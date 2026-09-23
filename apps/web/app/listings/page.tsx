"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { EnqueueDialog } from "@/components/EnqueueDialog";
import { Dropzone } from "@/components/PhotoManager";
import { useToast } from "@/components/Toasts";
import { Empty, ErrorBox, PageHead, StatusBadge, Thumb } from "@/components/ui";
import { api, dateTime, euro, photoUrl } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import type { Item, Listing, QueueEntry, Template } from "@/lib/types";

const TABS = { new: "Neu erstellen", drafts: "Entwürfe", queue: "Warteschlange", active: "Aktive Listings", templates: "Vorlagen" } as const;
type Tab = keyof typeof TABS;

function ListingsInner() {
  const params = useSearchParams();
  const router = useRouter();
  const tab = (params.get("tab") as Tab) in TABS ? (params.get("tab") as Tab) : "new";
  const setTab = (t: Tab) => router.replace(`/listings?tab=${t}`);
  return (
    <>
      <PageHead title="Listings" sub="Artikel erstellen, einplanen und veröffentlichen" />
      <div className="tabs" role="tablist">
        {(Object.keys(TABS) as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>{TABS[t]}</button>
        ))}
      </div>
      {tab === "new" && <NewTab onDone={() => setTab("drafts")} />}
      {tab === "drafts" && <DraftsTab />}
      {tab === "queue" && <QueueTab />}
      {tab === "active" && <ActiveTab />}
      {tab === "templates" && <TemplatesTab />}
    </>
  );
}

export default function ListingsPage() {
  return <Suspense><ListingsInner /></Suspense>;
}

// ---------- new ----------

function NewTab({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const info = useApi<{ aiEnabled: boolean }>("/info");
  const [files, setFiles] = useState<File[]>([]);
  const [mode, setMode] = useState<"one" | "each">("one");
  const [useAi, setUseAi] = useState(true);
  const [hints, setHints] = useState("");
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const previews = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);

  async function create() {
    setError(null);
    const groups = mode === "one" ? [files] : files.map((f) => [f]);
    const ai = useAi && !!info.data?.aiEnabled;
    let done = 0;
    const aiErrors: string[] = [];
    for (const g of groups) {
      setProgress(`Erstelle Artikel ${done + 1} von ${groups.length}${ai ? " (inkl. KI)" : ""}…`);
      const fd = new FormData();
      g.forEach((f) => fd.append("photos", f));
      if (ai) fd.append("ai", "true");
      if (hints) fd.append("hints", hints);
      try {
        const r = await api<{ aiError: string | null }>("/listings/drafts", { method: "POST", body: fd });
        if (r.aiError) aiErrors.push(r.aiError);
      } catch (e) {
        setError((e as Error).message);
        break;
      }
      done++;
    }
    setProgress(null);
    if (done) {
      toast({ kind: "info", text: `${done} Entwurf/Entwürfe erstellt` });
      if (aiErrors.length) toast({ kind: "error", text: `KI-Fehler: ${aiErrors[0]}` });
      setFiles([]);
      onDone();
    }
  }

  return (
    <div className="card stack">
      <ErrorBox error={error} />
      <Dropzone onFiles={(f) => setFiles((p) => [...p, ...f])} label="Fotos auswählen oder hierher ziehen" />
      {!!files.length && (
        <div className="photo-strip">
          {files.map((f, i) => (
            <div className="photo" key={i}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={previews[i]} alt={f.name} />
              <button className="x" onClick={() => setFiles((p) => p.filter((_, j) => j !== i))} aria-label="entfernen">✕</button>
            </div>
          ))}
        </div>
      )}
      <div className="form-grid">
        <label className="field">Aufteilung
          <select value={mode} onChange={(e) => setMode(e.target.value as "one" | "each")}>
            <option value="one">Alle Fotos = ein Artikel</option>
            <option value="each">Batch: jedes Foto = eigener Artikel</option>
          </select>
        </label>
        <label className="field">KI-Unterstützung
          <select value={useAi ? "1" : "0"} onChange={(e) => setUseAi(e.target.value === "1")} disabled={!info.data?.aiEnabled}>
            <option value="1">Titel, Beschreibung, Kategorie, Preis generieren</option>
            <option value="0">Ohne KI (manuell ausfüllen)</option>
          </select>
        </label>
        <label className="field span-all">Hinweise für die KI (optional)
          <input value={hints} onChange={(e) => setHints(e.target.value)} placeholder="z. B. „Größe M, 2x getragen, Versand nur Hermes“" />
        </label>
      </div>
      {!info.data?.aiEnabled && <div className="alert small">KI ist deaktiviert – ANTHROPIC_API_KEY in .env eintragen, um Inserate automatisch generieren zu lassen.</div>}
      <div className="row">
        {progress && <span className="muted">{progress}</span>}
        <div className="spacer" />
        <button className="btn primary" disabled={!files.length || !!progress} onClick={create}>Entwürfe erstellen</button>
      </div>
    </div>
  );
}

