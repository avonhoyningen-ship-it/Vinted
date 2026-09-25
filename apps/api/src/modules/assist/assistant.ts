import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { env } from "../../config/env.js";
import { db, nowIso } from "../../db/index.js";
import { eventBus, type AssistStatus } from "../../lib/eventBus.js";
import { HttpError } from "../../lib/http.js";
import { photoPath } from "../../storage/photos.js";
import { getAccount } from "../accounts/repo.js";
import { createListing, getItem, listPhotos } from "../archive/repo.js";
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
let status: AssistStatus = { state: "idle", itemId: null, title: null, position: 0, total: 0, filled: [], missing: [], message: null, done: [] };

function setStatus(patch: Partial<AssistStatus>) {
  status = { ...status, ...patch };
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

/** First visible candidate wins – Vinted may change markup, so several variants are tried. */
async function firstVisible(candidates: Locator[]): Promise<Locator | null> {
  for (const c of candidates) {
    const el = c.first();
    if ((await el.count()) && (await el.isVisible().catch(() => false))) return el;
  }
  return null;
}

async function fill(page: Page, candidates: Locator[], value: string): Promise<boolean> {
  const el = await firstVisible(candidates);
  if (!el) return false;
  await el.click();
  await el.fill(value);
  return true;
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
    ["Titel", item.title, [page.locator('[data-testid="title--input"]'), page.locator('input[name="title"]'), page.locator("#title"), page.getByLabel(/^titel/i)]],
    ["Beschreibung", item.description, [page.locator('[data-testid="description--input"]'), page.locator('textarea[name="description"]'), page.locator("#description"), page.getByLabel(/beschreib/i)]],
  ];
  const price = item.price_confirmed && item.price_cents ? item.price_cents : item.price_suggested_cents ?? item.price_cents;
  if (price) {
    fields.push(["Preis", priceText(price), [page.locator('[data-testid="price-input--input"]'), page.locator('input[name="price"]'), page.locator("#price"), page.getByLabel(/^preis/i)]]);
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
  missing.push("Kategorie, Marke, Größe, Zustand prüfen");

  setStatus({ state: "waiting", filled, missing, message: "Bitte im Vinted-Chrome prüfen, fehlende Angaben ergänzen und auf „Hochladen“ klicken." });
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
