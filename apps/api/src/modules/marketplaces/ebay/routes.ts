import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { currentUserId, db, withUser } from "../../../db/index.js";
import { eventBus } from "../../../lib/eventBus.js";
import { h, HttpError } from "../../../lib/http.js";
import { authorizeUrl, exchangeCode, loadConfig, requireConfig, saveConfig, type EbayConfig } from "./client.js";
import { endOnEbay, listOnEbay, listPolicies } from "./service.js";

export const ebayRouter = Router();

/** Login states → user (the callback comes back without the dashboard's login header in the cloud). */
const states = new Map<string, { userId: string; at: number }>();

ebayRouter.get("/status", h(async (_req, res) => {
  const cfg = await loadConfig();
  res.json({
    configured: !!cfg?.clientId, connected: !!cfg?.refreshToken, sandbox: !!cfg?.sandbox,
    clientId: cfg?.clientId ?? "", ruName: cfg?.ruName ?? "", hasSecret: !!cfg?.clientSecret,
    refreshExpiresAt: cfg?.refreshExpiresAt ?? null, postalCode: cfg?.postalCode ?? "",
    fulfillmentPolicyId: cfg?.fulfillmentPolicyId ?? "", paymentPolicyId: cfg?.paymentPolicyId ?? "", returnPolicyId: cfg?.returnPolicyId ?? "",
    autoList: cfg?.autoList ?? true, pricePercent: cfg?.pricePercent ?? 100,
  });
}));

/** Developer keys from developer.ebay.com (the secret is kept when left empty). */
ebayRouter.put("/config", h(async (req, res) => {
  const b = z.object({ clientId: z.string().trim().min(5), clientSecret: z.string().trim().optional(), ruName: z.string().trim().min(3), sandbox: z.boolean().default(false) }).parse(req.body);
  const old = await loadConfig();
  const secret = b.clientSecret || old?.clientSecret;
  if (!secret) throw new HttpError(400, "Cert ID (Client Secret) fehlt");
  const changedKeys = !old || old.clientId !== b.clientId || old.sandbox !== b.sandbox;
  await saveConfig({
    ...(old ?? {}), clientId: b.clientId, clientSecret: secret, ruName: b.ruName, sandbox: b.sandbox,
    ...(changedKeys ? { refreshToken: null, accessToken: null, locationReady: false } : {}),
  } as EbayConfig);
  res.json({ ok: true });
}));

ebayRouter.put("/settings", h(async (req, res) => {
  const b = z.object({
    postalCode: z.string().trim().regex(/^\d{5}$/, "Postleitzahl: 5 Ziffern").optional(),
    fulfillmentPolicyId: z.string().optional(), paymentPolicyId: z.string().optional(), returnPolicyId: z.string().optional(),
    autoList: z.boolean().optional(), pricePercent: z.number().int().min(50).max(200).optional(),
  }).parse(req.body);
  const cfg = await requireConfig();
  await saveConfig({ ...cfg, ...b, ...(b.postalCode && b.postalCode !== cfg.postalCode ? { locationReady: false } : {}) });
  res.json({ ok: true });
}));

/** Step 1: eBay's login page. */
ebayRouter.get("/connect", h(async (_req, res) => {
  const cfg = await requireConfig();
  const state = crypto.randomBytes(16).toString("hex");
  states.set(state, { userId: currentUserId(), at: Date.now() });
  res.json({ url: authorizeUrl(cfg, state) });
}));

/** Step 2 (if eBay doesn't redirect back): the seller pastes the address/code shown after logging in. */
ebayRouter.post("/code", h(async (req, res) => {
  const { code } = z.object({ code: z.string().min(5) }).parse(req.body);
  await saveConfig(await exchangeCode(await requireConfig(), code));
  res.json({ ok: true });
}));

ebayRouter.post("/disconnect", h(async (_req, res) => {
  const cfg = await requireConfig();
  await saveConfig({ ...cfg, refreshToken: null, accessToken: null, accessExpiresAt: null });
  res.json({ ok: true });
}));

ebayRouter.get("/policies", h(async (_req, res) => {
  res.json(await listPolicies());
}));

ebayRouter.get("/listings", h(async (_req, res) => {
  res.json(await db.all(`SELECT m.*, i.title FROM marketplace_listings m JOIN items i ON i.id = m.item_id
    WHERE m.platform = 'ebay' ORDER BY m.listed_at DESC LIMIT 500`));
}));

/** Puts articles on eBay one after another (progress as live events). */
ebayRouter.post("/list", h(async (req, res) => {
  const { itemIds } = z.object({ itemIds: z.array(z.number().int().positive()).min(1).max(200) }).parse(req.body);
  await requireConfig();
  // Runs on in the background (the request's user scope carries over).
  void (async () => {
    let ok = 0;
    for (const id of itemIds) {
      try { await listOnEbay(id); ok++; } catch { /* reported per item as event */ }
    }
    eventBus.publish({ type: "marketplace", platform: "eBay", itemId: 0, title: "", state: "listed", url: null, message: `${ok} von ${itemIds.length} auf eBay eingestellt` });
  })();
  res.json({ queued: itemIds.length });
}));

ebayRouter.post("/end/:itemId", h(async (req, res) => {
  res.json({ ended: await endOnEbay(Number(req.params.itemId), "manual") });
}));

/** eBay sends the browser back here after the login (public: identified by the login state). */
export const ebayCallbackRouter = Router();
ebayCallbackRouter.get("/ebay/callback", h(async (req, res) => {
  const state = String(req.query.state ?? "");
  const entry = states.get(state);
  states.delete(state);
  const back = (q: string) => res.redirect(`/settings?ebay=${q}`);
  if (!entry || Date.now() - entry.at > 30 * 60_000) return back("abgelaufen");
  if (req.query.error || !req.query.code) return back("abgebrochen");
  await withUser(entry.userId, async () => saveConfig(await exchangeCode(await requireConfig(), String(req.query.code))));
  back("ok");
}));
