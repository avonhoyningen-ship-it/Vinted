import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("local → cloud migration", () => {
  it("copies all data for one user with new ids, uploads photos and never copies Vinted logins", async () => {
    const { openSqlite } = await import("../src/db/sqlite.js");
    const { applyPgSchema, postgresDriver } = await import("../src/db/postgres.js");
    const { testConnector: pgliteConnector } = await import("./support/testDb.js");
    const idx = await import("../src/db/index.js");
    const { localStore } = await import("../src/storage/store.js");
    const { migrateToCloud } = await import("../src/tools/migrateToCloud.js");

    // --- local data ---
    const local = openSqlite(":memory:");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-"));
    const localPhotos = localStore(dir);
    await localPhotos.put("abc.jpg", Buffer.from("JPEGDATA"), "image/jpeg");
    const run = (sql: string, ...p: unknown[]) => Number(local.prepare(sql).run(...(p as never[])).lastInsertRowid);
    // ids deliberately not 1 so remapping is visible
    run("INSERT INTO items (id, title) VALUES (500, 'Platzhalter')");
    local.exec("DELETE FROM items");
    const acc = run("INSERT INTO accounts (name, domain, session_encrypted, refresh_encrypted, session_hint, status) VALUES ('Shop', 'vinted.de', 'geheim', 'geheim2', '…abcd', 'connected')");
    const item = run("INSERT INTO items (title, brand, price_cents) VALUES ('Sakura Tee', 'Graphic Tee', 2400)");
    run("INSERT INTO item_photos (item_id, file_name, mime_type, sha256) VALUES (?, 'abc.jpg', 'image/jpeg', 'abc')", item);
    run("INSERT INTO item_photos (item_id, file_name, mime_type, sha256, position) VALUES (?, 'fehlt.jpg', 'image/jpeg', 'x', 1)", item);
    const listing = run("INSERT INTO listings (item_id, account_id, vinted_item_id, title, price_cents) VALUES (?, ?, '777', 'Sakura Tee', 2400)", item, acc);
    run("INSERT INTO sales (account_id, listing_id, item_id, external_id, title, price_cents, sold_at) VALUES (?, ?, ?, 's1', 'Sakura Tee', 2400, '2026-09-01T10:00:00.000Z')", acc, listing, item);
    const rule = run("INSERT INTO automation_rules (name, account_id, trigger_type, action_type, action_config) VALUES ('Danke', ?, 'item_sold', 'send_message', '{\"message\":\"Danke\"}')", acc);
    run("INSERT INTO scheduled_actions (rule_id, account_id, listing_id, action_type, run_at) VALUES (?, ?, ?, 'send_message', '2026-09-01T10:00:00.000Z')", rule, acc, listing);
    run("INSERT INTO settings (key, value) VALUES ('brand.rules', '\"T-Shirt=Graphic Tee\"')");

    // --- cloud ---
    const connector = await pgliteConnector();
    await applyPgSchema(connector);
    const previous = idx.getDriver();
    idx.setDriver(postgresDriver(connector, { scope: idx.scopeUserId }));
    const uploaded = new Map<string, Buffer>();
    const cloudPhotos = { kind: "supabase" as const, put: async (n: string, d: Buffer) => void uploaded.set(`${idx.currentUserId()}/${n}`, d), get: async () => Buffer.alloc(0) };
    try {
      const report = await migrateToCloud({ local, userId: "user_owner", localPhotos, cloudPhotos });
      expect(report.rows).toMatchObject({ accounts: 1, items: 1, item_photos: 2, listings: 1, sales: 1, automation_rules: 1, scheduled_actions: 1 });
      expect(report).toMatchObject({ photos: 1, missingPhotos: 1 });
      expect(uploaded.get("user_owner/abc.jpg")?.toString()).toBe("JPEGDATA");

      await idx.withUser("user_owner", async () => {
        const a = (await idx.db.get<Record<string, unknown>>("SELECT * FROM accounts"))!;
        expect(a).toMatchObject({ name: "Shop", status: "disconnected", session_encrypted: null, refresh_encrypted: null, user_id: "user_owner" });
        const l = (await idx.db.get<Record<string, unknown>>("SELECT l.*, i.title item_title FROM listings l JOIN items i ON i.id = l.item_id"))!;
        expect(l).toMatchObject({ item_title: "Sakura Tee", account_id: a.id, vinted_item_id: "777" });
        const s = (await idx.db.get<Record<string, unknown>>("SELECT * FROM sales"))!;
        expect(s).toMatchObject({ listing_id: l.id, item_id: l.item_id, account_id: a.id });
        const act = (await idx.db.get<Record<string, unknown>>("SELECT s.*, r.name FROM scheduled_actions s JOIN automation_rules r ON r.id = s.rule_id"))!;
        expect(act).toMatchObject({ name: "Danke", listing_id: l.id });
        expect(await idx.db.get("SELECT value FROM settings WHERE key = 'brand.rules'")).toEqual({ value: '"T-Shirt=Graphic Tee"' });
      });
      // Another user sees nothing of it; a second run is refused.
      expect(await idx.withUser("user_other", () => idx.db.all("SELECT * FROM items"))).toEqual([]);
      await expect(migrateToCloud({ local, userId: "user_owner", localPhotos, cloudPhotos })).rejects.toThrow(/schon 1 Artikel/);
    } finally {
      idx.setDriver(previous);
    }
  }, 60_000);
});
