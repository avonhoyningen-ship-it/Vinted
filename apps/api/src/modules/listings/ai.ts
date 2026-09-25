import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import sharp from "sharp";
import { z } from "zod";
import { env } from "../../config/env.js";
import { HttpError } from "../../lib/http.js";
import { photoPath } from "../../storage/photos.js";
import { CONDITIONS, type PhotoRow } from "../archive/repo.js";

export const ListingSuggestion = z.object({
  title: z.string().describe("Vinted-Titel, max. 90 Zeichen, normale Schreibweise"),
  bullets: z.array(z.string()).describe("Beschreibung als Stichpunkte; jeder beginnt mit '- ' und enthält einen Emoji"),
  hashtags: z.array(z.string()).describe("15–20 Hashtags, jeweils mit #, ohne Leerzeichen"),
  category: z.string().describe("Vinted-Kategoriepfad, z. B. 'Herren > Kleidung > Jacken'"),
  brand: z.string().nullable().describe("Marke falls erkennbar, sonst null"),
  size: z.string().nullable().describe("Größe laut Etikett oder Verkäufer, sonst null"),
  condition: z.enum(CONDITIONS),
  color: z.string().nullable(),
  material: z.string().nullable(),
  suggested_price_eur: z.number().describe("Ambitionierter, aber realistischer Vinted-Preis in EUR"),
  price_reasoning: z.string().describe("Ein Satz Begründung für den Preis"),
  rotations: z.array(z.object({
    photo: z.number().int().describe("Fotonummer, beginnend bei 1"),
    degrees: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  })).describe("Für JEDES Foto: Drehung im Uhrzeigersinn, damit es aufrecht steht (0 = passt schon)"),
  confidence_notes: z.string().describe("Was unsicher ist und manuell geprüft werden sollte (nur intern, nicht Teil der Beschreibung)"),
});
export type ListingSuggestion = z.infer<typeof ListingSuggestion>;

let client: Anthropic | null = null;
function getClient() {
  if (!env.anthropicApiKey) throw new HttpError(503, "ANTHROPIC_API_KEY ist nicht gesetzt – KI-Funktionen deaktiviert (siehe .env)");
  client ??= new Anthropic({ apiKey: env.anthropicApiKey });
  return client;
}

export const aiEnabled = () => !!env.anthropicApiKey;

/** Fixed technical rules appended to the (user-editable) style prompt. */
const TECHNICAL_RULES = `
Technische Vorgaben (immer einhalten):
- Die Fotos sind nummeriert (Foto 1, Foto 2, …). Gib für jedes Foto unter "rotations" an, um wie viel Grad es im Uhrzeigersinn gedreht werden muss, damit Kleidung/Etiketten aufrecht und lesbar sind (0, 90, 180 oder 270).
- "bullets" enthält nur die Stichpunkte der Beschreibung (ohne Titel, ohne Hashtags).
- Hashtags gehören ausschließlich in "hashtags".
- Maße und Größe nur übernehmen, wenn sie vom Verkäufer stammen oder klar auf einem Etikett lesbar sind.`;

export interface GenerateOptions {
  hints?: string;
  /** Measurements from the upload folder name, e.g. "Länge 70 Breite 55". */
  measurements?: string | null;
  language?: string;
  stylePrompt: string;
}

/** Small JPEG for the model (faster, cheaper); full-size files stay untouched. */
async function modelImage(p: PhotoRow): Promise<Anthropic.ImageBlockParam> {
  const buf = await sharp(photoPath(p.file_name)).resize({ width: 1024, height: 1024, fit: "inside" }).jpeg({ quality: 80 }).toBuffer();
  return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: buf.toString("base64") } };
}

/** Generates the sales kit (title, bullets, hashtags, …) and per-photo rotations from up to 20 photos. */
export async function generateListing(photos: PhotoRow[], opts: GenerateOptions): Promise<ListingSuggestion> {
  if (!photos.length) throw new HttpError(400, "Mindestens ein Foto erforderlich");
  const content: Anthropic.ContentBlockParam[] = [];
  for (const [i, p] of photos.slice(0, 20).entries()) {
    content.push({ type: "text", text: `Foto ${i + 1}:` }, await modelImage(p));
  }
  const info = [
    `Sprache der Texte: ${opts.language ?? "de"}.`,
    opts.measurements ? `Maße vom Verkäufer (aus dem Ordnernamen): ${opts.measurements}` : "Keine Maße angegeben – keine Maße erfinden.",
    opts.hints ? `Hinweise vom Verkäufer (haben Vorrang vor deiner Einschätzung): ${opts.hints}` : "Keine weiteren Hinweise vom Verkäufer.",
  ].join("\n");
  content.push({ type: "text", text: `Erstelle das Verkaufs-Kit für diesen Artikel.\n${info}` });

  const response = await getClient().messages.parse({
    model: env.anthropicModel,
    max_tokens: 16000,
    system: `${opts.stylePrompt.trim()}\n${TECHNICAL_RULES}`,
    messages: [{ role: "user", content }],
    output_config: { format: zodOutputFormat(ListingSuggestion) },
  });
  if (response.stop_reason === "refusal") throw new HttpError(422, "Die KI hat die Anfrage abgelehnt");
  if (!response.parsed_output) throw new HttpError(502, "KI-Antwort konnte nicht gelesen werden");
  return response.parsed_output;
}

