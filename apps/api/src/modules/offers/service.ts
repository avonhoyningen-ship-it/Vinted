import { currentUserId, db, nowIso } from "../../db/index.js";
import { getSetting, getSettings } from "../../lib/settings.js";
import { vintedClient } from "../../vinted/vintedClient.js";
import type { RemoteOffer } from "../../vinted/types.js";
import { chromeUrlFor, sessionFor, type AccountRow } from "../accounts/repo.js";
import { priceText } from "../assist/assistant.js";
import { DEFAULT_TEXTS, getOutreachStatus, planOutreach, startOutreach } from "../outreach/service.js";
import { answerOfferInChrome, type OfferAnswerJob, type OfferAnswerResult } from "./chromeOffer.js";

/**
 * Runs in the background (local version, Vinted-Chrome):
 * 1. Everyone who favourites an active item gets a price offer (−20 %, even euros) – once per item and member.
 * 2. Price offers from buyers are answered: within the allowed discount → accepted,
 *    below → counter-offer at the lowest allowed price. The allowed discount depends on how long
 *    the item has been online (default: 20 % in the first week, 30 % after that).
 */

export interface OfferRules { maxPercentNew: number; maxPercentOld: number; oldAfterDays: number }

export type OfferDecision =
  | { action: "accept"; maxPercent: number; minCents: number; old: boolean }
  | { action: "counter"; cents: number; maxPercent: number; minCents: number; old: boolean }
  | { action: "skip"; reason: string };

/** What to do with an offer of `offerCents` for an item at `priceCents` listed at `listedAt`. */
export function decideOffer(offerCents: number, priceCents: number, listedAt: string | null, rules: OfferRules, now = Date.now()): OfferDecision {
  if (!priceCents || priceCents <= 0) return { action: "skip", reason: "Artikel hat keinen Preis" };
  const days = listedAt ? (now - Date.parse(listedAt)) / 86400_000 : 0;
  const old = days >= rules.oldAfterDays;
  const maxPercent = old ? rules.maxPercentOld : rules.maxPercentNew;
  const minCents = Math.ceil((priceCents * (100 - maxPercent)) / 100);
  if (offerCents >= minCents) return { action: "accept", maxPercent, minCents, old };
  // Counter with the lowest allowed price: even euros if possible, never below the limit.
  let cents = Math.ceil(minCents / 200) * 200;
  if (cents >= priceCents) cents = Math.ceil(minCents / 100) * 100;
  if (cents >= priceCents) cents = minCents;
  if (cents >= priceCents) return { action: "skip", reason: "Kein Spielraum für ein Gegenangebot" };
  return { action: "counter", cents, maxPercent, minCents, old };
}

// ---------- log (what the automation did; shown in the settings) ----------

export interface OfferLogEntry {
  at: string;
  kind: "reply" | "favourites";
  account: string;
  name: string;
  title: string;
  text: string;
  ok: boolean;
}
const logs = new Map<string, OfferLogEntry[]>();
function addLog(e: Omit<OfferLogEntry, "at">) {
  const list = logs.get(currentUserId()) ?? [];
  list.unshift({ at: nowIso(), ...e });
  logs.set(currentUserId(), list.slice(0, 50));
  console.log(`[offers] ${e.account}: ${e.name} – ${e.title}: ${e.text}`);
}
export const getOfferLog = () => logs.get(currentUserId()) ?? [];

// ---------- 1. offers to members who favourited ----------

export async function autoFavouriteOffers(): Promise<number> {
  const s = await getSettings();
  if (!s["offers.autoFavourites"] || s["automation.paused"]) return 0;
  if (getOutreachStatus().state === "running") return 0; // a manual or earlier run is still sending
  const percent = s["offers.favouritePercent"];
  const { targets } = await planOutreach("favourites", percent);
  const open = targets.filter((t) => !t.skip && !t.alreadySent).slice(0, 500);
  if (!open.length) return 0;
  try {
    await startOutreach({ kind: "favourites", keys: open.map((t) => t.key), text: DEFAULT_TEXTS.favourites, percent });
    addLog({ kind: "favourites", account: "alle", name: `${open.length} Mitglieder`, title: "Favoriten", text: `Angebote −${percent} % werden verschickt`, ok: true });
    return open.length;
  } catch (e) {
    // Daily message cap reached etc. – try again on the next round.
    console.warn("[offers] Favoriten-Angebote:", (e as Error).message);
    return 0;
  }
}

// ---------- 2. answering buyers' offers ----------

type Answerer = (job: OfferAnswerJob) => Promise<OfferAnswerResult>;
let answerer: Answerer = answerOfferInChrome;
/** Tests: a fake instead of the Vinted-Chrome. */
export function setOfferAnswerer(fn: Answerer) {
  answerer = fn;
}

