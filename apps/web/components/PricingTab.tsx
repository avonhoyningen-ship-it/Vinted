"use client";
import { useState } from "react";
import { api, dateTime, euro, parseEuro } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import type { PriceExample, PriceRule } from "@/lib/types";
import { useToast } from "./Toasts";
import { Empty } from "./ui";

const SOURCE: Record<PriceExample["source"], string> = { confirmed: "✓ bestätigt", bulk: "Mehrfachauswahl", manual: "selbst gesetzt", sold: "💰 verkauft" };

/** Pricing rules ("tell the tool the prices") and what it has learned so far. */
export function PricingTab() {
  const toast = useToast();
  const rules = useApi<PriceRule[]>("/pricing/rules");
  const examples = useApi<PriceExample[]>("/pricing/examples");
  const [form, setForm] = useState({ brand: "", category: "", keyword: "", price: "" });
  const [filter, setFilter] = useState("");

  async function addRule() {
    try {
      await api("/pricing/rules", {
        method: "POST",
        json: { brand: form.brand || null, category: form.category || null, keyword: form.keyword || null, price_cents: parseEuro(form.price) ?? 0 },
      });
      setForm({ brand: "", category: "", keyword: "", price: "" });
      void rules.reload();
      toast({ kind: "info", text: "Regel gespeichert – offene Preisvorschläge wurden aktualisiert" });
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    }
  }

  const shown = (examples.data ?? []).filter((e) => !filter || `${e.title} ${e.brand ?? ""} ${e.category ?? ""}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="stack">
      <div className="alert info small">
        So lernt das Tool deine Preise: Jeder Preis, den du per ✓ bestätigst, selbst einträgst oder für mehrere Artikel gleichzeitig setzt, wird gespeichert –
        verkaufte Artikel zählen am stärksten. Neue Artikel bekommen den Preis ähnlicher Artikel (Marke, Kategorie, Wörter im Titel) vorgeschlagen.
        Regeln haben immer Vorrang.
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>Preisregeln</h2>
        <div className="small muted">Sag dem Tool feste Preise, z. B. „Marke Hysteric Glamour → 60 €“ oder „Stichwort Bandshirt → 30 €“. Die genaueste passende Regel gewinnt.</div>
        <div className="form-grid" style={{ alignItems: "end" }}>
          <label className="field">Marke<input value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} placeholder="z. B. Hysteric Glamour" /></label>
          <label className="field">Kategorie enthält<input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="z. B. T-Shirts" /></label>
          <label className="field">Stichwort im Titel<input value={form.keyword} onChange={(e) => setForm({ ...form, keyword: e.target.value })} placeholder="z. B. Bandshirt" /></label>
          <label className="field">Preis (€)<input inputMode="decimal" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="z. B. 35" /></label>
          <button className="btn primary" disabled={!parseEuro(form.price) || !(form.brand || form.category || form.keyword)} onClick={addRule}>+ Regel</button>
        </div>
        {rules.data && !rules.data.length && <Empty>Noch keine Regeln.</Empty>}
        <ul className="timeline">
          {rules.data?.map((r) => (
            <li key={r.id}>
              <span style={{ flex: 1 }}>
                {[r.brand && <>Marke <strong>{r.brand}</strong></>, r.category && <>Kategorie <strong>{r.category}</strong></>, r.keyword && <>Stichwort <strong>{r.keyword}</strong></>]
                  .filter(Boolean).map((x, i) => <span key={i}>{i > 0 && " + "}{x}</span>)}
              </span>
              <strong className="mono">{euro(r.price_cents)}</strong>
              <button className="btn small danger" onClick={() => api(`/pricing/rules/${r.id}`, { method: "DELETE" }).then(() => rules.reload())} aria-label="Regel löschen">✕</button>
            </li>
          ))}
        </ul>
      </div>

      <div className="card stack">
        <div className="row">
          <h2 style={{ margin: 0 }}>Gelernte Preise ({examples.data?.length ?? 0})</h2>
          <div className="spacer" />
          <input style={{ width: 220 }} placeholder="Suchen…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        {examples.data && !examples.data.length && <Empty>Noch nichts gelernt. Setz bei Entwürfen einen Preis oder bestätige einen Vorschlag mit ✓.</Empty>}
        {!!shown.length && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Artikel</th><th>Marke</th><th>Kategorie</th><th>Quelle</th><th className="num">Preis</th><th></th></tr></thead>
              <tbody>
                {shown.map((e) => (
                  <tr key={e.id}>
                    <td>{e.title}<div className="small muted">{dateTime(e.created_at)}</div></td>
                    <td>{e.brand ?? "–"}</td>
                    <td className="small">{e.category ?? "–"}</td>
                    <td className="small">{SOURCE[e.source]}</td>
                    <td className="num">{euro(e.price_cents)}</td>
                    <td><button className="btn small ghost" title="Diesen Preis vergessen" onClick={() => api(`/pricing/examples/${e.id}`, { method: "DELETE" }).then(() => examples.reload())}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
