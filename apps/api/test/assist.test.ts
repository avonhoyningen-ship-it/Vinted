import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium } from "playwright-core";

const CHROME = "/opt/pw-browsers/chromium";
const hasChrome = fs.existsSync(CHROME);

// A stand-in for Vinted's sell page: file input, title, description, price (rendered late) and an upload button.
const SELL_PAGE = `<!doctype html><html><body>
  <input type="file" multiple accept="image/*" id="photos" style="display:none">
  <label for="t">Titel</label><input id="t" data-testid="title--input">
  <label for="d">Beschreibung</label><textarea id="d" name="description"></textarea>
  <div id="later"></div>
  <script>setTimeout(() => { later.innerHTML = '<label for="p">Preis</label><input id="p" name="price">'; }, 2000)</script>
  <button id="upload" onclick="location.href='/items/5550001-sakura-tee'">Hochladen</button>
</body></html>`;

let server: http.Server;
let chrome: ChildProcess;
let app: import("express").Express;
let base = "";

async function waitFor<T>(fn: () => Promise<T | undefined | false>, ms = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 200));
  }
}

beforeAll(async () => {
  if (!hasChrome) return;
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(req.url?.startsWith("/items/new") ? SELL_PAGE : "<html><body>Artikel online</body></html>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const port = 9300 + Math.floor(Math.random() * 500);
  chrome = spawn(CHROME, ["--headless=new", "--no-sandbox", `--remote-debugging-port=${port}`, `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), "vc-"))}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
  await waitFor(() => fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok));
  process.env.CHROME_DEBUG_URL = `http://127.0.0.1:${port}`;
  process.env.VINTED_SELL_URL = `${base}/items/new`;
  vi.resetModules();
  app = (await import("../src/app.js")).createApp();
}, 30_000);

afterAll(() => {
  chrome?.kill();
  server?.close();
});

describe.skipIf(!hasChrome)("posting assistant (Vinted-Chrome via CDP)", () => {
  it("explains when the Vinted-Chrome is not running", async () => {
    const { startAssist } = await import("../src/modules/assist/assistant.js");
    const { env } = await import("../src/config/env.js");
    const old = env.chromeDebugUrl;
    env.chromeDebugUrl = "http://127.0.0.1:1";
    try {
      await expect(startAssist([1], 1)).rejects.toThrow(/Chrome fuer Vinted starten/);
    } finally {
      env.chromeDebugUrl = old;
    }
  });

  it("fills the sell page, waits for the seller's upload click and links the listing", async () => {
    const { db } = await import("../src/db/index.js");
    const acc = Number(db.prepare("INSERT INTO accounts (name, domain, status) VALUES ('Vinted 1', 'vinted.de', 'connected')").run().lastInsertRowid);
    const photo = (c: string) => sharp({ create: { width: 40, height: 50, channels: 3, background: c } }).jpeg().toBuffer();
    const draft = (await request(app).post("/api/listings/drafts")
      .attach("photos", await photo("#a33"), "1.jpg").attach("photos", await photo("#3a3"), "2.jpg")
      .field("data", JSON.stringify({ title: "Sakura Tee", description: "- 🌸 Print\n- 📦 Ich versende fix", price_cents: 2450 }))).body.item;

    const start = await request(app).post("/api/assist/start").send({ itemIds: [draft.id], accountId: acc });
    expect(start.status).toBe(200);

    const waiting = await waitFor(async () => {
      const s = (await request(app).get("/api/assist/status")).body;
      return s.state === "waiting" && s;
    });
    expect(waiting.filled).toEqual(["2 Fotos", "Titel", "Beschreibung", "Preis"]);
    expect(waiting.fields).toEqual([]);

    // Look at the form like the seller would, then click "Hochladen".
    const b = await chromium.connectOverCDP(process.env.CHROME_DEBUG_URL!);
    const page = b.contexts()[0]!.pages().find((p) => p.url().includes("/items/new"))!;
    expect(await page.inputValue("#t")).toBe("Sakura Tee");
    expect(await page.inputValue("#d")).toBe("- 🌸 Print\n- 📦 Ich versende fix");
    expect(await page.inputValue("#p")).toBe("24,50");
    expect(await page.evaluate(() => (document.getElementById("photos") as HTMLInputElement).files!.length)).toBe(2);
    await page.click("#upload");

    const done = await waitFor(async () => {
      const s = (await request(app).get("/api/assist/status")).body;
      return s.done.length === 1 && s;
    });
    expect(done.done[0]).toMatchObject({ itemId: draft.id, url: `${base}/items/5550001-sakura-tee` });
    const detail = (await request(app).get(`/api/archive/${draft.id}`)).body;
    expect(detail.item.status).toBe("active");
    expect(detail.listings[0]).toMatchObject({ vinted_item_id: "5550001", price_cents: 2450 });
    await b.close();
  }, 60_000);

});
