import sharp from "sharp";
import { db, nowIso } from "../../../db/index.js";
import { eventBus } from "../../../lib/eventBus.js";
import { HttpError } from "../../../lib/http.js";
import { readPhoto } from "../../../storage/photos.js";
import { getItem, listPhotos, recomputeItemStatus, type ItemRow } from "../../archive/repo.js";
import { aiEnabled, chooseAspects } from "../../listings/ai.js";
import { loadRules, ruleBrand } from "../../listings/brandRules.js";
import { ebay, EbayError, LOCATION_KEY, loadConfig, MARKETPLACE, requireConfig, saveConfig, uploadPicture, type EbayConfig } from "./client.js";

/**
 * eBay listings of archive items: photos → category → item specifics → inventory item →
 * offer → publish. Ending (when sold elsewhere) and picking up eBay orders.
 */
export interface MarketplaceListing {
  id: number; item_id: number; platform: string; sku: string | null; offer_id: string | null; external_id: string | null;
  url: string | null; price_cents: number | null; status: "active" | "sold" | "ended" | "failed"; error: string | null;
  listed_at: string; ended_at: string | null; sold_at: string | null;
}

const skuFor = (itemId: number) => `ask-${itemId}`;
const itemIdFromSku = (sku: string | null | undefined) => (sku?.match(/^ask-(\d+)$/) ? Number(sku.slice(4)) : null);

const CONDITION: Record<string, string> = {
  new_with_tags: "NEW", new_without_tags: "NEW_OTHER", very_good: "USED_EXCELLENT", good: "USED_EXCELLENT", satisfactory: "USED_EXCELLENT",
};
const CONDITION_TEXT: Record<string, string> = { very_good: "Sehr guter Zustand", good: "Guter Zustand", satisfactory: "Zufriedenstellender Zustand" };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const toHtml = (text: string) => esc(text).split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");

// ---------- setup ----------

export async function listPolicies() {
  const q = `?marketplace_id=${MARKETPLACE}`;
  const [f, p, r] = await Promise.all([
    ebay<{ fulfillmentPolicies?: { fulfillmentPolicyId: string; name: string }[] }>("GET", `/sell/account/v1/fulfillment_policy${q}`),
    ebay<{ paymentPolicies?: { paymentPolicyId: string; name: string }[] }>("GET", `/sell/account/v1/payment_policy${q}`),
    ebay<{ returnPolicies?: { returnPolicyId: string; name: string }[] }>("GET", `/sell/account/v1/return_policy${q}`),
  ]);
  return {
    fulfillment: (f.data.fulfillmentPolicies ?? []).map((x) => ({ id: x.fulfillmentPolicyId, name: x.name })),
    payment: (p.data.paymentPolicies ?? []).map((x) => ({ id: x.paymentPolicyId, name: x.name })),
    return: (r.data.returnPolicies ?? []).map((x) => ({ id: x.returnPolicyId, name: x.name })),
  };
}

/** eBay needs a "location" the item ships from (only the postal code is used). */
async function ensureLocation(cfg: EbayConfig) {
  if (cfg.locationReady) return;
  if (!cfg.postalCode) throw new HttpError(400, "Bitte unter Einstellungen → eBay deine Postleitzahl eintragen (Versandort)");
  try {
    await ebay("POST", `/sell/inventory/v1/location/${LOCATION_KEY}`, {
      location: { address: { postalCode: cfg.postalCode, country: "DE" } }, locationTypes: ["WAREHOUSE"], name: "Versandort", merchantLocationStatus: "ENABLED",
    });
  } catch (e) {
    if (!(e instanceof EbayError && e.errorIds.includes(25803))) throw e; // already exists
  }
  await saveConfig({ ...cfg, locationReady: true });
}

// ---------- category + item specifics ----------

