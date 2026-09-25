import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { env } from "../../config/env.js";
import { db, nowIso } from "../../db/index.js";
import { eventBus, type AssistStatus } from "../../lib/eventBus.js";
import { HttpError } from "../../lib/http.js";
import { photoPath } from "../../storage/photos.js";
import { getAccount } from "../accounts/repo.js";
import { createListing, getItem, listPhotos } from "../archive/repo.js";
import { parseMeasurements, ruleBrand } from "../listings/brandRules.js";
import { confirmPrice } from "../pricing/engine.js";

/**
 * Posting assistant for the seller's own Vinted-Chrome (remote debugging on
 * port 9222): opens the sell page, uploads the photos and fills title,
 * description and price. The seller reviews and clicks "Hochladen" – the
 * assistant detects the new listing, links it in the archive and prepares
 * the next item. It never submits the form itself.
 */

const PUBLISH_TIMEOUT_MS = 30 * 60_000;

interface Job { itemId: number; accountId: number }

let browser: Browser | null = null;
let queue: Job[] = [];
let running = false;
let skipCurrent = false;
let status: AssistStatus = { state: "idle", itemId: null, title: null, position: 0, total: 0, filled: [], missing: [], message: null, done: [], fields: [] };

function setStatus(patch: Partial<AssistStatus>) {
  status = { ...status, ...patch };
  if (patch.state && patch.state !== "waiting" && !("fields" in patch)) status.fields = [];
  eventBus.publish({ type: "assist", status });
}

export const getAssistStatus = () => status;

async function connect(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  try {
    browser = await chromium.connectOverCDP(env.chromeDebugUrl, { timeout: 5000 });
    return browser;
  } catch {
    throw new HttpError(503, "Das Vinted-Chrome läuft nicht. Bitte zuerst „Chrome fuer Vinted starten.bat“ öffnen und bei Vinted einloggen.");
  }
}

const sellUrl = (domain: string) => env.vintedSellUrl ?? `https://www.${domain}/items/new`;
const priceText = (cents: number) => (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2).replace(".", ","));

/**
 * First visible candidate wins – Vinted may change markup, so several variants
 * are tried. The sell form renders progressively, so we keep looking for a while.
 */
async function firstVisible(candidates: Locator[], timeoutMs = 20_000): Promise<Locator | null> {
  const until = Date.now() + timeoutMs;
  do {
    for (const c of candidates) {
      const el = c.first();
      if ((await el.count().catch(() => 0)) && (await el.isVisible().catch(() => false))) return el;
    }
    await new Promise((r) => setTimeout(r, 500));
  } while (Date.now() < until);
  return null;
}

/** Short description of all form fields on the page – shown to the seller when something wasn't found. */
async function describeFields(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    document.querySelectorAll("input, textarea, select, [contenteditable=true]").forEach((el) => {
      const e = el as HTMLInputElement;
      if (e.type === "hidden") return;
      const label = e.id ? document.querySelector(`label[for="${CSS.escape(e.id)}"]`)?.textContent?.trim() : "";
      const parts = [e.tagName.toLowerCase(), e.type && `type=${e.type}`, e.id && `#${e.id}`, e.name && `name=${e.name}`,
        e.getAttribute("data-testid") && `testid=${e.getAttribute("data-testid")}`, label && `„${label.slice(0, 30)}“`,
        e.getAttribute("placeholder") && `placeholder=„${e.getAttribute("placeholder")!.slice(0, 30)}“`].filter(Boolean);
      out.push(parts.join(" "));
    });
    return out.slice(0, 40);
  }).catch(() => []);
}

async function fill(page: Page, candidates: Locator[], value: string, timeoutMs = 20_000): Promise<boolean> {
  const el = await firstVisible(candidates, timeoutMs);
  if (!el) return false;
  await el.click();
  await el.fill(value);
  return true;
}

// ---------- dropdowns (Kategorie, Marke, Größe, Zustand, Farbe, Material) ----------

