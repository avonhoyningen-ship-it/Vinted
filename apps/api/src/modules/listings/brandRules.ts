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

const normalize = (s: string) => s.toLowerCase().replace(/[-\s]+/g, "");

/** Brand forced by a rule for this item (e.g. every T-shirt → "Graphic Tee"), else null. */
export function ruleBrand(item: { title: string; category: string | null }, rules = parseBrandRules(getSetting("brand.rules"))): string | null {
  const text = normalize(`${item.title} ${item.category ?? ""}`);
  return rules.find((r) => text.includes(normalize(r.keyword)))?.brand ?? null;
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