async function suggestCategory(query: string): Promise<{ id: string; name: string }> {
  const tree = await ebay<{ categoryTreeId: string }>("GET", `/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${MARKETPLACE}`);
  const r = await ebay<{ categorySuggestions?: { category: { categoryId: string; categoryName: string } }[] }>(
    "GET", `/commerce/taxonomy/v1/category_tree/${tree.data.categoryTreeId}/get_category_suggestions?q=${encodeURIComponent(query.slice(0, 80))}`);
  const c = r.data.categorySuggestions?.[0]?.category;
  if (!c) throw new HttpError(400, "eBay hat keine passende Kategorie gefunden");
  return { id: c.categoryId, name: c.categoryName };
}

interface Aspect { localizedAspectName: string; aspectConstraint?: { aspectRequired?: boolean; aspectMode?: string }; aspectValues?: { localizedValue: string }[] }

async function requiredAspects(categoryId: string): Promise<{ name: string; values: string[] }[]> {
  const tree = await ebay<{ categoryTreeId: string }>("GET", `/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${MARKETPLACE}`);
  const r = await ebay<{ aspects?: Aspect[] }>("GET", `/commerce/taxonomy/v1/category_tree/${tree.data.categoryTreeId}/get_item_aspects_for_category?category_id=${categoryId}`);
  return (r.data.aspects ?? []).filter((a) => a.aspectConstraint?.aspectRequired).map((a) => ({
    name: a.localizedAspectName,
    values: a.aspectConstraint?.aspectMode === "SELECTION_ONLY" ? (a.aspectValues ?? []).map((v) => v.localizedValue) : [],
  }));
}

/** Item specifics from the article's data; what's still missing is filled by the AI (or left out). */
async function buildAspects(item: ItemRow, brand: string, categoryName: string, required: { name: string; values: string[] }[]) {
  const dept = /damen|frauen/i.test(item.category ?? "") ? "Damen" : /herren|männer/i.test(item.category ?? "") ? "Herren" : null;
  const known: Record<string, string | null> = {
    Marke: brand, Größe: item.size, Farbe: item.color, Material: item.material, Abteilung: dept,
    Produktart: categoryName, Zustand: null,
  };
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(known)) if (v) out[k] = [v];
  const missing = required.filter((a) => !out[a.name] || (a.values.length && !a.values.includes(out[a.name]![0]!)));
  if (missing.length && aiEnabled()) {
    const article = [`Titel: ${item.title}`, `Kategorie: ${item.category ?? "–"}`, `Größe: ${item.size ?? "–"}`, `Farbe: ${item.color ?? "–"}`,
      `Material: ${item.material ?? "–"}`, `Marke: ${brand}`, `Beschreibung: ${item.description.slice(0, 1500)}`].join("\n");
    const chosen = await chooseAspects(article, missing).catch(() => ({} as Record<string, string>));
    for (const [k, v] of Object.entries(chosen)) out[k] = [v];
  }
  return out;
}

// ---------- listing ----------

export async function activeEbayListing(itemId: number) {
  return db.get<MarketplaceListing>("SELECT * FROM marketplace_listings WHERE item_id = ? AND platform = 'ebay' AND status = 'active'", [itemId]);
}

