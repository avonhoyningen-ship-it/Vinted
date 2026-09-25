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

  // Fake Supabase Storage: bucket + objects in memory.
  const http = await import("node:http");
  storage = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (req.headers.authorization !== "Bearer service_role_key") return res.writeHead(401).end();
    const url = decodeURIComponent(req.url ?? "");
    let m;
    if (req.method === "POST" && url === "/storage/v1/bucket") return res.writeHead(200).end("{}");
    if (req.method === "POST" && (m = /^\/storage\/v1\/object\/photos\/(.+)$/.exec(url))) {
      objects.set(m[1]!, Buffer.concat(chunks));
      return res.writeHead(200).end("{}");
    }
    if (req.method === "GET" && (m = /^\/storage\/v1\/object\/authenticated\/photos\/(.+)$/.exec(url))) {
      return objects.has(m[1]!) ? res.writeHead(200).end(objects.get(m[1]!)) : res.writeHead(404).end();
    }
    if (req.method === "POST" && (m = /^\/storage\/v1\/object\/sign\/photos\/(.+)$/.exec(url))) {
      if (!objects.has(m[1]!)) return res.writeHead(400).end("{}");
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ signedURL: `/object/sign/photos/${m[1]}?token=t` }));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => storage.listen(0, "127.0.0.1", r));
  const { setPhotoStore, supabaseStore } = await import("../src/storage/store.js");
  setPhotoStore(supabaseStore({ url: `http://127.0.0.1:${(storage.address() as { port: number }).port}`, serviceKey: "service_role_key", bucket: "photos" }));

  app = (await import("../src/app.js")).createApp();
}, 60_000);

let storage: import("node:http").Server;
const objects = new Map<string, Buffer>();

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

  it("stores photos in the user's own Supabase folder and serves them via signed URLs", async () => {
    const sharp = (await import("sharp")).default;
    const jpg = await sharp({ create: { width: 40, height: 40, channels: 3, background: "#e33" } }).jpeg().toBuffer();
    const draft = await request(app).post("/api/listings/drafts").set(as("alice")).attach("photos", jpg, "a.jpg").field("data", JSON.stringify({ title: "Rotes Shirt" }));
    expect(draft.status).toBe(201);
    const file = draft.body.photos[0].file_name as string;
    expect([...objects.keys()]).toContain(`user_alice/${file}`);

    const own = await request(app).get(`/api/photos/${file}`).set(as("alice"));
    expect(own.status).toBe(302);
    expect(own.headers.location).toMatch(new RegExp(`/storage/v1/object/sign/photos/user_alice/${file}\\?token=`));
    // Bob knows the file name but only ever looks into his own folder.
    expect((await request(app).get(`/api/photos/${file}`).set(as("bob"))).status).toBe(404);
    expect((await request(app).get("/api/photos/..%2F..%2Fetc%2Fpasswd").set(as("alice"))).status).toBe(404);

    // ZIP download reads the photos back from storage
    const zip = await request(app).get(`/api/archive/${draft.body.item.id}/photos.zip`).set(as("alice"));
    expect(zip.status).toBe(200);
    expect(zip.headers["content-type"]).toBe("application/zip");
  });

  it("runs the posting assistant only through the PC helper in the cloud", async () => {
    expect((await request(app).get("/api/assist/status").set(as("alice"))).body.state).toBe("idle");
    const items = (await request(app).get("/api/archive").set(as("alice"))).body.items as { id: number; photo_count: number }[];
    const withPhoto = items.find((i) => Number(i.photo_count) > 0)!;
    const acc = await request(app).post("/api/accounts").set(as("alice")).send({ name: "Shop", domain: "vinted.de" });
    const res = await request(app).post("/api/assist/start").set(as("alice")).send({ itemIds: [withPhoto.id], accountId: acc.body.account.id });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/PC-Helfer/);
  });
});

describe("stripe:setup", () => {
  it("creates product, monthly price, webhook with all events and the customer portal – and reuses them", async () => {
    const { setupStripe, WEBHOOK_EVENTS } = await import("../src/tools/stripeSetup.js");
    const state = { products: [] as { id: string; name: string }[], prices: [] as Record<string, unknown>[], hooks: [] as Record<string, unknown>[], portals: 0 };
    const fake = {
      products: { list: async () => ({ data: state.products }), create: async (p: { name: string }) => { const x = { id: `prod_${state.products.length + 1}`, name: p.name }; state.products.push(x); return x; } },
      prices: {
        list: async () => ({ data: state.prices }),
        create: async (p: Record<string, unknown>) => { const x = { id: "price_1", ...p, unit_amount: p.unit_amount }; state.prices.push(x); return x; },
      },
      webhookEndpoints: {
        list: async () => ({ data: state.hooks }),
        create: async (p: Record<string, unknown>) => { const x = { id: "we_1", secret: "whsec_new", ...p }; state.hooks.push(x); return x; },
        update: async () => ({}),
      },
      billingPortal: { configurations: { create: async () => { state.portals++; return {}; } } },
    } as unknown as import("stripe").default;
    const first = await setupStripe(fake, { apiUrl: "https://api.example.com/", amountCents: 999, appUrl: "https://app.example.com" });
    expect(first).toMatchObject({ priceId: "price_1", webhookSecret: "whsec_new", webhookUrl: "https://api.example.com/api/billing/webhook" });
    expect(state.prices[0]).toMatchObject({ unit_amount: 999, currency: "eur", recurring: { interval: "month" } });
    expect(state.hooks[0]!.enabled_events).toEqual(WEBHOOK_EVENTS);
    const again = await setupStripe(fake, { apiUrl: "https://api.example.com", amountCents: 999 });
    expect(again.webhookSecret).toBeNull();
    expect(state.products).toHaveLength(1);
    expect(state.prices).toHaveLength(1);
    expect(state.hooks).toHaveLength(1);
  });
});
