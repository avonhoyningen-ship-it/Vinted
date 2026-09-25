import cors from "cors";
import express from "express";
import { env } from "./config/env.js";
import { requireAuth } from "./lib/auth.js";
import { errorHandler, h, idParam } from "./lib/http.js";
import { helperAdapter } from "./cloud/helperAdapter.js";
import { cloudAssistRouter, connectAccountViaHelper, helperRouter, helperTokensRouter } from "./cloud/helperRoutes.js";
import { vintedClient } from "./vinted/vintedClient.js";
import { cloudAuth } from "./cloud/auth.js";
import { billingRouter, billingWebhook, meHandler } from "./cloud/billing.js";
import { accountsRouter } from "./modules/accounts/routes.js";
import { archiveRouter } from "./modules/archive/routes.js";
import { assistRouter } from "./modules/assist/routes.js";
import { automationsRouter } from "./modules/automations/routes.js";
import { listingsRouter } from "./modules/listings/routes.js";
import { pricingRouter } from "./modules/pricing/routes.js";
import { statsRouter } from "./modules/stats/routes.js";
import { authRouter } from "./modules/system/authRoutes.js";
import { systemRouter } from "./modules/system/routes.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  if (env.trustProxy) app.set("trust proxy", 1);
  const origins = env.corsOrigin.split(",").map((s) => s.trim());
  if (env.appMode === "cloud") origins.push(new URL(env.appUrl).origin);
  app.use(cors({ origin: origins, credentials: true }));
  // Stripe signs the raw body: this route must come before the JSON parser.
  if (env.appMode === "cloud") app.post("/api/billing/webhook", ...billingWebhook);
  // The PC helper sends whole listing/sales lists back – allow larger bodies there.
  const jsonSmall = express.json({ limit: "2mb" });
  const jsonLarge = express.json({ limit: "20mb" });
  app.use((req, res, next) => (req.path.startsWith("/api/helper/") ? jsonLarge : jsonSmall)(req, res, next));
  app.use((_req, res, next) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "same-origin");
    next();
  });

  if (env.appMode === "cloud") {
    // Clerk session + active subscription; every request runs in its user's database scope.
    app.use("/api", cloudAuth);
    app.get("/api/me", h(meHandler));
    app.use("/api/billing", billingRouter);
    // PC helper: pairing keys (dashboard), job polling (helper, own key), Vinted via helper.
    app.use("/api/helper-tokens", helperTokensRouter);
    app.use("/api/helper", helperRouter);
    app.post("/api/accounts/:id/connect-helper", h(async (req, res) => res.json(await connectAccountViaHelper(idParam(req)))));
    app.use("/api/assist", cloudAssistRouter);
    vintedClient.useAdapter(helperAdapter, 0);
  } else {
    // Login (cookie session) or bearer API_TOKEN; open only if neither is configured.
    app.use("/api/auth", authRouter);
    app.use("/api", requireAuth);
  }
  app.use("/api", systemRouter);
  app.use("/api/accounts", accountsRouter);
  app.use("/api/listings", listingsRouter);
  app.use("/api/archive", archiveRouter);
  app.use("/api/automations", automationsRouter);
  app.use("/api/stats", statsRouter);
  app.use("/api/pricing", pricingRouter);
  // The posting assistant drives the Chrome on this PC – in the cloud the PC helper does that.
  if (env.appMode === "local") app.use("/api/assist", assistRouter);
  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));
  app.use(errorHandler);
  return app;
}