/** Puts one archive item on eBay (fixed price) – returns the eBay listing. */
export async function listOnEbay(itemId: number): Promise<MarketplaceListing> {
  const existing = await activeEbayListing(itemId);
  if (existing) return existing;
  const cfg = await requireConfig();
  if (!cfg.fulfillmentPolicyId || !cfg.paymentPolicyId || !cfg.returnPolicyId) {
    throw new HttpError(400, "Bitte unter Einstellungen → eBay Versand-, Zahlungs- und Rückgabe-Richtlinie auswählen");
  }
  await ensureLocation(cfg);
  const item = await getItem(itemId);
  const base = item.price_confirmed && item.price_cents ? item.price_cents : item.price_suggested_cents ?? item.price_cents;
  if (!base) throw new HttpError(400, `„${item.title}“ hat noch keinen Preis`);
  const priceCents = Math.round((base * (cfg.pricePercent ?? 100)) / 100);
  const sku = skuFor(itemId);
  try {
    // Photos: eBay needs them on its own picture hosting.
    const photos = (await listPhotos(itemId)).slice(0, 12);
    if (!photos.length) throw new HttpError(400, "Keine Fotos");
    const imageUrls: string[] = [];
    for (const [i, p] of photos.entries()) {
      const jpg = await sharp(await readPhoto(p.file_name)).rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
      imageUrls.push(await uploadPicture(jpg, `${sku}-${i + 1}`));
    }
    // Brand switch off → only a brand rule (e.g. "Graphic Tee"), otherwise "Markenlos".
    const rules = await loadRules();
    const brand = ruleBrand(item, rules.brand) ?? (item.mention_brand && item.brand ? item.brand : "Markenlos");
    const leaf = (item.category ?? "").split(">").map((x) => x.trim()).filter(Boolean).pop() ?? "";
    const category = await suggestCategory([leaf, item.title].filter(Boolean).join(" "));
    const aspects = await buildAspects(item, brand, category.name, await requiredAspects(category.id));
    const condition = CONDITION[item.condition ?? ""] ?? "USED_EXCELLENT";

    await ebay("PUT", `/sell/inventory/v1/inventory_item/${sku}`, {
      availability: { shipToLocationAvailability: { quantity: 1 } },
      condition,
      ...(condition === "USED_EXCELLENT" && CONDITION_TEXT[item.condition ?? ""] ? { conditionDescription: CONDITION_TEXT[item.condition ?? ""] } : {}),
      product: { title: item.title.slice(0, 80), description: toHtml(item.description || item.title), aspects, imageUrls },
    });
    const offer = {
      sku, marketplaceId: MARKETPLACE, format: "FIXED_PRICE", availableQuantity: 1, categoryId: category.id,
      listingDescription: toHtml(item.description || item.title),
      listingPolicies: { fulfillmentPolicyId: cfg.fulfillmentPolicyId, paymentPolicyId: cfg.paymentPolicyId, returnPolicyId: cfg.returnPolicyId },
      pricingSummary: { price: { value: (priceCents / 100).toFixed(2), currency: "EUR" } },
      merchantLocationKey: LOCATION_KEY,
    };
    let offerId: string;
    try {
      offerId = (await ebay<{ offerId: string }>("POST", "/sell/inventory/v1/offer", offer)).data.offerId;
    } catch (e) {
      // An offer for this SKU exists already (e.g. after an earlier attempt) → update it.
      if (!(e instanceof EbayError && e.errorIds.includes(25002))) throw e;
      const found = await ebay<{ offers?: { offerId: string }[] }>("GET", `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}`);
      offerId = found.data.offers?.[0]?.offerId ?? "";
      if (!offerId) throw e;
      await ebay("PUT", `/sell/inventory/v1/offer/${offerId}`, offer);
    }
    const pub = await ebay<{ listingId: string }>("POST", `/sell/inventory/v1/offer/${offerId}/publish`);
    const listingId = pub.data.listingId;
    const url = `https://www.ebay.de/itm/${listingId}`;
    await db.run("DELETE FROM marketplace_listings WHERE item_id = ? AND platform = 'ebay' AND status = 'failed'", [itemId]);
    const id = await db.insert(`INSERT INTO marketplace_listings (item_id, platform, sku, offer_id, external_id, url, price_cents, status, listed_at)
      VALUES (?, 'ebay', ?, ?, ?, ?, ?, 'active', ?)`, [itemId, sku, offerId, listingId, url, priceCents, nowIso()]);
    await recomputeItemStatus(itemId);
    eventBus.publish({ type: "marketplace", platform: "eBay", itemId, title: item.title, state: "listed", url, message: null });
    return (await db.get<MarketplaceListing>("SELECT * FROM marketplace_listings WHERE id = ?", [id]))!;
  } catch (e) {
    const message = (e as Error).message;
    await db.run("DELETE FROM marketplace_listings WHERE item_id = ? AND platform = 'ebay' AND status = 'failed'", [itemId]);
    await db.run("INSERT INTO marketplace_listings (item_id, platform, sku, status, error, listed_at) VALUES (?, 'ebay', ?, 'failed', ?, ?)", [itemId, sku, message.slice(0, 500), nowIso()]);
    eventBus.publish({ type: "marketplace", platform: "eBay", itemId, title: item.title, state: "failed", url: null, message });
    throw e;
  }
}

