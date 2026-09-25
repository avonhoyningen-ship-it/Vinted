import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Driver, Params, Row } from "./types.js";
import { migrations } from "./migrations.js";

/**
 * Uses Node's built-in SQLite (node:sqlite, Node >= 22.13), so no native
 * module has to be compiled on install (works on Windows without Visual Studio).
 */
export type SqliteDB = DatabaseSync & {
  /** Wraps fn in a transaction (nested calls use savepoints). Returns a runner like better-sqlite3. */
  transaction<T>(fn: () => T): () => T;
};

let depth = 0;

export function openSqlite(file: string): SqliteDB {
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
  }) as SqliteDB;
  migrate(db);
  return db;
}

export function migrate(db: SqliteDB) {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const applied = new Set(db.prepare("SELECT id FROM _migrations").all().map((r) => Number(r.id)));
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      m.run?.(db);
      db.prepare("INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)").run(m.id, m.name, new Date().toISOString());
    })();
  }
}

const txDepth = new AsyncLocalStorage<number>();
let txQueue: Promise<void> = Promise.resolve();

/** Async driver on top of node:sqlite – same interface as the Postgres driver. */
export function sqliteDriver(file: string): Driver {
  const raw = openSqlite(file);
  // State file of the removed demo mode – no longer used.
  if (file !== ":memory:") fs.rmSync(path.join(path.dirname(file), "mock-vinted.json"), { force: true });
  const bind = (params: Params | undefined) => (params === undefined ? [] : Array.isArray(params) ? params : [params]) as never[];
  return {
    kind: "sqlite",
    raw,
    async all(sql, params) {
      return raw.prepare(sql).all(...bind(params)) as Row[];
    },
    async get(sql, params) {
      return raw.prepare(sql).get(...bind(params)) as Row | undefined;
    },
    async run(sql, params) {
      const r = raw.prepare(sql).run(...bind(params));
      return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
    },
    async exec(sql) {
      raw.exec(sql);
    },
    async tx(fn) {
      // Nested call inside a running transaction → savepoint.
      const depth = txDepth.getStore();
      if (depth !== undefined) {
        const sp = `sp${depth + 1}`;
        raw.exec(`SAVEPOINT ${sp}`);
        try {
          const result = await txDepth.run(depth + 1, fn);
          raw.exec(`RELEASE ${sp}`);
          return result;
        } catch (e) {
          raw.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
          throw e;
        }
      }
      // Top level: one transaction at a time (a single connection is shared).
      const previous = txQueue;
      let release!: () => void;
      txQueue = new Promise<void>((r) => (release = r));
      await previous;
      raw.exec("BEGIN");
      try {
        const result = await txDepth.run(0, fn);
        raw.exec("COMMIT");
        return result;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      } finally {
        release();
      }
    },
    async close() {
      raw.close();
    },
  };
}
