"use client";
import { useRef, useState } from "react";
import { api } from "@/lib/api";
import { useToast } from "./Toasts";

/** "📷 +" – picks photos from the computer/phone and appends them to an item. */
export function AddPhotosButton({ itemId, onDone }: { itemId: number; onDone?: () => void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function upload(files: File[]) {
    if (!files.length) return;
    setBusy(true);
    try {
      for (let i = 0; i < files.length; i += 20) {
        const fd = new FormData();
        files.slice(i, i + 20).forEach((f) => fd.append("photos", f));
        await api(`/archive/${itemId}/photos`, { method: "POST", body: fd });
      }
      toast({ kind: "info", text: `${files.length} Foto(s) hinzugefügt` });
      onDone?.();
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <>
      <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => upload([...(e.target.files ?? [])])} />
      <button className="btn small" disabled={busy} title="Fotos ergänzen" onClick={() => input.current?.click()}>{busy ? "Lädt…" : "📷 +"}</button>
    </>
  );
}
