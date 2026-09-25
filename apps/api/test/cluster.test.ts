import http from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { StoredLogin } from "../src/helper/runtime.js";

/**
 * Two API instances (two separately loaded copies of the app) on one Postgres:
 * the PC helper is connected to instance B, the dashboard talks to instance A.
 * Jobs, results and live events must travel between them (LISTEN/NOTIFY),
 * and background jobs must only run on one instance at a time.
 */
type Instance = { app: import("express").Express; server: http.Server; base: string; db: typeof import("../src/db/index.js") };

let A: Instance;
let B: Instance;
let stop = false;
let loop: Promise<void> | null = null;

async function instance(connector: import("../src/db/postgres.js").PgConnector): Promise<Instance> {
  vi.resetModules();
  const db = await import("../src/db/index.js");
  const { postgresDriver } = await import("../src/db/postgres.js");
  db.setDriver(postgresDriver(connector, { scope: db.scopeUserId }));
  const { setTokenVerifier } = await import("../src/cloud/auth.js");
  setTokenVerifier(async (t) => {
    if (!t.startsWith("tok_")) throw new Error("no");
    return { userId: `user_${t.slice(4)}`, email: null };
  });
  const app = (await import("../src/app.js")).createApp();
  await (await import("../src/lib/cluster.js")).startCluster();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return { app, server, db, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

beforeAll(async () => {
  Object.assign(process.env, { APP_MODE: "cloud", APP_URL: "https://app.example.com" });
  const { applyPgSchema } = await import("../src/db/postgres.js");
  const { testConnector: pgliteConnector } = await import("./support/testDb.js");
  const connector = await pgliteConnector();
  await applyPgSchema(connector);
  A = await instance(connector);
  B = await instance(connector);
  await A.db.withSystem(() => A.db.db.run("INSERT INTO app_users (id, subscription_status) VALUES ('user_alice', 'active')"));
}, 60_000);

afterAll(async () => {
  stop = true;
  for (const i of [A, B]) {
    i?.server.closeAllConnections();
    i?.server.close();
  }
  await Promise.race([loop, new Promise((r) => setTimeout(r, 2000))]);
});

const as = { Authorization: "Bearer tok_alice" };

describe("several API instances", () => {
  it("routes helper jobs, results and live events between instances", async () => {
    const token = (await request(A.app).post("/api/helper-tokens").set(as).send({ name: "PC" })).body.token as string;

    // The helper is connected to instance B.
    const { createHelper } = await import("../src/helper/runtime.js");
    const { VintedClient } = await import("../src/vinted/vintedClient.js");
    const { mockAdapter } = await import("./support/mockAdapter.js");
    const logins = new Map<number, StoredLogin>();
    const helper = createHelper({
      cloud: (p, init = {}) => fetch(`${B.base}${p}`, {
        method: init.method ?? "GET",
        headers: { authorization: `Bearer ${token}`, ...(init.json !== undefined ? { "content-type": "application/json" } : {}) },
        body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
      }),
      vinted: new VintedClient(mockAdapter, 0),
      logins: { get: (id) => logins.get(id), set: (id, l) => void logins.set(id, l), delete: (id) => void logins.delete(id) },
      readVintedCookies: async () => ({ access: "token-cluster-account", refresh: null }),
      assistant: {
        setSource: () => {}, start: async () => { throw new Error("n/a"); }, skip: () => {}, stop: () => {},
        status: () => { throw new Error("n/a"); },
      },
    });
    loop = (async () => {
      while (!stop) await helper.pollOnce().catch(() => new Promise((r) => setTimeout(r, 100)));
    })();
    for (let i = 0; i < 50 && !(await request(A.app).get("/api/helper-tokens").set(as)).body.status.online; i++) await new Promise((r) => setTimeout(r, 100));

    // Dashboard on A → job → helper on B → result back to A (plus the sync's Vinted calls).
    const acc = (await request(A.app).post("/api/accounts").set(as).send({ name: "Shop", domain: "vinted.de" })).body.account;
    const started = Date.now();
    const res = await request(A.app).post(`/api/accounts/${acc.id}/connect-helper`).set(as);
    expect(res.status).toBe(200);
    expect(res.body.account.status).toBe("connected");
    expect(Date.now() - started).toBeLessThan(15_000); // notifications, not only the fallback polling
    expect((await request(A.app).get("/api/archive").set(as)).body.total).toBeGreaterThan(0);

    // A live event raised on B reaches A (assistant status via the helper's event endpoint).
    await fetch(`${B.base}/api/helper/events`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ events: [{ type: "assist.status", status: { state: "waiting", message: "von B", itemId: null, title: null, position: 0, total: 1, filled: [], missing: [], done: [], fields: [], tabs: [] } }] }),
    });
    await new Promise((r) => setTimeout(r, 300));
    expect((await request(A.app).get("/api/assist/status").set(as)).body).toMatchObject({ state: "waiting", message: "von B" });
  }, 60_000);

  // PGlite has a single connection, so the lock can only be checked against a real server (TEST_PG_URL).
  it.skipIf(!process.env.TEST_PG_URL)("runs background jobs on only one instance at a time", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const first = A.db.withLock("jobs:test", () => hold);
    await new Promise((r) => setTimeout(r, 100));
    expect(await B.db.withLock("jobs:test", async () => {})).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(await B.db.withLock("jobs:test", async () => {})).toBe(true);
  });
});
