import request from "supertest";
import type Stripe from "stripe";
import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Cloud mode end to end: Clerk session → no subscription (402) → Stripe
 * Checkout → signed webhooks → access → cancellation → access blocked again.
 * Clerk is replaced by a fake token check, Stripe's API calls by stubs; the
 * webhook signatures are real (Stripe's own signing helper).
 */
const WEBHOOK_SECRET = "whsec_test_secret";

let app: import("express").Express;
let stripe: Stripe;
const subs = new Map<string, Partial<Stripe.Subscription>>();
const checkoutCalls: Stripe.Checkout.SessionCreateParams[] = [];

beforeAll(async () => {
  Object.assign(process.env, {
    APP_MODE: "cloud", APP_URL: "https://app.example.com", STRIPE_SECRET_KEY: "sk_test_dummy",
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_PRICE_ID: "price_monthly",
  });
  vi.resetModules();
  const { setDriver, scopeUserId } = await import("../src/db/index.js");
  const { applyPgSchema, postgresDriver } = await import("../src/db/postgres.js");
  const { pgliteConnector } = await import("./support/pglite.js");
  const connector = await pgliteConnector();
  await applyPgSchema(connector);
  setDriver(postgresDriver(connector, { scope: scopeUserId })); // no default user: like production

  const { setTokenVerifier } = await import("../src/cloud/auth.js");
  setTokenVerifier(async (token) => {
    const m = /^tok_(\w+)$/.exec(token);
    if (!m) throw new Error("invalid");
    return { userId: `user_${m[1]}`, email: `${m[1]}@example.com` };
  });

  const { default: StripeCtor } = await import("stripe");
  stripe = new StripeCtor("sk_test_dummy");
  let n = 0;
  Object.assign(stripe.customers, { create: async (p: Stripe.CustomerCreateParams) => ({ id: `cus_${++n}`, metadata: p.metadata }) });
  Object.assign(stripe.checkout.sessions, {
    create: async (p: Stripe.Checkout.SessionCreateParams) => {
      checkoutCalls.push(p);
      return { id: `cs_${n}`, url: `https://checkout.stripe.com/c/pay/cs_${n}` };
    },
  });
  Object.assign(stripe.billingPortal.sessions, { create: async () => ({ url: "https://billing.stripe.com/p/session_1" }) });
  Object.assign(stripe.subscriptions, { retrieve: async (id: string) => subs.get(id) });
  Object.assign(stripe.prices, { retrieve: async () => ({ unit_amount: 999, currency: "eur", recurring: { interval: "month" } }) });
  const { setStripe } = await import("../src/cloud/billing.js");
  setStripe(stripe);

  app = (await import("../src/app.js")).createApp();
}, 60_000);

function webhook(type: string, object: object, secret = WEBHOOK_SECRET) {
  const payload = JSON.stringify({ id: `evt_${Math.random()}`, object: "event", type, data: { object } });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
  return request(app).post("/api/billing/webhook").set("stripe-signature", header).set("content-type", "application/json").send(payload);
}

const as = (user: string) => ({ Authorization: `Bearer tok_${user}` });
const future = Math.floor(Date.now() / 1000) + 30 * 86400;

describe("cloud: login, subscription, access", () => {
  it("requires a Clerk session", async () => {
    expect((await request(app).get("/api/archive")).status).toBe(401);
    expect((await request(app).get("/api/archive").set({ Authorization: "Bearer forged" })).status).toBe(401);
    expect((await request(app).get("/api/health")).status).toBe(200);
  });

  it("blocks the app without a subscription but shows the upgrade info", async () => {
    const res = await request(app).get("/api/archive").set(as("alice"));
    expect(res.status).toBe(402);
    expect(res.body.code).toBe("subscription_required");
    const me = await request(app).get("/api/me").set(as("alice"));
    expect(me.body).toMatchObject({ userId: "user_alice", email: "alice@example.com", active: false, subscription: { status: "none" } });
    expect(me.body.price).toEqual({ amount: 999, currency: "eur", interval: "month" });
  });

  it("starts Stripe Checkout with card + PayPal, linked to the Clerk user", async () => {
    const res = await request(app).post("/api/billing/checkout").set(as("alice"));
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(checkoutCalls[0]).toMatchObject({
      mode: "subscription", client_reference_id: "user_alice", customer: "cus_1", payment_method_types: ["card", "paypal"],
      line_items: [{ price: "price_monthly", quantity: 1 }], subscription_data: { metadata: { clerk_user_id: "user_alice" } },
      success_url: "https://app.example.com/abo?status=success",
    });
  });

  it("rejects webhooks with a wrong signature", async () => {
    const res = await webhook("customer.subscription.updated", { id: "sub_x" }, "whsec_wrong");
    expect(res.status).toBe(400);
  });

  it("activates the subscription after checkout (webhook) and unlocks the app", async () => {
    subs.set("sub_alice", {
      id: "sub_alice", object: "subscription", status: "active", customer: "cus_1", cancel_at_period_end: false,
      metadata: { clerk_user_id: "user_alice" }, items: { data: [{ current_period_end: future }] } as unknown as Stripe.Subscription["items"],
    });
    const res = await webhook("checkout.session.completed", {
      id: "cs_1", object: "checkout.session", mode: "subscription", client_reference_id: "user_alice", subscription: "sub_alice", customer: "cus_1",
    });
    expect(res.status).toBe(200);
    const me = await request(app).get("/api/me").set(as("alice"));
    expect(me.body).toMatchObject({ active: true, subscription: { status: "active", currentPeriodEnd: new Date(future * 1000).toISOString() } });
    expect((await request(app).get("/api/archive").set(as("alice"))).status).toBe(200);
    // Already subscribed → no second checkout
    expect((await request(app).post("/api/billing/checkout").set(as("alice"))).status).toBe(409);
  });

  it("keeps every user's data separate", async () => {
    await request(app).post("/api/archive").set(as("alice")).send({ title: "Sakura Tee von Alice" });
    // Bob subscribes as well
    await request(app).post("/api/billing/checkout").set(as("bob"));
    subs.set("sub_bob", { id: "sub_bob", status: "active", customer: "cus_2", metadata: { clerk_user_id: "user_bob" }, items: { data: [] } as unknown as Stripe.Subscription["items"] });
    await webhook("customer.subscription.created", subs.get("sub_bob")!);
    const bob = await request(app).get("/api/archive").set(as("bob"));
    expect(bob.status).toBe(200);
    expect(bob.body.total).toBe(0);
    const alice = await request(app).get("/api/archive").set(as("alice"));
    expect(alice.body.items.map((i: { title: string }) => i.title)).toEqual(["Sakura Tee von Alice"]);
    const aliceItem = alice.body.items[0].id;
    expect((await request(app).get(`/api/archive/${aliceItem}`).set(as("bob"))).status).toBe(404);
    expect((await request(app).delete(`/api/archive/${aliceItem}`).set(as("bob"))).status).toBe(404);
  });

  it("renews on invoice.paid, keeps access during a failed payment retry", async () => {
    const later = future + 30 * 86400;
    subs.set("sub_alice", { ...subs.get("sub_alice")!, items: { data: [{ current_period_end: later }] } as unknown as Stripe.Subscription["items"] });
    await webhook("invoice.paid", { id: "in_1", object: "invoice", parent: { subscription_details: { subscription: "sub_alice" } } });
    expect((await request(app).get("/api/me").set(as("alice"))).body.subscription.currentPeriodEnd).toBe(new Date(later * 1000).toISOString());

    subs.set("sub_alice", { ...subs.get("sub_alice")!, status: "past_due" });
    await webhook("invoice.payment_failed", { id: "in_2", object: "invoice", subscription: "sub_alice" });
    const me = await request(app).get("/api/me").set(as("alice"));
    expect(me.body.subscription.status).toBe("past_due");
    expect(me.body.active).toBe(true);
  });

  it("opens the customer portal to manage or cancel", async () => {
    const res = await request(app).post("/api/billing/portal").set(as("alice"));
    expect(res.body.url).toBe("https://billing.stripe.com/p/session_1");
  });

  it("locks the app once the subscription is cancelled/expired", async () => {
    subs.set("sub_alice", { ...subs.get("sub_alice")!, status: "canceled" });
    await webhook("customer.subscription.deleted", subs.get("sub_alice")!);
    expect((await request(app).get("/api/me").set(as("alice"))).body).toMatchObject({ active: false, subscription: { status: "canceled" } });
    expect((await request(app).get("/api/archive").set(as("alice"))).status).toBe(402);
    // Data stays – re-subscribing unlocks it again.
    subs.set("sub_alice", { ...subs.get("sub_alice")!, status: "active" });
    await webhook("customer.subscription.updated", subs.get("sub_alice")!);
    expect((await request(app).get("/api/archive").set(as("alice"))).body.total).toBe(1);
  });

  it("does not offer the local posting assistant in the cloud", async () => {
    expect((await request(app).get("/api/assist/status").set(as("alice"))).status).toBe(404);
  });
});
