import { Router } from "express";
import { z } from "zod";
import { db, nowIso } from "../../db/index.js";
import { h, HttpError, idParam, notFound } from "../../lib/http.js";
import { getSetting } from "../../lib/settings.js";
import { upload, uploadThumbs } from "../../lib/upload.js";
import { readPhoto, rotateStoredPhoto, storePhoto } from "../../storage/photos.js";
import { addPhoto, createItem, getItem, itemInput, listPhotos, reorderPhotos, replacePhotoFile, updateItem } from "../archive/repo.js";
import { confirmPrice, refreshSuggestion } from "../pricing/engine.js";
import { aiEnabled, detectOrientations, groupingThumb, groupPhotosInOrder, type Rotation } from "./ai.js";
import { orientPhotos, runAi } from "./salesKit.js";
import { mergeIfKnown } from "../duplicates/merge.js";
import { cancelQueueEntry, enqueue, enqueueInput, listQueue, rescheduleQueueEntry } from "./queue.js";

export const listingsRouter = Router();

const withDaysOnline = <T extends { listed_at: string }>(l: T) => ({ ...l, days_online: Math.floor((Date.now() - Date.parse(l.listed_at)) / 86400_000) });

/** Active listings across all accounts. */
listingsRouter.get("/", h(async (req, res) => {
  const accountId = req.query.accountId ? Number(req.query.accountId) : null;
  const rows = await db.all<{ listed_at: string }>(`
    SELECT l.*, a.name AS account_name,
      (SELECT file_name FROM item_photos p WHERE p.item_id = l.item_id ORDER BY position, id LIMIT 1) AS cover_photo
    FROM listings l JOIN accounts a ON a.id = l.account_id
    WHERE l.status = 'active' AND l.account_id = COALESCE(@accountId, l.account_id)
    ORDER BY l.listed_at DESC
  `, { accountId });
  res.json(rows.map(withDaysOnline));
}));

/** Everything that was uploaded to Vinted (newest first), whatever happened afterwards – the "Hochgeladen" tab. */
listingsRouter.get("/uploaded", h(async (_req, res) => {
  const rows = await db.all<{ listed_at: string }>(`
    SELECT l.*, a.name AS account_name,
      (SELECT file_name FROM item_photos p WHERE p.item_id = l.item_id ORDER BY position, id LIMIT 1) AS cover_photo
    FROM listings l JOIN accounts a ON a.id = l.account_id
    ORDER BY l.listed_at DESC, l.id DESC LIMIT 500
  `);
  res.json(rows.map(withDaysOnline));
}));

/** Everything that was sold (one row per article, latest sale) – the "Verkauft" tab, to upload it again later. */
listingsRouter.get("/sold", h(async (_req, res) => {
  res.json(await db.all(`
    SELECT i.id, i.title, i.brand, i.size, i.price_cents, i.currency,
      (SELECT file_name FROM item_photos p WHERE p.item_id = i.id ORDER BY position, id LIMIT 1) AS cover_photo,
      l.sold_at, l.sold_price_cents, a.name AS account_name, l.url
    FROM items i
    JOIN listings l ON l.id = (SELECT id FROM listings x WHERE x.item_id = i.id AND x.status = 'sold' ORDER BY x.sold_at DESC, x.id DESC LIMIT 1)
    JOIN accounts a ON a.id = l.account_id
    WHERE i.status = 'sold'
    ORDER BY l.sold_at DESC LIMIT 1000`));
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
  const item = await createItem({ ...data, measurements, title: data.title || measurements || "Neuer Artikel" });
  for (const s of stored) await addPhoto(item.id, s.photo, s.name);

  if (data.price_cents) await confirmPrice(item.id, data.price_cents, "manual");
  else await refreshSuggestion(item.id);

  // Seller hints are kept with the item: the AI reads them when it writes the texts at upload time.
  const hints = typeof req.body.hints === "string" ? req.body.hints.trim().slice(0, 1000) : "";
  if (hints && !data.notes) await updateItem(item.id, { notes: hints });

  let suggestion = null;
  let aiError: string | null = null;
  if (req.body.ai === "true" && aiEnabled()) {
    try {
      suggestion = await runAi(item.id, req.body.hints, data, true, !rotations);
    } catch (e) {
      aiError = (e as Error).message;
    }
  } else if (req.body.orient === "true" && !rotations && aiEnabled()) {
    // Import without texts: only turn the photos upright (texts follow at upload).
    try {
      await orientPhotos(item.id);
    } catch (e) {
      aiError = (e as Error).message;
    }
  }
  // Same garment already there (same photos)? → no second article: merge into the existing one.
  const keep = await mergeIfKnown(item.id);
  res.status(201).json({ item: await getItem(keep), photos: await listPhotos(keep), suggestion, aiError, mergedInto: keep !== item.id ? keep : null });
}));

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
  await getItem(id);
  const input = aiInput.parse(req.body ?? {});
  const suggestion = await runAi(id, input.hints, {}, input.apply);
  res.json({ suggestion, item: await getItem(id), photos: await listPhotos(id) });
}));

