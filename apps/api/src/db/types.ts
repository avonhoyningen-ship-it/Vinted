export type Row = Record<string, unknown>;
/** Positional values for "?" or one object for "@name" placeholders. */
export type Params = unknown[] | Record<string, unknown>;

/** Database driver: SQLite locally, Postgres (Supabase) in the cloud. */
export interface Driver {
  kind: "sqlite" | "postgres";
  all(sql: string, params?: Params): Promise<Row[]>;
  get(sql: string, params?: Params): Promise<Row | undefined>;
  run(sql: string, params?: Params): Promise<{ changes: number; lastId: number }>;
  exec(sql: string): Promise<void>;
  tx<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
  /** Users whose data background jobs work on (Postgres: users with an active subscription). */
  userIds?(): Promise<string[]>;
  /** Runs fn only if no other API instance holds the lock `name` (Postgres advisory lock); false = skipped. */
  withLock?(name: string, fn: () => Promise<unknown>): Promise<boolean>;
  /** Messages between API instances (Postgres LISTEN/NOTIFY). */
  pubsub?: {
    publish(channel: string, payload: string): Promise<void>;
    subscribe(channel: string, cb: (payload: string) => void): Promise<void>;
  };
  /** Only SQLite: the underlying handle (migrations, tests). */
  raw?: unknown;
}