/** Ends the eBay listing of an item (sold elsewhere / removed). Returns how many were ended. */
export async function endOnEbay(itemId: number, reason: "sold_elsewhere" | "manual" = "manual"): Promise<number> {
  const rows = await db.all<MarketplaceListing>("SELECT * FROM marketplace_listings WHERE item_id = ? AND platform = 'ebay' AND status = 'active'", [itemId]);
  for (const l of rows) {
    if (l.offer_id) {
      try {
        await ebay("POST", `/sell/inventory/v1/offer/${l.offer_id}/withdraw`);
      } catch (e) {
        if (!(e instanceof EbayError && e.errorIds.some((id) => [25713, 25710].includes(id)))) throw e; // already ended/not found
      }
    }
    await db.run("UPDATE marketplace_listings SET status = 'ended', ended_at = ? WHERE id = ?", [nowIso(), l.id]);
    await recomputeItemStatus(itemId);
    if (reason === "sold_elsewhere") {
      const item = await getItem(itemId).catch(() => null);
      eventBus.publish({ type: "marketplace", platform: "eBay", itemId, title: item?.title ?? "Artikel", state: "ended", url: l.url, message: "Woanders verkauft – auf eBay beendet" });
    }
  }
  return rows.length;
}

// ---------- orders (sold on eBay) ----------

/** Picks up new eBay orders: marks the article sold and takes it off everywhere else. */
export async function pollEbayOrders(): Promise<number> {
  const cfg = await loadConfig();
  if (!cfg?.refreshToken) return 0;
  const since = (cfg as EbayConfig & { lastOrderCheck?: string }).lastOrderCheck ?? new Date(Date.now() - 7 * 86400_000).toISOString();
  const started = new Date().toISOString();
  const r = await ebay<{ orders?: { orderId: string; creationDate: string; lineItems?: { sku?: string; legacyItemId?: string; total?: { value: string } }[] }[] }>(
    "GET", `/sell/fulfillment/v1/order?filter=${encodeURIComponent(`creationdate:[${since}..]`)}&limit=100`);
  let n = 0;
  for (const o of r.data.orders ?? []) {
    for (const li of o.lineItems ?? []) {
      const row = await db.get<MarketplaceListing>(
        "SELECT * FROM marketplace_listings WHERE platform = 'ebay' AND status = 'active' AND (sku = ? OR external_id = ?)", [li.sku ?? "", li.legacyItemId ?? ""]);
      const itemId = row?.item_id ?? itemIdFromSku(li.sku);
      if (!row || !itemId) continue;
      const price = li.total?.value ? Math.round(Number(li.total.value) * 100) : row.price_cents;
      await db.run("UPDATE marketplace_listings SET status = 'sold', sold_at = ?, sold_price_cents = ?, order_id = ?, ended_at = ? WHERE id = ?",
        [o.creationDate, price, o.orderId, o.creationDate, row.id]);
      await recomputeItemStatus(itemId);
      const item = await getItem(itemId);
      eventBus.publish({ type: "sale", accountId: 0, accountName: "eBay", itemId, title: item.title, priceCents: price ?? 0, currency: "EUR", soldAt: o.creationDate });
      const { soldElsewhere } = await import("../crossDelist.js");
      await soldElsewhere(itemId, "ebay");
      n++;
    }
  }
  await saveConfig({ ...(await requireConfig()), lastOrderCheck: started } as EbayConfig);
  return n;
}
