"use client";
import { useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useToast } from "./Toasts";

const MAX_PHOTOS = 20;
const isImage = (f: File) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif|avif)$/i.test(f.name);

interface Group { folder: string; files: File[]; hint: string }

/**
 * Folder upload: every folder = one article, the folder name carries the
 * measurements (e.g. "Laenge 70 Breite 55"). Selecting a parent folder with
 * several sub-folders creates one draft per sub-folder.
 */
export function FolderUpload({ aiEnabled, onDone }: { aiEnabled: boolean; onDone: () => void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [hints, setHints] = useState("");
  const [useAi, setUseAi] = useState(true);
  const [progress, setProgress] = useState<string | null>(null);
  const [results, setResults] = useState<{ folder: string; ok: boolean; text: string }[]>([]);

  function pick(files: File[]) {
    const map = new Map<string, File[]>();
    for (const f of files.filter(isImage)) {
      const parts = (f.webkitRelativePath || f.name).split("/");
      const folder = parts.length > 1 ? parts[parts.length - 2]! : "Ohne Ordner";
      map.set(folder, [...(map.get(folder) ?? []), f]);
    }
    setGroups([...map].sort(([a], [b]) => a.localeCompare(b, "de", { numeric: true })).map(([folder, fs]) => ({ folder, files: fs, hint: "" })));
    setResults([]);
  }

  const total = useMemo(() => groups.reduce((n, g) => n + g.files.length, 0), [groups]);

  async function create() {
    const out: typeof results = [];
    for (const [i, g] of groups.entries()) {
      setProgress(`Artikel ${i + 1} von ${groups.length}: „${g.folder}“ ${useAi && aiEnabled ? "– KI dreht Fotos und schreibt die Beschreibung…" : "wird angelegt…"}`);
      const fd = new FormData();
      [...g.files].sort((a, b) => a.name.localeCompare(b.name, "de", { numeric: true })).slice(0, MAX_PHOTOS).forEach((f) => fd.append("photos", f, f.name));
      fd.append("folder", g.folder);
      const hint = [hints, g.hint].filter((h) => h.trim()).join(". ");
      if (hint) fd.append("hints", hint);
      if (useAi && aiEnabled) fd.append("ai", "true");
      try {
        const r = await api<{ item: { title: string }; aiError: string | null }>("/listings/drafts", { method: "POST", body: fd });
        out.push({ folder: g.folder, ok: !r.aiError, text: r.aiError ? `Entwurf angelegt, KI-Fehler: ${r.aiError}` : r.item.title });
      } catch (e) {
        out.push({ folder: g.folder, ok: false, text: (e as Error).message });
      }
      setResults([...out]);
    }
    setProgress(null);
    const ok = out.filter((r) => r.ok).length;
    toast({ kind: ok === out.length ? "info" : "error", text: `${ok} von ${out.length} Entwürfen fertig` });
    if (ok === out.length) { setGroups([]); onDone(); }
  }

  return (
    <div className="card stack">
      <div className="row">
        <button className="btn primary" disabled={!!progress} onClick={() => input.current?.click()}>📁 Ordner auswählen</button>
        <span className="small muted">Ein Ordner = ein Artikel, der Ordnername enthält die Maße (z. B. <code>Laenge 70 Breite 55</code>). Ein übergeordneter Ordner mit mehreren Unterordnern erstellt mehrere Entwürfe.</span>
        <input ref={input} type="file" hidden multiple {...{ webkitdirectory: "", directory: "" }} onChange={(e) => { pick([...(e.target.files ?? [])]); e.target.value = ""; }} />
      </div>

      {!!groups.length && (
        <>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Ordner (= Maße)</th><th className="num">Fotos</th><th>Extra-Hinweis für diesen Artikel</th><th></th></tr></thead>
              <tbody>
                {groups.map((g, i) => (
                  <tr key={g.folder}>
                    <td><strong>{g.folder}</strong></td>
                    <td className="num">{g.files.length}{g.files.length > MAX_PHOTOS && <div className="small" style={{ color: "var(--warn)" }}>nur die ersten {MAX_PHOTOS}</div>}</td>
                    <td><input value={g.hint} placeholder="z. B. kleiner Fleck am Ärmel" onChange={(e) => setGroups(groups.map((x, j) => (j === i ? { ...x, hint: e.target.value } : x)))} /></td>
                    <td><button className="btn small ghost" onClick={() => setGroups(groups.filter((_, j) => j !== i))} aria-label="entfernen">✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="form-grid">
            <label className="field span-all">Hinweise für alle Artikel (Zustand, Passform, Besonderheiten, Wunsch-Hashtags)
              <input value={hints} onChange={(e) => setHints(e.target.value)} placeholder="z. B. Zustand sehr gut, fällt normal aus, #carhartt" />
            </label>
            <label className="row span-all"><input type="checkbox" checked={useAi && aiEnabled} disabled={!aiEnabled} onChange={(e) => setUseAi(e.target.checked)} />
              KI: Fotos automatisch drehen, Titel, Beschreibung, Hashtags und Preis erstellen</label>
          </div>
          <div className="small muted">Beim Hochladen werden alle Foto-Metadaten (GPS-Standort, Handymodell, Aufnahmezeit) entfernt.</div>
          <div className="row">
            {progress && <span className="muted">{progress}</span>}
            <div className="spacer" />
            <button className="btn primary" disabled={!!progress} onClick={create}>{groups.length} Entwürfe erstellen ({total} Fotos)</button>
          </div>
        </>
      )}

      {!!results.length && (
        <ul className="timeline">
          {results.map((r) => (
            <li key={r.folder}><span>{r.ok ? "✅" : "⚠️"}</span><strong>{r.folder}</strong><span className="muted" style={{ flex: 1 }}>{r.text}</span></li>
          ))}
        </ul>
      )}
    </div>
  );
}