const draftsQuery = async (later: 0 | 1) => (await db.all<{ photo_count: number }>(`
  SELECT i.*, (SELECT file_name FROM item_photos p WHERE p.item_id = i.id ORDER BY position, id LIMIT 1) AS cover_photo,
    (SELECT COUNT(*) FROM item_photos p WHERE p.item_id = i.id) AS photo_count
  FROM items i WHERE i.status = 'draft' AND i.later = ${later} ORDER BY i.created_at DESC
`)).map((r) => ({ ...r, photo_count: Number(r.photo_count) }));

listingsRouter.get("/drafts", h(async (_req, res) => {
  res.json(await draftsQuery(0));
}));

/** Drafts parked for later. */
listingsRouter.get("/later", h(async (_req, res) => {
  res.json(await draftsQuery(1));
}));

/** Moves drafts to "Später" (later: true) or back to "Entwürfe" (later: false). */
listingsRouter.post("/later", h(async (req, res) => {
  const { itemIds, later } = z.object({ itemIds: z.array(z.number().int().positive()).min(1).max(1000), later: z.boolean() }).parse(req.body);
  await db.tx(async () => {
    for (const id of itemIds) await db.run("UPDATE items SET later = ?, updated_at = ? WHERE id = ?", [later ? 1 : 0, nowIso(), id]);
  });
  res.json({ moved: itemIds.length });
}));

// ---------- queue ----------

listingsRouter.get("/queue", h(async (req, res) => {
  res.json(await listQueue(typeof req.query.status === "string" ? req.query.status : undefined));
}));

listingsRouter.post("/queue", h(async (req, res) => {
  res.status(201).json(await enqueue(enqueueInput.parse(req.body)));
}));

listingsRouter.post("/queue/:id/cancel", h(async (req, res) => {
  await cancelQueueEntry(idParam(req));
  res.status(204).end();
}));

listingsRouter.post("/queue/:id/reschedule", h(async (req, res) => {
  const { at } = z.object({ at: z.string().datetime({ offset: true }).optional() }).parse(req.body ?? {});
  res.json(await rescheduleQueueEntry(idParam(req), at ?? nowIso()));
}));

// ---------- templates ----------

const templateInput = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(["shipping", "condition", "measurements", "other"]).default("other"),
  body: z.string().trim().min(1).max(3000),
});

listingsRouter.get("/templates", h(async (_req, res) => {
  res.json(await db.all("SELECT * FROM templates ORDER BY kind, name"));
}));

listingsRouter.post("/templates", h(async (req, res) => {
  const t = templateInput.parse(req.body);
  const id = await db.insert("INSERT INTO templates (name, kind, body) VALUES (?, ?, ?)", [t.name, t.kind, t.body]);
  res.status(201).json(await db.get("SELECT * FROM templates WHERE id = ?", [id]));
}));

listingsRouter.put("/templates/:id", h(async (req, res) => {
  const id = idParam(req);
  const t = templateInput.parse(req.body);
  if (!(await db.run("UPDATE templates SET name = ?, kind = ?, body = ?, updated_at = ? WHERE id = ?", [t.name, t.kind, t.body, nowIso(), id]))) throw notFound("Vorlage");
  res.json(await db.get("SELECT * FROM templates WHERE id = ?", [id]));
}));

listingsRouter.delete("/templates/:id", h(async (req, res) => {
  if (!(await db.run("DELETE FROM templates WHERE id = ?", [idParam(req)]))) throw notFound("Vorlage");
  res.status(204).end();
}));
