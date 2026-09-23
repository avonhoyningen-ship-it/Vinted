"use client";
import type { ReactNode } from "react";
import { ACCOUNT_STATUS, ITEM_STATUS, LISTING_STATUS } from "@/lib/api";

export function PageHead({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <div className="muted">{sub}</div>}
      </div>
      <div className="row">{children}</div>
    </div>
  );
}

export function Tile({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="card tile">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

const TONES: Record<string, string> = {
  connected: "good", active: "good", done: "good", relisted: "accent", sold: "accent",
  pending: "warn", queued: "warn", processing: "warn", draft: "", archived: "",
  error: "bad", failed: "bad", disconnected: "", cancelled: "", skipped: "", removed: "", expired: "", hidden: "",
};
const LABELS: Record<string, string> = {
  ...LISTING_STATUS, ...ACCOUNT_STATUS, ...ITEM_STATUS,
  processing: "Läuft", done: "Erledigt", failed: "Fehlgeschlagen", cancelled: "Storniert", skipped: "Übersprungen",
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <span className={`badge ${TONES[status] ?? ""}`}>{label ?? LABELS[status] ?? status}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="alert bad">{error}</div>;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="row" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <div className="spacer" />
          <button className="btn ghost" onClick={onClose} aria-label="Schließen">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Thumb({ src, alt = "" }: { src: string | null; alt?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return src ? <img className="thumb" src={src} alt={alt} loading="lazy" /> : <div className="thumb" />;
}
