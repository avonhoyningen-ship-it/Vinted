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
        ...(token ? { sessionToken: token } : {}),
      };
      const res = initial
        ? await api<{ error: string | null }>(`/accounts/${initial.id}`, { method: "PATCH", json: body })
        : await api<{ error: string | null }>("/accounts", { method: "POST", json: body });
      if (res.error) toast({ kind: "error", text: `Gespeichert, aber Verbindung fehlgeschlagen: ${res.error}` });
      else toast({ kind: "info", text: "Account gespeichert" });
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
      <label className="field">Session-Token {initial?.session_hint && <span className="muted">(gespeichert: {initial.session_hint} – leer lassen zum Behalten)</span>}
        <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" placeholder="Wert des Cookies access_token_web" />
      </label>
      <div className="small muted">
        Es wird <strong>kein Passwort</strong> gespeichert. Das Token wird mit AES-256-GCM verschlüsselt abgelegt und nie wieder im Klartext angezeigt.
        So findest du es: bei Vinted einloggen → Entwicklertools (F12) → Anwendung/Speicher → Cookies → <code>access_token_web</code>.
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
        <button className="btn primary" disabled={busy || !name || (!initial && !token)} onClick={save}>{busy ? "Verbinde…" : "Speichern & verbinden"}</button>
      </div>
    </div>
  );
}
