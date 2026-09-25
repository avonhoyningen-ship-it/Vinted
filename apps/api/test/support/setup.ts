import { vintedClient } from "../../src/vinted/vintedClient.js";
import { mockAdapter } from "./mockAdapter.js";

// The app itself only talks to the real Vinted client; tests swap in a fake.
vintedClient.useAdapter(mockAdapter, 0);

// TEST_DB=postgres: the same tests against Postgres with row level security (PGlite in memory).
if (process.env.TEST_DB === "postgres") {
  const { setDriver, scopeUserId, withSystem, db } = await import("../../src/db/index.js");
  const { applyPgSchema, postgresDriver } = await import("../../src/db/postgres.js");
  const { testConnector: pgliteConnector } = await import("./testDb.js");
  const connector = await pgliteConnector();
  await applyPgSchema(connector);
  // Tests act as one signed-up user unless they choose a scope themselves.
  setDriver(postgresDriver(connector, { scope: () => scopeUserId() ?? "user_test" }));
  await withSystem(() => db.run("INSERT INTO app_users (id, email, subscription_status) VALUES ('user_test', 'test@example.com', 'active') ON CONFLICT DO NOTHING"));
}
