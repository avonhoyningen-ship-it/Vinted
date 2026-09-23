import { env } from "./config/env.js";
import { createApp } from "./app.js";
import { startWorkers } from "./workers/scheduler.js";

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
