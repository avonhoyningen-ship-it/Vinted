import { Router } from "express";
import { z } from "zod";
import {
  authEnabled, checkPassword, clearFailures, COOKIE, createSession, isAuthenticated, loginBlocked, recordFailure,
} from "../../lib/auth.js";
import { h, HttpError } from "../../lib/http.js";

export const authRouter = Router();

authRouter.get("/me", (req, res) => {
  res.json({ authRequired: authEnabled(), authenticated: isAuthenticated(req) });
});

authRouter.post("/login", h(async (req, res) => {
  const ip = req.ip ?? "unknown";
  const wait = loginBlocked(ip);
  if (wait > 0) throw new HttpError(429, `Zu viele Fehlversuche – bitte in ${Math.ceil(wait / 60_000)} Minuten erneut versuchen`);
  const { password } = z.object({ password: z.string().min(1).max(500) }).parse(req.body);
  // Constant delay makes password guessing slower.
  await new Promise((r) => setTimeout(r, 400));
  if (!checkPassword(password)) {
    recordFailure(ip);
    throw new HttpError(401, "Falsches Passwort");
  }
  clearFailures(ip);
  const s = createSession();
  res.cookie(COOKIE, s.value, { httpOnly: true, sameSite: "lax", secure: req.secure, maxAge: s.maxAgeMs, path: "/" });
  res.json({ ok: true });
}));

authRouter.post("/logout", (req, res) => {
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: "lax", secure: req.secure, path: "/" });
  res.json({ ok: true });
});
