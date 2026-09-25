"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useToast } from "./Toasts";

const MAX_PHOTOS = 20; // Vinted allows at most 20 photos per listing
const isImage = (f: File) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif|avif)$/i.test(f.name);
const byName = (a: File, b: File) => a.name.localeCompare(b.name, "de", { numeric: true });

interface Group { key: string; files: File[]; measurements: string; hint: string }
type Mode = "perFolder" | "grouped";
type Rotation = 0 | 90 | 180 | 270;

interface PickedFile { file: File; path: string }

/** Reads dropped folders recursively (Explorer/Finder drag & drop). */
async function filesFromDrop(dt: DataTransfer): Promise<PickedFile[]> {
  const out: PickedFile[] = [];
  const walk = async (entry: FileSystemEntry | null, path: string): Promise<void> => {
    if (!entry) return;
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ file, path: path + file.name });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries returns at most ~100 entries per call – read until empty.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e, `${path}${entry.name}/`);
      }
    }
  };
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.() ?? null);
  if (entries.some(Boolean)) {
    for (const e of entries) await walk(e, "");
  } else {
    for (const f of dt.files) out.push({ file: f, path: f.name });
  }
  return out;
}

let keySeq = 0;
const newKey = () => `g${++keySeq}`;

/** Shows a thumbnail rotated inside its 72×90 box (swapping sides for 90°/270°). */
function rotatedStyle(deg: Rotation): React.CSSProperties {
  if (!deg) return {};
  const side = deg % 180 !== 0;
  return {
    position: "absolute", top: "50%", left: "50%", width: side ? 90 : 72, height: side ? 72 : 90,
    transform: `translate(-50%, -50%) rotate(${deg}deg)`,
  };
}

/** Small JPEG preview for the AI grouping step (keeps the upload light). */
async function thumbnail(f: File): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(f);
    const scale = Math.min(1, 512 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    return await new Promise((resolve) => canvas.toBlob((b) => resolve(b ?? f), "image/jpeg", 0.7));
  } catch {
    return f; // format the browser can't decode – let the server try
  }
}

/**
 * Folder upload in two modes:
 * - perFolder: every (sub)folder is one article, the folder name holds the measurements
 * - grouped:   all photos of all articles in ONE folder, in order; the AI finds where
 *              a new article starts, the user can fix the groups before creating drafts
 */
