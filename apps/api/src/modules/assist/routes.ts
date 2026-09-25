import { Router } from "express";
import { z } from "zod";
import { h } from "../../lib/http.js";
import { getAssistStatus, skipAssist, startAssist, stopAssist } from "./assistant.js";

export const assistRouter = Router();

assistRouter.get("/status", (_req, res) => {
  res.json(getAssistStatus());
});

assistRouter.post("/start", h(async (req, res) => {
  const { itemIds, accountId } = z.object({
    itemIds: z.array(z.number().int().positive()).min(1).max(200),
    accountId: z.number().int().positive(),
  }).parse(req.body);
  res.json(await startAssist(itemIds, accountId));
}));

assistRouter.post("/skip", (req, res) => {
  const itemId = Number(req.body?.itemId);
  skipAssist(Number.isInteger(itemId) && itemId > 0 ? itemId : undefined);
  res.json(getAssistStatus());
});

assistRouter.post("/stop", (_req, res) => {
  stopAssist();
  res.json(getAssistStatus());
});
