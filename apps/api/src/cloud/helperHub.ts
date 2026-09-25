import crypto from "node:crypto";
import { currentUserId, db, nowIso, withSystem } from "../db/index.js";
import { HttpError } from "../lib/http.js";

/**
 * Job queue between the cloud and the user's PC helper.
 *
 * The helper keeps one long-poll request open (POST /api/helper/poll). The
 * cloud puts jobs into helper_jobs (per user, row level security) and wakes
 * that request; the helper runs the job on the user's PC (their Chrome, their
 * internet connection, their Vinted login) and posts the result back.
 * Waiting callers live in memory – run the API as a single instance.
 */

export const HELPER_ONLINE_MS = 90_000;
const POLL_WAIT_MS = 25_000;

export class HelperError extends HttpError {
  constructor(message: string, public code = "helper") {
    super(503, message);
  }
}

// ---------- tokens ----------

export const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

/** New pairing key for the PC helper – shown once, only its hash is stored. */
export async function createHelperToken(name: string) {
  const token = `ask_${crypto.randomBytes(24).toString("base64url")}`;
  const id = await db.insert("INSERT INTO helper_tokens (name, token_hash) VALUES (?, ?)", [name, hashToken(token)]);
  return { id, token };
}

/** Which user a helper token belongs to (system scope: before we know the user). */
export async function userForHelperToken(token: string): Promise<{ userId: string; tokenId: number } | null> {
  if (!/^ask_[A-Za-z0-9_-]{20,}$/.test(token)) return null;
  const row = await withSystem(() => db.get<{ id: number; user_id: string }>(
    "SELECT id, user_id FROM helper_tokens WHERE token_hash = ? AND revoked_at IS NULL", [hashToken(token)]));
  return row ? { userId: row.user_id, tokenId: Number(row.id) } : null;
}

export async function helperStatus() {
  const row = await db.get<{ last_seen_at: string | null }>("SELECT MAX(last_seen_at) last_seen_at FROM helper_tokens WHERE revoked_at IS NULL");
  const lastSeenAt = row?.last_seen_at ?? null;
  return { online: !!lastSeenAt && Date.now() - Date.parse(lastSeenAt) < HELPER_ONLINE_MS, lastSeenAt };
}

// ---------- jobs ----------

interface Waiter { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
const waiters = new Map<number, Waiter>();
const pollers = new Map<string, Set<() => void>>();

function wake(userId: string) {
  for (const w of pollers.get(userId) ?? []) w();
}

/**
 * Runs a job on the user's PC helper and waits for its result. Fails fast
 * with a clear message when the helper is not running.
 */
export async function runOnHelper<T = unknown>(kind: string, payload: unknown, opts: { timeoutMs?: number; wait?: boolean } = {}): Promise<T> {
  if (!(await helperStatus()).online) {
    throw new HelperError("Der PC-Helfer ist nicht verbunden – bitte auf deinem PC „PC-Helfer starten.bat“ öffnen.", "offline");
  }
  const userId = currentUserId();
  const id = await db.insert("INSERT INTO helper_jobs (kind, payload) VALUES (?, ?)", [kind, JSON.stringify(payload ?? {})]);
  if (opts.wait === false) {
    wake(userId);
    return id as T;
  }
  const result = new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      void db.run("UPDATE helper_jobs SET status = 'failed', error = 'Zeitüberschreitung', finished_at = ? WHERE id = ? AND status IN ('pending','running')", [nowIso(), id]);
      reject(new HelperError("Der PC-Helfer hat nicht rechtzeitig geantwortet.", "timeout"));
    }, opts.timeoutMs ?? 120_000);
    waiters.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
  });
  wake(userId);
  return result;
}

/** Pending jobs for the calling helper, marked as running. */
async function claim(limit = 10) {
  const jobs = await db.all<{ id: number; kind: string; payload: string }>(
    "SELECT id, kind, payload FROM helper_jobs WHERE status = 'pending' ORDER BY id LIMIT ?", [limit]);
  const claimed = [];
  for (const j of jobs) {
    // Only one poller gets each job.
    if (await db.run("UPDATE helper_jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'pending'", [nowIso(), j.id])) {
      claimed.push({ id: Number(j.id), kind: j.kind, payload: JSON.parse(j.payload) as unknown });
    }
  }
  return claimed;
}

/** Long poll: returns jobs as soon as there are any, or an empty list after ~25 s. */
export async function pollJobs(tokenId: number, signal?: AbortSignal) {
  await db.run("UPDATE helper_tokens SET last_seen_at = ? WHERE id = ?", [nowIso(), tokenId]);
  let jobs = await claim();
  if (jobs.length) return jobs;
  const userId = currentUserId();
  await new Promise<void>((resolve) => {
    const set = pollers.get(userId) ?? new Set();
    pollers.set(userId, set);
    const done = () => {
      clearTimeout(timer);
      set.delete(done);
      resolve();
    };
    const timer = setTimeout(done, POLL_WAIT_MS);
    set.add(done);
    signal?.addEventListener("abort", done);
  });
  await db.run("UPDATE helper_tokens SET last_seen_at = ? WHERE id = ?", [nowIso(), tokenId]);
  jobs = await claim();
  return jobs;
}

export interface JobResult { ok: boolean; result?: unknown; error?: string; code?: string }

export async function completeJob(id: number, r: JobResult) {
  const changed = await db.run("UPDATE helper_jobs SET status = ?, result = ?, error = ?, finished_at = ? WHERE id = ? AND status = 'running'",
    [r.ok ? "done" : "failed", r.ok ? JSON.stringify(r.result ?? null) : null, r.ok ? null : `${r.code ?? ""}|${r.error ?? "Fehler"}`, nowIso(), id]);
  if (!changed) return false;
  const w = waiters.get(id);
  if (w) {
    clearTimeout(w.timer);
    waiters.delete(id);
    if (r.ok) w.resolve(r.result);
    else w.reject(Object.assign(new HelperError(r.error ?? "Fehler im PC-Helfer", r.code ?? "helper"), { remoteCode: r.code }));
  }
  return true;
}
