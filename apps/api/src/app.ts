import cors from "cors";
import express from "express";
import { env } from "./config/env.js";
import { requireAuth } from "./lib/auth.js";
import { errorHandler } from "./lib/http.js";
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
  app.use(cors({ origin: env.corsOrigin.split(",").map((s) => s.trim()), credentials: true }));
  app.use(express.json({ limit: "2mb" }));
  app.use((_req, res, next) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "same-origin");
    next();
  });

  // Login (cookie session) or bearer API_TOKEN; open only if neither is configured.
  app.use("/api/auth", authRouter);
  app.use("/api", requireAuth);
  app.use("/api", systemRouter);
  app.use("/api/accounts", accountsRouter);
  app.use("/api/listings", listingsRouter);
  app.use("/api/archive", archiveRouter);
  app.use("/api/automations", automationsRouter);
  app.use("/api/stats", statsRouter);
  app.use("/api/pricing", pricingRouter);
  app.use("/api/assist", assistRouter);
  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));
  app.use(errorHandler);
  return app;
}
