import { Router } from "express";
import { z } from "zod";
import { db } from "../../db/index.js";
import { h, idParam, notFound } from "../../lib/http.js";
import { confirmPrice, refreshAllSuggestions, refreshSuggestion, ruleInput, type PriceRule } from "./engine.js";

export const pricingRouter = Router();

const ids = z.array(z.number().int().positive()).min(1).max(500);

/** Same price for several items at once – each one becomes a learning example. */
pricingRouter.post("/bulk", h((req, res) => {
  const { itemIds, priceCents } = z.object({ itemIds: ids, priceCents: z.number().int().min(50).max(10_000_000) }).parse(req.body);
  db.transaction(() => itemIds.forEach((id) => confirmPrice(id, priceCents, "bulk")))();
  const refreshed = refreshAllSuggestions();
  res.json({ updated: itemIds.length, refreshed });
}));

/** ✓ – accept the suggested price for the given items. */
pricingRouter.post("/accept", h((req, res) => {
  const { itemIds } = z.object({ itemIds: ids }).parse(req.body);
  let accepted = 0;
  db.transaction(() => {
    for (const id of itemIds) {
      const row = db.prepare("SELECT price_suggested_cents p FROM items WHERE id = ?").get(id) as { p: number | null } | undefined;
      if (row?.p) { confirmPrice(id, Number(row.p), "confirmed"); accepted++; }
    }
  })();
  refreshAllSuggestions();
  res.json({ accepted });
}));

pricingRouter.post("/suggest/:id", h((req, res) => {
  res.json(refreshSuggestion(idParam(req)));
}));

pricingRouter.post("/refresh", h((_req, res) => {
  res.json({ refreshed: refreshAllSuggestions() });
}));

// ---------- rules ----------

pricingRouter.get("/rules", h((_req, res) => {
  res.json(db.prepare("SELECT * FROM price_rules ORDER BY created_at DESC").all());
}));

pricingRouter.post("/rules", h((req, res) => {
  const r = ruleInput.parse(req.body);
  const out = db.prepare("INSERT INTO price_rules (brand, category, keyword, price_cents, note) VALUES (?, ?, ?, ?, ?)")
    .run(r.brand || null, r.category || null, r.keyword || null, r.price_cents, r.note || null);
  refreshAllSuggestions();
  res.status(201).json(db.prepare("SELECT * FROM price_rules WHERE id = ?").get(out.lastInsertRowid));
}));

pricingRouter.put("/rules/:id", h((req, res) => {
  const id = idParam(req);
  const r = ruleInput.parse(req.body);
  const out = db.prepare("UPDATE price_rules SET brand = ?, category = ?, keyword = ?, price_cents = ?, note = ? WHERE id = ?")
    .run(r.brand || null, r.category || null, r.keyword || null, r.price_cents, r.note || null, id);
  if (!out.changes) throw notFound("Regel");
  refreshAllSuggestions();
  res.json(db.prepare("SELECT * FROM price_rules WHERE id = ?").get(id) as unknown as PriceRule);
}));

pricingRouter.delete("/rules/:id", h((req, res) => {
  if (!db.prepare("DELETE FROM price_rules WHERE id = ?").run(idParam(req)).changes) throw notFound("Regel");
  refreshAllSuggestions();
  res.status(204).end();
}));

// ---------- learned examples ----------

pricingRouter.get("/examples", h((_req, res) => {
  res.json(db.prepare("SELECT * FROM price_examples ORDER BY created_at DESC LIMIT 500").all());
}));

pricingRouter.delete("/examples/:id", h((req, res) => {
  if (!db.prepare("DELETE FROM price_examples WHERE id = ?").run(idParam(req)).changes) throw notFound("Preis");
  refreshAllSuggestions();
  res.status(204).end();
}));
