import { Router } from "express";
import { z } from "zod";
import { db } from "../../db/index.js";
import { h, HttpError, idParam } from "../../lib/http.js";
import { PLACEHOLDERS, renderTemplate } from "../../lib/placeholders.js";
import { ACTIONS, getRule, ruleInput, ruleToApi, saveRule, templateVars, TRIGGERS, type RuleRow } from "./engine.js";

export const automationsRouter = Router();

automationsRouter.get("/meta", (_req, res) => {
  res.json({ triggers: TRIGGERS, actions: ACTIONS, placeholders: PLACEHOLDERS });
});

automationsRouter.get("/rules", h((_req, res) => {
  const rules = db.prepare("SELECT * FROM automation_rules ORDER BY created_at DESC").all() as RuleRow[];
  const stats = db.prepare("SELECT rule_id, status, COUNT(*) n FROM scheduled_actions GROUP BY rule_id, status").all() as { rule_id: number; status: string; n: number }[];
  res.json(rules.map((r) => ({
    ...ruleToApi(r),
    stats: Object.fromEntries(stats.filter((s) => s.rule_id === r.id).map((s) => [s.status, s.n])),
  })));
}));

automationsRouter.post("/rules", h((req, res) => {
  res.status(201).json(ruleToApi(saveRule(ruleInput.parse(req.body))));
}));

automationsRouter.put("/rules/:id", h((req, res) => {
  res.json(ruleToApi(saveRule(ruleInput.parse(req.body), idParam(req))));
}));

automationsRouter.post("/rules/:id/toggle", h((req, res) => {
  const r = getRule(idParam(req));
  db.prepare("UPDATE automation_rules SET enabled = ? WHERE id = ?").run(r.enabled ? 0 : 1, r.id);
  if (r.enabled) db.prepare("UPDATE scheduled_actions SET status = 'cancelled' WHERE rule_id = ? AND status = 'pending'").run(r.id);
  res.json(ruleToApi(getRule(r.id)));
}));

automationsRouter.delete("/rules/:id", h((req, res) => {
  const id = idParam(req);
  getRule(id);
  db.prepare("UPDATE scheduled_actions SET status = 'cancelled' WHERE rule_id = ? AND status = 'pending'").run(id);
  db.prepare("DELETE FROM automation_rules WHERE id = ?").run(id);
  res.status(204).end();
}));

/** Renders a message template against a real listing (or sample data). */
automationsRouter.post("/preview", h((req, res) => {
  const { template, listingId, accountId } = z.object({
    template: z.string().max(1000), listingId: z.number().int().positive().optional(), accountId: z.number().int().positive().optional(),
  }).parse(req.body);
  const vars = accountId
    ? templateVars(listingId ?? null, accountId, "max_mustermann", undefined)
    : { artikelname: "Levi's 501 Jeans W32", preis: "25,00 €", neuer_preis: "22,50 €", marke: "Levi's", groesse: "W32", nutzer: "max_mustermann", account: "Mein Shop" };
  res.json({ text: renderTemplate(template, vars) });
}));

automationsRouter.get("/actions", h((req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : null;
  res.json(db.prepare(`
    SELECT s.*, r.name AS rule_name, a.name AS account_name, l.title AS listing_title
    FROM scheduled_actions s
    LEFT JOIN automation_rules r ON r.id = s.rule_id
    JOIN accounts a ON a.id = s.account_id
    LEFT JOIN listings l ON l.id = s.listing_id
    WHERE (@status IS NULL OR s.status = @status)
    ORDER BY CASE s.status WHEN 'pending' THEN 0 ELSE 1 END, COALESCE(s.executed_at, s.run_at) DESC
    LIMIT 300
  `).all({ status }));
}));

automationsRouter.post("/actions/:id/cancel", h((req, res) => {
  const r = db.prepare("UPDATE scheduled_actions SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(idParam(req));
  if (!r.changes) throw new HttpError(409, "Aktion ist nicht mehr ausstehend");
  res.status(204).end();
}));
