"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface Group { accountId: number; accountName: string; listings: { listingId: number; title: string; url: string | null; reason: string }[] }

/** Warning while an article is online more than once on the same account (checked in the background). */
export function DuplicateBanner() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const load = () => api<Group[]>("/duplicates").then(setGroups).catch(() => {});
    void load();
    window.addEventListener("duplicate", load);
    window.addEventListener("dashboard-refresh", load);
    return () => { window.removeEventListener("duplicate", load); window.removeEventListener("dashboard-refresh", load); };
  }, []);
  if (!groups.length) return null;
  return (
    <div className="alert bad stack" style={{ marginBottom: 16, gap: 6 }}>
      <div className="row">
        <strong>⛔ {groups.length === 1 ? "Ein Artikel ist" : `${groups.length} Artikel sind`} doppelt online – Vinted wertet Duplikate ab.</strong>
        <div className="spacer" />
        <button className="btn small" onClick={() => setOpen(!open)}>{open ? "Ausblenden" : "Anzeigen"}</button>
      </div>
      {open && groups.map((g) => (
        <div key={g.listings[0]!.listingId} className="small">
          <b>{g.accountName}:</b>{" "}
          {g.listings.map((l, i) => (
            <span key={l.listingId}>{i > 0 && " · "}{l.url ? <a href={l.url} target="_blank" rel="noreferrer">{l.title}</a> : l.title} ({l.reason})</span>
          ))}
          {" "}– einen davon auf Vinted löschen.
        </div>
      ))}
    </div>
  );
}
