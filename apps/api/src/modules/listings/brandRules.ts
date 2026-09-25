import { db, nowIso } from "../../db/index.js";
import { getSetting } from "../../lib/settings.js";

/** Parses "T-Shirt=Graphic Tee" lines into rules (case-insensitive keyword match). */
export function parseBrandRules(text: string): { keyword: string; brand: string }[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return { keyword: l.slice(0, i).trim(), brand: l.slice(i + 1).trim() };
    })
    .filter((r) => r.keyword && r.brand);
}

/** Lowercase words; hyphens inside words are dropped so "T-Shirts" → "tshirts". */
const words = (s: string) => s.toLowerCase().replace(/(\p{L})-(\p{L})/gu, "$1$2").split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * Brand forced by a rule for this item (e.g. every T-shirt → "Graphic Tee"), else null.
 * A rule's keyword may list alternatives ("T-Shirt, Tee, Shirt"); each must match a whole
 * word (plural "s" allowed) in the title, the category or the description's hashtags.
 */
export function ruleBrand(
  item: { title: string; category: string | null; description?: string | null },
  rules = parseBrandRules(getSetting("brand.rules")),
): string | null {
  const hashtags = (item.description ?? "").match(/#[\p{L}\p{N}-]+/gu)?.join(" ") ?? "";
  const have = new Set(words(`${item.title} ${item.category ?? ""} ${hashtags}`));
  return rules.find((r) => r.keyword.split(/[,|]/).map((k) => words(k).join("")).filter(Boolean)
    .some((k) => have.has(k) || have.has(`${k}s`)))?.brand ?? null;
}

/** Re-applies the brand rules to every unsold item (drafts, archive, queue); returns how many changed. */
export function applyBrandRules(): number {
  const rules = parseBrandRules(getSetting("brand.rules"));
  if (!rules.length) return 0;
  const items = db.prepare("SELECT id, title, category, description, brand FROM items WHERE status <> 'sold'").all() as
    { id: number; title: string; category: string | null; description: string; brand: string | null }[];
  const update = db.prepare("UPDATE items SET brand = ?, updated_at = ? WHERE id = ?");
  let changed = 0;
  for (const it of items) {
    const brand = ruleBrand(it, rules);
    if (brand && brand !== it.brand) { update.run(brand, nowIso(), it.id); changed++; }
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
