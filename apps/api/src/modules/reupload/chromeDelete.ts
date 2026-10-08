import { env } from "../../config/env.js";
import { connect, firstVisible } from "../assist/assistant.js";

/**
 * Deletes one own listing on Vinted in the seller's Vinted-Chrome:
 * item page → "Löschen" → confirm → the item page is gone afterwards.
 */
export interface DeleteJob { vintedItemId: string; domain: string; chromeUrl?: string | null }
export interface DeleteResult { ok: boolean; message: string }

const LOGIN = /\/(member\/(login|signup)|signup|login)/;

export async function deleteInChrome(job: DeleteJob): Promise<DeleteResult> {
  const browser = await connect(job.chromeUrl ?? undefined);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = await context.newPage();
  const base = env.vintedBaseUrl ?? `https://www.${job.domain}`;
  const itemUrl = `${base}/items/${job.vintedItemId}`;
  const fail = (message: string): DeleteResult => ({ ok: false, message });
  try {
    const first = await page.goto(itemUrl, { waitUntil: "domcontentloaded" });
    if (LOGIN.test(page.url())) return fail("Im Vinted-Chrome ist niemand eingeloggt");
    if (first?.status() === 404) return { ok: true, message: "War auf Vinted schon gelöscht" };

    const del = await firstVisible([
      page.getByRole("button", { name: /^\s*(artikel )?löschen\s*$|^\s*delete( item)?\s*$/i }),
      page.locator('[data-testid*="delete" i]'),
    ], 10_000);
    if (!del) return fail("Knopf „Löschen“ nicht gefunden – gehört der Artikel zum eingeloggten Account?");
    await del.click();

    // Vinted asks again (sometimes with a reason): confirm in the dialog.
    const dialog = page.locator('[role="dialog"], [class*="modal" i]');
    const confirm = await firstVisible([
      dialog.getByRole("button", { name: /löschen|bestätigen|ja|delete|confirm/i }),
      page.locator('[data-testid*="confirm" i]'),
    ], 8000);
    if (confirm) await confirm.click();

    // Gone = the item page is no longer there.
    const until = Date.now() + 20_000;
    while (Date.now() < until) {
      await page.waitForTimeout(1000);
      const r = await page.request.get(itemUrl, { maxRedirects: 0 }).catch(() => null);
      if (r && (r.status() === 404 || r.status() === 410)) return { ok: true, message: "Auf Vinted gelöscht" };
    }
    return fail("Löschen nicht bestätigt – bitte im Vinted-Chrome prüfen");
  } catch (e) {
    return fail((e as Error).message);
  } finally {
    await page.close().catch(() => {});
  }
}
