import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AssistStatus } from "../lib/eventBus.js";
import type { AssistItemData, AssistSource } from "../modules/assist/assistant.js";
import type { VintedClient, VintedSession } from "../vinted/vintedClient.js";

/**
 * The PC helper's job handlers. The cloud dashboard asks, the helper acts on
 * this PC: Vinted calls from this internet connection with the login stored
 * here, reading the login from the Vinted-Chrome, and the posting assistant.
 */

export interface StoredLogin { domain: string; token: string; refreshToken: string | null; vintedUserId: string | null }

/** Vinted logins per cloud account id, kept (encrypted) on this PC only. */
export interface LoginStore {
  get(accountId: number): StoredLogin | undefined;
  set(accountId: number, login: StoredLogin): void;
  delete(accountId: number): void;
}

export interface HelperDeps {
  /** Authenticated request to the cloud API (path starting with /api/helper/…). */
  cloud(pathname: string, init?: { method?: string; json?: unknown }): Promise<Response>;
  vinted: VintedClient;
  logins: LoginStore;
  /** access/refresh token cookies of the Vinted-Chrome for a domain. */
  readVintedCookies(domain: string, chromeUrl?: string | null): Promise<{ access: string | null; refresh: string | null }>;
  assistant: {
    setSource(s: AssistSource): void;
    start(itemIds: number[], accountId: number): Promise<AssistStatus>;
    skip(itemId?: number): void;
    stop(): void;
    status(): AssistStatus;
  };
  log?: (msg: string) => void;
}

export interface Job { id: number; kind: string; payload: Record<string, unknown> }

const VINTED_METHODS = new Set(["verifySession", "fetchOwnListings", "fetchSales", "fetchFavourites", "fetchMessages", "sendMessage", "updatePrice"]);

