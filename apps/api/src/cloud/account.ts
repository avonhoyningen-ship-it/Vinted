import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { currentUserId, db, withSystem } from "../db/index.js";
import { USER_TABLES } from "../db/pgSchema.js";
import { h, HttpError } from "../lib/http.js";
import { createZip } from "../lib/zip.js";
import { photoStore } from "../storage/store.js";
import { forgetAccess } from "./auth.js";
import { stripe } from "./billing.js";
import { getUser } from "./users.js";

/**
 * DSGVO self-service: download all data (Art. 15/20) and delete the account
 * with everything in it (Art. 17).
 */
export const accountRouter = Router();

/** Children before parents, so foreign keys never block. */
const DELETE_ORDER = [
  "scheduled_actions", "listing_price_changes", "publish_queue", "sales", "price_examples", "item_photos", "listings",
  "vinted_events", "automation_rules", "templates", "price_rules", "settings", "items", "accounts", "helper_jobs", "helper_tokens",
] as const;

type ClerkDeleter = (userId: string) => Promise<void>;
let deleteClerkUser: ClerkDeleter = async (userId) => {
  if (!env.clerkSecretKey) return;
  const { createClerkClient } = await import("@clerk/backend");
  await createClerkClient({ secretKey: env.clerkSecretKey }).users.deleteUser(userId);
};
/** Tests replace the Clerk call. */
export function setClerkDeleter(fn: ClerkDeleter) {
  deleteClerkUser = fn;
}

accountRouter.get("/export", h(async (_req, res) => {
  const userId = currentUserId();
  const user = await getUser(userId);
  const data: Record<string, unknown> = {
    exportedAt: new Date().toISOString(),
    user: user && { id: user.id, email: user.email, subscription_status: user.subscription_status, current_period_end: user.current_period_end },
  };
  for (const t of USER_TABLES) data[t] = await db.all(`SELECT * FROM ${t}`);
  data.helper_tokens = await db.all("SELECT id, name, last_seen_at, revoked_at, created_at FROM helper_tokens");
  const files: { name: string; data: Buffer }[] = [{ name: "daten.json", data: Buffer.from(JSON.stringify(data, null, 2)) }];
  for (const p of (data.item_photos as { item_id: number; file_name: string }[])) {
    const photo = await photoStore().get(p.file_name).catch(() => null);
    if (photo) files.push({ name: `fotos/${p.item_id}/${p.file_name}`, data: photo });
  }
  res.setHeader("content-type", "application/zip");
  res.setHeader("content-disposition", `attachment; filename="alex-sales-kit-daten-${new Date().toISOString().slice(0, 10)}.zip"`);
  res.send(createZip(files));
}));

accountRouter.delete("/", h(async (req, res) => {
  const { confirm } = z.object({ confirm: z.literal("LÖSCHEN", { error: "Zum Bestätigen „LÖSCHEN“ eingeben." }) }).parse(req.body ?? {});
  void confirm;
  const userId = currentUserId();
  const user = await getUser(userId);
  if (!user) throw new HttpError(404, "Konto nicht gefunden");

  // 1. End the subscription now – nothing is charged anymore.
  if (user.stripe_subscription_id && !["canceled", "incomplete_expired"].includes(user.subscription_status)) {
    await (await stripe()).subscriptions.cancel(user.stripe_subscription_id).catch((e: Error) => {
      if (!/No such subscription/i.test(e.message)) throw new HttpError(502, `Abo konnte nicht beendet werden: ${e.message}`);
    });
  }
  // 2. Photos, 3. all rows of this user (row level security keeps it to this user), 4. the user record, 5. the Clerk login.
  const photos = (await photoStore().deleteAll?.()) ?? 0;
  const rows: Record<string, number> = {};
  await db.tx(async () => {
    for (const t of DELETE_ORDER) rows[t] = await db.run(`DELETE FROM ${t}`);
  });
  await withSystem(() => db.run("DELETE FROM app_users WHERE id = ?", [userId]));
  forgetAccess(userId);
  await deleteClerkUser(userId);
  console.log(`[account] Konto ${userId} gelöscht (${photos} Fotos, ${Object.values(rows).reduce((a, b) => a + b, 0)} Zeilen)`);
  res.json({ deleted: true });
}));
