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
const server = app.listen(env.port, () => {
  console.log(`[api] http://localhost:${env.port}/api  (Vinted-Modus: ${env.vintedMode})`);
});
const stopWorkers = startWorkers();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopWorkers();
    server.close(() => process.exit(0));
  });
}
