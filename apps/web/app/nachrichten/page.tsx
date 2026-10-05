"use client";
import { useEffect, useState } from "react";
import { useToast } from "@/components/Toasts";
import { Empty, ErrorBox, PageHead } from "@/components/ui";
import { api } from "@/lib/api";

type Kind = "purchases" | "favourites";
interface Target {
  key: string; accountName: string; name: string; title: string; info: string | null;
  offerCents: number | null; oldCents: number | null; alreadySent: boolean; skip: string | null;
}
interface Preview { targets: Target[]; warnings: string[]; defaultText: string }
interface Status {
  state: "idle" | "running" | "done"; kind: Kind | null; total: number; done: number; message: string | null;
  items: { key: string; name: string; title: string; state: "queued" | "running" | "done" | "failed" | "skipped"; message: string | null }[];
}

const TABS: Record<Kind, string> = { purchases: "✉️ Verkäufer anschreiben", favourites: "💸 Angebot an Favoriten" };
const STATE_LABEL = { queued: "wartet", running: "läuft…", done: "✓ gesendet", failed: "✗ fehlgeschlagen", skipped: "übersprungen" } as const;

export default function NachrichtenPage() {
  const toast = useToast();
  const [kind, setKind] = useState<Kind>("purchases");
  const [percent, setPercent] = useState(10);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [status, setStatus] = useState<Status | null>(null);

  async function load(k = kind, p = percent) {
    setLoading(true);
    setError(null);
    try {
      const r = await api<Preview>(`/outreach/preview?kind=${k}&percent=${p}`);
      setPreview(r);
      setText((t) => (t && k === kind ? t : r.defaultText));
      setSelected(r.targets.filter((t) => !t.skip && !t.alreadySent).map((t) => t.key));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(kind, percent); }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live progress while sending.
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      const s = await api<Status>("/outreach/status").catch(() => null);
      if (stop || !s) return;
      setStatus(s);
      if (s.state === "running") setTimeout(tick, 1500);
      else if (s.state === "done") void load();
    };
    void tick();
    return () => { stop = true; };
  }, [status?.state === "running"]); // eslint-disable-line react-hooks/exhaustive-deps

  async function start() {
    try {
      const s = await api<Status>("/outreach/start", { method: "POST", json: { kind, keys: selected, text, percent } });
      setStatus(s);
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    }
  }

  const sendable = preview?.targets.filter((t) => !t.skip && !t.alreadySent) ?? [];
  const toggle = (k: string) => setSelected((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]));
  const running = status?.state === "running";

  return (
    <>
      <PageHead title="Nachrichten" sub="Mehrere Leute auf einmal anschreiben – nacheinander über deinen Vinted-Chrome" />
      <div className="tabs" role="tablist">
        {(Object.keys(TABS) as Kind[]).map((k) => (
          <button key={k} role="tab" aria-selected={kind === k} className={`tab ${kind === k ? "active" : ""}`} onClick={() => { setText(""); setKind(k); }}>{TABS[k]}</button>
        ))}
      </div>
      <ErrorBox error={error} />

      {status && status.state !== "idle" && (
        <div className="card stack" style={{ marginBottom: 16, gap: 6 }}>
          <div className="row">
            <strong>{running ? `Sende ${status.done + 1} von ${status.total}…` : status.message}</strong>
            <div className="spacer" />
            {running && <button className="btn small danger" onClick={() => api<Status>("/outreach/stop", { method: "POST" }).then(setStatus)}>Stoppen</button>}
          </div>
          {status.items.map((i) => (
            <div key={i.key} className="small row" style={{ gap: 8 }}>
              <span style={{ width: 120, color: i.state === "done" ? "var(--good)" : i.state === "failed" ? "var(--bad)" : "var(--muted)" }}>{STATE_LABEL[i.state]}</span>
              <span><b>{i.name}</b> – {i.title}{i.message && i.state !== "done" ? ` · ${i.message}` : ""}</span>
            </div>
          ))}
        </div>
      )}

      <div className="card stack">
        {kind === "purchases"
          ? <div className="small muted">Alle Verkäufer, bei denen du gekauft hast und deren Paket noch nicht verschickt ist, bekommen die Nachricht in ihrem Kauf-Chat.</div>
          : (
            <div className="row" style={{ gap: 8 }}>
              <span className="small muted">Jedes Mitglied, das einen aktiven Artikel favorisiert hat, bekommt ein Angebot – gerundet auf gerade Euro-Beträge.</span>
              <div className="spacer" />
              <label className="row small" style={{ gap: 6 }}>Rabatt
                <input type="number" min={1} max={80} style={{ width: 64 }} value={percent} onChange={(e) => setPercent(Number(e.target.value) || 10)} onBlur={() => load(kind, percent)} /> %
              </label>
            </div>
          )}
        <label className="field">Nachricht {kind === "favourites" && <span className="small muted">– Platzhalter: {"{name}"}, {"{title}"}, {"{price}"} (Angebot), {"{old}"} (alter Preis)</span>}
          <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        {preview?.warnings.map((w) => <div key={w} className="alert small">{w}</div>)}
        {loading && <div className="muted small">Lade Empfänger…</div>}
        {preview && !preview.targets.length && !loading && <Empty>{kind === "purchases" ? "Keine offenen Käufe gefunden." : "Keine Favoriten bei aktiven Artikeln gefunden."}</Empty>}
        {!!preview?.targets.length && (
          <div className="table-wrap">
            <table>
              <thead><tr>
                <th><input type="checkbox" aria-label="alle" checked={sendable.length > 0 && selected.length === sendable.length}
                  onChange={() => setSelected(selected.length === sendable.length ? [] : sendable.map((t) => t.key))} /></th>
                <th>{kind === "purchases" ? "Verkäufer" : "Mitglied"}</th><th>Artikel</th><th>{kind === "purchases" ? "Status" : "Angebot"}</th><th>Account</th>
              </tr></thead>
              <tbody>
                {preview.targets.map((t) => (
                  <tr key={t.key} style={{ opacity: t.skip || t.alreadySent ? 0.55 : 1 }}>
                    <td><input type="checkbox" disabled={!!t.skip || t.alreadySent} checked={selected.includes(t.key)} onChange={() => toggle(t.key)} aria-label="auswählen" /></td>
                    <td><b>{t.name}</b></td>
                    <td>{t.title}</td>
                    <td>{t.alreadySent ? <span className="badge good">schon gesendet</span> : t.skip ? <span className="badge warn">{t.skip}</span> : t.info ?? "–"}</td>
                    <td className="muted">{t.accountName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="row">
          <span className="small muted">Der Vinted-Chrome muss laufen und eingeloggt sein. Jeder bekommt die Nachricht nur einmal.</span>
          <div className="spacer" />
          <button className="btn" onClick={() => load()} disabled={loading}>Aktualisieren</button>
          <button className="btn primary" disabled={!selected.length || !text.trim() || running} onClick={start}>
            {kind === "purchases" ? `An ${selected.length} Verkäufer senden` : `${selected.length} Angebote senden`}
          </button>
        </div>
      </div>
    </>
  );
}
