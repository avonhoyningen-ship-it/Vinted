import { z } from "zod";
import { db, nowIso } from "../../db/index.js";
import { decrypt, encrypt, maskSecret } from "../../lib/crypto.js";
import { HttpError, notFound } from "../../lib/http.js";
import type { VintedSession } from "../../vinted/vintedClient.js";

export const VINTED_DOMAINS = [
  "vinted.de", "vinted.at", "vinted.fr", "vinted.be", "vinted.nl", "vinted.lu", "vinted.it", "vinted.es",
  "vinted.pt", "vinted.pl", "vinted.cz", "vinted.sk", "vinted.lt", "vinted.hu", "vinted.ro", "vinted.se",
  "vinted.dk", "vinted.fi", "vinted.co.uk", "vinted.ie", "vinted.gr", "vinted.hr", "vinted.com",
] as const;

export interface AccountRow {
  id: number;
  name: string;
  domain: string;
  username: string | null;
  vinted_user_id: string | null;
  session_encrypted: string | null;
  session_hint: string | null;
  status: "pending" | "connected" | "error" | "disconnected";
  last_error: string | null;
  last_sync_at: string | null;
  followers: number;
  active_listings: number;
  total_sales: number;
  unread_messages: number;
  publish_interval_minutes: number | null;
  polling_enabled: number;
  created_at: string;
  updated_at: string;
}

export type PublicAccount = Omit<AccountRow, "session_encrypted" | "polling_enabled"> & { polling_enabled: boolean; has_session: boolean };

export function toPublic(a: AccountRow): PublicAccount {
  const { session_encrypted, polling_enabled, ...rest } = a;
  return { ...rest, polling_enabled: !!polling_enabled, has_session: !!session_encrypted };
}

export const accountInput = z.object({
  name: z.string().trim().min(1).max(80),
  domain: z.enum(VINTED_DOMAINS),
  sessionToken: z.string().trim().min(8).max(8192).optional(),
  publishIntervalMinutes: z.number().int().min(5).max(24 * 60).nullable().optional(),
  pollingEnabled: z.boolean().optional(),
});
export const accountPatch = accountInput.partial();

export function listAccounts(): AccountRow[] {
  return db.prepare("SELECT * FROM accounts ORDER BY name").all() as unknown as AccountRow[];
}

export function getAccount(id: number): AccountRow {
  const a = db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as unknown as AccountRow | undefined;
  if (!a) throw notFound("Account");
  return a;
}

export function createAccount(input: z.infer<typeof accountInput>): AccountRow {
  const r = db.prepare(`
    INSERT INTO accounts (name, domain, session_encrypted, session_hint, publish_interval_minutes, polling_enabled)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    input.name, input.domain,
    input.sessionToken ? encrypt(input.sessionToken) : null,
    input.sessionToken ? maskSecret(input.sessionToken) : null,
    input.publishIntervalMinutes ?? null,
    input.pollingEnabled === false ? 0 : 1,
  );
  return getAccount(Number(r.lastInsertRowid));
}

export function updateAccount(id: number, patch: z.infer<typeof accountPatch>): AccountRow {
  const a = getAccount(id);
  const tokenChanged = patch.sessionToken !== undefined;
  db.prepare(`
    UPDATE accounts SET name = ?, domain = ?, session_encrypted = ?, session_hint = ?, publish_interval_minutes = ?,
      polling_enabled = ?, status = ?, updated_at = ?
    WHERE id = ?
  `).run(
    patch.name ?? a.name,
    patch.domain ?? a.domain,
    tokenChanged ? encrypt(patch.sessionToken!) : a.session_encrypted,
    tokenChanged ? maskSecret(patch.sessionToken!) : a.session_hint,
    patch.publishIntervalMinutes !== undefined ? patch.publishIntervalMinutes : a.publish_interval_minutes,
    patch.pollingEnabled === undefined ? a.polling_enabled : patch.pollingEnabled ? 1 : 0,
    tokenChanged ? "pending" : a.status,
    nowIso(),
    id,
  );
  return getAccount(id);
}

/** Removes the stored session. Listings, sales and archive data stay untouched. */
export function disconnectAccount(id: number) {
  getAccount(id);
  db.prepare("UPDATE accounts SET session_encrypted = NULL, session_hint = NULL, status = 'disconnected', updated_at = ? WHERE id = ?").run(nowIso(), id);
  db.prepare("UPDATE publish_queue SET status = 'cancelled', updated_at = ? WHERE account_id = ? AND status = 'pending'").run(nowIso(), id);
  db.prepare("UPDATE scheduled_actions SET status = 'cancelled' WHERE account_id = ? AND status = 'pending'").run(id);
}

export function deleteAccount(id: number) {
  getAccount(id);
  const used = db.prepare("SELECT COUNT(*) c FROM listings WHERE account_id = ?").get(id) as { c: number };
  if (used.c > 0) {
    throw new HttpError(409, "Account hat Listings im Archiv und kann nur getrennt, nicht gelöscht werden (kein Datenverlust).");
  }
  db.transaction(() => {
    db.prepare("DELETE FROM publish_queue WHERE account_id = ?").run(id);
    db.prepare("DELETE FROM sales WHERE account_id = ?").run(id);
    db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
  })();
}

export function sessionFor(a: AccountRow): VintedSession {
  if (!a.session_encrypted) throw new HttpError(400, `Account "${a.name}" hat keine gespeicherte Session`);
  return { token: decrypt(a.session_encrypted), domain: a.domain, vintedUserId: a.vinted_user_id };
}

export function setAccountStatus(id: number, status: AccountRow["status"], error: string | null) {
  db.prepare("UPDATE accounts SET status = ?, last_error = ?, updated_at = ? WHERE id = ?").run(status, error, nowIso(), id);
}
