"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useToast } from "./Toasts";

const MAX_PHOTOS = 20; // Vinted allows at most 20 photos per listing
const isImage = (f: File) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif|avif)$/i.test(f.name);
const byName = (a: File, b: File) => a.name.localeCompare(b.name, "de", { numeric: true });

interface Group { key: string; files: File[]; measurements: string; hint: string }
type Mode = "perFolder" | "grouped";

let keySeq = 0;
const newKey = () => `g${++keySeq}`;

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
  const [hints, setHints] = useState("");
  const [useAi, setUseAi] = useState(true);
  const [progress, setProgress] = useState<string | null>(null);
  const [results, setResults] = useState<{ key: string; label: string; ok: boolean; text: string }[]>([]);

  const allFiles = useMemo(() => [...folders.values()].flat(), [folders]);
  const urls = useMemo(() => new Map(allFiles.map((f) => [f, URL.createObjectURL(f)])), [allFiles]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);

  function pick(files: File[]) {
    const map = new Map<string, File[]>();
    for (const f of files.filter(isImage)) {
      const parts = (f.webkitRelativePath || f.name).split("/");
      const folder = parts.length > 1 ? parts[parts.length - 2]! : "Ohne Ordner";
      map.set(folder, [...(map.get(folder) ?? []), f]);
    }
    for (const fs of map.values()) fs.sort(byName);
    const sorted = new Map([...map].sort(([a], [b]) => a.localeCompare(b, "de", { numeric: true })));
    setFolders(sorted);
    setResults([]);
    // One folder with many photos → most likely several articles in one folder.
    const m: Mode = sorted.size === 1 && [...sorted.values()][0]!.length > 8 ? "grouped" : "perFolder";
    setMode(m);
    setGroups(m === "perFolder" ? perFolderGroups(sorted) : []);
  }

  const perFolderGroups = (map: Map<string, File[]>): Group[] =>
    [...map].map(([folder, fs]) => ({ key: newKey(), files: fs, measurements: folder.replace(/_+/g, " ").trim(), hint: "" }));

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
      setProgress(`KI ordnet ${files.length} Fotos den Kleidungsstücken zu…`);
      const r = await api<{ groups: number[][] }>("/listings/group-photos", { method: "POST", body: fd });
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
      const label = g.measurements || `Artikel ${i + 1}`;
      setProgress(`Artikel ${i + 1} von ${groups.length} ${useAi && aiEnabled ? "– KI dreht Fotos und schreibt die Beschreibung…" : "wird angelegt…"}`);
      const fd = new FormData();
      g.files.slice(0, MAX_PHOTOS).forEach((f) => fd.append("photos", f, f.name));
      if (g.measurements.trim()) fd.append("data", JSON.stringify({ measurements: g.measurements.trim() }));
      const hint = [hints, g.hint].filter((h) => h.trim()).join(". ");
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
    <div className="card stack">
      <div className="row">
        <button className="btn primary" disabled={!!progress} onClick={() => input.current?.click()}>📁 Ordner auswählen</button>
        {!!total && <span className="muted">{total} Fotos in {folders.size} Ordner{folders.size === 1 ? "" : "n"}</span>}
        <input ref={input} type="file" hidden multiple {...{ webkitdirectory: "", directory: "" }} onChange={(e) => { pick([...(e.target.files ?? [])]); e.target.value = ""; }} />
      </div>

      {!!total && (
        <div className="stack" style={{ gap: 6 }}>
          <label className="row"><input type="radio" name="mode" checked={mode === "grouped"} onChange={() => switchMode("grouped")} />
            <span><strong>Alle Kleidungsstücke in einem Ordner</strong> – Fotos liegen der Reihe nach, die KI ordnet sie den Artikeln zu</span></label>
          <label className="row"><input type="radio" name="mode" checked={mode === "perFolder"} onChange={() => switchMode("perFolder")} />
            <span><strong>Ein Ordner pro Kleidungsstück</strong> – der Ordnername enthält die Maße</span></label>
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
                    <div className="photo" key={f.webkitRelativePath || f.name} style={{ width: 72, height: 90 }} title={f.name}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={urls.get(f)} alt={f.name} loading="lazy" />
                      {p > 0 && <button className="x" onClick={() => splitAt(i, p)} title="Ab hier neuer Artikel" aria-label="Ab hier neuer Artikel">✂</button>}
                    </div>
                  ))}
                </div>
                <div className="form-grid">
                  <label className="field">Maße<input value={g.measurements} placeholder="z. B. Länge 70 cm, Breite 55 cm" onChange={(e) => update(i, { measurements: e.target.value })} /></label>
                  <label className="field">Hinweis für diesen Artikel<input value={g.hint} placeholder="z. B. kleiner Fleck am Ärmel" onChange={(e) => update(i, { hint: e.target.value })} /></label>
                </div>
              </div>
            ))}
          </div>
          <div className="form-grid">
            <label className="field span-all">Hinweise für alle Artikel (Zustand, Passform, Besonderheiten, Wunsch-Hashtags)
              <input value={hints} onChange={(e) => setHints(e.target.value)} placeholder="z. B. Zustand sehr gut, fällt normal aus" />
            </label>
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
