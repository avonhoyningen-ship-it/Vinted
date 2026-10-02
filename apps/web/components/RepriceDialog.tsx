"use client";
import { useState } from "react";
import { api, euro, parseEuro } from "@/lib/api";
import { ErrorBox, Modal } from "./ui";

interface PlanRow { listingId: number; title: string; accountName: string; views: number; daysOnline: number; oldCents: number; newCents: number; skip: string | null }

/** "Preis senken": selected listings or all with few views, by X %, with a preview before anything changes. */
export function RepriceDialog({ selectedIds, onClose, onStarted }: { selectedIds: number[]; onClose: () => void; onStarted: () => void }) {
  const [mode, setMode] = useState<"selected" | "views">(selectedIds.length ? "selected" : "views");
  const [percent, setPercent] = useState("10");
  const [maxViews, setMaxViews] = useState("20");
  const [minDays, setMinDays] = useState("7");
  const [minPrice, setMinPrice] = useState("");
  const [plan, setPlan] = useState<PlanRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const body = () => ({
    percent: Number(percent.replace(",", ".")),
    ...(parseEuro(minPrice) ? { minPriceCents: parseEuro(minPrice)! } : {}),
    ...(mode === "selected" ? { listingIds: selectedIds } : { maxViews: Number(maxViews), minDays: Number(minDays || 0) }),
  });

  async function preview() {
    setBusy(true);
    setError(null);
    try {
      setPlan(await api<PlanRow[]>("/reprice/preview", { method: "POST", json: body() }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    setBusy(true);
    setError(null);
    try {
      await api("/reprice/start", { method: "POST", json: body() });
      onStarted();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const changes = plan?.filter((p) => !p.skip) ?? [];
  const reset = () => setPlan(null);
  return (
    <Modal title="💸 Preis senken" onClose={onClose}>
      <div className="stack">
        <ErrorBox error={error} />
        <div className="stack" style={{ gap: 6 }}>
          <label className="row small"><input type="radio" checked={mode === "selected"} disabled={!selectedIds.length} onChange={() => { setMode("selected"); reset(); }} />
            Ausgewählte Artikel ({selectedIds.length})</label>
          <label className="row small" style={{ flexWrap: "wrap" }}><input type="radio" checked={mode === "views"} onChange={() => { setMode("views"); reset(); }} />
            Alle aktiven Artikel mit weniger als
            <input style={{ width: 70 }} type="number" min={1} value={maxViews} onChange={(e) => { setMaxViews(e.target.value); setMode("views"); reset(); }} /> Aufrufen,
            mindestens <input style={{ width: 60 }} type="number" min={0} value={minDays} onChange={(e) => { setMinDays(e.target.value); setMode("views"); reset(); }} /> Tage online</label>
        </div>
        <div className="form-grid">
          <label className="field">Senken um (%)<input inputMode="decimal" value={percent} onChange={(e) => { setPercent(e.target.value); reset(); }} /></label>
          <label className="field">Nie unter (€, optional)<input inputMode="decimal" value={minPrice} onChange={(e) => { setMinPrice(e.target.value); reset(); }} placeholder="z. B. 10" /></label>
        </div>
        <div className="small muted">
          Das Dashboard öffnet jeden Artikel im Vinted-Chrome (dem Chrome des jeweiligen Accounts), ändert den Preis, speichert und prüft
          danach den angezeigten Preis. Vinted benachrichtigt dabei alle, die den Artikel favorisiert haben. Das Vinted-Chrome muss laufen und eingeloggt sein.
        </div>
        {plan && (
          <div className="table-wrap" style={{ maxHeight: 280, overflowY: "auto" }}>
            <table className="small">
              <thead><tr><th>Artikel</th><th className="num">Aufrufe</th><th className="num">Jetzt</th><th className="num">Neu</th><th></th></tr></thead>
              <tbody>
                {plan.map((p) => (
                  <tr key={p.listingId} style={{ opacity: p.skip ? 0.5 : 1 }}>
                    <td>{p.title}<div className="muted">{p.accountName} · {p.daysOnline} Tage</div></td>
                    <td className="num">{p.views}</td>
                    <td className="num">{euro(p.oldCents)}</td>
                    <td className="num"><strong>{p.skip ? "–" : euro(p.newCents)}</strong></td>
                    <td className="muted">{p.skip}</td>
                  </tr>
                ))}
                {!plan.length && <tr><td colSpan={5} className="muted">Keine passenden Artikel.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
        <div className="row">
          <div className="spacer" />
          <button className="btn" onClick={onClose}>Abbrechen</button>
          {!plan ? (
            <button className="btn primary" disabled={busy || (mode === "selected" && !selectedIds.length)} onClick={preview}>{busy ? "Berechne…" : "Vorschau"}</button>
          ) : (
            <button className="btn primary" disabled={busy || !changes.length} onClick={start}>{busy ? "Starte…" : `Jetzt ${changes.length} Preis${changes.length === 1 ? "" : "e"} senken`}</button>
          )}
        </div>
      </div>
    </Modal>
  );
}
