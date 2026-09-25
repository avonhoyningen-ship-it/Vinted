import type { SQLInputValue } from "node:sqlite";
import { z } from "zod";
import { db, nowIso } from "../../db/index.js";
import { HttpError, notFound } from "../../lib/http.js";
import type { StoredPhoto } from "../../storage/photos.js";

export const CONDITIONS = ["new_with_tags", "new_without_tags", "very_good", "good", "satisfactory"] as const;
export const ITEM_STATUSES = ["draft", "queued", "active", "sold", "archived", "relisted"] as const;

export interface ItemRow {
  id: number;
  title: string;
  description: string;
  category: string | null;
  brand: string | null;
  size: string | null;
  condition: string | null;
  color: string | null;
  material: string | null;
  measurements: string | null;
  price_cents: number | null;
  currency: string;
  purchase_price_cents: number | null;
  status: (typeof ITEM_STATUSES)[number];
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface PhotoRow {
  id: number;
  item_id: number;
  file_name: string;
  original_name: string | null;
  mime_type: string;
  width: number | null;
  height: number | null;
  size_bytes: number | null;
  sha256: string;
  position: number;
  created_at: string;
}

export interface ListingRow {
  id: number;
  item_id: number;
  account_id: number;
  vinted_item_id: string | null;
  url: string | null;
  title: string;
  description: string;
  price_cents: number | null;
  currency: string;
  status: "active" | "sold" | "removed" | "expired" | "hidden";
  favourites: number;
  views: number;
  listed_at: string;
  sold_at: string | null;
  sold_price_cents: number | null;
  ended_at: string | null;
  last_price_drop_at: string | null;
  created_at: string;
  updated_at: string;
}

const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();

export const itemInput = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000).default(""),
  category: nullableText(120),
  brand: nullableText(120),
  size: nullableText(60),
  condition: z.enum(CONDITIONS).nullable().optional(),
  color: nullableText(60),
  material: nullableText(120),
  measurements: nullableText(500),
  price_cents: z.number().int().min(0).max(10_000_000).nullable().optional(),
  currency: z.string().length(3).default("EUR"),
  purchase_price_cents: z.number().int().min(0).nullable().optional(),
  notes: nullableText(2000),
});
export const itemPatch = itemInput.partial().extend({
  status: z.enum(["draft", "archived"]).optional(), // other statuses are derived from listings
});
export type ItemInput = z.infer<typeof itemInput>;

const ITEM_FIELDS = [
  "title", "description", "category", "brand", "size", "condition", "color", "material",
  "measurements", "price_cents", "currency", "purchase_price_cents", "notes",
] as const;

export function getItem(id: number): ItemRow {
  const i = db.prepare("SELECT * FROM items WHERE id = ?").get(id) as unknown as ItemRow | undefined;
  if (!i) throw notFound("Artikel");
  return i;
}

export function createItem(input: Partial<ItemInput> & { title: string }, status: ItemRow["status"] = "draft"): ItemRow {
  const data = itemInput.parse(input);
  const cols = ITEM_FIELDS.filter((f) => data[f] !== undefined);
  const r = db.prepare(`INSERT INTO items (${[...cols, "status"].join(", ")}) VALUES (${[...cols.map((c) => "@" + c), "@status"].join(", ")})`)
    .run({ ...Object.fromEntries(cols.map((c) => [c, data[c] ?? null])), status });
  return getItem(Number(r.lastInsertRowid));
}

export function updateItem(id: number, patch: z.infer<typeof itemPatch>): ItemRow {
  getItem(id);
  const fields = [...ITEM_FIELDS, "status"] as const;
  const keys = fields.filter((k) => patch[k] !== undefined);
  if (keys.length) {
    db.prepare(`UPDATE items SET ${keys.map((k) => `${k} = @${k}`).join(", ")}, updated_at = @updated_at WHERE id = @id`)
      .run({ ...Object.fromEntries(keys.map((k) => [k, patch[k] ?? null])), updated_at: nowIso(), id });
  }
  if (patch.status === undefined) recomputeItemStatus(id);
  return getItem(id);
}

export function deleteItem(id: number) {
  getItem(id);
  const c = db.prepare("SELECT COUNT(*) c FROM listings WHERE item_id = ?").get(id) as { c: number };
  if (c.c > 0) throw new HttpError(409, "Artikel war bereits eingestellt – statt Löschen bitte archivieren (Verlauf bleibt erhalten).");
  db.prepare("DELETE FROM items WHERE id = ?").run(id);
}

// ---------- photos ----------

export function listPhotos(itemId: number): PhotoRow[] {
  return db.prepare("SELECT * FROM item_photos WHERE item_id = ? ORDER BY position, id").all(itemId) as unknown as PhotoRow[];
}