const CONDITION_LABELS: Record<string, string> = {
  new_with_tags: "Neu mit Etikett", new_without_tags: "Neu ohne Etikett", very_good: "Sehr gut", good: "Gut", satisfactory: "Zufriedenstellend",
};
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Innermost block that contains the field label and an input – one row of Vinted's form. */
function fieldRow(page: Page, label: RegExp) {
  return page.locator("div, li, section").filter({ has: page.getByText(label) }).filter({ has: page.locator("input") }).last();
}

/** A visible, clickable element whose own text is exactly `text` (or starts with it for sizes). */
async function findOption(page: Page, text: string, prefix = false): Promise<Locator | null> {
  const re = prefix ? new RegExp(`^\\s*${esc(text)}(\\s|/|\\(|$)`, "i") : new RegExp(`^\\s*${esc(text)}\\s*$`, "i");
  const candidates = [
    page.getByRole("option", { name: re }), page.getByRole("radio", { name: re }), page.getByRole("checkbox", { name: re }),
    page.getByRole("button", { name: re }), page.locator("li, label, [role=button], [role=option], span, div, p").filter({ hasText: re }),
  ];
  for (const c of candidates) {
    const n = await c.count().catch(() => 0);
    for (let i = n - 1; i >= 0; i--) { // innermost / last first
      const el = c.nth(i);
      if (await el.isVisible().catch(() => false)) {
        const own = (await el.innerText().catch(() => "")).trim();
        if (re.test(own)) return el;
      }
    }
  }
  return null;
}

/**
 * Opens a dropdown row and clicks through `path` (e.g. category levels). If an
 * option isn't visible, types it into the focused search field first.
 * Leaves values alone that Vinted already filled correctly.
 */
async function pickDropdown(page: Page, label: RegExp, path: string[], prefix = false): Promise<boolean> {
  const row = fieldRow(page, label);
  if (!(await row.count().catch(() => 0))) return false;
  const input = row.locator("input").first();
  const current = (await input.inputValue().catch(() => "")).trim().toLowerCase();
  const target = path[path.length - 1]!.toLowerCase();
  if (current && (current === target || (prefix && current.startsWith(target)))) return true;

  await input.click({ timeout: 5000 });
  await page.waitForTimeout(700);
  for (const seg of path) {
    let option = await findOption(page, seg, prefix);
    if (!option) {
      // Vinted's list has a search box (brands: thousands of entries) – the focused field or any visible one.
      let search = page.locator("input:focus, textarea:focus");
      if (!(await search.count()) || !(await search.isEditable().catch(() => false))) {
        search = page.locator('input[type="search"], input[placeholder*="such" i], input[placeholder*="search" i], input[placeholder*="marke" i]')
          .filter({ visible: true }).first();
      }
      if ((await search.count()) && (await search.isEditable().catch(() => false))) {
        await search.fill(seg);
        await page.waitForTimeout(1500);
        option = await findOption(page, seg, prefix);
      }
    }
    if (!option) {
      await page.keyboard.press("Escape").catch(() => {});
      return false;
    }
    await option.click();
    await page.waitForTimeout(700);
  }
  await page.keyboard.press("Escape").catch(() => {});
  const value = (await input.inputValue().catch(() => "")).trim().toLowerCase();
  return value.includes(target) || (prefix && value.startsWith(target));
}

/** Category: first the full path (e.g. Herren > Kleidung > T-Shirts > Bedruckte T-Shirts), then just the last level via search. */
async function pickCategory(page: Page, category: string): Promise<boolean> {
  const path = category.split(">").map((x) => x.trim()).filter(Boolean);
  if (!path.length) return false;
  if (await pickDropdown(page, /^kategorie$/i, path)) return true;
  return path.length > 1 && pickDropdown(page, /^kategorie$/i, [path[path.length - 1]!]);
}

