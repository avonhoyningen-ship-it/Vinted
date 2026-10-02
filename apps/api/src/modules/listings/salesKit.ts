import { z } from "zod";
import { getSetting } from "../../lib/settings.js";
import { readPhoto, rotateStoredPhoto } from "../../storage/photos.js";
import { getItem, itemInput, listPhotos, reorderPhotos, replacePhotoFile, updateItem } from "../archive/repo.js";
import { confirmPrice, examplesForPrompt, refreshSuggestion } from "../pricing/engine.js";
import { aiEnabled, composeDescription, detectOrientations, generateListing, normalizeOrder } from "./ai.js";
import { loadRules, ruleBrand, ruleParcel } from "./brandRules.js";

/** Sales-kit AI on stored items: on demand (✨ KI) and fresh at every upload. */

/** Runs the sales-kit AI: rotates photos upright and (optionally) writes the texts into the item. */
export async function runAi(itemId: number, hints: string | undefined, keep: Partial<z.infer<typeof itemInput>> = {}, apply = true, orient = true, reorder = true) {
  const item = await getItem(itemId);
  if (orient) await orientPhotos(itemId);
  const photos = await listPhotos(itemId);
  const s = await generateListing(photos, {
    hints, measurements: item.measurements, language: await getSetting("ai.language"), stylePrompt: await getSetting("ai.listingPrompt"),
    priceExamples: await examplesForPrompt(item),
  });
  // Outfit shot → article only → details → tag (as decided by the model).
  const sent = photos.slice(0, 20);
  const order = normalizeOrder(s.photo_order ?? [], sent.length).map((i) => sent[i]!.id);
  if (reorder) await reorderPhotos(itemId, [...order, ...photos.slice(20).map((p) => p.id)]);
  const description = composeDescription(s);
  if (apply) {
    const rules = await loadRules();
    await updateItem(itemId, {
      title: keep.title || s.title.slice(0, 200),
      description: keep.description || description.slice(0, 5000),
      category: keep.category ?? s.category,
      // Brand rules win over the AI (e.g. every T-shirt → "Graphic Tee").
      brand: keep.brand ?? ruleBrand({ title: s.title, category: s.category, description }, rules.brand) ?? s.brand,
      size: keep.size ?? s.size,
      condition: keep.condition ?? s.condition,
      color: keep.color ?? s.color,
      material: keep.material ?? s.material,
      parcel_size: keep.parcel_size ?? ruleParcel({ title: s.title, category: s.category, description }, rules.parcel) ?? s.parcel_size,
    });
    if (keep.price_cents) await confirmPrice(itemId, keep.price_cents, "manual");
  }
  // The price is only a suggestion until the seller confirms it (✓).
  if (!(await getItem(itemId)).price_confirmed) await refreshSuggestion(itemId, Math.round(s.suggested_price_eur * 100));
  return { ...s, description };
}

/** Turns every photo of an item upright (dedicated orientation check). */
export async function orientPhotos(itemId: number) {
  const photos = await listPhotos(itemId);
  const degrees = await detectOrientations(await Promise.all(photos.map((p) => readPhoto(p.file_name))));
  for (const [i, deg] of degrees.entries()) {
    if (deg) await replacePhotoFile(photos[i]!.id, await rotateStoredPhoto(photos[i]!.file_name, deg));
  }
}

/**
 * Right before an item is filled into Vinted: title, description, hashtags and the listing
 * fields (category, brand, size, condition, colour, material) are written fresh every time.
 * The seller's price, measurements and photos stay as they are. Returns an error text or null.
 */
export async function refreshForUpload(itemId: number): Promise<string | null> {
  if (!aiEnabled() || !(await getSetting("ai.regenerateOnUpload"))) return null;
  try {
    const item = await getItem(itemId);
    await runAi(itemId, item.notes ?? undefined, {}, true, false, false);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
