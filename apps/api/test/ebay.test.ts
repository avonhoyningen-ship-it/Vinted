import http from "node:http";
import sharp from "sharp";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * eBay end to end against a fake eBay (its REST + Trading endpoints): connect with own keys,
 * list an article (photos, category, item specifics, offer, publish), and the cross-delisting:
 * sold on Vinted → ended on eBay; sold on eBay → deleted on Vinted.
 */
const calls: { method: string; path: string; body: unknown }[] = [];
let orders: unknown[] = [];
let server: http.Server;
let offerSeq = 0;

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://x");
    const body = (req.headers["content-type"] ?? "").includes("json") && raw ? JSON.parse(raw) : raw;
    calls.push({ method: req.method!, path: url.pathname + url.search, body });
    const json = (code: number, data: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    const p = url.pathname;
    if (p === "/identity/v1/oauth2/token") {
      return json(200, { access_token: "ebay-access", expires_in: 7200, refresh_token: "ebay-refresh", refresh_token_expires_in: 47304000 });
    }
    if (!/^Bearer ebay-access$/.test(String(req.headers.authorization)) && p !== "/ws/api.dll") return json(401, { errors: [{ errorId: 1001, message: "Invalid token" }] });
    if (p === "/ws/api.dll") {
      if (req.headers["x-ebay-api-iaf-token"] !== "ebay-access") { res.end("<Ack>Failure</Ack>"); return; }
      res.end(`<?xml version="1.0"?><UploadSiteHostedPicturesResponse><Ack>Success</Ack><SiteHostedPictureDetails><FullURL>https://i.ebayimg.com/images/g/pic${calls.length}/s-l1600.jpg</FullURL></SiteHostedPictureDetails></UploadSiteHostedPicturesResponse>`);
      return;
    }
    if (p === "/sell/account/v1/fulfillment_policy") return json(200, { fulfillmentPolicies: [{ fulfillmentPolicyId: "F1", name: "Hermes Paket" }] });
    if (p === "/sell/account/v1/payment_policy") return json(200, { paymentPolicies: [{ paymentPolicyId: "P1", name: "eBay-Zahlungsabwicklung" }] });
    if (p === "/sell/account/v1/return_policy") return json(200, { returnPolicies: [{ returnPolicyId: "R1", name: "Keine Rücknahme" }] });
    if (p.startsWith("/sell/inventory/v1/location/")) return json(204, {});
    if (p.endsWith("/get_default_category_tree_id")) return json(200, { categoryTreeId: "77" });
    if (p.endsWith("/get_category_suggestions")) return json(200, { categorySuggestions: [{ category: { categoryId: "15687", categoryName: "T-Shirts" } }] });
    if (p.endsWith("/get_item_aspects_for_category")) {
      return json(200, { aspects: [
        { localizedAspectName: "Marke", aspectConstraint: { aspectRequired: true, aspectMode: "FREE_TEXT" } },
        { localizedAspectName: "Größe", aspectConstraint: { aspectRequired: true, aspectMode: "FREE_TEXT" } },
        { localizedAspectName: "Abteilung", aspectConstraint: { aspectRequired: true, aspectMode: "SELECTION_ONLY" }, aspectValues: [{ localizedValue: "Herren" }, { localizedValue: "Damen" }] },
      ] });
    }
    if (p.startsWith("/sell/inventory/v1/inventory_item/")) return json(204, {});
    if (p === "/sell/inventory/v1/offer" && req.method === "POST") return json(201, { offerId: `O${++offerSeq}` });
    if (/^\/sell\/inventory\/v1\/offer\/O\d+\/publish$/.test(p)) return json(200, { listingId: `11000${offerSeq}` });
    if (/^\/sell\/inventory\/v1\/offer\/O\d+\/withdraw$/.test(p)) return json(200, { listingId: "x" });
    if (p === "/sell/fulfillment/v1/order") return json(200, { orders });
    return json(404, { errors: [{ errorId: 404, message: `fake: ${p}` }] });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.EBAY_API_BASE = base;
  process.env.EBAY_AUTH_BASE = base;
});

