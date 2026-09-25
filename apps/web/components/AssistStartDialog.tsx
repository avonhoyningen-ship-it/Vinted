"use client";
import { useState } from "react";
import { api } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { CLOUD } from "@/lib/mode";
import type { Account } from "@/lib/types";
import { ErrorBox, Modal } from "./ui";

/** Starts the posting assistant for one or more items. */
export function AssistStartDialog({ itemIds, onClose, onStarted }: { itemIds: number[]; onClose: () => void; onStarted: () => void }) {
  const accounts = useApi<Account[]>("/accounts");
  const [accountId, setAccountId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chosen = accountId || String(accounts.data?.[0]?.id ?? "");

  async function start() {
    setBusy(true);
    setError(null);
    try {
      await api("/assist/start", { method: "POST", json: { itemIds, accountId: Number(chosen) } });
      onStarted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`🤖 ${itemIds.length} Artikel bei Vinted vorbereiten`} onClose={onClose}>
      <div className="stack">
        <ErrorBox error={error} />
        <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
          <li>Das Vinted-Chrome muss laufen („Chrome fuer Vinted starten.bat“) und du musst dort bei Vinted eingeloggt sein{CLOUD ? " – außerdem der PC-Helfer („PC-Helfer starten.bat“)" : ""}.</li>
          <li>Das Dashboard öffnet dort für jeden Artikel einen eigenen Tab „Artikel verkaufen“ und füllt Fotos, Titel, Beschreibung, Preis, Kategorie, Marke, Größe, Zustand, Farbe, Maße und Paketgröße aus – einen nach dem anderen, bitte so lange warten.</li>
          <li>Danach gehst du die Tabs durch, prüfst kurz und klickst jeweils selbst auf <strong>„Hochladen“</strong>.</li>
          <li>Jeder hochgeladene Artikel wird automatisch verknüpft, sein Tab schließt sich und der nächste kommt nach vorne. Tab schließen = überspringen.</li>
        </ol>
        <label className="field">Account
          <select value={chosen} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.data?.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.domain})</option>)}
          </select>
        </label>
        <div className="row"><div className="spacer" /><button className="btn" onClick={onClose}>Abbrechen</button>
          <button className="btn primary" disabled={busy || !chosen} onClick={start}>{busy ? "Verbinde mit Chrome…" : "Starten"}</button></div>
      </div>
    </Modal>
  );
}
