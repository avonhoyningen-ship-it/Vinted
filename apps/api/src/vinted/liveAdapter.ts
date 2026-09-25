import crypto from "node:crypto";
import { env } from "../config/env.js";
import { decodeVintedToken, formatDate, isAnonymous, isExpired } from "./token.js";
import type {
  RemoteFavourite, RemoteListing, RemoteListingStatus, RemoteMessage, RemoteSale,
  VintedAdapter, VintedProfile, VintedSession,
} from "./types.js";
import { VintedError } from "./types.js";

/**
 * Client for Vinted's web endpoints, authenticated with the user's own
 * `access_token_web` cookie (the same requests the Vinted website makes).
 *
 * Vinted has no documented public API: all paths and response mappings live
 * in this file so changes are fixed in one place. There is deliberately no
 * fallback to demo data – every failure becomes a VintedError with a clear
 * message. Vinted's bot protection is respected, not bypassed: a challenge
 * page is reported as "blocked".
 *
 * Write operations (publishing, messaging, price changes) are not implemented
 * against undocumented endpoints and report "unsupported".
 */
const USER_AGENT = "VintedDashboard/0.1 (self-hosted; personal account management)";
const WARMUP_TTL_MS = 30 * 60_000;

// ---------- cookie jar (per account session) ----------

interface Jar { cookies: Map<string, string>; warmedAt: number }
const jars = new Map<string, Jar>();

function jarKey(s: VintedSession) {
  return `${s.domain}:${crypto.createHash("sha256").update(s.refreshToken ?? s.token).digest("hex").slice(0, 16)}`;
}

function cookieHeader(s: VintedSession, jar: Jar | undefined) {
  const c = new Map(jar?.cookies);
  c.set("access_token_web", s.token);
  if (s.refreshToken) c.set("refresh_token_web", s.refreshToken);
  return [...c].map(([k, v]) => `${k}=${v}`).join("; ");
}

function readSetCookies(res: Response): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(";");
    const i = pair!.indexOf("=");
    if (i > 0) out.set(pair!.slice(0, i).trim(), pair!.slice(i + 1).trim());
  }
  return out;
}

