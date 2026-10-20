"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { useToast } from "./Toasts";

interface Status {
  configured: boolean; connected: boolean; sandbox: boolean; clientId: string; ruName: string; hasSecret: boolean;
  refreshExpiresAt: string | null; postalCode: string; fulfillmentPolicyId: string; paymentPolicyId: string; returnPolicyId: string;
  autoList: boolean; pricePercent: number;
}
interface Policies { fulfillment: { id: string; name: string }[]; payment: { id: string; name: string }[]; return: { id: string; name: string }[] }

/** eBay: own developer keys → login → shipping/payment/return policies → automatic listing. */
export function EbayCard() {
  const toast = useToast();
  const { data: st, reload } = useApi<Status>("/ebay/status");
  const [keys, setKeys] = useState({ clientId: "", clientSecret: "", ruName: "", sandbox: false });
  const [code, setCode] = useState("");
  const [policies, setPolicies] = useState<Policies | null>(null);
  const [form, setForm] = useState({ postalCode: "", fulfillmentPolicyId: "", paymentPolicyId: "", returnPolicyId: "", autoList: true, pricePercent: 100 });

  useEffect(() => {
    if (!st) return;
    setKeys((k) => ({ ...k, clientId: st.clientId, ruName: st.ruName, sandbox: st.sandbox }));
    setForm({ postalCode: st.postalCode, fulfillmentPolicyId: st.fulfillmentPolicyId, paymentPolicyId: st.paymentPolicyId, returnPolicyId: st.returnPolicyId, autoList: st.autoList, pricePercent: st.pricePercent });
    if (st.connected) api<Policies>("/ebay/policies").then(setPolicies).catch((e) => toast({ kind: "error", text: e.message }));
  }, [st]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("ebay");
    if (q) toast({ kind: q === "ok" ? "info" : "error", text: q === "ok" ? "Mit eBay verbunden ✓" : `eBay-Anmeldung ${q}` });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const run = (fn: () => Promise<unknown>, ok: string) => fn().then(() => { toast({ kind: "info", text: ok }); void reload(); }).catch((e) => toast({ kind: "error", text: e.message }));

  return (
    <div className="card stack" style={{ marginBottom: 16 }}>
      <h2>🛒 eBay – direkt mit einstellen</h2>
      <div className="small muted">
        Jeder Artikel, der auf Vinted online geht, wird automatisch auch auf eBay eingestellt (offizielle eBay-Schnittstelle).
        Wird er irgendwo verkauft, wird er auf der anderen Plattform sofort beendet bzw. gelöscht.
      </div>

      <details open={!st?.configured}>
        <summary><strong>1. eBay-Entwickler-Zugang</strong> {st?.configured ? "✓" : ""}</summary>
        <ol className="small" style={{ paddingLeft: 18 }}>
          <li>Auf <a href="https://developer.ebay.com" target="_blank" rel="noreferrer">developer.ebay.com</a> mit deinem eBay-Konto registrieren (kostenlos).</li>
          <li>Unter „Application Keys“ ein <b>Production</b>-Keyset anlegen: <b>App ID</b> und <b>Cert ID</b> hier eintragen.</li>
          <li>Unter „User Tokens“ → „Get a Token from eBay via Your Application“ eine <b>RuName</b> anlegen und hier eintragen.
            Als „Auth accepted URL“ <code>{typeof window !== "undefined" ? window.location.origin : ""}/api/ebay/callback</code> eintragen –
            akzeptiert eBay die nicht, einfach eine beliebige https-Adresse nehmen und unten den Code einfügen.</li>
        </ol>
        <div className="form-grid">
          <label className="field">App ID (Client ID)<input value={keys.clientId} onChange={(e) => setKeys({ ...keys, clientId: e.target.value })} /></label>
          <label className="field">Cert ID (Client Secret) <input type="password" value={keys.clientSecret} placeholder={st?.hasSecret ? "gespeichert – leer lassen zum Behalten" : ""} onChange={(e) => setKeys({ ...keys, clientSecret: e.target.value })} /></label>
          <label className="field">RuName<input value={keys.ruName} onChange={(e) => setKeys({ ...keys, ruName: e.target.value })} /></label>
          <label className="row"><input type="checkbox" checked={keys.sandbox} onChange={(e) => setKeys({ ...keys, sandbox: e.target.checked })} /> Sandbox (nur zum Testen)</label>
        </div>
        <div className="row"><div className="spacer" /><button className="btn" onClick={() => run(() => api("/ebay/config", { method: "PUT", json: keys }), "eBay-Zugang gespeichert")}>Speichern</button></div>
      </details>

      {st?.configured && (
        <details open={!st.connected}>
          <summary><strong>2. Mit deinem eBay-Konto verbinden</strong> {st.connected ? "✓ verbunden" : ""}</summary>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn primary" onClick={() => api<{ url: string }>("/ebay/connect").then((r) => window.open(r.url, "_blank")).catch((e) => toast({ kind: "error", text: e.message }))}>Bei eBay anmelden</button>
            {st.connected && <button className="btn small" onClick={() => run(() => api("/ebay/disconnect", { method: "POST" }), "eBay getrennt")}>Trennen</button>}
          </div>
          <div className="small muted">Leitet eBay nicht zurück? Die komplette Adresse aus der Adresszeile nach der Anmeldung hier einfügen:</div>
          <div className="row">
            <input style={{ flex: 1 }} value={code} placeholder="https://…?code=v%5E1.1…" onChange={(e) => setCode(e.target.value)} />
            <button className="btn" disabled={!code} onClick={() => run(() => api("/ebay/code", { method: "POST", json: { code } }).then(() => setCode("")), "Mit eBay verbunden ✓")}>Übernehmen</button>
          </div>
        </details>
      )}

      {st?.connected && (
        <details open={!st.fulfillmentPolicyId}>
          <summary><strong>3. Versand, Zahlung, Rückgabe</strong> {st.fulfillmentPolicyId ? "✓" : ""}</summary>
          <div className="small muted">Die Richtlinien legst du einmal bei eBay an (Mein eBay → Konto → Rahmenbedingungen für Angebote), dann hier auswählen.</div>
          <div className="form-grid">
            <label className="field">Postleitzahl (Versandort)<input value={form.postalCode} maxLength={5} onChange={(e) => setForm({ ...form, postalCode: e.target.value })} /></label>
            {(["fulfillment", "payment", "return"] as const).map((k) => {
              const key = `${k}PolicyId` as "fulfillmentPolicyId" | "paymentPolicyId" | "returnPolicyId";
              return (
                <label key={k} className="field">{{ fulfillment: "Versand", payment: "Zahlung", return: "Rückgabe" }[k]}
                  <select value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })}>
                    <option value="">– auswählen –</option>
                    {policies?.[k].map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </label>
              );
            })}
            <label className="field">eBay-Preis in % vom Vinted-Preis<input type="number" min={50} max={200} value={form.pricePercent} onChange={(e) => setForm({ ...form, pricePercent: Number(e.target.value) || 100 })} /></label>
            <label className="row"><input type="checkbox" checked={form.autoList} onChange={(e) => setForm({ ...form, autoList: e.target.checked })} /> Automatisch einstellen, sobald ein Artikel auf Vinted online ist</label>
          </div>
          <div className="row"><div className="spacer" />
            <button className="btn primary" onClick={() => run(() => api("/ebay/settings", { method: "PUT", json: { ...form, postalCode: form.postalCode || undefined } }), "eBay-Einstellungen gespeichert")}>Speichern</button>
          </div>
        </details>
      )}
    </div>
  );
}
