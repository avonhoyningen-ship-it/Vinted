"use client";
import { useState } from "react";
import { api, API_URL, CONDITIONS, centsToInput } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import type { Account, Item } from "@/lib/types";
import { useToast } from "./Toasts";
import { AssistStartDialog } from "./AssistStartDialog";
import { ErrorBox, Modal } from "./ui";

/** Copies text; falls back to a hidden textarea where the Clipboard API is unavailable (http in LAN). */
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

/**
 * Manual posting assistant: everything needed to create the listing on
 * Vinted by hand (copy texts, download photos, open the sell page), then
 * link the new Vinted listing back to the archive.
 */
export function VintedPostHelper({ item, photoCount, onClose, onDone }: { item: Item; photoCount: number; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const accounts = useApi<Account[]>("/accounts");
  const [accountId, setAccountId] = useState("");
  const [url, setUrl] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assist, setAssist] = useState(false);
  const account = accounts.data?.find((a) => String(a.id) === accountId) ?? accounts.data?.[0];
  const domain = account?.domain ?? "vinted.de";
  const price = item.price_confirmed && item.price_cents ? item.price_cents : item.price_suggested_cents;

  const doCopy = async (label: string, text: string) => {
    await copy(text);
    setCopied(label);
    setTimeout(() => setCopied((c) => (c === label ? null : c)), 1500);
  };

  async function link() {
    setError(null);
    try {
      await api(`/archive/${item.id}/listings`, { method: "POST", json: { accountId: Number(accountId || account?.id), url, priceCents: price ?? undefined } });
      toast({ kind: "info", text: "Vinted-Listing verknüpft – Verkäufe werden jetzt erkannt" });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const row = (label: string, value: string | null | undefined, copyable = true) => value ? (
    <div className="row" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
      <div style={{ width: 110, flexShrink: 0 }} className="small muted">{label}</div>
      <div style={{ flex: 1, minWidth: 0, whiteSpace: "pre-wrap", maxHeight: label === "Beschreibung" ? 160 : undefined, overflowY: "auto" }}>{value}</div>
      {copyable && <button className="btn small" style={{ flexShrink: 0 }} onClick={() => doCopy(label, value)}>{copied === label ? "✓ kopiert" : "Kopieren"}</button>}
    </div>
  ) : null;

  if (assist) return <AssistStartDialog itemIds={[item.id]} onClose={() => setAssist(false)} onStarted={onClose} />;

  return (
    <Modal title="Bei Vinted einstellen" onClose={onClose}>
      <div className="stack">
        <div className="card row" style={{ padding: 12, background: "var(--surface-2)" }}>
          <span style={{ flex: 1 }}><strong>Automatisch:</strong> Das Dashboard füllt das Formular in deinem Vinted-Chrome aus – du klickst nur noch „Hochladen“.</span>
          <button className="btn primary" onClick={() => setAssist(true)}>🤖 Im Vinted-Chrome ausfüllen</button>
        </div>
        <div className="small muted">Oder von Hand:</div>

        <strong>1. Fotos &amp; Vinted öffnen</strong>
        <div className="row">
          <a className="btn" href={`${API_URL}/api/archive/${item.id}/photos.zip`} download>📦 {photoCount} Fotos herunterladen (ZIP)</a>
          <a className="btn primary" href={`https://www.${domain}/items/new`} target="_blank" rel="noreferrer">Vinted „Artikel verkaufen“ öffnen ↗</a>
        </div>
        <div className="small muted">ZIP entpacken und die Fotos in der Reihenfolge 01, 02, … bei Vinted hochladen.</div>

        <strong>2. Texte kopieren &amp; einfügen</strong>
        <div className="stack" style={{ gap: 10 }}>
          {row("Titel", item.title)}
          {row("Beschreibung", item.description)}
          {row("Preis", price ? centsToInput(price) : null)}
          {!item.price_confirmed && price && <div className="small" style={{ color: "var(--warn)" }}>Preis ist noch ein Vorschlag – nach dem Einstellen wird er als bestätigt gelernt.</div>}
          {row("Marke", item.brand, false)}
          {row("Größe", item.size, false)}
          {row("Zustand", item.condition ? CONDITIONS[item.condition] ?? item.condition : null, false)}
          {row("Kategorie", item.category, false)}
        </div>

        <strong>3. Nach dem Hochladen: Vinted-Link einfügen</strong>
        <ErrorBox error={error} />
        <div className="form-grid">
          <label className="field">Account
            <select value={accountId || String(account?.id ?? "")} onChange={(e) => setAccountId(e.target.value)}>
              {accounts.data?.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.domain})</option>)}
            </select>
          </label>
          <label className="field">Link zum neuen Vinted-Artikel
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={`https://www.${domain}/items/…`} />
          </label>
        </div>
        <div className="row">
          <div className="spacer" />
          <button className="btn" onClick={onClose}>Später</button>
          <button className="btn primary" disabled={!/\/items\/\d+/.test(url) || !account} onClick={link}>Verknüpfen</button>
        </div>
      </div>
    </Modal>
  );
}
