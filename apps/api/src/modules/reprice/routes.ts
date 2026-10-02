import { Router } from "express";
import { h } from "../../lib/http.js";
import { getRepriceStatus, planReprice, repriceInput, startReprice, stopReprice } from "./service.js";

export const repriceRouter = Router();

/** Which listings would change, and to which price. */
repriceRouter.post("/preview", h(async (req, res) => {
  res.json(await planReprice(repriceInput.parse(req.body)));
}));

repriceRouter.post("/start", h(async (req, res) => {
  res.json(await startReprice(repriceInput.parse(req.body)));
}));

repriceRouter.get("/status", (_req, res) => {
  res.json(getRepriceStatus());
});

repriceRouter.post("/stop", (_req, res) => {
  stopReprice();
  res.json(getRepriceStatus());
});
