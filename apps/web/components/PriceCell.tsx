"use client";
import { api, euro } from "@/lib/api";
import type { Item } from "@/lib/types";
import { useToast } from "./Toasts";

/** Confirmed price, or the learned suggestion with a one-click ✓. */
export function PriceCell({ item, onChange }: { item: Item; onChange: () => void }) {
  const toast = useToast();
  if (item.price_confirmed && item.price_cents !== null) return <span className="mono">{euro(item.price_cents, item.currency)}</span>;
  if (!item.price_suggested_cents) return <span className="muted small">kein Vorschlag</span>;
  const accept = () => api("/pricing/accept", { method: "POST", json: { itemIds: [item.id] } })
    .then(onChange).catch((e) => toast({ kind: "error", text: e.message }));
  return (
    <span className="row" style={{ justifyContent: "flex-end", gap: 6, flexWrap: "nowrap" }} title={item.price_suggestion_reason ?? ""}>
      <span className="mono muted">{euro(item.price_suggested_cents, item.currency)}?</span>
      <button className="btn small primary" onClick={accept} aria-label="Preisvorschlag übernehmen">✓</button>
    </span>
  );
}