export function FolderUpload({ aiEnabled, onDone }: { aiEnabled: boolean; onDone: () => void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [folders, setFolders] = useState<Map<string, File[]>>(new Map());
  const [mode, setMode] = useState<Mode>("perFolder");
  const [groups, setGroups] = useState<Group[]>([]);
  // Details for the whole folder (apply to every article unless overridden).
  const [folderMeasurements, setFolderMeasurements] = useState("");
  const [folderSize, setFolderSize] = useState("");
  const [hints, setHints] = useState("");
  const [useAi, setUseAi] = useState(true);
  const [progress, setProgress] = useState<string | null>(null);
  // Clockwise rotation per photo: from the AI check, adjustable by click.
  const [rot, setRot] = useState<Map<File, Rotation>>(new Map());
  const turn = (f: File) => setRot(new Map(rot).set(f, (((rot.get(f) ?? 0) + 90) % 360) as Rotation));
  const [results, setResults] = useState<{ key: string; label: string; ok: boolean; text: string }[]>([]);

  const allFiles = useMemo(() => [...folders.values()].flat(), [folders]);
  const urls = useMemo(() => new Map(allFiles.map((f) => [f, URL.createObjectURL(f)])), [allFiles]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);

  const [over, setOver] = useState(false);

  function pick(picked: PickedFile[]) {
    const map = new Map<string, File[]>();
    for (const { file: f, path } of picked.filter((p) => isImage(p.file))) {
      const parts = path.split("/");
      const folder = parts.length > 1 ? parts[parts.length - 2]! : "Ohne Ordner";
      map.set(folder, [...(map.get(folder) ?? []), f]);
    }
    for (const fs of map.values()) fs.sort(byName);
    const sorted = new Map([...map].sort(([a], [b]) => a.localeCompare(b, "de", { numeric: true })));
    setFolders(sorted);
    setResults([]);
    setRot(new Map());
    // A single folder's name holds the measurements that apply to all its articles.
    setFolderMeasurements(sorted.size === 1 ? cleanName([...sorted.keys()][0]!) : "");
    // One folder with many photos → most likely several articles in one folder.
    const m: Mode = sorted.size === 1 && [...sorted.values()][0]!.length > 8 ? "grouped" : "perFolder";
    setMode(m);
    setGroups(m === "perFolder" ? perFolderGroups(sorted) : []);
  }

  const cleanName = (folder: string) => (folder === "Ohne Ordner" ? "" : folder.replace(/_+/g, " ").trim());
  const perFolderGroups = (map: Map<string, File[]>): Group[] =>
    map.size === 1
      ? [...map].map(([, fs]) => ({ key: newKey(), files: fs, measurements: "", hint: "" })) // uses the folder-wide value
      : [...map].map(([folder, fs]) => ({ key: newKey(), files: fs, measurements: cleanName(folder), hint: "" }));

  function switchMode(m: Mode) {
    setMode(m);
    setGroups(m === "perFolder" ? perFolderGroups(folders) : []);
  }

  async function autoGroup() {
    const files = [...folders.values()].flat();
    setProgress(`Bereite ${files.length} Fotos vor…`);
    try {
      const fd = new FormData();
      for (const [i, f] of files.entries()) {
        if (i % 20 === 0) setProgress(`Bereite Fotos vor… ${i} / ${files.length}`);
        fd.append("photos", await thumbnail(f), f.name);
      }
      setProgress(`KI ordnet ${files.length} Fotos den Kleidungsstücken zu und dreht sie richtig herum…`);
      const r = await api<{ groups: number[][]; rotations: Rotation[] }>("/listings/group-photos", { method: "POST", body: fd });
      setRot(new Map(files.map((f, i) => [f, r.rotations[i] ?? 0])));
      setGroups(r.groups.map((idx) => ({ key: newKey(), files: idx.map((i) => files[i]!), measurements: "", hint: "" })));
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    } finally {
      setProgress(null);
    }
  }

  const update = (i: number, patch: Partial<Group>) => setGroups(groups.map((g, j) => (j === i ? { ...g, ...patch } : g)));
  const mergeWithPrevious = (i: number) =>
    setGroups(groups.flatMap((g, j) => (j === i ? [] : j === i - 1 ? [{ ...g, files: [...g.files, ...groups[i]!.files] }] : [g])));
  const splitAt = (i: number, photo: number) =>
    setGroups(groups.flatMap((g, j) => (j === i
      ? [{ ...g, files: g.files.slice(0, photo) }, { key: newKey(), files: g.files.slice(photo), measurements: "", hint: "" }]
      : [g])));

  async function create() {
    const out: typeof results = [];
    for (const [i, g] of groups.entries()) {
      const measurements = (g.measurements || folderMeasurements).trim();
      const label = g.measurements || `Artikel ${i + 1}`;
      setProgress(`Artikel ${i + 1} von ${groups.length} ${useAi && aiEnabled ? "– KI dreht Fotos und schreibt die Beschreibung…" : "wird angelegt…"}`);
      const fd = new FormData();
      const sent = g.files.slice(0, MAX_PHOTOS);
      sent.forEach((f) => fd.append("photos", f, f.name));
      // Rotations checked in the preview: the server applies them and skips its own check.
      if (sent.some((f) => rot.has(f))) fd.append("rotations", JSON.stringify(sent.map((f) => rot.get(f) ?? 0)));
      const data = { ...(measurements ? { measurements } : {}), ...(folderSize.trim() ? { size: folderSize.trim() } : {}) };
      if (Object.keys(data).length) fd.append("data", JSON.stringify(data));
      const hint = [folderSize.trim() && `Größe: ${folderSize.trim()}`, hints, g.hint].filter((h) => h && h.trim()).join(". ");
      if (hint) fd.append("hints", hint);
      if (useAi && aiEnabled) fd.append("ai", "true");
      try {
        const r = await api<{ item: { title: string }; aiError: string | null }>("/listings/drafts", { method: "POST", body: fd });
        out.push({ key: g.key, label, ok: !r.aiError, text: r.aiError ? `Entwurf angelegt, KI-Fehler: ${r.aiError}` : r.item.title });
      } catch (e) {
        out.push({ key: g.key, label, ok: false, text: (e as Error).message });
      }
      setResults([...out]);
    }
    setProgress(null);
    const ok = out.filter((r) => r.ok).length;
    toast({ kind: ok === out.length ? "info" : "error", text: `${ok} von ${out.length} Entwürfen fertig` });
    if (ok === out.length) { setGroups([]); setFolders(new Map()); onDone(); }
  }

  const total = allFiles.length;

  return (
    <div
      className="card stack"
      onDragOver={(e) => { e.preventDefault(); if (!progress) setOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false); }}
      onDrop={async (e) => {
        e.preventDefault();
        setOver(false);
        if (progress) return;
        const picked = await filesFromDrop(e.dataTransfer);
        if (!picked.some((p) => isImage(p.file))) toast({ kind: "error", text: "Keine Fotos im gezogenen Ordner gefunden" });
        else pick(picked);
      }}
    >
      <div className={`dropzone ${over ? "over" : ""}`} onClick={() => !progress && input.current?.click()} role="button" tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && input.current?.click()}>
        <div style={{ fontSize: 28 }}>📁</div>
        <strong>Ordner hierher ziehen</strong> oder klicken zum Auswählen
        <div className="small muted">Alle Kleidungsstücke in einem Ordner, oder ein Oberordner mit einem Unterordner pro Kleidungsstück</div>
      </div>
      <div className="row">
        {!!total && <span className="muted">{total} Fotos in {folders.size} Ordner{folders.size === 1 ? "" : "n"}</span>}
        <input ref={input} type="file" hidden multiple {...{ webkitdirectory: "", directory: "" }} onChange={(e) => { pick([...(e.target.files ?? [])].map((f) => ({ file: f, path: f.webkitRelativePath || f.name }))); e.target.value = ""; }} />
      </div>

      {!!total && (
        <div className="stack" style={{ gap: 6 }}>
          <label className="row"><input type="radio" name="mode" checked={mode === "grouped"} onChange={() => switchMode("grouped")} />
            <span><strong>Alle Kleidungsstücke in einem Ordner</strong> – Fotos liegen der Reihe nach, die KI ordnet sie den Artikeln zu</span></label>
          <label className="row"><input type="radio" name="mode" checked={mode === "perFolder"} onChange={() => switchMode("perFolder")} />
            <span><strong>Ein Ordner pro Kleidungsstück</strong> – der Ordnername enthält die Maße</span></label>
        </div>
      )}

      {!!total && (
        <div className="card stack" style={{ padding: 12, background: "var(--surface-2)" }}>
          <strong>Angaben für den ganzen Ordner</strong>
          <div className="small muted">Gelten für alle Artikel; pro Artikel kannst du sie unten überschreiben.</div>
          <div className="form-grid">
            <label className="field">Maße {folders.size === 1 && <span className="muted">(aus dem Ordnernamen)</span>}
              <input value={folderMeasurements} onChange={(e) => setFolderMeasurements(e.target.value)} placeholder="z. B. Länge 70 cm, Breite 55 cm" />
            </label>
            <label className="field">Größe<input value={folderSize} onChange={(e) => setFolderSize(e.target.value)} placeholder="z. B. S–M" /></label>
            <label className="field span-all">Weitere Details (Zustand, Passform, Besonderheiten, Wunsch-Hashtags)
              <input value={hints} onChange={(e) => setHints(e.target.value)} placeholder="z. B. Zustand sehr gut, fällt normal aus, #bandshirt" />
            </label>
          </div>
        </div>
      )}

      {mode === "grouped" && !!total && !groups.length && (
        <div className="row">
          <button className="btn primary" disabled={!!progress || !aiEnabled} onClick={autoGroup}>✨ KI ordnet {total} Fotos zu</button>
          {!aiEnabled && <span className="small" style={{ color: "var(--warn)" }}>Dafür wird die KI benötigt (ANTHROPIC_API_KEY).</span>}
        </div>
      )}

      {!!groups.length && (
        <>
          <div className="small muted">
            {groups.length} Artikel erkannt. Prüfe die Zuordnung: <strong>✂</strong> auf einem Foto trennt ab dort einen neuen Artikel ab,
            „↑ zusammenführen“ hängt eine Gruppe an die vorherige an.
          </div>
          <div className="stack">
            {groups.map((g, i) => (
              <div key={g.key} className="card stack" style={{ padding: 12, background: "var(--surface-2)" }}>
                <div className="row">
                  <strong>Artikel {i + 1}</strong>
                  <span className="muted small">{g.files.length} Fotos{g.files.length > MAX_PHOTOS && ` – nur die ersten ${MAX_PHOTOS} (Vinted-Limit)`}</span>
                  <div className="spacer" />
                  {i > 0 && <button className="btn small" onClick={() => mergeWithPrevious(i)}>↑ mit vorherigem zusammenführen</button>}
                  <button className="btn small ghost" onClick={() => setGroups(groups.filter((_, j) => j !== i))} aria-label="Artikel entfernen">✕</button>
                </div>
                <div className="photo-strip">
                  {g.files.map((f, p) => (
                    <div className="photo" key={`${p}-${f.name}`} style={{ width: 72, height: 90 }} title={f.name}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={urls.get(f)} alt={f.name} loading="lazy" style={rotatedStyle(rot.get(f) ?? 0)} />
                      <button className="rot" onClick={() => turn(f)} title="Foto um 90° drehen" aria-label="Foto drehen">↻</button>
                      {p > 0 && <button className="x" onClick={() => splitAt(i, p)} title="Ab hier neuer Artikel" aria-label="Ab hier neuer Artikel">✂</button>}
                    </div>
                  ))}
                </div>
                <div className="form-grid">
                  <label className="field">Maße (nur falls abweichend)<input value={g.measurements} placeholder={folderMeasurements ? `wie Ordner: ${folderMeasurements}` : "z. B. Länge 70 cm, Breite 55 cm"} onChange={(e) => update(i, { measurements: e.target.value })} /></label>
                  <label className="field">Hinweis für diesen Artikel<input value={g.hint} placeholder="z. B. kleiner Fleck am Ärmel" onChange={(e) => update(i, { hint: e.target.value })} /></label>
                </div>
              </div>
            ))}
          </div>
          <div className="form-grid">
            <label className="row span-all"><input type="checkbox" checked={useAi && aiEnabled} disabled={!aiEnabled} onChange={(e) => setUseAi(e.target.checked)} />
              KI: Fotos automatisch drehen, Titel, Beschreibung, Hashtags und Preis erstellen</label>
          </div>
          <div className="small muted">Beim Hochladen werden alle Foto-Metadaten (GPS-Standort, Handymodell, Aufnahmezeit) entfernt.</div>
          <div className="row">
            <div className="spacer" />
            <button className="btn primary" disabled={!!progress} onClick={create}>{groups.length} Entwürfe erstellen</button>
          </div>
        </>
      )}

      {progress && <div className="alert info">{progress}</div>}

      {!!results.length && (
        <ul className="timeline">
          {results.map((r) => (
            <li key={r.key}><span>{r.ok ? "✅" : "⚠️"}</span><strong>{r.label}</strong><span className="muted" style={{ flex: 1 }}>{r.text}</span></li>
          ))}
        </ul>
      )}
    </div>
  );
}
