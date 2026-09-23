import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root (works from both src/ and dist/). */
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback === undefined) throw new Error(`Missing required env var ${name} (see .env.example)`);
    return fallback;
  }
  return v;
}

function int(name: string, fallback: number, min?: number): number {
  const raw = process.env[name];
  const n = raw ? Number.parseInt(raw, 10) : fallback;
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be an integer`);
  return min !== undefined ? Math.max(min, n) : n;
}

function resolvePath(p: string): string {
  return p === ":memory:" || path.isAbsolute(p) ? p : path.resolve(ROOT_DIR, p);
}

export const env = {
  port: int("API_PORT", 4000),
  corsOrigin: str("CORS_ORIGIN", "http://localhost:3000"),
  /** Bearer token for scripts / a future mobile app (never shipped to the browser). */
  apiToken: process.env.API_TOKEN || null,
  /** Password for the web login. Required when NODE_ENV=production. */
  dashboardPassword: process.env.DASHBOARD_PASSWORD || null,
  /** Set when running behind a reverse proxy (Caddy) so client IPs / HTTPS are detected. */
  trustProxy: process.env.TRUST_PROXY === "true",
  sessionDays: int("SESSION_DAYS", 30, 1),
  isProduction: process.env.NODE_ENV === "production",
  databasePath: resolvePath(str("DATABASE_PATH", "./data/vinted.db")),
  storageDir: resolvePath(str("STORAGE_DIR", "./data/uploads")),
  encryptionKey: str("ENCRYPTION_KEY"),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
  anthropicModel: str("ANTHROPIC_MODEL", "claude-opus-5"),
  vintedMode: str("VINTED_MODE", "mock") as "mock" | "live",
  /** Minimum 5 minutes: no aggressive polling. */
  pollIntervalMinutes: int("POLL_INTERVAL_MINUTES", 10, 5),
  /** Default gap between two queued publications on the same account. */
  publishIntervalMinutes: int("PUBLISH_INTERVAL_MINUTES", 30, 5),
  /** Minimum gap between two HTTP requests to Vinted per account. */
  vintedMinRequestGapMs: int("VINTED_MIN_REQUEST_GAP_MS", 4000, 1000),
  mockRandomEvents: process.env.MOCK_RANDOM_EVENTS === "true",
  disableWorkers: process.env.DISABLE_WORKERS === "true",
};
