import { Router } from "express";
import { z } from "zod";
import { db, nowIso } from "../../db/index.js";
import { h, HttpError, idParam, notFound } from "../../lib/http.js";
import { getSetting } from "../../lib/settings.js";
import { upload, uploadThumbs } from "../../lib/upload.js";
import { photoPath, rotateStoredPhoto, storePhoto } from "../../storage/photos.js";
import fs from "node:fs";
import { addPhoto, createItem, getItem, itemInput, listPhotos, reorderPhotos, replacePhotoFile, updateItem } from "../archive/repo.js";
import { confirmPrice, examplesForPrompt, refreshSuggestion } from "../pricing/engine.js";
import { ruleBrand, ruleParcel } from "./brandRules.js";
import { aiEnabled, composeDescription, detectOrientations, generateListing, groupingThumb, groupPhotosInOrder, normalizeOrder, type Rotation } from "./ai.js";
import { cancelQueueEntry, enqueue, enqueueInput, listQueue, rescheduleQueueEntry } from "./queue.js";

export const listingsRouter = Router();

/** Active listings across all accounts. */
listingsRouter.get("/", h((req, res) => {
  const accountId = req.query.accountId ? Number(req.query.accountId) : null;
  const rows = db.prepare(`
    SELECT l.*, a.name AS account_name,
      (SELECT file_name FROM item_photos p WHERE p.item_id = l.item_id ORDER BY position, id LIMIT 1) AS cover_photo,
      CAST((julianday('now') - julianday(l.listed_at)) AS INTEGER) AS days_online
    FROM listings l JOIN accounts a ON a.id = l.account_id
    WHERE l.status = 'active' AND (@accountId IS NULL OR l.account_id = @accountId)
    ORDER BY l.listed_at DESC
  `).all({ accountId });
  res.json(rows);
}));

/** Everything that was uploaded to Vinted (newest first), whatever happened afterwards – the "Hochgeladen" tab. */
listingsRouter.get("/uploaded", h((_req, res) => {
  res.json(db.prepare(`
    SELECT l.*, a.name AS account_name,
      (SELECT file_name FROM item_photos p WHERE p.item_id = l.item_id ORDER BY position, id LIMIT 1) AS cover_photo,
      CAST((julianday('now') - julianday(l.listed_at)) AS INTEGER) AS days_online
    FROM listings l JOIN accounts a ON a.id = l.account_id
    ORDER BY l.listed_at DESC, l.id DESC LIMIT 500
  `).all());
}));

// ---------- drafts (photo-first creation) ----------

/** "Laenge_70_Breite-55" → "Laenge 70 Breite 55" (folder names carry the measurements). */
export function measurementsFromFolder(folder: string | undefined): string | null {
  const name = (folder ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";
  const cleaned = name.replace(/[_]+/g, " ").replace(/\s*-\s*/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 500) : null;
}

/**
 * Creates a draft item from uploaded photos. Optional multipart fields:
 * `data` (JSON) pre-fills fields, `folder` = folder name with measurements,
 * `hints` = notes for the AI, `ai=true` fills everything with AI.
 */
listingsRouter.post("/drafts", upload.array("photos", 20), h(async (req, res) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (!files.length) throw new HttpError(400, "Mindestens ein Foto hochladen (Feld 'photos')");
  const data = req.body.data ? itemInput.partial().parse(JSON.parse(req.body.data)) : {};
  const measurements = data.measurements ?? measurementsFromFolder(req.body.folder);
  // Photos are sorted by file name so the order matches the folder.
  // Optional `rotations` (JSON, same order as the upload): already decided/checked in the preview.
  const rotations = req.body.rotations ? z.array(z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])).parse(JSON.parse(req.body.rotations)) : null;
  const ordered = rotations ? files.map((f, i) => ({ f, rot: rotations[i] ?? 0 }))
    : [...files].sort((a, b) => a.originalname.localeCompare(b.originalname, "de", { numeric: true })).map((f) => ({ f, rot: 0 as Rotation }));
  const stored = [];
  for (const { f, rot } of ordered) {
    const photo = await storePhoto(f.buffer);
    stored.push({ photo: rot ? await rotateStoredPhoto(photo.fileName, rot) : photo, name: f.originalname });
  }
  const item = createItem({ ...data, measurements, title: data.title || measurements || "Neuer Artikel" });
  for (const s of stored) addPhoto(item.id, s.photo, s.name);

  if (data.price_cents) confirmPrice(item.id, data.price_cents, "manual");
  else refreshSuggestion(item.id);

  let suggestion = null;
  let aiError: string | null = null;
  if (req.body.ai === "true" && aiEnabled()) {
    try {
      suggestion = await runAi(item.id, req.body.hints, data, true, !rotations);
    } catch (e) {
      aiError = (e as Error).message;
    }
  }
  res.status(201).json({ item: getItem(item.id), photos: listPhotos(item.id), suggestion, aiError });
}));

