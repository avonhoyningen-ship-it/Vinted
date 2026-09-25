import fs from "node:fs";
import { Router } from "express";
import { z } from "zod";
import { env } from "../../config/env.js";
import { currentUserId, db } from "../../db/index.js";
import { eventBus, type DashboardEvent } from "../../lib/eventBus.js";
import { h, HttpError } from "../../lib/http.js";
import { applyBrandRules } from "../listings/brandRules.js";
import { DEFAULT_SETTINGS, getSettings, setSettings } from "../../lib/settings.js";
import { photoPath } from "../../storage/photos.js";
import { aiEnabled } from "../listings/ai.js";
import { vintedClient } from "../../vinted/vintedClient.js";
import { pollAccounts } from "../../workers/scheduler.js";

export const systemRouter = Router();

systemRouter.get("/health", (_req, res) => {
  res.json({ ok: true });
});

systemRouter.get("/info", (_req, res) => {
  res.json({
    aiEnabled: aiEnabled(),
    canPublish: vintedClient.canPublish,
    aiModel: env.anthropicModel,
    pollIntervalMinutes: env.pollIntervalMinutes,
    publishIntervalMinutes: env.publishIntervalMinutes,
  });
});

systemRouter.get("/settings", h(async (_req, res) => {
  res.json(await getSettings());
}));

systemRouter.get("/settings/defaults", (_req, res) => {
  res.json(DEFAULT_SETTINGS);
});

systemRouter.put("/settings", h(async (req, res) => {
  const body = z.record(z.string(), z.unknown()).parse(req.body);
  for (const k of Object.keys(body)) if (!(k in DEFAULT_SETTINGS)) throw new HttpError(400, `Unbekannte Einstellung ${k}`);
  let saved;
  try {
    saved = await setSettings(body);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  if ("brand.rules" in body || "parcel.rules" in body) await applyBrandRules();
  res.json(saved);
}));

systemRouter.post("/poll-now", h(async (_req, res) => {
  await pollAccounts(true);
  res.json({ ok: true });
}));

/** Server-Sent Events stream for live notifications (sales, favourites, ...). */
systemRouter.get("/events/stream", (req, res) => {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write("retry: 5000\n\n");
  const viewer = currentUserId();
  const send = (e: DashboardEvent, userId: string) => {
    if (userId === viewer) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  };
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  eventBus.on("event", send);
  req.on("close", () => {
    clearInterval(ping);
    eventBus.off("event", send);
  });
});

systemRouter.get("/photos/:file", (req, res) => {
  const file = photoPath(req.params.file);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.setHeader("cache-control", "private, max-age=31536000, immutable");
  res.sendFile(file);
});

systemRouter.get("/dashboard", h(async (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 7) + "-01";
  // COUNT/SUM come back as strings from Postgres: normalize numbers.
  const q = async (sql: string, p: unknown[] = []) => {
    const row = (await db.get(sql, p)) ?? {};
    return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : v === null && k !== "next_at" ? 0 : v]));
  };
  const count = async (sql: string) => Number((await q(sql)).c ?? 0);
  res.json({
    accounts: await q("SELECT COUNT(*) total, SUM(CASE WHEN status = 'connected' THEN 1 ELSE 0 END) connected, SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) errors FROM accounts"),
    today: await q("SELECT COUNT(*) sales, COALESCE(SUM(price_cents), 0) revenue_cents FROM sales WHERE sold_at >= ?", [today]),
    month: await q("SELECT COUNT(*) sales, COALESCE(SUM(price_cents), 0) revenue_cents FROM sales WHERE sold_at >= ?", [monthStart]),
    activeListings: await count("SELECT COUNT(*) c FROM listings WHERE status = 'active'"),
    queue: await q("SELECT COUNT(*) pending, MIN(scheduled_at) next_at FROM publish_queue WHERE status = 'pending'"),
    failedQueue: await count("SELECT COUNT(*) c FROM publish_queue WHERE status = 'failed'"),
    pendingActions: await count("SELECT COUNT(*) c FROM scheduled_actions WHERE status = 'pending'"),
    drafts: await count("SELECT COUNT(*) c FROM items WHERE status = 'draft'"),
    archiveTotal: await count("SELECT COUNT(*) c FROM items"),
    recentEvents: await db.all(`SELECT e.type, e.vinted_username, e.occurred_at, e.payload, a.name account_name, l.title
      FROM vinted_events e JOIN accounts a ON a.id = e.account_id LEFT JOIN listings l ON l.id = e.listing_id
      ORDER BY e.occurred_at DESC LIMIT 15`),
  });
}));