/** Accepts renewed tokens only if they belong to the same logged-in user. */
function adoptRotatedTokens(s: VintedSession, set: Map<string, string>) {
  const access = set.get("access_token_web");
  if (!access || access === s.token) return;
  try {
    const next = decodeVintedToken(access);
    const current = decodeVintedToken(s.token);
    if (isAnonymous(next) || next.userId !== current.userId) return;
    s.token = access;
    s.refreshToken = set.get("refresh_token_web") ?? s.refreshToken ?? null;
    s.onTokens?.(s.token, s.refreshToken ?? null);
  } catch {
    /* ignore malformed cookies */
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- HTTP ----------

async function rawFetch(s: VintedSession, url: string, accept: string): Promise<Response> {
  try {
    return await fetch(url, {
      headers: {
        accept,
        "accept-language": "de-DE,de;q=0.9",
        "user-agent": USER_AGENT,
        cookie: cookieHeader(s, jars.get(jarKey(s))),
      },
      redirect: "manual",
    });
  } catch (e) {
    throw new VintedError(`Vinted ist nicht erreichbar (${(e as Error).message}). Internetverbindung prüfen.`, "network");
  }
}

/**
 * Loads the Vinted start page once per session like a browser would, to
 * receive the regular session cookies (and renewed tokens, if Vinted issues
 * them for a supplied refresh_token_web).
 */
async function warmUp(s: VintedSession) {
  const key = jarKey(s);
  const jar = jars.get(key);
  if (jar && Date.now() - jar.warmedAt < WARMUP_TTL_MS) return;
  const res = await rawFetch(s, `https://www.${s.domain}/`, "text/html");
  const set = readSetCookies(res);
  adoptRotatedTokens(s, set);
  set.delete("access_token_web");
  set.delete("refresh_token_web");
  jars.set(jarKey(s), { cookies: new Map([...(jar?.cookies ?? []), ...set]), warmedAt: Date.now() });
  if (res.status === 403 || res.status === 429) throw blockedError(res.status);
  await sleep(Math.min(env.vintedMinRequestGapMs, 2000));
}

function blockedError(status: number) {
  return new VintedError(
    `Vinted hat die Anfrage mit seinem Bot-Schutz blockiert (HTTP ${status}). Das passiert gelegentlich – bitte in einigen Minuten erneut versuchen. ` +
      "Das Dashboard umgeht diesen Schutz bewusst nicht.",
    "blocked",
  );
}

/** Checks the stored token locally before contacting Vinted. */
function checkToken(s: VintedSession) {
  const info = decodeVintedToken(s.token);
  if (isAnonymous(info)) {
    throw new VintedError(
      "Dieses access_token_web gehört zu keinem angemeldeten Nutzer (anonymes Besucher-Token). " +
        "Bitte bei vinted.de einloggen und danach den Cookie access_token_web erneut kopieren.",
      "auth",
    );
  }
  if (isExpired(info) && !s.refreshToken) {
    throw new VintedError(
      `Das access_token_web ist am ${formatDate(info.expiresAt!)} abgelaufen (Vinted-Tokens gelten ca. 24 Stunden). ` +
        "Bitte ein neues Token eintragen – oder zusätzlich das refresh_token_web, damit die Verbindung automatisch erneuert werden kann.",
      "auth",
    );
  }
  return info;
}

async function getJson<T>(s: VintedSession, path: string): Promise<T> {
  checkToken(s);
  await warmUp(s);
  if (isExpired(decodeVintedToken(s.token))) {
    throw new VintedError(
      "Das access_token_web ist abgelaufen und konnte nicht automatisch erneuert werden. Bitte bei Vinted einloggen und die Tokens neu eintragen.",
      "auth",
    );
  }
  const res = await rawFetch(s, `https://www.${s.domain}${path}`, "application/json, text/plain, */*");
  const type = res.headers.get("content-type") ?? "";
  const text = await res.text();
  const isJson = type.includes("json");

  if (!isJson && (res.status === 403 || res.status === 429 || res.status === 503 || /enable javascript/i.test(text))) {
    throw blockedError(res.status);
  }
  if (res.status === 401) {
    throw new VintedError("Vinted hat das access_token_web abgelehnt (abgelaufen oder ungültig). Bitte neu einloggen und das Token erneuern.", "auth");
  }
  if (res.status === 429) {
    throw new VintedError("Vinted-Rate-Limit erreicht – das Dashboard wartet und versucht es später erneut.", "rate_limit", (Number(res.headers.get("retry-after")) || 60) * 1000);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new VintedError(`Unerwartete Antwort von Vinted (HTTP ${res.status}, kein JSON) bei ${path}.`, "remote");
  }
  const err = body as { code?: number; message?: string; message_code?: string };
  if (res.status === 403) {
    throw new VintedError(
      `Vinted verweigert den Zugriff (${err.message ?? "access denied"}${err.message_code ? `, ${err.message_code}` : ""}). ` +
        "Das Token ist ungültig, abgelaufen oder gehört zu einer anderen Länder-Domain.",
      "auth",
    );
  }
  if (res.status === 404) throw new VintedError(`Vinted-Endpunkt nicht gefunden (${path}) – Vinted hat die Schnittstelle evtl. geändert.`, "remote");
  if (!res.ok) throw new VintedError(`Vinted antwortete mit HTTP ${res.status}${err.message ? `: ${err.message}` : ""} (${path}).`, "remote");
  return body as T;
}

// ---------- mapping ----------

type Price = string | number | { amount?: string | number; currency_code?: string } | null | undefined;
export function priceCents(p: Price): number {
  const raw = typeof p === "object" && p !== null ? p.amount : p;
  const n = Number.parseFloat(String(raw ?? "0").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
function currency(p: Price, fallback?: string): string {
  return (typeof p === "object" && p?.currency_code) || fallback || "EUR";
}

interface ApiUser {
  id: number; login: string; followers_count?: number; item_count?: number; given_item_count?: number;
}
interface ApiPhoto { url?: string; full_size_url?: string }
export interface ApiItem {
  id: number; title: string; description?: string; price?: Price; currency?: string; brand_title?: string; size_title?: string;
  status?: string; is_closed?: boolean | number; is_hidden?: boolean | number; is_draft?: boolean | number; is_reserved?: boolean;
  favourite_count?: number; view_count?: number; url?: string; path?: string; photos?: ApiPhoto[]; photo?: ApiPhoto | null;
  created_at_ts?: string; catalog_id?: number;
}

function listingStatus(i: ApiItem): RemoteListingStatus {
  if (i.is_closed) return "sold";
  if (i.is_hidden) return "hidden";
  return "active";
}

export function mapItem(i: ApiItem, domain: string): RemoteListing {
  const photos = i.photos?.length ? i.photos : i.photo ? [i.photo] : [];
  const url = i.url ?? i.path ?? `/items/${i.id}`;
  return {
    vintedItemId: String(i.id),
    title: i.title,
    description: i.description ?? "",
    priceCents: priceCents(i.price),
    currency: currency(i.price, i.currency),
    brand: i.brand_title || null,
    size: i.size_title || null,
    condition: i.status ?? null,
    category: i.catalog_id ? String(i.catalog_id) : null,
    status: listingStatus(i),
    favourites: i.favourite_count ?? 0,
    views: i.view_count ?? 0,
    url: url.startsWith("http") ? url : `https://www.${domain}${url}`,
    photoUrls: photos.map((p) => p.full_size_url ?? p.url ?? "").filter(Boolean),
    createdAt: i.created_at_ts ?? null,
  };
}

async function currentUser(s: VintedSession): Promise<ApiUser> {
  const info = checkToken(s);
  try {
    return (await getJson<{ user: ApiUser }>(s, "/api/v2/users/current")).user;
  } catch (e) {
    // Older/other deployments: fall back to the user id from the token (same user, not demo data).
    if (e instanceof VintedError && e.code === "remote" && /nicht gefunden/.test(e.message) && info.userId) {
      return (await getJson<{ user: ApiUser }>(s, `/api/v2/users/${info.userId}`)).user;
    }
    throw e;
  }
}

// ---------- adapter ----------

export const liveAdapter: VintedAdapter = {
  name: "live",
  canPublish: false,

  async verifySession(s): Promise<VintedProfile> {
    const u = await currentUser(s);
    if (!u?.id || !u.login) throw new VintedError("Vinted lieferte kein Nutzerprofil zurück.", "remote");
    let unread: number | null = null;
    try {
      await sleep(env.vintedMinRequestGapMs);
      const inbox = await getJson<{ conversations?: { unread?: boolean }[] }>(s, "/api/v2/inbox?page=1&per_page=20");
      unread = (inbox.conversations ?? []).filter((c) => c.unread).length;
    } catch (e) {
      if (e instanceof VintedError && (e.code === "auth" || e.code === "blocked")) throw e;
      unread = null; // inbox not readable – keep the previous value instead of guessing
    }
    return {
      userId: String(u.id),
      username: u.login,
      followers: u.followers_count ?? 0,
      activeListings: u.item_count ?? 0,
      totalSales: u.given_item_count ?? 0,
      unreadMessages: unread,
    };
  },

  async fetchOwnListings(s) {
    const userId = s.vintedUserId ?? decodeVintedToken(s.token).userId ?? String((await currentUser(s)).id);
    const out: RemoteListing[] = [];
    for (let page = 1; page <= 20; page++) {
      if (page > 1) await sleep(env.vintedMinRequestGapMs);
      const r = await getJson<{ items?: ApiItem[]; pagination?: { total_pages?: number } }>(
        s, `/api/v2/wardrobe/${userId}/items?page=${page}&per_page=96&order=newest_first`,
      );
      if (!Array.isArray(r.items)) throw new VintedError("Unerwartetes Format der Artikelliste von Vinted.", "remote");
      for (const i of r.items) if (!i.is_draft) out.push(mapItem(i, s.domain));
      if (!r.pagination?.total_pages || page >= r.pagination.total_pages) break;
    }
    return out;
  },

  async fetchSales(s) {
    const r = await getJson<{ my_orders?: { transaction_id: number; title: string; price?: Price; date?: string; item_id?: number; buyer?: { login?: string } }[] }>(
      s, "/api/v2/my_orders?type=sold&status=all&page=1&per_page=50",
    );
    return (r.my_orders ?? []).map<RemoteSale>((o) => ({
      externalId: String(o.transaction_id), vintedItemId: o.item_id ? String(o.item_id) : null, title: o.title,
      priceCents: priceCents(o.price), currency: currency(o.price), buyer: o.buyer?.login ?? null, soldAt: o.date ?? new Date().toISOString(),
    }));
  },

  async fetchFavourites(s) {
    const r = await getJson<{ notifications?: { id: number; body?: string; subject_id?: number; updated_at?: string; user_id?: number }[] }>(
      s, "/api/v2/notifications?page=1&per_page=50",
    );
    return (r.notifications ?? [])
      .filter((n) => /favorit|favourite|merkliste|gefällt/i.test(n.body ?? ""))
      .map<RemoteFavourite>((n) => ({
        externalId: String(n.id), vintedItemId: String(n.subject_id ?? ""), userId: String(n.user_id ?? ""),
        username: (n.body ?? "").split(" ")[0] ?? "", occurredAt: n.updated_at ?? new Date().toISOString(),
      }));
  },

  async fetchMessages(s) {
    const r = await getJson<{ conversations?: { id: number; unread?: boolean; description?: string; updated_at?: string; opposite_user?: { id: number; login: string } }[] }>(
      s, "/api/v2/inbox?page=1&per_page=20",
    );
    return (r.conversations ?? [])
      .filter((c) => c.unread && c.opposite_user)
      .map<RemoteMessage>((c) => ({
        externalId: `${c.id}:${c.updated_at ?? ""}`, conversationId: String(c.id), userId: String(c.opposite_user!.id),
        username: c.opposite_user!.login, text: c.description ?? "", vintedItemId: null, occurredAt: c.updated_at ?? new Date().toISOString(),
      }));
  },

  async sendMessage() {
    throw new VintedError("Nachrichten senden ist nicht verfügbar (keine offizielle Vinted-API).", "unsupported");
  },
  async createListing() {
    throw new VintedError("Automatisches Einstellen ist nicht verfügbar (keine offizielle Vinted-API) – Artikel manuell einstellen und Link im Archiv hinterlegen.", "unsupported");
  },
  async updatePrice() {
    throw new VintedError("Preisänderung ist nicht verfügbar (keine offizielle Vinted-API).", "unsupported");
  },
};

/** For tests: forget cached cookies. */
export function resetLiveSessions() {
  jars.clear();
}
