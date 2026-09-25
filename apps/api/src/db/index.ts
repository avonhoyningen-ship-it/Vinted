import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "../config/env.js";
import { applyPgSchema, nodePgConnector, postgresDriver, SYSTEM_SCOPE } from "./postgres.js";
import { sqliteDriver } from "./sqlite.js";
import type { Driver, Params, Row } from "./types.js";

export type { Params, Row } from "./types.js";

/**
 * Data access for the whole app. Locally a SQLite file; in the cloud Postgres
 * (Supabase) where row level security keeps every user to their own rows.
 * All calls are async so both drivers share the same code.
 */

/** The user whose data a request/job works on. Local mode: always "local". */
export const LOCAL_USER = "local";
const userStore = new AsyncLocalStorage<string>();

export function currentUserId(): string {
  return userStore.getStore() ?? LOCAL_USER;
}

/** Raw scope (undefined = none) – the Postgres driver refuses queries without one. */
export const scopeUserId = () => userStore.getStore();

/** Scope for work that is not tied to one user (webhooks, schedulers, helper auth). Postgres: owner rights. */
export function withSystem<T>(fn: () => T): T {
  return userStore.run(SYSTEM_SCOPE, fn);
}

/** Runs fn with every query scoped to `userId`. */
export function withUser<T>(userId: string, fn: () => T): T {
  return userStore.run(userId, fn);
}

/** Runs a background job once per user, each in its own user scope; one failing user doesn't stop the others. */
export async function forEachUser(fn: () => Promise<unknown>) {
  const ids = (await driver.userIds?.()) ?? [LOCAL_USER];
  for (const id of ids) {
    try {
      await withUser(id, fn);
    } catch (e) {
      console.error(`[jobs] ${id}:`, (e as Error).message);
    }
  }
}

/** Postgres whose connection pool is created on first use (the pg module loads lazily). */
function lazyPostgres(url: string): Driver {
  let ready: Promise<Driver> | null = null;
  const get = () => (ready ??= (async () => {
    const connector = await nodePgConnector(url, env.databaseCaCert);
    if (env.dbAutoMigrate) await applyPgSchema(connector);
    return postgresDriver(connector, { scope: scopeUserId });
  })());
  return {
    kind: "postgres",
    all: async (sql, p) => (await get()).all(sql, p),
    get: async (sql, p) => (await get()).get(sql, p),
    run: async (sql, p) => (await get()).run(sql, p),
    exec: async (sql) => (await get()).exec(sql),
    tx: async (fn) => (await get()).tx(fn),
    userIds: async () => (await get()).userIds!(),
    withLock: async (name, fn) => (await get()).withLock!(name, fn),
    pubsub: {
      publish: async (c, p) => (await get()).pubsub!.publish(c, p),
      subscribe: async (c, cb) => (await get()).pubsub!.subscribe(c, cb),
    },
    close: async () => { if (ready) await (await ready).close(); },
  };
}

let driver: Driver = env.databaseUrl ? lazyPostgres(env.databaseUrl) : sqliteDriver(env.databasePath);

/** Swaps the driver (Postgres in cloud mode, tests). */
export function setDriver(d: Driver) {
  driver = d;
}
export const getDriver = () => driver;

export const db = {
  all<T = Row>(sql: string, params?: Params): Promise<T[]> {
    return driver.all(sql, params) as Promise<T[]>;
  },
  get<T = Row>(sql: string, params?: Params): Promise<T | undefined> {
    return driver.get(sql, params) as Promise<T | undefined>;
  },
  /** Returns the number of changed rows. */
  async run(sql: string, params?: Params): Promise<number> {
    return (await driver.run(sql, params)).changes;
  },
  /** INSERT that returns the new row's id (0 if nothing was inserted, e.g. ON CONFLICT DO NOTHING). */
  async insert(sql: string, params?: Params): Promise<number> {
    const r = await driver.run(sql, params);
    return r.changes ? r.lastId : 0;
  },
  exec(sql: string): Promise<void> {
    return driver.exec(sql);
  },
  /** Runs fn in one transaction (nested calls become savepoints). Keep fn to DB calls only. */
  tx<T>(fn: () => Promise<T>): Promise<T> {
    return driver.tx(fn);
  },
};

/** Runs fn on only one API instance at a time (Postgres); locally always. */
export async function withLock(name: string, fn: () => Promise<unknown>): Promise<boolean> {
  if (!driver.withLock) {
    await fn();
    return true;
  }
  return driver.withLock(name, fn);
}

export const nowIso = () => new Date().toISOString();

/** Builds "a = @a, b = @b" for partial updates from a whitelist. */
export function updateSet<T extends object>(patch: T, allowed: readonly (keyof T & string)[]) {
  const keys = allowed.filter((k) => patch[k] !== undefined);
  return { sql: keys.map((k) => `${k} = @${k}`).join(", "), keys };
}
