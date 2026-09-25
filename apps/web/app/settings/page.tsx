"use client";
import { useEffect, useState } from "react";
import { useToast } from "@/components/Toasts";
import { ErrorBox, PageHead } from "@/components/ui";
import { api } from "@/lib/api";
import { playSound, SOUND_PRESETS, type SoundPreset } from "@/lib/sounds";
import { useApi } from "@/lib/useApi";

interface Settings {
  "sound.preset": SoundPreset; "sound.volume": number; "sound.enabled": boolean;
  "notifications.desktop": boolean; "notifications.confetti": boolean;
  "automation.dailyMessageCap": number; "automation.paused": boolean; "ai.language": string;
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
          <label className="field">Sprache für KI-Texte
            <select value={data["ai.language"]} onChange={(e) => update({ "ai.language": e.target.value })}>
              <option value="de">Deutsch</option><option value="en">Englisch</option><option value="fr">Französisch</option>
              <option value="it">Italienisch</option><option value="es">Spanisch</option><option value="nl">Niederländisch</option><option value="pl">Polnisch</option>
            </select>
          </label>
        </div>

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
