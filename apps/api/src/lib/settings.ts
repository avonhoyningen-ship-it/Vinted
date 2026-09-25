import { db } from "../db/index.js";
import { DEFAULT_LISTING_PROMPT } from "../modules/listings/defaultPrompt.js";

export const DEFAULT_SETTINGS = {
  "sound.preset": "cha-ching",
  "sound.volume": 0.7,
  "sound.enabled": true,
  "notifications.desktop": true,
  "notifications.confetti": true,
  /** Hard cap on automated messages per account and day (anti-spam). */
  "automation.dailyMessageCap": 40,
  "automation.paused": false,
  "ai.language": "de",
  /** Instructions for AI listing texts (Einstellungen → KI-Prompt). */
  "ai.listingPrompt": DEFAULT_LISTING_PROMPT,
  /** Brand rules, one per line: "<words in title/category/hashtags>=<brand>", e.g. "T-Shirt, Tee=Graphic Tee". */
  "brand.rules": "T-Shirt, Tee, Shirt=Graphic Tee",
};
export type SettingKey = keyof typeof DEFAULT_SETTINGS;

export function getSettings(): typeof DEFAULT_SETTINGS {
  const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of rows) if (r.key in DEFAULT_SETTINGS) out[r.key] = JSON.parse(r.value);
  return out as typeof DEFAULT_SETTINGS;
}

export function getSetting<K extends SettingKey>(key: K): (typeof DEFAULT_SETTINGS)[K] {
  return getSettings()[key];
}

export function setSettings(patch: Partial<Record<SettingKey, unknown>>) {
  const stmt = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  db.transaction(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULT_SETTINGS)) continue;
      const def = DEFAULT_SETTINGS[k as SettingKey];
      if (typeof v !== typeof def) throw new Error(`Setting ${k} must be ${typeof def}`);
      stmt.run(k, JSON.stringify(v));
    }
  })();
  return getSettings();
}
