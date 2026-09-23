import { env } from "../config/env.js";
import { db } from "../db/index.js";
import { syncAccount } from "../modules/accounts/sync.js";
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

/** Syncs every connected account whose last sync is older than the poll interval. */
export async function pollAccounts(force = false) {
  const cutoff = new Date(Date.now() - env.pollIntervalMinutes * 60_000).toISOString();
  const due = db.prepare(`SELECT id FROM accounts WHERE session_encrypted IS NOT NULL AND polling_enabled = 1
    AND status IN ('connected','pending') AND (@force = 1 OR last_sync_at IS NULL OR last_sync_at <= @cutoff)`)
    .all({ cutoff, force: force ? 1 : 0 }) as { id: number }[];
  for (const { id } of due) {
    try {
      await syncAccount(id);
    } catch (e) {
      console.warn(`[poll] account ${id}:`, (e as Error).message);
    }
  }
}

export function startWorkers() {
  if (env.disableWorkers) return () => {};
  const stops = [
    loop("poll", 60_000, () => pollAccounts()),
    loop("publish", 60_000, processDueQueue, 10_000),
    loop("actions", 60_000, () => runDueActions()),
    loop("stale", 60 * 60_000, async () => scheduleStaleListingActions(), 30_000),
  ];
  console.log(`[workers] gestartet (Polling alle ${env.pollIntervalMinutes} min, Veröffentlichung alle ${env.publishIntervalMinutes} min)`);
  return () => stops.forEach((s) => s());
}
