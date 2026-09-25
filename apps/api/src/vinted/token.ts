import { VintedError } from "./types.js";

export interface VintedTokenInfo {
  /** Vinted user id of the logged-in user (absent on anonymous tokens). */
  userId: string | null;
  expiresAt: Date | null;
  scope: string | null;
}

/**
 * Reads the (unverified) payload of Vinted's `access_token_web` JWT. Only used
 * to give precise error messages before any request is made – Vinted itself
 * verifies the signature.
 */
export function decodeVintedToken(token: string): VintedTokenInfo {
  const parts = token.trim().split(".");
  if (parts.length !== 3 || !parts[0]!.startsWith("eyJ")) {
    throw new VintedError(
      "Das ist kein gültiges access_token_web. Erwartet wird der komplette Cookie-Wert (ein langer Text, der mit „eyJ“ beginnt).",
      "auth",
    );
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new VintedError("Das access_token_web ist beschädigt (Inhalt nicht lesbar). Bitte neu aus dem Browser kopieren.", "auth");
  }
  const sub = payload.sub ?? payload.user_id;
  return {
    userId: sub === undefined || sub === null || sub === "" ? null : String(sub),
    expiresAt: typeof payload.exp === "number" ? new Date(payload.exp * 1000) : null,
    scope: typeof payload.scope === "string" ? payload.scope : null,
  };
}

export function isAnonymous(info: VintedTokenInfo) {
  return !info.userId || info.scope === "public";
}

export function isExpired(info: VintedTokenInfo, now = Date.now()) {
  return !!info.expiresAt && info.expiresAt.getTime() <= now;
}

export const formatDate = (d: Date) => d.toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Berlin" });
