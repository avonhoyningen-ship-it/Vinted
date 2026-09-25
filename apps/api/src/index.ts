import { env } from "./config/env.js";
import { createApp } from "./app.js";
import { startWorkers } from "./workers/scheduler.js";

if (env.isProduction && !env.dashboardPassword) {
  console.error("DASHBOARD_PASSWORD fehlt: Im Produktionsbetrieb ist ein Login-Passwort Pflicht (siehe DEPLOY.md).");
  process.exit(1);
}
if (env.dashboardPassword && env.dashboardPassword.length < 10) {
  console.error("DASHBOARD_PASSWORD ist zu kurz (mindestens 10 Zeichen).");
  process.exit(1);
}

const app = createApp();
// Without a password the API only listens on this PC; with one it is reachable in the network.
const host = env.dashboardPassword || env.apiToken ? "0.0.0.0" : "127.0.0.1";
const server = app.listen(env.port, host, () => {
  console.log(`[api] http://localhost:${env.port}/api${host === "127.0.0.1" ? "  (ohne Passwort: nur auf diesem PC erreichbar)" : ""}`);
});
const stopWorkers = startWorkers();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopWorkers();
    server.close(() => process.exit(0));
  });
}
