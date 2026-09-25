import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { db, withSystem } from "../db/index.js";
import { h, HttpError } from "../lib/http.js";
import { stripe, syncSubscription } from "./billing.js";
import { sendMail } from "./mail.js";

/**
 * "Verträge hier kündigen" (§ 312k BGB): public, no login. Every request is
 * stored with its time of receipt; if the e-mail belongs to an active
 * subscription it is cancelled at the end of the paid period right away.
 * The page never reveals whether an e-mail has an account – the details go
 * to that e-mail address.
 */
export const legalRouter = Router();

const tries = new Map<string, number[]>();
function limited(ip: string) {
  const now = Date.now();
  const recent = (tries.get(ip) ?? []).filter((t) => now - t < 3600_000);
  recent.push(now);
  tries.set(ip, recent);
  return recent.length > 10;
}

const cancelInput = z.object({
  name: z.string().trim().min(2).max(200),
  email: z.string().trim().toLowerCase().email().max(200),
  kind: z.enum(["ordentlich", "ausserordentlich"]).default("ordentlich"),
  reason: z.string().trim().max(2000).optional(),
});

const de = (iso: string) => new Date(iso).toLocaleString("de-DE", { timeZone: "Europe/Berlin", dateStyle: "long", timeStyle: "short" });

legalRouter.post("/cancel", h(async (req, res) => {
  if (limited(req.ip ?? "unknown")) throw new HttpError(429, "Zu viele Anfragen – bitte später erneut versuchen oder per E-Mail kündigen.");
  const input = cancelInput.parse(req.body);
  if (input.kind === "ausserordentlich" && !input.reason) throw new HttpError(400, "Bitte den Kündigungsgrund angeben.");
  const receivedAt = new Date().toISOString();

  const user = await withSystem(() => db.get<{ id: string; stripe_subscription_id: string | null; subscription_status: string }>(
    "SELECT id, stripe_subscription_id, subscription_status FROM app_users WHERE LOWER(email) = ? ORDER BY created_at LIMIT 1", [input.email]));
  let effective: string | null = null;
  let result = "kein aktives Abo zu dieser E-Mail gefunden – manuell prüfen";
  if (user?.stripe_subscription_id && ["active", "trialing", "past_due"].includes(user.subscription_status)) {
    try {
      const sub = await (await stripe()).subscriptions.update(user.stripe_subscription_id, {
        cancel_at_period_end: true,
        cancellation_details: { comment: `Kündigungsbutton (${input.kind})${input.reason ? `: ${input.reason.slice(0, 400)}` : ""}` },
      });
      await syncSubscription(sub, user.id);
      const end = sub.items?.data?.[0]?.current_period_end ?? (sub as unknown as { current_period_end?: number }).current_period_end;
      effective = end ? new Date(end * 1000).toISOString() : null;
      result = input.kind === "ausserordentlich" ? "zum Periodenende gekündigt – außerordentliche Kündigung manuell prüfen" : "zum Periodenende gekündigt";
    } catch (e) {
      result = `Stripe-Fehler: ${(e as Error).message} – manuell kündigen`;
    }
  }
  await withSystem(() => db.run(
    "INSERT INTO cancellation_requests (user_id, name, email, kind, reason, effective, result, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [user?.id ?? null, input.name, input.email, input.kind, input.reason ?? null, effective, result, receivedAt]));

  const confirmation = [
    `Hallo ${input.name},`,
    "",
    `wir haben deine ${input.kind === "ausserordentlich" ? "außerordentliche" : "ordentliche"} Kündigung für „Alex Sales Kit“ am ${de(receivedAt)} erhalten.`,
    effective
      ? `Dein Abo endet zum ${de(effective)}. Bis dahin kannst du alle Funktionen weiter nutzen; danach wird nichts mehr abgebucht.`
      : "Zu dieser E-Mail-Adresse haben wir kein laufendes Abo gefunden. Falls du mit einer anderen Adresse registriert bist, antworte bitte auf diese E-Mail.",
    input.kind === "ausserordentlich" ? "Die außerordentliche Kündigung prüfen wir und melden uns." : "",
    "",
    "Deine Daten bleiben gespeichert, bis du dein Konto löschst (im Dashboard unter „Abo“ → „Meine Daten“).",
  ].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n");
  await sendMail({ to: input.email, subject: "Bestätigung deiner Kündigung – Alex Sales Kit", text: confirmation });
  if (env.operatorEmail) {
    await sendMail({ to: env.operatorEmail, subject: `Kündigung eingegangen: ${input.email}`, text: `${confirmation}\n\n---\nErgebnis: ${result}` });
  }
  // Same answer whether or not an account exists: details go to the e-mail address.
  res.json({ receivedAt, kind: input.kind, message: "Deine Kündigung ist eingegangen. Die Bestätigung mit dem Zeitpunkt, zu dem sie wirksam wird, schicken wir an deine E-Mail-Adresse." });
}));
