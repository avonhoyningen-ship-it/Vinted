"use client";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { ErrorBox, PageHead } from "@/components/ui";
import { api, dateTime } from "@/lib/api";
import Link from "next/link";
import { LEGAL } from "@/lib/legal";
import { PRICE_LABEL } from "@/lib/mode";
import { useApi } from "@/lib/useApi";

export interface Me {
  userId: string;
  email: string | null;
  active: boolean;
  subscription: { status: string; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; hasCustomer: boolean };
  price: { amount: number | null; currency: string; interval: string | null } | null;
}

const STATUS: Record<string, string> = {
  none: "Kein Abo", active: "Aktiv", trialing: "Testphase", past_due: "Zahlung offen – Stripe versucht es erneut",
  canceled: "Gekündigt / abgelaufen", unpaid: "Unbezahlt", incomplete: "Zahlung nicht abgeschlossen", incomplete_expired: "Abgebrochen",
};

function priceText(p: Me["price"]) {
  if (!p?.amount) return PRICE_LABEL;
  const amount = new Intl.NumberFormat("de-DE", { style: "currency", currency: p.currency.toUpperCase() }).format(p.amount / 100);
  return `${amount} / ${p.interval === "year" ? "Jahr" : "Monat"}`;
}

function AboInner() {
  const params = useSearchParams();
  const { data: me, error, reload } = useApi<Me>("/me");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [terms, setTerms] = useState(false);
  const [startNow, setStartNow] = useState(false);

  async function go(path: "/billing/checkout" | "/billing/portal") {
    setBusy(true);
    setErr(null);
    try {
      const json = path === "/billing/checkout" ? { acceptTerms: terms, startNow, termsVersion: LEGAL.version } : undefined;
      const { url } = await api<{ url: string }>(path, { method: "POST", json });
      window.location.href = url;
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  const status = params.get("status");
  return (
    <div className="stack" style={{ maxWidth: 640 }}>
      <PageHead title="Abo" sub="Dein Zugang zum Alex Sales Kit" />
      <ErrorBox error={error ?? err} />
      {status === "success" && !me?.active && (
        <div className="alert info row">Zahlung erhalten – dein Abo wird gerade aktiviert… <button className="btn small" onClick={() => reload()}>Aktualisieren</button></div>
      )}
      {status === "cancelled" && <div className="alert">Bezahlung abgebrochen – es wurde nichts abgebucht.</div>}
      {me && (
        <div className="card stack">
          <div className="row"><strong>Status:</strong> <span className={`badge ${me.active ? "good" : "warn"}`}>{STATUS[me.subscription.status] ?? me.subscription.status}</span></div>
          {me.subscription.currentPeriodEnd && (
            <div className="small muted">
              {me.subscription.cancelAtPeriodEnd || me.subscription.status === "canceled" ? "Zugang bis" : "Nächste Abbuchung"}: {dateTime(me.subscription.currentPeriodEnd)}
            </div>
          )}
          <div className="price">{priceText(me.price)}</div>
          {!me.active ? (
            <>
              <p className="muted" style={{ margin: 0 }}>Mit dem Abo schaltest du alle Funktionen frei. Bezahlen mit Karte oder PayPal, verlängert sich monatlich, jederzeit zum Monatsende kündbar.</p>
              <label className="row small" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
                <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} style={{ marginTop: 3 }} />
                <span>Ich habe die <Link href="/agb" target="_blank">AGB</Link> und die <Link href="/datenschutz" target="_blank">Datenschutzerklärung</Link> gelesen und akzeptiere die AGB.</span>
              </label>
              <label className="row small" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
                <input type="checkbox" checked={startNow} onChange={(e) => setStartNow(e.target.checked)} style={{ marginTop: 3 }} />
                <span>
                  Ich verlange ausdrücklich, dass ihr vor Ablauf der Widerrufsfrist mit der Leistung beginnt. Mir ist bekannt, dass ich bei einem
                  Widerruf einen anteiligen Betrag für die bis dahin erbrachte Leistung zahle (<Link href="/widerruf" target="_blank">Widerrufsbelehrung</Link>).
                </span>
              </label>
              <button className="btn primary big" disabled={busy || !terms || !startNow} onClick={() => go("/billing/checkout")} style={{ justifyContent: "center" }}>
                {busy ? "Weiter zu Stripe…" : "Abo abschließen"}
              </button>
            </>
          ) : (
            <a className="btn primary" href="/dashboard" style={{ justifyContent: "center" }}>Zum Dashboard</a>
          )}
          {me.subscription.hasCustomer && (
            <button className="btn" disabled={busy} onClick={() => go("/billing/portal")} style={{ justifyContent: "center" }}>
              Abo verwalten / kündigen / Zahlungsart ändern
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function AboPage() {
  return <Suspense><AboInner /></Suspense>;
}
