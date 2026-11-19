import { env } from "../../config/env.js";
import { connect, firstVisible, priceText } from "../assist/assistant.js";
import { makeOffer } from "../outreach/chromeOutreach.js";

/**
 * Answers a buyer's price offer in the seller's Vinted-Chrome:
 * - "accept": opens the chat and clicks „Annehmen“ (plus a confirm dialog, if Vinted shows one)
 * - "counter": opens the chat and sends our own offer with the given price
 */
export interface OfferAnswerJob {
  conversationId: string;
  domain: string;
  chromeUrl?: string | null;
  action: "accept" | "counter";
  /** Counter-offer price (only for "counter"). */
  cents?: number;
}

export interface OfferAnswerResult { ok: boolean; message: string }

const LOGIN = /\/(member\/(login|signup)|signup|login)/;
const ACCEPT = /^\s*(angebot\s+)?annehmen\s*$|^\s*accept(\s+offer)?\s*$/i;

export async function answerOfferInChrome(job: OfferAnswerJob): Promise<OfferAnswerResult> {
  const browser = await connect(job.chromeUrl ?? undefined);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = await context.newPage();
  const base = env.vintedBaseUrl ?? `https://www.${job.domain}`;
  const fail = (message: string): OfferAnswerResult => ({ ok: false, message });
  try {
    await page.goto(`${base}/inbox/${job.conversationId}`, { waitUntil: "domcontentloaded" });
    if (LOGIN.test(page.url())) return fail("Im Vinted-Chrome ist niemand eingeloggt");

    if (job.action === "accept") {
      const btn = await firstVisible([
        page.getByRole("button", { name: ACCEPT }), page.locator('[data-testid*="accept" i]'),
      ], 15_000);
      if (!btn) return fail("Knopf „Annehmen“ nicht gefunden – ist das Angebot noch offen?");
      await btn.click();
      // Some versions ask once more.
      const confirm = await firstVisible([
        page.locator('[role="dialog"]').getByRole("button", { name: /annehmen|bestätigen|ja|accept|confirm/i }),
      ], 3000);
      if (confirm) await confirm.click();
      // Accepted = the button is gone or the chat says so.
      const until = Date.now() + 15_000;
      while (Date.now() < until) {
        const still = await page.getByRole("button", { name: ACCEPT }).first().isVisible().catch(() => false);
        const said = await page.getByText(/angenommen|accepted/i).count().catch(() => 0);
        if (!still || said) return { ok: true, message: "Angebot angenommen" };
        await page.waitForTimeout(500);
      }
      return fail("Annehmen nicht bestätigt – bitte im Vinted-Chrome prüfen");
    }

    if (!job.cents) return fail("Kein Preis für das Gegenangebot");
    const problem = await makeOffer(page, job.cents, [
      page.getByRole("button", { name: /gegenangebot|counter/i }),
    ]);
    if (problem) return fail(problem);
    return { ok: true, message: `Gegenangebot ${priceText(job.cents)} € gesendet` };
  } catch (e) {
    return fail((e as Error).message);
  } finally {
    await page.close().catch(() => {});
  }
}
