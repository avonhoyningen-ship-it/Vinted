"use client";
import { useEffect, useState, type ReactNode } from "react";
import { useToast } from "@/components/Toasts";
import { EbayCard } from "@/components/EbayCard";
import { ErrorBox, PageHead } from "@/components/ui";
import { api } from "@/lib/api";
import { playSound, SOUND_PRESETS, type SoundPreset } from "@/lib/sounds";
import { useApi } from "@/lib/useApi";

interface Settings {
  "sound.preset": SoundPreset; "sound.volume": number; "sound.enabled": boolean;
  "notifications.desktop": boolean; "notifications.confetti": boolean;
  "automation.dailyMessageCap": number; "automation.paused": boolean; "ai.language": string; "ai.listingPrompt": string; "ai.regenerateOnUpload": boolean; "ai.closingText": string; "brand.rules": string; "parcel.rules": string;
  "offers.autoFavourites": boolean; "offers.favouritePercent": number; "offers.autoReply": boolean;
  "offers.maxPercentNew": number; "offers.maxPercentOld": number; "offers.oldAfterDays": number;
}
interface Info { aiEnabled: boolean; aiModel: string; pollIntervalMinutes: number; publishIntervalMinutes: number }

export default function SettingsPage() {
  const toast = useToast();
  const { data, error, setData } = useApi<Settings>("/settings");
  const info = useApi<Info>("/info");
  const [perm, setPerm] = useState<string>("default");
  useEffect(() => { if ("Notification" in window) setPerm(Notification.permission); }, []);

  async function update(patch: Partial<Settings>) {
    try {
      setData(await api<Settings>("/settings", { method: "PUT", json: patch }));
      window.dispatchEvent(new Event("settings-changed"));
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    }
  }

  if (!data) return <ErrorBox error={error} />;
  return (
    <>
      <PageHead title="Einstellungen" />
      <RemoteAccessCard />
      <EbayCard />
      <div className="grid grid-2">
        <div className="card stack">
          <h2>Sale-Sound & Benachrichtigungen</h2>
          <label className="row"><input type="checkbox" checked={data["sound.enabled"]} onChange={(e) => update({ "sound.enabled": e.target.checked })} /> Sound bei Verkauf abspielen</label>
          <label className="field">Sound
            <div className="row" style={{ flexWrap: "nowrap" }}>
              <select value={data["sound.preset"]} onChange={(e) => update({ "sound.preset": e.target.value as SoundPreset })}>
                {Object.entries(SOUND_PRESETS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <button className="btn" onClick={() => playSound(data["sound.preset"], data["sound.volume"])}>▶ Testen</button>
            </div>
          </label>
          <label className="field">Lautstärke: {Math.round(data["sound.volume"] * 100)} %
            <input type="range" min={0} max={1} step={0.05} value={data["sound.volume"]} onChange={(e) => setData({ ...data, "sound.volume": Number(e.target.value) })}
              onMouseUp={() => update({ "sound.volume": data["sound.volume"] })} onTouchEnd={() => update({ "sound.volume": data["sound.volume"] })} onKeyUp={() => update({ "sound.volume": data["sound.volume"] })} />
          </label>
          <label className="row"><input type="checkbox" checked={data["notifications.confetti"]} onChange={(e) => update({ "notifications.confetti": e.target.checked })} /> Konfetti bei Verkauf</label>
          <label className="row"><input type="checkbox" checked={data["notifications.desktop"]} onChange={(e) => update({ "notifications.desktop": e.target.checked })} /> Desktop-Benachrichtigung</label>
          {data["notifications.desktop"] && perm !== "granted" && (
            <div className="row">
              <span className="small muted">{perm === "denied" ? "Im Browser blockiert – in den Seiteneinstellungen erlauben." : "Browser-Erlaubnis fehlt."}</span>
              {perm !== "denied" && <button className="btn small" onClick={() => Notification.requestPermission().then(setPerm)}>Erlauben</button>}
            </div>
          )}
          <div className="small muted">Hinweis: Browser spielen Sounds erst nach einer Interaktion mit der Seite ab. Lass das Dashboard in einem Tab offen.</div>
        </div>

        <div className="card stack">
          <h2>Automatisierungen & KI</h2>
          <label className="field">Max. automatische Nachrichten pro Account und Tag
            <input type="number" min={0} max={500} value={data["automation.dailyMessageCap"]} onChange={(e) => setData({ ...data, "automation.dailyMessageCap": Number(e.target.value) })}
              onBlur={() => update({ "automation.dailyMessageCap": data["automation.dailyMessageCap"] })} />
          </label>
          <label className="row"><input type="checkbox" checked={data["automation.paused"]} onChange={(e) => update({ "automation.paused": e.target.checked })} /> Alle Automatisierungen pausieren</label>
          <label className="row"><input type="checkbox" checked={data["ai.regenerateOnUpload"] ?? true} onChange={(e) => update({ "ai.regenerateOnUpload": e.target.checked })} /> KI schreibt Titel, Beschreibung und Angaben bei jedem Hochladen neu (Preis und Fotos bleiben)</label>
          <label className="field">Sprache für KI-Texte
            <select value={data["ai.language"]} onChange={(e) => update({ "ai.language": e.target.value })}>
              <option value="de">Deutsch</option><option value="en">Englisch</option><option value="fr">Französisch</option>
              <option value="it">Italienisch</option><option value="es">Spanisch</option><option value="nl">Niederländisch</option><option value="pl">Polnisch</option>
            </select>
          </label>
        </div>

        <OffersCard data={data} setData={setData} update={update} />

        <RulesEditor title="Markenregeln" value={data["brand.rules"]} onSave={(v) => update({ "brand.rules": v })} help={<>
          Eine Regel pro Zeile: <code>Wörter im Titel oder in der Kategorie=Marke</code>. Die Regel gewinnt immer gegen die KI und wird
          beim Ausfüllen im Vinted-Chrome verwendet. Mehrere Wörter mit Komma trennen, z. B. <code>T-Shirt, Tee, Shirt=Graphic Tee</code>. Gilt auch für bestehende Entwürfe.
        </>} />
        <RulesEditor title="Paketgröße" value={data["parcel.rules"]} onSave={(v) => update({ "parcel.rules": v })} help={<>
          Eine Regel pro Zeile: <code>Wörter=Klein</code>, <code>Mittel</code> oder <code>Groß</code>. Die erste passende Zeile gilt, z. B.{" "}
          <code>Pullover, Hoodie=Mittel</code> vor <code>T-Shirt, Tee=Klein</code>. Wird beim Ausfüllen im Vinted-Chrome ausgewählt.
        </>} />

        <PromptEditor value={data["ai.listingPrompt"]} onSave={(v) => update({ "ai.listingPrompt": v })} />
        <RulesEditor title="Abschluss jeder Beschreibung" value={data["ai.closingText"] ?? ""} onSave={(v) => update({ "ai.closingText": v })} help={<>
          Steht in jeder Beschreibung zwischen dem kurzen Text und den Hashtags. Zum Beispiel Versand-Hinweis oder
          „Aus tierfreiem Nichtraucherhaushalt.“ (nur eintragen, wenn es stimmt).</>} />

        {info.data && (
          <div className="card stack">
            <h2>System</h2>
            <table><tbody>
              <tr><td>KI</td><td>{info.data.aiEnabled ? `aktiv (${info.data.aiModel})` : "deaktiviert – ANTHROPIC_API_KEY fehlt"}</td></tr>
              <tr><td>Polling-Intervall</td><td>{info.data.pollIntervalMinutes} Minuten</td></tr>
              <tr><td>Standard-Veröffentlichungsabstand</td><td>{info.data.publishIntervalMinutes} Minuten</td></tr>
            </tbody></table>
            <div className="small muted">Diese Werte werden in der Datei <code>.env</code> konfiguriert.</div>
            <div className="row"><button className="btn" onClick={() => api("/auth/logout", { method: "POST" }).then(() => { window.location.href = "/login"; })}>Abmelden</button></div>
          </div>
        )}
      </div>
    </>
  );
}

function PromptEditor({ value, onSave }: { value: string; onSave: (v: string) => Promise<void> }) {
  const [text, setText] = useState(value);
  const [defaults, setDefaults] = useState<string | null>(null);
  useEffect(() => setText(value), [value]);
  useEffect(() => { api<{ "ai.listingPrompt": string }>("/settings/defaults").then((d) => setDefaults(d["ai.listingPrompt"])).catch(() => {}); }, []);
  return (
    <div className="card stack" style={{ gridColumn: "1 / -1" }}>
      <h2>KI-Prompt für Beschreibungen</h2>
      <div className="small muted">
        So schreibt die KI Titel, Stichpunkte und Hashtags. Maße kommen aus dem Ordnernamen, Zustand und Besonderheiten aus deinen Hinweisen beim Upload.
        Das Drehen der Fotos und das Datenformat regelt das Programm selbst – dafür musst du hier nichts schreiben.
      </div>
      <textarea rows={18} value={text} onChange={(e) => setText(e.target.value)} style={{ fontFamily: "ui-monospace, monospace", fontSize: 13 }} />
      <div className="row">
        {defaults !== null && text !== defaults && <button className="btn" onClick={() => setText(defaults)}>Standard wiederherstellen</button>}
        <div className="spacer" />
        {text !== value && <span className="small muted">Ungespeichert</span>}
        <button className="btn primary" disabled={text === value || text.trim().length < 20} onClick={() => onSave(text)}>Prompt speichern</button>
      </div>
    </div>
  );
}

function RulesEditor({ title, help, value, onSave }: { title: string; help: ReactNode; value: string; onSave: (v: string) => Promise<void> }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <div className="card stack">
      <h2>{title}</h2>
      <div className="small muted">{help}</div>
      <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} style={{ fontFamily: "ui-monospace, monospace", fontSize: 13 }} />
      <div className="row"><div className="spacer" />
        <button className="btn primary" disabled={text === value} onClick={() => onSave(text)}>Speichern</button></div>
    </div>
  );
}

