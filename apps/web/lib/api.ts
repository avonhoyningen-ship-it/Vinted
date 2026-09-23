export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000").replace(/\/$/, "");
const TOKEN = process.env.NEXT_PUBLIC_API_TOKEN || "";

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (TOKEN) headers.set("authorization", `Bearer ${TOKEN}`);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`${API_URL}/api${path}`, { ...init, headers, body });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const details = (data as { details?: { message?: string; path?: unknown[] }[] }).details;
    const detailMsg = Array.isArray(details) ? details.map((d) => d.message).filter(Boolean).join(", ") : "";
    throw new ApiError(res.status, [(data as { error?: string }).error ?? `HTTP ${res.status}`, detailMsg].filter(Boolean).join(": "), details);
  }
  return data as T;
}

export function withToken(url: string) {
  return TOKEN ? `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(TOKEN)}` : url;
}

export const photoUrl = (file: string | null | undefined) => (file ? withToken(`${API_URL}/api/photos/${file}`) : null);
export const eventStreamUrl = () => withToken(`${API_URL}/api/events/stream`);

export function euro(cents: number | null | undefined, currency = "EUR") {
  if (cents === null || cents === undefined) return "–";
  return new Intl.NumberFormat("de-DE", { style: "currency", currency }).format(cents / 100);
}

export function dateTime(iso: string | null | undefined) {
  if (!iso) return "–";
  return new Date(iso).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });
}

export function date(iso: string | null | undefined) {
  if (!iso) return "–";
  return new Date(iso).toLocaleDateString("de-DE");
}

export function relative(iso: string | null | undefined) {
  if (!iso) return "nie";
  const diff = (Date.parse(iso) - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat("de", { numeric: "auto" });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  return rtf.format(Math.round(diff / 86400), "day");
}

/** "12,50" / "12.5" / "12" → cents */
export function parseEuro(input: string): number | null {
  const s = input.trim().replace(/\s|€/g, "").replace(",", ".");
  if (!s) return null;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
export const centsToInput = (c: number | null | undefined) => (c === null || c === undefined ? "" : (c / 100).toFixed(2).replace(".", ","));

export const CONDITIONS: Record<string, string> = {
  new_with_tags: "Neu mit Etikett",
  new_without_tags: "Neu ohne Etikett",
  very_good: "Sehr gut",
  good: "Gut",
  satisfactory: "Zufriedenstellend",
};

export const ITEM_STATUS: Record<string, string> = {
  draft: "Entwurf",
  queued: "In Warteschlange",
  active: "Aktiv",
  sold: "Verkauft",
  archived: "Archiviert",
  relisted: "Erneut gelistet",
};

export const LISTING_STATUS: Record<string, string> = {
  active: "Aktiv", sold: "Verkauft", removed: "Entfernt", expired: "Abgelaufen", hidden: "Versteckt",
};

export const ACCOUNT_STATUS: Record<string, string> = {
  pending: "Ausstehend", connected: "Verbunden", error: "Fehler", disconnected: "Getrennt",
};
