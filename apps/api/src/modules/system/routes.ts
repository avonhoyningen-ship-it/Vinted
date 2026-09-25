import fs from "node:fs";
import type { SQLInputValue } from "node:sqlite";
import { Router } from "express";
import { z } from "zod";
import { env } from "../../config/env.js";
import { db } from "../../db/index.js";
import { eventBus, type DashboardEvent } from "../../lib/eventBus.js";
import { h, HttpError } from "../../lib/http.js";
import { DEFAULT_SETTINGS, getSettings, setSettings } from "../../lib/settings.js";
import { photoPath } from "../../storage/photos.js";
import { aiEnabled } from "../listings/ai.js";
import { pollAccounts } from "../../workers/scheduler.js";

export const systemRouter = Router();

systemRouter.get("/health", (_req, res) => {
  res.json({ ok: true });
});

systemRouter.get("/info", (_req, res) => {
  res.json({
    aiEnabled: aiEnabled(),
    aiModel: env.anthropicModel,
    pollIntervalMinutes: env.pollIntervalMinutes,
    publishIntervalMinutes: env.publishIntervalMinutes,
  });
});

systemRouter.get("/settings", (_req, res) => {
  res.json(getSettings());
});

systemRouter.put("/settings", h((req, res) => {
  const body = z.record(z.string(), z.unknown()).parse(req.body);
  for (const k of Object.keys(body)) if (!(k in DEFAULT_SETTINGS)) throw new HttpError(400, `Unbekannte Einstellung ${k}`);
  try {
    res.json(setSettings(body));
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
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
  const send = (e: DashboardEvent) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
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

systemRouter.get("/dashboard", h((_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 7) + "-01";
  const q = (sql: string, ...p: SQLInputValue[]) => db.prepare(sql).get(...p);
  res.json({
    accounts: q("SELECT COUNT(*) total, SUM(status = 'connected') connected, SUM(status = 'error') errors FROM accounts"),
    today: q("SELECT COUNT(*) sales, COALESCE(SUM(price_cents), 0) revenue_cents FROM sales WHERE sold_at >= ?", today),
    month: q("SELECT COUNT(*) sales, COALESCE(SUM(price_cents), 0) revenue_cents FROM sales WHERE sold_at >= ?", monthStart),
    activeListings: (q("SELECT COUNT(*) c FROM listings WHERE status = 'active'") as { c: number }).c,
    queue: q("SELECT COUNT(*) pending, MIN(scheduled_at) next_at FROM publish_queue WHERE status = 'pending'"),
    failedQueue: (q("SELECT COUNT(*) c FROM publish_queue WHERE status = 'failed'") as { c: number }).c,
    pendingActions: (q("SELECT COUNT(*) c FROM scheduled_actions WHERE status = 'pending'") as { c: number }).c,
    drafts: (q("SELECT COUNT(*) c FROM items WHERE status = 'draft'") as { c: number }).c,
    archiveTotal: (q("SELECT COUNT(*) c FROM items") as { c: number }).c,
    recentEvents: db.prepare(`SELECT e.type, e.vinted_username, e.occurred_at, e.payload, a.name account_name, l.title
      FROM vinted_events e JOIN accounts a ON a.id = e.account_id LEFT JOIN listings l ON l.id = e.listing_id
      ORDER BY e.occurred_at DESC LIMIT 15`).all(),
  });
}));