/** Local dashboard: how to open it from another laptop or the phone. */
function RemoteAccessCard() {
  const net = useApi<{ local: boolean; passwordSet: boolean; urls: string[]; remoteUrls: string[] }>("/network");
  if (!net.data?.local) return null;
  return (
    <div className="card stack" style={{ marginBottom: 16 }}>
      <h2>💻 Von anderem Laptop / Handy öffnen</h2>
      {net.data.passwordSet ? (
        <>
          <div className="small"><b>Von überall</b> (anderer Wohnort, unterwegs) – Tailscale auf beiden Geräten mit demselben Konto:</div>
          {net.data.remoteUrls.length
            ? net.data.remoteUrls.map((u) => <code key={u} style={{ fontSize: 16 }}>{u}</code>)
            : <div className="small muted">Tailscale ist auf diesem PC noch nicht aktiv – „Zugriff von anderem Geraet.bat“ starten, sie führt dich durch.</div>}
          <div className="small"><b>Im gleichen WLAN:</b></div>
          {net.data.urls.map((u) => <code key={u} style={{ fontSize: 16 }}>{u}</code>)}
          <div className="small muted">Login mit deinem Dashboard-Passwort. Dieser PC muss an sein und das Dashboard laufen. Der Vinted-Chrome läuft weiter auf diesem PC.</div>
        </>
      ) : (
        <div className="alert small">Ohne Passwort ist das Dashboard nur auf diesem PC erreichbar. Starte „Zugriff von anderem Geraet.bat“ – dort legst du ein Passwort fest und gibst den Zugriff frei.</div>
      )}
    </div>
  );
}

