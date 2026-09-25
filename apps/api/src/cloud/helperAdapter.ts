import type { VintedAdapter, VintedSession } from "../vinted/types.js";
import { VintedError } from "../vinted/types.js";
import { HelperError, runOnHelper } from "./helperHub.js";

/**
 * Vinted access in the cloud: every call runs on the user's PC helper, from
 * their own internet connection and with the login stored only on their PC.
 */
const VINTED_CODES = new Set(["auth", "rate_limit", "blocked", "unsupported", "network", "remote"]);

function call<T>(method: string) {
  return async (s: VintedSession, ...args: unknown[]): Promise<T> => {
    try {
      return await runOnHelper<T>("vinted.call", { method, accountId: s.accountId, domain: s.domain, vintedUserId: s.vintedUserId ?? null, args });
    } catch (e) {
      if (e instanceof HelperError) {
        const remote = (e as HelperError & { remoteCode?: string }).remoteCode;
        // Offline/timeout are not retried here – the next poll tries again.
        throw new VintedError(e.message, remote && VINTED_CODES.has(remote) ? (remote as VintedError["code"]) : "remote");
      }
      throw e;
    }
  };
}

export const helperAdapter: VintedAdapter = {
  name: "helper",
  canPublish: false,
  verifySession: call("verifySession"),
  fetchOwnListings: call("fetchOwnListings"),
  fetchSales: call("fetchSales"),
  fetchFavourites: call("fetchFavourites"),
  fetchMessages: call("fetchMessages"),
  sendMessage: call("sendMessage"),
  createListing: call("createListing"),
  updatePrice: call("updatePrice"),
};
