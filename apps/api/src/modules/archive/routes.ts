import { Router } from "express";
import { z } from "zod";
import { db, nowIso } from "../../db/index.js";
import { h, HttpError, idParam } from "../../lib/http.js";
import { upload } from "../../lib/upload.js";
import { storePhoto } from "../../storage/photos.js";
import { getAccount } from "../accounts/repo.js";
import { confirmPrice, refreshSuggestion } from "../pricing/engine.js";
import { enqueue } from "../listings/queue.js";
import {
  addPhoto, archiveQuery, createItem, createListing, deleteItem, deletePhoto, endListing, facets, getItem, getListing,
  itemDetail, itemInput, itemPatch, markListingSold, reorderPhotos, searchItems, setListingPrice, updateItem,
} from "./repo.js";

export const archiveRouter = Router();

archiveRouter.get("/", h((req, res) => {
  res.json(searchItems(archiveQuery.parse(req.query)));
}));

archiveRouter.get("/facets", h((_req, res) => {
  res.json(facets());
}));

/** Create an archive item manually (JSON). For photo-first creation see POST /api/listings/drafts. */
archiveRouter.post("/", h((req, res) => {
  const item = createItem(itemInput.parse(req.body));
  if (item.price_cents) confirmPrice(item.id, item.price_cents, "manual");
  else refreshSuggestion(item.id);
  res.status(201).json(getItem(item.id));
}));

archiveRouter.get("/:id", h((req, res) => {
  res.json(itemDetail(idParam(req)));
}));

archiveRouter.patch("/:id", h((req, res) => {
  const id = idParam(req);
  const patch = itemPatch.parse(req.body);
  const before = getItem(id);
  const item = updateItem(id, patch);
  if (patch.price_cents && (patch.price_cents !== before.price_cents || !before.price_confirmed)) confirmPrice(id, patch.price_cents, "manual");
  else if (!before.price_confirmed) refreshSuggestion(id);
  res.json(getItem(item.id));
}));

archiveRouter.delete("/:id", h((req, res) => {
  deleteItem(idParam(req));
  res.status(204).end();
}));

// ---------- photos ----------

archiveRouter.post("/:id/photos", upload.array("photos", 20), h(async (req, res) => {
  const id = idParam(req);
  getItem(id);
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (!files.length) throw new HttpError(400, "Keine Fotos hochgeladen (Feld 'photos')");
  const added = [];
  for (const f of files) added.push(addPhoto(id, await storePhoto(f.buffer), f.originalname));
  db.prepare("UPDATE items SET updated_at = ? WHERE id = ?").run(nowIso(), id);
  res.status(201).json(added);
}));

archiveRouter.put("/:id/photos/order", h((req, res) => {
  const id = idParam(req);
  const { ids } = z.object({ ids: z.array(z.number().int()) }).parse(req.body);
  reorderPhotos(id, ids);
  res.json(itemDetail(id).photos);
}));

archiveRouter.delete("/:id/photos/:photoId", h((req, res) => {
  deletePhoto(idParam(req), idParam(req, "photoId"));
  res.status(204).end();
}));

// ---------- reupload ----------

const reuploadInput = z.object({
  accountId: z.number().int().positive(),
  scheduledAt: z.string().datetime({ offset: true }).optional(),
  priceCents: z.number().int().min(0).optional(),
});

/**
 * Puts an archived item back on the same or another own account, with its
 * stored photos and the (optionally edited) texts from the archive.
 */
archiveRouter.post("/:id/reupload", h((req, res) => {
  const id = idParam(req);
  const input = reuploadInput.parse(req.body);
  if (input.priceCents !== undefined) {
    db.prepare("UPDATE items SET price_cents = ?, updated_at = ? WHERE id = ?").run(input.priceCents, nowIso(), id);
  }
  const [entry] = enqueue({ itemIds: [id], accountId: input.accountId, startAt: input.scheduledAt }, true);
  res.status(201).json(entry);
}));

// ---------- listing history (manual maintenance) ----------

const manualListingInput = z.object({
  accountId: z.number().int().positive(),
  url: z.string().url().optional(),
  vintedItemId: z.string().trim().min(1).optional(),
  priceCents: z.number().int().min(0).optional(),
  listedAt: z.string().datetime({ offset: true }).optional(),
});

/** Records a listing that was created manually on Vinted (e.g. in live mode). */
archiveRouter.post("/:id/listings", h((req, res) => {
  const id = idParam(req);
  const input = manualListingInput.parse(req.body);
  const item = getItem(id);
  getAccount(input.accountId);
  const vintedItemId = input.vintedItemId ?? input.url?.match(/\/items\/(\d+)/)?.[1] ?? null;
  const listing = createListing({
    item_id: id, account_id: input.accountId, vinted_item_id: vintedItemId, url: input.url ?? null, title: item.title,
    description: item.description, price_cents: input.priceCents ?? item.price_cents, currency: item.currency, listed_at: input.listedAt,
  });
  // Close a pending queue entry for this item/account, if any.
  db.prepare("UPDATE publish_queue SET status = 'done', listing_id = ?, updated_at = ? WHERE item_id = ? AND account_id = ? AND status IN ('pending','failed')")
    .run(listing.id, nowIso(), id, input.accountId);
  res.status(201).json(listing);
}));

const listingUpdate = z.object({
  status: z.enum(["sold", "removed", "expired", "hidden"]).optional(),
  soldAt: z.string().datetime({ offset: true }).optional(),
  soldPriceCents: z.number().int().min(0).optional(),
  priceCents: z.number().int().min(0).optional(),
});

archiveRouter.patch("/:id/listings/:listingId", h((req, res) => {
  const itemId = idParam(req);
  const listing = getListing(idParam(req, "listingId"));
  if (listing.item_id !== itemId) throw new HttpError(404, "Listing gehört nicht zu diesem Artikel");
  const input = listingUpdate.parse(req.body);
  if (input.priceCents !== undefined) setListingPrice(listing.id, input.priceCents, "Manuell");
  if (input.status === "sold") {
    const soldAt = input.soldAt ?? nowIso();
    const price = input.soldPriceCents ?? listing.price_cents ?? 0;
    markListingSold(listing.id, soldAt, price);
    const item = getItem(itemId);
    db.prepare(`INSERT OR IGNORE INTO sales (account_id, listing_id, item_id, external_id, title, price_cents, currency, category, brand, sold_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(listing.account_id, listing.id, itemId, `manual:${listing.id}`, listing.title, price, listing.currency, item.category, item.brand, soldAt);
  } else if (input.status) {
    endListing(listing.id, input.status);
  }
  res.json(getListing(listing.id));
}));
