"use client";
import { useRef, useState } from "react";
import { api, photoUrl } from "@/lib/api";
import type { Photo } from "@/lib/types";
import { useToast } from "./Toasts";

export function Dropzone({ onFiles, label, multiple = true }: { onFiles: (files: File[]) => void; label: string; multiple?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      className={`dropzone ${over ? "over" : ""}`}
      onClick={() => input.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith("image/"));
        if (files.length) onFiles(files);
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && input.current?.click()}
    >
      {label}
      <input ref={input} type="file" accept="image/*" multiple={multiple} hidden onChange={(e) => {
        const files = [...(e.target.files ?? [])];
        e.target.value = "";
        if (files.length) onFiles(files);
      }} />
    </div>
  );
}

/** Photo list for an archive item: upload more, delete, reorder. */
export function PhotoManager({ itemId, photos, onChange }: { itemId: number; photos: Photo[]; onChange: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function upload(files: File[]) {
    setBusy(true);
    try {
      const fd = new FormData();
      files.forEach((f) => fd.append("photos", f));
      await api(`/archive/${itemId}/photos`, { method: "POST", body: fd });
      onChange();
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function move(index: number, dir: -1 | 1) {
    const ids = photos.map((p) => p.id);
    const j = index + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j]!, ids[index]!];
    await api(`/archive/${itemId}/photos/order`, { method: "PUT", json: { ids } });
    onChange();
  }

  async function remove(id: number) {
    if (!confirm("Foto entfernen?")) return;
    await api(`/archive/${itemId}/photos/${id}`, { method: "DELETE" });
    onChange();
  }

  return (
    <div className="stack">
      <div className="photo-strip">
        {photos.map((p, i) => (
          <div className="photo" key={p.id}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={photoUrl(p.file_name)!} alt={`Foto ${i + 1}`} />
            <button className="x" onClick={() => remove(p.id)} aria-label="Foto entfernen">✕</button>
            <div className="arrows">
              <button onClick={() => move(i, -1)} disabled={i === 0} aria-label="nach vorne">◀</button>
              <button onClick={() => move(i, 1)} disabled={i === photos.length - 1} aria-label="nach hinten">▶</button>
            </div>
          </div>
        ))}
      </div>
      <Dropzone onFiles={upload} label={busy ? "Lade hoch…" : "Fotos hinzufügen (klicken oder hierher ziehen)"} />
      <div className="small muted">Beim Hochladen werden EXIF-Metadaten (z. B. GPS-Standort, Kameradaten) aus Datenschutzgründen entfernt.</div>
    </div>
  );
}
