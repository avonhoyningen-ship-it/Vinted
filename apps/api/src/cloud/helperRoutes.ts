import express, { Router } from "express";
import { z } from "zod";
import { db, nowIso, withUser } from "../db/index.js";
import { eventBus, type AssistStatus } from "../lib/eventBus.js";
import { h, HttpError, idParam } from "../lib/http.js";
import { readPhoto } from "../storage/photos.js";
import { safeName } from "../storage/store.js";
import { chromeUrlFor, getAccount, toPublic } from "../modules/accounts/repo.js";
import { syncAccount } from "../modules/accounts/sync.js";
import { assistData, checkAssistItems, linkUploadedListing } from "../modules/assist/localSource.js";
import { completeJob, createHelperToken, helperStatus, pollJobs, runOnHelper, userForHelperToken } from "./helperHub.js";
import { getUser, hasAccess } from "./users.js";

// ---------- dashboard side (Clerk session) ----------

/** Pairing keys for the PC helper: create (shown once), list, revoke. */
export const helperTokensRouter = Router();

helperTokensRouter.get("/", h(async (_req, res) => {
  res.json({
    status: await helperStatus(),
    tokens: await db.all("SELECT id, name, last_seen_at, revoked_at, created_at FROM helper_tokens ORDER BY id DESC"),
  });
}));

helperTokensRouter.post("/", h(async (req, res) => {
  const { name } = z.object({ name: z.string().trim().min(1).max(80).default("Mein PC") }).parse(req.body ?? {});
  res.status(201).json(await createHelperToken(name));
}));

helperTokensRouter.delete("/:id", h(async (req, res) => {
  if (!(await db.run("UPDATE helper_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [nowIso(), idParam(req)]))) {
    throw new HttpError(404, "Schlüssel nicht gefunden");
  }
  res.status(204).end();
}));

/**
 * Connects a Vinted account through the helper: it reads the login of the
 * Vinted-Chrome on the user's PC and keeps it there. The cloud only stores a
 * marker ("via PC-Helfer") – never the token.
 */
export const HELPER_SESSION = "helper";
export async function connectAccountViaHelper(accountId: number) {
  const account = await getAccount(accountId);
  const r = await runOnHelper<{ hint: string }>("account.connect", { accountId, domain: account.domain, chromeUrl: chromeUrlFor(account) }, { timeoutMs: 60_000 });
  await db.run("UPDATE accounts SET session_encrypted = ?, refresh_encrypted = NULL, session_hint = ?, status = 'pending', last_error = NULL, updated_at = ? WHERE id = ?",
    [HELPER_SESSION, `PC-Helfer ${r.hint}`, nowIso(), accountId]);
  let error: string | null = null;
  try {
    await syncAccount(accountId);
  } catch (e) {
    error = (e as Error).message;
  }
  return { account: toPublic(await getAccount(accountId)), error };
}

/** Posting assistant in the cloud: the helper drives the Chrome on the user's PC. */
export const cloudAssistRouter = Router();
cloudAssistRouter.get("/status", h(async (_req, res) => {
  res.json(eventBus.lastAssist.get(res.locals.userId) ?? { state: "idle", itemId: null, title: null, position: 0, total: 0, filled: [], missing: [], message: null, done: [], fields: [], tabs: [] });
}));

cloudAssistRouter.post("/start", h(async (req, res) => {
  const { itemIds, accountId } = z.object({ itemIds: z.array(z.number().int().positive()).min(1).max(50), accountId: z.number().int().positive() }).parse(req.body);
  await checkAssistItems(itemIds, accountId);
  const items = [];
  for (const id of itemIds) items.push(await assistData(id, accountId));
  res.json(await runOnHelper("assist.start", { accountId, items }, { timeoutMs: 45_000 }));
}));

cloudAssistRouter.post("/skip", h(async (req, res) => {
  const itemId = Number(req.body?.itemId);
  res.json(await runOnHelper("assist.skip", { itemId: Number.isInteger(itemId) && itemId > 0 ? itemId : undefined }, { timeoutMs: 20_000 }));
}));

cloudAssistRouter.post("/stop", h(async (_req, res) => {
  res.json(await runOnHelper("assist.stop", {}, { timeoutMs: 20_000 }));
}));

// ---------- helper side (pairing key) ----------

export const helperRouter = Router();

helperRouter.use(async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  try {
    const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
    const who = await userForHelperToken(token);
    if (!who) return res.status(401).json({ error: "Ungültiger oder widerrufener Helfer-Schlüssel" });
    if (!hasAccess(await getUser(who.userId))) return res.status(402).json({ error: "Kein aktives Abo", code: "subscription_required" });
    res.locals.userId = who.userId;
    res.locals.tokenId = who.tokenId;
    withUser(who.userId, next);
  } catch (e) {
    next(e);
  }
});

helperRouter.get("/me", h(async (_req, res) => {
  const u = await getUser(res.locals.userId);
  res.json({ userId: res.locals.userId, email: u?.email ?? null });
}));

helperRouter.post("/poll", h(async (req, res) => {
  const abort = new AbortController();
  req.on("close", () => abort.abort());
  res.json({ jobs: await pollJobs(res.locals.tokenId, abort.signal) });
}));

helperRouter.post("/jobs/:id/result", h(async (req, res) => {
  const r = z.object({ ok: z.boolean(), result: z.unknown().optional(), error: z.string().max(2000).optional(), code: z.string().max(40).optional() }).parse(req.body);
  res.json({ accepted: await completeJob(idParam(req), r) });
}));

const helperEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("assist.status"), status: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("assist.linked"), itemId: z.number().int().positive(), accountId: z.number().int().positive(), url: z.string().url() }),
]);

/** Live updates from the helper (assistant progress, uploaded items). */
helperRouter.post("/events", h(async (req, res) => {
  const { events } = z.object({ events: z.array(helperEvent).max(50) }).parse(req.body);
  for (const e of events) {
    if (e.type === "assist.status") {
      eventBus.publish({ type: "assist", status: e.status as unknown as AssistStatus });
    } else {
      await getAccount(e.accountId);
      await linkUploadedListing({ itemId: e.itemId, accountId: e.accountId }, e.url);
    }
  }
  res.json({ ok: true });
}));

/** Photos for the assistant (from the user's own storage folder). */
helperRouter.get("/photos/:file", h(async (req, res) => {
  const data = await readPhoto(safeName(String(req.params.file))).catch(() => null);
  if (!data) throw new HttpError(404, "Foto nicht gefunden");
  res.setHeader("content-type", "image/jpeg");
  res.send(data);
}));
