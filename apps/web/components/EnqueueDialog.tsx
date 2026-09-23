"use client";
import { useState } from "react";
import { api } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import type { Account } from "@/lib/types";
import { useToast } from "./Toasts";
import { ErrorBox, Modal } from "./ui";

function localInputValue(d: Date) {
  const off = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}

/** Schedules items for publication (new listing or reupload). */
export function EnqueueDialog({ itemIds, reuploadItemId, onClose, onDone }: {
  itemIds: number[]; reuploadItemId?: number; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const accounts = useApi<Account[]>("/accounts");
  const info = useApi<{ publishIntervalMinutes: number }>("/info");
  const [accountId, setAccountId] = useState<string>("");
  const [start, setStart] = useState(localInputValue(new Date()));
  const [interval, setInterval] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const usable = accounts.data?.filter((a) => a.has_session) ?? [];

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const startAt = new Date(start).toISOString();
      if (reuploadItemId) {
        await api(`/archive/${reuploadItemId}/reupload`, { method: "POST", json: { accountId: Number(accountId), scheduledAt: startAt } });
      } else {
        await api("/listings/queue", {
          method: "POST",
          json: { itemIds, accountId: Number(accountId), startAt, ...(interval ? { intervalMinutes: Number(interval) } : {}) },
        });
      }
      toast({ kind: "info", text: `${itemIds.length} Artikel eingeplant` });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={reuploadItemId ? "Erneut einstellen" : `${itemIds.length} Artikel einplanen`} onClose={onClose}>
      <div className="stack">
        <ErrorBox error={error} />
        <label className="field">Account
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">Bitte wählen…</option>
            {usable.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.domain})</option>)}
          </select>
        </label>
        <div className="form-grid">
          <label className="field">Frühester Start<input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></label>
          {!reuploadItemId && itemIds.length > 1 && (
            <label className="field">Abstand (Minuten)<input type="number" min={5} value={interval} onChange={(e) => setInterval(e.target.value)} placeholder={`Standard (${info.data?.publishIntervalMinutes ?? 30})`} /></label>
          )}
        </div>
        <div className="small muted">
          Artikel werden nacheinander im eingestellten Abstand veröffentlicht, nach bereits geplanten Einträgen dieses Accounts.
          {reuploadItemId && " Es werden die gespeicherten Fotos und die aktuellen Texte aus dem Archiv verwendet – vorher im Archiv anpassen."}
        </div>
        <div className="row"><div className="spacer" /><button className="btn" onClick={onClose}>Abbrechen</button>
          <button className="btn primary" disabled={!accountId || busy} onClick={submit}>Einplanen</button></div>
      </div>
    </Modal>
  );
}
