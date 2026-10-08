// Starts the Next.js web app. Without DASHBOARD_PASSWORD it only listens on this PC
// (127.0.0.1, development mode). With a password it is reachable from other devices
// (WLAN, Tailscale) – then it runs the optimised production build, because the dev
// server only works properly on "localhost". The build is redone automatically after updates.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webDir = path.join(root, "apps", "web");
try { process.loadEnvFile(path.join(root, ".env")); } catch { /* no .env yet */ }

const network = !!process.env.DASHBOARD_PASSWORD;
const host = network ? "0.0.0.0" : "127.0.0.1";
const wantDev = process.argv[2] !== "start" && (!network || process.env.DASHBOARD_DEV === "true");
if (!network) console.log("[web] Kein DASHBOARD_PASSWORD gesetzt → nur auf diesem PC erreichbar (http://localhost:3000)");

const next = path.join(root, "node_modules", "next", "dist", "bin", "next");
process.env.ASK_LOCAL_BUILD = "1"; // plain "next build" / "next start" (no standalone output)

/** Code version + public settings: a new build is only needed when one of them changed. */
function buildStamp() {
  let head = "";
  try { head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(); } catch { /* no git */ }
  const publicEnv = Object.entries(process.env).filter(([k]) => k.startsWith("NEXT_PUBLIC_")).sort().map(([k, v]) => `${k}=${v}`).join("\n");
  return `${head}\n${publicEnv}`;
}

if (!wantDev && process.argv[2] !== "start") {
  const stampFile = path.join(webDir, ".next", "ask-build-stamp");
  const stamp = buildStamp();
  const built = fs.existsSync(path.join(webDir, ".next", "BUILD_ID")) && fs.existsSync(stampFile) && fs.readFileSync(stampFile, "utf8") === stamp;
  if (!built) {
    console.log("[web] Baue das Dashboard für den Zugriff von anderen Geräten (1–3 Minuten, nur nach Updates) …");
    const r = spawnSync(process.execPath, [next, "build"], { cwd: webDir, stdio: "inherit" });
    if (r.status !== 0) {
      console.error("[web] Build fehlgeschlagen – starte im Entwicklungsmodus (dann nur auf diesem PC voll nutzbar).");
    } else {
      fs.writeFileSync(stampFile, stamp);
    }
  }
}

const useDev = wantDev || (process.argv[2] !== "start" && !fs.existsSync(path.join(webDir, ".next", "BUILD_ID")));
const child = spawn(process.execPath, [next, useDev ? "dev" : "start", "-p", "3000", "-H", host], { cwd: webDir, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
