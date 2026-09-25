import { db, nowIso } from "../../db/index.js";
import { eventBus } from "../../lib/eventBus.js";
import { storePhotoFromUrl } from "../../storage/photos.js";
import { vintedClient, VintedError, type RemoteListing } from "../../vinted/vintedClient.js";
import {
  addPhoto, CONDITIONS, createItem, createListing, endListing, markListingSold, recomputeItemStatus, type ListingRow,
} from "../archive/repo.js";
import { ingestEvent } from "../automations/engine.js";
import { confirmPrice } from "../pricing/engine.js";
import { getAccount, sessionFor, setAccountStatus, type AccountRow } from "./repo.js";

export interface SyncResult {
  imported: number;
  updated: number;
  ended: number;
  newSales: number;
  newFavourites: number;
  newMessages: number;
  initial: boolean;
  /** Non-fatal problems (e.g. sales feed not readable); profile and listings were synced. */
  warnings: string[];
}

const CONDITION_ALIASES: Record<string, (typeof CONDITIONS)[number]> = {
  "neu mit etikett": "new_with_tags", "new with tags": "new_with_tags", "neu ohne etikett": "new_without_tags",
  "new without tags": "new_without_tags", "sehr gut": "very_good", "very good": "very_good", gut: "good", good: "good",
  zufriedenstellend: "satisfactory", satisfactory: "satisfactory",
};
export function normalizeCondition(raw: string | null | undefined): (typeof CONDITIONS)[number] | null {
  if (!raw) return null;
  if ((CONDITIONS as readonly string[]).includes(raw)) return raw as (typeof CONDITIONS)[number];
  return CONDITION_ALIASES[raw.trim().toLowerCase()] ?? null;
}

const keyFor = (a: AccountRow) => `account:${a.id}`;

/** Imports a listing that exists on Vinted but not yet in the archive. */
async function importRemoteListing(account: AccountRow, r: RemoteListing): Promise<ListingRow> {
  const item = await createItem({
    title: r.title.slice(0, 200) || "Ohne Titel",
    description: r.description.slice(0, 5000),
    brand: r.brand ?? null,
    size: r.size ?? null,
    condition: normalizeCondition(r.condition),
    category: r.category ?? null,
    price_cents: r.priceCents,
    currency: r.currency,
  });
  // Prices already live on Vinted were set by the seller: learn from them.
  if (r.priceCents) await confirmPrice(item.id, r.priceCents, "confirmed");
  for (const url of r.photoUrls.slice(0, 20)) {
    try {
      await addPhoto(item.id, await storePhotoFromUrl(url), null);
    } catch (e) {
      console.warn(`[sync] Foto-Import fehlgeschlagen (${url}):`, (e as Error).message);
    }
  }
  return createListing({
    item_id: item.id, account_id: account.id, vinted_item_id: r.vintedItemId, url: r.url, title: r.title,
    description: r.description, price_cents: r.priceCents, currency: r.currency,
    status: r.status === "sold" ? "sold" : r.status === "hidden" ? "hidden" : "active",
    listed_at: r.createdAt ?? nowIso(), favourites: r.favourites, views: r.views,
  });
}

async function listingByVintedId(accountId: number, vintedItemId: string | null): Promise<ListingRow | undefined> {
  if (!vintedItemId) return undefined;
  return db.get<ListingRow>("SELECT * FROM listings WHERE account_id = ? AND vinted_item_id = ?", [accountId, vintedItemId]);
}

/**
 * Pulls profile, listings, sales, favourites and messages for one account,
 * keeps the archive in sync (never deleting anything) and feeds new events
 * into the automation engine and the live notification stream.
 */
