import crypto from "node:crypto";
import type { PgConnector } from "../../src/db/postgres.js";

/**
 * Postgres for tests: a real server when TEST_PG_URL is set (own schema per
 * test file, several connections – like Supabase), otherwise PGlite in memory.
 */
export async function testConnector(): Promise<PgConnector> {
  const url = process.env.TEST_PG_URL;
  if (!url) return (await import("./pglite.js")).pgliteConnector();
  const pg = (await import("pg")).default;
  const schema = `t_${crypto.randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const { nodePgConnector } = await import("../../src/db/postgres.js");
  return nodePgConnector(url, null, { searchPath: schema });
}

/** Whether the test database has more than one connection (advisory locks between connections). */
export const realPostgres = () => !!process.env.TEST_PG_URL;
