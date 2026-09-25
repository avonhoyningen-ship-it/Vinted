import express, { Router } from "express";
import type Stripe from "stripe";
import { env } from "../config/env.js";
import { h, HttpError } from "../lib/http.js";
import { forgetAccess } from "./auth.js";
import { getUser, hasAccess, saveSubscription, setCustomer, userByCustomer } from "./users.js";

/**
 * Monthly subscription with Stripe: Checkout (card + PayPal), Customer Portal
 * (change payment method, cancel) and webhooks that keep app_users in sync.
 * The Clerk user id travels as client_reference_id and as metadata.
 */

let stripeClient: Stripe | null = null;
export async function stripe(): Promise<Stripe> {
  if (stripeClient) return stripeClient;
  if (!env.stripeSecretKey) throw new HttpError(503, "Zahlungen sind noch nicht eingerichtet (STRIPE_SECRET_KEY fehlt)");
  const { default: StripeCtor } = await import("stripe");
  stripeClient = new StripeCtor(env.stripeSecretKey);
  return stripeClient;
}
/** Tests inject a fake client. */
export function setStripe(s: Stripe | null) {
  stripeClient = s;
}

const iso = (unix: number | null | undefined) => (unix ? new Date(unix * 1000).toISOString() : null);

/** Newer Stripe API versions keep the period on the subscription items. */
function periodEnd(sub: Stripe.Subscription): string | null {
  const legacy = (sub as unknown as { current_period_end?: number }).current_period_end;
  return iso(legacy ?? sub.items?.data?.[0]?.current_period_end);
}

const customerId = (c: string | Stripe.Customer | Stripe.DeletedCustomer | null) => (typeof c === "string" ? c : c?.id ?? null);

/** Stores the subscription's current state for its user (idempotent – the state is always read from Stripe). */
export async function syncSubscription(sub: Stripe.Subscription, userIdHint?: string | null) {
  const cid = customerId(sub.customer);
  const userId = userIdHint ?? sub.metadata?.clerk_user_id ?? (cid ? (await userByCustomer(cid))?.id : null);
  if (!userId || !(await getUser(userId))) {
    console.warn(`[billing] Abo ${sub.id} ohne bekannten Nutzer`);
    return;
  }
  await saveSubscription(userId, {
    customerId: cid, subscriptionId: sub.id, status: sub.status, currentPeriodEnd: periodEnd(sub), cancelAtPeriodEnd: !!sub.cancel_at_period_end,
  });
  forgetAccess(userId);
}

let priceCache: { at: number; value: { amount: number | null; currency: string; interval: string | null } } | null = null;
async function priceInfo() {
  if (!env.stripePriceId || !env.stripeSecretKey) return null;
  if (priceCache && Date.now() - priceCache.at < 10 * 60_000) return priceCache.value;
  const p = await (await stripe()).prices.retrieve(env.stripePriceId);
  priceCache = { at: Date.now(), value: { amount: p.unit_amount, currency: p.currency, interval: p.recurring?.interval ?? null } };
  return priceCache.value;
}

export const billingRouter = Router();
const uid = (res: express.Response) => String(res.locals.userId);

/** Who is signed in and whether the subscription is active. */
export async function meHandler(_req: express.Request, res: express.Response) {
  const user = await getUser(uid(res));
  res.json({
    userId: uid(res),
    email: user?.email ?? null,
    active: hasAccess(user),
    subscription: {
      status: user?.subscription_status ?? "none",
      currentPeriodEnd: user?.current_period_end ?? null,
      cancelAtPeriodEnd: !!user?.cancel_at_period_end,
      hasCustomer: !!user?.stripe_customer_id,
    },
    price: await priceInfo().catch(() => null),
  });
}

billingRouter.post("/checkout", h(async (_req, res) => {
  if (!env.stripePriceId) throw new HttpError(503, "STRIPE_PRICE_ID fehlt");
  const s = await stripe();
  const user = (await getUser(uid(res)))!;
  if (hasAccess(user) && user.stripe_subscription_id) throw new HttpError(409, "Dein Abo ist bereits aktiv – verwalten kannst du es im Kundenportal.");
  let customer = user.stripe_customer_id;
  if (!customer) {
    customer = (await s.customers.create({ email: user.email ?? undefined, metadata: { clerk_user_id: user.id } })).id;
    await setCustomer(user.id, customer);
  }
  const session = await s.checkout.sessions.create({
    mode: "subscription",
    customer,
    client_reference_id: user.id,
    line_items: [{ price: env.stripePriceId, quantity: 1 }],
    payment_method_types: env.stripePaymentMethods as Stripe.Checkout.SessionCreateParams.PaymentMethodType[],
    subscription_data: { metadata: { clerk_user_id: user.id } },
    allow_promotion_codes: true,
    locale: "de",
    success_url: `${env.appUrl}/abo?status=success`,
    cancel_url: `${env.appUrl}/abo?status=cancelled`,
  });
  res.json({ url: session.url });
}));

billingRouter.post("/portal", h(async (_req, res) => {
  const user = (await getUser(uid(res)))!;
  if (!user.stripe_customer_id) throw new HttpError(400, "Noch kein Abo abgeschlossen");
  const session = await (await stripe()).billingPortal.sessions.create({ customer: user.stripe_customer_id, return_url: `${env.appUrl}/abo` });
  res.json({ url: session.url });
}));

/** Stripe → us. Mounted with the raw body (signature check needs the exact bytes). */
export const billingWebhook = [
  express.raw({ type: "application/json", limit: "1mb" }),
  h(async (req, res) => {
    if (!env.stripeWebhookSecret) throw new HttpError(503, "STRIPE_WEBHOOK_SECRET fehlt");
    const s = await stripe();
    let event: Stripe.Event;
    try {
      event = s.webhooks.constructEvent(req.body as Buffer, String(req.headers["stripe-signature"] ?? ""), env.stripeWebhookSecret);
    } catch {
      throw new HttpError(400, "Ungültige Stripe-Signatur");
    }
    switch (event.type) {
      // Abo abgeschlossen
      case "checkout.session.completed": {
        const session = event.data.object;
        if (session.mode === "subscription" && session.subscription) {
          const sub = await s.subscriptions.retrieve(typeof session.subscription === "string" ? session.subscription : session.subscription.id);
          await syncSubscription(sub, session.client_reference_id);
        }
        break;
      }
      // Abo aktiviert / geändert / gekündigt / abgelaufen
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await syncSubscription(event.data.object);
        break;
      // Abo verlängert / Zahlung fehlgeschlagen: current state comes from the subscription itself
      case "invoice.paid":
      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice & { subscription?: string | { id: string } | null };
        const subRef = invoice.parent?.subscription_details?.subscription ?? invoice.subscription;
        const subId = typeof subRef === "string" ? subRef : subRef?.id;
        if (subId) await syncSubscription(await s.subscriptions.retrieve(subId));
        break;
      }
      default:
        break;
    }
    res.json({ received: true });
  }),
];
