"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { AssistStartDialog } from "@/components/AssistStartDialog";
import { Empty, ErrorBox, PageHead, StatusBadge } from "@/components/ui";
import { euro, ITEM_STATUS, photoUrl } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import type { Account, Item } from "@/lib/types";

interface Result { total: number; page: number; pageSize: number; items: Item[] }
interface Facets { categories: { v: string; n: number }[]; brands: { v: string; n: number }[] }

export default function ArchivePage() {
  const [q, setQ] = useState("");
  const [accountId, setAccountId] = useState("");
  const [status, setStatus] = useState("");
  const [category, setCategory] = useState("");
  const [brand, setBrand] = useState("");
  const [sort, setSort] = useState("updated");
  const [page, setPage] = useState(1);
  const accounts = useApi<Account[]>("/accounts");
  const facets = useApi<Facets>("/archive/facets");

  const path = useMemo(() => {
    const p = new URLSearchParams({ sort, page: String(page), pageSize: "48" });
    if (q) p.set("q", q);
    if (accountId) p.set("accountId", accountId);
    if (status) p.set("status", status);
    if (category) p.set("category", category);
    if (brand) p.set("brand", brand);
    return `/archive?${p}`;
  }, [q, accountId, status, category, brand, sort, page]);
  const { data, error, reload } = useApi<Result>(path);
  // Upload again (articles that are not online right now).
  const [selected, setSelected] = useState<number[]>([]);
  const [assist, setAssist] = useState(false);
  const toggle = (id: number) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const canUpload = (i: Item) => i.status !== "active" && i.status !== "relisted" && i.status !== "queued";
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const reset = <T,>(fn: (v: T) => void) => (v: T) => { fn(v); setPage(1); };

  return (
    <>
      <PageHead title="Archiv" sub="Alles, was schon mal auf Vinted war – jeder Artikel nur einmal. Entwürfe findest du unter Listings.">
        <Link className="btn primary" href="/listings">+ Neuer Artikel</Link>
      </PageHead>
      <div className="card form-grid" style={{ marginBottom: 16 }}>
        <label className="field">Suche<input value={q} onChange={(e) => reset(setQ)(e.target.value)} placeholder="Titel, Beschreibung, Marke" /></label>
        <label className="field">Account
          <select value={accountId} onChange={(e) => reset(setAccountId)(e.target.value)}>
            <option value="">Alle</option>
            {accounts.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label className="field">Status
          <select value={status} onChange={(e) => reset(setStatus)(e.target.value)}>
            <option value="">Alle</option>
            {Object.entries(ITEM_STATUS).filter(([k]) => k !== "draft" && k !== "queued").map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="field">Kategorie
          <select value={category} onChange={(e) => reset(setCategory)(e.target.value)}>
            <option value="">Alle</option>
            {facets.data?.categories.map((c) => <option key={c.v} value={c.v}>{c.v} ({c.n})</option>)}
          </select>
        </label>
        <label className="field">Marke
          <select value={brand} onChange={(e) => reset(setBrand)(e.target.value)}>
            <option value="">Alle</option>
            {facets.data?.brands.map((c) => <option key={c.v} value={c.v}>{c.v} ({c.n})</option>)}
          </select>
        </label>
        <label className="field">Sortierung
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="updated">Zuletzt geändert</option>
            <option value="created">Neueste</option>
            <option value="price">Preis</option>
            <option value="title">Titel</option>
          </select>
        </label>
      </div>
      <ErrorBox error={error} />
      {data && (
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="muted small">{data.total} Artikel{selected.length ? ` · ${selected.length} ausgewählt` : ""}</span>
          <div className="spacer" />
          {!!selected.length && <button className="btn small" onClick={() => setSelected([])}>Auswahl aufheben</button>}
          <button className="btn primary small" disabled={!selected.length} onClick={() => setAssist(true)}>🤖 Bei Vinted vorbereiten ({selected.length})</button>
        </div>
      )}
      {data && !data.items.length && <div className="card"><Empty>Keine Artikel gefunden.</Empty></div>}
      <div className="item-grid">
        {data?.items.map((i) => (
          <Link key={i.id} href={`/archive/${i.id}`} className="item-card" style={{ position: "relative" }}>
            {canUpload(i) && (
              <label title="Zum erneuten Hochladen auswählen" onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggle(i.id); }}
                style={{ position: "absolute", top: 8, left: 8, zIndex: 2, background: "var(--surface)", borderRadius: 6, padding: "2px 4px" }}>
                <input type="checkbox" readOnly checked={selected.includes(i.id)} aria-label="auswählen" />
              </label>
            )}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {i.cover_photo ? <img className="img" src={photoUrl(i.cover_photo)!} alt="" loading="lazy" /> : <div className="img" />}
            <div className="body">
              <div className="title" title={i.title}>{i.title}</div>
              <div className="row"><strong className="mono">{euro(i.price_cents, i.currency)}</strong><div className="spacer" /><StatusBadge status={i.status} /></div>
              <div className="small muted">{[i.brand, i.size].filter(Boolean).join(" · ") || " "}</div>
              <div className="small muted">{i.times_listed ? `${i.times_listed}× eingestellt · ${i.last_account}` : "nie eingestellt"}</div>
            </div>
          </Link>
        ))}
      </div>
      {assist && <AssistStartDialog itemIds={selected} onClose={() => setAssist(false)} onStarted={() => { setAssist(false); setSelected([]); void reload(); }} />}
      {pages > 1 && (
        <div className="row" style={{ marginTop: 16, justifyContent: "center" }}>
          <button className="btn small" disabled={page <= 1} onClick={() => setPage(page - 1)}>← Zurück</button>
          <span className="muted">Seite {page} / {pages}</span>
          <button className="btn small" disabled={page >= pages} onClick={() => setPage(page + 1)}>Weiter →</button>
        </div>
      )}
    </>
  );
}
