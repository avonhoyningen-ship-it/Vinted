import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "playwright-core";
import { env, ROOT_DIR } from "../../config/env.js";
import { connect, firstVisible } from "../assist/assistant.js";

/**
 * Deletes one own listing on Vinted in the seller's Vinted-Chrome:
 * item page → "Löschen" (also behind a "…" menu) → confirm in Vinted's dialog →
 * check that the item is really gone. On failure a screenshot is saved in data/debug.
 */
export interface DeleteJob { vintedItemId: string; domain: string; chromeUrl?: string | null }
export interface DeleteResult { ok: boolean; message: string }

const LOGIN = /\/(member\/(login|signup)|signup|login)/;
const DELETE = /^\s*(artikel )?löschen\s*$|^\s*delete( item)?\s*$|^\s*supprimer\s*$/i;

/** Item page gone: 404/410, or Vinted sends us elsewhere, or the owner buttons are no longer there. */
async function isGone(page: Page, itemUrl: string, id: string): Promise<boolean> {
  const r = await page.request.get(itemUrl).catch(() => null);
  if (r && (r.status() === 404 || r.status() === 410)) return true;
  if (r && !new URL(r.url()).pathname.startsWith(`/items/${id}`)) return true;
  // Some deleted items still answer 200 with an empty "nicht verfügbar" page: the owner buttons are gone then.
  const check = await page.context().newPage();
  try {
    const res = await check.goto(itemUrl, { waitUntil: "domcontentloaded" });
    if (res && res.status() >= 400) return true;
    if (!check.url().includes(`/items/${id}`)) return true;
    await check.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await check.waitForTimeout(1500);
    const ownerButtons = await check.getByRole("button", { name: /löschen|bearbeiten|delete|edit/i }).count();
    const editLinks = await check.locator(`a[href*="/items/${id}/edit"]`).count();
    // A live item (also someone else's) still shows its price or buy buttons – then it is not gone.
    const alive = await check.locator('[data-testid*="item-price" i], [itemprop="price"]').count()
      + await check.getByRole("button", { name: /kaufen|buy|angebot|nachricht|message|offer/i }).count();
    return ownerButtons === 0 && editLinks === 0 && alive === 0;
  } finally {
    await check.close().catch(() => {});
  }
}

async function findDelete(page: Page): Promise<Locator | null> {
  const direct = await firstVisible([page.getByRole("button", { name: DELETE }), page.locator('[data-testid*="delete" i]')], 8000);
  if (direct) return direct;
  // Sometimes behind a "…"/"Mehr" menu.
  const menu = await firstVisible([page.getByRole("button", { name: /mehr|optionen|more|menu|…|\.\.\./i }), page.locator('[data-testid*="menu" i] button, button[data-testid*="more" i]')], 3000);
  if (!menu) return null;
  await menu.click().catch(() => {});
  return firstVisible([page.getByRole("button", { name: DELETE }), page.getByRole("menuitem", { name: DELETE }), page.getByText(DELETE)], 4000);
}

const CLICKABLE = 'button, [role="button"], a, [role="menuitem"], input[type="submit"], input[type="button"]';

/** Keys of the clickable things on the page right now (text + position) – to see what the click added. */
async function clickableKeys(page: Page): Promise<string[]> {
  return page.evaluate((sel) => Array.from(document.querySelectorAll<HTMLElement>(sel)).map((e) => {
    const r = e.getBoundingClientRect();
    return `${(e.innerText || (e as HTMLInputElement).value || "").trim()}|${Math.round(r.x)}|${Math.round(r.y)}`;
  }), CLICKABLE);
}

/**
 * The confirm button of Vinted's "Wirklich löschen?" question: a button that appeared after the
 * click (or sits in a dialog), says "Löschen / Entfernen / Bestätigen / Ja / OK …" and not "Abbrechen".
 * Marks it with data-ask-confirm and returns it.
 */
