import { z } from "zod";
import { currentUserId, db, nowIso } from "../../db/index.js";
import { HttpError } from "../../lib/http.js";
import { getSetting } from "../../lib/settings.js";
import { vintedClient } from "../../vinted/vintedClient.js";
import { chromeUrlFor, sessionFor, type AccountRow } from "../accounts/repo.js";
import { evenEuros } from "../automations/engine.js";
import { priceText } from "../assist/assistant.js";
import { sendInChrome, type OutreachJob, type OutreachResult } from "./chromeOutreach.js";

/**
 * Bulk messages from the dashboard, sent one by one in the Vinted-Chrome:
 * - "purchases": a note to every seller whose item I bought and who hasn't shipped yet
 * - "favourites": a price offer (−X %, even euros) to every member who favourited an active item
 * Nobody gets the same message twice (outreach_log); the daily message cap applies.
 */
export type OutreachKind = "purchases" | "favourites";

export interface OutreachTarget {
  key: string;
  accountId: number;
  accountName: string;
  /** Who gets it (Vinted username). */
  name: string;
  title: string;
  info: string | null;
  path: string | null;
  offerCents: number | null;
  oldCents: number | null;
  alreadySent: boolean;
  skip: string | null;
}

export const DEFAULT_TEXTS: Record<OutreachKind, string> = {
  purchases: "Hey ich fahre bald in den Urlaub kannst du bitte möglichst schnell verschicken",
  favourites: "Hey {name}, du hast „{title}“ favorisiert – ich mach dir ein Angebot: {price} € statt {old} € 🙂",
};

/** Chat start page for an item and a member (VINTED_OFFER_PATH can override it if Vinted changes the address). */
const offerPath = (vintedItemId: string, userId: string) =>
  (process.env.VINTED_OFFER_PATH ?? "/items/{item}/want_it/new?receiver_id={user}").replace("{item}", vintedItemId).replace("{user}", userId);

async function connectedAccounts() {
  return db.all<AccountRow>("SELECT * FROM accounts WHERE status = 'connected' ORDER BY id");
}

async function sentKeys(kind: OutreachKind) {
  const rows = await db.all<{ account_id: number; target_key: string }>("SELECT account_id, target_key FROM outreach_log WHERE kind = ?", [kind]);
  return new Set(rows.map((r) => `${r.account_id}:${r.target_key}`));
}

export async function planOutreach(kind: OutreachKind, percent = 10): Promise<{ targets: OutreachTarget[]; warnings: string[] }> {
  const sent = await sentKeys(kind);
  const targets: OutreachTarget[] = [];
  const warnings: string[] = [];
  if (kind === "purchases") {
    for (const a of await connectedAccounts()) {
      try {
        for (const p of await vintedClient.fetchPurchases(`account:${a.id}`, sessionFor(a))) {
          targets.push({
            key: `purchase:${p.externalId}`, accountId: a.id, accountName: a.name, name: p.seller ?? "Verkäufer", title: p.title,
            info: p.status, path: p.conversationId ? `/inbox/${p.conversationId}` : null, offerCents: null, oldCents: null,
            alreadySent: sent.has(`${a.id}:purchase:${p.externalId}`), skip: p.conversationId ? null : "Kein Chat zum Kauf gefunden",
          });
        }
      } catch (e) {
        warnings.push(`${a.name}: Käufe konnten nicht abgerufen werden – ${(e as Error).message}`);
      }
    }
  } else {
    const rows = await db.all<{ account_id: number; account_name: string; user_id: string; username: string | null; title: string; vinted_item_id: string; price_cents: number | null }>(`
      SELECT e.account_id, a.name AS account_name, e.vinted_user_id AS user_id, MAX(e.vinted_username) AS username,
        l.title, l.vinted_item_id, l.price_cents
      FROM vinted_events e JOIN listings l ON l.id = e.listing_id JOIN accounts a ON a.id = e.account_id
      WHERE e.type = 'favourite' AND l.status = 'active' AND l.vinted_item_id IS NOT NULL AND e.vinted_user_id IS NOT NULL AND e.vinted_user_id <> ''
      GROUP BY e.account_id, a.name, e.vinted_user_id, l.id, l.title, l.vinted_item_id, l.price_cents
      ORDER BY l.title`);
    if (!rows.length) warnings.push("Noch keine Favoriten bekannt – sie werden beim Abgleich mit Vinted gesammelt.");
    for (const r of rows) {
      const old = r.price_cents ? Number(r.price_cents) : null;
      const offer = old ? evenEuros((old * (100 - percent)) / 100, old) : null;
      const key = `fav:${r.vinted_item_id}:${r.user_id}`;
      targets.push({
        key, accountId: Number(r.account_id), accountName: r.account_name, name: r.username ?? "Mitglied", title: r.title,
        info: old ? `${priceText(old)} € → ${priceText(offer!)} €` : null, path: offerPath(r.vinted_item_id, r.user_id),
        offerCents: offer, oldCents: old, alreadySent: sent.has(`${r.account_id}:${key}`),
        skip: !old ? "Kein Preis" : !offer || offer < 200 ? "Preis zu niedrig für ein Angebot" : null,
      });
    }
  }
  return { targets, warnings };
}