/** Opens the sell page in the Vinted-Chrome and fills what can be filled. */
async function prepare(job: Job): Promise<Page> {
  const item = getItem(job.itemId);
  const account = getAccount(job.accountId);
  const photos = listPhotos(item.id).slice(0, 20);
  const b = await connect();
  const context = b.contexts()[0] ?? (await b.newContext());
  const page = await context.newPage();
  await page.goto(sellUrl(account.domain), { waitUntil: "domcontentloaded" });
  await page.bringToFront();

  if (/\/(member\/(login|signup)|signup|login)/.test(page.url())) {
    throw new HttpError(401, "Im Vinted-Chrome ist niemand eingeloggt – bitte dort bei Vinted anmelden und erneut starten.");
  }

  const filled: string[] = [];
  const missing: string[] = [];

  const fileInput = page.locator('input[type="file"]');
  try {
    await fileInput.first().waitFor({ state: "attached", timeout: 30_000 });
    if (photos.length) {
      await fileInput.first().setInputFiles(photos.map((p) => photoPath(p.file_name)));
      filled.push(`${photos.length} Fotos`);
    }
  } catch {
    missing.push("Fotos");
  }

  const fields: [string, string | null, Locator[]][] = [
    ["Titel", item.title, [
      page.locator('[data-testid="title--input"]'), page.locator('input[name="title"]'), page.locator("#title"),
      page.getByLabel(/^titel/i), page.getByRole("textbox", { name: /titel/i }), page.locator('input[id*="title" i]'),
    ]],
    ["Beschreibung", item.description, [
      page.locator('[data-testid="description--input"]'), page.locator('textarea[name="description"]'), page.locator("#description"),
      page.getByLabel(/beschreib/i), page.getByRole("textbox", { name: /beschreib/i }), page.locator('textarea[id*="description" i]'), page.locator("textarea"),
    ]],
  ];
  const price = item.price_confirmed && item.price_cents ? item.price_cents : item.price_suggested_cents ?? item.price_cents;
  if (price) {
    fields.push(["Preis", priceText(price), [
      page.locator('[data-testid="price-input--input"]'), page.locator('input[name="price"]'), page.locator("#price"),
      page.getByLabel(/^preis/i), page.getByRole("textbox", { name: /preis/i }), page.locator('input[id*="price" i]'),
    ]]);
  }
  for (const [label, value, candidates] of fields) {
    if (!value) continue;
    try {
      if (await fill(page, candidates, value)) filled.push(label);
      else missing.push(label);
    } catch {
      missing.push(label);
    }
  }
  if (!price) missing.push("Preis");

  // Dropdowns and measurements. Each one is best effort – the seller checks before uploading.
  const brand = ruleBrand(item) ?? item.brand;
  const dropdowns: [string, () => Promise<boolean>, boolean][] = [
    ["Kategorie", () => pickCategory(page, item.category ?? ""), !!item.category],
    ["Marke", () => pickDropdown(page, /^marke$/i, [brand ?? ""]), !!brand],
    ["Größe", () => pickDropdown(page, /^größe$/i, [item.size ?? ""], true), !!item.size],
    ["Zustand", () => pickDropdown(page, /^zustand$/i, [CONDITION_LABELS[item.condition ?? ""] ?? ""]), !!CONDITION_LABELS[item.condition ?? ""]],
    ["Farbe", () => pickDropdown(page, /^farbe$/i, [item.color ?? ""]), !!item.color],
    ["Material", () => pickDropdown(page, /^material/i, [item.material ?? ""]), !!item.material],
  ];
  for (const [label, run, available] of dropdowns) {
    if (!available) { missing.push(label); continue; }
    try {
      if (await run()) filled.push(label);
      else missing.push(label);
    } catch {
      missing.push(label);
      await page.keyboard.press("Escape").catch(() => {});
    }
  }
  const { width, length } = parseMeasurements(item.measurements ?? item.title);
  const measure: [string, number | null, Locator[]][] = [
    ["Schulterweite", width, [page.getByPlaceholder(/schulterweite|breite/i), page.getByLabel(/schulterweite|breite/i)]],
    ["Länge", length, [page.getByPlaceholder(/^länge/i), page.getByLabel(/^länge/i)]],
  ];
  for (const [label, value, candidates] of measure) {
    if (value === null) continue;
    if (await fill(page, candidates, String(value), 3000).catch(() => false)) filled.push(label);
  }
  const notFound = missing.some((m) => ["Fotos", "Titel", "Beschreibung", "Preis", "Kategorie", "Marke", "Größe", "Zustand"].includes(m));

  setStatus({
    state: "waiting", filled, missing,
    message: "Bitte im Vinted-Chrome prüfen, fehlende Angaben ergänzen und auf „Hochladen“ klicken.",
    fields: notFound ? [`Seite: ${page.url()}`, ...(await describeFields(page))] : [],
  });
  return page;
}

