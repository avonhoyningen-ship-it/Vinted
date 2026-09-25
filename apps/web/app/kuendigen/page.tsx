"use client";
import { useState } from "react";
import { LegalLinks } from "@/components/LegalPage";
import { api } from "@/lib/api";
import { LEGAL } from "@/lib/legal";

/** "Verträge hier kündigen" (§ 312k BGB) – reachable without login. */
export default function KuendigenPage() {
  const [step, setStep] = useState<"start" | "form" | "done">("start");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [kind, setKind] = useState<"ordentlich" | "ausserordentlich">("ordentlich");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ receivedAt: string; message: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ receivedAt: string; message: string }>("/public/cancel", { method: "POST", json: { name, email, kind, reason: reason || undefined } });
      setReceipt(r);
      setStep("done");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="landing">
      <div className="landing-inner legal stack">
        <a href="/">← {LEGAL.product}</a>
        <h1>Verträge hier kündigen</h1>
        {step === "start" && (
          <>
            <p>Hier kannst du dein Abo für „{LEGAL.product}“ ohne Anmeldung kündigen.</p>
            <div><button className="btn primary big" onClick={() => setStep("form")}>Verträge hier kündigen</button></div>
          </>
        )}
        {step === "form" && (
          <form className="card stack" onSubmit={submit}>
            <label className="field">Vor- und Nachname *<input required value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></label>
            <label className="field">E-Mail-Adresse deines Kontos *<input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></label>
            <label className="field">Art der Kündigung *
              <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                <option value="ordentlich">Ordentliche Kündigung zum nächstmöglichen Zeitpunkt (Ende des bezahlten Monats)</option>
                <option value="ausserordentlich">Außerordentliche Kündigung aus wichtigem Grund</option>
              </select>
            </label>
            {kind === "ausserordentlich" && (
              <label className="field">Kündigungsgrund *<textarea required value={reason} onChange={(e) => setReason(e.target.value)} /></label>
            )}
            <div className="small muted">Kündigungszeitpunkt: zum nächstmöglichen Zeitpunkt. Die Bestätigung mit Eingangszeit und Wirksamkeitsdatum erhältst du per E-Mail.</div>
            {error && <div className="alert bad">{error}</div>}
            <button className="btn primary big" disabled={busy} style={{ justifyContent: "center" }}>{busy ? "Wird gesendet…" : "Jetzt kündigen"}</button>
          </form>
        )}
        {step === "done" && receipt && (
          <div className="card stack">
            <h2 style={{ margin: 0 }}>Kündigung eingegangen</h2>
            <p style={{ margin: 0 }}>Eingang: {new Date(receipt.receivedAt).toLocaleString("de-DE", { dateStyle: "long", timeStyle: "medium" })}</p>
            <p style={{ margin: 0 }}>Name: {name} · E-Mail: {email} · Art: {kind === "ordentlich" ? "ordentlich, zum nächstmöglichen Zeitpunkt" : "außerordentlich"}</p>
            <p style={{ margin: 0 }}>{receipt.message}</p>
            <div><button className="btn" onClick={() => window.print()}>Diese Bestätigung drucken / speichern</button></div>
          </div>
        )}
        <LegalLinks />
      </div>
    </div>
  );
}
