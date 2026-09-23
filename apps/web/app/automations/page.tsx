"use client";
import { useEffect, useState } from "react";
import { useToast } from "@/components/Toasts";
import { Empty, ErrorBox, Modal, PageHead, StatusBadge } from "@/components/ui";
import { api, dateTime, euro, parseEuro } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import type { Account } from "@/lib/types";

interface Rule {
  id?: number; name: string; enabled: boolean; accountId: number | null;
  triggerType: string; triggerConfig: { keywords?: string[]; days?: number };
  actionType: string; actionConfig: { message?: string; percent?: number; minPriceCents?: number; repeatEveryDays?: number };
  delayMinutes: number; perUserLimit: number; perUserWindowHours: number; stats?: Record<string, number>;
}
interface Meta { triggers: Record<string, string>; actions: Record<string, string>; placeholders: { key: string; description: string }[] }
interface ActionLog {
  id: number; rule_name: string | null; account_name: string; listing_title: string | null; action_type: string;
  status: string; result: string | null; run_at: string; executed_at: string | null; payload: string;
}

const PRESETS: Rule[] = [
  { name: "Danke fürs Merken", enabled: true, accountId: null, triggerType: "item_favourited", triggerConfig: {}, actionType: "send_message",
    actionConfig: { message: "Hi {nutzer}, danke fürs Merken von „{artikelname}“! Bei Fragen gerne melden 😊" }, delayMinutes: 30, perUserLimit: 1, perUserWindowHours: 168 },
  { name: "FAQ: Maße", enabled: true, accountId: null, triggerType: "message_received", triggerConfig: { keywords: ["maße", "länge", "breite", "wie groß"] }, actionType: "send_message",
    actionConfig: { message: "Hallo {nutzer}, die genauen Maße findest du in der Artikelbeschreibung. Wenn etwas fehlt, messe ich gerne nach!" }, delayMinutes: 5, perUserLimit: 1, perUserWindowHours: 24 },
  { name: "Danke für den Kauf", enabled: true, accountId: null, triggerType: "item_sold", triggerConfig: {}, actionType: "send_message",
    actionConfig: { message: "Vielen Dank für deinen Kauf, {nutzer}! Ich verschicke „{artikelname}“ so schnell wie möglich." }, delayMinutes: 10, perUserLimit: 3, perUserWindowHours: 24 },
  { name: "Preis -10 % nach 14 Tagen", enabled: true, accountId: null, triggerType: "listing_stale", triggerConfig: { days: 14 }, actionType: "reduce_price",
    actionConfig: { percent: 10, repeatEveryDays: 7 }, delayMinutes: 0, perUserLimit: 1, perUserWindowHours: 168 },
];

function describe(r: Rule, meta: Meta | null) {
  const when = meta?.triggers[r.triggerType] ?? r.triggerType;
  const cond = r.triggerType === "message_received" && r.triggerConfig.keywords?.length ? ` („${r.triggerConfig.keywords.join("“, „")}“)`
    : r.triggerType === "listing_stale" ? ` (${r.triggerConfig.days} Tage)` : "";
  const then = r.actionType === "reduce_price" ? `Preis um ${r.actionConfig.percent} % senken` : "Nachricht senden";
  const delay = r.delayMinutes ? `nach ${r.delayMinutes >= 60 ? `${Math.round(r.delayMinutes / 60 * 10) / 10} Std.` : `${r.delayMinutes} Min.`}` : "sofort";
  return `Wenn ${when}${cond} → ${then} ${delay}`;
}

