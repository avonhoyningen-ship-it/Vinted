import crypto from "node:crypto";
import { env } from "../config/env.js";
import type {
  ListingDraft, RemoteFavourite, RemoteListing, RemoteMessage, RemoteSale,
  SendMessageInput, VintedAdapter, VintedProfile, VintedSession,
} from "./types.js";
import { VintedError } from "./types.js";

/**
 * In-memory simulation of a Vinted account. Used for development, demos and
 * tests (VINTED_MODE=mock). Events can be injected via POST /api/system/simulate.
 */
interface MockAccount {
  userId: string;
  username: string;
  followers: number;
  listings: RemoteListing[];
  sales: RemoteSale[];
  favourites: RemoteFavourite[];
  messages: RemoteMessage[];
  sentMessages: (SendMessageInput & { at: string })[];
}

const accounts = new Map<string, MockAccount>();
let seq = 1000;
const nextId = () => String(++seq);

const BUYERS = ["lena_mode", "tom.vintage", "sarah_k", "mia.secondhand", "jonas92", "anna_loves_denim"];
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)]!;

function userIdFor(token: string) {
  return "mock-" + crypto.createHash("sha256").update(token).digest("hex").slice(0, 8);
}

function ensure(s: VintedSession): MockAccount {
  if (!s.token || s.token.length < 8 || s.token.startsWith("invalid")) {
    throw new VintedError("Session-Token ungültig oder abgelaufen", "auth");
  }
  const id = userIdFor(s.token);
  let acc = accounts.get(id);
  if (!acc) {
    acc = {
      userId: id,
      username: `reseller_${id.slice(5, 9)}`,
      followers: 20 + Math.floor(Math.random() * 200),
      listings: [],
      sales: [],
      favourites: [],
      messages: [],
      sentMessages: [],
    };
    // A few pre-existing listings, so the first sync demonstrates the archive import.
    const seed: [string, string, number, string, string][] = [
      ["Levi's 501 Jeans W32 L32", "Levi's", 3500, "W32", "Jeans"],
      ["Nike Air Max 90 weiß", "Nike", 5500, "42", "Sneaker"],
      ["Zara Wollmantel beige", "Zara", 4200, "M", "Mäntel"],
    ];
    for (const [title, brand, price, size, category] of seed) {
      const vid = nextId();
      acc.listings.push({
        vintedItemId: vid, title, description: `${title}. Guter Zustand, aus Nichtraucherhaushalt.`,
        priceCents: price, currency: "EUR", brand, size, condition: "very_good", category,
        status: "active", favourites: Math.floor(Math.random() * 10), views: Math.floor(Math.random() * 200),
        url: `https://www.${s.domain}/items/${vid}`, photoUrls: [], createdAt: new Date(Date.now() - 86400_000 * 7).toISOString(),
      });
    }
    accounts.set(id, acc);
  }
  if (env.mockRandomEvents) randomTick(acc);
  return acc;
}

function randomTick(acc: MockAccount) {
  const active = acc.listings.filter((l) => l.status === "active");
  if (!active.length) return;
  if (Math.random() < 0.3) mockInject(acc.userId, "favourite");
  if (Math.random() < 0.1) mockInject(acc.userId, "sale");
  if (Math.random() < 0.1) mockInject(acc.userId, "message");
}

/** Injects a simulated event into a mock account. Returns a short description. */
export function mockInject(userId: string, type: "sale" | "favourite" | "message", opts: { vintedItemId?: string; text?: string } = {}): string {
  const acc = accounts.get(userId);
  if (!acc) throw new VintedError("Mock-Account unbekannt – Account zuerst synchronisieren", "remote");
  const active = acc.listings.filter((l) => l.status === "active");
  const listing = (opts.vintedItemId && acc.listings.find((l) => l.vintedItemId === opts.vintedItemId)) || pick(active);
  const now = new Date().toISOString();
  const buyer = pick(BUYERS);
  if (type === "sale") {
    if (!listing) throw new VintedError("Keine aktiven Listings zum Verkaufen", "remote");
    listing.status = "sold";
    acc.sales.push({ externalId: nextId(), vintedItemId: listing.vintedItemId, title: listing.title, priceCents: listing.priceCents, currency: listing.currency, buyer, soldAt: now });
    return `Verkauf: ${listing.title}`;
  }
  if (type === "favourite") {
    if (!listing) throw new VintedError("Keine aktiven Listings", "remote");
    listing.favourites += 1;
    acc.favourites.push({ externalId: nextId(), vintedItemId: listing.vintedItemId, userId: `u-${buyer}`, username: buyer, occurredAt: now });
    return `${buyer} hat ${listing.title} favorisiert`;
  }
  const text = opts.text ?? pick(["Hallo, ist der Artikel noch da?", "Wie sind die genauen Maße?", "Geht noch was am Preis?", "Versendest du auch mit Hermes?"]);
  acc.messages.push({ externalId: nextId(), conversationId: `c-${buyer}`, userId: `u-${buyer}`, username: buyer, text, vintedItemId: listing?.vintedItemId ?? null, occurredAt: now });
  return `Nachricht von ${buyer}: ${text}`;
}

export function mockSentMessages(userId: string) {
  return accounts.get(userId)?.sentMessages ?? [];
}

export function mockReset() {
  accounts.clear();
}

export const mockAdapter: VintedAdapter = {
  name: "mock",
  async verifySession(s): Promise<VintedProfile> {
    const acc = ensure(s);
    return {
      userId: acc.userId,
      username: acc.username,
      followers: acc.followers,
      activeListings: acc.listings.filter((l) => l.status === "active").length,
      totalSales: acc.sales.length,
      unreadMessages: acc.messages.length,
    };
  },
  async fetchOwnListings(s) {
    return ensure(s).listings.map((l) => ({ ...l }));
  },
  async fetchSales(s) {
    return [...ensure(s).sales];
  },
  async fetchFavourites(s) {
    return [...ensure(s).favourites];
  },
  async fetchMessages(s) {
    return [...ensure(s).messages];
  },
  async sendMessage(s, input) {
    ensure(s).sentMessages.push({ ...input, at: new Date().toISOString() });
  },
  async createListing(s, draft: ListingDraft) {
    const acc = ensure(s);
    const vid = nextId();
    const url = `https://www.${s.domain}/items/${vid}`;
    acc.listings.push({
      vintedItemId: vid, title: draft.title, description: draft.description, priceCents: draft.priceCents,
      currency: draft.currency, brand: draft.brand, size: draft.size, condition: draft.condition, category: draft.category,
      status: "active", favourites: 0, views: 0, url, photoUrls: [], createdAt: new Date().toISOString(),
    });
    return { vintedItemId: vid, url };
  },
  async updatePrice(s, vintedItemId, priceCents) {
    const l = ensure(s).listings.find((x) => x.vintedItemId === vintedItemId);
    if (!l) throw new VintedError("Listing nicht gefunden", "remote");
    l.priceCents = priceCents;
  },
};
