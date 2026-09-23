import { z } from "zod";
import { db, nowIso } from "../../db/index.js";
import { HttpError, notFound } from "../../lib/http.js";
import { formatPrice, renderTemplate } from "../../lib/placeholders.js";
import { getSetting } from "../../lib/settings.js";
import { vintedClient, VintedError } from "../../vinted/vintedClient.js";
import { getAccount, sessionFor } from "../accounts/repo.js";
import { getListing, setListingPrice } from "../archive/repo.js";

// ---------- rule schema ----------

export const TRIGGERS = {
  item_favourited: "Artikel wird favorisiert",
  message_received: "Nachricht erhalten (FAQ / Schlüsselwörter)",
  item_sold: "Artikel verkauft",
  listing_stale: "X Tage ohne Verkauf",
} as const;
export const ACTIONS = { send_message: "Nachricht senden", reduce_price: "Preis senken" } as const;

const triggerConfig = z.object({
  keywords: z.array(z.string().trim().min(1)).max(50).optional(),
  days: z.number().int().min(1).max(365).optional(),
});
const actionConfig = z.object({
  message: z.string().trim().min(1).max(1000).optional(),
  percent: z.number().min(1).max(50).optional(),
  minPriceCents: z.number().int().min(0).optional(),
  repeatEveryDays: z.number().int().min(1).max(365).optional(),
});

export const ruleInput = z.object({
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  accountId: z.number().int().positive().nullable().default(null),
  triggerType: z.enum(Object.keys(TRIGGERS) as [keyof typeof TRIGGERS]),
  triggerConfig: triggerConfig.default({}),
  actionType: z.enum(Object.keys(ACTIONS) as [keyof typeof ACTIONS]),
  actionConfig: actionConfig.default({}),
  delayMinutes: z.number().int().min(0).max(60 * 24 * 14).default(0),
  perUserLimit: z.number().int().min(1).max(100).default(1),
  perUserWindowHours: z.number().int().min(1).max(24 * 365).default(168),
}).superRefine((r, ctx) => {
  if (r.triggerType === "listing_stale") {
    if (r.actionType !== "reduce_price") ctx.addIssue({ code: "custom", message: "'X Tage ohne Verkauf' unterstützt nur die Aktion 'Preis senken'", path: ["actionType"] });
    if (!r.triggerConfig.days) ctx.addIssue({ code: "custom", message: "Anzahl Tage erforderlich", path: ["triggerConfig", "days"] });
    if (!r.actionConfig.percent) ctx.addIssue({ code: "custom", message: "Prozentsatz erforderlich", path: ["actionConfig", "percent"] });
  } else {
    if (r.actionType !== "send_message") ctx.addIssue({ code: "custom", message: "Dieser Auslöser unterstützt nur 'Nachricht senden'", path: ["actionType"] });
    if (!r.actionConfig.message) ctx.addIssue({ code: "custom", message: "Nachrichtentext erforderlich", path: ["actionConfig", "message"] });
  }
});
export type RuleInput = z.infer<typeof ruleInput>;

export interface RuleRow {
  id: number; name: string; enabled: number; account_id: number | null; trigger_type: keyof typeof TRIGGERS;
  trigger_config: string; action_type: keyof typeof ACTIONS; action_config: string; delay_minutes: number;
  per_user_limit: number; per_user_window_hours: number; created_at: string; updated_at: string;
}