export default function AutomationsPage() {
  const toast = useToast();
  const meta = useApi<Meta>("/automations/meta");
  const rules = useApi<Rule[]>("/automations/rules");
  const log = useApi<ActionLog[]>("/automations/actions");
  const accounts = useApi<Account[]>("/accounts");
  const settings = useApi<Record<string, unknown>>("/settings");
  const [edit, setEdit] = useState<Rule | null>(null);

  const reloadAll = () => { void rules.reload(); void log.reload(); };
  const paused = settings.data?.["automation.paused"] === true;

  async function togglePause() {
    await api("/settings", { method: "PUT", json: { "automation.paused": !paused } });
    void settings.reload();
  }

  return (
    <>
      <PageHead title="Automatisierungen" sub="Wenn [Ereignis] dann [Aktion] nach [Zeitspanne]">
        <button className={`btn ${paused ? "primary" : ""}`} onClick={togglePause}>{paused ? "▶ Fortsetzen" : "⏸ Alle pausieren"}</button>
        <button className="btn primary" onClick={() => setEdit({ ...PRESETS[0]!, name: "" })}>+ Neue Regel</button>
      </PageHead>
      {paused && <div className="alert" style={{ marginBottom: 16 }}>Automatisierungen sind pausiert – geplante Aktionen werden erst nach dem Fortsetzen ausgeführt.</div>}
      <div className="stack">
        <div className="card">
          <h2>Regeln</h2>
          {rules.data && !rules.data.length && (
            <div className="stack">
              <Empty>Noch keine Regeln. Starte mit einer Vorlage:</Empty>
              <div className="row" style={{ justifyContent: "center" }}>
                {PRESETS.map((p) => <button key={p.name} className="btn small" onClick={() => setEdit(p)}>{p.name}</button>)}
              </div>
            </div>
          )}
          <ul className="timeline">
            {rules.data?.map((r) => (
              <li key={r.id}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <strong>{r.name}</strong> {!r.enabled && <span className="badge">aus</span>}
                  <div className="small muted">{describe(r, meta.data)} · {r.accountId ? accounts.data?.find((a) => a.id === r.accountId)?.name : "alle Accounts"}
                    {r.actionType === "send_message" && ` · max. ${r.perUserLimit}× pro Nutzer in ${r.perUserWindowHours} Std.`}</div>
                  <div className="small muted">Ausgeführt: {r.stats?.done ?? 0} · geplant: {r.stats?.pending ?? 0} · übersprungen: {r.stats?.skipped ?? 0} · Fehler: {r.stats?.failed ?? 0}</div>
                </span>
                <button className="btn small" onClick={() => api(`/automations/rules/${r.id}/toggle`, { method: "POST" }).then(reloadAll)}>{r.enabled ? "Deaktivieren" : "Aktivieren"}</button>
                <button className="btn small" onClick={() => setEdit(r)}>Bearbeiten</button>
                <button className="btn small danger" onClick={() => confirm("Regel löschen?") && api(`/automations/rules/${r.id}`, { method: "DELETE" }).then(reloadAll)}>✕</button>
              </li>
            ))}
          </ul>
        </div>

        <div className="card">
          <div className="row"><h2 style={{ margin: 0 }}>Aktionsprotokoll</h2><div className="spacer" /><button className="btn small" onClick={() => log.reload()}>Aktualisieren</button></div>
          {log.data && !log.data.length && <Empty>Noch keine Aktionen.</Empty>}
          {!!log.data?.length && (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Zeit</th><th>Regel</th><th>Account</th><th>Artikel / Nutzer</th><th>Status</th><th>Ergebnis</th><th></th></tr></thead>
                <tbody>
                  {log.data.map((a) => (
                    <tr key={a.id}>
                      <td className="small">{dateTime(a.executed_at ?? a.run_at)}</td>
                      <td>{a.rule_name ?? "–"}</td>
                      <td>{a.account_name}</td>
                      <td>{a.listing_title ?? "–"}<div className="small muted">{JSON.parse(a.payload).username ?? ""}</div></td>
                      <td><StatusBadge status={a.status} /></td>
                      <td className="small" style={{ maxWidth: 320 }}>{a.result}</td>
                      <td>{a.status === "pending" && <button className="btn small danger" onClick={() => api(`/automations/actions/${a.id}/cancel`, { method: "POST" }).then(reloadAll).catch((e) => toast({ kind: "error", text: e.message }))}>Abbrechen</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      {edit && <RuleEditor rule={edit} meta={meta.data} accounts={accounts.data ?? []} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reloadAll(); }} />}
    </>
  );
}

function RuleEditor({ rule, meta, accounts, onClose, onSaved }: { rule: Rule; meta: Meta | null; accounts: Account[]; onClose: () => void; onSaved: () => void }) {
  const [r, setR] = useState<Rule>(rule);
  const [keywords, setKeywords] = useState((rule.triggerConfig.keywords ?? []).join(", "));
  const [minPrice, setMinPrice] = useState(rule.actionConfig.minPriceCents ? String(rule.actionConfig.minPriceCents / 100) : "");
  const [delayUnit, setDelayUnit] = useState<"min" | "h">(rule.delayMinutes >= 60 && rule.delayMinutes % 60 === 0 ? "h" : "min");
  const [delay, setDelay] = useState(String(delayUnit === "h" ? rule.delayMinutes / 60 : rule.delayMinutes));
  const [preview, setPreview] = useState("");
  const [error, setError] = useState<string | null>(null);
  const isStale = r.triggerType === "listing_stale";

  useEffect(() => {
    if (!r.actionConfig.message) return setPreview("");
    const t = setTimeout(() => {
      api<{ text: string }>("/automations/preview", { method: "POST", json: { template: r.actionConfig.message } }).then((p) => setPreview(p.text)).catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [r.actionConfig.message]);

  function setTrigger(t: string) {
    setR((p) => ({ ...p, triggerType: t, actionType: t === "listing_stale" ? "reduce_price" : "send_message",
      triggerConfig: t === "listing_stale" ? { days: p.triggerConfig.days ?? 14 } : p.triggerConfig,
      actionConfig: t === "listing_stale" ? { percent: p.actionConfig.percent ?? 10, repeatEveryDays: p.actionConfig.repeatEveryDays ?? 7 } : { message: p.actionConfig.message ?? "" } }));
  }

  async function save() {
    setError(null);
    const body: Rule = {
      ...r,
      delayMinutes: Math.round(Number(delay || 0) * (delayUnit === "h" ? 60 : 1)),
      triggerConfig: isStale ? { days: r.triggerConfig.days } : r.triggerType === "message_received" ? { keywords: keywords.split(",").map((k) => k.trim()).filter(Boolean) } : {},
      actionConfig: isStale ? { percent: r.actionConfig.percent, repeatEveryDays: r.actionConfig.repeatEveryDays, ...(parseEuro(minPrice) ? { minPriceCents: parseEuro(minPrice)! } : {}) } : { message: r.actionConfig.message },
    };
    const { id, stats: _s, ...json } = body;
    try {
      await api(id ? `/automations/rules/${id}` : "/automations/rules", { method: id ? "PUT" : "POST", json });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Modal title={r.id ? "Regel bearbeiten" : "Neue Regel"} onClose={onClose}>
      <div className="stack">
        <ErrorBox error={error} />
        <label className="field">Name<input value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} /></label>
        <div className="form-grid">
          <label className="field">Wenn (Ereignis)
            <select value={r.triggerType} onChange={(e) => setTrigger(e.target.value)}>
              {meta && Object.entries(meta.triggers).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label className="field">Account
            <select value={r.accountId ?? ""} onChange={(e) => setR({ ...r, accountId: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Alle Accounts</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
        </div>
        {r.triggerType === "message_received" && (
          <label className="field">Schlüsselwörter (kommagetrennt, leer = jede Nachricht)<input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="maße, versand, preis" /></label>
        )}
        {isStale ? (
          <div className="form-grid">
            <label className="field">Tage ohne Verkauf<input type="number" min={1} value={r.triggerConfig.days ?? ""} onChange={(e) => setR({ ...r, triggerConfig: { days: Number(e.target.value) } })} /></label>
            <label className="field">Preis senken um (%)<input type="number" min={1} max={50} value={r.actionConfig.percent ?? ""} onChange={(e) => setR({ ...r, actionConfig: { ...r.actionConfig, percent: Number(e.target.value) } })} /></label>
            <label className="field">Wiederholen alle (Tage)<input type="number" min={1} value={r.actionConfig.repeatEveryDays ?? ""} onChange={(e) => setR({ ...r, actionConfig: { ...r.actionConfig, repeatEveryDays: Number(e.target.value) } })} /></label>
            <label className="field">Mindestpreis (€)<input value={minPrice} onChange={(e) => setMinPrice(e.target.value)} placeholder="optional" /></label>
          </div>
        ) : (
          <>
            <label className="field">Dann: Nachricht senden
              <textarea rows={4} value={r.actionConfig.message ?? ""} onChange={(e) => setR({ ...r, actionConfig: { message: e.target.value } })} />
            </label>
            <div className="row small">
              {meta?.placeholders.map((p) => (
                <button key={p.key} type="button" className="btn small" title={p.description}
                  onClick={() => setR({ ...r, actionConfig: { message: `${r.actionConfig.message ?? ""}{${p.key}}` } })}>{`{${p.key}}`}</button>
              ))}
            </div>
            {preview && <div className="alert info small">Vorschau: {preview}</div>}
          </>
        )}
        <div className="form-grid">
          <label className="field">Verzögerung
            <div className="row" style={{ flexWrap: "nowrap" }}>
              <input type="number" min={0} value={delay} onChange={(e) => setDelay(e.target.value)} />
              <select style={{ width: 100 }} value={delayUnit} onChange={(e) => setDelayUnit(e.target.value as "min" | "h")}><option value="min">Minuten</option><option value="h">Stunden</option></select>
            </div>
          </label>
          {!isStale && <>
            <label className="field">Max. pro Nutzer<input type="number" min={1} value={r.perUserLimit} onChange={(e) => setR({ ...r, perUserLimit: Number(e.target.value) })} /></label>
            <label className="field">im Zeitraum (Std.)<input type="number" min={1} value={r.perUserWindowHours} onChange={(e) => setR({ ...r, perUserWindowHours: Number(e.target.value) })} /></label>
          </>}
        </div>
        {!isStale && <div className="small muted">Zusätzlich gilt ein globales Tageslimit für automatische Nachrichten pro Account (Einstellungen), damit niemand zugespammt wird.</div>}
        {isStale && r.actionConfig.percent && <div className="small muted">Beispiel: {euro(2500)} → {euro(Math.floor(2500 * (100 - r.actionConfig.percent) / 100 / 10) * 10)}</div>}
        <label className="row"><input type="checkbox" checked={r.enabled} onChange={(e) => setR({ ...r, enabled: e.target.checked })} /> Regel aktiv</label>
        <div className="row"><div className="spacer" /><button className="btn" onClick={onClose}>Abbrechen</button><button className="btn primary" disabled={!r.name} onClick={save}>Speichern</button></div>
      </div>
    </Modal>
  );
}
