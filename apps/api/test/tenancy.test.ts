import { beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/db/types.js";

/**
 * Cloud isolation: every user only sees and changes their own rows – enforced
 * by Postgres row level security, not only by the app's queries.
 */
describe("row level security (Postgres)", () => {
  let pg: Driver;
  let withUser: <T>(id: string, fn: () => T) => T;
  let withSystem: <T>(fn: () => T) => T;

  beforeAll(async () => {
    const { applyPgSchema, postgresDriver } = await import("../src/db/postgres.js");
    const { testConnector: pgliteConnector } = await import("./support/testDb.js");
    const idx = await import("../src/db/index.js");
    withUser = idx.withUser;
    withSystem = idx.withSystem;
    const connector = await pgliteConnector();
    await applyPgSchema(connector);
    await applyPgSchema(connector); // idempotent: a second run must not fail
    pg = postgresDriver(connector, { scope: idx.scopeUserId });
    await withSystem(() => pg.run("INSERT INTO app_users (id, subscription_status) VALUES ('user_a', 'active'), ('user_b', 'active'), ('user_c', 'canceled')"));
  }, 60_000);

  it("refuses queries without a signed-in user", async () => {
    await expect(pg.all("SELECT * FROM items")).rejects.toThrow(/ohne angemeldeten Nutzer/);
  });

  it("fills user_id automatically and hides other users' rows", async () => {
    const itemA = await withUser("user_a", async () => (await pg.run("INSERT INTO items (title) VALUES ('Shirt von A')")).lastId);
    await withUser("user_a", () => pg.run("INSERT INTO settings (key, value) VALUES ('ai.language', '\"de\"')"));
    await withUser("user_b", () => pg.run("INSERT INTO items (title) VALUES ('Hoodie von B')"));

    const seenByA = await withUser("user_a", () => pg.all("SELECT title, user_id FROM items"));
    const seenByB = await withUser("user_b", () => pg.all("SELECT title, user_id FROM items"));
    expect(seenByA).toEqual([{ title: "Shirt von A", user_id: "user_a" }]);
    expect(seenByB).toEqual([{ title: "Hoodie von B", user_id: "user_b" }]);
    expect(await withUser("user_b", () => pg.all("SELECT * FROM settings"))).toEqual([]);

    // B can neither read, change nor delete A's item – even knowing its id.
    expect(await withUser("user_b", () => pg.get("SELECT * FROM items WHERE id = ?", [itemA]))).toBeUndefined();
    expect((await withUser("user_b", () => pg.run("UPDATE items SET title = 'gehackt' WHERE id = ?", [itemA]))).changes).toBe(0);
    expect((await withUser("user_b", () => pg.run("DELETE FROM items WHERE id = ?", [itemA]))).changes).toBe(0);
    expect(await withUser("user_a", () => pg.get("SELECT title FROM items WHERE id = ?", [itemA]))).toEqual({ title: "Shirt von A" });
  });

  it("rejects rows written for another user", async () => {
    await expect(withUser("user_b", () => pg.run("INSERT INTO items (title, user_id) VALUES ('Fremd', 'user_a')"))).rejects.toThrow(/row-level security/);
    const id = await withUser("user_b", async () => (await pg.run("INSERT INTO items (title) VALUES ('Eigenes')")).lastId);
    await expect(withUser("user_b", () => pg.run("UPDATE items SET user_id = 'user_a' WHERE id = ?", [id]))).rejects.toThrow(/row-level security/);
  });

  it("keeps transactions in the user's scope", async () => {
    await withUser("user_a", () => pg.tx(async () => {
      await pg.run("INSERT INTO templates (name, body) VALUES ('Versand', 'Versand am nächsten Tag')");
      await pg.tx(async () => pg.run("INSERT INTO templates (name, body) VALUES ('Maße', 'Länge x Breite')"));
    }));
    expect(await withUser("user_a", () => pg.all("SELECT name FROM templates ORDER BY name"))).toEqual([{ name: "Maße" }, { name: "Versand" }]);
    expect(await withUser("user_b", () => pg.all("SELECT name FROM templates"))).toEqual([]);
  });

  it("each user only sees their own subscription row; jobs run for paying users", async () => {
    expect(await withUser("user_a", () => pg.all("SELECT id FROM app_users"))).toEqual([{ id: "user_a" }]);
    expect(await pg.userIds!()).toEqual(["user_a", "user_b"]);
  });

  it("rejects unsafe user ids", async () => {
    await expect(withUser("x'; DROP TABLE items; --", () => pg.all("SELECT 1"))).rejects.toThrow(/ohne angemeldeten Nutzer/);
  });
});

describe("supabase/schema.sql", () => {
  it("matches the schema the API applies", async () => {
    const fs = await import("node:fs");
    const { PG_SCHEMA } = await import("../src/db/pgSchema.js");
    const file = fs.readFileSync(new URL("../../../supabase/schema.sql", import.meta.url), "utf8");
    expect(file.endsWith(PG_SCHEMA), "supabase/schema.sql veraltet – npm run db:schema -w apps/api").toBe(true);
  });
});
