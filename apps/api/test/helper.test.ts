import http from "node:http";
import fs from "node:fs";
import sharp from "sharp";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AssistStatus } from "../src/lib/eventBus.js";
import type { AssistSource } from "../src/modules/assist/assistant.js";
import type { StoredLogin } from "../src/helper/runtime.js";

/**
 * Cloud dashboard + PC helper end to end: pairing key, account connection
 * through the Vinted-Chrome (the login stays on the PC), Vinted sync via the
 * helper and the posting assistant with photos from the cloud.
 * Vinted and Chrome are fakes; cloud API and helper are the real code.
 */
let app: import("express").Express;
let server: http.Server;
let base = "";
let db: typeof import("../src/db/index.js");
const logins = new Map<number, StoredLogin>();
let assistSource: AssistSource | null = null;
const assistCalls: { itemIds: number[]; accountId: number }[] = [];
let stopHelper = false;
let helperLoop: Promise<void> | null = null;

const idle: AssistStatus = { state: "idle", itemId: null, title: null, position: 0, total: 0, filled: [], missing: [], message: null, done: [], fields: [], tabs: [] };

beforeAll(async () => {
  Object.assign(process.env, { APP_MODE: "cloud", APP_URL: "https://app.example.com" });
  vi.resetModules();
  db = await import("../src/db/index.js");
  const { applyPgSchema, postgresDriver } = await import("../src/db/postgres.js");
  const { pgliteConnector } = await import("./support/pglite.js");
  const connector = await pgliteConnector();
  await applyPgSchema(connector);
  db.setDriver(postgresDriver(connector, { scope: db.scopeUserId }));
  await db.withSystem(() => db.db.run("INSERT INTO app_users (id, email, subscription_status) VALUES ('user_alice', 'a@x.de', 'active'), ('user_bob', 'b@x.de', 'active')"));
  const { setTokenVerifier } = await import("../src/cloud/auth.js");
  setTokenVerifier(async (t) => {
    if (!t.startsWith("tok_")) throw new Error("not a Clerk session");
    return { userId: `user_${t.replace("tok_", "")}`, email: null };
  });
  const { localStore, setPhotoStore } = await import("../src/storage/store.js");
  setPhotoStore(localStore(fs.mkdtempSync("/tmp/helper-photos-")));
  app = (await import("../src/app.js")).createApp();
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 60_000);

afterAll(async () => {
  stopHelper = true;
  server?.closeAllConnections(); // ends the helper's open long poll
  server?.close();
  await Promise.race([helperLoop, new Promise((r) => setTimeout(r, 2000))]);
});

const as = (u: string) => ({ Authorization: `Bearer tok_${u}` });

async function startHelper(token: string) {
  const { createHelper } = await import("../src/helper/runtime.js");
  const { VintedClient } = await import("../src/vinted/vintedClient.js");
  const { mockAdapter } = await import("./support/mockAdapter.js");
  const helper = createHelper({
    cloud: (p, init = {}) => fetch(`${base}${p}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, ...(init.json !== undefined ? { "content-type": "application/json" } : {}) },
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    }),
    vinted: new VintedClient(mockAdapter, 0),
    logins: { get: (id) => logins.get(id), set: (id, l) => void logins.set(id, l), delete: (id) => void logins.delete(id) },
    // The seller is logged in at vinted.de in the Vinted-Chrome.
    readVintedCookies: async (domain) => (domain === "vinted.de" ? { access: "token-helper-account", refresh: "refresh-xyz" } : { access: null, refresh: null }),
    assistant: {
      setSource: (s) => { assistSource = s; },
      start: async (itemIds, accountId) => {
        assistCalls.push({ itemIds, accountId });
        return { ...idle, state: "preparing", total: itemIds.length };
      },
      skip: () => {},
      stop: () => {},
      status: () => idle,
    },
  });
  helperLoop = (async () => {
    while (!stopHelper) await helper.pollOnce().catch(() => new Promise((r) => setTimeout(r, 200)));
  })();
  // wait until the cloud sees the helper as online
  for (let i = 0; i < 50; i++) {
    if ((await request(app).get("/api/helper-tokens").set(as("alice"))).body.status?.online) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("helper not online");
}

describe("cloud + PC helper", () => {
  let accountId: number;
  let token: string;

  it("explains when the helper is not running", async () => {
    const acc = await request(app).post("/api/accounts").set(as("alice")).send({ name: "Mein Shop", domain: "vinted.de" });
    expect(acc.status).toBe(201);
    accountId = acc.body.account.id;
    const res = await request(app).post(`/api/accounts/${accountId}/connect-helper`).set(as("alice"));
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/PC-Helfer ist nicht verbunden/);
  });

  it("never accepts a Vinted login in the cloud", async () => {
    const res = await request(app).post("/api/accounts").set(as("alice")).send({ name: "X", domain: "vinted.de", sessionToken: "eyJhbGciOi.secret.token" });
    expect(res.status).toBe(400);
  });

  it("pairs the helper with a key that only works for its owner", async () => {
    const created = await request(app).post("/api/helper-tokens").set(as("alice")).send({ name: "Laptop" });
    expect(created.status).toBe(201);
    token = created.body.token;
    expect(token).toMatch(/^ask_/);
    expect((await request(app).post("/api/helper/poll").set({ Authorization: "Bearer ask_wrongwrongwrongwrongwrong" })).status).toBe(401);
    // Clerk sessions don't work on helper routes and helper keys don't open the dashboard.
    expect((await request(app).post("/api/helper/poll").set(as("alice"))).status).toBe(401);
    expect((await request(app).get("/api/archive").set({ Authorization: `Bearer ${token}` })).status).toBe(401);
    const list = await request(app).get("/api/helper-tokens").set(as("alice"));
    expect(list.body.tokens[0]).toMatchObject({ name: "Laptop" });
    expect(JSON.stringify(list.body)).not.toContain(token);
  });

  it("connects the account through the Vinted-Chrome – the login stays on the PC", async () => {
    await startHelper(token);
    const res = await request(app).post(`/api/accounts/${accountId}/connect-helper`).set(as("alice"));
    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
    expect(res.body.account).toMatchObject({ status: "connected", has_session: true, session_hint: "PC-Helfer ••••ount" });
    expect(logins.get(accountId)).toMatchObject({ token: "token-helper-account", refreshToken: "refresh-xyz", domain: "vinted.de" });
    const row = await db.withUser("user_alice", () => db.db.get<Record<string, unknown>>("SELECT * FROM accounts WHERE id = ?", [accountId]));
    expect(JSON.stringify(row)).not.toContain("token-helper-account");
    // The first sync ran through the helper and imported the shop's listings.
    const archive = await request(app).get("/api/archive").set(as("alice"));
    expect(archive.body.total).toBeGreaterThan(0);
  });

  it("syncs again through the helper", async () => {
    const res = await request(app).post(`/api/accounts/${accountId}/sync`).set(as("alice"));
    expect(res.status).toBe(200);
    expect(res.body.account.status).toBe("connected");
  });

  it("runs the posting assistant on the PC with photos from the cloud and links the upload", async () => {
    const jpg = await sharp({ create: { width: 30, height: 40, channels: 3, background: "#0a0" } }).jpeg().toBuffer();
    const draft = await request(app).post("/api/listings/drafts").set(as("alice")).attach("photos", jpg, "1.jpg")
      .field("data", JSON.stringify({ title: "Grünes Tee", price_cents: 1900, size: "M", condition: "very_good" }));
    const itemId = draft.body.item.id;

    const start = await request(app).post("/api/assist/start").set(as("alice")).send({ itemIds: [itemId], accountId });
    expect(start.status).toBe(200);
    expect(start.body.state).toBe("preparing");
    expect(assistCalls.at(-1)).toEqual({ itemIds: [itemId], accountId });

    // The engine asks for the item: data + photos downloaded from the cloud.
    const data = await assistSource!.load({ itemId, accountId });
    expect(data).toMatchObject({ title: "Grünes Tee", price: "19", size: "M", condition: "Sehr gut", brand: "Graphic Tee", parcel: "Klein", domain: "vinted.de" });
    expect(data.photoFiles).toHaveLength(1);
    expect(fs.readFileSync(data.photoFiles[0]!).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));

    // Status updates reach the dashboard; the seller's upload gets linked.
    assistSource!.publish({ ...idle, state: "waiting", message: "1 Tab bereit", total: 1 });
    await assistSource!.linked({ itemId, accountId }, "https://www.vinted.de/items/99887766-gruenes-tee");
    await new Promise((r) => setTimeout(r, 200));
    expect((await request(app).get("/api/assist/status").set(as("alice"))).body).toMatchObject({ state: "waiting", message: "1 Tab bereit" });
    const detail = await request(app).get(`/api/archive/${itemId}`).set(as("alice"));
    expect(detail.body.item.status).toBe("active");
    expect(detail.body.listings[0]).toMatchObject({ vinted_item_id: "99887766", price_cents: 1900 });
  });

  it("keeps helpers of different users apart", async () => {
    // Bob has no helper: his requests never reach Alice's helper.
    const acc = await request(app).post("/api/accounts").set(as("bob")).send({ name: "Bobs Shop", domain: "vinted.de" });
    const res = await request(app).post(`/api/accounts/${acc.body.account.id}/connect-helper`).set(as("bob"));
    expect(res.status).toBe(503);
    expect(logins.has(acc.body.account.id)).toBe(false);
  });

  it("stops working when the key is revoked", async () => {
    const list = await request(app).get("/api/helper-tokens").set(as("alice"));
    expect((await request(app).delete(`/api/helper-tokens/${list.body.tokens[0].id}`).set(as("alice"))).status).toBe(204);
    expect((await request(app).post("/api/helper/poll").set({ Authorization: `Bearer ${token}` })).status).toBe(401);
  });
});
