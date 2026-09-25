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
}

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

  return (
    <div className={`alert ${s.state === "error" ? "bad" : active ? "info" : "good"}`} style={{ marginBottom: 16 }}>
      <div className="row">
        <strong>🤖 Einstell-Assistent</strong>
        {active && <span>Artikel {s.position} von {s.total}: {s.itemId ? <Link href={`/archive/${s.itemId}`}>{s.title}</Link> : s.title}</span>}
        <div className="spacer" />
        {active && <button className="btn small" onClick={() => api("/assist/skip", { method: "POST" })}>Überspringen</button>}
        {active && <button className="btn small danger" onClick={() => api("/assist/stop", { method: "POST" })}>Stoppen</button>}
        {!active && <button className="btn small ghost" onClick={() => setDismissed(true)} aria-label="Schließen">✕</button>}
      </div>
      {s.message && <div style={{ marginTop: 4 }}>{s.message}</div>}
      {s.state === "waiting" && (
        <div className="small" style={{ marginTop: 4 }}>
          Ausgefüllt: {s.filled.join(", ") || "–"}{s.missing.length > 0 && <> · Bitte selbst: {s.missing.join(", ")}</>}
        </div>
      )}
      {!!s.fields?.length && (
        <details className="small" style={{ marginTop: 6 }}>
          <summary>Technische Details (bitte als Screenshot schicken, falls Felder nicht ausgefüllt wurden)</summary>
          <pre style={{ whiteSpace: "pre-wrap", margin: "6px 0 0", fontSize: 11 }}>{s.fields.join("\n")}</pre>
        </details>
      )}
      {!!s.done.length && <div className="small" style={{ marginTop: 4 }}>✓ Eingestellt: {s.done.map((d) => d.title).join(", ")}</div>}
    </div>
  );
}
