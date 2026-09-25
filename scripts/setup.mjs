// Creates .env from .env.example (or completes an existing one):
// fresh ENCRYPTION_KEY and a random DASHBOARD_PASSWORD if missing.
import crypto from "node:crypto";
import fs from "node:fs";

const exists = fs.existsSync(".env");
let content = exists ? fs.readFileSync(".env", "utf8") : fs.readFileSync(".env.example", "utf8");

function ensure(key, value, comment) {
  const re = new RegExp(`^${key}=(.*)$`, "m");
  const m = content.match(re);
  if (m && m[1].trim()) return null;
  if (m) content = content.replace(re, `${key}=${value}`);
  else content += `\n${comment ? `# ${comment}\n` : ""}${key}=${value}\n`;
  return value;
}

ensure("ENCRYPTION_KEY", crypto.randomBytes(32).toString("base64"));
const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
const pw = Array.from(crypto.randomBytes(18), (b) => alphabet[b % alphabet.length]).join("");
// Only for a fresh .env: an existing but empty DASHBOARD_PASSWORD means "no login" and is respected.
const newPw = !exists || !/^DASHBOARD_PASSWORD=/m.test(content)
  ? ensure("DASHBOARD_PASSWORD", pw, "Passwort für den Login im Dashboard (mind. 4 Zeichen; leer = kein Login, dann nur auf diesem PC nutzbar)")
  : null;

fs.writeFileSync(".env", content, { mode: 0o600 });
console.log(exists ? ".env ergänzt." : ".env erstellt.");
if (newPw) console.log(`\n  Dein Dashboard-Passwort: ${newPw}\n  (steht auch in .env unter DASHBOARD_PASSWORD – dort kannst du es ändern)\n`);
