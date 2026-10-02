"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { RepriceDialog } from "@/components/RepriceDialog";
import { Empty, ErrorBox, Modal, PageHead, Thumb } from "@/components/ui";
import { api, euro, photoUrl } from "@/lib/api";
import { useApi } from "@/lib/useApi";

interface Issue { code: string; severity: "high" | "medium" | "low" | "info"; text: string; tip: string }
interface Row {
  listingId: number; itemId: number; accountName: string; url: string | null; title: string; priceCents: number | null;
  views: number; favourites: number; photoCount: number; coverPhoto: string | null; marketCents: number | null; hasVintedId: boolean;
  score: number; daysOnline: number; viewsPerDay: number; favouriteRate: number; issues: Issue[];
}
interface Analysis { listings: Row[]; issueCounts: Record<string, number>; insights: { kind: "good" | "bad" | "info"; text: string }[] }
interface AiReview {
  summary: string; reasons: string[]; improvements: { area: string; tip: string }[]; better_title: string | null; suggested_price_eur: number | null;
}

const ISSUE_LABEL: Record<string, string> = {
  low_views: "Wenig Aufrufe", low_interest: "Wenig Favoriten", no_conversion: "Favoriten, kein Kauf", overpriced: "Zu teuer",
  stale: "Lange online", few_photos: "Wenige Fotos", short_description: "Kurze Beschreibung", missing_info: "Angaben fehlen",
  no_measurements: "Keine Maße", brand_not_in_title: "Marke fehlt im Titel", new: "Neu",
};
const SEV_CLASS: Record<Issue["severity"], string> = { high: "bad", medium: "warn", low: "", info: "accent" };
const scoreClass = (s: number) => (s >= 80 ? "good" : s >= 50 ? "warn" : "bad");
const num = (x: number, d = 1) => x.toFixed(d).replace(".", ",");

