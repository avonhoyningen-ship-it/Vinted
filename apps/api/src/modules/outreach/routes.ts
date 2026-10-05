import { Router } from "express";
import { z } from "zod";
import { h } from "../../lib/http.js";
import { DEFAULT_TEXTS, getOutreachStatus, planOutreach, startInput, startOutreach, stopOutreach } from "./service.js";

export const outreachRouter = Router();

/** Who would get the message (with default text): ?kind=purchases|favourites&percent=10 */
outreachRouter.get("/preview", h(async (req, res) => {
  const { kind, percent } = z.object({ kind: z.enum(["purchases", "favourites"]), percent: z.coerce.number().int().min(1).max(80).default(10) }).parse(req.query);
  res.json({ ...(await planOutreach(kind, percent)), defaultText: DEFAULT_TEXTS[kind] });
}));

outreachRouter.post("/start", h(async (req, res) => {
  res.json(await startOutreach(startInput.parse(req.body)));
}));

outreachRouter.get("/status", (_req, res) => {
  res.json(getOutreachStatus());
});

outreachRouter.post("/stop", (_req, res) => {
  stopOutreach();
  res.json(getOutreachStatus());
});
