"use client";
import { useState } from "react";
import { ErrorBox } from "@/components/ui";
import { api, relative } from "@/lib/api";
import { useApi } from "@/lib/useApi";

interface HelperInfo {
  status: { online: boolean; lastSeenAt: string | null };
  tokens: { id: number; name: string; last_seen_at: string | null; revoked_at: string | null; created_at: string }[];
}

const API_ADDRESS = process.env.NEXT_PUBLIC_DIRECT_API_URL || "(Adresse der Dashboard-API)";

/** Cloud: pairing the PC helper that talks to Vinted from the seller's own PC. */
export function HelperCard({ onChange }: { onChange?: () => void }) {
  const { data, error, reload } = useApi<HelperInfo>("/helper-tokens");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    setErr(null);
    try {
      const r = await api<{ token: string }>("/helper-tokens", { method: "POST", json: { name: "Mein PC" } });
      setNewKey(r.token);
      void reload();
      onChange?.();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function revoke(id: number) {
    if (!confirm("Schlüssel widerrufen? Der PC-Helfer mit diesem Schlüssel wird sofort getrennt.")) return;
    await api(`/helper-tokens/${id}`, { method: "DELETE" });
    void reload();
  }

  const active = data?.tokens.filter((t) => !t.revoked_at) ?? [];
  return (
    <div className="card stack">
      <div className="row">
        <h2 style={{ margin: 0 }}>PC-Helfer</h2>
        <span className={`badge ${data?.status.online ? "good" : "warn"}`}>{data?.status.online ? "verbunden" : "nicht verbunden"}</span>
        <div className="spacer" />
        <button className="btn small" onClick={() => reload()}>Aktualisieren</button>
      </div>
      <ErrorBox error={error ?? err} />
      <div className="small muted">
        Der PC-Helfer läuft auf deinem PC und spricht von dort mit Vinted: Verkäufe abrufen, Nachrichten senden, Preise senken und das
        Vinted-Formular in deinem Chrome ausfüllen. Deine Vinted-Anmeldung bleibt dabei auf deinem PC – das Dashboard speichert sie nicht.
      </div>
      <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
        <li>„Chrome fuer Vinted starten.bat“ öffnen und dort bei Vinted einloggen.</li>
        <li>„PC-Helfer starten.bat“ öffnen. Beim ersten Start fragt er nach der Adresse <code>{API_ADDRESS}</code> und einem Schlüssel:</li>
      </ol>
      {newKey ? (
        <div className="alert info stack" style={{ gap: 6 }}>
          <strong>Dein Helfer-Schlüssel (wird nur jetzt angezeigt):</strong>
          <code style={{ userSelect: "all", wordBreak: "break-all" }}>{newKey}</code>
          <div className="row">
            <button className="btn small" onClick={() => void navigator.clipboard.writeText(newKey)}>Kopieren</button>
            <button className="btn small ghost" onClick={() => setNewKey(null)}>Ausblenden</button>
          </div>
        </div>
      ) : (
        <div className="row"><button className="btn primary" onClick={create}>Neuen Schlüssel erzeugen</button></div>
      )}
      {active.length > 0 && (
        <table className="small">
          <tbody>
            {active.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td className="muted">zuletzt aktiv {relative(t.last_seen_at)}</td>
                <td style={{ textAlign: "right" }}><button className="btn small danger" onClick={() => revoke(t.id)}>Widerrufen</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
