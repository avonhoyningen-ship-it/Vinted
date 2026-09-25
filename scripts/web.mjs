// Starts the Next.js web app. Without DASHBOARD_PASSWORD it only listens on this PC
// (127.0.0.1) – with a password it is reachable in the local network (phone/tablet).
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try { process.loadEnvFile(path.join(root, ".env")); } catch { /* no .env yet */ }

const mode = process.argv[2] === "start" ? "start" : "dev";
const host = process.env.DASHBOARD_PASSWORD ? "0.0.0.0" : "127.0.0.1";
if (host === "127.0.0.1") console.log("[web] Kein DASHBOARD_PASSWORD gesetzt → nur auf diesem PC erreichbar (http://localhost:3000)");

const next = path.join(root, "node_modules", "next", "dist", "bin", "next");
const child = spawn(process.execPath, [next, mode, "-p", "3000", "-H", host], { cwd: path.join(root, "apps", "web"), stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
