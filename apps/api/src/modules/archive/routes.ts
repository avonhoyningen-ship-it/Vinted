import { Router } from "express";
import { z } from "zod";
import { db, nowIso } from "../../db/index.js";
import { h, HttpError, idParam } from "../../lib/http.js";
import { upload } from "../../lib/upload.js";
import fs from "node:fs";
import { createZip } from "../../lib/zip.js";
import { photoPath, storePhoto } from "../../storage/photos.js";
import { getAccount } from "../accounts/repo.js";
import { confirmPrice, refreshSuggestion } from "../pricing/engine.js";
import { enqueue } from "../listings/queue.js";
import {
  addPhoto, archiveQuery, createItem, createListing, deleteItem, deletePhoto, endListing, facets, getItem, getListing,
  itemDetail, itemInput, itemPatch, listPhotos, markListingSold, reorderPhotos, searchItems, setListingPrice, updateItem,
} from "./repo.js";

export const archiveRouter = Router();

archiveRouter.get("/", h(async (req, res) => {
  res.json(await searchItems(archiveQuery.parse(req.query)));
}));

archiveRouter.get("/facets", h(async (_req, res) => {
  res.json(await facets());
}));

/** Create an archive item manually (JSON). For photo-first creation see POST /api/listings/drafts. */
archiveRouter.post("/", h(async (req, res) => {
  const item = await createItem(itemInput.parse(req.body));
  if (item.price_cents) await confirmPrice(item.id, item.price_cents, "manual");
  else await refreshSuggestion(item.id);
  res.status(201).json(await getItem(item.id));
}));

archiveRouter.get("/:id", h(async (req, res) => {
  res.json(await itemDetail(idParam(req)));
}));

archiveRouter.patch("/:id", h(async (req, res) => {
  const id = idParam(req);
  const patch = itemPatch.parse(req.body);
  const before = await getItem(id);
  const item = await updateItem(id, patch);
  if (patch.price_cents && (patch.price_cents !== before.price_cents || !before.price_confirmed)) await confirmPrice(id, patch.price_cents, "manual");
  else if (!before.price_confirmed) await refreshSuggestion(id);
  res.json(await getItem(item.id));
}));

archiveRouter.delete("/:id", h(async (req, res) => {
  await deleteItem(idParam(req));
  res.status(204).end();
}));

// ---------- photos ----------

archiveRouter.post("/:id/photos", upload.array("photos", 20), h(async (req, res) => {
  const id = idParam(req);
  await getItem(id);
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (!files.length) throw new HttpError(400, "Keine Fotos hochgeladen (Feld 'photos')");
  const added = [];
  for (const f of files) added.push(await addPhoto(id, await storePhoto(f.buffer), f.originalname));
  await db.run("UPDATE items SET updated_at = ? WHERE id = ?", [nowIso(), id]);
  res.status(201).json(added);
}));

/** All photos of an item as ZIP, in listing order (01.jpg, 02.jpg, …) – for manual upload to Vinted. */
archiveRouter.get("/:id/photos.zip", h(async (req, res) => {
  const id = idParam(req);
  const item = await getItem(id);
  const photos = (await listPhotos(id)).slice(0, 20);
  if (!photos.length) throw new HttpError(404, "Keine Fotos vorhanden");
  const zip = createZip(photos.map((p, i) => ({ name: `${String(i + 1).padStart(2, "0")}.jpg`, data: fs.readFileSync(photoPath(p.file_name)) })));
  const safe = item.title.replace(/[^\p{L}\p{N} _-]+/gu, "").trim().slice(0, 60) || `artikel-${id}`;
  res.setHeader("content-type", "application/zip");
  res.setHeader("content-disposition", `attachment; filename="${encodeURIComponent(safe)}.zip"; filename*=UTF-8''${encodeURIComponent(safe)}.zip`);
  res.send(zip);
}));

archiveRouter.put("/:id/photos/order", h(async (req, res) => {
  const id = idParam(req);
  const { ids } = z.object({ ids: z.array(z.number().int()) }).parse(req.body);
  await reorderPhotos(id, ids);
  res.json(await listPhotos(id));
}));

archiveRouter.delete("/:id/photos/:photoId", h(async (req, res) => {
  await deletePhoto(idParam(req), idParam(req, "photoId"));
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
archiveRouter.post("/:id/reupload", h(async (req, res) => {
  const id = idParam(req);
  const input = reuploadInput.parse(req.body);
  if (input.priceCents !== undefined) {
    await db.run("UPDATE items SET price_cents = ?, updated_at = ? WHERE id = ?", [input.priceCents, nowIso(), id]);
  }
  const [entry] = await enqueue({ itemIds: [id], accountId: input.accountId, startAt: input.scheduledAt }, true);
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
archiveRouter.post("/:id/listings", h(async (req, res) => {
  const id = idParam(req);
  const input = manualListingInput.parse(req.body);
  const item = await getItem(id);
  await getAccount(input.accountId);
  const vintedItemId = input.vintedItemId ?? input.url?.match(/\/items\/(\d+)/)?.[1] ?? null;
  const listing = await createListing({
    item_id: id, account_id: input.accountId, vinted_item_id: vintedItemId, url: input.url ?? null, title: item.title,
    description: item.description, price_cents: input.priceCents ?? item.price_cents, currency: item.currency, listed_at: input.listedAt,
  });
  // Posted with this price → it is the seller's price now (and a learning example).
  if (listing.price_cents && !(await getItem(id)).price_confirmed) await confirmPrice(id, listing.price_cents, "confirmed");
  // Close a pending queue entry for this item/account, if any.
  await db.run("UPDATE publish_queue SET status = 'done', listing_id = ?, updated_at = ? WHERE item_id = ? AND account_id = ? AND status IN ('pending','failed')",
    [listing.id, nowIso(), id, input.accountId]);
  res.status(201).json(listing);
}));

const listingUpdate = z.object({
  status: z.enum(["sold", "removed", "expired", "hidden"]).optional(),
  soldAt: z.string().datetime({ offset: true }).optional(),
  soldPriceCents: z.number().int().min(0).optional(),
  priceCents: z.number().int().min(0).optional(),
});

archiveRouter.patch("/:id/listings/:listingId", h(async (req, res) => {
  const itemId = idParam(req);
  const listing = await getListing(idParam(req, "listingId"));
  if (listing.item_id !== itemId) throw new HttpError(404, "Listing gehört nicht zu diesem Artikel");
  const input = listingUpdate.parse(req.body);
  if (input.priceCents !== undefined) await setListingPrice(listing.id, input.priceCents, "Manuell");
  if (input.status === "sold") {
    const soldAt = input.soldAt ?? nowIso();
    const price = input.soldPriceCents ?? listing.price_cents ?? 0;
    await markListingSold(listing.id, soldAt, price);
    const item = await getItem(itemId);
    await db.run(`INSERT INTO sales (account_id, listing_id, item_id, external_id, title, price_cents, currency, category, brand, sold_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [listing.account_id, listing.id, itemId, `manual:${listing.id}`, listing.title, price, listing.currency, item.category, item.brand, soldAt]);
  } else if (input.status) {
    await endListing(listing.id, input.status);
  }
  res.json(await getListing(listing.id));
}));
