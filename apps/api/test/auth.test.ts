import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Each test file gets a fresh module graph, so env can be set before import.
process.env.DASHBOARD_PASSWORD = "richtig-geheim-123";
process.env.API_TOKEN = "script-token-xyz";
let app: import("express").Express;

beforeAll(async () => {
  vi.resetModules(); // the shared test setup already loaded env without these values
  app = (await import("../src/app.js")).createApp();
});

describe("auth", () => {
  it("blocks the API without login but keeps health open", async () => {
    expect((await request(app).get("/api/accounts")).status).toBe(401);
    expect((await request(app).get("/api/photos/x.jpg")).status).toBe(401);
    expect((await request(app).get("/api/health")).status).toBe(200);
    const me = await request(app).get("/api/auth/me");
    expect(me.body).toEqual({ authRequired: true, authenticated: false });
  });

  it("rejects a wrong password and accepts the right one", async () => {
    expect((await request(app).post("/api/auth/login").send({ password: "falsch" })).status).toBe(401);
    const ok = await request(app).post("/api/auth/login").send({ password: "richtig-geheim-123" });
    expect(ok.status).toBe(200);
    const cookie = ok.headers["set-cookie"]![0]!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    const session = cookie.split(";")[0]!;
    expect((await request(app).get("/api/accounts").set("cookie", session)).status).toBe(200);
    // Tampered cookie is rejected.
    expect((await request(app).get("/api/accounts").set("cookie", session.slice(0, -2) + "xx")).status).toBe(401);
  });

  it("accepts the bearer API token for scripts", async () => {
    expect((await request(app).get("/api/accounts").set("authorization", "Bearer script-token-xyz")).status).toBe(200);
    expect((await request(app).get("/api/accounts").set("authorization", "Bearer nope")).status).toBe(401);
  });

  it("locks out after repeated failures", async () => {
    for (let i = 0; i < 10; i++) await request(app).post("/api/auth/login").send({ password: `x${i}` });
    const r = await request(app).post("/api/auth/login").send({ password: "richtig-geheim-123" });
    expect(r.status).toBe(429);
  }, 15_000);
});
