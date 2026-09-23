/**
 * Replaces {placeholder} tokens. Unknown placeholders are left untouched so
 * typos are visible in the preview rather than silently removed.
 */
export function renderTemplate(template: string, vars: Record<string, string | number | null | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const v = vars[name.toLowerCase()];
    return v === undefined || v === null ? match : String(v);
  });
}

export function formatPrice(cents: number | null | undefined, currency = "EUR"): string {
  if (cents === null || cents === undefined) return "";
  return new Intl.NumberFormat("de-DE", { style: "currency", currency }).format(cents / 100);
}

export const PLACEHOLDERS = [
  { key: "artikelname", description: "Titel des Artikels" },
  { key: "preis", description: "Aktueller Preis, z. B. 12,00 €" },
  { key: "neuer_preis", description: "Neuer Preis nach Preissenkung" },
  { key: "marke", description: "Marke" },
  { key: "groesse", description: "Größe" },
  { key: "nutzer", description: "Benutzername des Käufers/Interessenten" },
  { key: "account", description: "Name deines Accounts" },
] as const;