/** Runs the sales-kit AI: rotates photos upright and (optionally) writes the texts into the item. */
async function runAi(itemId: number, hints: string | undefined, keep: Partial<z.infer<typeof itemInput>> = {}, apply = true, orient = true) {
  const item = getItem(itemId);
  if (orient) await orientPhotos(itemId);
  const photos = listPhotos(itemId);
  const s = await generateListing(photos, {
    hints, measurements: item.measurements, language: getSetting("ai.language"), stylePrompt: getSetting("ai.listingPrompt"),
    priceExamples: examplesForPrompt(item),
  });
  // Outfit shot → article only → details → tag (as decided by the model).
  const sent = photos.slice(0, 20);
  const order = normalizeOrder(s.photo_order ?? [], sent.length).map((i) => sent[i]!.id);
  reorderPhotos(itemId, [...order, ...photos.slice(20).map((p) => p.id)]);
  const description = composeDescription(s);
  if (apply) {
    updateItem(itemId, {
      title: keep.title || s.title.slice(0, 200),
      description: keep.description || description.slice(0, 5000),
      category: keep.category ?? s.category,
      // Brand rules win over the AI (e.g. every T-shirt → "Graphic Tee").
      brand: keep.brand ?? ruleBrand({ title: s.title, category: s.category, description }) ?? s.brand,
      size: keep.size ?? s.size,
      condition: keep.condition ?? s.condition,
      color: keep.color ?? s.color,
      material: keep.material ?? s.material,
      parcel_size: keep.parcel_size ?? ruleParcel({ title: s.title, category: s.category, description }) ?? s.parcel_size,
    });
    if (keep.price_cents) confirmPrice(itemId, keep.price_cents, "manual");
  }
  // The price is only a suggestion until the seller confirms it (✓).
  if (!getItem(itemId).price_confirmed) refreshSuggestion(itemId, Math.round(s.suggested_price_eur * 100));
  return { ...s, description };
}

/** Turns every photo of an item upright (dedicated orientation check). */
async function orientPhotos(itemId: number) {
  const photos = listPhotos(itemId);
  const degrees = await detectOrientations(photos.map((p) => fs.readFileSync(photoPath(p.file_name))));
  for (const [i, deg] of degrees.entries()) {
    if (deg) replacePhotoFile(photos[i]!.id, await rotateStoredPhoto(photos[i]!.file_name, deg));
  }
}

/**
 * Groups the photos of one folder into articles. Expects small previews in
 * folder order (field `photos`); returns index groups, e.g. [[0,1,2],[3,4]].
 * Nothing is stored – the real upload happens per group afterwards.
 */
listingsRouter.post("/group-photos", uploadThumbs.array("photos", 600), h(async (req, res) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length < 2) throw new HttpError(400, "Mindestens zwei Fotos zum Zuordnen hochladen");
  if (!aiEnabled()) throw new HttpError(503, "ANTHROPIC_API_KEY ist nicht gesetzt – die automatische Zuordnung braucht die KI");
  const thumbs = [];
  for (const f of files) {
    try {
      thumbs.push(await groupingThumb(f.buffer));
    } catch {
      throw new HttpError(400, `Foto „${f.originalname}“ kann nicht gelesen werden (Format nicht unterstützt?)`);
    }
  }
  const [groups, rotations] = await Promise.all([groupPhotosInOrder(thumbs), detectOrientations(thumbs)]);
  res.json({ groups, rotations });
}));

