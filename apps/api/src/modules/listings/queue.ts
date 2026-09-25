import { z } from "zod";
import { env } from "../../config/env.js";
import { db, nowIso } from "../../db/index.js";
import { eventBus } from "../../lib/eventBus.js";
import { HttpError, notFound } from "../../lib/http.js";
import { photoPath } from "../../storage/photos.js";
import { vintedClient, VintedError } from "../../vinted/vintedClient.js";
import { getAccount, sessionFor, type AccountRow } from "../accounts/repo.js";
import { createListing, getItem, listPhotos, recomputeItemStatus } from "../archive/repo.js";

export const enqueueInput = z.object({
  itemIds: z.array(z.number().int().positive()).min(1).max(200),
  accountId: z.number().int().positive(),
  startAt: z.string().datetime({ offset: true }).optional(),
  intervalMinutes: z.number().int().min(5).max(24 * 60).optional(),
});

export interface QueueRow {
  id: number; item_id: number; account_id: number; scheduled_at: string; status: string; attempts: number;
  last_error: string | null; listing_id: number | null; is_reupload: number; created_at: string; updated_at: string;
}

export const intervalFor = (a: AccountRow) => a.publish_interval_minutes ?? env.publishIntervalMinutes;

function assertPublishable(itemId: number, accountId: number) {
  const item = getItem(itemId);
  if (!item.title.trim() || item.price_cents === null) throw new HttpError(400, `Artikel #${itemId} braucht Titel und Preis`);
  if (!listPhotos(itemId).length) throw new HttpError(400, `Artikel #${itemId} braucht mindestens ein Foto`);
  const active = db.prepare("SELECT COUNT(*) c FROM listings WHERE item_id = ? AND account_id = ? AND status = 'active'").get(itemId, accountId) as { c: number };
  if (active.c > 0) throw new HttpError(409, `Artikel #${itemId} ist auf diesem Account bereits aktiv`);
  const queued = db.prepare("SELECT COUNT(*) c FROM publish_queue WHERE item_id = ? AND status IN ('pending','processing')").get(itemId) as { c: number };
  if (queued.c > 0) throw new HttpError(409, `Artikel #${itemId} ist bereits in der Warteschlange`);
}

/**
 * Appends items to an account's queue, spaced by the account's interval,
 * starting after the last already-scheduled entry.
 */
export function enqueue(input: z.infer<typeof enqueueInput>, isReupload = false): QueueRow[] {
  if (!vintedClient.canPublish) {
    throw new HttpError(409, "Automatisches Einstellen ist nicht verfügbar (keine offizielle Vinted-API). Nutze beim Artikel „Bei Vinted einstellen“.");
  }
  const account = getAccount(input.accountId);
  if (!account.session_encrypted) throw new HttpError(400, "Account hat keine Session");
  input.itemIds.forEach((id) => assertPublishable(id, account.id));
  const interval = (input.intervalMinutes ?? intervalFor(account)) * 60_000;
  const last = db.prepare("SELECT MAX(scheduled_at) m FROM publish_queue WHERE account_id = ? AND status IN ('pending','processing')").get(account.id) as { m: string | null };
  let t = Math.max(input.startAt ? Date.parse(input.startAt) : Date.now(), last.m ? Date.parse(last.m) + interval : 0);
  const ids: number[] = [];
  db.transaction(() => {
    for (const itemId of input.itemIds) {
      const r = db.prepare("INSERT INTO publish_queue (item_id, account_id, scheduled_at, is_reupload) VALUES (?, ?, ?, ?)")
        .run(itemId, account.id, new Date(t).toISOString(), isReupload ? 1 : 0);
      ids.push(Number(r.lastInsertRowid));
      recomputeItemStatus(itemId);
      t += interval;
    }
  })();
  return ids.map(getQueueEntry);
}

export function getQueueEntry(id: number): QueueRow {
  const q = db.prepare("SELECT * FROM publish_queue WHERE id = ?").get(id) as unknown as QueueRow | undefined;
  if (!q) throw notFound("Warteschlangen-Eintrag");
  return q;
}

export function listQueue(status?: string) {
  return db.prepare(`
    SELECT q.*, i.title, i.price_cents, i.currency, a.name AS account_name,
      (SELECT file_name FROM item_photos p WHERE p.item_id = i.id ORDER BY position, id LIMIT 1) AS cover_photo
    FROM publish_queue q JOIN items i ON i.id = q.item_id JOIN accounts a ON a.id = q.account_id
    WHERE (@status IS NULL OR q.status = @status)
    ORDER BY CASE q.status WHEN 'processing' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, q.scheduled_at
    LIMIT 500
  `).all({ status: status ?? null });
}

