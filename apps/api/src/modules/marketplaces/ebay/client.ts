import { db, nowIso } from "../../../db/index.js";
import { decrypt, encrypt } from "../../../lib/crypto.js";
import { HttpError } from "../../../lib/http.js";

/**
 * eBay's official APIs (Sell Inventory/Account/Fulfillment, Taxonomy, Trading for photos)
 * with the seller's own developer keys. Login per OAuth; the refresh token is stored encrypted.
 */
export interface EbayConfig {
  clientId: string;
  clientSecret: string;
  /** "RuName" from the eBay developer portal (redirect URL name). */
  ruName: string;
  sandbox: boolean;
  // Filled in after connecting:
  refreshToken?: string | null;
  refreshExpiresAt?: string | null;
  accessToken?: string | null;
  accessExpiresAt?: string | null;
  username?: string | null;
  // Seller settings for listings:
  postalCode?: string | null;
  fulfillmentPolicyId?: string | null;
  paymentPolicyId?: string | null;
  returnPolicyId?: string | null;
  /** List every article on eBay as soon as it is online on Vinted. */
  autoList?: boolean;
  /** Price on eBay in percent of the Vinted price (100 = same). */
  pricePercent?: number;
  locationReady?: boolean;
}

export const SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
];
export const MARKETPLACE = "EBAY_DE";
export const LOCATION_KEY = "ask-standort";

/** Hosts (overridable for tests). */
export function hosts(sandbox: boolean) {
  return {
    api: process.env.EBAY_API_BASE ?? (sandbox ? "https://api.sandbox.ebay.com" : "https://api.ebay.com"),
    auth: process.env.EBAY_AUTH_BASE ?? (sandbox ? "https://auth.sandbox.ebay.com" : "https://auth.ebay.com"),
  };
}

// ---------- stored config ----------

export async function loadConfig(): Promise<EbayConfig | null> {
  const row = await db.get<{ data_encrypted: string }>("SELECT data_encrypted FROM marketplace_auth WHERE platform = 'ebay'");
  return row ? (JSON.parse(decrypt(row.data_encrypted)) as EbayConfig) : null;
}

export async function saveConfig(cfg: EbayConfig) {
  await db.tx(async () => {
    await db.run("DELETE FROM marketplace_auth WHERE platform = 'ebay'");
    await db.run("INSERT INTO marketplace_auth (platform, data_encrypted, updated_at) VALUES ('ebay', ?, ?)", [encrypt(JSON.stringify(cfg)), nowIso()]);
  });
}

export async function requireConfig(): Promise<EbayConfig> {
  const cfg = await loadConfig();
  if (!cfg?.clientId) throw new HttpError(400, "eBay ist noch nicht eingerichtet (Einstellungen → eBay)");
  return cfg;
}

// ---------- OAuth ----------

export function authorizeUrl(cfg: EbayConfig, state: string) {
  const u = new URL(`${hosts(cfg.sandbox).auth}/oauth2/authorize`);
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", cfg.ruName);
  u.searchParams.set("scope", SCOPES.join(" "));
  u.searchParams.set("state", state);
  return u.toString();
}