export function addPhoto(itemId: number, p: StoredPhoto, originalName: string | null): PhotoRow {
  const existing = db.prepare("SELECT * FROM item_photos WHERE item_id = ? AND sha256 = ?").get(itemId, p.sha256) as unknown as PhotoRow | undefined;
  if (existing) return existing;
  const pos = (db.prepare("SELECT COALESCE(MAX(position), -1) + 1 p FROM item_photos WHERE item_id = ?").get(itemId) as { p: number }).p;
  const r = db.prepare(`
    INSERT INTO item_photos (item_id, file_name, original_name, mime_type, width, height, size_bytes, sha256, position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(itemId, p.fileName, originalName, p.mimeType, p.width, p.height, p.sizeBytes, p.sha256, pos);
  return db.prepare("SELECT * FROM item_photos WHERE id = ?").get(r.lastInsertRowid) as unknown as PhotoRow;
}

/** Points a photo row at a new file (e.g. after rotation), keeping its position. */
export function replacePhotoFile(photoId: number, p: StoredPhoto) {
  db.prepare("UPDATE item_photos SET file_name = ?, width = ?, height = ?, size_bytes = ?, sha256 = ? WHERE id = ?")
    .run(p.fileName, p.width, p.height, p.sizeBytes, p.sha256, photoId);
}

export function deletePhoto(itemId: number, photoId: number) {
  const r = db.prepare("DELETE FROM item_photos WHERE id = ? AND item_id = ?").run(photoId, itemId);
  if (!r.changes) throw notFound("Foto");
}

export function reorderPhotos(itemId: number, ids: number[]) {
  const stmt = db.prepare("UPDATE item_photos SET position = ? WHERE id = ? AND item_id = ?");
  db.transaction(() => ids.forEach((id, i) => stmt.run(i, id, itemId)))();
}

// ---------- listings / history ----------

export function getListing(id: number): ListingRow {
  const l = db.prepare("SELECT * FROM listings WHERE id = ?").get(id) as unknown as ListingRow | undefined;
  if (!l) throw notFound("Listing");
  return l;
}

export function createListing(data: {
  item_id: number; account_id: number; vinted_item_id?: string | null; url?: string | null; title: string;
  description: string; price_cents: number | null; currency: string; status?: ListingRow["status"];
  listed_at?: string; favourites?: number; views?: number;
}): ListingRow {
  const r = db.prepare(`
    INSERT INTO listings (item_id, account_id, vinted_item_id, url, title, description, price_cents, currency, status, listed_at, favourites, views)
    VALUES (@item_id, @account_id, @vinted_item_id, @url, @title, @description, @price_cents, @currency, @status, @listed_at, @favourites, @views)
  `).run({
    vinted_item_id: null, url: null, status: "active", listed_at: nowIso(), favourites: 0, views: 0, ...data,
  });
  recomputeItemStatus(data.item_id);
  return getListing(Number(r.lastInsertRowid));
}

export function markListingSold(listingId: number, soldAt: string, priceCents: number | null) {
  db.prepare("UPDATE listings SET status = 'sold', sold_at = ?, sold_price_cents = ?, ended_at = ?, updated_at = ? WHERE id = ?")
    .run(soldAt, priceCents, soldAt, nowIso(), listingId);
  recomputeItemStatus(getListing(listingId).item_id);
}

export function endListing(listingId: number, status: "removed" | "expired" | "hidden") {
  db.prepare("UPDATE listings SET status = ?, ended_at = COALESCE(ended_at, ?), updated_at = ? WHERE id = ?").run(status, nowIso(), nowIso(), listingId);
  recomputeItemStatus(getListing(listingId).item_id);
}

export function setListingPrice(listingId: number, newPriceCents: number, reason: string) {
  const l = getListing(listingId);
  db.transaction(() => {
    db.prepare("INSERT INTO listing_price_changes (listing_id, old_price_cents, new_price_cents, reason) VALUES (?, ?, ?, ?)")
      .run(listingId, l.price_cents, newPriceCents, reason);
    db.prepare("UPDATE listings SET price_cents = ?, last_price_drop_at = CASE WHEN ? < COALESCE(price_cents, 0) THEN ? ELSE last_price_drop_at END, updated_at = ? WHERE id = ?")
      .run(newPriceCents, newPriceCents, nowIso(), nowIso(), listingId);
    db.prepare("UPDATE items SET price_cents = ?, updated_at = ? WHERE id = ?").run(newPriceCents, nowIso(), l.item_id);
  })();
}

/**
 * Item status is derived from its listing history so it can never drift:
 * active listing → active (or relisted if listed more than once),
 * pending queue entry → queued, last listing sold → sold,
 * listed before but nothing live → archived, never listed → draft.
 * A manual "archived" status on a never-listed item is preserved.
 */
export function recomputeItemStatus(itemId: number) {
  const item = db.prepare("SELECT status FROM items WHERE id = ?").get(itemId) as { status: string } | undefined;
  if (!item) return;
  const stats = db.prepare(`
    SELECT COUNT(*) total,
      SUM(status = 'active') active,
      (SELECT status FROM listings WHERE item_id = @id ORDER BY listed_at DESC, id DESC LIMIT 1) latest
    FROM listings WHERE item_id = @id
  `).get({ id: itemId }) as { total: number; active: number | null; latest: string | null };
  const queued = (db.prepare("SELECT COUNT(*) c FROM publish_queue WHERE item_id = ? AND status IN ('pending','processing')").get(itemId) as { c: number }).c;

  let status: string;
  if ((stats.active ?? 0) > 0) status = stats.total > 1 ? "relisted" : "active";
  else if (queued > 0) status = "queued";
  else if (stats.latest === "sold") status = "sold";
  else if (stats.total > 0) status = "archived";
  else status = item.status === "archived" ? "archived" : "draft";

  if (status !== item.status) db.prepare("UPDATE items SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), itemId);
}

// ---------- search ----------

export const archiveQuery = z.object({
  q: z.string().trim().optional(),
  accountId: z.coerce.number().int().positive().optional(),
  status: z.enum(ITEM_STATUSES).optional(),
  category: z.string().optional(),
  brand: z.string().optional(),
  sort: z.enum(["updated", "created", "price", "title"]).default("updated"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(48),
});

export function searchItems(q: z.infer<typeof archiveQuery>) {
  const where: string[] = [];
  const params: Record<string, SQLInputValue> = {};
  if (q.q) {
    where.push("(i.title LIKE @q OR i.description LIKE @q OR i.brand LIKE @q)");
    params.q = `%${q.q}%`;
  }
  if (q.status) { where.push("i.status = @status"); params.status = q.status; }
  if (q.category) { where.push("i.category = @category"); params.category = q.category; }
  if (q.brand) { where.push("i.brand = @brand"); params.brand = q.brand; }
  if (q.accountId) {
    where.push("EXISTS (SELECT 1 FROM listings l WHERE l.item_id = i.id AND l.account_id = @accountId)");
    params.accountId = q.accountId;
  }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const order = { updated: "i.updated_at DESC", created: "i.created_at DESC", price: "i.price_cents DESC", title: "i.title COLLATE NOCASE" }[q.sort];
  const total = (db.prepare(`SELECT COUNT(*) c FROM items i ${w}`).get(params) as { c: number }).c;
  const rows = db.prepare(`
    SELECT i.*,
      (SELECT file_name FROM item_photos p WHERE p.item_id = i.id ORDER BY position, id LIMIT 1) AS cover_photo,
      (SELECT COUNT(*) FROM item_photos p WHERE p.item_id = i.id) AS photo_count,
      (SELECT COUNT(*) FROM listings l WHERE l.item_id = i.id) AS times_listed,
      (SELECT a.name FROM listings l JOIN accounts a ON a.id = l.account_id WHERE l.item_id = i.id ORDER BY l.listed_at DESC LIMIT 1) AS last_account
    FROM items i ${w}
    ORDER BY ${order}
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit: q.pageSize, offset: (q.page - 1) * q.pageSize });
  return { total, page: q.page, pageSize: q.pageSize, items: rows };
}

