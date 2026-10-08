import sharp from "sharp";
import { db, nowIso } from "../../db/index.js";
import { readPhoto } from "../../storage/photos.js";
import { recomputeItemStatus } from "../archive/repo.js";

/**
 * One garment = one article. The same shirt can end up as two archive items
 * (e.g. uploaded by hand on Vinted and then imported, or imported again on
 * another PC). This finds such items by their photos and merges them: the
 * older item keeps everything (listings, sales, price history), the copy goes.
 */

// ---------- photo fingerprint: 256-bit difference hash + average colour ----------

interface Print { bits: bigint; rgb: [number, number, number] }
const cache = new Map<string, Print | null>();

export async function fingerprint(input: Buffer): Promise<Print> {
  const img = sharp(input).rotate();
  const gray = await img.clone().grayscale().resize(17, 16, { fit: "fill" }).raw().toBuffer();
  let bits = 0n;
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) bits = (bits << 1n) | (gray[y * 17 + x]! < gray[y * 17 + x + 1]! ? 1n : 0n);
  const { channels } = await img.clone().removeAlpha().resize(1, 1, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true }).then((r) => ({ channels: [...r.data] }));
  return { bits, rgb: [channels[0]!, channels[1]!, channels[2]!] };
}

function distance(a: bigint, b: bigint) {
  let v = a ^ b;
  let n = 0;
  while (v) { n += Number(v & 1n); v >>= 1n; }
  return n;
}

/** Same photo (also after Vinted re-compressed or resized it). */
export function samePhoto(a: Print, b: Print) {
  const colour = Math.hypot(a.rgb[0] - b.rgb[0], a.rgb[1] - b.rgb[1], a.rgb[2] - b.rgb[2]);
  return distance(a.bits, b.bits) <= 24 && colour < 24;
}

async function printOf(fileName: string) {
  if (!cache.has(fileName)) cache.set(fileName, await readPhoto(fileName).then(fingerprint).catch(() => null));
  return cache.get(fileName)!;
}

async function printsOfItem(itemId: number) {
  const photos = await db.all<{ file_name: string }>("SELECT file_name FROM item_photos WHERE item_id = ? ORDER BY position, id LIMIT 4", [itemId]);
  return (await Promise.all(photos.map((p) => printOf(p.file_name)))).filter((p): p is Print => !!p);
}

/** Two items show the same garment: at least two photos match (or the only photo, if one has just one). */
function sameGarment(a: Print[], b: Print[]) {
  if (!a.length || !b.length) return false;
  let matches = 0;
  for (const x of a) if (b.some((y) => samePhoto(x, y))) matches++;
  return matches >= Math.min(2, a.length, b.length);
}

// ---------- merging ----------

/** Moves everything of `dupId` to `keepId` and deletes the copy. */
export async function mergeItems(keepId: number, dupId: number) {
  await db.tx(async () => {
    await db.run("UPDATE listings SET item_id = ? WHERE item_id = ?", [keepId, dupId]);
    await db.run("UPDATE sales SET item_id = ? WHERE item_id = ?", [keepId, dupId]);
    await db.run("UPDATE publish_queue SET item_id = ? WHERE item_id = ?", [keepId, dupId]);
    // Price examples: keep the existing ones of the kept item (one per source).
    await db.run("DELETE FROM price_examples WHERE item_id = ? AND source IN (SELECT source FROM price_examples WHERE item_id = ?)", [dupId, keepId]);
    await db.run("UPDATE price_examples SET item_id = ? WHERE item_id = ?", [keepId, dupId]);
    // Photos: the kept item keeps its own; it only takes over the copy's photos if it has none.
    const own = Number((await db.get<{ c: number }>("SELECT COUNT(*) c FROM item_photos WHERE item_id = ?", [keepId]))!.c);
    if (!own) await db.run("UPDATE item_photos SET item_id = ? WHERE item_id = ?", [keepId, dupId]);
    await db.run("DELETE FROM items WHERE id = ?", [dupId]);
    await db.run("UPDATE items SET updated_at = ? WHERE id = ?", [nowIso(), keepId]);
  });
  await recomputeItemStatus(keepId);
}

/** After an import: if this item is a garment that already exists, merge it into the existing one. Returns the id to use. */
export async function mergeIfKnown(itemId: number): Promise<number> {
  const mine = await printsOfItem(itemId);
  if (!mine.length) return itemId;
  const others = await db.all<{ id: number }>("SELECT id FROM items WHERE id <> ? ORDER BY id", [itemId]);
  for (const o of others) {
    if (sameGarment(mine, await printsOfItem(o.id))) {
      const [keep, dup] = o.id < itemId ? [o.id, itemId] : [itemId, o.id];
      await mergeItems(keep, dup);
      return keep;
    }
  }
  return itemId;
}

/** Cleans up the whole archive once: every garment ends up as exactly one item. Returns how many copies were merged. */
export async function mergeAllDuplicates(): Promise<number> {
  const items = await db.all<{ id: number }>("SELECT id FROM items ORDER BY id");
  const prints = new Map<number, Print[]>();
  for (const i of items) prints.set(i.id, await printsOfItem(i.id));
  const gone = new Set<number>();
  let merged = 0;
  for (const [n, a] of items.entries()) {
    if (gone.has(a.id)) continue;
    for (const b of items.slice(n + 1)) {
      if (gone.has(b.id) || !sameGarment(prints.get(a.id)!, prints.get(b.id)!)) continue;
      await mergeItems(a.id, b.id);
      gone.add(b.id);
      merged++;
    }
  }
  return merged;
}
