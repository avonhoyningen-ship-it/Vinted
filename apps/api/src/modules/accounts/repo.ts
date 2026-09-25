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
  refresh_encrypted: string | null;
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

export type PublicAccount = Omit<AccountRow, "session_encrypted" | "refresh_encrypted" | "polling_enabled"> & {
  polling_enabled: boolean; has_session: boolean; has_refresh_token: boolean;
};

export function toPublic(a: AccountRow): PublicAccount {
  const { session_encrypted, refresh_encrypted, polling_enabled, ...rest } = a;
  return { ...rest, polling_enabled: !!polling_enabled, has_session: !!session_encrypted, has_refresh_token: !!refresh_encrypted };
}

export const accountInput = z.object({
  name: z.string().trim().min(1).max(80),
  domain: z.enum(VINTED_DOMAINS),
  sessionToken: z.string().trim().min(8).max(8192).optional(),
  refreshToken: z.string().trim().min(8).max(8192).optional(),
  publishIntervalMinutes: z.number().int().min(5).max(24 * 60).nullable().optional(),
  pollingEnabled: z.boolean().optional(),
});
export const accountPatch = accountInput.partial();

export function listAccounts(): Promise<AccountRow[]> {
  return db.all<AccountRow>("SELECT * FROM accounts ORDER BY name");
}

export async function getAccount(id: number): Promise<AccountRow> {
  const a = await db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", [id]);
  if (!a) throw notFound("Account");
  return a;
}

export async function createAccount(input: z.infer<typeof accountInput>): Promise<AccountRow> {
  const id = await db.insert(`
    INSERT INTO accounts (name, domain, session_encrypted, refresh_encrypted, session_hint, publish_interval_minutes, polling_enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    input.name, input.domain,
    input.sessionToken ? encrypt(input.sessionToken) : null,
    input.refreshToken ? encrypt(input.refreshToken) : null,
    input.sessionToken ? maskSecret(input.sessionToken) : null,
    input.publishIntervalMinutes ?? null,
    input.pollingEnabled === false ? 0 : 1,
  ]);
  return getAccount(id);
}

export async function updateAccount(id: number, patch: z.infer<typeof accountPatch>): Promise<AccountRow> {
  const a = await getAccount(id);
  const tokenChanged = patch.sessionToken !== undefined;
  await db.run(`
    UPDATE accounts SET name = ?, domain = ?, session_encrypted = ?, refresh_encrypted = ?, session_hint = ?, publish_interval_minutes = ?,
      polling_enabled = ?, status = ?, updated_at = ?
    WHERE id = ?
  `, [
    patch.name ?? a.name,
    patch.domain ?? a.domain,
    tokenChanged ? encrypt(patch.sessionToken!) : a.session_encrypted,
    patch.refreshToken !== undefined ? encrypt(patch.refreshToken) : tokenChanged ? null : a.refresh_encrypted,
    tokenChanged ? maskSecret(patch.sessionToken!) : a.session_hint,
    patch.publishIntervalMinutes !== undefined ? patch.publishIntervalMinutes : a.publish_interval_minutes,
    patch.pollingEnabled === undefined ? a.polling_enabled : patch.pollingEnabled ? 1 : 0,
    tokenChanged ? "pending" : a.status,
    nowIso(),
    id,
  ]);
  return getAccount(id);
}

/** Removes the stored session. Listings, sales and archive data stay untouched. */
export async function disconnectAccount(id: number) {
  await getAccount(id);
  await db.run("UPDATE accounts SET session_encrypted = NULL, refresh_encrypted = NULL, session_hint = NULL, status = 'disconnected', updated_at = ? WHERE id = ?", [nowIso(), id]);
  await db.run("UPDATE publish_queue SET status = 'cancelled', updated_at = ? WHERE account_id = ? AND status = 'pending'", [nowIso(), id]);
  await db.run("UPDATE scheduled_actions SET status = 'cancelled' WHERE account_id = ? AND status = 'pending'", [id]);
}

export async function deleteAccount(id: number) {
  await getAccount(id);
  const used = await db.get<{ c: number }>("SELECT COUNT(*) c FROM listings WHERE account_id = ?", [id]);
  if (Number(used?.c) > 0) {
    throw new HttpError(409, "Account hat Listings im Archiv und kann nur getrennt, nicht gelöscht werden (kein Datenverlust).");
  }
  await db.tx(async () => {
    await db.run("DELETE FROM publish_queue WHERE account_id = ?", [id]);
    await db.run("DELETE FROM sales WHERE account_id = ?", [id]);
    await db.run("DELETE FROM accounts WHERE id = ?", [id]);
  });
}

export function sessionFor(a: AccountRow): VintedSession {
  if (!a.session_encrypted) throw new HttpError(400, `Account "${a.name}" hat keine gespeicherte Session`);
  return {
    token: decrypt(a.session_encrypted),
    refreshToken: a.refresh_encrypted ? decrypt(a.refresh_encrypted) : null,
    domain: a.domain,
    vintedUserId: a.vinted_user_id,
    // Vinted renewed the tokens (same user): store them encrypted.
    onTokens: (access, refresh) =>
      db.run("UPDATE accounts SET session_encrypted = ?, refresh_encrypted = COALESCE(?, refresh_encrypted), session_hint = ?, updated_at = ? WHERE id = ?",
        [encrypt(access), refresh ? encrypt(refresh) : null, maskSecret(access), nowIso(), a.id]).then(() => undefined),
  };
}

export async function setAccountStatus(id: number, status: AccountRow["status"], error: string | null) {
  await db.run("UPDATE accounts SET status = ?, last_error = ?, updated_at = ? WHERE id = ?", [status, error, nowIso(), id]);
}
