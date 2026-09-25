/** "cloud": SaaS with Clerk login and subscription. Otherwise the local single-user dashboard. */
export const CLOUD = process.env.NEXT_PUBLIC_APP_MODE === "cloud";

/** Price shown on the landing page (the real price comes from Stripe). */
export const PRICE_LABEL = process.env.NEXT_PUBLIC_PRICE_LABEL || "9,99 € / Monat";
