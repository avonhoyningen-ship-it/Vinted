#!/usr/bin/env node
/**
 * Builds the PC helper as a download for Windows customers – no Node.js
 * installation needed:
 *
 *   node scripts/package-helper.mjs --api https://api.deine-domain.de [--upload]
 *
 * Result: dist/ask-helper-windows.zip with
 *   PC-Helfer starten.cmd            (double click)
 *   Chrome fuer Vinted starten.bat   (Vinted-Chrome with remote debugging)
 *   LIESMICH.txt
 *   node/node.exe                    (official Node.js LTS for Windows x64)
 *   app/helper.mjs                   (bundled helper) + default-config.json (API address)
 *   app/node_modules/playwright-core
 *
 * --upload puts the ZIP into a public Supabase bucket "downloads" (needs
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY) and prints the download link for
 * NEXT_PUBLIC_HELPER_DOWNLOAD_URL. Works on Windows, macOS and Linux.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const apiUrl = (arg("--api") || process.env.ASK_API_URL || "").replace(/\/+$/, "");
if (!/^https?:\/\//.test(apiUrl)) {
  console.error("Aufruf: node scripts/package-helper.mjs --api https://api.deine-domain.de [--upload]");
  process.exit(1);
}
const outDir = path.resolve(arg("--out") || path.join(ROOT, "dist"));
const cacheDir = path.join(os.homedir(), ".cache", "ask-helper-build");
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(cacheDir, { recursive: true });

// ---------- ZIP (deflate) ----------

function dosDateTime(d = new Date()) {
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

function writeZip(file, entries) {
  const fd = fs.openSync(file, "w");
  const central = [];
  let offset = 0;
  const { time, date } = dosDateTime();
  for (const e of entries) {
    const name = Buffer.from(e.name.replace(/\\/g, "/"), "utf8");
    const data = e.data;
    const crc = zlib.crc32(data);
    const packed = zlib.deflateRawSync(data, { level: 9 });
    const method = packed.length < data.length ? 8 : 0;
    const body = method ? packed : data;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(method, 8);
    h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12); h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(body.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(name.length, 26);
    fs.writeSync(fd, h); fs.writeSync(fd, name); fs.writeSync(fd, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(method, 10);
    c.writeUInt16LE(time, 12); c.writeUInt16LE(date, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  fs.writeSync(fd, cd); fs.writeSync(fd, end);
  fs.closeSync(fd);
}

/** Reads one file out of a ZIP (used for node.exe from the official Node.js ZIP). */
function extractFromZip(zipFile, wanted) {
  const buf = fs.readFileSync(zipFile);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    if (wanted(name)) {
      const lNameLen = buf.readUInt16LE(localOffset + 26), lExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, start + size);
      return method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error("Datei nicht im ZIP gefunden");
}

// ---------- 1. Node.js for Windows ----------

async function windowsNode() {
  const index = await (await fetch("https://nodejs.org/dist/index.json")).json();
  const lts = index.find((r) => r.lts && Number(r.version.slice(1).split(".")[0]) >= 22 && r.files.includes("win-x64-zip"));
  const version = arg("--node-version") || lts.version;
  const zipPath = path.join(cacheDir, `node-${version}-win-x64.zip`);
  if (!fs.existsSync(zipPath)) {
    console.log(`Lade Node.js ${version} für Windows …`);
    const res = await fetch(`https://nodejs.org/dist/${version}/node-${version}-win-x64.zip`);
    if (!res.ok) throw new Error(`Node.js-Download fehlgeschlagen (HTTP ${res.status})`);
    fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
  }
  return { version, exe: extractFromZip(zipPath, (n) => /^node-v[^/]+-win-x64\/node\.exe$/.test(n)) };
}

// ---------- 2. bundle the helper ----------

async function bundle() {
  const esbuild = await import("esbuild");
  const r = await esbuild.build({
    entryPoints: [path.join(ROOT, "apps/api/src/helper/main.ts")],
    bundle: true, platform: "node", format: "esm", target: "node22", write: false,
    external: ["playwright-core"],
    // CommonJS dependencies inside an ES module need a real `require`.
    banner: { js: "import { createRequire as __askCreateRequire } from 'node:module'; const require = __askCreateRequire(import.meta.url);" },
    logLevel: "warning",
  });
  return Buffer.from(r.outputFiles[0].contents);
}

