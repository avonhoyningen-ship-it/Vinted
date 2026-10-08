import { Router } from "express";
import { h, idParam } from "../../lib/http.js";
import { findDuplicates } from "../duplicates/service.js";
import { reuploadListing } from "./service.js";

export const reuploadRouter = Router();

/** ♻️ Re-Upload: delete on Vinted, then prepare it again with fresh texts. */
reuploadRouter.post("/reupload/:listingId", h(async (req, res) => {
  res.json(await reuploadListing(idParam(req, "listingId")));
}));

/** Articles that are online more than once on the same account. */
reuploadRouter.get("/duplicates", h(async (_req, res) => {
  res.json(await findDuplicates());
}));
