import type { Locator, Page } from "playwright-core";
import { env } from "../../config/env.js";
import { connect, fillPrice, firstVisible, priceText } from "../assist/assistant.js";

/**
 * Sends one chat message – optionally with a price offer – in the seller's
 * Vinted-Chrome: opens the chat page, makes the offer, types the text, sends,
 * and checks that the text shows up in the chat afterwards.
 */
export interface OutreachJob {
  /** Path on Vinted, e.g. "/inbox/123" (chat with a seller) or the chat start page for an item and member. */
  path: string;
  domain: string;
  chromeUrl?: string | null;
  text: string;
  /** Price offer in cents (offers to members who favourited an item). */
  offerCents?: number | null;
}

export interface OutreachResult { ok: boolean; message: string }

const LOGIN = /\/(member\/(login|signup)|signup|login)/;

async function messageBox(page: Page): Promise<Locator | null> {
  return firstVisible([
    page.locator('[data-testid*="message-input" i] textarea'), page.locator('textarea[name="body"]'), page.locator('textarea[name="message"]'),
    page.getByRole("textbox", { name: /nachricht|message|schreib/i }), page.getByPlaceholder(/nachricht|message|schreib/i),
    page.locator("textarea"), page.locator('[contenteditable="true"]'),
  ], 15_000);
}

/** Vinted's offer dialog: button → price field → confirm. */
export async function makeOffer(page: Page, cents: number, extraOpeners: Locator[] = []): Promise<string | null> {
  // Vinted's offer window (Nov 2026): input name="offer" (type number) + submit button "Verhandeln".
  const fieldCandidates = [
    page.locator('[data-testid="offer-price-field--input"]'), page.locator('input[name="offer"]'),
    page.locator('[data-testid*="offer" i] input'), page.locator('input[name*="price" i]'),
    page.getByLabel(/preis|angebot|price|offer/i), page.getByRole("textbox", { name: /preis|angebot|price|offer/i }),
  ];
  // With ?offer_request=true the window is already open – then don't click anything else (could close it).
  let field = await firstVisible(fieldCandidates.slice(0, 2), 6000);
  if (!field) {
    const open = await firstVisible([
      ...extraOpeners,
      page.locator('[data-testid="make-offer-button"]'),
      page.getByRole("button", { name: /^\s*verhandeln\s*$|angebot (machen|senden|erstellen)|preis (anbieten|vorschlagen)|make an offer|send (an )?offer/i }),
      page.locator('button[data-testid*="offer" i]:not([data-testid*="close" i])'),
    ], 10_000);
    if (!open) return "Knopf für ein Angebot nicht gefunden";
    await open.click();
    field = await firstVisible(fieldCandidates, 8000);
  }
  if (!field) return "Preisfeld im Angebot nicht gefunden";
  const isNumber = (await field.getAttribute("type").catch(() => null)) === "number";
  const value = isNumber ? String(cents / 100) : priceText(cents);
  if (isNumber) {
    await field.click();
    await field.fill(value);
    const got = Number((await field.inputValue().catch(() => "")).replace(",", "."));
    if (Math.round(got * 100) !== cents) return `Preis ließ sich nicht eintragen (${value} €)`;
  } else if (!(await fillPrice(page, [field], value))) {
    return "Preisfeld im Angebot nicht gefunden";
  }
  // The confirm button inside the offer window (not the button that opened it).
  const dialog = page.locator('[role="dialog"], [data-testid="offer-modal--overlay"], [class*="modal" i]');
  const confirm = await firstVisible([
    page.locator('[data-testid="offer-submit-button"]'),
    dialog.getByRole("button", { name: /verhandeln|angebot senden|senden|anbieten|bestätigen|send/i }),
    dialog.locator('button[type="submit"]'),
    page.getByRole("button", { name: /^\s*(angebot senden|send offer)\s*$/i }),
  ], 8000);
  if (!confirm) return "Knopf „Angebot senden“ nicht gefunden";
  await confirm.click();
  await page.waitForTimeout(2000);
  const err = (await page.locator('[role="alert"], [data-testid*="error" i]').first().innerText().catch(() => "")).trim();
  if (err && /fehler|nicht|error|kann|mindest|höchst/i.test(err)) return `Vinted: ${err.slice(0, 160)}`;
  // Window still open → not sent.
  if (await page.locator('[data-testid="offer-submit-button"]').isVisible().catch(() => false)) return "Angebot wurde nicht abgeschickt (Fenster noch offen)";
  return null;
}

export async function sendInChrome(job: OutreachJob): Promise<OutreachResult> {
  const browser = await connect(job.chromeUrl ?? undefined);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = await context.newPage();
  const base = env.vintedBaseUrl ?? `https://www.${job.domain}`;
  const fail = (message: string): OutreachResult => ({ ok: false, message });
  try {
    await page.goto(`${base}${job.path}`, { waitUntil: "domcontentloaded" });
    if (LOGIN.test(page.url())) return fail("Im Vinted-Chrome ist niemand eingeloggt");

    if (job.offerCents) {
      const problem = await makeOffer(page, job.offerCents);
      if (problem) return fail(problem);
    }

    const box = await messageBox(page);
    if (!box) return fail("Nachrichtenfeld nicht gefunden – ist der Chat erreichbar?");
    await box.click();
    await box.fill(job.text).catch(async () => { await page.keyboard.type(job.text); });
    const send = await firstVisible([
      page.getByRole("button", { name: /^\s*(senden|send|nachricht senden)\s*$/i }), page.locator('[data-testid*="send" i]'),
      page.locator('button[type="submit"]'),
    ], 3000);
    if (send) await send.click();
    else await box.press("Enter");

    // Sent = the text appears in the chat and the input is empty again.
    const snippet = job.text.slice(0, 40);
    const until = Date.now() + 15_000;
    while (Date.now() < until) {
      const cleared = !(await box.inputValue().catch(() => "")).trim();
      const shown = await page.getByText(snippet, { exact: false }).count().catch(() => 0);
      if (cleared && shown) return { ok: true, message: job.offerCents ? `Angebot ${priceText(job.offerCents)} € gesendet` : "Nachricht gesendet" };
      await page.waitForTimeout(500);
    }
    return fail("Senden nicht bestätigt – bitte im Vinted-Chrome prüfen");
  } catch (e) {
    return fail((e as Error).message);
  } finally {
    await page.close().catch(() => {});
  }
}