const aiInput = z.object({ apply: z.boolean().default(false), hints: z.string().max(1000).optional() });

/** Runs the sales-kit AI on an item's stored photos (photos are always rotated upright). */
listingsRouter.post("/drafts/:id/ai", h(async (req, res) => {
  const id = idParam(req);
  getItem(id);
  const input = aiInput.parse(req.body ?? {});
  const suggestion = await runAi(id, input.hints, {}, input.apply);
  res.json({ suggestion, item: getItem(id), photos: listPhotos(id) });
}));

const draftsQuery = (later: 0 | 1) => db.prepare(`
  SELECT i.*, (SELECT file_name FROM item_photos p WHERE p.item_id = i.id ORDER BY position, id LIMIT 1) AS cover_photo,
    (SELECT COUNT(*) FROM item_photos p WHERE p.item_id = i.id) AS photo_count
  FROM items i WHERE i.status = 'draft' AND i.later = ${later} ORDER BY i.created_at DESC
`).all();

listingsRouter.get("/drafts", h((_req, res) => {
  res.json(draftsQuery(0));
}));

/** Drafts parked for later. */
listingsRouter.get("/later", h((_req, res) => {
  res.json(draftsQuery(1));
}));

/** Moves drafts to "Später" (later: true) or back to "Entwürfe" (later: false). */
listingsRouter.post("/later", h((req, res) => {
  const { itemIds, later } = z.object({ itemIds: z.array(z.number().int().positive()).min(1).max(1000), later: z.boolean() }).parse(req.body);
  const stmt = db.prepare("UPDATE items SET later = ?, updated_at = ? WHERE id = ?");
  db.transaction(() => itemIds.forEach((id) => stmt.run(later ? 1 : 0, nowIso(), id)))();
  res.json({ moved: itemIds.length });
}));

// ---------- queue ----------

listingsRouter.get("/queue", h((req, res) => {
  res.json(listQueue(typeof req.query.status === "string" ? req.query.status : undefined));
}));

listingsRouter.post("/queue", h((req, res) => {
  res.status(201).json(enqueue(enqueueInput.parse(req.body)));
}));

listingsRouter.post("/queue/:id/cancel", h((req, res) => {
  cancelQueueEntry(idParam(req));
  res.status(204).end();
}));

listingsRouter.post("/queue/:id/reschedule", h((req, res) => {
  const { at } = z.object({ at: z.string().datetime({ offset: true }).optional() }).parse(req.body ?? {});
  res.json(rescheduleQueueEntry(idParam(req), at ?? nowIso()));
}));

// ---------- templates ----------

const templateInput = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(["shipping", "condition", "measurements", "other"]).default("other"),
  body: z.string().trim().min(1).max(3000),
});

listingsRouter.get("/templates", h((_req, res) => {
  res.json(db.prepare("SELECT * FROM templates ORDER BY kind, name").all());
}));

listingsRouter.post("/templates", h((req, res) => {
  const t = templateInput.parse(req.body);
  const r = db.prepare("INSERT INTO templates (name, kind, body) VALUES (?, ?, ?)").run(t.name, t.kind, t.body);
  res.status(201).json(db.prepare("SELECT * FROM templates WHERE id = ?").get(r.lastInsertRowid));
}));

listingsRouter.put("/templates/:id", h((req, res) => {
  const id = idParam(req);
  const t = templateInput.parse(req.body);
  const r = db.prepare("UPDATE templates SET name = ?, kind = ?, body = ?, updated_at = ? WHERE id = ?").run(t.name, t.kind, t.body, nowIso(), id);
  if (!r.changes) throw notFound("Vorlage");
  res.json(db.prepare("SELECT * FROM templates WHERE id = ?").get(id));
}));

listingsRouter.delete("/templates/:id", h((req, res) => {
  const r = db.prepare("DELETE FROM templates WHERE id = ?").run(idParam(req));
  if (!r.changes) throw notFound("Vorlage");
  res.status(204).end();
}));
