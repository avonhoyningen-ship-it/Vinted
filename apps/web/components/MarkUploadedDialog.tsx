"use client";
import { useState } from "react";
import { api } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import type { Account } from "@/lib/types";
import { ErrorBox, Modal } from "./ui";

/** Marks drafts as uploaded by hand (e.g. posted on the phone) – they move to "Hochgeladen". */
export function MarkUploadedDialog({ itemIds, onClose, onDone }: { itemIds: number[]; onClose: () => void; onDone: () => void }) {
  const accounts = useApi<Account[]>("/accounts");
  const [accountId, setAccountId] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chosen = accountId || String(accounts.data?.[0]?.id ?? "");

  async function save() {
    setBusy(true);
    setError(null);
    try {
      for (const id of itemIds) {
        await api(`/archive/${id}/listings`, {
          method: "POST",
          json: { accountId: Number(chosen), ...(itemIds.length === 1 && url.trim() ? { url: url.trim() } : {}) },
        });
      }
      window.dispatchEvent(new CustomEvent("dashboard-refresh"));
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`✓ ${itemIds.length} Artikel als hochgeladen markieren`} onClose={onClose}>
      <div className="stack">
        <ErrorBox error={error} />
        <div className="small muted">Die Artikel wandern nach „Hochgeladen“ und zählen als aktiv.</div>
        <label className="field">Account
          <select value={chosen} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.data?.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.domain})</option>)}
          </select>
        </label>
        {itemIds.length === 1 && (
          <label className="field">Vinted-Link (optional)
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.vinted.de/items/…" />
          </label>
        )}
        <div className="row"><div className="spacer" /><button className="btn" onClick={onClose}>Abbrechen</button>
          <button className="btn primary" disabled={busy || !chosen} onClick={save}>{busy ? "Speichere…" : "Als hochgeladen markieren"}</button></div>
      </div>
    </Modal>
  );
}
