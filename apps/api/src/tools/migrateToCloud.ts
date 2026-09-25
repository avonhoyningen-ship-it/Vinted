/**
 * Moves the local dashboard (SQLite + photo folder) into the cloud version
 * (Supabase Postgres + Storage) for one Clerk user.
 *
 *   npm run migrate:cloud -w apps/api -- --user user_2abc...
 *
 * Needs in .env (or the shell): DATABASE_URL, SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY and the local DATABASE_PATH / STORAGE_DIR.
 * Vinted logins are NOT copied: in the cloud they stay on the user's PC
 * (PC helper), so accounts arrive as "disconnected".
 */
import fs from "node:fs";
import path from "node:path";
import { env } from "../config/env.js";
import { db, scopeUserId, setDriver, withSystem, withUser } from "../db/index.js";
import { applyPgSchema, nodePgConnector, postgresDriver } from "../db/postgres.js";
import { openSqlite, type SqliteDB } from "../db/sqlite.js";
import type { Row } from "../db/types.js";
import { localStore, setPhotoStore, supabaseStore, type PhotoStore } from "../storage/store.js";

type IdMap = Map<number, number>;

/** Tables in foreign-key order; `refs` maps a column to the table whose new ids it needs. */
const TABLES: { name: string; refs?: Record<string, string>; skip?: string[] }[] = [
  { name: "accounts", skip: ["session_encrypted", "refresh_encrypted", "session_hint"] },
  { name: "items" },
  { name: "item_photos", refs: { item_id: "items" } },
  { name: "listings", refs: { item_id: "items", account_id: "accounts" } },
  { name: "listing_price_changes", refs: { listing_id: "listings" } },
  { name: "publish_queue", refs: { item_id: "items", account_id: "accounts", listing_id: "listings" } },
  { name: "sales", refs: { account_id: "accounts", listing_id: "listings", item_id: "items" } },
  { name: "vinted_events", refs: { account_id: "accounts", listing_id: "listings" } },
  { name: "automation_rules", refs: { account_id: "accounts" } },
  { name: "scheduled_actions", refs: { rule_id: "automation_rules", event_id: "vinted_events", account_id: "accounts", listing_id: "listings" } },
  { name: "templates" },
  { name: "price_rules" },
  { name: "price_examples", refs: { item_id: "items" } },
];

export interface MigrationReport { rows: Record<string, number>; photos: number; missingPhotos: number }

/** Copies everything from `local` into the current (Postgres) driver for `userId`. */
export async function migrateToCloud(opts: { local: SqliteDB; userId: string; localPhotos: PhotoStore; cloudPhotos: PhotoStore; force?: boolean }): Promise<MigrationReport> {
  const { local, userId } = opts;
  await withSystem(() => db.run("INSERT INTO app_users (id) VALUES (?) ON CONFLICT (id) DO NOTHING", [userId]));
  return withUser(userId, async () => {
    const existing = Number((await db.get<{ c: number }>("SELECT COUNT(*) c FROM items"))?.c ?? 0);
    if (existing && !opts.force) throw new Error(`Der Cloud-Nutzer hat schon ${existing} Artikel – Abbruch (mit --force trotzdem ergänzen).`);

    const maps = new Map<string, IdMap>();
    const report: MigrationReport = { rows: {}, photos: 0, missingPhotos: 0 };
    for (const t of TABLES) {
      const rows = local.prepare(`SELECT * FROM ${t.name} ORDER BY id`).all() as Row[];
      const map: IdMap = new Map();
      maps.set(t.name, map);
      for (const row of rows) {
        const data: Row = {};
        for (const [k, v] of Object.entries(row)) {
          if (k === "id" || k === "user_id" || t.skip?.includes(k)) continue;
          const refTable = t.refs?.[k];
          data[k] = refTable && v !== null ? maps.get(refTable)!.get(Number(v)) ?? null : v;
        }
        if (t.name === "accounts") Object.assign(data, { status: "disconnected", last_error: "Mit dem PC-Helfer neu verbinden" });
        if (t.name === "item_photos") {
          try {
            await opts.cloudPhotos.put(String(row.file_name), await opts.localPhotos.get(String(row.file_name)), String(row.mime_type ?? "image/jpeg"));
            report.photos++;
          } catch {
            report.missingPhotos++;
          }
        }
        const cols = Object.keys(data);
        const newId = await db.insert(`INSERT INTO ${t.name} (${cols.join(", ")}) VALUES (${cols.map((c) => "@" + c).join(", ")})`, data);
        map.set(Number(row.id), newId);
      }
      report.rows[t.name] = rows.length;
    }
    for (const s of local.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[]) {
      await db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value", [s.key, s.value]);
    }
    return report;
  });
}

async function main() {
  const args = process.argv.slice(2);
  const userId = args[args.indexOf("--user") + 1];
  if (!args.includes("--user") || !userId?.startsWith("user_")) {
    console.error("Aufruf: npm run migrate:cloud -w apps/api -- --user user_… (Clerk-Nutzer-ID aus dashboard.clerk.com → Users)");
    process.exit(1);
  }
  if (!env.databaseUrl || !env.supabaseUrl || !env.supabaseServiceKey) {
    console.error("DATABASE_URL, SUPABASE_URL und SUPABASE_SERVICE_ROLE_KEY müssen gesetzt sein.");
    process.exit(1);
  }
  if (!fs.existsSync(env.databasePath)) {
    console.error(`Lokale Datenbank nicht gefunden: ${env.databasePath}`);
    process.exit(1);
  }
  const local = openSqlite(env.databasePath);
  const connector = await nodePgConnector(env.databaseUrl, env.databaseCaCert);
  await applyPgSchema(connector);
  // The scope comes from withUser/withSystem inside migrateToCloud.
  setDriver(postgresDriver(connector, { scope: scopeUserId }));
  const cloudPhotos = supabaseStore({ url: env.supabaseUrl, serviceKey: env.supabaseServiceKey, bucket: env.supabaseBucket });
  setPhotoStore(cloudPhotos);
  const report = await migrateToCloud({
    local, userId, localPhotos: localStore(path.join(env.storageDir, "photos")), cloudPhotos, force: args.includes("--force"),
  });
  console.log("Übertragen:", report.rows);
  console.log(`Fotos: ${report.photos} hochgeladen${report.missingPhotos ? `, ${report.missingPhotos} fehlten lokal` : ""}`);
  console.log("Fertig. Vinted-Accounts bitte im Cloud-Dashboard mit dem PC-Helfer neu verbinden.");
  await connector.end();
}

if (process.argv[1] && /migrateToCloud\.(ts|js)$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error("Fehler:", (e as Error).message);
    process.exit(1);
  });
}
