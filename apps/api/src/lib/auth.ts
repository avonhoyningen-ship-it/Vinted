import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";

/**
 * Password login with a stateless, HMAC-signed session cookie.
 * Cookie value: <expiresAtMs>.<nonce>.<hmac>; HttpOnly, SameSite=Lax,
 * Secure when served over HTTPS. The signing key is derived from
 * ENCRYPTION_KEY + DASHBOARD_PASSWORD, so changing the password logs out
 * every session.
 */
export const COOKIE = "vd_session";

export const authEnabled = () => !!(env.dashboardPassword || env.apiToken);

function signingKey() {
  return crypto.createHmac("sha256", Buffer.from(env.encryptionKey, "base64")).update(`session:${env.dashboardPassword ?? ""}`).digest();
}

function sign(payload: string) {
  return crypto.createHmac("sha256", signingKey()).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string) {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function checkPassword(input: string) {
  return !!env.dashboardPassword && safeEqual(input, env.dashboardPassword);
}

export function createSession(): { value: string; maxAgeMs: number } {
  const maxAgeMs = env.sessionDays * 86400_000;
  const payload = `${Date.now() + maxAgeMs}.${crypto.randomBytes(12).toString("base64url")}`;
  return { value: `${payload}.${sign(payload)}`, maxAgeMs };
}

export function verifySession(value: string | undefined): boolean {
  if (!value || !env.dashboardPassword) return false;
  const i = value.lastIndexOf(".");
  if (i < 0) return false;
  const payload = value.slice(0, i);
  if (!safeEqual(value.slice(i + 1), sign(payload))) return false;
  const expires = Number(payload.split(".")[0]);
  return Number.isFinite(expires) && expires > Date.now();
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export function isAuthenticated(req: Request): boolean {
  if (!authEnabled()) return true;
  if (verifySession(readCookie(req, COOKIE))) return true;
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  return !!env.apiToken && !!bearer && safeEqual(bearer, env.apiToken);
}

const PUBLIC_PATHS = new Set(["/health", "/auth/login", "/auth/logout", "/auth/me"]);

const isLoopback = (ip: string | undefined) => !!ip && /^(127\.|::1$|::ffff:127\.)/.test(ip.trim());

/**
 * Where the request really comes from. The Next.js dev server proxies /api from
 * localhost and passes the browser's address in x-forwarded-for.
 */
export function clientIsLocal(req: Request): boolean {
  if (!isLoopback(req.socket.remoteAddress)) return false;
  const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return forwarded.every(isLoopback);
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (PUBLIC_PATHS.has(req.path)) return next();
  // Without a password the dashboard only works on this PC – never open to the whole network.
  if (!authEnabled()) {
    if (clientIsLocal(req)) return next();
    return res.status(403).json({ error: "Ohne Passwort ist das Dashboard nur auf dem PC selbst nutzbar. Für Zugriff von Handy/Tablet in .env ein DASHBOARD_PASSWORD setzen." });
  }
  if (isAuthenticated(req)) return next();
  res.status(401).json({ error: "Nicht angemeldet" });
}

// ---------- brute-force protection ----------

const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 10;
const failures = new Map<string, { count: number; first: number }>();

export function loginBlocked(ip: string): number {
  const f = failures.get(ip);
  if (!f) return 0;
  if (Date.now() - f.first > WINDOW_MS) {
    failures.delete(ip);
    return 0;
  }
  return f.count >= MAX_FAILURES ? f.first + WINDOW_MS - Date.now() : 0;
}

export function recordFailure(ip: string) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > WINDOW_MS) failures.set(ip, { count: 1, first: Date.now() });
  else f.count++;
}

export function clearFailures(ip: string) {
  failures.delete(ip);
}
