import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { env } from "../config/env.js";
import { migrations } from "./migrations.js";

export type DB = Database.Database;

function open(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

export function migrate(db: DB) {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const applied = new Set(db.prepare("SELECT id FROM _migrations").all().map((r) => (r as { id: number }).id));
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)").run(m.id, m.name, new Date().toISOString());
    })();
  }
}

export const db: DB = open(env.databasePath);

export const nowIso = () => new Date().toISOString();

/** Builds "a = @a, b = @b" for partial updates from a whitelist. */
export function updateSet<T extends object>(patch: T, allowed: readonly (keyof T & string)[]) {
  const keys = allowed.filter((k) => patch[k] !== undefined);
  return { sql: keys.map((k) => `${k} = @${k}`).join(", "), keys };
}
