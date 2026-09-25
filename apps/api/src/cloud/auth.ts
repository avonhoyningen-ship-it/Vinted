import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";
import { withUser } from "../db/index.js";
import { readCookie } from "../lib/auth.js";
import { ensureUser, getUser, hasAccess } from "./users.js";

/**
 * Cloud login: every request carries a Clerk session token (Authorization
 * header, the __session cookie, or ?token= for the live event stream). The
 * verified Clerk user id becomes the database scope of the whole request.
 */

export interface VerifiedUser { userId: string; email: string | null }
type Verifier = (token: string) => Promise<VerifiedUser>;

async function clerkVerifier(token: string): Promise<VerifiedUser> {
  const { verifyToken } = await import("@clerk/backend");
  const authorizedParties = env.appUrl ? [new URL(env.appUrl).origin] : undefined;
  const r = (await verifyToken(token, {
    ...(env.clerkJwtKey ? { jwtKey: env.clerkJwtKey } : { secretKey: env.clerkSecretKey ?? undefined }),
    authorizedParties,
  })) as unknown as { sub?: string; email?: string; data?: { sub: string; email?: string }; errors?: Error[] };
  const payload = r.sub ? r : r.data;
  if (!payload?.sub) throw r.errors?.[0] ?? new Error("invalid token");
  return { userId: payload.sub, email: payload.email ?? null };
}

let verifier: Verifier = clerkVerifier;
/** Tests replace the Clerk check. */
export function setTokenVerifier(v: Verifier) {
  verifier = v;
}

function tokenOf(req: Request): string | null {
  const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) return bearer;
  const cookie = readCookie(req, "__session");
  if (cookie) return cookie;
  // EventSource can't send headers: short-lived token in the query, only for the stream.
  if (req.path === "/events/stream" && typeof req.query.token === "string") return req.query.token;
  return null;
}

/** Paths reachable without a Clerk session (webhooks and the PC helper authenticate themselves). */
const PUBLIC = [/^\/health$/, /^\/billing\/webhook$/, /^\/helper\//];
/** Paths a signed-in user may use without an active subscription. */
const NO_SUBSCRIPTION_NEEDED = [/^\/me$/, /^\/billing\//, /^\/info$/];

// Avoid a user upsert and status lookup on every single request.
const known = new Set<string>();
const accessCache = new Map<string, { ok: boolean; at: number }>();
export const forgetAccess = (userId: string) => accessCache.delete(userId);

async function checkAccess(userId: string): Promise<boolean> {
  const c = accessCache.get(userId);
  if (c && Date.now() - c.at < 15_000) return c.ok;
  const ok = hasAccess(await getUser(userId));
  accessCache.set(userId, { ok, at: Date.now() });
  return ok;
}

export async function cloudAuth(req: Request, res: Response, next: NextFunction) {
  if (PUBLIC.some((r) => r.test(req.path))) return next();
  const token = tokenOf(req);
  if (!token) return res.status(401).json({ error: "Nicht angemeldet" });
  let user: VerifiedUser;
  try {
    user = await verifier(token);
  } catch {
    return res.status(401).json({ error: "Sitzung abgelaufen – bitte neu anmelden" });
  }
  try {
    if (!known.has(user.userId)) {
      await ensureUser(user.userId, user.email);
      known.add(user.userId);
    }
    if (!NO_SUBSCRIPTION_NEEDED.some((r) => r.test(req.path)) && !(await checkAccess(user.userId))) {
      return res.status(402).json({ error: "Kein aktives Abo – bitte unter „Abo“ abschließen.", code: "subscription_required" });
    }
  } catch (e) {
    return next(e);
  }
  res.locals.userId = user.userId;
  withUser(user.userId, next);
}
