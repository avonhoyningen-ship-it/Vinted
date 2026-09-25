import { env } from "./config/env.js";
import { createApp } from "./app.js";
import { startWorkers } from "./workers/scheduler.js";

if (env.isProduction && !env.dashboardPassword) {
  console.error("DASHBOARD_PASSWORD fehlt: Im Produktionsbetrieb ist ein Login-Passwort Pflicht (siehe DEPLOY.md).");
  process.exit(1);
}
// At home (PC/WLAN) 4 characters are enough – the login locks after 10 failed attempts.
// On an internet-facing server (Docker, NODE_ENV=production) a longer password is required.
const minLength = env.isProduction ? 10 : 4;
if (env.dashboardPassword && env.dashboardPassword.length < minLength) {
  console.error(`DASHBOARD_PASSWORD ist zu kurz (mindestens ${minLength} Zeichen${env.isProduction ? " auf einem Server im Internet" : ""}).`);
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
