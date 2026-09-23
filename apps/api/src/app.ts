import cors from "cors";
import express from "express";
import { env } from "./config/env.js";
import { errorHandler } from "./lib/http.js";
import { accountsRouter } from "./modules/accounts/routes.js";
import { archiveRouter } from "./modules/archive/routes.js";
import { automationsRouter } from "./modules/automations/routes.js";
import { listingsRouter } from "./modules/listings/routes.js";
import { statsRouter } from "./modules/stats/routes.js";
import { systemRouter } from "./modules/system/routes.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors({ origin: env.corsOrigin.split(",").map((s) => s.trim()) }));
  app.use(express.json({ limit: "2mb" }));

  // Optional bearer token for deployments on a shared server. EventSource and
  // <img> can't send headers, so ?token= is accepted as well.
  if (env.apiToken) {
    app.use("/api", (req, res, next) => {
      if (req.path === "/health") return next();
      const header = req.headers.authorization?.replace(/^Bearer\s+/i, "");
      if (header === env.apiToken || req.query.token === env.apiToken) return next();
      res.status(401).json({ error: "Unauthorized" });
    });
  }

  app.use("/api", systemRouter);
  app.use("/api/accounts", accountsRouter);
  app.use("/api/listings", listingsRouter);
  app.use("/api/archive", archiveRouter);
  app.use("/api/automations", automationsRouter);
  app.use("/api/stats", statsRouter);
  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));
  app.use(errorHandler);
  return app;
}
