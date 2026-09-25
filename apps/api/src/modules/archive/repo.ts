import { z } from "zod";
import { db, nowIso } from "../../db/index.js";
import { HttpError, notFound } from "../../lib/http.js";
import type { StoredPhoto } from "../../storage/photos.js";
import { recordPriceExample } from "../pricing/engine.js";

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
  parcel_size: string | null;
  later: number;
  price_cents: number | null;
  currency: string;
  purchase_price_cents: number | null;
  price_suggested_cents: number | null;
  price_suggestion_reason: string | null;
  price_confirmed: number;
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

export const PARCEL_SIZES = ["Klein", "Mittel", "Groß"] as const;
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
  parcel_size: z.enum(PARCEL_SIZES).nullable().optional(),
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
  "measurements", "parcel_size", "price_cents", "currency", "purchase_price_cents", "notes",
] as const;

export async function getItem(id: number): Promise<ItemRow> {
  const i = await db.get<ItemRow>("SELECT * FROM items WHERE id = ?", [id]);
  if (!i) throw notFound("Artikel");
  return i;
}

export async function createItem(input: Partial<ItemInput> & { title: string }, status: ItemRow["status"] = "draft"): Promise<ItemRow> {
  const data = itemInput.parse(input);
  const cols = ITEM_FIELDS.filter((f) => data[f] !== undefined);
  const id = await db.insert(`INSERT INTO items (${[...cols, "status"].join(", ")}) VALUES (${[...cols.map((c) => "@" + c), "@status"].join(", ")})`,
    { ...Object.fromEntries(cols.map((c) => [c, data[c] ?? null])), status });
  return getItem(id);
}

export async function updateItem(id: number, patch: z.infer<typeof itemPatch>): Promise<ItemRow> {
  await getItem(id);
  const fields = [...ITEM_FIELDS, "status"] as const;
  const keys = fields.filter((k) => patch[k] !== undefined);
  if (keys.length) {
    await db.run(`UPDATE items SET ${keys.map((k) => `${k} = @${k}`).join(", ")}, updated_at = @updated_at WHERE id = @id`,
      { ...Object.fromEntries(keys.map((k) => [k, patch[k] ?? null])), updated_at: nowIso(), id });
  }
  if (patch.status === undefined) await recomputeItemStatus(id);
  return getItem(id);
}

export async function deleteItem(id: number) {
  await getItem(id);
  const c = await db.get<{ c: number }>("SELECT COUNT(*) c FROM listings WHERE item_id = ?", [id]);
  if (Number(c?.c) > 0) throw new HttpError(409, "Artikel war bereits eingestellt – statt Löschen bitte archivieren (Verlauf bleibt erhalten).");
  await db.run("DELETE FROM items WHERE id = ?", [id]);
}

// ---------- photos ----------

export function listPhotos(itemId: number): Promise<PhotoRow[]> {
  return db.all<PhotoRow>("SELECT * FROM item_photos WHERE item_id = ? ORDER BY position, id", [itemId]);
}