const attempts = new Map<string, number>();
const MAX_ATTEMPTS = 2;

async function handled(accountId: number, key: string) {
  return !!(await db.get("SELECT 1 FROM outreach_log WHERE account_id = ? AND kind = 'offer_reply' AND target_key = ?", [accountId, key]));
}
async function markHandled(accountId: number, key: string) {
  await db.run("INSERT INTO outreach_log (account_id, kind, target_key, sent_at) VALUES (?, 'offer_reply', ?, ?) ON CONFLICT DO NOTHING", [accountId, key, nowIso()]);
}

async function answerOne(a: AccountRow, o: RemoteOffer, rules: OfferRules): Promise<boolean> {
  const tries = attempts.get(`${a.id}:${o.externalId}`) ?? 0;
  if (tries >= MAX_ATTEMPTS || (await handled(a.id, o.externalId))) return false;
  const listing = o.vintedItemId
    ? await db.get<{ id: number; title: string; price_cents: number | null; listed_at: string | null; status: string }>(
      "SELECT id, title, price_cents, listed_at, status FROM listings WHERE account_id = ? AND vinted_item_id = ? ORDER BY status = 'active' DESC LIMIT 1", [a.id, o.vintedItemId])
    : undefined;
  const base = { kind: "reply" as const, account: a.name, name: o.username };
  // Old offer for an item that is sold or gone: nothing to answer.
  if (listing && listing.status !== "active") {
    await markHandled(a.id, o.externalId);
    return false;
  }
  if (!listing) {
    await markHandled(a.id, o.externalId);
    addLog({ ...base, title: o.vintedItemId ? `Artikel ${o.vintedItemId}` : "unbekannter Artikel", text: `Angebot ${priceText(o.priceCents)} € – Artikel nicht als aktiv im Dashboard, bitte selbst antworten`, ok: false });
    return false;
  }
  const d = decideOffer(o.priceCents, Number(listing.price_cents ?? 0), listing.listed_at, rules);
  if (d.action === "skip") {
    await markHandled(a.id, o.externalId);
    addLog({ ...base, title: listing.title, text: `Angebot ${priceText(o.priceCents)} € – ${d.reason}`, ok: false });
    return false;
  }
  const r = await answerer({
    conversationId: o.conversationId, domain: a.domain, chromeUrl: chromeUrlFor(a), action: d.action, cents: d.action === "counter" ? d.cents : undefined,
  });
  const why = `${d.old ? "über" : "unter"} ${rules.oldAfterDays} Tage online, bis −${d.maxPercent} % = ${priceText(d.minCents)} €`;
  const what = d.action === "accept"
    ? `Angebot ${priceText(o.priceCents)} € angenommen (${why})`
    : `Angebot ${priceText(o.priceCents)} € zu niedrig → Gegenangebot ${priceText(d.cents)} € (${why})`;
  if (r.ok) {
    await markHandled(a.id, o.externalId);
    addLog({ ...base, title: listing.title, text: what, ok: true });
    return true;
  }
  attempts.set(`${a.id}:${o.externalId}`, tries + 1);
  addLog({ ...base, title: listing.title, text: `${what} – fehlgeschlagen: ${r.message}`, ok: false });
  return false;
}

export async function autoReplyOffers(): Promise<number> {
  const s = await getSettings();
  if (!s["offers.autoReply"] || s["automation.paused"]) return 0;
  const rules: OfferRules = { maxPercentNew: s["offers.maxPercentNew"], maxPercentOld: s["offers.maxPercentOld"], oldAfterDays: s["offers.oldAfterDays"] };
  let done = 0;
  for (const a of await db.all<AccountRow>("SELECT * FROM accounts WHERE status = 'connected' ORDER BY id")) {
    let offers: RemoteOffer[];
    try {
      offers = await vintedClient.fetchOffers(`account:${a.id}`, sessionFor(a));
    } catch (e) {
      console.warn(`[offers] ${a.name}: Angebote nicht lesbar – ${(e as Error).message}`);
      continue;
    }
    for (const o of offers) {
      try {
        if (await answerOne(a, o, rules)) done++;
      } catch (e) {
        // Chrome not running etc.: stop for this round, try again next time.
        console.warn(`[offers] ${a.name}:`, (e as Error).message);
        break;
      }
    }
  }
  return done;
}

export async function offerStatus() {
  return {
    autoFavourites: await getSetting("offers.autoFavourites"),
    autoReply: await getSetting("offers.autoReply"),
    log: getOfferLog(),
  };
}
