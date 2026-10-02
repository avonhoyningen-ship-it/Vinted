/**
 * Why doesn't a listing sell? Rules on Vinted's own numbers (views,
 * favourites, days online) plus price and listing quality. Pure functions,
 * so the thresholds are easy to test and tune.
 */

export type Severity = "high" | "medium" | "low" | "info";

export interface Issue {
  code: string;
  severity: Severity;
  text: string;
  tip: string;
}

export interface ListingFacts {
  title: string;
  description: string;
  priceCents: number | null;
  views: number;
  favourites: number;
  listedAt: string;
  lastPriceDropAt: string | null;
  photoCount: number;
  brand: string | null;
  size: string | null;
  category: string | null;
  condition: string | null;
  measurements: string | null;
  /** Typical price of similar items the seller sold/priced (cents), if known. */
  marketCents: number | null;
}

export interface Diagnosis {
  score: number;
  daysOnline: number;
  viewsPerDay: number;
  favouriteRate: number;
  issues: Issue[];
}

const eur = (c: number) => `${(c / 100).toFixed(2).replace(".", ",")} €`;
const pct = (x: number) => `${Math.round(x * 100)} %`;
const WEIGHT: Record<Severity, number> = { high: 30, medium: 15, low: 5, info: 0 };

export function diagnose(f: ListingFacts, now = Date.now()): Diagnosis {
  const daysOnline = Math.max(0, (now - Date.parse(f.listedAt)) / 86400_000);
  const viewsPerDay = daysOnline >= 1 ? f.views / daysOnline : f.views;
  const favouriteRate = f.views ? f.favourites / f.views : 0;
  const issues: Issue[] = [];
  const add = (code: string, severity: Severity, text: string, tip: string) => issues.push({ code, severity, text, tip });
  const days = Math.floor(daysOnline);

  if (daysOnline < 3) {
    add("new", "info", `Erst seit ${days === 0 ? "heute" : `${days} Tag${days === 1 ? "" : "en"}`} online`, "Für eine Bewertung von Aufrufen und Favoriten ist es noch zu früh.");
  } else {
    if (viewsPerDay < 3) {
      add("low_views", "high", `Wird kaum gefunden: ${viewsPerDay.toFixed(1).replace(".", ",")} Aufrufe pro Tag`,
        "Titel mit Marke, Artikelart, Größe und Stil-Stichworten (z. B. „Vintage Graphic Tee Anime weiß M“), genaue Kategorie, 5–10 passende Hashtags. Nach 2–3 Wochen neu einstellen – neue Artikel stehen weiter oben.");
    }
    if (f.views >= 30 && favouriteRate < 0.03) {
      add("low_interest", "medium", `Viele schauen, wenige merken ihn sich: ${f.favourites} Favoriten bei ${f.views} Aufrufen (${pct(favouriteRate)})`,
        "Das erste Foto entscheidet: hell, ganzer Artikel, ruhiger Hintergrund, gern getragen. Preis mit ähnlichen Artikeln vergleichen.");
    }
    if (f.favourites >= 3 && daysOnline >= 7) {
      add("no_conversion", "high", `${f.favourites} Leute haben ihn favorisiert, aber niemand kauft`,
        f.lastPriceDropAt ? "Interessenten zögern beim Preis – ein Bündel-/Mengenrabatt oder ein Angebot an die Interessenten hilft." : "Preis leicht senken (5–10 %): Vinted benachrichtigt alle, die den Artikel favorisiert haben.");
    }
    if (daysOnline >= 30) {
      add("stale", f.views / Math.max(daysOnline, 1) < 3 ? "medium" : "low", `Seit ${days} Tagen online`,
        "Ältere Artikel rutschen in der Suche nach unten. Löschen und neu einstellen (mit frischen Fotos) bringt ihn wieder nach vorne.");
    }
  }

  if (f.priceCents && f.marketCents && f.priceCents > f.marketCents * 1.2) {
    add("overpriced", "high", `${pct(f.priceCents / f.marketCents - 1)} teurer als deine ähnlichen Artikel (üblich ≈ ${eur(f.marketCents)})`,
      `Auf etwa ${eur(Math.round(f.marketCents / 50) * 50)} gehen oder im Titel/Beschreibung begründen, warum er mehr wert ist (Marke, Zustand, Seltenheit).`);
  }
  if (f.photoCount < 4) {
    add("few_photos", "medium", `Nur ${f.photoCount} Foto${f.photoCount === 1 ? "" : "s"}`, "5–8 Fotos: Gesamtansicht, getragen, Rückseite, Details/Print, Etikett, eventuelle Mängel.");
  }
  if (f.description.replace(/#\S+/g, "").trim().length < 120) {
    add("short_description", "low", "Kurze Beschreibung", "Zustand, Material, Passform und Maße in Stichpunkten ergänzen – das beantwortet die häufigsten Käuferfragen vorab.");
  }
  const missing = [!f.brand && "Marke", !f.size && "Größe", !f.condition && "Zustand", !f.category && "Kategorie"].filter(Boolean) as string[];
  if (missing.length) add("missing_info", "medium", `Fehlende Angaben: ${missing.join(", ")}`, "Fehlende Felder machen den Artikel in Filtern unsichtbar – im Dashboard und bei Vinted ergänzen.");
  if (!f.measurements) add("no_measurements", "low", "Keine Maße angegeben", "Breite und Länge angeben – bei Kleidung die häufigste Rückfrage.");
  if (f.brand && !f.title.toLowerCase().includes(f.brand.toLowerCase())) {
    add("brand_not_in_title", "low", `Marke „${f.brand}“ steht nicht im Titel`, "Viele suchen direkt nach der Marke – sie gehört an den Anfang des Titels.");
  }

  const score = Math.max(0, 100 - issues.reduce((s, i) => s + WEIGHT[i.severity], 0));
  issues.sort((a, b) => WEIGHT[b.severity] - WEIGHT[a.severity]);
  return { score, daysOnline, viewsPerDay, favouriteRate, issues };
}

// ---------- insights over all listings ----------

export interface HistoryRow { status: string; listedAt: string; soldAt: string | null; priceCents: number | null; category: string | null; brand: string | null }
export interface Insight { kind: "good" | "bad" | "info"; text: string }

const lastSegment = (c: string | null) => (c ?? "").split(">").pop()!.trim() || null;

export function insights(rows: HistoryRow[]): Insight[] {
  const out: Insight[] = [];
  const sold = rows.filter((r) => r.status === "sold" && r.soldAt);
  if (rows.length < 5) return [{ kind: "info", text: "Noch zu wenige Artikel für Auswertungen – ab etwa 5 Listings gibt es hier Muster." }];

  const rate = (list: HistoryRow[]) => list.filter((r) => r.status === "sold").length / list.length;
  out.push({ kind: "info", text: `Verkaufsquote insgesamt: ${pct(rate(rows))} (${sold.length} von ${rows.length} Listings verkauft).` });

  const daysToSell = sold.map((r) => (Date.parse(r.soldAt!) - Date.parse(r.listedAt)) / 86400_000).filter((d) => d >= 0);
  if (daysToSell.length >= 3) {
    const sorted = [...daysToSell].sort((a, b) => a - b);
    out.push({ kind: "info", text: `Verkaufte Artikel waren im Mittel ${Math.round(sorted[Math.floor(sorted.length / 2)]!)} Tage online.` });
  }

  for (const [label, key] of [["Kategorie", (r: HistoryRow) => lastSegment(r.category)], ["Marke", (r: HistoryRow) => r.brand]] as const) {
    const groups = new Map<string, HistoryRow[]>();
    for (const r of rows) {
      const k = key(r);
      if (k) groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    const ranked = [...groups.entries()].filter(([, l]) => l.length >= 3).map(([k, l]) => ({ k, r: rate(l), n: l.length })).sort((a, b) => b.r - a.r);
    if (ranked.length >= 2) {
      const best = ranked[0]!, worst = ranked[ranked.length - 1]!;
      if (best.r > worst.r) {
        out.push({ kind: "good", text: `Beste ${label}: ${best.k} – ${pct(best.r)} verkauft (${best.n} Listings).` });
        out.push({ kind: "bad", text: `Schwächste ${label}: ${worst.k} – ${pct(worst.r)} verkauft (${worst.n} Listings).` });
      }
    }
  }

  const buckets: [string, number, number][] = [["unter 10 €", 0, 1000], ["10–20 €", 1000, 2000], ["20–35 €", 2000, 3500], ["über 35 €", 3500, Infinity]];
  const byBucket = buckets.map(([name, lo, hi]) => {
    const l = rows.filter((r) => r.priceCents !== null && r.priceCents >= lo && r.priceCents < hi);
    return { name, n: l.length, r: l.length ? rate(l) : 0 };
  }).filter((b) => b.n >= 3);
  if (byBucket.length >= 2) {
    const best = [...byBucket].sort((a, b) => b.r - a.r)[0]!;
    out.push({ kind: "good", text: `Preisbereich mit der besten Quote: ${best.name} (${pct(best.r)} verkauft). ${byBucket.map((b) => `${b.name}: ${pct(b.r)}`).join(" · ")}` });
  }
  return out;
}

/**
 * SQL condition (listings `l` joined with accounts `a`): only listings that really are in the
 * seller's Vinted shop – linked to a Vinted item and on a connected account, checked at every sync.
 */
export const ON_VINTED = "l.status = 'active' AND l.vinted_item_id IS NOT NULL AND a.status = 'connected'";