async function tokenRequest(cfg: EbayConfig, body: Record<string, string>) {
  const r = await fetch(`${hosts(cfg.sandbox).api}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams(body).toString(),
  });
  const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new HttpError(400, `eBay-Anmeldung fehlgeschlagen: ${String(data.error_description ?? data.error ?? r.status)}`);
  return data as { access_token: string; expires_in: number; refresh_token?: string; refresh_token_expires_in?: number };
}

/** The code from eBay's redirect (or the whole URL pasted by the seller) → tokens. */
export async function exchangeCode(cfg: EbayConfig, codeOrUrl: string): Promise<EbayConfig> {
  let code = codeOrUrl.trim();
  if (/^https?:\/\//.test(code)) code = new URL(code).searchParams.get("code") ?? "";
  if (!code) throw new HttpError(400, "Kein eBay-Code gefunden – bitte die komplette Adresse nach der Anmeldung einfügen");
  const t = await tokenRequest(cfg, { grant_type: "authorization_code", code, redirect_uri: cfg.ruName });
  const now = Date.now();
  return {
    ...cfg,
    accessToken: t.access_token,
    accessExpiresAt: new Date(now + (t.expires_in - 60) * 1000).toISOString(),
    refreshToken: t.refresh_token ?? cfg.refreshToken ?? null,
    refreshExpiresAt: t.refresh_token_expires_in ? new Date(now + t.refresh_token_expires_in * 1000).toISOString() : cfg.refreshExpiresAt ?? null,
  };
}

/** A valid user access token (refreshed when expired). */
export async function accessToken(): Promise<{ token: string; cfg: EbayConfig }> {
  let cfg = await requireConfig();
  if (!cfg.refreshToken) throw new HttpError(400, "eBay ist nicht verbunden – bitte unter Einstellungen → eBay „Mit eBay verbinden“");
  if (!cfg.accessToken || !cfg.accessExpiresAt || Date.parse(cfg.accessExpiresAt) < Date.now()) {
    const t = await tokenRequest(cfg, { grant_type: "refresh_token", refresh_token: cfg.refreshToken, scope: SCOPES.join(" ") });
    cfg = { ...cfg, accessToken: t.access_token, accessExpiresAt: new Date(Date.now() + (t.expires_in - 60) * 1000).toISOString() };
    await saveConfig(cfg);
  }
  return { token: cfg.accessToken!, cfg };
}

// ---------- REST calls ----------

export class EbayError extends HttpError {
  constructor(status: number, message: string, public errorIds: number[] = []) {
    super(status, message);
  }
}

export async function ebay<T = unknown>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<{ status: number; data: T; headers: Headers }> {
  const { token, cfg } = await accessToken();
  const r = await fetch(`${hosts(cfg.sandbox).api}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      "accept-language": "de-DE",
      "content-language": "de-DE",
      "x-ebay-c-marketplace-id": MARKETPLACE,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...extraHeaders,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const data = (text ? JSON.parse(text) : {}) as T & { errors?: { errorId: number; message: string; longMessage?: string; parameters?: { name: string; value: string }[] }[] };
  if (!r.ok) {
    const errs = data.errors ?? [];
    const msg = errs.map((e) => e.longMessage || e.message).join(" · ") || `HTTP ${r.status}`;
    throw new EbayError(r.status >= 500 ? 502 : 400, `eBay: ${msg}`, errs.map((e) => e.errorId));
  }
  return { status: r.status, data, headers: r.headers };
}

/** Photo upload to eBay's picture hosting (Trading API UploadSiteHostedPictures) → public picture URL. */
export async function uploadPicture(jpeg: Buffer, name: string): Promise<string> {
  const { token, cfg } = await accessToken();
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<UploadSiteHostedPicturesRequest xmlns="urn:ebay:apis:eBLBaseComponents"><PictureName>${name.replace(/[<>&"]/g, "")}</PictureName><PictureSet>Supersize</PictureSet></UploadSiteHostedPicturesRequest>`;
  const form = new FormData();
  form.append("XML Payload", new Blob([xml], { type: "text/xml" }), "payload.xml");
  form.append("image", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), `${name}.jpg`);
  const r = await fetch(`${hosts(cfg.sandbox).api}/ws/api.dll`, {
    method: "POST",
    headers: {
      "X-EBAY-API-CALL-NAME": "UploadSiteHostedPictures",
      "X-EBAY-API-SITEID": "77",
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1271",
      "X-EBAY-API-IAF-TOKEN": token,
    },
    body: form,
  });
  const out = await r.text();
  const url = out.match(/<FullURL>([^<]+)<\/FullURL>/)?.[1];
  if (!url) {
    const err = out.match(/<LongMessage>([^<]+)<\/LongMessage>/)?.[1] ?? out.match(/<ShortMessage>([^<]+)<\/ShortMessage>/)?.[1] ?? `HTTP ${r.status}`;
    throw new EbayError(400, `eBay-Foto-Upload: ${err}`);
  }
  return url.replace(/&amp;/g, "&");
}