export function cancelQueueEntry(id: number) {
  const q = getQueueEntry(id);
  if (q.status !== "pending" && q.status !== "failed") throw new HttpError(409, "Nur wartende oder fehlgeschlagene Einträge können storniert werden");
  db.prepare("UPDATE publish_queue SET status = 'cancelled', updated_at = ? WHERE id = ?").run(nowIso(), id);
  recomputeItemStatus(q.item_id);
}

export function rescheduleQueueEntry(id: number, at: string) {
  const q = getQueueEntry(id);
  if (!["pending", "failed"].includes(q.status)) throw new HttpError(409, "Eintrag kann nicht neu geplant werden");
  db.prepare("UPDATE publish_queue SET status = 'pending', scheduled_at = ?, last_error = NULL, updated_at = ? WHERE id = ?").run(at, nowIso(), id);
  recomputeItemStatus(q.item_id);
  return getQueueEntry(id);
}

/** Publishes one queue entry through the Vinted client. */
export async function publishEntry(q: QueueRow): Promise<void> {
  db.prepare("UPDATE publish_queue SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(nowIso(), q.id);
  const account = getAccount(q.account_id);
  const item = getItem(q.item_id);
  try {
    const photos = listPhotos(item.id);
    const res = await vintedClient.createListing(`account:${account.id}`, sessionFor(account), {
      title: item.title, description: item.description, priceCents: item.price_cents ?? 0, currency: item.currency,
      brand: item.brand, size: item.size, condition: item.condition, category: item.category, color: item.color,
      photos: photos.map((p) => ({ path: photoPath(p.file_name), mimeType: p.mime_type })),
    });
    const listing = createListing({
      item_id: item.id, account_id: account.id, vinted_item_id: res.vintedItemId, url: res.url, title: item.title,
      description: item.description, price_cents: item.price_cents, currency: item.currency,
    });
    db.prepare("UPDATE publish_queue SET status = 'done', listing_id = ?, last_error = NULL, updated_at = ? WHERE id = ?").run(listing.id, nowIso(), q.id);
    recomputeItemStatus(item.id);
    eventBus.publish({ type: "published", accountId: account.id, itemId: item.id, title: item.title });
  } catch (e) {
    const msg = (e as Error).message;
    // Rate limits: push back instead of failing.
    if (e instanceof VintedError && e.code === "rate_limit" && q.attempts < 5) {
      const later = new Date(Date.now() + intervalFor(account) * 60_000).toISOString();
      db.prepare("UPDATE publish_queue SET status = 'pending', scheduled_at = ?, last_error = ?, updated_at = ? WHERE id = ?").run(later, msg, nowIso(), q.id);
    } else {
      db.prepare("UPDATE publish_queue SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?").run(msg, nowIso(), q.id);
      eventBus.publish({ type: "queue_failed", accountId: account.id, itemId: item.id, error: msg });
    }
    recomputeItemStatus(item.id);
  }
}

/**
 * Called by the scheduler: publishes at most one due entry per account and
 * never faster than the account's interval since its last publication.
 */
export async function processDueQueue(): Promise<number> {
  const due = db.prepare(`
    SELECT q.* FROM publish_queue q JOIN accounts a ON a.id = q.account_id
    WHERE q.status = 'pending' AND q.scheduled_at <= ? AND a.status = 'connected'
    ORDER BY q.scheduled_at
  `).all(nowIso()) as unknown as QueueRow[];
  const handled = new Set<number>();
  let n = 0;
  for (const q of due) {
    if (handled.has(q.account_id)) continue;
    handled.add(q.account_id);
    const account = getAccount(q.account_id);
    const lastPublished = db.prepare(`SELECT MAX(l.listed_at) m FROM listings l JOIN publish_queue pq ON pq.listing_id = l.id WHERE l.account_id = ?`).get(q.account_id) as { m: string | null };
    const minGap = Math.min(intervalFor(account), env.publishIntervalMinutes) * 60_000 * 0.5;
    if (lastPublished.m && Date.now() - Date.parse(lastPublished.m) < minGap) continue;
    await publishEntry(q);
    n++;
  }
  return n;
}
