"use client";
import { useEffect, useState } from "react";
import { api, euro } from "@/lib/api";

interface RepriceStatus {
  state: "idle" | "running" | "done";
  percent: number;
  total: number;
  done: number;
  message: string | null;
  items: { listingId: number; title: string; oldCents: number; newCents: number; state: string; message: string | null }[];
}

const LABEL: Record<string, string> = { queued: "⏳", running: "✍️", done: "✓", failed: "⚠️", skipped: "–" };

/** Live progress of "Preis senken" (SSE via SaleNotifier). */
export function RepriceBanner() {
  const [s, setS] = useState<RepriceStatus | null>(null);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    api<RepriceStatus>("/reprice/status").then(setS).catch(() => {});
    const on = (e: Event) => { setS((e as CustomEvent<RepriceStatus>).detail); setHidden(false); };
    window.addEventListener("reprice", on);
    return () => window.removeEventListener("reprice", on);
  }, []);
  if (!s || s.state === "idle" || hidden) return null;
  const running = s.state === "running";
  return (
    <div className={`alert ${running ? "info" : s.items.some((i) => i.state === "failed") ? "bad" : "good"}`} style={{ marginBottom: 16 }}>
      <div className="row">
        <strong>💸 Preis senken −{s.percent} %</strong>
        <span>{s.done} von {s.total}</span>
        <div className="spacer" />
        {running
          ? <button className="btn small danger" onClick={() => api("/reprice/stop", { method: "POST" })}>Stoppen</button>
          : <button className="btn small ghost" onClick={() => setHidden(true)} aria-label="Schließen">✕</button>}
      </div>
      {s.message && <div style={{ marginTop: 4 }}>{s.message}</div>}
      <table className="small" style={{ marginTop: 6, width: "100%" }}>
        <tbody>
          {s.items.map((i) => (
            <tr key={i.listingId}>
              <td style={{ width: 24 }}>{LABEL[i.state] ?? i.state}</td>
              <td>{i.title}</td>
              <td className="num" style={{ whiteSpace: "nowrap" }}>{euro(i.oldCents)} → {euro(i.newCents)}</td>
              <td className="muted">{i.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