export default function AnalysePage() {
  const { data, error, reload } = useApi<Analysis>("/analysis");
  const [filter, setFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [reprice, setReprice] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [ai, setAi] = useState<{ row: Row; review: AiReview | null; error: string | null } | null>(null);

  useEffect(() => {
    const r = () => void reload();
    window.addEventListener("dashboard-refresh", r);
    return () => window.removeEventListener("dashboard-refresh", r);
  }, [reload]);

  const rows = useMemo(() => (data?.listings ?? []).filter((r) => !filter || r.issues.some((i) => i.code === filter)), [data, filter]);
  const toggle = (id: number) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  async function runAi(row: Row) {
    setAi({ row, review: null, error: null });
    try {
      setAi({ row, review: await api<AiReview>(`/analysis/${row.listingId}/ai`, { method: "POST" }), error: null });
    } catch (e) {
      setAi({ row, review: null, error: (e as Error).message });
    }
  }

  return (
    <>
      <PageHead title="Analyse" sub="Warum verkaufen sich deine Artikel nicht – und was hilft">
        <button className="btn primary" onClick={() => setReprice(true)}>💸 Preis senken{selected.length ? ` (${selected.length})` : "…"}</button>
      </PageHead>
      <ErrorBox error={error} />

      {data && (
        <div className="grid grid-2" style={{ marginBottom: 16 }}>
          <div className="card stack" style={{ gap: 8 }}>
            <h2 style={{ margin: 0 }}>Erkenntnisse</h2>
            {data.insights.map((i, n) => (
              <div key={n} className="row small" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
                <span aria-hidden>{i.kind === "good" ? "🟢" : i.kind === "bad" ? "🔴" : "ℹ️"}</span><span>{i.text}</span>
              </div>
            ))}
          </div>
          <div className="card stack" style={{ gap: 8 }}>
            <h2 style={{ margin: 0 }}>Häufigste Probleme</h2>
            <div className="row" style={{ gap: 6 }}>
              <button className={`btn small ${!filter ? "primary" : ""}`} onClick={() => setFilter(null)}>Alle ({data.listings.length})</button>
              {Object.entries(data.issueCounts).filter(([c]) => c !== "new").sort((a, b) => b[1] - a[1]).map(([code, n]) => (
                <button key={code} className={`btn small ${filter === code ? "primary" : ""}`} onClick={() => setFilter(filter === code ? null : code)}>
                  {ISSUE_LABEL[code] ?? code} ({n})
                </button>
              ))}
            </div>
            <div className="small muted">Grundlage: Aufrufe und Favoriten von Vinted (beim letzten Abgleich), dein Preis im Vergleich zu deinen ähnlichen Artikeln und die Vollständigkeit des Inserats.</div>
          </div>
        </div>
      )}

      {data && !data.listings.length && <div className="card"><Empty>Keine aktiven Listings – sobald Artikel bei Vinted online sind (und abgeglichen wurden), erscheinen sie hier.</Empty></div>}
      {!!rows.length && (
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="muted small">{selected.length} ausgewählt</span>
          <button className="btn small" onClick={() => setSelected(selected.length === rows.length ? [] : rows.map((r) => r.listingId))}>Alle</button>
        </div>
      )}
      <div className="stack">
        {rows.map((r) => (
          <div key={r.listingId} className="card" style={{ padding: 12 }}>
            <div className="row" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
              <input type="checkbox" checked={selected.includes(r.listingId)} onChange={() => toggle(r.listingId)} aria-label="auswählen" style={{ marginTop: 4 }} />
              <div style={{ width: 56, flexShrink: 0 }}><Thumb src={photoUrl(r.coverPhoto)} /></div>
              <div className="stack" style={{ gap: 4, flex: 1, minWidth: 0 }}>
                <div className="row" style={{ flexWrap: "nowrap" }}>
                  <Link href={`/archive/${r.itemId}`} style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</Link>
                  <div className="spacer" />
                  <span className={`badge ${scoreClass(r.score)}`} title="Gesundheitswert 0–100">{r.score}</span>
                </div>
                <div className="small muted">
                  {r.accountName} · {euro(r.priceCents)}{r.marketCents ? ` (üblich ${euro(r.marketCents)})` : ""} · {r.views} Aufrufe ({num(r.viewsPerDay)}/Tag) ·
                  {" "}{r.favourites} ❤️ ({num(r.favouriteRate * 100, 0)} %) · {Math.floor(r.daysOnline)} Tage online · {r.photoCount} Fotos
                </div>
                <div className="row" style={{ gap: 4 }}>
                  {r.issues.map((i) => <span key={i.code} className={`badge ${SEV_CLASS[i.severity]}`}>{ISSUE_LABEL[i.code] ?? i.code}</span>)}
                  {!r.issues.length && <span className="badge good">Alles im grünen Bereich</span>}
                </div>
                {open === r.listingId && (
                  <ul className="small" style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                    {r.issues.map((i) => <li key={i.code}><strong>{i.text}.</strong> {i.tip}</li>)}
                  </ul>
                )}
                <div className="row" style={{ gap: 6 }}>
                  {!!r.issues.length && <button className="btn small ghost" onClick={() => setOpen(open === r.listingId ? null : r.listingId)}>{open === r.listingId ? "Weniger" : "Gründe & Tipps"}</button>}
                  <button className="btn small" onClick={() => runAi(r)}>✨ KI-Analyse</button>
                  {r.url && <a className="btn small ghost" href={r.url} target="_blank" rel="noreferrer">Vinted ↗</a>}
                  {!r.hasVintedId && <span className="small muted">kein Vinted-Link – Preis kann nicht automatisch gesenkt werden</span>}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {reprice && <RepriceDialog selectedIds={selected} onClose={() => setReprice(false)} onStarted={() => { setReprice(false); setSelected([]); }} />}
      {ai && (
        <Modal title={`✨ KI-Analyse: ${ai.row.title}`} onClose={() => setAi(null)}>
          <div className="stack">
            <ErrorBox error={ai.error} />
            {!ai.review && !ai.error && <div className="muted">Die KI sieht sich Fotos, Texte und Zahlen an… (ca. 20–40 Sekunden)</div>}
            {ai.review && (
              <>
                <p style={{ margin: 0 }}>{ai.review.summary}</p>
                <div><strong>Gründe</strong><ol style={{ margin: "4px 0 0", paddingLeft: 18 }}>{ai.review.reasons.map((x, i) => <li key={i}>{x}</li>)}</ol></div>
                <div><strong>Das solltest du ändern</strong><ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{ai.review.improvements.map((x, i) => <li key={i}><strong>{x.area}:</strong> {x.tip}</li>)}</ul></div>
                {ai.review.better_title && <div className="alert info small"><strong>Titel-Vorschlag:</strong> {ai.review.better_title}</div>}
                {ai.review.suggested_price_eur !== null && (
                  <div className="alert small"><strong>Preis-Vorschlag:</strong> {euro(Math.round(ai.review.suggested_price_eur * 100))} (jetzt {euro(ai.row.priceCents)})</div>
                )}
              </>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