function filesUnder(dir, prefix) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(full, `${prefix}/${e.name}`));
    else out.push({ name: `${prefix}/${e.name}`, data: fs.readFileSync(full) });
  }
  return out;
}

const crlf = (s) => Buffer.from(s.trim().split("\n").join("\r\n") + "\r\n", "utf8");

const LAUNCHER = `
@echo off
rem PC-Helfer fuer Alex Sales Kit - Doppelklick zum Starten.
title PC-Helfer - Alex Sales Kit
cd /d "%~dp0"
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9222/json/version -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 call "Chrome fuer Vinted starten.bat"
echo.
echo Der PC-Helfer startet. Beim ersten Start fragt er nach deinem Helfer-Schluessel
echo (Dashboard - Accounts - PC-Helfer - Neuen Schluessel erzeugen).
echo Dieses Fenster OFFEN LASSEN, solange das Dashboard mit Vinted arbeiten soll.
echo.
"%~dp0node\\node.exe" "%~dp0app\\helper.mjs" %*
pause
`;

const README = (api) => `
PC-Helfer fuer Alex Sales Kit
=============================

1. Diesen Ordner an einen festen Platz entpacken (z. B. Dokumente\\PC-Helfer).
2. "Chrome fuer Vinted starten.bat" oeffnen und im neuen Chrome-Fenster bei Vinted einloggen.
3. "PC-Helfer starten.cmd" doppelklicken. Beim ersten Start den Helfer-Schluessel eingeben
   (Dashboard -> Accounts -> PC-Helfer -> Neuen Schluessel erzeugen).
4. Im Dashboard auf der Account-Karte "Mit PC-Helfer verbinden" klicken.

Das Fenster des PC-Helfers offen lassen, solange das Dashboard mit Vinted arbeiten soll.
Deine Vinted-Anmeldung bleibt auf diesem PC (verschluesselt in %USERPROFILE%\\.ask-helper).

Dashboard-Adresse: ${api}
Mehrere Vinted-Accounts: pro Account ein eigenes Chrome-Profil, Startdatei gibt es im Dashboard
auf der Account-Karte ("Chrome fuer diesen Account").
`;

// ---------- 3. assemble ----------

const node = await windowsNode();
const helper = await bundle();
const entries = [
  { name: "PC-Helfer starten.cmd", data: crlf(LAUNCHER) },
  { name: "Chrome fuer Vinted starten.bat", data: fs.readFileSync(path.join(ROOT, "Chrome fuer Vinted starten.bat")) },
  { name: "LIESMICH.txt", data: crlf(README(apiUrl)) },
  { name: "node/node.exe", data: node.exe },
  { name: "app/helper.mjs", data: helper },
  { name: "app/default-config.json", data: Buffer.from(JSON.stringify({ apiUrl }, null, 2)) },
  { name: "app/package.json", data: Buffer.from(JSON.stringify({ type: "module", private: true }, null, 2)) },
  ...filesUnder(path.join(ROOT, "node_modules/playwright-core"), "app/node_modules/playwright-core"),
].map((e) => ({ ...e, name: `PC-Helfer/${e.name}` }));
const zipFile = path.join(outDir, "ask-helper-windows.zip");
writeZip(zipFile, entries);
const mb = (fs.statSync(zipFile).size / 1024 / 1024).toFixed(1);
console.log(`Fertig: ${zipFile} (${mb} MB, Node.js ${node.version}, ${entries.length} Dateien)`);

// ---------- 4. optional upload ----------

if (args.includes("--upload")) {
  const url = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("--upload braucht SUPABASE_URL und SUPABASE_SERVICE_ROLE_KEY");
  const auth = { authorization: `Bearer ${key}`, apikey: key };
  await fetch(`${url}/storage/v1/bucket`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ id: "downloads", name: "downloads", public: true }) });
  const res = await fetch(`${url}/storage/v1/object/downloads/ask-helper-windows.zip`, {
    method: "POST", headers: { ...auth, "content-type": "application/zip", "x-upsert": "true" }, body: fs.readFileSync(zipFile),
  });
  if (!res.ok) throw new Error(`Upload fehlgeschlagen (HTTP ${res.status}): ${await res.text()}`);
  console.log(`\nHochgeladen. In Vercel eintragen:\n  NEXT_PUBLIC_HELPER_DOWNLOAD_URL=${url}/storage/v1/object/public/downloads/ask-helper-windows.zip`);
}
