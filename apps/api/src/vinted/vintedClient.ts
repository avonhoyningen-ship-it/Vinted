import { env } from "../config/env.js";
import { RateLimiter } from "../lib/rateLimiter.js";
import { liveAdapter } from "./liveAdapter.js";
import type { ListingDraft, SendMessageInput, VintedAdapter, VintedSession } from "./types.js";
import { VintedError } from "./types.js";

export * from "./types.js";

/**
 * Central entry point for all Vinted access. Every call goes through a
 * per-account rate limiter (min gap + jitter) and a small retry policy that
 * backs off on HTTP 429. Change limits here, change endpoints in the adapter.
 */
export class VintedClient {
  private limiter!: RateLimiter;

  constructor(private adapter: VintedAdapter, private minGapMs: number, private maxRetries = 2) {
    this.useAdapter(adapter);
  }

  /** Test hook: swap the transport (tests use an in-memory fake). */
  useAdapter(adapter: VintedAdapter, minGapMs = this.minGapMs) {
    this.adapter = adapter;
    this.limiter = new RateLimiter(minGapMs, minGapMs === 0 ? 0 : undefined);
  }

  get mode() {
    return this.adapter.name;
  }

  private async call<T>(accountKey: string, fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await this.limiter.schedule(accountKey, fn);
      } catch (e) {
        const err = e instanceof VintedError ? e : new VintedError((e as Error).message, "network");
        // Auth errors and bot-protection blocks are never retried automatically.
        const retryable = err.code === "rate_limit" || err.code === "network";
        if (!retryable || attempt >= this.maxRetries) throw err;
        attempt++;
        const backoff = err.retryAfterMs ?? 30_000 * 2 ** (attempt - 1);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }

  verifySession(key: string, s: VintedSession) { return this.call(key, () => this.adapter.verifySession(s)); }
  fetchOwnListings(key: string, s: VintedSession) { return this.call(key, () => this.adapter.fetchOwnListings(s)); }
  fetchSales(key: string, s: VintedSession) { return this.call(key, () => this.adapter.fetchSales(s)); }
  fetchFavourites(key: string, s: VintedSession) { return this.call(key, () => this.adapter.fetchFavourites(s)); }
  fetchMessages(key: string, s: VintedSession) { return this.call(key, () => this.adapter.fetchMessages(s)); }
  sendMessage(key: string, s: VintedSession, input: SendMessageInput) { return this.call(key, () => this.adapter.sendMessage(s, input)); }
  createListing(key: string, s: VintedSession, draft: ListingDraft) { return this.call(key, () => this.adapter.createListing(s, draft)); }
  updatePrice(key: string, s: VintedSession, vintedItemId: string, priceCents: number) {
    return this.call(key, () => this.adapter.updatePrice(s, vintedItemId, priceCents));
  }
}

/** Always the real Vinted client – there is no demo/mock fallback at runtime. */
export const vintedClient = new VintedClient(liveAdapter, env.vintedMinRequestGapMs);