async function findConfirm(page: Page, before: string[]): Promise<Locator | null> {
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    const found = await page.evaluate(({ sel, before }) => {
      const pos = /lösch|entfern|bestätig|^ja\b|^ok$|delete|remove|confirm|^weiter$|^fortfahren$/i;
      const neg = /abbrech|cancel|zurück|schließ|nein|behalten|close|back/i;
      const old = new Set(before);
      let best: HTMLElement | null = null;
      let bestScore = 0;
      for (const e of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
        e.removeAttribute("data-ask-confirm");
        if (e.hasAttribute("data-ask-clicked")) continue;
        const r = e.getBoundingClientRect();
        const style = getComputedStyle(e);
        if (!r.width || !r.height || style.visibility === "hidden" || style.display === "none") continue;
        const text = (e.innerText || (e as HTMLInputElement).value || e.getAttribute("aria-label") || "").trim();
        if (!text || text.length > 40 || !pos.test(text) || neg.test(text)) continue;
        const isNew = !old.has(`${text}|${Math.round(r.x)}|${Math.round(r.y)}`);
        const inDialog = !!e.closest('[role="dialog"], [role="alertdialog"], [aria-modal="true"], [class*="modal" i], [class*="dialog" i], [class*="overlay" i]');
        const score = (isNew ? 2 : 0) + (inDialog ? 2 : 0) + (/lösch|delete/i.test(text) ? 1 : 0);
        if (score >= 2 && score > bestScore) { best = e; bestScore = score; }
      }
      if (best) best.setAttribute("data-ask-confirm", "1");
      return !!best;
    }, { sel: CLICKABLE, before });
    if (found) return page.locator("[data-ask-confirm]").first();
    await page.waitForTimeout(400);
  }
  return null;
}

async function screenshot(page: Page, id: string) {
  try {
    const dir = path.join(ROOT_DIR, "data", "debug");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `loeschen-${id}.png`);
    await page.screenshot({ path: file, fullPage: false });
    return file;
  } catch {
    return null;
  }
}

export async function deleteInChrome(job: DeleteJob): Promise<DeleteResult> {
  const browser = await connect(job.chromeUrl ?? undefined);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = await context.newPage();
  // A browser popup "Wirklich löschen? OK / Abbrechen" is answered with OK.
  page.on("dialog", (d) => { void d.accept().catch(() => {}); });
  const base = env.vintedBaseUrl ?? `https://www.${job.domain}`;
  const id = job.vintedItemId;
  const itemUrl = `${base}/items/${id}`;
  const fail = async (message: string): Promise<DeleteResult> => {
    const shot = await screenshot(page, id);
    return { ok: false, message: shot ? `${message} (Bildschirmfoto: ${shot})` : message };
  };
  try {
    const first = await page.goto(itemUrl, { waitUntil: "domcontentloaded" });
    if (LOGIN.test(page.url())) return { ok: false, message: "Im Vinted-Chrome ist niemand eingeloggt" };
    if (first && (first.status() === 404 || first.status() === 410)) return { ok: true, message: "War auf Vinted schon gelöscht" };
    await page.waitForTimeout(1500);

    const del = await findDelete(page);
    if (!del) {
      if (await isGone(page, itemUrl, id)) return { ok: true, message: "War auf Vinted schon gelöscht" };
      return fail("Knopf „Löschen“ nicht gefunden – gehört der Artikel zum eingeloggten Account?");
    }
    await del.scrollIntoViewIfNeeded().catch(() => {});
    await del.evaluate((e) => e.setAttribute("data-ask-clicked", "1")).catch(() => {});
    const before = await clickableKeys(page);
    await del.click();
    await page.waitForTimeout(1200);

    // Vinted asks again ("Möchtest du den Artikel wirklich löschen?"), sometimes with a reason to pick first.
    const radio = page.locator('[role="dialog"] input[type="radio"], [aria-modal="true"] input[type="radio"]').first();
    if (await radio.isVisible().catch(() => false)) await radio.check({ force: true }).catch(() => {});
    const confirm = await findConfirm(page, before);
    if (confirm) {
      await confirm.click().catch(() => {});
      await page.waitForTimeout(1500);
    }

    const until = Date.now() + 25_000;
    while (Date.now() < until) {
      if (await isGone(page, itemUrl, id)) return { ok: true, message: "Auf Vinted gelöscht" };
      await page.waitForTimeout(2000);
    }
    return fail(confirm ? "Löschen nicht bestätigt – der Artikel ist noch online" : "Bestätigungs-Fenster von Vinted nicht gefunden");
  } catch (e) {
    return fail((e as Error).message);
  } finally {
    await page.close().catch(() => {});
  }
}
