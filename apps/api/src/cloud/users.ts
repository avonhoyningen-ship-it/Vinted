import { db, nowIso, withSystem } from "../db/index.js";

export interface AppUser {
  id: string;
  email: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: string;
  current_period_end: string | null;
  cancel_at_period_end: number;
}

/** Statuses that unlock the app. "past_due" keeps access while Stripe retries the payment. */
export const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"]);
export const hasAccess = (u: Pick<AppUser, "subscription_status"> | undefined) => !!u && ACTIVE_STATUSES.has(u.subscription_status);

/** Creates the user row on the first request after sign-up. */
export async function ensureUser(id: string, email: string | null) {
  await withSystem(() => db.run(
    "INSERT INTO app_users (id, email) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET email = COALESCE(excluded.email, app_users.email)",
    [id, email],
  ));
}

export function getUser(id: string): Promise<AppUser | undefined> {
  return withSystem(() => db.get<AppUser>("SELECT * FROM app_users WHERE id = ?", [id]));
}

export function userByCustomer(customerId: string): Promise<AppUser | undefined> {
  return withSystem(() => db.get<AppUser>("SELECT * FROM app_users WHERE stripe_customer_id = ?", [customerId]));
}

export async function saveSubscription(userId: string, s: {
  customerId?: string | null; subscriptionId: string | null; status: string; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean;
}) {
  await withSystem(() => db.run(`UPDATE app_users SET stripe_customer_id = COALESCE(?, stripe_customer_id), stripe_subscription_id = ?,
      subscription_status = ?, current_period_end = ?, cancel_at_period_end = ?, updated_at = ? WHERE id = ?`,
  [s.customerId ?? null, s.subscriptionId, s.status, s.currentPeriodEnd, s.cancelAtPeriodEnd ? 1 : 0, nowIso(), userId]));
}

export async function setCustomer(userId: string, customerId: string) {
  await withSystem(() => db.run("UPDATE app_users SET stripe_customer_id = ?, updated_at = ? WHERE id = ?", [customerId, nowIso(), userId]));
}
