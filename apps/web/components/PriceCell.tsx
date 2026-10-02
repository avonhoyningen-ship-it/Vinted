"use client";
import { useEffect, useRef, useState } from "react";
import { api, parseEuro } from "@/lib/api";
import type { Item } from "@/lib/types";
import { useToast } from "./Toasts";

const centsText = (c: number | null | undefined) => (c ? (c % 100 ? (c / 100).toFixed(2).replace(".", ",") : String(c / 100)) : "");

/**
 * Price field right in the drafts list: click, type, Enter → saved (confirmed)
 * and the cursor jumps to the next article's price. The learned suggestion
 * shows as placeholder; Enter on an empty field takes it.
 */
export function PriceCell({ item, onChange }: { item: Item; onChange: () => void }) {
  const toast = useToast();
  const confirmed = item.price_confirmed && item.price_cents !== null ? item.price_cents : null;
  const [value, setValue] = useState(centsText(confirmed));
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const ref = useRef<HTMLInputElement>(null);
  const saved = useRef<number | null>(confirmed); // last value sent (the list reloads a moment later)

  // Take over changes from outside (bulk price, ✓ suggestions) while not typing here.
  useEffect(() => {
    saved.current = confirmed;
    if (document.activeElement !== ref.current) setValue(centsText(confirmed));
  }, [confirmed]);

  /** Checks the input right away (so the cursor can move on at once); null = invalid. */
  function target(): number | "none" | null {
    const cents = value.trim() ? parseEuro(value) : item.price_suggested_cents ?? null;
    if (!value.trim() && !cents) return "none"; // nothing typed, no suggestion
    if (!cents || cents < 50) {
      toast({ kind: "error", text: "Bitte einen Preis eingeben, z. B. 25 oder 24,50" });
      return null;
    }
    return cents;
  }

  async function save(cents: number) {
    if (cents === saved.current) return;
    saved.current = cents;
    setValue(centsText(cents));
    setState("saving");
    try {
      await api("/pricing/set", { method: "POST", json: { itemId: item.id, priceCents: cents } });
      setState("saved");
      onChange();
    } catch (e) {
      saved.current = confirmed;
      setState("idle");
      toast({ kind: "error", text: `${item.title}: ${(e as Error).message}` });
    }
  }

  /** Enter/Tab: move on immediately, save in the background. */
  function commit(step: 1 | -1) {
    const cents = target();
    if (cents === null) return;
    focusNext(step);
    if (cents !== "none") void save(cents);
  }

  function focusNext(step: 1 | -1) {
    const all = [...document.querySelectorAll<HTMLInputElement>("input[data-price-input]")];
    const next = all[all.indexOf(ref.current!) + step];
    if (next) {
      next.focus();
      next.select();
    } else ref.current?.blur();
  }

  return (
    <span className="row" style={{ justifyContent: "flex-end", gap: 4, flexWrap: "nowrap" }} title={item.price_suggestion_reason ?? ""}>
      <input
        ref={ref}
        data-price-input
        className="mono"
        style={{ width: 84, textAlign: "right" }}
        inputMode="decimal"
        value={value}
        placeholder={item.price_suggested_cents ? `${centsText(item.price_suggested_cents)}?` : "Preis"}
        aria-label={`Preis für ${item.title}`}
        onFocus={(e) => e.target.select()}
        onChange={(e) => { setValue(e.target.value); setState("idle"); }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            commit(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            setValue(centsText(confirmed));
            ref.current?.blur();
          }
        }}
        onBlur={() => {
          const cents = value.trim() ? parseEuro(value) : null;
          if (cents && cents >= 50 && cents !== saved.current) void save(cents);
        }}
      />
      <span className="small" style={{ width: 14, color: state === "saved" || confirmed ? "var(--good)" : "var(--muted)" }}>
        {state === "saving" ? "…" : confirmed ? "✓" : "€"}
      </span>
    </span>
  );
}
