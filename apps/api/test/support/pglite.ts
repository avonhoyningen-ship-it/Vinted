import { PGlite, types } from "@electric-sql/pglite";
import type { PgConnector } from "../../src/db/postgres.js";

/**
 * In-memory Postgres (PGlite) with the same connection interface as the
 * Supabase pool. One connection: callers are serialized like a pool of size 1.
 */
export async function pgliteConnector(): Promise<PgConnector> {
  const pg = new PGlite({
    parsers: { [types.INT8]: (v: string) => Number(v), [types.NUMERIC]: (v: string) => Number(v) },
  });
  let queue: Promise<void> = Promise.resolve();
  return {
    async connect() {
      let release!: () => void;
      const previous = queue;
      queue = new Promise<void>((r) => (release = r));
      await previous;
      return {
        async query(text, values) {
          // Several statements without parameters (BEGIN; SET ROLE …) need the simple protocol.
          if (!values?.length && text.includes(";")) {
            const res = await pg.exec(text);
            const last = res[res.length - 1];
            return { rows: (last?.rows ?? []) as Record<string, unknown>[], affectedRows: last?.affectedRows };
          }
          const r = await pg.query(text, values as unknown[]);
          return { rows: r.rows as Record<string, unknown>[], affectedRows: r.affectedRows };
        },
        release,
      };
    },
    end: () => pg.close(),
    async listen(channel, cb) {
      await pg.listen(channel, cb);
    },
  };
}