// ---------- drafts ----------

function DraftsTab() {
  const toast = useToast();
  const { data, error, reload } = useApi<Item[]>("/listings/drafts");
  const info = useApi<{ aiEnabled: boolean }>("/info");
  const [selected, setSelected] = useState<number[]>([]);
  const [enqueue, setEnqueue] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const toggle = (id: number) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  async function ai(id: number) {
    setBusy(id);
    try {
      await api(`/listings/drafts/${id}/ai`, { method: "POST", json: { apply: true } });
      void reload();
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack">
      <ErrorBox error={error} />
      <div className="row">
        <span className="muted">{selected.length} ausgewählt</span>
        <button className="btn small" onClick={() => setSelected(selected.length === data?.length ? [] : data?.map((d) => d.id) ?? [])}>Alle</button>
        <div className="spacer" />
        <button className="btn primary" disabled={!selected.length} onClick={() => setEnqueue(true)}>In Warteschlange…</button>
      </div>
      {data && !data.length && <div className="card"><Empty>Keine Entwürfe. <Link href="/listings?tab=new">Neue Artikel erstellen →</Link></Empty></div>}
      {!!data?.length && (
        <div className="card table-wrap">
          <table>
            <thead><tr><th></th><th></th><th>Titel</th><th>Marke / Größe</th><th className="num">Preis</th><th className="num">Fotos</th><th></th></tr></thead>
            <tbody>
              {data.map((d) => {
                const ready = d.price_cents !== null && !!d.title && (d.photo_count ?? 0) > 0;
                return (
                  <tr key={d.id}>
                    <td><input type="checkbox" checked={selected.includes(d.id)} onChange={() => toggle(d.id)} aria-label="auswählen" /></td>
                    <td style={{ width: 56 }}><Thumb src={photoUrl(d.cover_photo)} /></td>
                    <td><Link href={`/archive/${d.id}`}>{d.title}</Link>{!ready && <div className="small" style={{ color: "var(--warn)" }}>Preis/Titel/Foto fehlt</div>}</td>
                    <td>{[d.brand, d.size].filter(Boolean).join(" · ") || "–"}</td>
                    <td className="num">{euro(d.price_cents, d.currency)}</td>
                    <td className="num">{d.photo_count}</td>
                    <td className="row" style={{ justifyContent: "flex-end" }}>
                      {info.data?.aiEnabled && <button className="btn small" disabled={busy === d.id} onClick={() => ai(d.id)}>{busy === d.id ? "KI…" : "✨ KI"}</button>}
                      <Link className="btn small" href={`/archive/${d.id}`}>Bearbeiten</Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {enqueue && <EnqueueDialog itemIds={selected} onClose={() => setEnqueue(false)} onDone={() => { setEnqueue(false); setSelected([]); void reload(); }} />}
    </div>
  );
}

// ---------- queue ----------

function QueueTab() {
  const toast = useToast();
  const { data, error, reload } = useApi<QueueEntry[]>("/listings/queue");
  const act = (path: string) => api(path, { method: "POST", json: {} }).then(() => reload()).catch((e) => toast({ kind: "error", text: e.message }));
  return (
    <div className="stack">
      <ErrorBox error={error} />
      <div className="row"><span className="small muted">Der Hintergrund-Worker prüft jede Minute auf fällige Einträge (max. einer pro Account und Durchlauf).</span><div className="spacer" /><button className="btn small" onClick={() => reload()}>Aktualisieren</button></div>
      {data && !data.length && <div className="card"><Empty>Warteschlange ist leer.</Empty></div>}
      {!!data?.length && (
        <div className="card table-wrap">
          <table>
            <thead><tr><th></th><th>Artikel</th><th>Account</th><th>Geplant</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {data.map((q) => (
                <tr key={q.id}>
                  <td style={{ width: 56 }}><Thumb src={photoUrl(q.cover_photo)} /></td>
                  <td><Link href={`/archive/${q.item_id}`}>{q.title}</Link> <span className="muted">{euro(q.price_cents, q.currency)}</span>{q.is_reupload ? <> <span className="badge accent">Reupload</span></> : null}
                    {q.last_error && <div className="small" style={{ color: "var(--bad)" }}>{q.last_error}</div>}</td>
                  <td>{q.account_name}</td>
                  <td>{dateTime(q.scheduled_at)}</td>
                  <td><StatusBadge status={q.status} /></td>
                  <td className="row" style={{ justifyContent: "flex-end" }}>
                    {(q.status === "pending" || q.status === "failed") && <button className="btn small" onClick={() => act(`/listings/queue/${q.id}/reschedule`)}>{q.status === "failed" ? "Erneut versuchen" : "Jetzt"}</button>}
                    {(q.status === "pending" || q.status === "failed") && <button className="btn small danger" onClick={() => act(`/listings/queue/${q.id}/cancel`)}>Stornieren</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------- active ----------

function ActiveTab() {
  const { data, error } = useApi<Listing[]>("/listings");
  return (
    <div className="stack">
      <ErrorBox error={error} />
      {data && !data.length && <div className="card"><Empty>Keine aktiven Listings.</Empty></div>}
      {!!data?.length && (
        <div className="card table-wrap">
          <table>
            <thead><tr><th></th><th>Titel</th><th>Account</th><th className="num">Preis</th><th className="num">❤️</th><th className="num">👁</th><th className="num">Tage online</th><th></th></tr></thead>
            <tbody>
              {data.map((l) => (
                <tr key={l.id}>
                  <td style={{ width: 56 }}><Thumb src={photoUrl(l.cover_photo)} /></td>
                  <td><Link href={`/archive/${l.item_id}`}>{l.title}</Link></td>
                  <td>{l.account_name}</td>
                  <td className="num">{euro(l.price_cents, l.currency)}</td>
                  <td className="num">{l.favourites}</td>
                  <td className="num">{l.views}</td>
                  <td className="num">{l.days_online}</td>
                  <td>{l.url && <a href={l.url} target="_blank" rel="noreferrer">Vinted ↗</a>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------- templates ----------

const KINDS: Record<string, string> = { shipping: "Versand", condition: "Zustand", measurements: "Maßangaben", other: "Sonstiges" };

function TemplatesTab() {
  const toast = useToast();
  const { data, reload } = useApi<Template[]>("/listings/templates");
  const [edit, setEdit] = useState<Partial<Template> | null>(null);

  async function save() {
    if (!edit) return;
    try {
      const json = { name: edit.name, kind: edit.kind ?? "other", body: edit.body };
      if (edit.id) await api(`/listings/templates/${edit.id}`, { method: "PUT", json });
      else await api("/listings/templates", { method: "POST", json });
      setEdit(null);
      void reload();
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    }
  }

  return (
    <div className="grid grid-2">
      <div className="card stack">
        <div className="row"><h2 style={{ margin: 0 }}>Vorlagen</h2><div className="spacer" /><button className="btn small primary" onClick={() => setEdit({ kind: "shipping", name: "", body: "" })}>+ Neue Vorlage</button></div>
        {data && !data.length && <Empty>Noch keine Vorlagen. Beispiel: „Versand innerhalb von 1–2 Werktagen. Nichtraucherhaushalt, keine Haustiere.“</Empty>}
        <ul className="timeline">
          {data?.map((t) => (
            <li key={t.id}>
              <span className="badge">{KINDS[t.kind]}</span>
              <span style={{ flex: 1, minWidth: 0 }}><strong>{t.name}</strong><div className="small muted" style={{ whiteSpace: "pre-wrap" }}>{t.body.slice(0, 140)}</div></span>
              <button className="btn small" onClick={() => setEdit(t)}>Bearbeiten</button>
              <button className="btn small danger" onClick={() => confirm("Vorlage löschen?") && api(`/listings/templates/${t.id}`, { method: "DELETE" }).then(() => reload())}>✕</button>
            </li>
          ))}
        </ul>
      </div>
      {edit && (
        <div className="card stack">
          <h2>{edit.id ? "Vorlage bearbeiten" : "Neue Vorlage"}</h2>
          <label className="field">Name<input value={edit.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
          <label className="field">Art
            <select value={edit.kind ?? "other"} onChange={(e) => setEdit({ ...edit, kind: e.target.value })}>
              {Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label className="field">Text<textarea rows={6} value={edit.body ?? ""} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></label>
          <div className="row"><div className="spacer" /><button className="btn" onClick={() => setEdit(null)}>Abbrechen</button><button className="btn primary" disabled={!edit.name || !edit.body} onClick={save}>Speichern</button></div>
        </div>
      )}
    </div>
  );
}