export async function syncAccount(accountId: number): Promise<SyncResult> {
  const account = await getAccount(accountId);
  const session = sessionFor(account);
  const key = keyFor(account);
  const initial = !account.last_sync_at;
  const result: SyncResult = { imported: 0, updated: 0, ended: 0, newSales: 0, newFavourites: 0, newMessages: 0, initial, warnings: [] };

  try {
    const profile = await vintedClient.verifySession(key, session);
    await db.run(`UPDATE accounts SET username = ?, vinted_user_id = ?, followers = ?, active_listings = ?, total_sales = ?,
      unread_messages = COALESCE(?, unread_messages), status = 'connected', last_error = NULL, updated_at = ? WHERE id = ?`,
      [profile.username, profile.userId, profile.followers, profile.activeListings, profile.totalSales, profile.unreadMessages, nowIso(), accountId]);
    session.vintedUserId = profile.userId;

    // --- listings ---
    const remote = await vintedClient.fetchOwnListings(key, session);
    const seen = new Set<string>();
    for (const r of remote) {
      seen.add(r.vintedItemId);
      const local = await listingByVintedId(accountId, r.vintedItemId);
      if (!local) {
        // Only active listings are imported; sold/hidden ones we never saw are skipped.
        if (r.status !== "active") continue;
        await importRemoteListing(account, r);
        result.imported++;
        continue;
      }
      const status = local.status === "sold" ? "sold" : r.status === "hidden" ? "hidden" : r.status === "active" ? "active" : local.status;
      await db.run("UPDATE listings SET favourites = ?, views = ?, price_cents = ?, status = ?, ended_at = CASE WHEN ? = 'active' THEN NULL ELSE ended_at END, updated_at = ? WHERE id = ?",
        [r.favourites, r.views, r.priceCents, status, status, nowIso(), local.id]);
      if (status !== local.status) await recomputeItemStatus(local.item_id);
      result.updated++;
    }
    // Listings that disappeared from Vinted are marked removed; archive data stays.
    if (remote.length > 0) {
      const active = await db.all<ListingRow>("SELECT * FROM listings WHERE account_id = ? AND status = 'active' AND vinted_item_id IS NOT NULL", [accountId]);
      for (const l of active) {
        if (!seen.has(l.vinted_item_id!)) {
          await endListing(l.id, "removed");
          result.ended++;
        }
      }
    }

    // Sales, favourites and messages are best-effort: profile and listings are
    // already stored; a failing feed is reported as a warning, never faked.
    const optional = async <T>(label: string, fn: () => Promise<T[]>): Promise<T[]> => {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof VintedError && e.code === "auth") throw e;
        result.warnings.push(`${label} konnten nicht abgerufen werden: ${(e as Error).message}`);
        return [];
      }
    };

    // --- sales ---
    for (const s of await optional("Verkäufe", () => vintedClient.fetchSales(key, session))) {
      const listing = await listingByVintedId(accountId, s.vintedItemId);
      const item = listing ? await db.get<{ category: string | null; brand: string | null }>("SELECT category, brand FROM items WHERE id = ?", [listing.item_id]) : null;
      const inserted = await db.run(`INSERT INTO sales (account_id, listing_id, item_id, external_id, title, price_cents, currency, buyer, category, brand, sold_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        [accountId, listing?.id ?? null, listing?.item_id ?? null, s.externalId, s.title, s.priceCents, s.currency, s.buyer, item?.category ?? null, item?.brand ?? null, s.soldAt]);
      if (!inserted) continue;
      if (listing && listing.status !== "sold") await markListingSold(listing.id, s.soldAt, s.priceCents);
      result.newSales++;
      await ingestEvent({
        accountId, type: "sale", externalId: s.externalId, listingId: listing?.id ?? null, userId: s.buyer ? `buyer:${s.buyer}` : null,
        username: s.buyer, payload: { vintedItemId: s.vintedItemId, priceCents: s.priceCents }, occurredAt: s.soldAt,
      }, initial);
      if (!initial) {
        eventBus.publish({
          type: "sale", accountId, accountName: account.name, itemId: listing?.item_id ?? null, title: s.title,
          priceCents: s.priceCents, currency: s.currency, soldAt: s.soldAt,
        });
      }
    }

    // --- favourites ---
    for (const f of await optional("Favoriten", () => vintedClient.fetchFavourites(key, session))) {
      const listing = await listingByVintedId(accountId, f.vintedItemId);
      const r = await ingestEvent({
        accountId, type: "favourite", externalId: f.externalId, listingId: listing?.id ?? null, userId: f.userId, username: f.username,
        payload: { vintedItemId: f.vintedItemId }, occurredAt: f.occurredAt,
      }, initial);
      if (r.isNew) {
        result.newFavourites++;
        if (!initial) eventBus.publish({ type: "favourite", accountId, title: listing?.title ?? "Artikel", user: f.username });
      }
    }

    // --- messages ---
    for (const m of await optional("Nachrichten", () => vintedClient.fetchMessages(key, session))) {
      const listing = await listingByVintedId(accountId, m.vintedItemId);
      const r = await ingestEvent({
        accountId, type: "message", externalId: m.externalId, listingId: listing?.id ?? null, userId: m.userId, username: m.username,
        payload: { text: m.text, conversationId: m.conversationId, vintedItemId: m.vintedItemId }, occurredAt: m.occurredAt,
      }, initial);
      if (r.isNew) {
        result.newMessages++;
        if (!initial) eventBus.publish({ type: "message", accountId, user: m.username, preview: m.text.slice(0, 120) });
      }
    }

    if (result.warnings.length) console.warn(`[sync] Account ${accountId}:`, result.warnings.join(" | "));
    await db.run("UPDATE accounts SET last_sync_at = ?, updated_at = ? WHERE id = ?", [nowIso(), nowIso(), accountId]);
    eventBus.publish({ type: "account_status", accountId, status: "connected" });
    return result;
  } catch (e) {
    const msg = (e as Error).message;
    const current = (await getAccount(accountId)).status;
    const status = e instanceof VintedError && e.code === "auth" ? "error" : current === "pending" ? "error" : current;
    await setAccountStatus(accountId, status, msg);
    eventBus.publish({ type: "account_status", accountId, status, error: msg });
    throw e;
  }
}
