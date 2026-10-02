import { Router } from "express";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env } from "../../config/env.js";
import { db } from "../../db/index.js";
import { h, HttpError, idParam } from "../../lib/http.js";
import { getItem, getListing, listPhotos } from "../archive/repo.js";
import { getClient, modelImage } from "../listings/ai.js";
import { similarExamples } from "../pricing/engine.js";
import { diagnose, insights, ON_VINTED, type ListingFacts } from "./diagnose.js";

export const analysisRouter = Router();

interface Row {
  id: number; item_id: number; account_id: number; account_name: string; vinted_item_id: string | null; url: string | null;
  title: string; description: string; price_cents: number | null; views: number; favourites: number; listed_at: string;
  last_price_drop_at: string | null; brand: string | null; size: string | null; category: string | null; condition: string | null;
  measurements: string | null; photo_count: number; cover_photo: string | null;
}

/** Typical price of similar items (median of the closest learned examples). */
async function marketPrice(item: { id: number; title: string; brand: string | null; category: string | null; size: string | null; condition: string | null }) {
  const similar = await similarExamples(item, 8);
  if (similar.length < 2) return null;
  const prices = similar.map((x) => x.e.price_cents).sort((a, b) => a - b);
  return prices[Math.floor(prices.length / 2)]!;
}

async function facts(r: Row): Promise<ListingFacts> {
  return {
    title: r.title, description: r.description, priceCents: r.price_cents, views: Number(r.views), favourites: Number(r.favourites),
    listedAt: r.listed_at, lastPriceDropAt: r.last_price_drop_at, photoCount: Number(r.photo_count), brand: r.brand, size: r.size,
    category: r.category, condition: r.condition, measurements: r.measurements,
    marketCents: await marketPrice({ id: r.item_id, title: r.title, brand: r.brand, category: r.category, size: r.size, condition: r.condition }),
  };
}

const ACTIVE = `
  SELECT l.id, l.item_id, l.account_id, a.name AS account_name, l.vinted_item_id, l.url, l.title, l.description, l.price_cents,
    l.views, l.favourites, l.listed_at, l.last_price_drop_at, i.brand, i.size, i.category, i.condition, i.measurements,
    (SELECT COUNT(*) FROM item_photos p WHERE p.item_id = l.item_id) AS photo_count,
    (SELECT file_name FROM item_photos p WHERE p.item_id = l.item_id ORDER BY position, id LIMIT 1) AS cover_photo
  FROM listings l JOIN items i ON i.id = l.item_id JOIN accounts a ON a.id = l.account_id
  WHERE l.status = 'active'`;


/** All active listings with their diagnosis (worst first) and insights over the whole history. */
analysisRouter.get("/", h(async (_req, res) => {
  const rows = await db.all<Row>(`${ACTIVE.replace("l.status = 'active'", ON_VINTED)} ORDER BY l.listed_at`);
  // Active in the archive but not (verifiably) in the shop: left out, the page says why.
  const hidden = await db.all<{ reason: string; account_name: string; c: number }>(`
    SELECT CASE WHEN a.status <> 'connected' THEN 'account' ELSE 'unlinked' END AS reason, a.name AS account_name, COUNT(*) AS c
    FROM listings l JOIN accounts a ON a.id = l.account_id
    WHERE l.status = 'active' AND NOT (${ON_VINTED})
    GROUP BY CASE WHEN a.status <> 'connected' THEN 'account' ELSE 'unlinked' END, a.name`);
  const listings = [];
  for (const r of rows) {
    const f = await facts(r);
    listings.push({
      listingId: r.id, itemId: r.item_id, accountName: r.account_name, url: r.url, title: r.title, priceCents: r.price_cents,
      views: f.views, favourites: f.favourites, photoCount: f.photoCount, coverPhoto: r.cover_photo, marketCents: f.marketCents,
      hasVintedId: !!r.vinted_item_id, ...diagnose(f),
    });
  }
  listings.sort((a, b) => a.score - b.score || b.daysOnline - a.daysOnline);
  const history = await db.all<{ status: string; listed_at: string; sold_at: string | null; price_cents: number | null; category: string | null; brand: string | null }>(
    `SELECT l.status, l.listed_at, l.sold_at, l.price_cents, i.category, i.brand FROM listings l JOIN items i ON i.id = l.item_id`);
  const counts: Record<string, number> = {};
  for (const l of listings) for (const i of l.issues) counts[i.code] = (counts[i.code] ?? 0) + 1;
  res.json({
    listings,
    issueCounts: counts,
    hidden: {
      unlinked: hidden.filter((x) => x.reason === "unlinked").reduce((n, x) => n + Number(x.c), 0),
      accounts: hidden.filter((x) => x.reason === "account").map((x) => ({ name: x.account_name, count: Number(x.c) })),
    },
    insights: insights(history.map((h) => ({ status: h.status, listedAt: h.listed_at, soldAt: h.sold_at, priceCents: h.price_cents, category: h.category, brand: h.brand }))),
  });
}));

