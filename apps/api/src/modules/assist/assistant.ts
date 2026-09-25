import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { env } from "../../config/env.js";
import { db, nowIso } from "../../db/index.js";
import { eventBus, type AssistStatus, type AssistTab } from "../../lib/eventBus.js";
import { HttpError } from "../../lib/http.js";
import { photoPath } from "../../storage/photos.js";
import { getAccount } from "../accounts/repo.js";
import { createListing, getItem, listPhotos } from "../archive/repo.js";
import { parcelSize, parseMeasurements, ruleBrand, ruleParcel, type ParcelSize } from "../listings/brandRules.js";
import { confirmPrice } from "../pricing/engine.js";

/**
 * Posting assistant for the seller's own Vinted-Chrome (remote debugging on
 * port 9222): opens the sell page, uploads the photos and fills title,
 * description and price. The seller reviews and clicks "Hochladen" – the
 * assistant detects the new listing and links it in the archive. Several
 * items are prepared in their own tabs, one after another. It never submits
 * the form itself.
 */

const PUBLISH_TIMEOUT_MS = 3 * 60 * 60_000;

interface Job { itemId: number; accountId: number }

let browser: Browser | null = null;
let queue: Job[] = [];
let preparing = false;
let fatal: string | null = null;
let tabs: AssistTab[] = [];
const pages = new Map<number, Page>();
const done: AssistStatus["done"] = [];

/** Overall status derived from the tabs (one tab per item in the Vinted-Chrome). */
export function getAssistStatus(): AssistStatus {
  const current = tabs.find((t) => t.state === "preparing") ?? null;
  const ready = tabs.filter((t) => t.state === "ready");
  const last = [...tabs].reverse().find((t) => t.state !== "queued" && t.state !== "preparing") ?? null;
  const state: AssistStatus["state"] = fatal ? "error" : preparing ? "preparing" : ready.length ? "waiting" : "idle";
  const prepared = tabs.filter((t) => !["queued", "preparing"].includes(t.state)).length;
  let message: string | null = null;
  if (fatal) message = fatal;
  else if (preparing) message = `Bereite Artikel ${prepared + 1} von ${tabs.length} vor – bitte kurz warten…`;
  else if (ready.length) message = `${ready.length} Tab(s) bereit: im Vinted-Chrome prüfen und jeweils auf „Hochladen“ klicken. Danach öffnet sich der nächste Tab.`;
  else if (done.length) message = `${done.length} Artikel eingestellt`;
  return {
    state, itemId: current?.itemId ?? null, title: current?.title ?? null, position: prepared, total: tabs.length,
    filled: last?.filled ?? [], missing: last?.missing ?? [], message, done: [...done], fields: last?.fields ?? [],
    tabs: tabs.map((t) => ({ ...t })),
  };
}

function publish() {
  eventBus.publish({ type: "assist", status: getAssistStatus() });
}

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

// ---------- dropdowns (Kategorie, Marke, Größe, Zustand, Farbe) ----------

const CONDITION_LABELS: Record<string, string> = {
  new_with_tags: "Neu mit Etikett", new_without_tags: "Neu ohne Etikett", very_good: "Sehr gut", good: "Gut", satisfactory: "Zufriedenstellend",
};
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Innermost block that contains the field label and an input – one row of Vinted's form. */
function fieldRow(page: Page, label: RegExp) {
  return page.locator("div, li, section").filter({ has: page.getByText(label) }).filter({ has: page.locator("input") }).last();
}

