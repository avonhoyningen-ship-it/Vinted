"use client";
import { useState } from "react";
import { useToast } from "@/components/Toasts";
import { ErrorBox } from "@/components/ui";
import { api } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import type { Account } from "@/lib/types";

export function AccountForm({ initial, onSaved, onCancel }: { initial?: Account; onSaved: () => void; onCancel: () => void }) {
  const toast = useToast();
  const { data: domains } = useApi<string[]>("/accounts/domains");
  const [name, setName] = useState(initial?.name ?? "");
  const [domain, setDomain] = useState(initial?.domain ?? "vinted.de");
  const [token, setToken] = useState("");
  const [refresh, setRefresh] = useState("");
  // After a failed first connect the account exists already – further saves update it.
  const [created, setCreated] = useState<Account | null>(null);
  const existing = initial ?? created;
  const [interval, setInterval] = useState(initial?.publish_interval_minutes?.toString() ?? "");
  const [polling, setPolling] = useState(initial?.polling_enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body = {
        name, domain, pollingEnabled: polling,
        publishIntervalMinutes: interval ? Number(interval) : null,
        ...(token ? { sessionToken: token.trim() } : {}),
        ...(refresh ? { refreshToken: refresh.trim() } : {}),
      };
      const res = existing
        ? await api<{ error: string | null; account: Account }>(`/accounts/${existing.id}`, { method: "PATCH", json: body })
        : await api<{ error: string | null; account: Account }>("/accounts", { method: "POST", json: body });
      if (res.error) {
        if (!initial) setCreated(res.account);
        // Keep the dialog open so the token can be corrected right away.
        setError(`Verbindung fehlgeschlagen: ${res.error}`);
        return;
      }
      toast({ kind: "info", text: `Verbunden als @${res.account.username} (${res.account.followers} Follower)` });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <ErrorBox error={error} />
      <label className="field">Anzeigename<input value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. Shop DE Damen" /></label>
      <label className="field">Länder-Domain
        <select value={domain} onChange={(e) => setDomain(e.target.value)}>
          {(domains ?? ["vinted.de"]).map((d) => <option key={d}>{d}</option>)}
        </select>
      </label>
      <label className="field">access_token_web {initial?.session_hint && <span className="muted">(gespeichert: {initial.session_hint} – leer lassen zum Behalten)</span>}
        <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" placeholder="beginnt mit eyJ…" />
      </label>
      <label className="field">refresh_token_web (optional, empfohlen) {initial?.has_refresh_token && <span className="muted">(gespeichert)</span>}
        <input type="password" value={refresh} onChange={(e) => setRefresh(e.target.value)} autoComplete="off" placeholder="beginnt mit eyJ…" />
      </label>
      <div className="small muted">
        So findest du die Werte: bei <strong>{domain}</strong> im Browser einloggen → <kbd>F12</kbd> → Reiter „Anwendung“ (Chrome/Edge) bzw. „Speicher“ (Firefox)
        → Cookies → <code>https://www.{domain}</code> → Wert von <code>access_token_web</code> und <code>refresh_token_web</code> kopieren.
        Das access_token_web gilt nur ca. 24 Stunden; mit dem refresh_token_web kann das Dashboard die Verbindung erneuern.
        Es wird <strong>kein Passwort</strong> gespeichert; beide Werte liegen AES-256-verschlüsselt in der Datenbank.
      </div>
      <div className="form-grid">
        <label className="field">Abstand zwischen Veröffentlichungen (Min.)<input type="number" min={5} value={interval} onChange={(e) => setInterval(e.target.value)} placeholder="Standard" /></label>
        <label className="field">Automatisches Abrufen
          <select value={polling ? "1" : "0"} onChange={(e) => setPolling(e.target.value === "1")}><option value="1">aktiv</option><option value="0">pausiert</option></select>
        </label>
      </div>
      <div className="row">
        <div className="spacer" />
        <button className="btn" onClick={onCancel}>Abbrechen</button>
        <button className="btn primary" disabled={busy || !name || (!existing && !token)} onClick={save}>{busy ? "Verbinde mit Vinted…" : "Speichern & verbinden"}</button>
      </div>
    </div>
  );
}
