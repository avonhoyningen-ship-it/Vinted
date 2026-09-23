import type {
  RemoteFavourite, RemoteListing, RemoteListingStatus, RemoteMessage, RemoteSale,
  VintedAdapter, VintedProfile, VintedSession,
} from "./types.js";
import { VintedError } from "./types.js";

/**
 * Live adapter against Vinted's web endpoints.
 *
 * IMPORTANT: Vinted has no public, documented API. The read endpoints below
 * are the ones the Vinted web app itself uses; they can change at any time.
 * All endpoint paths and response mapping live in this file only.
 *
 * Write operations (publishing, messaging, price changes) are deliberately
 * NOT implemented against undocumented endpoints. They throw an
 * "unsupported" error so the dashboard can surface the item for manual
 * handling instead of silently failing. Implement them here if Vinted ever
 * offers an official API for them.
 */
const UA = "Mozilla/5.0 (compatible; VintedDashboard/0.1; personal account management)";

async function get<T>(s: VintedSession, path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`https://www.${s.domain}${path}`, {
      headers: {
        accept: "application/json",
        cookie: `access_token_web=${s.token}`,
        "user-agent": UA,
      },
    });
  } catch (e) {
    throw new VintedError(`Netzwerkfehler: ${(e as Error).message}`, "network");
  }
  if (res.status === 401 || res.status === 403) throw new VintedError("Session abgelaufen oder ungültig – Token erneuern", "auth");
  if (res.status === 429) {
    const ra = Number(res.headers.get("retry-after")) || 60;
    throw new VintedError("Vinted Rate-Limit erreicht", "rate_limit", ra * 1000);
  }
  if (!res.ok) throw new VintedError(`Vinted antwortete mit HTTP ${res.status}`, "remote");
  return (await res.json()) as T;
}

type Price = string | number | { amount?: string | number; currency_code?: string } | null | undefined;
function priceCents(p: Price): number {
  const raw = typeof p === "object" && p !== null ? p.amount : p;
  const n = Number.parseFloat(String(raw ?? "0").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
function currency(p: Price, fallback = "EUR"): string {
  return (typeof p === "object" && p?.currency_code) || fallback;
}

interface ApiUser { id: number; login: string; followers_count?: number; item_count?: number; given_item_count?: number; msg_template_count?: number }
interface ApiItem {
  id: number; title: string; description?: string; price?: Price; currency?: string; brand_title?: string; size_title?: string;
  status?: string; is_closed?: boolean | number; is_hidden?: boolean | number; is_draft?: boolean; favourite_count?: number;
  view_count?: number; url?: string; photos?: { url?: string; full_size_url?: string }[]; created_at_ts?: string; catalog_id?: number;
}

function listingStatus(i: ApiItem): RemoteListingStatus {
  if (i.is_closed) return "sold";
  if (i.is_hidden) return "hidden";
  return "active";
}

async function currentUser(s: VintedSession): Promise<ApiUser> {
  const r = await get<{ user: ApiUser }>(s, "/api/v2/users/current");
  return r.user;
}

export const liveAdapter: VintedAdapter = {
  name: "live",
  async verifySession(s): Promise<VintedProfile> {
    const u = await currentUser(s);
    let unread = 0;
    try {
      const inbox = await get<{ conversations?: { unread?: boolean }[] }>(s, "/api/v2/inbox?page=1&per_page=20");
      unread = (inbox.conversations ?? []).filter((c) => c.unread).length;
    } catch {
      /* inbox is optional for the overview */
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
    const userId = s.vintedUserId ?? String((await currentUser(s)).id);
    const out: RemoteListing[] = [];
    for (let page = 1; page <= 10; page++) {
      const r = await get<{ items: ApiItem[]; pagination?: { total_pages?: number } }>(
        s, `/api/v2/wardrobe/${userId}/items?page=${page}&per_page=96&order=newest_first`,
      );
      for (const i of r.items ?? []) {
        out.push({
          vintedItemId: String(i.id), title: i.title, description: i.description ?? "", priceCents: priceCents(i.price),
          currency: currency(i.price, i.currency), brand: i.brand_title ?? null, size: i.size_title ?? null,
          condition: i.status ?? null, category: i.catalog_id ? String(i.catalog_id) : null, status: listingStatus(i),
          favourites: i.favourite_count ?? 0, views: i.view_count ?? 0, url: i.url ?? `https://www.${s.domain}/items/${i.id}`,
          photoUrls: (i.photos ?? []).map((p) => p.full_size_url ?? p.url ?? "").filter(Boolean), createdAt: i.created_at_ts ?? null,
        });
      }
      if (!r.pagination?.total_pages || page >= r.pagination.total_pages) break;
    }
    return out;
  },
  async fetchSales(s) {
    const r = await get<{ my_orders?: { transaction_id: number; title: string; price?: Price; date?: string; item_id?: number; buyer?: { login?: string } }[] }>(
      s, "/api/v2/my_orders?type=sold&status=all&page=1&per_page=50",
    );
    return (r.my_orders ?? []).map<RemoteSale>((o) => ({
      externalId: String(o.transaction_id), vintedItemId: o.item_id ? String(o.item_id) : null, title: o.title,
      priceCents: priceCents(o.price), currency: currency(o.price), buyer: o.buyer?.login ?? null, soldAt: o.date ?? new Date().toISOString(),
    }));
  },
  async fetchFavourites(s) {
    const r = await get<{ notifications?: { id: number; entry_type?: number; body?: string; subject_id?: number; updated_at?: string; user_id?: number; link?: string }[] }>(
      s, "/api/v2/notifications?page=1&per_page=50",
    );
    // Favourite notifications carry the item as subject; the username is embedded in the text body.
    return (r.notifications ?? [])
      .filter((n) => /favorit|favourite|merkliste|gefällt/i.test(n.body ?? ""))
      .map<RemoteFavourite>((n) => ({
        externalId: String(n.id), vintedItemId: String(n.subject_id ?? ""), userId: String(n.user_id ?? ""),
        username: (n.body ?? "").split(" ")[0] ?? "", occurredAt: n.updated_at ?? new Date().toISOString(),
      }));
  },
  async fetchMessages(s) {
    const r = await get<{ conversations?: { id: number; unread?: boolean; description?: string; updated_at?: string; opposite_user?: { id: number; login: string }; item_count?: number }[] }>(
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
    throw new VintedError("Nachrichten senden ist im Live-Modus nicht verfügbar (keine offizielle Vinted-API)", "unsupported");
  },
  async createListing() {
    throw new VintedError("Automatisches Einstellen ist im Live-Modus nicht verfügbar (keine offizielle Vinted-API) – Artikel manuell einstellen und Link im Archiv hinterlegen", "unsupported");
  },
  async updatePrice() {
    throw new VintedError("Preisänderung ist im Live-Modus nicht verfügbar (keine offizielle Vinted-API)", "unsupported");
  },
};
