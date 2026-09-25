/**
 * PC-Helfer for the cloud dashboard. Runs on the seller's PC:
 *
 *   npm run helper -w apps/api            (or "PC-Helfer starten.bat")
 *   npm run helper -w apps/api -- --url https://api.example.com --key ask_...
 *
 * First start asks for the dashboard address and the pairing key (Dashboard →
 * Accounts → PC-Helfer). Settings and the Vinted logins are stored in
 * ~/.ask-helper (logins AES-256-GCM encrypted with a key that never leaves this PC).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import type { LoginStore, StoredLogin } from "./runtime.js";

const DIR = process.env.ASK_HELPER_DIR || path.join(os.homedir(), ".ask-helper");
const CONFIG = path.join(DIR, "config.json");
const KEY = path.join(DIR, "key");
const LOGINS = path.join(DIR, "logins.json");

interface Config { apiUrl: string; token: string }

function arg(name: string) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function loadConfig(): Promise<Config> {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  let cfg: Partial<Config> = fs.existsSync(CONFIG) ? JSON.parse(fs.readFileSync(CONFIG, "utf8")) : {};
  const url = arg("--url") ?? process.env.ASK_API_URL;
  const key = arg("--key");
  if (url) cfg.apiUrl = url;
  if (key) cfg.token = key;
  if (!cfg.apiUrl || !cfg.token) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log("Einrichtung des PC-Helfers (einmalig)\n");
    if (!cfg.apiUrl) cfg.apiUrl = (await rl.question("Adresse der Dashboard-API (z. B. https://api.deine-domain.de): ")).trim();
    if (!cfg.token) cfg.token = (await rl.question("Helfer-Schlüssel aus dem Dashboard (beginnt mit ask_): ")).trim();
    rl.close();
  }
  cfg = { apiUrl: cfg.apiUrl!.replace(/\/+$/, "").replace(/\/api$/, ""), token: cfg.token! };
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return cfg as Config;
}

/** Local key for the stored Vinted logins (created once, stays on this PC). */
function localKey(): string {
  if (!fs.existsSync(KEY)) fs.writeFileSync(KEY, crypto.randomBytes(32).toString("base64"), { mode: 0o600 });
  return fs.readFileSync(KEY, "utf8").trim();
}

async function main() {
  const cfg = await loadConfig();
  // The shared modules read their settings from the environment – set them before loading.
  process.env.ENCRYPTION_KEY = localKey();
  process.env.DISABLE_WORKERS = "true";
  const { encrypt, decrypt } = await import("../lib/crypto.js");
  const { env } = await import("../config/env.js");
  const { VintedClient } = await import("../vinted/vintedClient.js");
  const { liveAdapter } = await import("../vinted/liveAdapter.js");
  const assistant = await import("../modules/assist/assistant.js");
  const { chromium } = await import("playwright-core");
  const { createHelper } = await import("./runtime.js");

  const readAll = (): Record<string, string> => (fs.existsSync(LOGINS) ? JSON.parse(fs.readFileSync(LOGINS, "utf8")) : {});
  const logins: LoginStore = {
    get(id) {
      const enc = readAll()[id];
      return enc ? (JSON.parse(decrypt(enc)) as StoredLogin) : undefined;
    },
    set(id, login) {
      const all = readAll();
      all[id] = encrypt(JSON.stringify(login));
      fs.writeFileSync(LOGINS, JSON.stringify(all, null, 2), { mode: 0o600 });
    },
    delete(id) {
      const all = readAll();
      delete all[id];
      fs.writeFileSync(LOGINS, JSON.stringify(all, null, 2), { mode: 0o600 });
    },
  };

  const log = (msg: string) => console.log(`[${new Date().toLocaleTimeString("de-DE")}] ${msg}`);
  const helper = createHelper({
    log,
    logins,
    vinted: new VintedClient(liveAdapter, env.vintedMinRequestGapMs),
    cloud: (pathname, init = {}) => fetch(`${cfg.apiUrl}${pathname}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${cfg.token}`, ...(init.json !== undefined ? { "content-type": "application/json" } : {}) },
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
      signal: AbortSignal.timeout(60_000),
    }),
    async readVintedCookies(domain, chromeUrl) {
      let browser;
      try {
        browser = await chromium.connectOverCDP(chromeUrl || env.chromeDebugUrl, { timeout: 5000 });
      } catch {
        throw Object.assign(new Error("Das Vinted-Chrome läuft nicht – bitte „Chrome fuer Vinted starten.bat“ öffnen und bei Vinted einloggen."), { code: "chrome" });
      }
      const cookies = await browser.contexts()[0]!.cookies(`https://www.${domain}/`);
      await browser.close().catch(() => {}); // only disconnects, Chrome stays open
      const get = (n: string) => cookies.find((c) => c.name === n)?.value ?? null;
      return { access: get("access_token_web"), refresh: get("refresh_token_web") };
    },
    assistant: {
      setSource: assistant.setAssistSource,
      start: assistant.startAssist,
      skip: assistant.skipAssist,
      stop: assistant.stopAssist,
      status: assistant.getAssistStatus,
    },
  });

  const me = await fetch(`${cfg.apiUrl}/api/helper/me`, { headers: { authorization: `Bearer ${cfg.token}` } }).catch(() => null);
  if (me?.status === 401) {
    console.error("Der Helfer-Schlüssel ist ungültig oder wurde widerrufen. Im Dashboard einen neuen erzeugen und mit --key angeben.");
    process.exit(1);
  }
  log(me?.ok ? `Verbunden mit ${cfg.apiUrl} (${((await me.json()) as { email?: string }).email ?? "dein Konto"}). Dieses Fenster offen lassen.` : `Dashboard ${cfg.apiUrl} gerade nicht erreichbar – versuche es weiter …`);

  let wait = 0;
  for (;;) {
    try {
      const r = await helper.pollOnce();
      if (r.status === 401) {
        console.error("Der Helfer-Schlüssel wurde widerrufen. Bitte im Dashboard einen neuen erzeugen.");
        process.exit(1);
      }
      if (r.status === 402) {
        log("Kein aktives Abo – der Helfer wartet. (Abo im Dashboard unter „Abo“)");
        await new Promise((res) => setTimeout(res, 5 * 60_000));
        continue;
      }
      if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
      wait = 0;
    } catch (e) {
      wait = Math.min(wait ? wait * 2 : 5_000, 60_000);
      log(`Verbindung zum Dashboard unterbrochen (${(e as Error).message}) – neuer Versuch in ${wait / 1000} s`);
      await new Promise((res) => setTimeout(res, wait));
    }
  }
}

main().catch((e) => {
  console.error("PC-Helfer beendet:", (e as Error).message);
  process.exit(1);
});