interface OfferLog { at: string; kind: "reply" | "favourites"; account: string; name: string; title: string; text: string; ok: boolean }

/** Automatic offers: to members who favourite, and answers to buyers' offers (runs every 5 minutes in the background). */
function OffersCard({ data, setData, update }: { data: Settings; setData: (s: Settings) => void; update: (p: Partial<Settings>) => Promise<void> }) {
  const toast = useToast();
  const status = useApi<{ log: OfferLog[]; deepRunning?: boolean }>("/offers/status");
  const deepRunning = !!status.data?.deepRunning;
  // While the run through old things is going: refresh the log every few seconds.
  useEffect(() => {
    if (!deepRunning) return;
    const t = setInterval(() => void status.reload(), 5000);
    return () => clearInterval(t);
  }, [deepRunning, status.reload]);
  async function runOld() {
    try {
      const r = await api<{ started: boolean; log: OfferLog[]; deepRunning: boolean }>("/offers/run-old", { method: "POST" });
      status.setData({ log: r.log, deepRunning: r.deepRunning });
      toast({ kind: "info", text: r.started ? "Alte Favoriten und Angebote werden jetzt bearbeitet – dauert ein paar Minuten" : "Läuft schon" });
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    }
  }
  const [busy, setBusy] = useState(false);
  const num = (key: "offers.favouritePercent" | "offers.maxPercentNew" | "offers.maxPercentOld" | "offers.oldAfterDays", min: number, max: number) => (
    <input type="number" min={min} max={max} value={data[key]}
      onChange={(e) => setData({ ...data, [key]: Number(e.target.value) })}
      onBlur={() => update({ [key]: Math.min(max, Math.max(min, Math.round(data[key]))) })} />
  );
  async function runNow() {
    setBusy(true);
    try {
      const r = await api<{ replied: number; favourites: number; log: OfferLog[] }>("/offers/run", { method: "POST" });
      status.setData({ ...status.data, log: r.log });
      toast({ kind: "info", text: `${r.replied} Angebot(e) beantwortet, ${r.favourites} Favoriten-Angebot(e) gestartet` });
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card stack">
      <h2>💸 Automatische Angebote</h2>
      <label className="row"><input type="checkbox" checked={data["offers.autoFavourites"]} onChange={(e) => update({ "offers.autoFavourites": e.target.checked })} /> Favoriten automatisch ein Angebot schicken</label>
      <label className="field">Rabatt für Favoriten in % {num("offers.favouritePercent", 1, 80)}</label>
      <label className="row"><input type="checkbox" checked={data["offers.autoReply"]} onChange={(e) => update({ "offers.autoReply": e.target.checked })} /> Angebote von Käufern automatisch beantworten</label>
      <label className="field">Ab wie vielen Tagen online gilt ein Artikel als „alt“ {num("offers.oldAfterDays", 1, 365)}</label>
      <label className="field">Max. Rabatt, den ich annehme – neue Artikel (%) {num("offers.maxPercentNew", 0, 80)}</label>
      <label className="field">Max. Rabatt, den ich annehme – alte Artikel (%) {num("offers.maxPercentOld", 0, 80)}</label>
      <div className="small">Liegt ein Angebot darunter, schickt das Dashboard ein Gegenangebot zum niedrigsten erlaubten Preis (gerade Euro).</div>
      <div className="small muted">Läuft alle 5 Minuten im Hintergrund, solange das Dashboard und der Vinted-Chrome laufen. „Alle Automatisierungen pausieren“ stoppt es auch.</div>
      <div className="row"><button className="btn small" disabled={busy} onClick={runNow}>{busy ? "Prüfe …" : "Jetzt prüfen"}</button>
        <button className="btn small" disabled={deepRunning} onClick={runOld}>{deepRunning ? "Bearbeite alte Sachen …" : "Alte Favoriten & Angebote jetzt bearbeiten"}</button></div>
      <div className="small muted">„Alte … bearbeiten“ liest alle alten Favoriten und Chats der letzten 60 Tage und schickt bzw. beantwortet die Angebote (Tageslimit gilt). Dauert ein paar Minuten.</div>
      {!!status.data?.log.length && (
        <table className="small"><tbody>
          {status.data.log.slice(0, 15).map((l, i) => (
            <tr key={i}><td>{new Date(l.at).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</td>
              <td>{l.ok ? "✅" : "⚠️"} <b>{l.name}</b> – {l.title}: {l.text}</td></tr>
          ))}
        </tbody></table>
      )}
    </div>
  );
}