export async function addPhoto(itemId: number, p: StoredPhoto, originalName: string | null): Promise<PhotoRow> {
  const existing = await db.get<PhotoRow>("SELECT * FROM item_photos WHERE item_id = ? AND sha256 = ?", [itemId, p.sha256]);
  if (existing) return existing;
  const pos = Number((await db.get<{ p: number }>("SELECT COALESCE(MAX(position), -1) + 1 p FROM item_photos WHERE item_id = ?", [itemId]))!.p);
  const id = await db.insert(`
    INSERT INTO item_photos (item_id, file_name, original_name, mime_type, width, height, size_bytes, sha256, position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [itemId, p.fileName, originalName, p.mimeType, p.width, p.height, p.sizeBytes, p.sha256, pos]);
  return (await db.get<PhotoRow>("SELECT * FROM item_photos WHERE id = ?", [id]))!;
}

/** Points a photo row at a new file (e.g. after rotation), keeping its position. */
export async function replacePhotoFile(photoId: number, p: StoredPhoto) {
  await db.run("UPDATE item_photos SET file_name = ?, width = ?, height = ?, size_bytes = ?, sha256 = ? WHERE id = ?",
    [p.fileName, p.width, p.height, p.sizeBytes, p.sha256, photoId]);
}

export async function deletePhoto(itemId: number, photoId: number) {
  const changes = await db.run("DELETE FROM item_photos WHERE id = ? AND item_id = ?", [photoId, itemId]);
  if (!changes) throw notFound("Foto");
}

export async function reorderPhotos(itemId: number, ids: number[]) {
  await db.tx(async () => {
    for (const [i, id] of ids.entries()) await db.run("UPDATE item_photos SET position = ? WHERE id = ? AND item_id = ?", [i, id, itemId]);
  });
}

// ---------- listings / history ----------

export async function getListing(id: number): Promise<ListingRow> {
  const l = await db.get<ListingRow>("SELECT * FROM listings WHERE id = ?", [id]);
  if (!l) throw notFound("Listing");
  return l;
}

export async function createListing(data: {
  item_id: number; account_id: number; vinted_item_id?: string | null; url?: string | null; title: string;
  description: string; price_cents: number | null; currency: string; status?: ListingRow["status"];
  listed_at?: string; favourites?: number; views?: number;
}): Promise<ListingRow> {
  const id = await db.insert(`
    INSERT INTO listings (item_id, account_id, vinted_item_id, url, title, description, price_cents, currency, status, listed_at, favourites, views)
    VALUES (@item_id, @account_id, @vinted_item_id, @url, @title, @description, @price_cents, @currency, @status, @listed_at, @favourites, @views)
  `, {
    vinted_item_id: null, url: null, status: "active", listed_at: nowIso(), favourites: 0, views: 0,
    // Optional fields left undefined keep their defaults (undefined can't be bound).
    ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)),
  });
  await db.run("UPDATE items SET later = 0 WHERE id = ?", [data.item_id]); // uploaded → no longer "Später"
  await recomputeItemStatus(data.item_id);
  return getListing(id);
}

export async function markListingSold(listingId: number, soldAt: string, priceCents: number | null) {
  await db.run("UPDATE listings SET status = 'sold', sold_at = ?, sold_price_cents = ?, ended_at = ?, updated_at = ? WHERE id = ?",
    [soldAt, priceCents, soldAt, nowIso(), listingId]);
  const itemId = (await getListing(listingId)).item_id;
  await recomputeItemStatus(itemId);
  if (priceCents) await recordPriceExample(itemId, priceCents, "sold"); // real sale prices teach the most
}

export async function endListing(listingId: number, status: "removed" | "expired" | "hidden") {
  await db.run("UPDATE listings SET status = ?, ended_at = COALESCE(ended_at, ?), updated_at = ? WHERE id = ?", [status, nowIso(), nowIso(), listingId]);
  await recomputeItemStatus((await getListing(listingId)).item_id);
}

export async function setListingPrice(listingId: number, newPriceCents: number, reason: string) {
  const l = await getListing(listingId);
  await db.tx(async () => {
    await db.run("INSERT INTO listing_price_changes (listing_id, old_price_cents, new_price_cents, reason) VALUES (?, ?, ?, ?)",
      [listingId, l.price_cents, newPriceCents, reason]);
    await db.run("UPDATE listings SET price_cents = ?, last_price_drop_at = CASE WHEN ? < COALESCE(price_cents, 0) THEN ? ELSE last_price_drop_at END, updated_at = ? WHERE id = ?",
      [newPriceCents, newPriceCents, nowIso(), nowIso(), listingId]);
    await db.run("UPDATE items SET price_cents = ?, updated_at = ? WHERE id = ?", [newPriceCents, nowIso(), l.item_id]);
  });
}

/**
 * Item status is derived from its listing history so it can never drift:
 * active listing → active (or relisted if listed more than once),
 * pending queue entry → queued, last listing sold → sold,
 * listed before but nothing live → archived, never listed → draft.
 * A manual "archived" status on a never-listed item is preserved.
 */
export async function recomputeItemStatus(itemId: number) {
  const item = await db.get<{ status: string }>("SELECT status FROM items WHERE id = ?", [itemId]);
  if (!item) return;
  const stats = (await db.get<{ total: number; active: number | null; latest: string | null }>(`
    SELECT COUNT(*) total,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) active,
      (SELECT status FROM listings WHERE item_id = @id ORDER BY listed_at DESC, id DESC LIMIT 1) latest
    FROM listings WHERE item_id = @id
  `, { id: itemId }))!;
  const queued = Number((await db.get<{ c: number }>("SELECT COUNT(*) c FROM publish_queue WHERE item_id = ? AND status IN ('pending','processing')", [itemId]))!.c);
  const total = Number(stats.total);

  let status: string;
  if (Number(stats.active ?? 0) > 0) status = total > 1 ? "relisted" : "active";
  else if (queued > 0) status = "queued";
  else if (stats.latest === "sold") status = "sold";
  else if (total > 0) status = "archived";
  else status = item.status === "archived" ? "archived" : "draft";

  if (status !== item.status) await db.run("UPDATE items SET status = ?, updated_at = ? WHERE id = ?", [status, nowIso(), itemId]);
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

export async function searchItems(q: z.infer<typeof archiveQuery>) {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
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
  const order = { updated: "i.updated_at DESC", created: "i.created_at DESC", price: "i.price_cents DESC", title: "LOWER(i.title)" }[q.sort];
  const total = Number((await db.get<{ c: number }>(`SELECT COUNT(*) c FROM items i ${w}`, params))!.c);
  const rows = await db.all(`
    SELECT i.*,
      (SELECT file_name FROM item_photos p WHERE p.item_id = i.id ORDER BY position, id LIMIT 1) AS cover_photo,
      (SELECT COUNT(*) FROM item_photos p WHERE p.item_id = i.id) AS photo_count,
      (SELECT COUNT(*) FROM listings l WHERE l.item_id = i.id) AS times_listed,
      (SELECT a.name FROM listings l JOIN accounts a ON a.id = l.account_id WHERE l.item_id = i.id ORDER BY l.listed_at DESC LIMIT 1) AS last_account
    FROM items i ${w}
    ORDER BY ${order}
    LIMIT @limit OFFSET @offset
  `, { ...params, limit: q.pageSize, offset: (q.page - 1) * q.pageSize });
  return { total, page: q.page, pageSize: q.pageSize, items: rows };
}

export async function facets() {
  const col = (c: string) => db.all<{ v: string; n: number }>(`SELECT ${c} v, COUNT(*) n FROM items WHERE ${c} IS NOT NULL AND ${c} <> '' GROUP BY ${c} ORDER BY n DESC`);
  return { categories: await col("category"), brands: await col("brand") };
}

export async function itemDetail(id: number) {
  const item = await getItem(id);
  const listings = await db.all(`
    SELECT l.*, a.name AS account_name, a.domain AS account_domain
    FROM listings l JOIN accounts a ON a.id = l.account_id
    WHERE l.item_id = ? ORDER BY l.listed_at DESC
  `, [id]);
  const priceChanges = await db.all(`
    SELECT pc.* FROM listing_price_changes pc JOIN listings l ON l.id = pc.listing_id WHERE l.item_id = ? ORDER BY pc.created_at DESC
  `, [id]);
  const queue = await db.all(`
    SELECT q.*, a.name AS account_name FROM publish_queue q JOIN accounts a ON a.id = q.account_id
    WHERE q.item_id = ? ORDER BY q.scheduled_at DESC
  `, [id]);
  const sold = (listings as unknown as ListingRow[]).filter((l) => l.status === "sold");
  return {
    item,
    photos: await listPhotos(id),
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
