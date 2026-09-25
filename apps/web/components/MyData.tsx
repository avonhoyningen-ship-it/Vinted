"use client";
import { useState } from "react";
import { api } from "@/lib/api";

/** DSGVO self-service: download everything, delete the account. */
export function MyData() {
  const [busy, setBusy] = useState<"export" | "delete" | null>(null);
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setBusy("export");
    setError(null);
    try {
      const { getToken } = await import("@clerk/nextjs");
      const token = await getToken().catch(() => null);
      const res = await fetch("/api/me/export", { headers: token ? { authorization: `Bearer ${token}` } : {}, credentials: "include" });
      if (!res.ok) throw new Error(`Export fehlgeschlagen (HTTP ${res.status})`);
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement("a"), { href: url, download: `alex-sales-kit-daten-${new Date().toISOString().slice(0, 10)}.zip` });
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("delete");
    setError(null);
    try {
      await api("/me", { method: "DELETE", json: { confirm } });
      window.location.href = "/";
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }

  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Meine Daten</h2>
      <p className="small muted" style={{ margin: 0 }}>Alle deine Daten als ZIP-Datei (Artikel, Listings, Verkäufe, Einstellungen als JSON und alle Fotos).</p>
      <div><button className="btn" disabled={busy !== null} onClick={download}>{busy === "export" ? "Wird erstellt…" : "Alle Daten herunterladen"}</button></div>
      <hr style={{ border: 0, borderTop: "1px solid var(--border)", width: "100%" }} />
      <p className="small" style={{ margin: 0 }}>
        <strong>Konto löschen:</strong> Beendet dein Abo sofort (keine weitere Abbuchung, keine Erstattung für den laufenden Monat) und löscht
        endgültig alle Artikel, Fotos, Accounts, Einstellungen und dein Login. Das lässt sich nicht rückgängig machen.
      </p>
      <label className="field">Zum Bestätigen LÖSCHEN eingeben
        <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="LÖSCHEN" />
      </label>
      {error && <div className="alert bad">{error}</div>}
      <div><button className="btn danger" disabled={busy !== null || confirm !== "LÖSCHEN"} onClick={remove}>{busy === "delete" ? "Wird gelöscht…" : "Konto endgültig löschen"}</button></div>
    </div>
  );
}
