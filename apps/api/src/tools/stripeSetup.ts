/**
 * Sets up Stripe for the subscription (test or live mode, depending on the key):
 * product + monthly price, webhook endpoint with all needed events, Customer Portal.
 *
 *   STRIPE_SECRET_KEY=sk_test_... npm run stripe:setup -w apps/api -- --api https://api.deine-domain.de [--amount 9.99]
 *
 * Prints STRIPE_PRICE_ID and STRIPE_WEBHOOK_SECRET for Railway. Safe to run again:
 * existing product/webhook (same name/URL) are reused.
 */
import type Stripe from "stripe";

export const WEBHOOK_EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
];
const PRODUCT_NAME = "Alex Sales Kit";

export async function setupStripe(stripe: Stripe, opts: { apiUrl: string; amountCents: number; currency?: string; appUrl?: string }) {
  const currency = opts.currency ?? "eur";
  const products = await stripe.products.list({ active: true, limit: 100 });
  const product = products.data.find((p) => p.name === PRODUCT_NAME)
    ?? await stripe.products.create({ name: PRODUCT_NAME, description: "Monatliches Abo für das Alex Sales Kit (Vinted-Dashboard)" });

  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  const price = prices.data.find((p) => p.unit_amount === opts.amountCents && p.currency === currency && p.recurring?.interval === "month")
    ?? await stripe.prices.create({ product: product.id, unit_amount: opts.amountCents, currency, recurring: { interval: "month" }, nickname: "Monatlich" });

  const url = `${opts.apiUrl.replace(/\/+$/, "")}/api/billing/webhook`;
  const hooks = await stripe.webhookEndpoints.list({ limit: 100 });
  let webhookSecret: string | null = null;
  let hook = hooks.data.find((w) => w.url === url);
  if (hook) {
    await stripe.webhookEndpoints.update(hook.id, { enabled_events: WEBHOOK_EVENTS });
  } else {
    hook = await stripe.webhookEndpoints.create({ url, enabled_events: WEBHOOK_EVENTS, description: "Alex Sales Kit – Abo-Status" });
    webhookSecret = hook.secret ?? null; // only returned on creation
  }

  // Customer Portal: cancel at period end, update payment method, see invoices.
  await stripe.billingPortal.configurations.create({
    business_profile: { headline: "Alex Sales Kit – Abo verwalten" },
    default_return_url: opts.appUrl ? `${opts.appUrl.replace(/\/+$/, "")}/abo` : undefined,
    features: {
      subscription_cancel: { enabled: true, mode: "at_period_end" },
      payment_method_update: { enabled: true },
      invoice_history: { enabled: true },
      customer_update: { enabled: true, allowed_updates: ["email", "address"] },
    },
  });

  return { productId: product.id, priceId: price.id, webhookId: hook.id, webhookSecret, webhookUrl: url };
}

async function main() {
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const key = process.env.STRIPE_SECRET_KEY;
  const apiUrl = arg("--api");
  if (!key || !apiUrl) {
    console.error("Aufruf: STRIPE_SECRET_KEY=sk_test_… npm run stripe:setup -w apps/api -- --api https://api.deine-domain.de [--amount 9.99] [--app https://app.deine-domain.de]");
    process.exit(1);
  }
  const amountCents = Math.round(Number(arg("--amount") ?? "9.99") * 100);
  const { default: StripeCtor } = await import("stripe");
  const r = await setupStripe(new StripeCtor(key), { apiUrl, amountCents, appUrl: arg("--app") });
  console.log(`\nStripe ist eingerichtet (${key.startsWith("sk_live") ? "LIVE" : "Testmodus"}):`);
  console.log(`  Produkt:  ${r.productId}`);
  console.log(`  Webhook:  ${r.webhookUrl}`);
  console.log("\nIn Railway eintragen:");
  console.log(`  STRIPE_PRICE_ID=${r.priceId}`);
  console.log(r.webhookSecret ? `  STRIPE_WEBHOOK_SECRET=${r.webhookSecret}` : "  STRIPE_WEBHOOK_SECRET: Webhook gab es schon – Secret im Stripe-Dashboard unter Entwickler → Webhooks ansehen.");
  console.log("\nPayPal: im Stripe-Dashboard unter Einstellungen → Zahlungsmethoden aktivieren (sonst lehnt Checkout „paypal“ ab).");
}

if (process.argv[1] && /stripeSetup\.(ts|js)$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error("Fehler:", (e as Error).message);
    process.exit(1);
  });
}
