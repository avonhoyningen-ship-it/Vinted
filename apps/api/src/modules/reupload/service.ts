import { z } from "zod";
import { env } from "../../config/env.js";
import { currentUserId } from "../../db/index.js";
import { HttpError } from "../../lib/http.js";
import { chromeUrlFor, getAccount } from "../accounts/repo.js";
import { endListing, getListing } from "../archive/repo.js";
import { startAssist } from "../assist/assistant.js";
import { confirmPrice } from "../pricing/engine.js";
import { deleteInChrome, type DeleteJob, type DeleteResult } from "./chromeDelete.js";

/**
 * Re-upload of online listings: delete each one on Vinted (in the Vinted-Chrome),
 * keep its current price, then the posting assistant prepares them again – the AI
 * writes title and description fresh, the seller clicks "Hochladen" as always.
 */
type Deleter = (job: DeleteJob) => Promise<DeleteResult>;
type Launcher = (itemIds: number[], accountId: number) => Promise<unknown>;
let deleter: Deleter = deleteInChrome;
let launcher: Launcher = startAssist;

/** Cloud: delete and assistant run on the PC helper (set at startup). Tests: fakes. */
export function setReuploadDeps(deps: { deleter?: Deleter; launcher?: Launcher }) {
  if (deps.deleter) deleter = deps.deleter;
  if (deps.launcher) launcher = deps.launcher;
}

/** Deletes one listing on Vinted and keeps its current price for the new upload; throws on failure. */
async function deleteForReupload(listingId: number) {
  const listing = await getListing(listingId);
  if (listing.status !== "active") throw new HttpError(400, "Der Artikel ist nicht mehr online");
  if (!listing.vinted_item_id) throw new HttpError(400, "Keine Vinted-Artikelnummer – Re-Upload nicht möglich");
  const account = await getAccount(listing.account_id);
  const r = await deleter({ vintedItemId: listing.vinted_item_id, domain: account.domain, chromeUrl: chromeUrlFor(account) });
  if (!r.ok) throw new HttpError(502, `Löschen auf Vinted hat nicht geklappt: ${r.message}`);
  await endListing(listing.id, "removed");
  // The new listing gets the price the old one had on Vinted (incl. earlier price drops).
  if (listing.price_cents) await confirmPrice(listing.item_id, Number(listing.price_cents), "confirmed");
  return { listing, message: r.message };
}

export async function reuploadListing(listingId: number) {
  const { listing, message } = await deleteForReupload(listingId);
  const assist = await launcher([listing.item_id], listing.account_id);
  return { deleted: message, itemId: listing.item_id, priceCents: listing.price_cents, assist };
}

// ---------- several at once, with live progress ----------

export const batchInput = z.object({ listingIds: z.array(z.number().int().positive()).min(1).max(200) });

export interface ReuploadStatus {
  state: "idle" | "running" | "done";
  total: number;
  done: number;
  message: string | null;
  items: { listingId: number; title: string; priceCents: number | null; state: "queued" | "deleting" | "deleted" | "failed" | "skipped"; message: string | null }[];
}

const runs = new Map<string, { status: ReuploadStatus; stop: boolean }>();
export const getReuploadStatus = (): ReuploadStatus =>
  runs.get(currentUserId())?.status ?? { state: "idle", total: 0, done: 0, message: null, items: [] };

export async function startBatchReupload(listingIds: number[]): Promise<ReuploadStatus> {
  const userId = currentUserId();
  if (runs.get(userId)?.status.state === "running") throw new HttpError(409, "Es läuft bereits ein Re-Upload");
  const listings = [];
  for (const id of listingIds) listings.push(await getListing(id));
  const status: ReuploadStatus = {
    state: "running", total: listings.length, done: 0, message: null,
    items: listings.map((l) => ({ listingId: l.id, title: l.title, priceCents: l.price_cents, state: "queued", message: null })),
  };
  const run = { status, stop: false };
  runs.set(userId, run);
  let prepared = 0;
  void (async () => {
    // Local: each article is prepared right after it was deleted (nothing gets lost if a later one fails).
    // Cloud: the helper takes one batch per account, so they are handed over at the end.
    const eachNow = env.appMode === "local";
    const ready = new Map<number, number[]>(); // account → items to upload again
    for (const item of status.items) {
      if (run.stop) { item.state = "skipped"; item.message = "gestoppt"; status.done++; continue; }
      item.state = "deleting";
      try {
        const { listing, message } = await deleteForReupload(item.listingId);
        item.state = "deleted";
        item.message = message;
        if (eachNow) {
          await launcher([listing.item_id], listing.account_id).catch((e) => {
            item.message = `Gelöscht, aber Vorbereiten fehlgeschlagen: ${(e as Error).message}`;
          });
        } else ready.set(listing.account_id, [...(ready.get(listing.account_id) ?? []), listing.item_id]);
        prepared++;
      } catch (e) {
        item.state = "failed";
        item.message = (e as Error).message;
        if (/niemand eingeloggt|Chrome fuer Vinted starten|PC-Helfer/i.test(item.message)) { run.stop = true; status.message = item.message; }
      }
      status.done++;
    }
    for (const [accountId, itemIds] of ready) {
      try {
        await launcher(itemIds, accountId);
      } catch (e) {
        status.message = `Gelöscht, aber Vorbereiten fehlgeschlagen: ${(e as Error).message} – die Artikel liegen im Archiv und können über „Bei Vinted vorbereiten“ neu gestartet werden.`;
      }
    }
    const n = prepared;
    status.message ??= n ? `${n} gelöscht – der Vinted-Chrome bereitet sie jetzt neu vor. Danach jeweils „Hochladen“ klicken.` : "Nichts gelöscht.";
    status.state = "done";
  })();
  return status;
}

export function stopBatchReupload() {
  const run = runs.get(currentUserId());
  if (run) run.stop = true;
}
