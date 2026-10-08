import { Router } from "express";
import { h, idParam } from "../../lib/http.js";
import { findDuplicates } from "../duplicates/service.js";
import { batchInput, getReuploadStatus, reuploadListing, startBatchReupload, stopBatchReupload } from "./service.js";

export const reuploadRouter = Router();

/** ♻️ Several listings: delete all on Vinted, then prepare them again (live progress via /reupload/status). */
reuploadRouter.post("/reupload", h(async (req, res) => {
  res.json(await startBatchReupload(batchInput.parse(req.body).listingIds));
}));

reuploadRouter.get("/reupload/status", (_req, res) => {
  res.json(getReuploadStatus());
});

reuploadRouter.post("/reupload/stop", (_req, res) => {
  stopBatchReupload();
  res.json(getReuploadStatus());
});

/** ♻️ Re-Upload: delete on Vinted, then prepare it again with fresh texts. */
reuploadRouter.post("/reupload/:listingId", h(async (req, res) => {
  res.json(await reuploadListing(idParam(req, "listingId")));
}));

/** Articles that are online more than once on the same account. */
reuploadRouter.get("/duplicates", h(async (_req, res) => {
  res.json(await findDuplicates());
}));
