"use client";
import { useEffect, useState } from "react";
import { api, centsToInput, CONDITIONS, parseEuro } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import type { Item, Suggestion, Template } from "@/lib/types";
import { useToast } from "./Toasts";
import { ErrorBox } from "./ui";

type Form = {
  title: string; description: string; category: string; brand: string; size: string; condition: string;
  color: string; material: string; measurements: string; price: string; purchase: string; notes: string;
};

const toForm = (i: Item): Form => ({
  title: i.title, description: i.description, category: i.category ?? "", brand: i.brand ?? "", size: i.size ?? "",
  condition: i.condition ?? "", color: i.color ?? "", material: i.material ?? "", measurements: i.measurements ?? "",
  price: centsToInput(i.price_cents), purchase: centsToInput(i.purchase_price_cents), notes: i.notes ?? "",
});

/** Edit form for an archive item, incl. text templates and AI fill-in. */
export function ItemEditor({ item, onSaved, aiEnabled, onPhotosChanged }: { item: Item; onSaved: (i: Item) => void; aiEnabled: boolean; onPhotosChanged?: () => void }) {
  const toast = useToast();
  const [f, setF] = useState<Form>(toForm(item));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hints, setHints] = useState("");
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const templates = useApi<Template[]>("/listings/templates");

  useEffect(() => setF(toForm(item)), [item]);
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));
  const dirty = JSON.stringify(f) !== JSON.stringify(toForm(item));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const empty = (s: string) => (s.trim() ? s.trim() : null);
      const saved = await api<Item>(`/archive/${item.id}`, {
        method: "PATCH",
        json: {
          title: f.title, description: f.description, category: empty(f.category), brand: empty(f.brand), size: empty(f.size),
          condition: f.condition || null, color: empty(f.color), material: empty(f.material), measurements: empty(f.measurements),
          price_cents: parseEuro(f.price), purchase_price_cents: parseEuro(f.purchase), notes: empty(f.notes),
        },
      });
      onSaved(saved);
      toast({ kind: "info", text: "Gespeichert" });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function runAi() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ suggestion: Suggestion; item: Item }>(`/listings/drafts/${item.id}/ai`, { method: "POST", json: { apply: false, hints: hints || undefined } });
      setSuggestion(r.suggestion);
      onPhotosChanged?.(); // the AI rotates photos upright
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function applySuggestion() {
    if (!suggestion) return;
    setF((p) => ({
      ...p, title: suggestion.title, description: suggestion.description, category: suggestion.category,
      brand: suggestion.brand ?? p.brand, size: suggestion.size ?? p.size, condition: suggestion.condition,
      color: suggestion.color ?? p.color, material: suggestion.material ?? p.material,
      price: suggestion.suggested_price_eur.toFixed(2).replace(".", ","),
    }));
    setSuggestion(null);
  }

  function insertTemplate(id: string) {
    const t = templates.data?.find((x) => String(x.id) === id);
    if (t) setF((p) => ({ ...p, description: p.description.trim() ? `${p.description.trim()}\n\n${t.body}` : t.body }));
  }

  return (
    <div className="stack">
      <ErrorBox error={error} />
      {aiEnabled && (
        <div className="row">
          <input style={{ flex: 1, minWidth: 180 }} value={hints} onChange={(e) => setHints(e.target.value)} placeholder="Hinweise für die KI (optional), z. B. „Größe M, kleiner Fleck am Ärmel“" />
          <button className="btn" disabled={busy} onClick={runAi}>✨ Mit KI ausfüllen</button>
        </div>
      )}
      {suggestion && (
        <div className="alert info stack">
          <div><strong>KI-Vorschlag:</strong> {suggestion.title} · {suggestion.suggested_price_eur.toFixed(2)} € <span className="muted">({suggestion.price_reasoning})</span></div>
          {suggestion.confidence_notes && <div className="small">Bitte prüfen: {suggestion.confidence_notes}</div>}
          <div className="row"><button className="btn small primary" onClick={applySuggestion}>Übernehmen</button><button className="btn small" onClick={() => setSuggestion(null)}>Verwerfen</button></div>
        </div>
      )}
      <div className="form-grid">
        <label className="field span-all">Titel<input value={f.title} maxLength={200} onChange={set("title")} /></label>
        <label className="field span-all">
          <span className="row">Beschreibung <span className="spacer" />
            {!!templates.data?.length && (
              <select style={{ width: "auto" }} value="" onChange={(e) => insertTemplate(e.target.value)}>
                <option value="">+ Vorlage einfügen</option>
                {templates.data.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            )}
          </span>
          <textarea rows={7} value={f.description} onChange={set("description")} />
        </label>
        <label className="field">Kategorie<input value={f.category} onChange={set("category")} placeholder="Damen > Kleidung > Jacken" /></label>
        <label className="field">Marke<input value={f.brand} onChange={set("brand")} /></label>
        <label className="field">Größe<input value={f.size} onChange={set("size")} /></label>
        <label className="field">Zustand
          <select value={f.condition} onChange={set("condition")}>
            <option value="">–</option>
            {Object.entries(CONDITIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="field">Farbe<input value={f.color} onChange={set("color")} /></label>
        <label className="field">Material<input value={f.material} onChange={set("material")} /></label>
        <label className="field span-all">Maße<input value={f.measurements} onChange={set("measurements")} placeholder="z. B. Länge 68 cm, Achsel-Achsel 52 cm" /></label>
        <label className="field">Preis (€)<input inputMode="decimal" value={f.price} onChange={set("price")} /></label>
        <label className="field">Einkaufspreis (€, optional)<input inputMode="decimal" value={f.purchase} onChange={set("purchase")} /></label>
        <label className="field span-all">Interne Notizen<input value={f.notes} onChange={set("notes")} /></label>
      </div>
      <div className="row">
        <div className="spacer" />
        {dirty && <span className="small muted">Ungespeicherte Änderungen</span>}
        <button className="btn primary" disabled={busy || !dirty || !f.title.trim()} onClick={save}>Speichern</button>
      </div>
    </div>
  );
}
