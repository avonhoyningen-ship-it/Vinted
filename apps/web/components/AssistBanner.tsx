"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export interface AssistStatus {
  state: "idle" | "preparing" | "waiting" | "error";
  itemId: number | null;
  title: string | null;
  position: number;
  total: number;
  filled: string[];
  missing: string[];
  message: string | null;
  done: { itemId: number; title: string; url: string }[];
  fields?: string[];
  tabs?: AssistTab[];
}

export interface AssistTab {
  itemId: number;
  title: string;
  state: "queued" | "preparing" | "ready" | "done" | "skipped" | "error";
  filled: string[];
  missing: string[];
  message: string | null;
  url: string | null;
  fields: string[];
}

const TAB_LABEL: Record<AssistTab["state"], string> = {
  queued: "⏳ wartet", preparing: "✍️ wird ausgefüllt", ready: "👉 bereit – bitte hochladen", done: "✓ eingestellt", skipped: "übersprungen", error: "⚠️ Fehler",
};

/** Live status of the posting assistant (fed by the SSE stream via SaleNotifier). */
export function AssistBanner() {
  const [s, setS] = useState<AssistStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    api<AssistStatus>("/assist/status").then(setS).catch(() => {});
    const on = (e: Event) => { setS((e as CustomEvent<AssistStatus>).detail); setDismissed(false); };
    window.addEventListener("assist", on);
    return () => window.removeEventListener("assist", on);
  }, []);

  if (!s || dismissed) return null;
  const active = s.state === "preparing" || s.state === "waiting";
  if (!active && s.state !== "error" && !s.done.length) return null;

  const tabs = s.tabs ?? [];
  const details = tabs.flatMap((t) => (t.fields.length ? [`— ${t.title}`, ...t.fields] : []));
  return (
    <div className={`alert ${s.state === "error" ? "bad" : active ? "info" : "good"}`} style={{ marginBottom: 16 }}>
      <div className="row">
        <strong>🤖 Einstell-Assistent</strong>
        {active && <span>{tabs.filter((t) => t.state === "done").length} von {s.total} eingestellt</span>}
        <div className="spacer" />
        {active && <button className="btn small danger" onClick={() => api("/assist/stop", { method: "POST" })}>Stoppen</button>}
        {!active && <button className="btn small ghost" onClick={() => setDismissed(true)} aria-label="Schließen">✕</button>}
      </div>
      {s.message && <div style={{ marginTop: 4 }}>{s.message}</div>}
      {tabs.length > 0 && (
        <table className="small" style={{ marginTop: 6, width: "100%" }}>
          <tbody>
            {tabs.map((t) => (
              <tr key={t.itemId}>
                <td><Link href={`/archive/${t.itemId}`}>{t.title}</Link></td>
                <td style={{ whiteSpace: "nowrap" }}>{t.url ? <a href={t.url} target="_blank" rel="noreferrer">{TAB_LABEL[t.state]}</a> : TAB_LABEL[t.state]}</td>
                <td className="muted">
                  {t.message ?? (t.state === "ready" && t.missing.length > 0 ? `Bitte selbst: ${t.missing.join(", ")}` : "")}
                </td>
                <td style={{ textAlign: "right" }}>
                  {(t.state === "ready" || t.state === "queued") && (
                    <button className="btn small ghost" onClick={() => api("/assist/skip", { method: "POST", json: { itemId: t.itemId } })}>Überspringen</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {details.length > 0 && (
        <details className="small" style={{ marginTop: 6 }}>
          <summary>Technische Details (bitte als Screenshot schicken, falls Felder nicht ausgefüllt wurden)</summary>
          <pre style={{ whiteSpace: "pre-wrap", margin: "6px 0 0", fontSize: 11 }}>{details.join("\n")}</pre>
        </details>
      )}
    </div>
  );
}
