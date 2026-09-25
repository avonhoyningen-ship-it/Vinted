import { env } from "../config/env.js";

export interface Mail { to: string; subject: string; text: string }

type Sender = (m: Mail) => Promise<boolean>;

/** Sends via Resend (https://resend.com) when RESEND_API_KEY and MAIL_FROM are set; otherwise only logs. */
const resend: Sender = async (m) => {
  if (!env.resendApiKey || !env.mailFrom) {
    console.warn(`[mail] nicht versendet (RESEND_API_KEY/MAIL_FROM fehlen): ${m.subject} → ${m.to}`);
    return false;
  }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.resendApiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env.mailFrom, to: [m.to], subject: m.subject, text: m.text }),
  });
  if (!r.ok) console.warn(`[mail] Versand fehlgeschlagen (HTTP ${r.status}): ${m.subject}`);
  return r.ok;
};

let sender: Sender = resend;
export const sendMail = (m: Mail) => sender(m).catch(() => false);
/** Tests capture mails. */
export function setMailSender(s: Sender) {
  sender = s;
}
