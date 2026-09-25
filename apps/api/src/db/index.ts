import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { env } from "../config/env.js";
import { migrations } from "./migrations.js";

/**
 * Uses Node's built-in SQLite (node:sqlite, Node >= 22.13), so no native
 * module has to be compiled on install (works on Windows without Visual Studio).
 */
export type DB = DatabaseSync & {
  /** Wraps fn in a transaction (nested calls use savepoints). Returns a runner like better-sqlite3. */
  transaction<T>(fn: () => T): () => T;
};

let depth = 0;

function open(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  // Like better-sqlite3's usage in this codebase: shared param objects may carry extra keys.
  const prepare = raw.prepare.bind(raw);
  const db = Object.assign(raw, {
    prepare(sql: string) {
      const stmt = prepare(sql);
      stmt.setAllowUnknownNamedParameters(true);
      return stmt;
    },
    transaction<T>(fn: () => T) {
      return () => {
        const sp = `sp${depth}`;
        raw.exec(depth === 0 ? "BEGIN" : `SAVEPOINT ${sp}`);
        depth++;
        try {
          const result = fn();
          depth--;
          raw.exec(depth === 0 ? "COMMIT" : `RELEASE ${sp}`);
          return result;
        } catch (e) {
          depth--;
          raw.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
          throw e;
        }
      };
    },
  }) as DB;
  migrate(db);
  return db;
}

export function migrate(db: DB) {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const applied = new Set(db.prepare("SELECT id FROM _migrations").all().map((r) => Number(r.id)));
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
