import { db, nowIso } from "../../db/index.js";
import { eventBus } from "../../lib/eventBus.js";
import { HttpError } from "../../lib/http.js";
import { photoPath } from "../../storage/photos.js";
import { chromeUrlFor, getAccount } from "../accounts/repo.js";
import { createListing, getItem, listPhotos } from "../archive/repo.js";
import { loadRules, parcelSize, parseMeasurements, ruleBrand, ruleParcel } from "../listings/brandRules.js";
import { confirmPrice } from "../pricing/engine.js";
import { CONDITION_LABELS, priceText, type AssistItemData, type AssistSource, type Job } from "./assistant.js";

/** Form data for one item – shared by the local assistant and the cloud (which sends it to the PC helper). */
export async function assistData(itemId: number, accountId: number): Promise<Omit<AssistItemData, "photoFiles"> & { photos: string[] }> {
  const item = await getItem(itemId);
  const account = await getAccount(accountId);
  const rules = await loadRules();
  const price = item.price_confirmed && item.price_cents ? item.price_cents : item.price_suggested_cents ?? item.price_cents;
  const { width, length } = parseMeasurements(item.measurements ?? item.title);
  return {
    itemId: item.id,
    title: item.title,
    description: item.description,
    price: price ? priceText(price) : null,
    category: item.category,
    brand: ruleBrand(item, rules.brand) ?? item.brand,
    size: item.size,
    condition: CONDITION_LABELS[item.condition ?? ""] ?? null,
    color: item.color,
    width,
    length,
    parcel: ruleParcel(item, rules.parcel) ?? parcelSize(item.parcel_size),
    photos: (await listPhotos(item.id)).slice(0, 20).map((p) => p.file_name),
    domain: account.domain,
    chromeUrl: chromeUrlFor(account),
  };
}

export async function checkAssistItems(itemIds: number[], accountId: number) {
  await getAccount(accountId);
  const titles = new Map<number, string>();
  for (const id of itemIds) {
    const item = await getItem(id);
    titles.set(id, item.title);
    if (!(await listPhotos(id)).length) throw new HttpError(400, `„${item.title}“ hat keine Fotos`);
  }
  return titles;
}

/** The seller uploaded the item on Vinted: record the listing (and the price as confirmed). */
export async function linkUploadedListing(job: Job, url: string) {
  const item = await getItem(job.itemId);
  const vintedItemId = url.match(/\/items\/(\d+)/)?.[1] ?? null;
  const existing = vintedItemId && (await db.get("SELECT id FROM listings WHERE account_id = ? AND vinted_item_id = ?", [job.accountId, vintedItemId]));
  if (existing) return;
  const price = item.price_confirmed && item.price_cents ? item.price_cents : item.price_suggested_cents ?? item.price_cents;
  if (price && !item.price_confirmed) await confirmPrice(item.id, price, "confirmed");
  await createListing({
    item_id: item.id, account_id: job.accountId, vinted_item_id: vintedItemId, url, title: item.title,
    description: item.description, price_cents: price ?? null, currency: item.currency, listed_at: nowIso(),
  });
  eventBus.publish({ type: "published", accountId: job.accountId, itemId: item.id, title: item.title });
}

/** Local dashboard: items from this PC's database, photos from the local folder. */
export const localAssistSource: AssistSource = {
  check: checkAssistItems,
  // Unknown account: default Chrome – check() reports the missing account afterwards.
  chromeUrl: async (accountId) => chromeUrlFor((await getAccount(accountId).catch(() => null)) ?? { chrome_port: null }),
  async load(job) {
    const { photos, ...data } = await assistData(job.itemId, job.accountId);
    return { ...data, photoFiles: photos.map(photoPath) };
  },
  linked: linkUploadedListing,
  publish: (status) => eventBus.publish({ type: "assist", status }),
};
