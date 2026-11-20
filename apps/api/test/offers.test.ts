import { describe, expect, it } from "vitest";
import { decideOffer } from "../src/modules/offers/service.js";
import { favouriteFromNote, openOfferIn } from "../src/vinted/liveAdapter.js";

const rules = { maxPercentNew: 20, maxPercentOld: 30, oldAfterDays: 7 };
const now = Date.parse("2026-11-18T12:00:00Z");
const daysAgo = (d: number) => new Date(now - d * 86400_000).toISOString();

describe("decideOffer", () => {
  it("accepts up to 20 % in the first week", () => {
    expect(decideOffer(1600, 2000, daysAgo(2), rules, now)).toMatchObject({ action: "accept", maxPercent: 20 });
    expect(decideOffer(2000, 2000, daysAgo(2), rules, now)).toMatchObject({ action: "accept" });
  });

  it("counters a lower offer in the first week with the 20 % limit", () => {
    expect(decideOffer(1400, 2000, daysAgo(2), rules, now)).toMatchObject({ action: "counter", cents: 1600, old: false });
  });

  it("accepts up to 30 % after a week", () => {
    expect(decideOffer(1400, 2000, daysAgo(8), rules, now)).toMatchObject({ action: "accept", maxPercent: 30, old: true });
  });

  it("counters a lower offer after a week with the 30 % limit in even euros", () => {
    // 25 € −30 % = 17,50 € → counter 18 € (even euros, not below the limit)
    expect(decideOffer(1000, 2500, daysAgo(10), rules, now)).toMatchObject({ action: "counter", cents: 1800 });
  });

  it("never counters at or above the price", () => {
    expect(decideOffer(100, 300, daysAgo(10), { ...rules, maxPercentOld: 0 }, now)).toMatchObject({ action: "skip" });
  });
});

describe("openOfferIn", () => {
  const other = { id: 55, login: "lena" };
  const conv = (messages: unknown[]) => ({ id: 9, transaction: { item_id: 123 }, messages }) as Parameters<typeof openOfferIn>[0];

  it("finds the buyer's open offer", () => {
    const o = openOfferIn(conv([
      { id: 1, entity_type: "message", entity: { body: "Hi", user_id: 55 } },
      { id: 2, entity_type: "offer_request_message", entity: { user_id: 55, price: { amount: "14.0", currency_code: "EUR" }, status: "pending" } },
    ]), "77", other);
    expect(o).toMatchObject({ conversationId: "9", vintedItemId: "123", priceCents: 1400, userId: "55", externalId: "9:2" });
  });

  it("ignores finished offers and our own last offer", () => {
    expect(openOfferIn(conv([
      { id: 2, entity_type: "offer_request_message", entity: { user_id: 55, price: { amount: "14.0" }, status_title: "Angebot angenommen" } },
    ]), "77", other)).toBeNull();
    expect(openOfferIn(conv([
      { id: 2, entity_type: "offer_request_message", entity: { user_id: 55, price: { amount: "14.0" } } },
      { id: 3, entity_type: "offer_message", entity: { user_id: 77, price: { amount: "16.0" } } },
    ]), "77", other)).toBeNull();
  });

  it("ignores Vinted's cancelled/expired offers (status 40, „Abgebrochen“)", () => {
    expect(openOfferIn(conv([
      { id: 2, entity_type: "offer_request_message", entity: { user_id: 55, price: { amount: "15.0" }, status: 40, status_title: "Abgebrochen", current: true } },
    ]), "77", other)).toBeNull();
  });

  it("returns nothing for a chat without offers", () => {
    expect(openOfferIn(conv([{ id: 1, entity_type: "message", entity: { body: "Noch da?" } }]), "77", other)).toBeNull();
  });
});

describe("favouriteFromNote", () => {
  it("reads member and item from Vinted's notification", () => {
    expect(favouriteFromNote({
      id: "cc1e", body: "agustdnuts hat deinen Artikel Steppweste favorisiert.", subject_id: 10883892035,
      link: "/items/10883892035/want_it/new?offering_id=295208712", updated_at: "2026-11-20T07:09:14+00:00",
    })).toEqual({ externalId: "cc1e", vintedItemId: "10883892035", userId: "295208712", username: "agustdnuts", occurredAt: "2026-11-20T07:09:14+00:00" });
    expect(favouriteFromNote({ id: 1, body: "x hat … favorisiert.", link: "vintedfr://messaging?item_id=5&user_id=7&portal=fr" }))
      .toMatchObject({ vintedItemId: "5", userId: "7" });
  });
  it("skips notifications without a member", () => {
    expect(favouriteFromNote({ id: 1, body: "Neuigkeiten", link: "/catalog" })).toBeNull();
  });
});
