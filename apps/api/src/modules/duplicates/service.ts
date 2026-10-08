import sharp from "sharp";
import { currentUserId, db } from "../../db/index.js";
import { eventBus } from "../../lib/eventBus.js";
import { HttpError } from "../../lib/http.js";
import { readPhoto } from "../../storage/photos.js";

/**
 * "Ist der Artikel schon online?" – finds articles that are listed twice on the
 * same Vinted account: the same archive item, the same title, or (nearly) the
 * same cover photo. Used as a stop before uploading and by a background check.
 */
interface Active {
  id: number; item_id: number; account_id: number; account_name: string; title: string; url: string | null;
  listed_at: string; cover: string | null;
}

export interface DuplicateHit { listingId: number; itemId: number; title: string; url: string | null; listedAt: string; reason: string }
export interface DuplicateGroup { accountId: number; accountName: string; listings: DuplicateHit[] }

// ---------- photo fingerprint (difference hash, robust to resizing/recompression) ----------

const hashCache = new Map<string, string | null>();

export async function photoHash(input: Buffer): Promise<string> {
  const px = await sharp(input).rotate().grayscale().resize(9, 8, { fit: "fill" }).raw().toBuffer();
  let bits = "";
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += px[y * 9 + x]! < px[y * 9 + x + 1]! ? "1" : "0";
  return BigInt(`0b${bits}`).toString(16).padStart(16, "0");
}

export function hammingDistance(a: string, b: string): number {
  let v = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (v) { n += Number(v & 1n); v >>= 1n; }
  return n;
}

async function storedHash(fileName: string | null): Promise<string | null> {
  if (!fileName) return null;
  if (!hashCache.has(fileName)) hashCache.set(fileName, await readPhoto(fileName).then(photoHash).catch(() => null));
  return hashCache.get(fileName)!;
}

const SAME_PHOTO = 6; // of 64 bits
const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

async function why(a: { item_id: number; title: string; cover: string | null }, b: { item_id: number; title: string; cover: string | null }): Promise<string | null> {
  if (a.item_id === b.item_id) return "derselbe Artikel";
  if (norm(a.title) && norm(a.title) === norm(b.title)) return "gleicher Titel";
  const [ha, hb] = await Promise.all([storedHash(a.cover), storedHash(b.cover)]);
  if (ha && hb && hammingDistance(ha, hb) <= SAME_PHOTO) return "gleiches Foto";
  return null;
}

const ACTIVE_SQL = `
  SELECT l.id, l.item_id, l.account_id, a.name AS account_name, l.title, l.url, l.listed_at,
    (SELECT file_name FROM item_photos p WHERE p.item_id = l.item_id ORDER BY position, id LIMIT 1) AS cover
  FROM listings l JOIN accounts a ON a.id = l.account_id WHERE l.status = 'active'`;

/** All articles that are online more than once on the same account. */
export async function findDuplicates(): Promise<DuplicateGroup[]> {
  const rows = await db.all<Active>(`${ACTIVE_SQL} ORDER BY l.account_id, l.listed_at`);
  const groups: DuplicateGroup[] = [];
  const used = new Set<number>();
  for (const [i, a] of rows.entries()) {
    if (used.has(a.id)) continue;
    const hits: DuplicateHit[] = [];
    for (const b of rows.slice(i + 1)) {
      if (b.account_id !== a.account_id || used.has(b.id)) continue;
      const reason = await why(a, b);
      if (reason) { used.add(b.id); hits.push({ listingId: b.id, itemId: b.item_id, title: b.title, url: b.url, listedAt: b.listed_at, reason }); }
    }
    if (hits.length) {
      used.add(a.id);
      groups.push({ accountId: a.account_id, accountName: a.account_name, listings: [{ listingId: a.id, itemId: a.item_id, title: a.title, url: a.url, listedAt: a.listed_at, reason: "zuerst online" }, ...hits] });
    }
  }
  return groups;
}

/** Before uploading: which of these items are already online on the account? */
export async function onlineAlready(itemIds: number[], accountId: number): Promise<{ itemId: number; title: string; existing: DuplicateHit }[]> {
  const rows = await db.all<Active>(`${ACTIVE_SQL} AND l.account_id = ?`, [accountId]);
  const out = [];
  for (const id of itemIds) {
    const item = await db.get<{ id: number; title: string; cover: string | null }>(
      "SELECT i.id, i.title, (SELECT file_name FROM item_photos p WHERE p.item_id = i.id ORDER BY position, id LIMIT 1) AS cover FROM items i WHERE i.id = ?", [id]);
    if (!item) continue;
    for (const r of rows) {
      const reason = await why({ item_id: item.id, title: item.title, cover: item.cover }, r);
      if (reason) {
        out.push({ itemId: item.id, title: item.title, existing: { listingId: r.id, itemId: r.item_id, title: r.title, url: r.url, listedAt: r.listed_at, reason } });
        break;
      }
    }
  }
  return out;
}

/** Throws 409 "Stopp – schon online" unless the seller explicitly wants to upload anyway. */
export async function assertNotOnline(itemIds: number[], accountId: number, force = false) {
  if (force) return;
  const dup = await onlineAlready(itemIds, accountId);
  if (!dup.length) return;
  const list = dup.map((d) => `„${d.title}“ (${d.existing.reason}: „${d.existing.title}“)`).join(", ");
  throw new HttpError(409, `Stopp! Schon online auf diesem Account: ${list}`, { duplicates: dup });
}

// ---------- background check ----------

const warned = new Map<string, Set<string>>();

/** Runs after the syncs: warns once per newly found duplicate (toast + desktop notification). */
export async function watchDuplicates() {
  const seen = warned.get(currentUserId()) ?? new Set<string>();
  warned.set(currentUserId(), seen);
  for (const g of await findDuplicates()) {
    const sig = g.listings.map((l) => l.listingId).sort((a, b) => a - b).join(",");
    if (seen.has(sig)) continue;
    seen.add(sig);
    eventBus.publish({ type: "duplicate", accountId: g.accountId, accountName: g.accountName, titles: g.listings.map((l) => l.title), count: g.listings.length });
  }
}
