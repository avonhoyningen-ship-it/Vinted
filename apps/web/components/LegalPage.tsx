import Link from "next/link";
import type { ReactNode } from "react";
import { LEGAL, LEGAL_COMPLETE } from "@/lib/legal";

/** Frame for the legal pages (public, also reachable without login). */
export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="landing">
      <div className="landing-inner legal stack">
        <Link href="/">← {LEGAL.product}</Link>
        <h1>{title}</h1>
        {!LEGAL_COMPLETE && (
          <div className="alert bad">
            Betreiberangaben fehlen noch (NEXT_PUBLIC_LEGAL_NAME, _STREET, _CITY, _EMAIL in Vercel eintragen). So darf die Seite nicht live gehen.
          </div>
        )}
        {children}
        <p className="small muted">Stand: {new Date(LEGAL.version).toLocaleDateString("de-DE")}</p>
        <LegalLinks />
      </div>
    </div>
  );
}

export function LegalLinks() {
  return (
    <div className="row small" style={{ justifyContent: "center", gap: 16, flexWrap: "wrap" }}>
      <Link href="/impressum">Impressum</Link>
      <Link href="/datenschutz">Datenschutz</Link>
      <Link href="/agb">AGB</Link>
      <Link href="/widerruf">Widerruf</Link>
      <Link href="/kuendigen">Verträge hier kündigen</Link>
    </div>
  );
}

export function Address() {
  return (
    <p>
      {LEGAL.name}<br />
      {LEGAL.representative && <>{LEGAL.representative}<br /></>}
      {LEGAL.street}<br />
      {LEGAL.city}<br />
      {LEGAL.country}
    </p>
  );
}
