import { AsyncLocalStorage } from "node:async_hooks";
import { PG_SCHEMA } from "./pgSchema.js";
import type { Driver, Params, Row } from "./types.js";

/**
 * Postgres driver (Supabase in the cloud, PGlite in tests).
 *
 * Every statement runs inside a transaction that first switches to the
 * restricted role `app_user` and sets `app.user_id` – row level security then
 * limits it to that user's rows. Statements without a user scope are refused,
 * except in the explicit system scope (webhooks, schedulers, helper auth).
 */

/** Minimal connection interface shared by node-postgres and PGlite. */
export interface PgConnection {
  query(text: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount?: number | null; affectedRows?: number }>;
  release(): void;
}
export interface PgConnector {
  connect(): Promise<PgConnection>;
  end(): Promise<void>;
}

export const SYSTEM_SCOPE = "__system__";
const SAFE_USER_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Tables without an `id` column (no RETURNING id on insert). */
const NO_ID_TABLES = new Set(["settings", "app_users"]);

/**
 * Converts the app's SQLite-style SQL to Postgres: `?` and `@name` placeholders
 * become $1…, LIKE becomes ILIKE (SQLite's LIKE ignores case), and INSERTs get
 * `RETURNING id` so the new id is known.
 */
export function toPg(sql: string, params: Params | undefined, returningId = false): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const named = new Map<string, number>();
  const positional = Array.isArray(params) ? params : [];
  const obj = params && !Array.isArray(params) ? params : {};
  let out = "";
  let pos = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) { j += 2; continue; }
          break;
        }
        j++;
      }
      out += sql.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === "?") {
      values.push(positional[pos++] ?? null);
      out += `$${values.length}`;
      continue;
    }
    if (c === "@" && /[A-Za-z_]/.test(sql[i + 1] ?? "")) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i + 1))!;
      const name = m[0];
      if (!named.has(name)) {
        values.push(obj[name] === undefined ? null : obj[name]);
        named.set(name, values.length);
      }
      out += `$${named.get(name)}`;
      i += name.length;
      continue;
    }
    if ((c === "L" || c === "l") && /^like\b/i.test(sql.slice(i, i + 5)) && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? " ")) {
      out += "ILIKE";
      i += 3;
      continue;
    }
    out += c;
  }
  const table = /^\s*INSERT\s+INTO\s+([A-Za-z_]+)/i.exec(out)?.[1]?.toLowerCase();
  if (returningId && table && !NO_ID_TABLES.has(table) && !/\bRETURNING\b/i.test(out)) out = `${out.trimEnd()} RETURNING id`;
  return { text: out, values };
}

export function postgresDriver(connector: PgConnector, opts: { scope: () => string | undefined }): Driver {
  const txConn = new AsyncLocalStorage<{ conn: PgConnection; depth: number }>();

  function scopeSql(): string {
    const uid = opts.scope();
    if (uid === SYSTEM_SCOPE) return "BEGIN";
    if (!uid || !SAFE_USER_ID.test(uid)) throw new Error("Datenbankzugriff ohne angemeldeten Nutzer");
    // Values can't be parameters in SET/multi-statements; the id is validated above.
    return `BEGIN; SET LOCAL ROLE app_user; SELECT set_config('app.user_id', '${uid}', true)`;
  }

  /** Runs one statement in the current transaction, or in its own short one. */
  async function exec(text: string, values: unknown[]) {
    const tx = txConn.getStore();
    if (tx) return tx.conn.query(text, values);
    const begin = scopeSql();
    const conn = await connector.connect();
    try {
      await conn.query(begin);
      const r = await conn.query(text, values);
      await conn.query("COMMIT");
      return r;
    } catch (e) {
      await conn.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      conn.release();
    }
  }

  const changes = (r: { rowCount?: number | null; affectedRows?: number }) => Number(r.rowCount ?? r.affectedRows ?? 0);

  return {
    kind: "postgres",
    async all(sql, params) {
      const q = toPg(sql, params);
      return (await exec(q.text, q.values)).rows;
    },
    async get(sql, params) {
      const q = toPg(sql, params);
      return (await exec(q.text, q.values)).rows[0];
    },
    async run(sql, params) {
      const q = toPg(sql, params, true);
      const r = await exec(q.text, q.values);
      return { changes: changes(r), lastId: Number(r.rows[0]?.id ?? 0) };
    },
    async exec(sql) {
      await exec(sql, []);
    },
    async tx(fn) {
      const outer = txConn.getStore();
      if (outer) {
        const sp = `sp${outer.depth + 1}`;
        await outer.conn.query(`SAVEPOINT ${sp}`);
        try {
          const r = await txConn.run({ conn: outer.conn, depth: outer.depth + 1 }, fn);
          await outer.conn.query(`RELEASE SAVEPOINT ${sp}`);
          return r;
        } catch (e) {
          await outer.conn.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          throw e;
        }
      }
      const begin = scopeSql();
      const conn = await connector.connect();
      try {
        await conn.query(begin);
        const r = await txConn.run({ conn, depth: 0 }, fn);
        await conn.query("COMMIT");
        return r;
      } catch (e) {
        await conn.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        conn.release();
      }
    },
    async userIds() {
      const conn = await connector.connect();
      try {
        const r = await conn.query("SELECT id FROM app_users WHERE subscription_status IN ('active','trialing') ORDER BY id");
        return r.rows.map((x) => String(x.id));
      } finally {
        conn.release();
      }
    },
    async close() {
      await connector.end();
    },
  };
}

/** Creates/updates the schema (idempotent). Runs as the connecting owner role. */
export async function applyPgSchema(connector: PgConnector) {
  const conn = await connector.connect();
  try {
    await conn.query(PG_SCHEMA);
  } finally {
    conn.release();
  }
}

/** node-postgres pool (Supabase). BIGINT/NUMERIC come back as JS numbers like with SQLite. */
export async function nodePgConnector(connectionString: string, caCert: string | null = null): Promise<PgConnector> {
  const pg = (await import("pg")).default;
  pg.types.setTypeParser(20, (v) => Number(v)); // int8 (ids, COUNT)
  pg.types.setTypeParser(1700, (v) => Number(v)); // numeric (AVG, SUM)
  const pool = new pg.Pool({
    connectionString,
    max: Number(process.env.DB_POOL_SIZE ?? 10),
    // Supabase requires TLS. Its certificates are signed by Supabase's own CA: with DATABASE_CA_CERT
    // the server is verified, without it the connection is encrypted but not verified.
    ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? undefined : caCert ? { ca: caCert } : { rejectUnauthorized: false },
  });
  if (!caCert && !/localhost|127\.0\.0\.1/.test(connectionString)) {
    console.warn("[db] DATABASE_CA_CERT fehlt – TLS-Verbindung zu Postgres wird nicht verifiziert.");
  }
  return {
    connect: async () => {
      const c = await pool.connect();
      return { query: (t, v) => c.query(t, v as unknown[]), release: () => c.release() };
    },
    end: () => pool.end(),
  };
}
