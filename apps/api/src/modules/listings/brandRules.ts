import { db, nowIso } from "../../db/index.js";
import { getSetting } from "../../lib/settings.js";

/** Parses "T-Shirt=Graphic Tee" lines into rules (case-insensitive keyword match). */
export function parseRules(text: string): { keyword: string; value: string }[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return { keyword: l.slice(0, i).trim(), value: l.slice(i + 1).trim() };
    })
    .filter((r) => r.keyword && r.value);
}
export const parseBrandRules = parseRules;

type RuleItem = { title: string; category: string | null; description?: string | null };

/** Lowercase words; hyphens inside words are dropped so "T-Shirts" → "tshirts". */
const words = (s: string) => s.toLowerCase().replace(/(\p{L})-(\p{L})/gu, "$1$2").split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * Value of the first rule that matches the item, else null. A rule's keyword may list
 * alternatives ("T-Shirt, Tee, Shirt"); each must match a whole word (plural "s" allowed)
 * in the title, the category or the description's hashtags.
 */
export function matchRule(item: RuleItem, rules: { keyword: string; value: string }[]): string | null {
  const hashtags = (item.description ?? "").match(/#[\p{L}\p{N}-]+/gu)?.join(" ") ?? "";
  const have = new Set(words(`${item.title} ${item.category ?? ""} ${hashtags}`));
  return rules.find((r) => r.keyword.split(/[,|]/).map((k) => words(k).join("")).filter(Boolean)
    .some((k) => have.has(k) || have.has(`${k}s`)))?.value ?? null;
}

/** Brand forced by a rule for this item (e.g. every T-shirt → "Graphic Tee"), else null. */
export function ruleBrand(item: RuleItem, rules = parseRules(getSetting("brand.rules"))): string | null {
  return matchRule(item, rules);
}

export type ParcelSize = "Klein" | "Mittel" | "Groß";
/** "klein" / "S" / "mittel" / "gross" … → Vinted's parcel size label, else null. */
export function parcelSize(v: string | null | undefined): ParcelSize | null {
  const t = (v ?? "").trim().toLowerCase();
  if (/^(klein|s|small)$/.test(t)) return "Klein";
  if (/^(mittel|m|medium)$/.test(t)) return "Mittel";
  if (/^(gro(ß|ss)|l|large)$/.test(t)) return "Groß";
  return null;
}

/** Vinted parcel size for this item by rule (e.g. T-shirts → "Klein"), else null. */
export function ruleParcel(item: RuleItem, rules = parseRules(getSetting("parcel.rules"))): ParcelSize | null {
  return parcelSize(matchRule(item, rules));
}

/** Re-applies brand and parcel rules to every unsold item (drafts, archive, queue); returns how many changed. */
export function applyBrandRules(): number {
  const brandRules = parseRules(getSetting("brand.rules"));
  const parcelRules = parseRules(getSetting("parcel.rules"));
  const items = db.prepare("SELECT id, title, category, description, brand, parcel_size FROM items WHERE status <> 'sold'").all() as
    { id: number; title: string; category: string | null; description: string; brand: string | null; parcel_size: string | null }[];
  const update = db.prepare("UPDATE items SET brand = ?, parcel_size = ?, updated_at = ? WHERE id = ?");
  let changed = 0;
  for (const it of items) {
    const brand = ruleBrand(it, brandRules) ?? it.brand;
    const parcel = ruleParcel(it, parcelRules) ?? it.parcel_size;
    if (brand !== it.brand || parcel !== it.parcel_size) { update.run(brand, parcel, nowIso(), it.id); changed++; }
  }
  return changed;
}

/** "Breite 43, Länge 65" / "43x65" / "Schulter 43 Laenge 65" → { width: 43, length: 65 }. */
export function parseMeasurements(text: string | null | undefined): { width: number | null; length: number | null } {
  const t = (text ?? "").toLowerCase();
  const num = (re: RegExp) => { const m = t.match(re); return m ? Number(m[1]!.replace(",", ".")) : null; };
  let width = num(/(?:breite|schulter\w*|achsel\w*|weite|b)\s*[:=]?\s*(\d+(?:[.,]\d+)?)/);
  let length = num(/(?:l(?:ä|ae)nge|l)\s*[:=]?\s*(\d+(?:[.,]\d+)?)/);
  if (width === null || length === null) {
    const m = t.match(/(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)/);
    if (m) {
      width ??= Number(m[1]!.replace(",", "."));
      length ??= Number(m[2]!.replace(",", "."));
    }
  }
  return { width, length };
}
