import { Router } from "express";
import { z } from "zod";
import { db, nowIso } from "../../db/index.js";
import { h, HttpError, idParam, notFound } from "../../lib/http.js";
import { getSetting } from "../../lib/settings.js";
import { upload } from "../../lib/upload.js";
import { storePhoto } from "../../storage/photos.js";
import { addPhoto, createItem, getItem, itemInput, listPhotos, updateItem } from "../archive/repo.js";
import { aiEnabled, generateListing } from "./ai.js";
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

// ---------- drafts (photo-first creation) ----------

/**
 * Creates a draft item from uploaded photos. Optional multipart field `data`
 * (JSON) pre-fills fields; `ai=true` immediately fills fields with AI.
 */
listingsRouter.post("/drafts", upload.array("photos", 20), h(async (req, res) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (!files.length) throw new HttpError(400, "Mindestens ein Foto hochladen (Feld 'photos')");
  const data = req.body.data ? itemInput.partial().parse(JSON.parse(req.body.data)) : {};
  const stored = [];
  for (const f of files) stored.push({ photo: await storePhoto(f.buffer), name: f.originalname });
  const item = createItem({ ...data, title: data.title || "Neuer Artikel" });
  for (const s of stored) addPhoto(item.id, s.photo, s.name);

  let suggestion = null;
  let aiError: string | null = null;
  if (req.body.ai === "true" && aiEnabled()) {
    try {
      suggestion = await generateListing(listPhotos(item.id), req.body.hints, getSetting("ai.language"));
      applySuggestion(item.id, suggestion, data);
    } catch (e) {
      aiError = (e as Error).message;
    }
  }
  res.status(201).json({ item: getItem(item.id), photos: listPhotos(item.id), suggestion, aiError });
}));

type Suggestion = Awaited<ReturnType<typeof generateListing>>;
function applySuggestion(itemId: number, s: Suggestion, keep: Partial<z.infer<typeof itemInput>> = {}) {
  updateItem(itemId, {
    title: keep.title || s.title.slice(0, 200),
    description: keep.description || s.description,
    category: keep.category ?? s.category,
    brand: keep.brand ?? s.brand,
    size: keep.size ?? s.size,
    condition: keep.condition ?? s.condition,
    color: keep.color ?? s.color,
    material: keep.material ?? s.material,
    price_cents: keep.price_cents ?? Math.round(s.suggested_price_eur * 100),
  });
}

const aiInput = z.object({ apply: z.boolean().default(false), hints: z.string().max(1000).optional() });

/** Runs AI generation on an item's stored photos. */
listingsRouter.post("/drafts/:id/ai", h(async (req, res) => {
  const id = idParam(req);
  getItem(id);
  const input = aiInput.parse(req.body ?? {});
  const suggestion = await generateListing(listPhotos(id), input.hints, getSetting("ai.language"));
  if (input.apply) applySuggestion(id, suggestion);
  res.json({ suggestion, item: getItem(id) });
}));

listingsRouter.get("/drafts", h((_req, res) => {
  res.json(db.prepare(`
    SELECT i.*, (SELECT file_name FROM item_photos p WHERE p.item_id = i.id ORDER BY position, id LIMIT 1) AS cover_photo,
      (SELECT COUNT(*) FROM item_photos p WHERE p.item_id = i.id) AS photo_count
    FROM items i WHERE i.status = 'draft' ORDER BY i.created_at DESC
  `).all());
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
