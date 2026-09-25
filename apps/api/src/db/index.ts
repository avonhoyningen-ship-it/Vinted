import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "../config/env.js";
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

let driver: Driver = sqliteDriver(env.databasePath);

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

export const nowIso = () => new Date().toISOString();

/** Builds "a = @a, b = @b" for partial updates from a whitelist. */
export function updateSet<T extends object>(patch: T, allowed: readonly (keyof T & string)[]) {
  const keys = allowed.filter((k) => patch[k] !== undefined);
  return { sql: keys.map((k) => `${k} = @${k}`).join(", "), keys };
}
