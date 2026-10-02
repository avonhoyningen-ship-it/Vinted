import { z } from "zod";
import { currentUserId, db } from "../../db/index.js";
import { eventBus, type RepriceStatus } from "../../lib/eventBus.js";
import { HttpError } from "../../lib/http.js";
import { chromeUrlFor, getAccount } from "../accounts/repo.js";
import { getListing, setListingPrice } from "../archive/repo.js";
import { reducedPrice } from "../automations/engine.js";
import { changePriceInChrome, type PriceJob, type PriceResult } from "./chromePrice.js";

/**
 * "Preis senken": lowers the price of selected listings (or all with few
 * views) by a percentage – in the seller's Vinted-Chrome, one after another.
 * Cloud: the PC helper does the Chrome part.
 */

export const repriceInput = z.object({
  percent: z.number().min(1).max(80),
  /** Never below this price (cents) */
  minPriceCents: z.number().int().min(100).optional(),
  /** Either explicit listings … */
  listingIds: z.array(z.number().int().positive()).max(500).optional(),
  /** … or all active listings with fewer views than this … */
  maxViews: z.number().int().min(1).optional(),
  /** … that have been online at least this many days. */
  minDays: z.number().min(0).optional(),
}).refine((x) => x.listingIds?.length || x.maxViews, { message: "Artikel auswählen oder eine Aufruf-Grenze angeben" });
export type RepriceInput = z.infer<typeof repriceInput>;

export interface PlanRow {
  listingId: number; title: string; accountName: string; views: number; daysOnline: number;
  oldCents: number; newCents: number; skip: string | null;
}

export async function planReprice(input: RepriceInput): Promise<PlanRow[]> {
  const rows = await db.all<{ id: number; title: string; account_name: string; views: number; listed_at: string; price_cents: number | null; vinted_item_id: string | null }>(`
    SELECT l.id, l.title, a.name AS account_name, l.views, l.listed_at, l.price_cents, l.vinted_item_id
    FROM listings l JOIN accounts a ON a.id = l.account_id WHERE l.status = 'active' ORDER BY l.views, l.listed_at`);
  const wanted = input.listingIds ? new Set(input.listingIds) : null;
  const plan: PlanRow[] = [];
  for (const r of rows) {
    const daysOnline = (Date.now() - Date.parse(r.listed_at)) / 86400_000;
    if (wanted ? !wanted.has(Number(r.id)) : !(Number(r.views) < input.maxViews! && daysOnline >= (input.minDays ?? 0))) continue;
    const old = r.price_cents ?? 0;
    const next = old ? reducedPrice(old, input.percent, input.minPriceCents ?? null) : 0;
    const skip = !r.vinted_item_id ? "Keine Vinted-Artikelnummer (Link fehlt)" : !old ? "Kein Preis" : next >= old ? "Mindestpreis erreicht" : null;
    plan.push({ listingId: Number(r.id), title: r.title, accountName: r.account_name, views: Number(r.views), daysOnline: Math.floor(daysOnline), oldCents: old, newCents: next, skip });
  }
  return plan;
}

// ---------- executing one change ----------

type Executor = (job: PriceJob) => Promise<PriceResult>;
let executor: Executor = changePriceInChrome;
/** Cloud: runs the change on the PC helper (set at startup). Tests: a fake. */
export function setPriceExecutor(fn: Executor) {
  executor = fn;
}

/** Changes one listing's price on Vinted (Chrome) and records it; throws with a clear message on failure. */
export async function changeListingPrice(listingId: number, newCents: number, reason: string): Promise<PriceResult> {
  const listing = await getListing(listingId);
  if (!listing.vinted_item_id) throw new HttpError(400, "Keine Vinted-Artikelnummer");
  const account = await getAccount(listing.account_id);
  const job: PriceJob = { listingId, vintedItemId: listing.vinted_item_id, domain: account.domain, chromeUrl: chromeUrlFor(account), newCents };
  const result = await executor(job);
  if (result.ok) await setListingPrice(listingId, newCents, reason);
  return result;
}

// ---------- batch with live progress ----------

const runs = new Map<string, { status: RepriceStatus; stop: boolean }>();
const idle = (): RepriceStatus => ({ state: "idle", percent: 0, total: 0, done: 0, items: [], message: null });

export const getRepriceStatus = () => runs.get(currentUserId())?.status ?? idle();

function publish(status: RepriceStatus) {
  eventBus.publish({ type: "reprice", status: { ...status, items: status.items.map((i) => ({ ...i })) } });
}

export async function startReprice(input: RepriceInput): Promise<RepriceStatus> {
  const userId = currentUserId();
  if (runs.get(userId)?.status.state === "running") throw new HttpError(409, "Es läuft bereits eine Preissenkung");
  const plan = (await planReprice(input)).filter((p) => !p.skip);
  if (!plan.length) throw new HttpError(400, "Keine Artikel zum Senken (Auswahl leer, Mindestpreis erreicht oder ohne Vinted-Link)");
  const status: RepriceStatus = {
    state: "running", percent: input.percent, total: plan.length, done: 0, message: null,
    items: plan.map((p) => ({ listingId: p.listingId, title: p.title, oldCents: p.oldCents, newCents: p.newCents, state: "queued", message: null })),
  };
  const run = { status, stop: false };
  runs.set(userId, run);
  publish(status);
  void (async () => {
    for (const item of status.items) {
      if (run.stop) { item.state = "skipped"; item.message = "gestoppt"; continue; }
      item.state = "running";
      publish(status);
      try {
        const r = await changeListingPrice(item.listingId, item.newCents, `Preissenkung −${input.percent} %`);
        item.state = r.ok ? "done" : "failed";
        item.message = r.message;
      } catch (e) {
        item.state = "failed";
        item.message = (e as Error).message;
        // Chrome not running / not logged in: no point in trying the rest.
        if (e instanceof HttpError && e.status === 503) {
          run.stop = true;
          status.message = item.message;
        }
      }
      status.done++;
      publish(status);
      await new Promise((r) => setTimeout(r, 1500)); // let Vinted's pages settle between items
    }
    const ok = status.items.filter((i) => i.state === "done").length;
    status.state = "done";
    status.message ??= `${ok} von ${status.total} Preisen gesenkt`;
    publish(status);
  })();
  return status;
}

export function stopReprice() {
  const run = runs.get(currentUserId());
  if (run) run.stop = true;
}
