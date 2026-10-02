import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { env } from "../../config/env.js";
import { db } from "../../db/index.js";

/**
 * Starts the Vinted-Chrome(s) together with the dashboard: one Chrome per
 * debug port (own profile, remote debugging), exactly like
 * "Chrome fuer Vinted starten.bat". Already running ones are left alone.
 */
export interface ChromeTarget { port: number; profile: string; url: string; label: string }

const safeName = (name: string, port: number) => name.replace(/[^A-Za-z0-9_-]+/g, "") || `Account${port}`;

/** Which Chromes the accounts need: the default one (CHROME_DEBUG_URL) plus one per account with its own port. */
export function chromeTargets(accounts: { name: string; domain: string; chrome_port: number | null }[], defaultUrl: string): ChromeTarget[] {
  const out = new Map<number, ChromeTarget>();
  const m = defaultUrl.match(/^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/);
  const usesDefault = accounts.filter((a) => !a.chrome_port);
  if (m && (usesDefault.length || !accounts.length)) {
    const port = Number(m[1]);
    out.set(port, { port, profile: "C:\\vinted-chrome", url: `https://www.${usesDefault[0]?.domain ?? "vinted.de"}/`, label: "Standard" });
  }
  for (const a of accounts) {
    if (!a.chrome_port || out.has(a.chrome_port)) continue;
    const safe = safeName(a.name, a.chrome_port);
    out.set(a.chrome_port, { port: a.chrome_port, profile: `C:\\vinted-chrome-${safe}`, url: `https://www.${a.domain}/`, label: a.name });
  }
  return [...out.values()];
}

export function findChrome(): string | null {
  const candidates = [
    process.env.CHROME_PATH,
    ...(process.platform === "win32"
      ? [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA]
        .filter(Boolean).map((d) => path.join(d!, "Google", "Chrome", "Application", "chrome.exe"))
      : []),
  ];
  return candidates.find((c) => c && fs.existsSync(c)) ?? null;
}

async function running(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Starts every needed Vinted-Chrome that isn't running yet. Returns what happened, for the console. */
export async function startVintedChromes(opts: { chrome?: string | null; launch?: (chrome: string, args: string[]) => void } = {}): Promise<string[]> {
  const chrome = opts.chrome !== undefined ? opts.chrome : findChrome();
  if (!chrome) return ["Google Chrome nicht gefunden – bitte „Chrome fuer Vinted starten.bat“ nutzen oder CHROME_PATH in .env setzen."];
  const accounts = await db.all<{ name: string; domain: string; chrome_port: number | null }>("SELECT name, domain, chrome_port FROM accounts ORDER BY id");
  const launch = opts.launch ?? ((exe, args) => spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: false }).unref());
  const log: string[] = [];
  for (const t of chromeTargets(accounts, env.chromeDebugUrl)) {
    if (await running(t.port)) {
      log.push(`Vinted-Chrome (${t.label}) läuft schon auf Port ${t.port}.`);
      continue;
    }
    if (process.platform === "win32") fs.mkdirSync(t.profile, { recursive: true });
    launch(chrome, [`--remote-debugging-port=${t.port}`, `--user-data-dir=${t.profile}`, "--no-first-run", "--no-default-browser-check", t.url]);
    log.push(`Vinted-Chrome (${t.label}) gestartet: Profil ${t.profile}, Port ${t.port}.`);
  }
  return log;
}
