import { Router } from "express";
import { db } from "../../db/index.js";
import { env } from "../../config/env.js";
import { h, HttpError, idParam } from "../../lib/http.js";
import { importChromeLogin } from "./chromeLogin.js";
import { startVintedChromes } from "./chromeLaunch.js";
import { reconcileWithProfile } from "./profileScan.js";
import {
  accountInput, accountPatch, createAccount, deleteAccount, disconnectAccount, getAccount, listAccounts, toPublic, updateAccount, VINTED_DOMAINS,
} from "./repo.js";
import { syncAccount } from "./sync.js";

export const accountsRouter = Router();

accountsRouter.get("/domains", (_req, res) => {
  res.json(VINTED_DOMAINS);
});

accountsRouter.get("/", h(async (_req, res) => {
  res.json((await listAccounts()).map(toPublic));
}));

accountsRouter.post("/", h(async (req, res) => {
  const account = await createAccount(accountInput.parse(req.body));
  let sync = null;
  let error: string | null = null;
  if (account.session_encrypted) {
    try {
      sync = await syncAccount(account.id);
    } catch (e) {
      error = (e as Error).message;
    }
  }
  res.status(201).json({ account: toPublic(await getAccount(account.id)), sync, error });
}));

accountsRouter.get("/:id", h(async (req, res) => {
  const id = idParam(req);
  const account = toPublic(await getAccount(id));
  const listings = await db.all(`
    SELECT l.*, (SELECT file_name FROM item_photos p WHERE p.item_id = l.item_id ORDER BY position, id LIMIT 1) AS cover_photo
    FROM listings l WHERE l.account_id = ? AND l.status = 'active' ORDER BY l.listed_at DESC
  `, [id]);
  const recentSales = await db.all("SELECT * FROM sales WHERE account_id = ? ORDER BY sold_at DESC LIMIT 20", [id]);
  const recentEvents = await db.all("SELECT * FROM vinted_events WHERE account_id = ? ORDER BY occurred_at DESC LIMIT 30", [id]);
  const totals = await db.get("SELECT COUNT(*) sales, COALESCE(SUM(price_cents), 0) revenue_cents FROM sales WHERE account_id = ?", [id]);
  const queue = await db.get<{ c: number }>("SELECT COUNT(*) c FROM publish_queue WHERE account_id = ? AND status = 'pending'", [id]);
  res.json({ account, listings, recentSales, recentEvents, totals, queuedCount: Number(queue?.c ?? 0) });
}));

accountsRouter.patch("/:id", h(async (req, res) => {
  const id = idParam(req);
  const patch = accountPatch.parse(req.body);
  await updateAccount(id, patch);
  let error: string | null = null;
  if (patch.sessionToken || patch.refreshToken) {
    try {
      await syncAccount(id);
    } catch (e) {
      error = (e as Error).message;
    }
  }
  res.json({ account: toPublic(await getAccount(id)), error });
}));

/** Verifies the session and syncs listings, sales, favourites and messages. */
/** "Was ist wirklich online?" – checks every connected account's Vinted profile in the Vinted-Chrome. */
accountsRouter.post("/reconcile", h(async (_req, res) => {
  const accounts = await db.all<{ id: number; name: string }>("SELECT id, name FROM accounts WHERE status = 'connected' AND vinted_user_id IS NOT NULL ORDER BY id");
  if (!accounts.length) throw new HttpError(400, "Kein verbundener Vinted-Account");
  const results = [];
  for (const a of accounts) {
    try {
      results.push({ account: a.name, ...(await reconcileWithProfile(a.id)) });
    } catch (e) {
      results.push({ account: a.name, error: (e as Error).message });
    }
  }
  res.json({ results });
}));

/** Local dashboard: starts the Vinted-Chrome(s) that aren't running (also done at dashboard start). */
accountsRouter.post("/chrome/start", h(async (_req, res) => {
  if (env.appMode === "cloud") throw new HttpError(400, "In der Cloud-Version startet der PC-Helfer Chrome.");
  res.json({ log: await startVintedChromes() });
}));

/** Local dashboard: takes the login from the Vinted-Chrome and syncs right away. */
accountsRouter.post("/:id/chrome-login", h(async (req, res) => {
  if (env.appMode === "cloud") throw new HttpError(400, "In der Cloud-Version übernimmt der PC-Helfer den Login („Mit PC-Helfer verbinden“).");
  const id = idParam(req);
  await importChromeLogin(id);
  let error: string | null = null;
  try {
    await syncAccount(id);
  } catch (e) {
    error = (e as Error).message;
  }
  res.json({ account: toPublic(await getAccount(id)), error });
}));

accountsRouter.post("/:id/sync", h(async (req, res) => {
  const id = idParam(req);
  const result = await syncAccount(id);
  res.json({ account: toPublic(await getAccount(id)), result });
}));

accountsRouter.post("/:id/disconnect", h(async (req, res) => {
  const id = idParam(req);
  await disconnectAccount(id);
  res.json(toPublic(await getAccount(id)));
}));

accountsRouter.delete("/:id", h(async (req, res) => {
  await deleteAccount(idParam(req));
  res.status(204).end();
}));