afterAll(() => {
  server?.close();
  delete process.env.EBAY_API_BASE;
  delete process.env.EBAY_AUTH_BASE;
});

const waitFor = async <T>(fn: () => Promise<T | undefined | false>, ms = 15_000): Promise<T> => {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 100));
  }
};

describe("eBay (official API)", async () => {
  const { createApp } = await import("../src/app.js");
  const app = createApp();
  const { db } = await import("../src/db/index.js");
  const jpg = (c: string) => sharp({ create: { width: 60, height: 80, channels: 3, background: c } }).jpeg().toBuffer();
  const draft = async (title: string, colour: string, price: number) => {
    const d = (await request(app).post("/api/listings/drafts").attach("photos", await jpg(colour), "1.jpg")
      .field("data", JSON.stringify({ title, price_cents: price, size: "M", category: "Herren > Kleidung > T-Shirts", brand: "Hollister", condition: "very_good" }))).body.item;
    await request(app).post("/api/pricing/set").send({ itemId: d.id, priceCents: price });
    return d.id as number;
  };
  let accountId = 0;

  it("connects with the seller's own developer keys", async () => {
    expect((await request(app).get("/api/ebay/status")).body).toMatchObject({ configured: false, connected: false });
    expect((await request(app).put("/api/ebay/config").send({ clientId: "MyApp-123", clientSecret: "SBX-secret", ruName: "My-RuName" })).status).toBe(200);
    const { url } = (await request(app).get("/api/ebay/connect")).body;
    expect(url).toMatch(/\/oauth2\/authorize\?client_id=MyApp-123&response_type=code&redirect_uri=My-RuName&scope=/);
    // eBay shows the code in the address after the login – the seller pastes it.
    expect((await request(app).post("/api/ebay/code").send({ code: "https://example.com/accepted?code=v%5E1.1-abc&expires_in=299" })).status).toBe(200);
    const token = calls.find((c) => c.path === "/identity/v1/oauth2/token")!;
    expect(String(token.body)).toContain("grant_type=authorization_code");
    expect(String(token.body)).toContain("code=v%5E1.1-abc");
    const st = (await request(app).get("/api/ebay/status")).body;
    expect(st).toMatchObject({ configured: true, connected: true, hasSecret: true });
    expect(JSON.stringify(st)).not.toContain("SBX-secret");

    const pol = (await request(app).get("/api/ebay/policies")).body;
    expect(pol.fulfillment).toEqual([{ id: "F1", name: "Hermes Paket" }]);
    expect((await request(app).put("/api/ebay/settings").send({ postalCode: "21073", fulfillmentPolicyId: "F1", paymentPolicyId: "P1", returnPolicyId: "R1" })).status).toBe(200);
  });

  it("lists an article directly on eBay – without the brand unless switched on", async () => {
    const id = await draft("Graphic Print Tee Weiß Y2K", "#eee", 2000);
    expect((await request(app).post("/api/ebay/list").send({ itemIds: [id] })).body).toEqual({ queued: 1 });
    const row = await waitFor(() => db.get<{ status: string; url: string; price_cents: number; error: string | null }>(
      "SELECT * FROM marketplace_listings WHERE item_id = ? AND status IN ('active','failed')", [id]));
    expect(row.error).toBeNull();
    expect(row).toMatchObject({ status: "active", url: expect.stringMatching(/^https:\/\/www\.ebay\.de\/itm\/11000\d+$/), price_cents: 2000 });

    const inv = calls.find((c) => c.method === "PUT" && c.path === `/sell/inventory/v1/inventory_item/ask-${id}`)!.body as {
      condition: string; product: { title: string; aspects: Record<string, string[]>; imageUrls: string[] } };
    expect(inv.condition).toBe("USED_EXCELLENT");
    // Brand switch off: never "Hollister" – the brand rule (T-Shirt/Tee → Graphic Tee) like on Vinted.
    expect(inv.product.aspects).toMatchObject({ Marke: ["Graphic Tee"], Größe: ["M"], Abteilung: ["Herren"] });
    expect(JSON.stringify(inv)).not.toMatch(/hollister/i);
    expect(inv.product.imageUrls[0]).toMatch(/^https:\/\/i\.ebayimg\.com\//);
    expect(calls.some((c) => c.path.startsWith("/sell/inventory/v1/location/ask-standort"))).toBe(true);
    const offer = calls.find((c) => c.method === "POST" && c.path === "/sell/inventory/v1/offer")!.body as Record<string, unknown>;
    expect(offer).toMatchObject({ sku: `ask-${id}`, marketplaceId: "EBAY_DE", format: "FIXED_PRICE", categoryId: "15687",
      pricingSummary: { price: { value: "20.00", currency: "EUR" } }, listingPolicies: { fulfillmentPolicyId: "F1", paymentPolicyId: "P1", returnPolicyId: "R1" } });
    expect((await request(app).get(`/api/archive/${id}`)).body.item.status).toBe("active"); // online on eBay
  });

  it("sold on Vinted → ended on eBay automatically", async () => {
    const acc = await request(app).post("/api/accounts").send({ name: "Shop eBay-Test", domain: "vinted.de", sessionToken: "token-ebay-shop" });
    accountId = acc.body.account.id;
    const id = Number((await db.get<{ item_id: number }>("SELECT item_id FROM marketplace_listings WHERE status = 'active' ORDER BY id LIMIT 1"))!.item_id);
    const l = (await request(app).post(`/api/archive/${id}/listings`).send({ accountId, url: "https://www.vinted.de/items/9090111-x", priceCents: 2000 })).body;
    await request(app).patch(`/api/archive/${id}/listings/${l.id}`).send({ status: "sold", soldPriceCents: 1900 });
    expect(calls.some((c) => /\/offer\/O\d+\/withdraw$/.test(c.path))).toBe(true);
    expect((await db.get<{ status: string }>("SELECT status FROM marketplace_listings WHERE item_id = ? ORDER BY id DESC LIMIT 1", [id]))!.status).toBe("ended");
  });

  it("sold on eBay → deleted on Vinted, article counts as sold", async () => {
    const { setReuploadDeps } = await import("../src/modules/reupload/service.js");
    const deletedOnVinted: string[] = [];
    setReuploadDeps({ deleter: async (job) => { deletedOnVinted.push(job.vintedItemId); return { ok: true, message: "Auf Vinted gelöscht" }; } });
    const id = await draft("Racecar Graphic Tee Schwarz", "#111", 1800);
    await request(app).post("/api/ebay/list").send({ itemIds: [id] });
    const row = await waitFor(() => db.get<{ sku: string; external_id: string }>("SELECT * FROM marketplace_listings WHERE item_id = ? AND status = 'active'", [id]));
    const l = (await request(app).post(`/api/archive/${id}/listings`).send({ accountId, url: "https://www.vinted.de/items/9090222-x", priceCents: 1800 })).body;

    orders = [{ orderId: "26-1", creationDate: new Date().toISOString(), lineItems: [{ sku: row.sku, legacyItemId: row.external_id, total: { value: "18.00" } }] }];
    const { pollEbayOrders } = await import("../src/modules/marketplaces/ebay/service.js");
    expect(await pollEbayOrders()).toBe(1);
    expect(deletedOnVinted).toEqual(["9090222"]);
    expect((await db.get<{ status: string }>("SELECT status FROM listings WHERE id = ?", [l.id]))!.status).toBe("removed");
    expect((await db.get<{ status: string; sold_price_cents: number }>("SELECT status, sold_price_cents FROM marketplace_listings WHERE item_id = ? AND platform = 'ebay' ORDER BY id DESC LIMIT 1", [id]))).toEqual({ status: "sold", sold_price_cents: 1800 });
    expect((await request(app).get(`/api/archive/${id}`)).body.item.status).toBe("sold");
    // The same order again: nothing happens twice.
    expect(await pollEbayOrders()).toBe(0);
  });
});