/** A visible, clickable element whose own text is exactly `text` (or starts with it for sizes). */
async function findOption(page: Page | Locator, text: string, prefix = false): Promise<Locator | null> {
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

  // Mark every input that exists before opening, so only the dropdown's own search box is used –
  // never Vinted's site search in the header.
  await page.evaluate(() => document.querySelectorAll("input, textarea").forEach((e) => {
    if ((e as HTMLElement).getClientRects().length) e.setAttribute("data-ask-pre", "");
  })).catch(() => {});
  await input.click({ timeout: 5000 });
  await page.waitForTimeout(700);
  for (const seg of path) {
    let option = await findOption(page, seg, prefix);
    if (!option) {
      // Vinted's list has a search box (brands: thousands of entries) – the focused field or any visible one.
      const own = ":not([data-ask-pre]):not(header *):not(nav *):not([role=search] *)";
      let search = page.locator(`input${own}:focus`);
      if (!(await search.count()) || !(await search.isEditable().catch(() => false))) {
        search = page.locator(`input${own}:not([type=hidden]):not([type=checkbox]):not([type=radio])`).filter({ visible: true }).first();
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

/** Is a radio checked whose card starts with `size` (or are there no radios at all)? */
function parcelChecked(page: Page, size: string): Promise<boolean> {
  return page.evaluate((size) => {
    const radios = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    if (!radios.length) return true;
    return radios.some((r) => {
      if (!r.checked) return false;
      for (let el: HTMLElement | null = r, i = 0; el && i < 5; el = el.parentElement, i++) {
        const t = (el.innerText || el.textContent || "").trim().toLowerCase();
        if (t) return t.startsWith(size.toLowerCase());
      }
      return false;
    });
  }, size).catch(() => false);
}

/** Parcel size ("Klein", "Mittel", "Groß") – choice cards below the "Paketgröße" heading. */
async function pickParcel(page: Page, size: ParcelSize): Promise<boolean> {
  const headingText = /^\s*paketgröße/i;
  const heading = page.getByText(headingText).first();
  if (!(await heading.count().catch(() => 0))) return false;
  await heading.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(700);
  const section = page.locator("div, section, fieldset").filter({ has: page.getByText(headingText) }).filter({ hasText: size }).last();
  const scope: Page | Locator = (await section.count().catch(() => 0)) ? section : page;
  const starts = new RegExp(`^\\s*${esc(size)}(\\s|$)`, "i");
  const cards = [
    scope.locator('[data-testid*="package" i], [data-testid*="parcel" i]').filter({ hasText: starts }),
    scope.getByRole("radio", { name: starts }),
    scope.locator("label, [role=radio], li").filter({ hasText: starts }),
  ];
  for (const c of cards) {
    const n = await c.count().catch(() => 0);
    for (let i = n - 1; i >= 0; i--) {
      const el = c.nth(i);
      const text = (await el.innerText().catch(() => "")).trim();
      if (text && !starts.test(text)) continue; // e.g. the whole section
      await el.click({ timeout: 3000 }).catch(() => el.check({ force: true, timeout: 3000 }).catch(() => {}));
      await page.waitForTimeout(400);
      if (await parcelChecked(page, size)) return true;
      await el.locator('input[type="radio"]').first().check({ force: true, timeout: 2000 }).catch(() => {});
      if (await parcelChecked(page, size)) return true;
    }
  }
  const option = await findOption(scope, size);
  if (!option) return false;
  await option.click();
  await page.waitForTimeout(400);
  return parcelChecked(page, size);
}

/** Opens the sell page in the Vinted-Chrome and fills what can be filled. */
async function prepare(job: Job): Promise<{ page: Page; filled: string[]; missing: string[]; fields: string[] }> {
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
  // Material stays empty on purpose. Parcel size: rules first (T-shirts small, pullovers medium), then the AI's guess.
  const parcel = ruleParcel(item) ?? parcelSize(item.parcel_size);
  if (parcel) {
    if (await pickParcel(page, parcel).catch(() => false)) filled.push(`Paketgröße ${parcel}`);
    else missing.push("Paketgröße");
  }
  const notFound = missing.some((m) => ["Fotos", "Titel", "Beschreibung", "Preis", "Kategorie", "Marke", "Größe", "Zustand", "Paketgröße"].includes(m));

  const details = notFound ? [`Seite: ${page.url()}`, ...(await describeFields(page))] : [];
  return { page, filled, missing, fields: details };
}

/** Waits until the tab shows a published item (/items/<id>); null if the tab was closed or skipped. */
async function waitForPublish(page: Page, tab: AssistTab): Promise<string | null> {
  const started = Date.now();
  while (Date.now() - started < PUBLISH_TIMEOUT_MS) {
    if (tab.state !== "ready" || page.isClosed()) return null;
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

/** Shows the next tab that still waits for the seller's click. */
async function showNextReady() {
  if (preparing) return; // don't pull the seller away while a form is being filled
  const next = tabs.find((t) => t.state === "ready" && pages.get(t.itemId) && !pages.get(t.itemId)!.isClosed());
  if (next) await pages.get(next.itemId)!.bringToFront().catch(() => {});
}

/** Watches one prepared tab until the seller uploads it (or closes the tab). */
async function watch(job: Job, tab: AssistTab, page: Page) {
  try {
    const url = await waitForPublish(page, tab);
    if (url) {
      linkListing(job, url);
      Object.assign(tab, { state: "done", url, message: null });
      done.push({ itemId: tab.itemId, title: tab.title, url });
      setTimeout(() => void page.close().catch(() => {}), 2000);
    } else if (tab.state === "ready") {
      Object.assign(tab, { state: "skipped", message: "Tab geschlossen – übersprungen" });
    }
  } catch (e) {
    Object.assign(tab, { state: "error", message: (e as Error).message });
  } finally {
    pages.delete(tab.itemId);
    publish();
    await showNextReady();
  }
}

/** Fills one tab per item, one after another; each tab is then watched on its own. */
async function prepareAll() {
  if (preparing) return;
  preparing = true;
  fatal = null;
  try {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const tab = tabs.find((t) => t.itemId === job!.itemId && t.state === "queued");
      if (!tab) continue;
      Object.assign(tab, { state: "preparing", message: "Fülle das Vinted-Formular aus…" });
      publish();
      try {
        const r = await prepare(job);
        Object.assign(tab, { state: "ready", filled: r.filled, missing: r.missing, fields: r.fields, message: null });
        pages.set(tab.itemId, r.page);
        void watch(job, tab, r.page);
      } catch (e) {
        Object.assign(tab, { state: "error", message: (e as Error).message });
        if (e instanceof HttpError && (e.status === 503 || e.status === 401)) {
          fatal = (e as Error).message;
          queue = [];
          for (const t of tabs) if (t.state === "queued") Object.assign(t, { state: "skipped", message: null });
        }
      }
      publish();
    }
  } finally {
    preparing = false;
    publish();
    await showNextReady();
  }
}

export async function startAssist(itemIds: number[], accountId: number) {
  await connect(); // fail fast with a clear message
  getAccount(accountId);
  for (const id of itemIds) {
    const item = getItem(id);
    if (!listPhotos(id).length) throw new HttpError(400, `„${item.title}“ hat keine Fotos`);
  }
  if (!tabs.some((t) => ["queued", "preparing", "ready"].includes(t.state))) {
    tabs = [];
    done.length = 0;
  }
  for (const itemId of itemIds) {
    if (tabs.some((t) => t.itemId === itemId && ["queued", "preparing", "ready"].includes(t.state))) continue;
    tabs = tabs.filter((t) => t.itemId !== itemId);
    tabs.push({ itemId, title: getItem(itemId).title, state: "queued", filled: [], missing: [], message: null, url: null, fields: [] });
    queue.push({ itemId, accountId });
  }
  publish();
  void prepareAll();
  return getAssistStatus();
}

/** Skips one item (or the first open one): its tab stays open but is no longer watched. */
export function skipAssist(itemId?: number) {
  const tab = tabs.find((t) => (itemId === undefined || t.itemId === itemId) && ["queued", "ready"].includes(t.state));
  if (!tab) return;
  queue = queue.filter((j) => j.itemId !== tab.itemId);
  Object.assign(tab, { state: "skipped", message: null });
  publish();
}

export function stopAssist() {
  queue = [];
  for (const t of tabs) if (t.state === "queued" || t.state === "ready") Object.assign(t, { state: "skipped", message: null });
  publish();
}