export function facets() {
  const col = (c: string) => (db.prepare(`SELECT ${c} v, COUNT(*) n FROM items WHERE ${c} IS NOT NULL AND ${c} <> '' GROUP BY ${c} ORDER BY n DESC`).all() as { v: string; n: number }[]);
  return { categories: col("category"), brands: col("brand") };
}

export function itemDetail(id: number) {
  const item = getItem(id);
  const listings = db.prepare(`
    SELECT l.*, a.name AS account_name, a.domain AS account_domain
    FROM listings l JOIN accounts a ON a.id = l.account_id
    WHERE l.item_id = ? ORDER BY l.listed_at DESC
  `).all(id);
  const priceChanges = db.prepare(`
    SELECT pc.* FROM listing_price_changes pc JOIN listings l ON l.id = pc.listing_id WHERE l.item_id = ? ORDER BY pc.created_at DESC
  `).all(id);
  const queue = db.prepare(`
    SELECT q.*, a.name AS account_name FROM publish_queue q JOIN accounts a ON a.id = q.account_id
    WHERE q.item_id = ? ORDER BY q.scheduled_at DESC
  `).all(id);
  const sold = (listings as unknown as ListingRow[]).filter((l) => l.status === "sold");
  return {
    item,
    photos: listPhotos(id),
    listings,
    priceChanges,
    queue,
    summary: {
      timesListed: listings.length,
      accounts: [...new Set((listings as { account_name: string }[]).map((l) => l.account_name))],
      timesSold: sold.length,
      lastSoldAt: sold[0]?.sold_at ?? null,
    },
  };
}
