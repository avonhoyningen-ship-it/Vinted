import type { Page } from "playwright-core";
import { env } from "../../config/env.js";
import { connect, fillPrice, firstVisible, priceText } from "../assist/assistant.js";

/**
 * Changes the price of one own Vinted listing in the seller's Vinted-Chrome:
 * edit page → price field → save → read the price on the item page again.
 * Only "verified" counts as done for sure; anything else is reported.
 */
export interface PriceJob {
  listingId: number;
  vintedItemId: string;
  domain: string;
  chromeUrl?: string | null;
  newCents: number;
}

export interface PriceResult {
  ok: boolean;
  /** The item page shows exactly the new price. */
  verified: boolean;
  shownCents: number | null;
  message: string;
}

/** "24,50 €" / "€24.50" / "24 €" → 2450 */
export function parsePrice(text: string): number | null {
  const m = text.replace(/ /g, " ").match(/(\d{1,5}(?:[.,]\d{3})*)(?:[.,](\d{2}))?\s*€|€\s*(\d{1,5})(?:[.,](\d{2}))?/);
  if (!m) return null;
  const whole = (m[1] ?? m[3] ?? "").replace(/[.,]/g, "");
  const cents = m[2] ?? m[4] ?? "00";
  return Number(whole) * 100 + Number(cents);
}

async function shownPrice(page: Page): Promise<number | null> {
  for (const sel of ['[data-testid="item-price"]', '[data-testid*="item-price" i]', '[itemprop="price"]', '[data-testid*="price" i]']) {
    const el = page.locator(sel).first();
    if (await el.count().catch(() => 0)) {
      const content = await el.getAttribute("content").catch(() => null);
      if (content && /^\d+(\.\d+)?$/.test(content)) return Math.round(Number(content) * 100);
      const p = parsePrice(await el.innerText().catch(() => ""));
      if (p !== null) return p;
    }
  }
  return null;
}

export async function changePriceInChrome(job: PriceJob): Promise<PriceResult> {
  const browser = await connect(job.chromeUrl ?? undefined);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = await context.newPage();
  const base = env.vintedBaseUrl ?? `https://www.${job.domain}`;
  const fail = (message: string): PriceResult => ({ ok: false, verified: false, shownCents: null, message });
  try {
    await page.goto(`${base}/items/${job.vintedItemId}/edit`, { waitUntil: "domcontentloaded" });
    if (/\/(member\/(login|signup)|signup|login)/.test(page.url())) return fail("Im Vinted-Chrome ist niemand eingeloggt");
    if (!/\/edit/.test(page.url())) return fail("Bearbeiten nicht möglich – gehört der Artikel zum eingeloggten Account?");

    const priceField = [
      page.locator('[data-testid="price-input--input"]'), page.locator('input[name="price"]'), page.locator("#price"),
      page.getByLabel(/^preis/i), page.getByRole("textbox", { name: /preis/i }), page.locator('input[id*="price" i]'),
    ];
    if (!(await fillPrice(page, priceField, priceText(job.newCents)))) return fail("Preisfeld nicht gefunden oder Preis nicht übernommen");

    const save = await firstVisible([
      page.getByRole("button", { name: /^\s*(speichern|änderungen speichern|aktualisieren|hochladen)\s*$/i }),
      page.locator('[data-testid*="save" i]'), page.locator('[data-testid*="submit" i]'), page.locator('button[type="submit"]'),
    ], 10_000);
    if (!save) return fail("Knopf „Speichern“ nicht gefunden");
    await save.click();

    // Saved → Vinted shows the item page again.
    const until = Date.now() + 30_000;
    while (Date.now() < until && (/\/edit/.test(page.url()) || !/\/items\/\d+/.test(page.url()))) await page.waitForTimeout(500);
    if (/\/edit/.test(page.url())) {
      const hint = (await page.locator('[role="alert"], [class*="error" i]').first().innerText().catch(() => "")).trim().slice(0, 160);
      return fail(`Speichern nicht bestätigt${hint ? `: ${hint}` : " – bitte im Vinted-Chrome prüfen"}`);
    }
    await page.waitForTimeout(800);
    const shown = await shownPrice(page);
    if (shown === null) return { ok: true, verified: false, shownCents: null, message: "Gespeichert – neuer Preis auf der Artikelseite nicht lesbar, bitte kurz prüfen" };
    if (shown !== job.newCents) return { ok: false, verified: false, shownCents: shown, message: `Vinted zeigt ${priceText(shown)} € statt ${priceText(job.newCents)} €` };
    return { ok: true, verified: true, shownCents: shown, message: "Preis geändert" };
  } catch (e) {
    return fail((e as Error).message);
  } finally {
    await page.close().catch(() => {});
  }
}
