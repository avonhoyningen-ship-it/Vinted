import { Router } from "express";
import { z } from "zod";
import { db } from "../../db/index.js";
import { h, idParam, notFound } from "../../lib/http.js";
import { confirmPrice, refreshAllSuggestions, refreshSuggestion, ruleInput, type PriceRule } from "./engine.js";

export const pricingRouter = Router();

const ids = z.array(z.number().int().positive()).min(1).max(500);

/** Same price for several items at once – each one becomes a learning example. */
pricingRouter.post("/bulk", h(async (req, res) => {
  const { itemIds, priceCents } = z.object({ itemIds: ids, priceCents: z.number().int().min(50).max(10_000_000) }).parse(req.body);
  await db.tx(async () => {
    for (const id of itemIds) await confirmPrice(id, priceCents, "bulk");
  });
  const refreshed = await refreshAllSuggestions();
  res.json({ updated: itemIds.length, refreshed });
}));

/** ✓ – accept the suggested price for the given items. */
pricingRouter.post("/accept", h(async (req, res) => {
  const { itemIds } = z.object({ itemIds: ids }).parse(req.body);
  let accepted = 0;
  await db.tx(async () => {
    for (const id of itemIds) {
      const row = await db.get<{ p: number | null }>("SELECT price_suggested_cents p FROM items WHERE id = ?", [id]);
      if (row?.p) { await confirmPrice(id, Number(row.p), "confirmed"); accepted++; }
    }
  });
  await refreshAllSuggestions();
  res.json({ accepted });
}));

pricingRouter.post("/suggest/:id", h(async (req, res) => {
  res.json(await refreshSuggestion(idParam(req)));
}));

pricingRouter.post("/refresh", h(async (_req, res) => {
  res.json({ refreshed: await refreshAllSuggestions() });
}));

// ---------- rules ----------

pricingRouter.get("/rules", h(async (_req, res) => {
  res.json(await db.all("SELECT * FROM price_rules ORDER BY created_at DESC"));
}));

pricingRouter.post("/rules", h(async (req, res) => {
  const r = ruleInput.parse(req.body);
  const id = await db.insert("INSERT INTO price_rules (brand, category, keyword, price_cents, note) VALUES (?, ?, ?, ?, ?)",
    [r.brand || null, r.category || null, r.keyword || null, r.price_cents, r.note || null]);
  await refreshAllSuggestions();
  res.status(201).json(await db.get("SELECT * FROM price_rules WHERE id = ?", [id]));
}));

pricingRouter.put("/rules/:id", h(async (req, res) => {
  const id = idParam(req);
  const r = ruleInput.parse(req.body);
  const changes = await db.run("UPDATE price_rules SET brand = ?, category = ?, keyword = ?, price_cents = ?, note = ? WHERE id = ?",
    [r.brand || null, r.category || null, r.keyword || null, r.price_cents, r.note || null, id]);
  if (!changes) throw notFound("Regel");
  await refreshAllSuggestions();
  res.json(await db.get<PriceRule>("SELECT * FROM price_rules WHERE id = ?", [id]));
}));

pricingRouter.delete("/rules/:id", h(async (req, res) => {
  if (!(await db.run("DELETE FROM price_rules WHERE id = ?", [idParam(req)]))) throw notFound("Regel");
  await refreshAllSuggestions();
  res.status(204).end();
}));

// ---------- learned examples ----------

pricingRouter.get("/examples", h(async (_req, res) => {
  res.json(await db.all("SELECT * FROM price_examples ORDER BY created_at DESC LIMIT 500"));
}));

pricingRouter.delete("/examples/:id", h(async (req, res) => {
  if (!(await db.run("DELETE FROM price_examples WHERE id = ?", [idParam(req)]))) throw notFound("Preis");
  await refreshAllSuggestions();
  res.status(204).end();
}));
