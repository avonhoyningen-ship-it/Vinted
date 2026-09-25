import { z } from "zod";
import { db, nowIso } from "../../db/index.js";
import { formatPrice } from "../../lib/placeholders.js";

/**
 * Price learning. Sources, in order of priority:
 * 1. Rules the seller defined (brand / category / keyword → price)
 * 2. Prices of similar items the seller confirmed, set in bulk, or sold
 *    (sold prices weigh more)
 * 3. The AI estimate (which also sees the seller's learned prices)
 */

export type ExampleSource = "confirmed" | "bulk" | "manual" | "sold";

interface ItemFeatures {
  id?: number;
  title: string;
  brand: string | null;
  category: string | null;
  size: string | null;
  condition: string | null;
}

export interface PriceExample extends ItemFeatures {
  id: number;
  item_id: number | null;
  source: ExampleSource;
  price_cents: number;
  created_at: string;
}

export interface PriceRule {
  id: number;
  brand: string | null;
  category: string | null;
  keyword: string | null;
  price_cents: number;
  note: string | null;
  created_at: string;
}

export interface Suggestion {
  priceCents: number;
  reason: string;
  source: "rule" | "similar" | "ai";
}

// ---------- recording ----------

/** Stores what the seller decided (or what sold) as a learning example. */
export async function recordPriceExample(itemId: number, priceCents: number, source: ExampleSource) {
  const item = await db.get<ItemFeatures>("SELECT title, brand, category, size, condition FROM items WHERE id = ?", [itemId]);
  if (!item || !priceCents) return;
  // One example per item for the seller's own decisions (latest wins); sales are kept separately.
  if (source !== "sold") await db.run("DELETE FROM price_examples WHERE item_id = ? AND source <> 'sold'", [itemId]);
  await db.run(`INSERT INTO price_examples (item_id, source, title, brand, category, size, condition, price_cents, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(item_id, source) DO UPDATE SET price_cents = excluded.price_cents, title = excluded.title, brand = excluded.brand,
      category = excluded.category, size = excluded.size, condition = excluded.condition, created_at = excluded.created_at`,
    [itemId, source, item.title, item.brand, item.category, item.size, item.condition, priceCents, nowIso()]);
}

/** Sets the price of an item as seller-confirmed and learns from it. */
export async function confirmPrice(itemId: number, priceCents: number, source: Exclude<ExampleSource, "sold">) {
  await db.run("UPDATE items SET price_cents = ?, price_confirmed = 1, updated_at = ? WHERE id = ?", [priceCents, nowIso(), itemId]);
  await recordPriceExample(itemId, priceCents, source);
}

// ---------- similarity ----------

