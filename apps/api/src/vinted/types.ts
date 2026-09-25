export interface VintedSession {
  /** Decrypted session token (value of the `access_token_web` cookie). */
  token: string;
  /** Country domain, e.g. "vinted.de". */
  domain: string;
  vintedUserId?: string | null;
  /** Optional `refresh_token_web` cookie; lets the client pick up renewed access tokens. */
  refreshToken?: string | null;
  /** Called when Vinted hands out renewed tokens for the same user, so they can be stored. */
  onTokens?: (accessToken: string, refreshToken: string | null) => void | Promise<void>;
}

export interface VintedProfile {
  userId: string;
  username: string;
  followers: number;
  activeListings: number;
  totalSales: number;
  /** null = could not be determined (keeps the previous value). */
  unreadMessages: number | null;
}

export type RemoteListingStatus = "active" | "sold" | "hidden" | "removed";

export interface RemoteListing {
  vintedItemId: string;
  title: string;
  description: string;
  priceCents: number;
  currency: string;
  brand?: string | null;
  size?: string | null;
  condition?: string | null;
  category?: string | null;
  status: RemoteListingStatus;
  favourites: number;
  views: number;
  url: string;
  photoUrls: string[];
  createdAt?: string | null;
}

export interface RemoteSale {
  externalId: string;
  vintedItemId: string | null;
  title: string;
  priceCents: number;
  currency: string;
  buyer: string | null;
  soldAt: string;
}

export interface RemoteFavourite {
  externalId: string;
  vintedItemId: string;
  userId: string;
  username: string;
  occurredAt: string;
}

export interface RemoteMessage {
  externalId: string;
  conversationId: string;
  userId: string;
  username: string;
  text: string;
  vintedItemId: string | null;
  occurredAt: string;
}

export interface ListingDraft {
  title: string;
  description: string;
  priceCents: number;
  currency: string;
  brand?: string | null;
  size?: string | null;
  condition?: string | null;
  category?: string | null;
  color?: string | null;
  photos: { path: string; mimeType: string }[];
}

export interface SendMessageInput {
  toUserId: string;
  conversationId?: string | null;
  vintedItemId?: string | null;
  text: string;
}

/**
 * One adapter per transport. Everything Vinted-specific (endpoints, payload
 * shapes) lives in an adapter so API changes are fixed in one place.
 */
export interface VintedAdapter {
  readonly name: string;
  /** Whether createListing works (false for the live client: no official Vinted API). */
  readonly canPublish: boolean;
  verifySession(s: VintedSession): Promise<VintedProfile>;
  fetchOwnListings(s: VintedSession): Promise<RemoteListing[]>;
  fetchSales(s: VintedSession): Promise<RemoteSale[]>;
  fetchFavourites(s: VintedSession): Promise<RemoteFavourite[]>;
  fetchMessages(s: VintedSession): Promise<RemoteMessage[]>;
  sendMessage(s: VintedSession, input: SendMessageInput): Promise<void>;
  createListing(s: VintedSession, draft: ListingDraft): Promise<{ vintedItemId: string; url: string }>;
  updatePrice(s: VintedSession, vintedItemId: string, priceCents: number): Promise<void>;
}

export class VintedError extends Error {
  constructor(message: string, public code: "auth" | "rate_limit" | "blocked" | "unsupported" | "network" | "remote" = "remote", public retryAfterMs?: number) {
    super(message);
  }
}