export function ruleToApi(r: RuleRow) {
  return {
    id: r.id, name: r.name, enabled: !!r.enabled, accountId: r.account_id, triggerType: r.trigger_type,
    triggerConfig: JSON.parse(r.trigger_config), actionType: r.action_type, actionConfig: JSON.parse(r.action_config),
    delayMinutes: r.delay_minutes, perUserLimit: r.per_user_limit, perUserWindowHours: r.per_user_window_hours,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function getRule(id: number): RuleRow {
  const r = db.prepare("SELECT * FROM automation_rules WHERE id = ?").get(id) as RuleRow | undefined;
  if (!r) throw notFound("Regel");
  return r;
}

export function saveRule(input: RuleInput, id?: number): RuleRow {
  if (input.accountId) getAccount(input.accountId);
  const params = {
    name: input.name, enabled: input.enabled ? 1 : 0, account_id: input.accountId, trigger_type: input.triggerType,
    trigger_config: JSON.stringify(input.triggerConfig), action_type: input.actionType, action_config: JSON.stringify(input.actionConfig),
    delay_minutes: input.delayMinutes, per_user_limit: input.perUserLimit, per_user_window_hours: input.perUserWindowHours,
  };
  if (id) {
    getRule(id);
    db.prepare(`UPDATE automation_rules SET name=@name, enabled=@enabled, account_id=@account_id, trigger_type=@trigger_type,
      trigger_config=@trigger_config, action_type=@action_type, action_config=@action_config, delay_minutes=@delay_minutes,
      per_user_limit=@per_user_limit, per_user_window_hours=@per_user_window_hours, updated_at=@now WHERE id=@id`)
      .run({ ...params, now: nowIso(), id });
    return getRule(id);
  }
  const r = db.prepare(`INSERT INTO automation_rules (name, enabled, account_id, trigger_type, trigger_config, action_type, action_config,
      delay_minutes, per_user_limit, per_user_window_hours)
    VALUES (@name, @enabled, @account_id, @trigger_type, @trigger_config, @action_type, @action_config, @delay_minutes, @per_user_limit, @per_user_window_hours)`)
    .run(params);
  return getRule(Number(r.lastInsertRowid));
}

// ---------- events ----------

export type EventType = "favourite" | "message" | "sale";
const TRIGGER_FOR: Record<EventType, keyof typeof TRIGGERS> = {
  favourite: "item_favourited",
  message: "message_received",
  sale: "item_sold",
};

export interface IncomingEvent {
  accountId: number;
  type: EventType;
  externalId: string;
  listingId: number | null;
  userId: string | null;
  username: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
}

/**
 * Stores an observed event (deduplicated) and, unless silent, evaluates rules.
 * Silent mode is used for the very first sync of an account so historic
 * favourites/messages don't trigger a burst of automated messages.
 */
export function ingestEvent(e: IncomingEvent, silent = false): { isNew: boolean; eventId: number | null; scheduled: number } {
  const r = db.prepare(`
    INSERT OR IGNORE INTO vinted_events (account_id, type, external_id, listing_id, vinted_user_id, vinted_username, payload, occurred_at, processed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(e.accountId, e.type, e.externalId, e.listingId, e.userId, e.username, JSON.stringify(e.payload), e.occurredAt, silent ? nowIso() : null);
  if (!r.changes) return { isNew: false, eventId: null, scheduled: 0 };
  const eventId = Number(r.lastInsertRowid);
  if (silent) return { isNew: true, eventId, scheduled: 0 };
  const scheduled = evaluateEvent(eventId, e);
  db.prepare("UPDATE vinted_events SET processed_at = ? WHERE id = ?").run(nowIso(), eventId);
  return { isNew: true, eventId, scheduled };
}

function matchingRules(trigger: keyof typeof TRIGGERS, accountId: number): RuleRow[] {
  return db.prepare("SELECT * FROM automation_rules WHERE enabled = 1 AND trigger_type = ? AND (account_id IS NULL OR account_id = ?)")
    .all(trigger, accountId) as RuleRow[];
}

export function matchesKeywords(text: string, keywords: string[] | undefined): boolean {
  if (!keywords || keywords.length === 0) return true;
  const t = text.toLowerCase();
  return keywords.some((k) => t.includes(k.toLowerCase()));
}

function userLimitReached(rule: RuleRow, userId: string): boolean {
  const since = new Date(Date.now() - rule.per_user_window_hours * 3600_000).toISOString();
  const c = db.prepare(`SELECT COUNT(*) c FROM scheduled_actions
    WHERE rule_id = ? AND target_user_id = ? AND status IN ('pending','done') AND created_at >= ?`).get(rule.id, userId, since) as { c: number };
  return c.c >= rule.per_user_limit;
}

function evaluateEvent(eventId: number, e: IncomingEvent): number {
  let scheduled = 0;
  for (const rule of matchingRules(TRIGGER_FOR[e.type], e.accountId)) {
    const tc = JSON.parse(rule.trigger_config) as z.infer<typeof triggerConfig>;
    const ac = JSON.parse(rule.action_config) as z.infer<typeof actionConfig>;
    if (e.type === "message" && !matchesKeywords(String(e.payload.text ?? ""), tc.keywords)) continue;
    if (!e.userId) continue;
    const base = { rule_id: rule.id, event_id: eventId, account_id: e.accountId, listing_id: e.listingId, action_type: rule.action_type, target_user_id: e.userId };
    const payload = JSON.stringify({
      message: ac.message, username: e.username, conversationId: e.payload.conversationId ?? null, vintedItemId: e.payload.vintedItemId ?? null,
    });
    if (userLimitReached(rule, e.userId)) {
      insertAction({ ...base, payload, run_at: nowIso(), status: "skipped", result: "Häufigkeitslimit pro Nutzer erreicht" });
      continue;
    }
    insertAction({ ...base, payload, run_at: new Date(Date.now() + rule.delay_minutes * 60_000).toISOString(), status: "pending", result: null });
    scheduled++;
  }
  return scheduled;
}

function insertAction(a: {
  rule_id: number; event_id: number | null; account_id: number; listing_id: number | null; action_type: string;
  target_user_id: string | null; payload: string; run_at: string; status: string; result: string | null;
}) {
  db.prepare(`INSERT INTO scheduled_actions (rule_id, event_id, account_id, listing_id, action_type, target_user_id, payload, run_at, status, result)
    VALUES (@rule_id, @event_id, @account_id, @listing_id, @action_type, @target_user_id, @payload, @run_at, @status, @result)`).run(a);
}

// ---------- stale listings (time-based trigger) ----------

/** Schedules price drops for listings that have been active for too long. */
export function scheduleStaleListingActions(now = new Date()): number {
  let scheduled = 0;
  const rules = db.prepare("SELECT * FROM automation_rules WHERE enabled = 1 AND trigger_type = 'listing_stale'").all() as RuleRow[];
  for (const rule of rules) {
    const tc = JSON.parse(rule.trigger_config) as z.infer<typeof triggerConfig>;
    const ac = JSON.parse(rule.action_config) as z.infer<typeof actionConfig>;
    const listedBefore = new Date(now.getTime() - (tc.days ?? 14) * 86400_000).toISOString();
    const droppedBefore = new Date(now.getTime() - (ac.repeatEveryDays ?? tc.days ?? 7) * 86400_000).toISOString();
    const candidates = db.prepare(`
      SELECT l.id, l.account_id FROM listings l JOIN accounts a ON a.id = l.account_id
      WHERE l.status = 'active' AND a.status = 'connected' AND l.listed_at <= @listedBefore
        AND (@accountId IS NULL OR l.account_id = @accountId)
        AND (l.last_price_drop_at IS NULL OR l.last_price_drop_at <= @droppedBefore)
        AND (@minPrice IS NULL OR l.price_cents > @minPrice)
        AND NOT EXISTS (SELECT 1 FROM scheduled_actions s WHERE s.rule_id = @ruleId AND s.listing_id = l.id AND s.status = 'pending')
    `).all({ listedBefore, droppedBefore, accountId: rule.account_id, minPrice: ac.minPriceCents ?? null, ruleId: rule.id }) as { id: number; account_id: number }[];
    for (const c of candidates) {
      insertAction({
        rule_id: rule.id, event_id: null, account_id: c.account_id, listing_id: c.id, action_type: "reduce_price", target_user_id: null,
        payload: JSON.stringify({ percent: ac.percent, minPriceCents: ac.minPriceCents ?? null }),
        run_at: new Date(now.getTime() + rule.delay_minutes * 60_000).toISOString(), status: "pending", result: null,
      });
      scheduled++;
    }
  }
  return scheduled;
}

/** New price after a percentage drop, rounded down to 10 cents, never below the floor. */
export function reducedPrice(currentCents: number, percent: number, minCents: number | null): number {
  const raw = Math.floor((currentCents * (100 - percent)) / 100 / 10) * 10;
  return Math.max(raw, minCents ?? 0, 100);
}

// ---------- execution ----------

interface ActionRow {
  id: number; rule_id: number | null; account_id: number; listing_id: number | null; action_type: string;
  target_user_id: string | null; payload: string; run_at: string; status: string;
}

function finish(id: number, status: "done" | "failed" | "skipped", result: string) {
  db.prepare("UPDATE scheduled_actions SET status = ?, result = ?, executed_at = ? WHERE id = ?").run(status, result, nowIso(), id);
}

function messagesSentToday(accountId: number): number {
  const since = new Date(Date.now() - 86400_000).toISOString();
  return (db.prepare("SELECT COUNT(*) c FROM scheduled_actions WHERE account_id = ? AND action_type = 'send_message' AND status = 'done' AND executed_at >= ?")
    .get(accountId, since) as { c: number }).c;
}

export function templateVars(listingId: number | null, accountId: number, username?: string | null, newPriceCents?: number) {
  const account = getAccount(accountId);
  const l = listingId ? getListing(listingId) : null;
  const item = l ? (db.prepare("SELECT brand, size FROM items WHERE id = ?").get(l.item_id) as { brand: string | null; size: string | null }) : null;
  return {
    artikelname: l?.title ?? "",
    preis: l ? formatPrice(l.price_cents, l.currency) : "",
    neuer_preis: newPriceCents !== undefined ? formatPrice(newPriceCents, l?.currency) : "",
    marke: item?.brand ?? "",
    groesse: item?.size ?? "",
    nutzer: username ?? "",
    account: account.name,
  };
}

export async function executeAction(a: ActionRow): Promise<void> {
  const account = getAccount(a.account_id);
  if (account.status !== "connected") return finish(a.id, "skipped", "Account nicht verbunden");
  const payload = JSON.parse(a.payload) as Record<string, unknown>;
  const session = sessionFor(account);
  const key = `account:${account.id}`;
  try {
    if (a.action_type === "send_message") {
      if (messagesSentToday(account.id) >= getSetting("automation.dailyMessageCap")) {
        return finish(a.id, "skipped", "Tageslimit für automatische Nachrichten erreicht");
      }
      if (a.listing_id && getListing(a.listing_id).status !== "active" && payload.username && a.rule_id) {
        const rule = db.prepare("SELECT trigger_type FROM automation_rules WHERE id = ?").get(a.rule_id) as { trigger_type: string } | undefined;
        if (rule?.trigger_type === "item_favourited") return finish(a.id, "skipped", "Artikel nicht mehr aktiv");
      }
      const text = renderTemplate(String(payload.message ?? ""), templateVars(a.listing_id, a.account_id, payload.username as string));
      await vintedClient.sendMessage(key, session, {
        toUserId: a.target_user_id!, conversationId: (payload.conversationId as string) ?? null,
        vintedItemId: (payload.vintedItemId as string) ?? null, text,
      });
      return finish(a.id, "done", text);
    }
    if (a.action_type === "reduce_price") {
      const l = getListing(a.listing_id!);
      if (l.status !== "active" || l.price_cents === null || !l.vinted_item_id) return finish(a.id, "skipped", "Listing nicht mehr aktiv");
      const next = reducedPrice(l.price_cents, Number(payload.percent ?? 10), (payload.minPriceCents as number | null) ?? null);
      if (next >= l.price_cents) return finish(a.id, "skipped", "Mindestpreis erreicht");
      await vintedClient.updatePrice(key, session, l.vinted_item_id, next);
      setListingPrice(l.id, next, `Automatisierung #${a.rule_id}`);
      return finish(a.id, "done", `${formatPrice(l.price_cents, l.currency)} → ${formatPrice(next, l.currency)}`);
    }
    finish(a.id, "failed", `Unbekannte Aktion ${a.action_type}`);
  } catch (e) {
    const msg = e instanceof VintedError || e instanceof HttpError ? e.message : (e as Error).message;
    finish(a.id, "failed", msg);
  }
}

export async function runDueActions(limit = 20): Promise<number> {
  if (getSetting("automation.paused")) return 0;
  const due = db.prepare("SELECT * FROM scheduled_actions WHERE status = 'pending' AND run_at <= ? ORDER BY run_at LIMIT ?").all(nowIso(), limit) as ActionRow[];
  for (const a of due) await executeAction(a);
  return due.length;
}