const STOPWORDS = new Set([
  "und", "mit", "der", "die", "das", "für", "von", "vintage", "y2k", "archive", "streetwear", "2000s", "retro", "style",
  "gr", "größe", "size", "neu", "top", "shirt", "the", "and", "with",
]);
export function keywords(text: string): Set<string> {
  return new Set(
    text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
      .split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}
const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
const lastSegment = (c: string | null) => norm(c).split(">").pop()!.trim();

/** Higher = more similar. Brand and category matter most, then shared title words. */
export function similarity(a: ItemFeatures, b: ItemFeatures): number {
  let score = 0;
  if (norm(a.brand) && norm(a.brand) === norm(b.brand)) score += 3;
  if (norm(a.category) && norm(a.category) === norm(b.category)) score += 2;
  else if (lastSegment(a.category) && lastSegment(a.category) === lastSegment(b.category)) score += 1.5;
  const ka = keywords(a.title);
  let shared = 0;
  for (const w of keywords(b.title)) if (ka.has(w)) shared++;
  score += Math.min(shared, 3);
  if (norm(a.condition) && norm(a.condition) === norm(b.condition)) score += 0.5;
  if (norm(a.size) && norm(a.size) === norm(b.size)) score += 0.25;
  return score;
}

export async function similarExamples(item: ItemFeatures, limit = 8, minScore = 2.5) {
  const all = await db.all<PriceExample>("SELECT * FROM price_examples ORDER BY created_at DESC LIMIT 2000");
  return all
    .filter((e) => e.item_id !== item.id)
    .map((e) => ({ e, score: similarity(item, e) * (e.source === "sold" ? 1.3 : 1) }))
    .filter((x) => x.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Weighted median: robust against single outliers. */
function weightedMedian(values: { v: number; w: number }[]): number {
  const sorted = [...values].sort((a, b) => a.v - b.v);
  const total = sorted.reduce((s, x) => s + x.w, 0);
  let acc = 0;
  for (const x of sorted) {
    acc += x.w;
    if (acc >= total / 2) return x.v;
  }
  return sorted[sorted.length - 1]!.v;
}

/** Friendly price points: whole euros (half euros below 10 €). */
export function roundPrice(cents: number): number {
  return cents < 1000 ? Math.round(cents / 50) * 50 : Math.round(cents / 100) * 100;
}

// ---------- rules ----------

export async function matchingRule(item: ItemFeatures): Promise<PriceRule | null> {
  const rules = await db.all<PriceRule>("SELECT * FROM price_rules ORDER BY created_at DESC");
  const text = `${item.title} ${item.brand ?? ""} ${item.category ?? ""}`.toLowerCase();
  const hits = rules.filter((r) =>
    (!r.brand || norm(item.brand) === norm(r.brand) || text.includes(norm(r.brand))) &&
    (!r.category || norm(item.category).includes(norm(r.category))) &&
    (!r.keyword || text.includes(norm(r.keyword))));
  const specificity = (r: PriceRule) => Number(!!r.brand) + Number(!!r.category) + Number(!!r.keyword);
  return hits.sort((a, b) => specificity(b) - specificity(a))[0] ?? null;
}

export function describeRule(r: Pick<PriceRule, "brand" | "category" | "keyword">) {
  return [r.brand && `Marke „${r.brand}“`, r.category && `Kategorie „${r.category}“`, r.keyword && `Stichwort „${r.keyword}“`].filter(Boolean).join(" + ");
}

// ---------- suggestion ----------

export async function suggestPrice(item: ItemFeatures, aiPriceCents?: number | null): Promise<Suggestion | null> {
  const rule = await matchingRule(item);
  if (rule) return { priceCents: rule.price_cents, reason: `Deine Regel: ${describeRule(rule)}`, source: "rule" };

  const similar = await similarExamples(item);
  if (similar.length) {
    const price = roundPrice(weightedMedian(similar.map((x) => ({ v: x.e.price_cents, w: x.score }))));
    const sold = similar.filter((x) => x.e.source === "sold").length;
    const examples = similar.slice(0, 2).map((x) => `${x.e.title.slice(0, 40)} (${formatPrice(x.e.price_cents)})`).join(", ");
    return {
      priceCents: price,
      reason: `Wie ${similar.length} ähnliche${similar.length === 1 ? "r Artikel" : " Artikel"}${sold ? `, davon ${sold} verkauft` : ""}: ${examples}`,
      source: "similar",
    };
  }
  if (aiPriceCents) return { priceCents: roundPrice(aiPriceCents), reason: "KI-Schätzung (noch keine ähnlichen Preise gelernt)", source: "ai" };
  return null;
}

/** Examples as context for the AI, so its estimate follows the seller's price level. */
export async function examplesForPrompt(item: ItemFeatures): Promise<string> {
  let list = await similarExamples(item, 8, 1);
  if (!list.length) {
    list = (await db.all<PriceExample>("SELECT * FROM price_examples ORDER BY created_at DESC LIMIT 8")).map((e) => ({ e, score: 0 }));
  }
  return list.map(({ e }) => `- ${e.title}${e.brand ? ` (${e.brand})` : ""}: ${formatPrice(e.price_cents)}${e.source === "sold" ? " – verkauft" : ""}`).join("\n");
}

/** Computes and stores the suggestion for an item whose price is not confirmed yet. */
export async function refreshSuggestion(itemId: number, aiPriceCents?: number | null): Promise<Suggestion | null> {
  const item = await db.get<ItemFeatures & { price_suggested_cents: number | null; price_suggestion_reason: string | null }>(
    "SELECT id, title, brand, category, size, condition, price_suggested_cents, price_suggestion_reason FROM items WHERE id = ?", [itemId]);
  if (!item) return null;
  // Keep a previous AI estimate as fallback when recomputing.
  const ai = aiPriceCents ?? (item.price_suggestion_reason?.startsWith("KI") ? item.price_suggested_cents : null);
  const s = await suggestPrice(item, ai);
  await db.run("UPDATE items SET price_suggested_cents = ?, price_suggestion_reason = ? WHERE id = ?", [s?.priceCents ?? null, s?.reason ?? null, itemId]);
  return s;
}

/** Recomputes suggestions for all items still waiting for a confirmed price. */
export async function refreshAllSuggestions(): Promise<number> {
  const ids = await db.all<{ id: number }>("SELECT id FROM items WHERE price_confirmed = 0 AND status IN ('draft','archived')");
  for (const { id } of ids) await refreshSuggestion(Number(id));
  return ids.length;
}

// ---------- rule input ----------

export const ruleInput = z.object({
  brand: z.string().trim().max(120).nullable().optional(),
  category: z.string().trim().max(120).nullable().optional(),
  keyword: z.string().trim().max(120).nullable().optional(),
  price_cents: z.number().int().min(50).max(10_000_000),
  note: z.string().trim().max(300).nullable().optional(),
}).refine((r) => !!(r.brand || r.category || r.keyword), { message: "Mindestens Marke, Kategorie oder Stichwort angeben" });