/** Waits until the page shows a published item (/items/<id>), the tab is closed, or the job is skipped. */
async function waitForPublish(page: Page): Promise<string | null> {
  const started = Date.now();
  while (Date.now() - started < PUBLISH_TIMEOUT_MS) {
    if (skipCurrent || page.isClosed()) return null;
    const url = page.url();
    if (/\/items\/\d+/.test(url) && !/\/items\/new/.test(url)) return url.split("?")[0]!;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

function linkListing(job: Job, url: string) {
  const item = getItem(job.itemId);
  const vintedItemId = url.match(/\/items\/(\d+)/)?.[1] ?? null;
  const existing = vintedItemId && db.prepare("SELECT id FROM listings WHERE account_id = ? AND vinted_item_id = ?").get(job.accountId, vintedItemId);
  if (existing) return;
  const price = item.price_confirmed && item.price_cents ? item.price_cents : item.price_suggested_cents ?? item.price_cents;
  if (price && !item.price_confirmed) confirmPrice(item.id, price, "confirmed");
  createListing({
    item_id: item.id, account_id: job.accountId, vinted_item_id: vintedItemId, url, title: item.title,
    description: item.description, price_cents: price ?? null, currency: item.currency, listed_at: nowIso(),
  });
  eventBus.publish({ type: "published", accountId: job.accountId, itemId: item.id, title: item.title });
}

async function run() {
  if (running) return;
  running = true;
  try {
    let position = status.position;
    for (let job = queue.shift(); job; job = queue.shift()) {
      position++;
      skipCurrent = false;
      const item = getItem(job.itemId);
      setStatus({ state: "preparing", itemId: item.id, title: item.title, position, total: position + queue.length, filled: [], missing: [], message: "Fülle das Vinted-Formular aus…" });
      try {
        const page = await prepare(job);
        const url = await waitForPublish(page);
        if (url) {
          linkListing(job, url);
          setStatus({ done: [...status.done, { itemId: item.id, title: item.title, url }], message: "Eingestellt ✓" });
        }
      } catch (e) {
        const msg = (e as Error).message;
        setStatus({ state: "error", message: msg });
        if (e instanceof HttpError && (e.status === 503 || e.status === 401)) { queue = []; break; }
      }
    }
  } finally {
    running = false;
    if (status.state !== "error") setStatus({ state: "idle", itemId: null, title: null, message: status.done.length ? `${status.done.length} Artikel eingestellt` : null });
  }
}

export async function startAssist(itemIds: number[], accountId: number) {
  await connect(); // fail fast with a clear message
  getAccount(accountId);
  for (const id of itemIds) {
    const item = getItem(id);
    if (!listPhotos(id).length) throw new HttpError(400, `„${item.title}“ hat keine Fotos`);
  }
  if (!running) setStatus({ position: 0, done: [], state: "preparing", message: null });
  queue.push(...itemIds.filter((id) => !queue.some((j) => j.itemId === id)).map((itemId) => ({ itemId, accountId })));
  setStatus({ total: status.position + queue.length + (running ? 1 : 0) });
  void run();
  return status;
}

export function skipAssist() {
  skipCurrent = true;
}

export function stopAssist() {
  queue = [];
  skipCurrent = true;
}
