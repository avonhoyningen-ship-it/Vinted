/**
 * Operator details for Impressum, Datenschutz, AGB and Widerruf. Set them in
 * Vercel (Environment Variables) – until then the pages show a warning and
 * placeholders. Nothing here is invented: missing values stay visibly empty.
 */
const v = (name: string, value: string | undefined) => (value && value.trim()) || `[${name} fehlt]`;

export const LEGAL = {
  /** Name of the person or company, e.g. "Alexander Muster" or "Muster UG (haftungsbeschränkt)" */
  name: v("Name / Firma", process.env.NEXT_PUBLIC_LEGAL_NAME),
  /** Only for companies: e.g. "vertreten durch den Geschäftsführer Alexander Muster" */
  representative: process.env.NEXT_PUBLIC_LEGAL_REPRESENTATIVE?.trim() || null,
  street: v("Straße und Hausnummer", process.env.NEXT_PUBLIC_LEGAL_STREET),
  city: v("PLZ und Ort", process.env.NEXT_PUBLIC_LEGAL_CITY),
  country: process.env.NEXT_PUBLIC_LEGAL_COUNTRY?.trim() || "Deutschland",
  email: v("E-Mail", process.env.NEXT_PUBLIC_LEGAL_EMAIL),
  phone: process.env.NEXT_PUBLIC_LEGAL_PHONE?.trim() || null,
  /** USt-IdNr.; empty = Kleinunternehmer (§ 19 UStG) */
  vatId: process.env.NEXT_PUBLIC_LEGAL_VAT_ID?.trim() || null,
  /** Handelsregister, e.g. "Amtsgericht Hamburg, HRB 12345" (only for registered companies) */
  register: process.env.NEXT_PUBLIC_LEGAL_REGISTER?.trim() || null,
  product: "Alex Sales Kit",
  /** Date of the current version of the texts (shown on the pages, stored with the consent). */
  version: "2026-09-26",
};

export const LEGAL_COMPLETE = [
  process.env.NEXT_PUBLIC_LEGAL_NAME, process.env.NEXT_PUBLIC_LEGAL_STREET, process.env.NEXT_PUBLIC_LEGAL_CITY, process.env.NEXT_PUBLIC_LEGAL_EMAIL,
].every((x) => x && x.trim());
