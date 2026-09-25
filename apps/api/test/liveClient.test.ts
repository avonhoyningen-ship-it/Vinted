import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { db, getDriver } from "../src/db/index.js";
import { removeDemoData } from "../src/db/migrations.js";
import type { SqliteDB } from "../src/db/sqlite.js";
import { liveAdapter, resetLiveSessions } from "../src/vinted/liveAdapter.js";
import { vintedClient, VintedError } from "../src/vinted/vintedClient.js";
import { mockAdapter } from "./support/mockAdapter.js";

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload: object) => `${b64({ alg: "PS256", typ: "JWT" })}.${b64(payload)}.c2lnbmF0dXJl`;
const inOneDay = () => Math.floor(Date.now() / 1000) + 86400;
const userToken = jwt({ sub: 4242, scope: "user", exp: inOneDay(), purpose: "access" });

type Route = (url: URL, init: RequestInit) => Response | undefined;
const calls: { url: string; cookie: string }[] = [];

function stubVinted(route: Route) {
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    calls.push({ url: url.pathname + url.search, cookie: String((init.headers as Record<string, string>)?.cookie ?? "") });
    if (url.pathname === "/") {
      return new Response("<html></html>", { status: 200, headers: { "content-type": "text/html", "set-cookie": "anon_id=abc; Path=/" } });
    }
    return route(url, init) ?? new Response(JSON.stringify({ code: 404 }), { status: 404, headers: { "content-type": "application/json" } });
  }));
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const realVinted: Route = (url) => {
  if (url.pathname === "/api/v2/users/current") {
    return json({ user: { id: 4242, login: "linnea_shop", followers_count: 17, item_count: 1, given_item_count: 5 } });
  }
  if (url.pathname === "/api/v2/inbox") return json({ conversations: [{ unread: true }, { unread: false }] });
  if (url.pathname === "/api/v2/wardrobe/4242/items") {
    return json({
      items: [
        { id: 1, title: "Echte Bluse", price: { amount: "12.5", currency_code: "EUR" }, brand_title: "Mango", size_title: "S",
          status: "Sehr gut", favourite_count: 3, view_count: 40, url: "/items/1-echte-bluse", photos: [] },
        { id: 2, title: "Schon verkauft", price: "20.0", is_closed: true, photos: [] },
        { id: 3, title: "Entwurf", price: "5.0", is_draft: true, photos: [] },
      ],
      pagination: { total_pages: 1 },
    });
  }
  return undefined;
};

beforeAll(() => vintedClient.useAdapter(liveAdapter, 0));
afterEach(() => { vi.unstubAllGlobals(); calls.length = 0; resetLiveSessions(); });
afterAll(() => vintedClient.useAdapter(mockAdapter, 0));

const session = (token: string, extra: object = {}) => ({ token, domain: "vinted.de", ...extra });

describe("live Vinted client", () => {
  it("rejects values that are not a Vinted token without calling Vinted", async () => {
    stubVinted(() => undefined);
    await expect(liveAdapter.verifySession(session("demo-token-de-123"))).rejects.toThrow(/kein gültiges access_token_web/);
    expect(calls).toHaveLength(0);
  });

  it("explains anonymous (not logged-in) tokens", async () => {
    stubVinted(() => undefined);
    const anon = jwt({ scope: "public", exp: inOneDay(), purpose: "access" });
    await expect(liveAdapter.verifySession(session(anon))).rejects.toThrow(/keinem angemeldeten Nutzer/);
    expect(calls).toHaveLength(0);
  });

  it("reports an expired token with its date", async () => {
    stubVinted(() => undefined);
    const expired = jwt({ sub: 1, scope: "user", exp: 1_700_000_000 });
    await expect(liveAdapter.verifySession(session(expired))).rejects.toThrow(/abgelaufen/);
  });

  it("loads the logged-in user and only real listings, sending the stored cookie", async () => {
    stubVinted(realVinted);
    const profile = await liveAdapter.verifySession(session(userToken));
    expect(profile).toEqual({ userId: "4242", username: "linnea_shop", followers: 17, activeListings: 1, totalSales: 5, unreadMessages: 1 });
    const listings = await liveAdapter.fetchOwnListings(session(userToken, { vintedUserId: "4242" }));
    expect(listings.map((l) => [l.title, l.status])).toEqual([["Echte Bluse", "active"], ["Schon verkauft", "sold"]]);
    expect(listings[0]).toMatchObject({ priceCents: 1250, brand: "Mango", url: "https://www.vinted.de/items/1-echte-bluse" });
    const api = calls.find((c) => c.url.startsWith("/api/v2/users/current"))!;
    expect(api.cookie).toContain(`access_token_web=${userToken}`);
    expect(api.cookie).toContain("anon_id=abc");
  }, 20_000);

  it("turns Vinted's bot challenge into a clear 'blocked' error", async () => {
    stubVinted(() => new Response("<html>Please wait. Enable JavaScript and cookies to continue</html>", { status: 403, headers: { "content-type": "text/html" } }));
    const err = await liveAdapter.verifySession(session(userToken)).catch((e) => e);
    expect(err).toBeInstanceOf(VintedError);
    expect(err.code).toBe("blocked");
    expect(err.message).toMatch(/Bot-Schutz/);
  }, 20_000);

  it("turns Vinted's access_denied into an auth error", async () => {
    stubVinted(() => json({ code: 106, message: "Zugang verweigert", message_code: "access_denied" }, 403));
    const err = await liveAdapter.verifySession(session(userToken)).catch((e) => e);
    expect(err.code).toBe("auth");
    expect(err.message).toMatch(/Zugang verweigert/);
  }, 20_000);
});

