import { Router } from "express";
import { h } from "../../lib/http.js";
import { autoFavouriteOffers, autoReplyOffers, offerStatus, startDeepRun } from "./service.js";

export const offersRouter = Router();

/** Switches and the last things the automatic offers did. */
offersRouter.get("/status", h(async (_req, res) => {
  res.json(await offerStatus());
}));

/** Runs both automatic offer jobs now instead of waiting for the next round. */
offersRouter.post("/run", h(async (_req, res) => {
  const replied = await autoReplyOffers();
  const favourites = await autoFavouriteOffers();
  res.json({ replied, favourites, ...(await offerStatus()) });
}));

/** Works through old favourites and old open offers in the background. */
offersRouter.post("/run-old", h(async (_req, res) => {
  const started = startDeepRun();
  res.json({ started, ...(await offerStatus()) });
}));