/** Bullets + hashtags → final Vinted description text. */
export function composeDescription(s: Pick<ListingSuggestion, "bullets" | "hashtags">): string {
  const bullets = s.bullets
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b) => (b.startsWith("-") ? b.replace(/^-\s*/, "- ") : `- ${b}`));
  const tags = [...new Set(s.hashtags.map((t) => t.trim().replace(/\s+/g, "")).filter(Boolean).map((t) => (t.startsWith("#") ? t : `#${t}`).toLowerCase()))];
  return [bullets.join("\n"), tags.join(" ")].filter(Boolean).join("\n\n");
}

// ---------- grouping a flat folder into articles ----------

const GroupWindow = z.object({
  decisions: z.array(z.object({
    photo: z.number().int().describe("Fotonummer im aktuellen Block (ab 2)"),
    new_item: z.boolean().describe("true = auf diesem Foto beginnt ein ANDERES Kleidungsstück/Accessoire als auf dem vorherigen Foto"),
  })),
});

const GROUP_SYSTEM = `Du sortierst Produktfotos für Vinted-Inserate. Die Fotos stammen aus einem Ordner und sind in Aufnahme-Reihenfolge:
alle Fotos eines Artikels liegen direkt hintereinander (Vorderseite, Rückseite, Etikett, Details, Maßband …), dann folgt der nächste Artikel.
Entscheide für jedes Foto ab Foto 2, ob darauf ein anderer Artikel beginnt als auf dem direkt vorherigen Foto.
Detail- und Etikettenfotos gehören zum Artikel davor, wenn Farbe, Stoff oder Muster passen. Deko (Handy, Kopfhörer, Parfum …) ignorieren.`;

const WINDOW = 30;

/**
 * Splits ordered photos into articles. Works in overlapping windows (the last
 * photo of one window is the first of the next) so long folders keep context.
 * Returns groups of indexes, in order.
 */
export async function groupPhotosInOrder(images: Buffer[]): Promise<number[][]> {
  if (!images.length) return [];
  const newItem: boolean[] = images.map((_, i) => i === 0);
  for (let start = 0; start < images.length - 1; start += WINDOW - 1) {
    const slice = images.slice(start, start + WINDOW);
    const content: Anthropic.ContentBlockParam[] = [];
    slice.forEach((buf, i) => {
      content.push({ type: "text", text: `Foto ${i + 1}:` }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: buf.toString("base64") } });
    });
    content.push({ type: "text", text: `Gib für Foto 2 bis ${slice.length} an, ob ein neuer Artikel beginnt.` });
    let decisions: z.infer<typeof GroupWindow>["decisions"] | null = null;
    for (let attempt = 0; attempt < 2 && !decisions; attempt++) {
      const r = await getClient().messages.parse({
        model: env.anthropicModel,
        max_tokens: 8000,
        system: GROUP_SYSTEM,
        messages: [{ role: "user", content }],
        output_config: { format: zodOutputFormat(GroupWindow) },
      });
      if (r.stop_reason === "refusal") throw new HttpError(422, "Die KI hat die Zuordnung abgelehnt");
      const d = r.parsed_output?.decisions ?? [];
      if (d.length >= slice.length - 1) decisions = d;
    }
    if (!decisions) throw new HttpError(502, "Die KI hat die Fotos nicht vollständig zugeordnet – bitte erneut versuchen.");
    for (const d of decisions) {
      if (d.photo >= 2 && d.photo <= slice.length) newItem[start + d.photo - 1] = d.new_item;
    }
  }
  const groups: number[][] = [];
  newItem.forEach((isNew, i) => (isNew || !groups.length ? groups.push([i]) : groups[groups.length - 1]!.push(i)));
  return groups;
}

/** Normalises any uploaded image into a small JPEG for grouping. */
export async function groupingThumb(input: Buffer): Promise<Buffer> {
  return sharp(input).rotate().resize({ width: 512, height: 512, fit: "inside" }).jpeg({ quality: 70 }).toBuffer();
}
