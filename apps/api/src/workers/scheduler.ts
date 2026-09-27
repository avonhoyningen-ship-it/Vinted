import { env } from "../config/env.js";
import { db, forEachUser, withLock } from "../db/index.js";
import { importChromeLogin } from "../modules/accounts/chromeLogin.js";
import { syncAccount } from "../modules/accounts/sync.js";
import { VintedError } from "../vinted/vintedClient.js";
import { runDueActions, scheduleStaleListingActions } from "../modules/automations/engine.js";
import { processDueQueue } from "../modules/listings/queue.js";

/**
 * Background loops. Each loop is guarded against overlap; intervals are
 * deliberately conservative (see POLL_INTERVAL_MINUTES, minimum 5).
 */
function loop(name: string, everyMs: number, fn: () => Promise<unknown>, initialDelayMs = 5_000) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (e) {
      console.error(`[${name}]`, (e as Error).message);
    } finally {
      running = false;
    }
  };
  const t = setTimeout(() => { void tick(); }, initialDelayMs);
  const i = setInterval(() => { void tick(); }, everyMs);
  return () => { clearTimeout(t); clearInterval(i); };
}

const chromeRetry = new Map<number, number>();

/** Local: takes the login from the Vinted-Chrome and syncs; false if that did not work. */
async function renewFromChrome(id: number): Promise<boolean> {
  try {
    await importChromeLogin(id);
    await syncAccount(id);
    console.log(`[poll] account ${id}: Login aus dem Vinted-Chrome erneuert`);
    return true;
  } catch {
    return false; // Chrome not running or not logged in
  }
}

/** Syncs every connected account whose last sync is older than the poll interval. */
export async function pollAccounts(force = false) {
  const cutoff = new Date(Date.now() - env.pollIntervalMinutes * 60_000).toISOString();
  const due = await db.all<{ id: number }>(`SELECT id FROM accounts WHERE session_encrypted IS NOT NULL AND polling_enabled = 1
    AND status IN ('connected','pending') AND (@force = 1 OR last_sync_at IS NULL OR last_sync_at <= @cutoff)`,
    { cutoff, force: force ? 1 : 0 });
  for (const { id } of due) {
    try {
      await syncAccount(id);
    } catch (e) {
      // Local: login expired → take the current one from the Vinted-Chrome and try once more.
      if (env.appMode === "local" && e instanceof VintedError && e.code === "auth" && (await renewFromChrome(id))) continue;
      console.warn(`[poll] account ${id}:`, (e as Error).message);
    }
  }
  // Local: accounts stuck on an expired login get a fresh one from the Chrome (at most once per poll interval).
  if (env.appMode !== "local") return;
  const broken = await db.all<{ id: number }>("SELECT id FROM accounts WHERE status = 'error' AND polling_enabled = 1 AND session_encrypted IS NOT NULL");
  for (const { id } of broken) {
    if (!force && Date.now() - (chromeRetry.get(id) ?? 0) < env.pollIntervalMinutes * 60_000) continue;
    chromeRetry.set(id, Date.now());
    await renewFromChrome(id);
  }
}

export function startWorkers() {
  if (env.disableWorkers) return () => {};
  const stops = [
    // With several API instances only one runs each job at a time (Postgres advisory lock).
    loop("poll", 60_000, () => withLock("jobs:poll", () => forEachUser(() => pollAccounts()))),
    loop("publish", 60_000, () => withLock("jobs:publish", () => forEachUser(processDueQueue)), 10_000),
    loop("actions", 60_000, () => withLock("jobs:actions", () => forEachUser(() => runDueActions()))),
    loop("stale", 60 * 60_000, () => withLock("jobs:stale", () => forEachUser(() => scheduleStaleListingActions())), 30_000),
  ];
  console.log(`[workers] gestartet (Polling alle ${env.pollIntervalMinutes} min, Veröffentlichung alle ${env.publishIntervalMinutes} min)`);
  return () => stops.forEach((s) => s());
}