export function createHelper(deps: HelperDeps) {
  const log = deps.log ?? (() => {});
  const photoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-helper-"));

  // ---- live events to the dashboard (latest assistant status wins) ----
  let pendingStatus: AssistStatus | null = null;
  let sending: Promise<void> | null = null;
  const sendEvents = async (events: unknown[]) => {
    const r = await deps.cloud("/api/helper/events", { method: "POST", json: { events } });
    if (!r.ok) log(`Ereignis nicht übertragen (HTTP ${r.status})`);
  };
  function pushStatus(status: AssistStatus) {
    pendingStatus = status;
    sending ??= (async () => {
      while (pendingStatus) {
        const s = pendingStatus;
        pendingStatus = null;
        await sendEvents([{ type: "assist.status", status: s }]).catch((e) => log(`Status: ${(e as Error).message}`));
      }
      sending = null;
    })();
  }

  function session(accountId: number): VintedSession {
    const login = deps.logins.get(accountId);
    if (!login) throw Object.assign(new Error("Für diesen Account ist auf diesem PC kein Vinted-Login gespeichert – im Dashboard „Mit PC-Helfer verbinden“ klicken."), { code: "auth" });
    return {
      token: login.token, refreshToken: login.refreshToken, domain: login.domain, vintedUserId: login.vintedUserId,
      // Vinted renewed the login: keep the new tokens on this PC.
      onTokens: (access, refresh) => deps.logins.set(accountId, { ...login, token: access, refreshToken: refresh ?? login.refreshToken }),
    };
  }

  const handlers: Record<string, (p: Record<string, unknown>) => Promise<unknown>> = {
    async "vinted.call"(p) {
      const method = String(p.method);
      if (!VINTED_METHODS.has(method)) throw new Error(`Aktion ${method} ist im PC-Helfer nicht erlaubt`);
      const accountId = Number(p.accountId);
      const s = session(accountId);
      const args = Array.isArray(p.args) ? p.args : [];
      const fn = (deps.vinted as unknown as Record<string, (key: string, s: VintedSession, ...a: unknown[]) => Promise<unknown>>)[method]!;
      const result = await fn.call(deps.vinted, `account:${accountId}`, s, ...args);
      if (method === "verifySession" && result && typeof result === "object" && "userId" in result) {
        const login = deps.logins.get(accountId);
        if (login) deps.logins.set(accountId, { ...login, vintedUserId: String((result as { userId: string }).userId) });
      }
      return result ?? null;
    },

    async "account.connect"(p) {
      const accountId = Number(p.accountId);
      const domain = String(p.domain);
      const { access, refresh } = await deps.readVintedCookies(domain, typeof p.chromeUrl === "string" ? p.chromeUrl : null);
      if (!access) {
        throw Object.assign(new Error(`Im Vinted-Chrome ist niemand bei ${domain} eingeloggt – bitte dort anmelden und erneut verbinden.`), { code: "auth" });
      }
      deps.logins.set(accountId, { domain, token: access, refreshToken: refresh, vintedUserId: null });
      log(`Account #${accountId} (${domain}) verbunden`);
      return { hint: `••••${access.slice(-4)}` };
    },

    async "account.forget"(p) {
      deps.logins.delete(Number(p.accountId));
      return { ok: true };
    },

    async "assist.start"(p) {
      const accountId = Number(p.accountId);
      const items = (p.items as (Omit<AssistItemData, "photoFiles"> & { photos: string[] })[]) ?? [];
      const byId = new Map(items.map((i) => [i.itemId, i]));
      const chromeUrl = items[0]?.chromeUrl ?? null;
      deps.assistant.setSource({
        chromeUrl: async () => chromeUrl,
        async check(ids) {
          return new Map(ids.map((id) => [id, byId.get(id)?.title ?? `Artikel #${id}`]));
        },
        async load(job) {
          const item = byId.get(job.itemId);
          if (!item) throw new Error(`Artikel #${job.itemId} fehlt`);
          // Photos come from the user's cloud storage into a temporary folder.
          const dir = path.join(photoDir, String(item.itemId));
          fs.mkdirSync(dir, { recursive: true });
          const photoFiles: string[] = [];
          for (const [i, name] of item.photos.entries()) {
            const r = await deps.cloud(`/api/helper/photos/${encodeURIComponent(name)}`);
            if (!r.ok) continue;
            const file = path.join(dir, `${String(i + 1).padStart(2, "0")}.jpg`);
            fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
            photoFiles.push(file);
          }
          const { photos: _photos, ...data } = item;
          return { ...data, photoFiles };
        },
        async linked(job, url) {
          await sendEvents([{ type: "assist.linked", itemId: job.itemId, accountId: job.accountId, url }]);
        },
        publish: pushStatus,
      });
      return deps.assistant.start(items.map((i) => i.itemId), accountId);
    },

    async "assist.skip"(p) {
      deps.assistant.skip(typeof p.itemId === "number" ? p.itemId : undefined);
      return deps.assistant.status();
    },

    async "assist.stop"() {
      deps.assistant.stop();
      return deps.assistant.status();
    },
  };

  /** Runs one job and reports the result to the cloud. */
  async function run(job: Job) {
    const handler = handlers[job.kind];
    let body: { ok: boolean; result?: unknown; error?: string; code?: string };
    try {
      if (!handler) throw new Error(`Unbekannter Auftrag ${job.kind} – bitte den PC-Helfer aktualisieren`);
      body = { ok: true, result: await handler(job.payload ?? {}) };
    } catch (e) {
      const err = e as Error & { code?: string; status?: number };
      const code = err.code ?? (err.status === 503 ? "chrome" : undefined);
      body = { ok: false, error: err.message.slice(0, 1900), code };
      log(`${job.kind} fehlgeschlagen: ${err.message}`);
    }
    const r = await deps.cloud(`/api/helper/jobs/${job.id}/result`, { method: "POST", json: body });
    if (!r.ok) log(`Ergebnis für Auftrag ${job.id} nicht angenommen (HTTP ${r.status})`);
  }

  /** One long-poll round: fetch jobs and start them (they run in parallel). */
  async function pollOnce(): Promise<{ status: number; jobs: number }> {
    const r = await deps.cloud("/api/helper/poll", { method: "POST", json: {} });
    if (!r.ok) return { status: r.status, jobs: 0 };
    const { jobs } = (await r.json()) as { jobs: Job[] };
    for (const job of jobs) void run(job);
    return { status: r.status, jobs: jobs.length };
  }

  return { pollOnce, run, handlers };
}
