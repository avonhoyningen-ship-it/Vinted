// Creates .env from .env.example and fills in a fresh ENCRYPTION_KEY.
import crypto from "node:crypto";
import fs from "node:fs";

if (fs.existsSync(".env")) {
  console.log(".env existiert bereits – nichts geändert.");
  process.exit(0);
}
const key = crypto.randomBytes(32).toString("base64");
const content = fs.readFileSync(".env.example", "utf8").replace(/^ENCRYPTION_KEY=.*$/m, `ENCRYPTION_KEY=${key}`);
fs.writeFileSync(".env", content, { mode: 0o600 });
console.log(".env erstellt (mit neuem ENCRYPTION_KEY). Jetzt ggf. ANTHROPIC_API_KEY eintragen.");