export const startInput = z.object({
  kind: z.enum(["purchases", "favourites"]),
  keys: z.array(z.string().min(1)).min(1).max(500),
  text: z.string().trim().min(1).max(1000),
  percent: z.number().int().min(1).max(80).default(10),
});

/** "{name}", "{title}", "{price}", "{old}" in the text. */
export function fillText(text: string, t: Pick<OutreachTarget, "name" | "title" | "offerCents" | "oldCents">) {
  return text
    .replaceAll("{name}", t.name).replaceAll("{title}", t.title)
    .replaceAll("{price}", t.offerCents ? priceText(t.offerCents) : "").replaceAll("{old}", t.oldCents ? priceText(t.oldCents) : "");
}

// ---------- executing ----------

type Executor = (job: OutreachJob) => Promise<OutreachResult>;
let executor: Executor = sendInChrome;
/** Cloud: sends on the PC helper (set at startup). Tests: a fake. */
export function setOutreachExecutor(fn: Executor) {
  executor = fn;
}

export interface OutreachStatus {
  state: "idle" | "running" | "done";
  kind: OutreachKind | null;
  total: number;
  done: number;
  message: string | null;
  items: { key: string; name: string; title: string; state: "queued" | "running" | "done" | "failed" | "skipped"; message: string | null }[];
}

const runs = new Map<string, { status: OutreachStatus; stop: boolean }>();
export const getOutreachStatus = (): OutreachStatus =>
  runs.get(currentUserId())?.status ?? { state: "idle", kind: null, total: 0, done: 0, message: null, items: [] };

async function sentToday() {
  const since = new Date(Date.now() - 86400_000).toISOString();
  const a = await db.get<{ c: number }>("SELECT COUNT(*) c FROM outreach_log WHERE sent_at >= ?", [since]);
  const b = await db.get<{ c: number }>("SELECT COUNT(*) c FROM scheduled_actions WHERE action_type = 'send_message' AND status = 'done' AND executed_at >= ?", [since]);
  return Number(a?.c ?? 0) + Number(b?.c ?? 0);
}

export async function startOutreach(input: z.infer<typeof startInput>): Promise<OutreachStatus> {
  const userId = currentUserId();
  if (runs.get(userId)?.status.state === "running") throw new HttpError(409, "Es werden gerade schon Nachrichten verschickt");
  const wanted = new Set(input.keys);
  const { targets } = await planOutreach(input.kind, input.percent);
  const list = targets.filter((t) => wanted.has(t.key) && !t.skip && !t.alreadySent);
  if (!list.length) throw new HttpError(400, "Niemand zum Anschreiben ausgewählt (oder alle haben die Nachricht schon bekommen)");
  const cap = Number(await getSetting("automation.dailyMessageCap"));
  const left = Math.max(0, cap - (await sentToday()));
  if (!left) throw new HttpError(429, `Tageslimit von ${cap} Nachrichten erreicht (Einstellungen → Automatisierung)`);
  const accounts = new Map((await connectedAccounts()).map((a) => [a.id, a]));

  const status: OutreachStatus = {
    state: "running", kind: input.kind, total: list.length, done: 0, message: null,
    items: list.map((t) => ({ key: t.key, name: t.name, title: t.title, state: "queued", message: null })),
  };
  const run = { status, stop: false };
  runs.set(userId, run);
  void (async () => {
    let sentNow = 0;
    for (const [i, item] of status.items.entries()) {
      const t = list[i]!;
      if (run.stop || sentNow >= left) {
        item.state = "skipped";
        item.message = run.stop ? "gestoppt" : `Tageslimit (${cap}) erreicht`;
        status.done++;
        continue;
      }
      item.state = "running";
      try {
        const a = accounts.get(t.accountId)!;
        const r = await executor({ path: t.path!, domain: a.domain, chromeUrl: chromeUrlFor(a), text: fillText(input.text, t), offerCents: t.offerCents });
        item.state = r.ok ? "done" : "failed";
        item.message = r.message;
        if (r.ok) {
          sentNow++;
          await db.run("INSERT INTO outreach_log (account_id, kind, target_key, sent_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING", [t.accountId, input.kind, t.key, nowIso()]);
        }
        if (!r.ok && /niemand eingeloggt/.test(r.message)) run.stop = true;
      } catch (e) {
        item.state = "failed";
        item.message = (e as Error).message;
        if (e instanceof HttpError && e.status === 503) { run.stop = true; status.message = item.message; }
      }
      status.done++;
      // One chat after the other, with a short pause so each page has finished.
      await new Promise((r) => setTimeout(r, process.env.VITEST ? 10 : 2500));
    }
    const ok = status.items.filter((i) => i.state === "done").length;
    status.state = "done";
    status.message ??= `${ok} von ${status.total} ${input.kind === "favourites" ? "Angeboten" : "Nachrichten"} gesendet`;
  })();
  return status;
}

export function stopOutreach() {
  const run = runs.get(currentUserId());
  if (run) run.stop = true;
}
