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
const prices = new Map<string, number>(); // fake Vinted: item id → price in cents
const chats: { path: string; text: string; offer: string | null }[] = [];
const deleted = new Set<string>(); // fake Vinted: deleted item ids // fake Vinted: messages/offers that arrived

// Fake Vinted chat: optional offer dialog, message box, "Senden" shows the message in the chat.
const CHAT_PAGE = (withOffer: boolean) => `<!doctype html><html><body>
  <div id="log"></div>
  ${withOffer ? `<button id="ob" onclick="document.getElementById('dlg').style.display='block'">Angebot machen</button>
  <div id="dlg" role="dialog" style="display:none"><label for="op">Preis</label><input id="op" name="price">
    <button onclick="window.offer=document.getElementById('op').value; document.getElementById('dlg').style.display='none'">Angebot senden</button></div>` : ""}
  <textarea placeholder="Nachricht schreiben"></textarea>
  <button id="send">Senden</button>
  <script>
    document.getElementById('send').onclick = () => {
      const t = document.querySelector('textarea');
      fetch('/sent?path=' + encodeURIComponent(location.pathname + location.search) + '&offer=' + encodeURIComponent(window.offer || '') + '&text=' + encodeURIComponent(t.value))
        .then(() => { const p = document.createElement('p'); p.textContent = t.value; document.getElementById('log').append(p); t.value = ''; });
    };
  </script></body></html>`;
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
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname.startsWith("/items/new")) return res.end(SELL_PAGE);
    if (url.pathname.startsWith("/inbox/")) return res.end(CHAT_PAGE(false));
    if (/^\/items\/\d+\/want_it\/new$/.test(url.pathname)) return res.end(CHAT_PAGE(true));
    if (url.pathname === "/delete") {
      deleted.add(url.searchParams.get("id")!);
      return res.end("ok");
    }
    const own = /^\/items\/(\d+)$/.exec(url.pathname);
    if (own && deleted.has(own[1]!)) { res.statusCode = 404; return res.end("<html><body>Seite nicht gefunden</body></html>"); }
    if (own && own[1]!.startsWith("80")) {
      // Own item with "Löschen" + confirm dialog
      return res.end(`<!doctype html><html><body>Artikel online <button onclick="document.getElementById('d').style.display='block'">Löschen</button>
        <div id="d" role="dialog" style="display:none">Wirklich löschen? <button onclick="fetch('/delete?id=${own[1]}').then(() => location.href = '/')">Artikel löschen</button></div></body></html>`);
    }
    if (url.pathname === "/sent") {
      chats.push({ path: url.searchParams.get("path")!, text: url.searchParams.get("text")!, offer: url.searchParams.get("offer") || null });
      return res.end("ok");
    }
    // Fake edit/save/item pages for "Preis senken"
    const edit = /^\/items\/(\d+)\/edit$/.exec(url.pathname);
    if (edit) {
      const id = edit[1]!;
      if (id === "999") { res.writeHead(302, { location: `/items/${id}` }); return res.end(); } // not own item
      return res.end(`<!doctype html><html><body><label for="price">Preis</label><input id="price" name="price" value="${(prices.get(id) ?? 2400) / 100}">
        <button onclick="fetch('/save?id=${id}&price=' + encodeURIComponent(document.getElementById('price').value)).then(() => location.href = '/items/${id}')">Speichern</button></body></html>`);
    }
    if (url.pathname === "/save") {
      const v = (url.searchParams.get("price") ?? "").replace(",", ".");
      prices.set(url.searchParams.get("id")!, Math.round(Number(v) * 100));
      return res.end("ok");
    }
    const item = /^\/items\/(\d+)/.exec(url.pathname);
    if (item) {
      const c = prices.get(item[1]!) ?? 2400;
      return res.end(`<html><body>Artikel online <div data-testid="item-price">${(c / 100).toFixed(2).replace(".", ",")} €</div></body></html>`);
    }
    res.end("<html><body>Artikel online</body></html>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const port = 9300 + Math.floor(Math.random() * 500);
  chrome = spawn(CHROME, ["--headless=new", "--no-sandbox", `--remote-debugging-port=${port}`, `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), "vc-"))}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
  await waitFor(() => fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok));
  process.env.CHROME_DEBUG_URL = `http://127.0.0.1:${port}`;
  process.env.VINTED_SELL_URL = `${base}/items/new`;
  process.env.VINTED_BASE_URL = base;
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
    const acc = (await db.insert("INSERT INTO accounts (name, domain, status) VALUES ('Vinted 1', 'vinted.de', 'connected')"));
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
    const acc = (await db.insert("INSERT INTO accounts (name, domain, status) VALUES ('Vinted 2', 'vinted.de', 'connected')"));
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


  it("uses the account's own Chrome profile (port) – several Vinted accounts side by side", async () => {
    const { env } = await import("../src/config/env.js");
    const { stopAssist } = await import("../src/modules/assist/assistant.js");
    const port = Number(new URL(process.env.CHROME_DEBUG_URL!).port);
    const acc = (await request(app).post("/api/accounts").send({ name: "Shop 2", domain: "vinted.de", chromePort: port })).body.account;
    expect(acc.chrome_port).toBe(port);
    const photo = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#999" } }).jpeg().toBuffer();
    const draft = (await request(app).post("/api/listings/drafts").attach("photos", photo, "1.jpg").field("data", JSON.stringify({ title: "Port-Test" }))).body.item;
    const old = env.chromeDebugUrl;
    env.chromeDebugUrl = "http://127.0.0.1:1"; // the default Chrome is not running
    try {
      const res = await request(app).post("/api/assist/start").send({ itemIds: [draft.id], accountId: acc.id });
      expect(res.status).toBe(200);
      // An account without its own port still points at the (missing) default Chrome.
      const other = (await request(app).post("/api/accounts").send({ name: "Shop 3", domain: "vinted.de" })).body.account;
      const fail = await request(app).post("/api/assist/start").send({ itemIds: [draft.id], accountId: other.id });
      expect(fail.status).toBe(503);
    } finally {
      stopAssist();
      env.chromeDebugUrl = old;
    }
  }, 60_000);

  it("takes the Vinted login from the Vinted-Chrome (button + automatic renewal)", async () => {
    // Fake Vinted (this file loads the app fresh, so set it on that copy)
    const { vintedClient } = await import("../src/vinted/vintedClient.js");
    vintedClient.useAdapter((await import("./support/mockAdapter.js")).mockAdapter, 0);
    const b = await chromium.connectOverCDP(process.env.CHROME_DEBUG_URL!);
    const ctx = b.contexts()[0]!;
    const acc = (await request(app).post("/api/accounts").send({ name: "Chrome-Login", domain: "vinted.at" })).body.account;
    // Not logged in at vinted.at yet → clear message
    const missing = await request(app).post(`/api/accounts/${acc.id}/chrome-login`);
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/niemand bei vinted\.at eingeloggt/);

    await ctx.addCookies([
      { name: "access_token_web", value: "token-from-chrome-abcd", url: "https://www.vinted.at/" },
      { name: "refresh_token_web", value: "refresh-from-chrome", url: "https://www.vinted.at/" },
    ]);
    const ok = await request(app).post(`/api/accounts/${acc.id}/chrome-login`);
    expect(ok.status).toBe(200);
    expect(ok.body.error).toBeNull();
    expect(ok.body.account).toMatchObject({ status: "connected", session_hint: "••••abcd", has_refresh_token: true });

    // Expired login (account on "error") → the background sync takes the current one from the Chrome.
    const expired = await request(app).patch(`/api/accounts/${acc.id}`).send({ sessionToken: "invalid-expired-token" });
    expect(expired.body.account.status).toBe("error");
    await ctx.addCookies([{ name: "access_token_web", value: "token-renewed-wxyz", url: "https://www.vinted.at/" }]);
    const { pollAccounts } = await import("../src/workers/scheduler.js");
    await pollAccounts(true);
    const after = (await request(app).get(`/api/accounts/${acc.id}`)).body.account;
    expect(after).toMatchObject({ status: "connected", session_hint: "••••wxyz" });
    await b.close();
  }, 60_000);

  it("lowers prices in the Vinted-Chrome: listings with few views, preview, progress, verified", async () => {
    const acc = (await request(app).post("/api/accounts").send({ name: "Preis-Shop", domain: "vinted.de" })).body.account;
    const make = async (title: string, vintedId: string, priceCents: number) => {
      const item = (await request(app).post("/api/archive").send({ title, price_cents: priceCents })).body;
      await request(app).post(`/api/archive/${item.id}/listings`).send({ accountId: acc.id, url: `https://www.vinted.de/items/${vintedId}-x`, priceCents });
      return item.id as number;
    };
    await make("Ladenhüter Tee", "4242", 2400);
    await make("Fremder Artikel", "999", 3000);
    await make("Beliebtes Shirt", "5151", 2000);
    const { db } = await import("../src/db/index.js");
    await db.run("UPDATE accounts SET status = 'connected' WHERE id = ?", [acc.id]); // only connected shops count
    await db.run("UPDATE listings SET views = 3, listed_at = '2026-01-01T00:00:00.000Z' WHERE vinted_item_id IN ('4242','999')");
    await db.run("UPDATE listings SET views = 400 WHERE vinted_item_id = '5151' OR account_id <> ?", [acc.id]); // others: popular

    const preview = (await request(app).post("/api/reprice/preview").send({ percent: 10, maxViews: 20, minDays: 7 })).body;
    expect(preview.map((p: { title: string; oldCents: number; newCents: number }) => [p.title, p.oldCents, p.newCents])).toEqual([
      ["Ladenhüter Tee", 2400, 2200], ["Fremder Artikel", 3000, 2800],
    ]);

    const start = await request(app).post("/api/reprice/start").send({ percent: 10, maxViews: 20, minDays: 7 });
    expect(start.status).toBe(200);
    const done = await waitFor(async () => {
      const s = (await request(app).get("/api/reprice/status")).body;
      return s.state === "done" && s;
    }, 60_000);
    expect(done.items.map((i: { title: string; state: string }) => [i.title, i.state])).toEqual([["Ladenhüter Tee", "done"], ["Fremder Artikel", "failed"]]);
    expect(done.items[0].message).toBe("Preis geändert");
    expect(done.items[1].message).toMatch(/Bearbeiten nicht möglich/);
    expect(prices.get("4242")).toBe(2200); // the fake Vinted really got the new price
    const l = await db.get<{ price_cents: number; last_price_drop_at: string | null }>("SELECT price_cents, last_price_drop_at FROM listings WHERE vinted_item_id = '4242'");
    expect(l).toMatchObject({ price_cents: 2200 });
    expect(l!.last_price_drop_at).not.toBeNull();
    expect(await db.get("SELECT reason FROM listing_price_changes ORDER BY id DESC LIMIT 1")).toEqual({ reason: "Preissenkung −10 %" });

    // Explicit selection works too; the popular item stays untouched otherwise.
    const pick = (await request(app).post("/api/reprice/preview").send({ percent: 50, minPriceCents: 1500, listingIds: [(await db.get<{ id: number }>("SELECT id FROM listings WHERE vinted_item_id = '5151'"))!.id] })).body;
    expect(pick).toEqual([expect.objectContaining({ title: "Beliebtes Shirt", oldCents: 2000, newCents: 1500, skip: null })]);
  }, 90_000);

  it("writes every seller of an open purchase in the Vinted-Chrome – once", async () => {
    const acc = (await request(app).post("/api/accounts").send({ name: "Käufer-Shop", domain: "vinted.de", sessionToken: "token-buyer" })).body.account;
    expect(acc.status).toBe("connected");
    const pv = (await request(app).get("/api/outreach/preview").query({ kind: "purchases" })).body;
    expect(pv.defaultText).toBe("Hey ich fahre bald in den Urlaub kannst du bitte möglichst schnell verschicken");
    const mine = pv.targets.filter((t: { accountId: number }) => t.accountId === acc.id);
    expect(mine.map((t: { name: string; path: string }) => [t.name, t.path])).toEqual([["beanie_shop", "/inbox/7001"], ["retro_rina", "/inbox/7002"]]);

    const start = await request(app).post("/api/outreach/start").send({ kind: "purchases", keys: mine.map((t: { key: string }) => t.key), text: pv.defaultText });
    expect(start.status).toBe(200);
    const done = await waitFor(async () => {
      const s = (await request(app).get("/api/outreach/status")).body;
      return s.state === "done" && s;
    }, 60_000);
    expect(done.items.map((i: { state: string }) => i.state)).toEqual(["done", "done"]);
    expect(chats.filter((c) => c.path.startsWith("/inbox/")).map((c) => [c.path, c.text])).toEqual([
      ["/inbox/7001", pv.defaultText], ["/inbox/7002", pv.defaultText],
    ]);
    // Second time: nobody gets it twice.
    const again = (await request(app).get("/api/outreach/preview").query({ kind: "purchases" })).body.targets.filter((t: { accountId: number }) => t.accountId === acc.id);
    expect(again.every((t: { alreadySent: boolean }) => t.alreadySent)).toBe(true);
    expect((await request(app).post("/api/outreach/start").send({ kind: "purchases", keys: mine.map((t: { key: string }) => t.key), text: "x" })).status).toBe(400);
  }, 90_000);

  it("sends an offer −10 % (even euros) to members who favourited an active item", async () => {
    const { db } = await import("../src/db/index.js");
    const acc = (await db.get<{ id: number }>("SELECT id FROM accounts WHERE name = 'Käufer-Shop'"))!;
    const item = (await request(app).post("/api/archive").send({ title: "Favoriten Hoodie", price_cents: 3500 })).body;
    const listing = (await request(app).post(`/api/archive/${item.id}/listings`).send({ accountId: acc.id, url: "https://www.vinted.de/items/6060-x", priceCents: 3500 })).body;
    await db.run("INSERT INTO vinted_events (account_id, type, external_id, listing_id, vinted_user_id, vinted_username, occurred_at) VALUES (?, 'favourite', 'f1', ?, '777', 'lena_m', ?)",
      [acc.id, listing.id, new Date().toISOString()]);
    const pv = (await request(app).get("/api/outreach/preview").query({ kind: "favourites", percent: 10 })).body;
    const t = pv.targets.find((x: { title: string }) => x.title === "Favoriten Hoodie");
    expect(t).toMatchObject({ name: "lena_m", offerCents: 3200, oldCents: 3500, path: "/items/6060/want_it/new?receiver_id=777", skip: null });

    await request(app).post("/api/outreach/start").send({ kind: "favourites", keys: [t.key], text: pv.defaultText, percent: 10 });
    const done = await waitFor(async () => {
      const s = (await request(app).get("/api/outreach/status")).body;
      return s.state === "done" && s;
    }, 60_000);
    expect(done.items[0]).toMatchObject({ state: "done", message: "Angebot 32 € gesendet" });
    expect(chats.at(-1)).toEqual({ path: "/items/6060/want_it/new?receiver_id=777", offer: "32", text: "Hey lena_m, du hast „Favoriten Hoodie“ favorisiert – ich mach dir ein Angebot: 32 € statt 35 € 🙂" });
  }, 90_000);

  it("re-uploads an online listing: deleted on Vinted, then prepared again", async () => {
    const { db } = await import("../src/db/index.js");
    const acc = (await db.get<{ id: number }>("SELECT id FROM accounts WHERE name = 'Käufer-Shop'"))!;
    const jpg = await sharp({ create: { width: 60, height: 80, channels: 3, background: "#c80" } }).jpeg().toBuffer();
    const draft = (await request(app).post("/api/listings/drafts").attach("photos", jpg, "r.jpg").field("data", JSON.stringify({ title: "Reupload Weste", price_cents: 2000 }))).body.item;
    const listing = (await request(app).post(`/api/archive/${draft.id}/listings`).send({ accountId: acc.id, url: "https://www.vinted.de/items/8080-weste", priceCents: 2000 })).body;

    // Uploading it again while it is online: stop.
    const dup = await request(app).post("/api/assist/start").send({ itemIds: [draft.id], accountId: acc.id });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatch(/Stopp! Schon online/);

    const res = await request(app).post(`/api/reupload/${listing.id}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe("Auf Vinted gelöscht");
    expect(deleted.has("8080")).toBe(true);
    expect((await db.get<{ status: string }>("SELECT status FROM listings WHERE id = ?", [listing.id]))!.status).toBe("removed");
    expect(res.body.assist.tabs.some((t: { itemId: number }) => t.itemId === draft.id)).toBe(true); // the assistant prepares it again
    await request(app).post("/api/assist/stop");

    // Not an own item / no delete button → clear error, listing stays online.
    const other = (await request(app).post(`/api/archive/${draft.id}/listings`).send({ accountId: acc.id, url: "https://www.vinted.de/items/9191-x", priceCents: 2000 })).body;
    const bad = await request(app).post(`/api/reupload/${other.id}`);
    expect(bad.status).toBe(502);
    expect(bad.body.error).toMatch(/Löschen/);
    expect((await db.get<{ status: string }>("SELECT status FROM listings WHERE id = ?", [other.id]))!.status).toBe("active");
  }, 90_000);

  it("re-uploads several selected listings: deletes all first, keeps each current price", async () => {
    const { db } = await import("../src/db/index.js");
    const acc = (await db.get<{ id: number }>("SELECT id FROM accounts WHERE name = 'Käufer-Shop'"))!;
    const jpg = (c: string) => sharp({ create: { width: 60, height: 80, channels: 3, background: c } }).jpeg().toBuffer();
    const mk = async (title: string, vid: string, itemPrice: number, listingPrice: number) => {
      const d = (await request(app).post("/api/listings/drafts").attach("photos", await jpg(vid === "8081" ? "#a0a" : "#0aa"), "x.jpg").field("data", JSON.stringify({ title, price_cents: itemPrice }))).body.item;
      const l = (await request(app).post(`/api/archive/${d.id}/listings`).send({ accountId: acc.id, url: `https://www.vinted.de/items/${vid}-x`, priceCents: itemPrice })).body;
      await db.run("UPDATE listings SET price_cents = ? WHERE id = ?", [listingPrice, l.id]); // e.g. lowered on Vinted since
      return { item: d.id as number, listing: l.id as number };
    };
    const a = await mk("Batch Hoodie", "8081", 3500, 3200);
    const b = await mk("Batch Jeans", "8082", 2800, 2800);

    const start = await request(app).post("/api/reupload").send({ listingIds: [a.listing, b.listing] });
    expect(start.status).toBe(200);
    const done = await waitFor(async () => {
      const s = (await request(app).get("/api/reupload/status")).body;
      return s.state === "done" && s;
    }, 60_000);
    expect(done.items.map((i: { state: string }) => i.state)).toEqual(["deleted", "deleted"]);
    expect(deleted.has("8081") && deleted.has("8082")).toBe(true);
    const item = (await request(app).get(`/api/archive/${a.item}`)).body.item;
    expect(item).toMatchObject({ price_cents: 3200, price_confirmed: 1 }); // price of the old listing
    const st = (await request(app).get("/api/assist/status")).body;
    expect(st.tabs.map((t: { itemId: number }) => t.itemId)).toEqual(expect.arrayContaining([a.item, b.item]));
    await request(app).post("/api/assist/stop");
  }, 120_000);
});
