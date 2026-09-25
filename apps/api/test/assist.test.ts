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
  <header><input id="sitesearch" placeholder="Artikel suchen"></header>
  <input type="file" multiple accept="image/*" id="photos" style="display:none">
  <label for="t">Titel</label><input id="t" data-testid="title--input">
  <label for="d">Beschreibung</label><textarea id="d" name="description"></textarea>
  <div id="later"></div>
  <script>setTimeout(() => { later.innerHTML = '<label for="p">Preis</label><input id="p" name="price">'; }, 2000)</script>
  <div class="row" data-f="cat"><span>Kategorie</span><input readonly id="cat"></div>
  <div class="row" data-f="brand"><span>Marke</span><input readonly id="brand" value="Shein"></div>
  <div class="row" data-f="size"><span>Größe</span><input readonly id="size"></div>
  <div><span>Maße (empfohlen)</span><input id="w" placeholder="Schulterweite (bspw. 20)"><input id="l" placeholder="Länge (bspw. 20)"></div>
  <div class="row" data-f="cond"><span>Zustand</span><input readonly id="cond"></div>
  <div class="row" data-f="color"><span>Farbe</span><input readonly id="color"></div>
  <div class="row" data-f="mat"><span>Material (empfohlen)</span><input readonly id="mat"></div>
  <h2>Versand</h2>
  <div class="shipping">
    <div>Bitte wähle eine Sendungsgröße aus</div>
    <div class="cell" data-v="s"><div><div>Klein</div><div>Für Artikel, die in einen großen Umschlag passen.</div></div><input type="radio" name="pkg" value="s"></div>
    <div class="cell" data-v="m"><div><span>Empfohlen</span><div>Mittel</div><div>Für Artikel, die in einen Schuhkarton passen.</div><a href="#">Infos zu Größen und Entschädigungen</a></div><input type="radio" name="pkg" value="m" checked></div>
    <div class="cell" data-v="l"><div><div>Groß</div><div>Für Artikel, die in einen Umzugskarton passen.</div></div><input type="radio" name="pkg" value="l"></div>
  </div>
  <script>document.querySelectorAll(".cell").forEach((c) => c.addEventListener("click", () => { c.querySelector("input").checked = true; }));</script>
  <div id="panel" style="display:none"></div>
  <button id="upload" onclick="location.href='/items/' + (5550000 + t.value.length) + '-item'">Hochladen</button>
  <script>
    const trees = {
      cat: { "Damen": { "Kleidung": ["Kleider"] }, "Herren": { "Kleidung": { "T-Shirts": ["Einfarbige T-Shirts", "Bedruckte T-Shirts"] } } },
      brand: ["Nike", "Graphic Tee", "Hysteric Glamour"], size: ["S / 36", "M / 38", "L / 40"],
      cond: ["Neu mit Etikett", "Sehr gut", "Gut"], color: ["Schwarz", "Weiß"], mat: ["Polyester", "Baumwolle"],
    };
    let active = null;
    document.querySelectorAll(".row input").forEach((inp) => inp.addEventListener("click", () => {
      active = { f: inp.parentElement.dataset.f, inp, node: trees[inp.parentElement.dataset.f] };
      panel.innerHTML = ""; panel.style.display = "block";
      if (active.f === "brand") { // brand: search first, options only after typing
        const s = document.createElement("input"); s.placeholder = "Marke suchen"; panel.appendChild(s); s.oninput = () => list(s.value);
      } else list("");
    }));
    function list(q) {
      panel.querySelectorAll("ul").forEach((u) => u.remove());
      const ul = document.createElement("ul"); panel.appendChild(ul);
      const n = active.node, keys = Array.isArray(n) ? n : Object.keys(n);
      keys.filter((k) => active.f !== "brand" || (q && k.toLowerCase().includes(q.toLowerCase()))).forEach((k) => {
        const li = document.createElement("li"); li.textContent = k; li.onclick = () => choose(k); ul.appendChild(li);
      });
    }
    function choose(k) {
      const n = active.node;
      if (!Array.isArray(n)) { active.node = n[k]; list(""); return; }
      active.inp.value = k; panel.style.display = "none";
    }
  </script>
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
    res.setHeader("content-type", "text/html; charset=utf-8");
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
      .field("data", JSON.stringify({
        title: "Sakura Tee", description: "- 🌸 Print\n- 📦 Ich versende fix", price_cents: 2450,
        category: "Herren > Kleidung > T-Shirts > Bedruckte T-Shirts", size: "M", condition: "very_good", color: "Weiß",
        material: "Baumwolle", brand: "Shein", measurements: "Breite 43 Länge 65",
      }))).body.item;

    const start = await request(app).post("/api/assist/start").send({ itemIds: [draft.id], accountId: acc });
    expect(start.status).toBe(200);

    const waiting = await waitFor(async () => {
      const s = (await request(app).get("/api/assist/status")).body;
      return s.state === "waiting" && s;
    });
    expect(waiting.filled).toEqual(["2 Fotos", "Titel", "Beschreibung", "Preis", "Kategorie", "Marke", "Größe", "Zustand", "Farbe", "Schulterweite", "Länge", "Paketgröße Klein"]);
    expect(waiting.fields).toEqual([]);

    // Look at the form like the seller would, then click "Hochladen".
    const b = await chromium.connectOverCDP(process.env.CHROME_DEBUG_URL!);
    const page = b.contexts()[0]!.pages().find((p) => p.url().includes("/items/new"))!;
    expect(await page.inputValue("#t")).toBe("Sakura Tee");
    expect(await page.inputValue("#d")).toBe("- 🌸 Print\n- 📦 Ich versende fix");
    expect(await page.inputValue("#p")).toBe("24,50");
    expect(await page.evaluate(() => (document.getElementById("photos") as HTMLInputElement).files!.length)).toBe(2);
    // Dropdowns: category path, brand from the T-shirt rule (via search), size by prefix, condition, color, material
    expect(await page.inputValue("#cat")).toBe("Bedruckte T-Shirts");
    expect(await page.inputValue("#brand")).toBe("Graphic Tee");
    expect(await page.inputValue("#sitesearch")).toBe(""); // never types into Vinted's site search
    expect(await page.inputValue("#size")).toBe("M / 38");
    expect(await page.inputValue("#cond")).toBe("Sehr gut");
    expect(await page.inputValue("#color")).toBe("Weiß");
    expect(await page.inputValue("#mat")).toBe(""); // material is left empty on purpose
    expect(await page.locator("input[name=pkg]:checked").getAttribute("value")).toBe("s");
    expect(await page.inputValue("#w")).toBe("43");
    expect(await page.inputValue("#l")).toBe("65");
    await page.click("#upload");

    const done = await waitFor(async () => {
      const s = (await request(app).get("/api/assist/status")).body;
      return s.done.length === 1 && s;
    });
    expect(done.done[0]).toMatchObject({ itemId: draft.id, url: `${base}/items/5550010-item` });
    const detail = (await request(app).get(`/api/archive/${draft.id}`)).body;
    expect(detail.item.status).toBe("active");
    expect(detail.listings[0]).toMatchObject({ vinted_item_id: "5550010", price_cents: 2450 });
    await b.close();
  }, 60_000);

  it("prepares several items in their own tabs; each upload is linked separately", async () => {
    const { db } = await import("../src/db/index.js");
    const acc = Number(db.prepare("INSERT INTO accounts (name, domain, status) VALUES ('Vinted 2', 'vinted.de', 'connected')").run().lastInsertRowid);
    const photo = (c: string) => sharp({ create: { width: 40, height: 50, channels: 3, background: c } }).jpeg().toBuffer();
    const make = async (data: object) => (await request(app).post("/api/listings/drafts")
      .attach("photos", await photo("#33a"), "1.jpg").field("data", JSON.stringify(data))).body.item;
    const tee = await make({ title: "Anime Print Tee", price_cents: 2000, size: "M", category: "Herren > Kleidung > T-Shirts > Bedruckte T-Shirts" });
    const hoodie = await make({ title: "Vintage College Hoodie grau", price_cents: 3500, size: "L" });

    expect((await request(app).post("/api/assist/start").send({ itemIds: [tee.id, hoodie.id], accountId: acc })).status).toBe(200);
    const ready = await waitFor(async () => {
      const s = (await request(app).get("/api/assist/status")).body;
      return s.state === "waiting" && s.tabs.every((t: { state: string }) => t.state === "ready") && s;
    }, 60_000);
    expect(ready.tabs.map((t: { itemId: number }) => t.itemId)).toEqual([tee.id, hoodie.id]);
    expect(ready.tabs[0].filled).toContain("Paketgröße Klein");
    expect(ready.tabs[1].filled).toContain("Paketgröße Mittel");

    const b = await chromium.connectOverCDP(process.env.CHROME_DEBUG_URL!);
    const open = async () => {
      const pages = b.contexts()[0]!.pages().filter((p) => p.url().includes("/items/new"));
      const out: Record<string, import("playwright-core").Page> = {};
      for (const p of pages) out[await p.inputValue("#t")] = p;
      return out;
    };
    const tabs = await open();
    expect(await tabs["Vintage College Hoodie grau"]!.locator("input[name=pkg]:checked").getAttribute("value")).toBe("m");
    // Upload the second one first – order doesn't matter.
    await tabs["Vintage College Hoodie grau"]!.click("#upload");
    await tabs["Anime Print Tee"]!.click("#upload");
    const done = await waitFor(async () => {
      const s = (await request(app).get("/api/assist/status")).body;
      return s.done.length === 2 && s;
    });
    expect(done.state).toBe("idle");
    expect(done.tabs.map((t: { state: string }) => t.state)).toEqual(["done", "done"]);
    expect((await request(app).get(`/api/archive/${tee.id}`)).body.item.status).toBe("active");
    // Uploaded drafts leave "Entwürfe" and show up under "Hochgeladen".
    const drafts = (await request(app).get("/api/listings/drafts")).body.map((d: { id: number }) => d.id);
    expect(drafts).not.toContain(tee.id);
    expect(drafts).not.toContain(hoodie.id);
    const uploaded = (await request(app).get("/api/listings/uploaded")).body.map((l: { item_id: number }) => l.item_id);
    expect(uploaded).toEqual(expect.arrayContaining([tee.id, hoodie.id]));
    expect((await request(app).get(`/api/archive/${hoodie.id}`)).body.listings[0].vinted_item_id).toBe(String(5550000 + "Vintage College Hoodie grau".length));
    await b.close();
  }, 120_000);

});