describe("connecting an account (real client)", () => {
  const app = createApp();

  it("imports the real profile and active listings – no demo data", async () => {
    stubVinted(realVinted);
    const res = await request(app).post("/api/accounts").send({ name: "Mein Shop", domain: "vinted.de", sessionToken: userToken });
    expect(res.body.error).toBeNull();
    expect(res.body.account).toMatchObject({ username: "linnea_shop", followers: 17, status: "connected", vinted_user_id: "4242" });
    const archive = await request(app).get("/api/archive").query({ accountId: res.body.account.id });
    expect(archive.body.items.map((i: { title: string }) => i.title)).toEqual(["Echte Bluse"]);
    expect(JSON.stringify(archive.body)).not.toMatch(/Levi|Nike|Zara|reseller_/);
  }, 30_000);

  it("does not pretend to publish: the queue is blocked with a clear message", async () => {
    const acc = (await db.get("SELECT id FROM accounts WHERE status = 'connected' LIMIT 1")) as { id: number };
    const item = (await request(app).post("/api/archive").send({ title: "Test", price_cents: 1000 })).body;
    const res = await request(app).post("/api/listings/queue").send({ itemIds: [item.id], accountId: Number(acc.id) });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Bei Vinted einstellen/);
    expect((await request(app).get("/api/info")).body.canPublish).toBe(false);
  });

  it("fails with a clear message instead of falling back to demo data", async () => {
    stubVinted(() => json({ code: 106, message: "Zugang verweigert", message_code: "access_denied" }, 403));
    const res = await request(app).post("/api/accounts").send({ name: "Kaputt", domain: "vinted.de", sessionToken: userToken });
    expect(res.body.account.status).toBe("error");
    expect(res.body.error).toMatch(/Zugang verweigert/);
    const archive = await request(app).get("/api/archive").query({ accountId: res.body.account.id });
    expect(archive.body.total).toBe(0);
  }, 30_000);
});

// Only the local SQLite database ever had demo data.
describe.skipIf(process.env.TEST_DB === "postgres")("demo data cleanup", () => {
  it("removes demo accounts and seed items but keeps the user's own items", async () => {
    const acc = (await db.insert("INSERT INTO accounts (name, domain, vinted_user_id, username, status) VALUES ('Demo', 'vinted.de', 'mock-c9e3aaaa', 'reseller_c9e3', 'connected')"));
    const seed = (await db.insert("INSERT INTO items (title, status) VALUES ('Levi''s 501 Jeans W32 L32', 'active')"));
    const own = (await db.insert("INSERT INTO items (title, status) VALUES ('Meine Jacke', 'active')"));
    (await db.run("INSERT INTO item_photos (item_id, file_name, mime_type, sha256) VALUES (?, 'x.jpg', 'image/jpeg', 'abc')", [own]));
    for (const item of [seed, own]) {
      const l = (await db.insert("INSERT INTO listings (item_id, account_id, vinted_item_id, title) VALUES (?, ?, ?, 't')", [item, acc, `v${item}`]));
      (await db.run("INSERT INTO sales (account_id, listing_id, item_id, external_id, title, price_cents, sold_at) VALUES (?, ?, ?, ?, 't', 100, '2026-01-01')", [acc, l, item, `s${item}`]));
    }

    expect(removeDemoData(getDriver().raw as SqliteDB)).toEqual({ accounts: 1, items: 1 });
    expect((await db.get("SELECT COUNT(*) c FROM accounts WHERE vinted_user_id LIKE 'mock-%'"))).toMatchObject({ c: 0 });
    expect((await db.get("SELECT id FROM items WHERE id = ?", [seed]))).toBeUndefined();
    expect((await db.get("SELECT status FROM items WHERE id = ?", [own]))).toMatchObject({ status: "draft" });
    expect((await db.get("SELECT COUNT(*) c FROM sales WHERE account_id = ?", [acc]))).toMatchObject({ c: 0 });
  });
});
