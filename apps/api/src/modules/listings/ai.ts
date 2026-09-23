import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env } from "../../config/env.js";
import { HttpError } from "../../lib/http.js";
import { readPhotoBase64 } from "../../storage/photos.js";
import { CONDITIONS, type PhotoRow } from "../archive/repo.js";

export const ListingSuggestion = z.object({
  title: z.string().describe("Prägnanter Vinted-Titel, max. 60 Zeichen: Marke + Artikel + wichtigstes Merkmal"),
  description: z.string().describe("Ehrliche Beschreibung, 3-6 kurze Sätze, inkl. sichtbarer Mängel"),
  category: z.string().describe("Vinted-Kategoriepfad, z. B. 'Herren > Kleidung > Jeans'"),
  brand: z.string().nullable().describe("Marke falls erkennbar, sonst null"),
  size: z.string().nullable().describe("Größe falls auf Etikett erkennbar, sonst null"),
  condition: z.enum(CONDITIONS),
  color: z.string().nullable(),
  material: z.string().nullable(),
  suggested_price_eur: z.number().describe("Realistischer Vinted-Verkaufspreis in EUR"),
  price_reasoning: z.string().describe("Ein Satz Begründung für den Preis"),
  confidence_notes: z.string().describe("Was unsicher ist und manuell geprüft werden sollte"),
});
export type ListingSuggestion = z.infer<typeof ListingSuggestion>;

let client: Anthropic | null = null;
function getClient() {
  if (!env.anthropicApiKey) throw new HttpError(503, "ANTHROPIC_API_KEY ist nicht gesetzt – KI-Funktionen deaktiviert (siehe .env)");
  client ??= new Anthropic({ apiKey: env.anthropicApiKey });
  return client;
}

export const aiEnabled = () => !!env.anthropicApiKey;

const SYSTEM = `Du bist ein erfahrener Vinted-Reseller im deutschsprachigen Raum. Du erstellst aus Produktfotos
verkaufsstarke, aber ehrliche Inserate. Erfinde keine Details, die auf den Fotos nicht erkennbar sind: Unsicheres
(Größe, Material, Marke) gibst du als null zurück und nennst es in confidence_notes. Sichtbare Mängel gehören in die
Beschreibung. Preise orientieren sich an typischen Vinted-Second-Hand-Preisen, nicht am Neupreis.`;

/** Generates listing fields from up to 8 stored photos. */
export async function generateListing(photos: PhotoRow[], hints?: string, language = "de"): Promise<ListingSuggestion> {
  if (!photos.length) throw new HttpError(400, "Mindestens ein Foto erforderlich");
  const images: Anthropic.ImageBlockParam[] = photos.slice(0, 8).map((p) => ({
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: readPhotoBase64(p.file_name) },
  }));
  const text = [
    `Erstelle ein Vinted-Inserat für den Artikel auf diesen Fotos. Sprache der Texte: ${language}.`,
    hints ? `Zusätzliche Infos vom Verkäufer (haben Vorrang vor deiner Einschätzung): ${hints}` : "",
  ].filter(Boolean).join("\n");

  const response = await getClient().messages.parse({
    model: env.anthropicModel,
    max_tokens: 16000,
    system: SYSTEM,
    messages: [{ role: "user", content: [...images, { type: "text", text }] }],
    output_config: { format: zodOutputFormat(ListingSuggestion) },
  });
  if (response.stop_reason === "refusal") throw new HttpError(422, "Die KI hat die Anfrage abgelehnt");
  if (!response.parsed_output) throw new HttpError(502, "KI-Antwort konnte nicht gelesen werden");
  return response.parsed_output;
}