const AiReview = z.object({
  summary: z.string().describe("2–3 Sätze: die wahrscheinlichsten Gründe, warum der Artikel sich nicht verkauft"),
  reasons: z.array(z.string()).describe("Konkrete Gründe, wichtigster zuerst (max. 5)"),
  improvements: z.array(z.object({
    area: z.enum(["Fotos", "Titel", "Beschreibung", "Preis", "Kategorie/Angaben", "Timing"]),
    tip: z.string().describe("konkrete, umsetzbare Anweisung"),
  })).describe("Verbesserungen, wirksamste zuerst (max. 6)"),
  better_title: z.string().nullable().describe("Besserer Vinted-Titel (max. 90 Zeichen) oder null, wenn der Titel gut ist"),
  suggested_price_eur: z.number().nullable().describe("Empfohlener Preis in EUR oder null, wenn der Preis passt"),
});

/** AI review of one listing: photos, texts and Vinted's numbers. */
analysisRouter.post("/:listingId/ai", h(async (req, res) => {
  const listing = await getListing(idParam(req, "listingId"));
  const item = await getItem(listing.item_id);
  const row = (await db.get<Row>(`${ACTIVE.replace("WHERE l.status = 'active'", "WHERE l.id = ?")}`, [listing.id]))!;
  const f = await facts(row);
  const d = diagnose(f);
  const content: import("@anthropic-ai/sdk").default.ContentBlockParam[] = [];
  for (const [i, p] of (await listPhotos(item.id)).slice(0, 6).entries()) content.push({ type: "text", text: `Foto ${i + 1}:` }, await modelImage(p));
  content.push({
    type: "text",
    text: [
      "Analysiere dieses Vinted-Inserat eines Second-Hand-Verkäufers. Warum verkauft es sich nicht, und was genau sollte er ändern?",
      `Titel: ${listing.title}`,
      `Beschreibung:\n${listing.description || "(leer)"}`,
      `Preis: ${listing.price_cents ? (listing.price_cents / 100).toFixed(2) : "?"} € · Marke: ${item.brand ?? "?"} · Größe: ${item.size ?? "?"} · Zustand: ${item.condition ?? "?"} · Kategorie: ${item.category ?? "?"}`,
      `Online seit ${Math.floor(d.daysOnline)} Tagen · ${f.views} Aufrufe (${d.viewsPerDay.toFixed(1)}/Tag) · ${f.favourites} Favoriten`,
      f.marketCents ? `Ähnliche Artikel des Verkäufers kosten üblicherweise ${(f.marketCents / 100).toFixed(2)} €.` : "",
      `Automatische Befunde: ${d.issues.map((i) => i.text).join("; ") || "keine"}`,
    ].filter(Boolean).join("\n"),
  });
  const response = await getClient().messages.parse({
    model: env.anthropicModel,
    max_tokens: 4000,
    system: "Du bist ein erfahrener Vinted-Verkaufscoach. Antworte auf Deutsch, konkret und ehrlich. Erfinde keine Fakten über den Artikel, die nicht aus Fotos oder Text hervorgehen.",
    messages: [{ role: "user", content }],
    output_config: { format: zodOutputFormat(AiReview) },
  });
  if (!response.parsed_output) throw new HttpError(502, "KI-Antwort konnte nicht gelesen werden");
  res.json({ ...response.parsed_output, diagnosis: d });
}));
