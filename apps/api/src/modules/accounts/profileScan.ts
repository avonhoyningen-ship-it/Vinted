import { env } from "../../config/env.js";
import { db, nowIso } from "../../db/index.js";
import { HttpError } from "../../lib/http.js";
import { connect } from "../assist/assistant.js";
import { endListing, markListingSold, type ListingRow } from "../archive/repo.js";
import { chromeUrlFor, getAccount } from "./repo.js";

/**
 * "Was ist wirklich online?" – opens the seller's own Vinted profile in the
 * Vinted-Chrome (what buyers see), scrolls through the wardrobe and collects
 * every item shown. Listings the dashboard thinks are active but that are not
 * on the profile are taken out of "Aktive Listings".
 */
export interface ScanJob { vintedUserId: string; domain: string; chromeUrl?: string | null }
export interface ScanResult { ok: boolean; online: string[]; sold: string[]; message: string }

export async function scanProfileInChrome(job: ScanJob): Promise<ScanResult> {
  const browser = await connect(job.chromeUrl ?? undefined);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = await context.newPage();
  const base = env.vintedBaseUrl ?? `https://www.${job.domain}`;
  try {
    await page.goto(`${base}/member/${job.vintedUserId}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    // Load the whole wardrobe: scroll until no new items appear.
    let last = -1;
    let stable = 0;
    for (let i = 0; i < 120 && stable < 3; i++) {
      const n = await page.locator('a[href*="/items/"]').count();
      stable = n === last ? stable + 1 : 0;
      last = n;
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1200);
    }
    const found = await page.evaluate(() => {
      const out: { id: string; sold: boolean }[] = [];
      for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/items/"]'))) {
        const m = a.getAttribute("href")?.match(/\/items\/(\d+)/);
        if (!m) continue;
        // The item card around the link (largest box that only holds this item):
        // a "Verkauft" badge in it means it's no longer for sale.
        let card: HTMLElement = a;
        while (card.parentElement && Array.from(card.parentElement.querySelectorAll<HTMLAnchorElement>('a[href*="/items/"]'))
          .every((x) => x.getAttribute("href")?.match(/\/items\/(\d+)/)?.[1] === m[1])) card = card.parentElement;
        out.push({ id: m[1]!, sold: /(^|[^a-zäöü])(verkauft|sold)([^a-zäöü]|$)/i.test(card.textContent ?? "") });
      }
      return out;
    });
    const sold = new Set(found.filter((f) => f.sold).map((f) => f.id));
    const online = [...new Set(found.map((f) => f.id))].filter((id) => !sold.has(id));
    return { ok: true, online, sold: [...sold], message: `${online.length} Artikel im Profil gefunden` };
  } catch (e) {
    return { ok: false, online: [], sold: [], message: (e as Error).message };
  } finally {
    await page.close().catch(() => {});
  }
}

type Scanner = (job: ScanJob) => Promise<ScanResult>;
let scanner: Scanner = scanProfileInChrome;
/** Cloud: runs on the PC helper (set at startup). Tests: a fake. */
export function setProfileScanner(fn: Scanner) {
  scanner = fn;
}

export interface ReconcileResult { online: number; kept: number; removed: number; sold: number; message: string }

/** Compares "Aktive Listings" of one account with its Vinted profile and fixes the difference. */
export async function reconcileWithProfile(accountId: number): Promise<ReconcileResult> {
  const account = await getAccount(accountId);
  if (!account.vinted_user_id) throw new HttpError(400, "Account ist noch nicht mit Vinted verbunden");
  const r = await scanner({ vintedUserId: account.vinted_user_id, domain: account.domain, chromeUrl: chromeUrlFor(account) });
  if (!r.ok) throw new HttpError(502, `Vinted-Profil konnte nicht gelesen werden: ${r.message}`);
  const online = new Set(r.online);
  const sold = new Set(r.sold);
  const active = await db.all<ListingRow>("SELECT * FROM listings WHERE account_id = ? AND status = 'active'", [accountId]);
  const keep = active.filter((l) => l.vinted_item_id && online.has(l.vinted_item_id));
  // Safety net: if the profile showed fewer items than Vinted itself counts, the page did not load
  // completely – then nothing is changed rather than removing listings that are online.
  const expected = Number(account.active_listings ?? 0);
  if (expected && online.size < Math.floor(expected * 0.9)) {
    return { online: online.size, kept: keep.length, removed: 0, sold: 0, message: `Profil nicht vollständig geladen (${online.size} von ${expected} Artikeln) – nichts geändert, bitte nochmal versuchen.` };
  }
  if (!online.size && active.length) {
    return { online: 0, kept: 0, removed: 0, sold: 0, message: "Im Profil wurden keine Artikel gefunden – nichts geändert. Ist im Vinted-Chrome der richtige Account eingeloggt?" };
  }
  // Seen on the profile again → may be active again.
  for (const id of online) {
    await db.run(`UPDATE listings SET profile_missing_at = NULL, status = CASE WHEN status = 'removed' THEN 'active' ELSE status END, ended_at = CASE WHEN status = 'removed' THEN NULL ELSE ended_at END
      WHERE account_id = ? AND vinted_item_id = ? AND profile_missing_at IS NOT NULL`, [accountId, id]);
  }
  let removed = 0;
  let soldN = 0;
  for (const l of active) {
    if (l.vinted_item_id && online.has(l.vinted_item_id)) continue;
    if (l.vinted_item_id && sold.has(l.vinted_item_id)) {
      await markListingSold(l.id, nowIso(), l.price_cents);
      soldN++;
    } else {
      await endListing(l.id, "removed");
      await db.run("UPDATE listings SET profile_missing_at = ? WHERE id = ?", [nowIso(), l.id]);
      removed++;
    }
  }
  return {
    online: online.size, kept: keep.length, removed, sold: soldN,
    message: removed || soldN
      ? `${keep.length} sind online · ${removed} nicht mehr online${soldN ? ` · ${soldN} verkauft` : ""} – aus „Aktive Listings“ entfernt`
      : `Alles stimmt: ${keep.length} Artikel sind online`,
  };
}
