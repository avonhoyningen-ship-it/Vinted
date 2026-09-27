import { chromium } from "playwright-core";
import { HttpError } from "../../lib/http.js";
import { chromeUrlFor, getAccount, updateAccount, type AccountRow } from "./repo.js";

/**
 * Local dashboard: takes the Vinted login (access_token_web / refresh_token_web)
 * straight from the Vinted-Chrome on this PC – no copying from the developer tools.
 */
export async function readChromeLogin(domain: string, chromeUrl: string): Promise<{ access: string; refresh: string | null }> {
  let browser;
  try {
    browser = await chromium.connectOverCDP(chromeUrl, { timeout: 5000 });
  } catch {
    const port = new URL(chromeUrl).port;
    throw new HttpError(503, `Das Vinted-Chrome läuft nicht – bitte „Chrome fuer Vinted starten.bat“${port && port !== "9222" ? ` für diesen Account (Port ${port})` : ""} öffnen und bei Vinted einloggen.`);
  }
  try {
    const context = browser.contexts()[0];
    const cookies = context ? await context.cookies(`https://www.${domain}/`) : [];
    const get = (n: string) => cookies.find((c) => c.name === n)?.value || null;
    const access = get("access_token_web");
    if (!access) throw new HttpError(400, `Im Vinted-Chrome ist niemand bei ${domain} eingeloggt – bitte dort anmelden und erneut klicken.`);
    return { access, refresh: get("refresh_token_web") };
  } finally {
    await browser.close().catch(() => {}); // only disconnects – Chrome stays open
  }
}

/** Stores the login from the account's Chrome for this account. */
export async function importChromeLogin(accountId: number): Promise<AccountRow> {
  const account = await getAccount(accountId);
  const { access, refresh } = await readChromeLogin(account.domain, chromeUrlFor(account));
  return updateAccount(accountId, { sessionToken: access, ...(refresh ? { refreshToken: refresh } : {}) });
}
