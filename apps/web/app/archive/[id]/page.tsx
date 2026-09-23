"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { EnqueueDialog } from "@/components/EnqueueDialog";
import { ItemEditor } from "@/components/ItemEditor";
import { PhotoManager } from "@/components/PhotoManager";
import { useToast } from "@/components/Toasts";
import { Empty, ErrorBox, Modal, PageHead, StatusBadge } from "@/components/ui";
import { api, dateTime, euro, parseEuro } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import type { Account, Item, Listing, Photo } from "@/lib/types";

interface Detail {
  item: Item;
  photos: Photo[];
  listings: (Listing & { account_name: string; account_domain: string })[];
  priceChanges: { id: number; listing_id: number; old_price_cents: number | null; new_price_cents: number; reason: string | null; created_at: string }[];
  queue: { id: number; account_name: string; scheduled_at: string; status: string; last_error: string | null; is_reupload: number }[];
  summary: { timesListed: number; accounts: string[]; timesSold: number; lastSoldAt: string | null };
}

export default function ArchiveDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const { data, error, reload } = useApi<Detail>(`/archive/${id}`);
  const info = useApi<{ aiEnabled: boolean; vintedMode: string }>("/info");
  const [reupload, setReupload] = useState(false);
  const [manual, setManual] = useState(false);

  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  const { item, summary } = data;
  const hasActive = data.listings.some((l) => l.status === "active");

  async function setListingStatus(listingId: number, status: string) {
    let body: Record<string, unknown> = { status };
    if (status === "sold") {
      const price = prompt("Verkaufspreis (€)?", "");
      if (price === null) return;
      body = { status, soldPriceCents: parseEuro(price) ?? undefined };
    }
    try {
      await api(`/archive/${item.id}/listings/${listingId}`, { method: "PATCH", json: body });
      void reload();
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    }
  }

  return (
    <>
      <PageHead title={item.title} sub={<><StatusBadge status={item.status} /> · angelegt {dateTime(item.created_at)}</>}>
        <button className="btn primary" disabled={!data.photos.length} onClick={() => setReupload(true)}>{summary.timesListed ? "↻ Erneut einstellen" : "Einstellen"}</button>
        <button className="btn" onClick={() => setManual(true)}>Manuell erfasst…</button>
        {item.status !== "archived" && !hasActive && (
          <button className="btn" onClick={() => api(`/archive/${item.id}`, { method: "PATCH", json: { status: "archived" } }).then(() => reload())}>Archivieren</button>
        )}
        {!summary.timesListed && (
          <button className="btn danger" onClick={() => confirm("Entwurf endgültig löschen?") && api(`/archive/${item.id}`, { method: "DELETE" }).then(() => router.push("/archive")).catch((e) => toast({ kind: "error", text: e.message }))}>Löschen</button>
        )}
      </PageHead>

      <div className="grid detail-grid">
        <div className="stack">
          <div className="card"><h2>Fotos ({data.photos.length})</h2><PhotoManager itemId={item.id} photos={data.photos} onChange={reload} /></div>
          <div className="card"><h2>Artikeldaten</h2><ItemEditor item={item} aiEnabled={!!info.data?.aiEnabled} onSaved={() => reload()} /></div>
        </div>
        <div className="stack">
          <div className="card">
            <h2>Verlauf</h2>
            <div className="tiles" style={{ gridTemplateColumns: "repeat(3, 1fr)", marginBottom: 12 }}>
              <div><div className="small muted">Eingestellt</div><strong>{summary.timesListed}×</strong></div>
              <div><div className="small muted">Verkauft</div><strong>{summary.timesSold}×</strong></div>
              <div><div className="small muted">Accounts</div><strong>{summary.accounts.length}</strong></div>
            </div>
            {data.listings.length ? (
              <ul className="timeline">
                {data.listings.map((l) => (
                  <li key={l.id} style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
                    <div className="row">
                      <strong>{l.account_name}</strong><StatusBadge status={l.status} /><div className="spacer" />
                      <span className="mono">{euro(l.status === "sold" ? l.sold_price_cents ?? l.price_cents : l.price_cents, l.currency)}</span>
                    </div>
                    <div className="small muted">
                      eingestellt {dateTime(l.listed_at)}{l.sold_at && <> · verkauft {dateTime(l.sold_at)}</>}{l.ended_at && l.status !== "sold" && <> · beendet {dateTime(l.ended_at)}</>}
                      {" "}· ❤️ {l.favourites} · 👁 {l.views}
                    </div>
                    <div className="row">
                      {l.url && <a className="small" href={l.url} target="_blank" rel="noreferrer">Auf Vinted ansehen ↗</a>}
                      <div className="spacer" />
                      {l.status === "active" && <>
                        <button className="btn small" onClick={() => setListingStatus(l.id, "sold")}>Als verkauft</button>
                        <button className="btn small" onClick={() => setListingStatus(l.id, "removed")}>Beendet</button>
                      </>}
                    </div>
                  </li>
                ))}
              </ul>
            ) : <Empty>Noch nie eingestellt.</Empty>}
          </div>
          {!!data.queue.length && (
            <div className="card">
              <h2>Warteschlange</h2>
              <ul className="timeline">
                {data.queue.map((q) => (
                  <li key={q.id}><span style={{ flex: 1 }}>{q.account_name}{q.is_reupload ? " (Reupload)" : ""}{q.last_error && <div className="small" style={{ color: "var(--bad)" }}>{q.last_error}</div>}</span><StatusBadge status={q.status} /><span className="small muted">{dateTime(q.scheduled_at)}</span></li>
                ))}
              </ul>
            </div>
          )}
          {!!data.priceChanges.length && (
            <div className="card">
              <h2>Preisänderungen</h2>
              <ul className="timeline">
                {data.priceChanges.map((p) => (
                  <li key={p.id}><span style={{ flex: 1 }} className="mono">{euro(p.old_price_cents)} → {euro(p.new_price_cents)}</span><span className="small muted">{p.reason} · {dateTime(p.created_at)}</span></li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {reupload && <EnqueueDialog itemIds={[item.id]} reuploadItemId={item.id} onClose={() => setReupload(false)} onDone={() => { setReupload(false); void reload(); }} />}
      {manual && <ManualListingDialog item={item} onClose={() => setManual(false)} onDone={() => { setManual(false); void reload(); }} />}
    </>
  );
}

/** For items posted by hand on Vinted (e.g. in live mode): link the listing to the archive. */
function ManualListingDialog({ item, onClose, onDone }: { item: Item; onClose: () => void; onDone: () => void }) {
  const accounts = useApi<Account[]>("/accounts");
  const [accountId, setAccountId] = useState("");
  const [url, setUrl] = useState("");
  const [price, setPrice] = useState(item.price_cents ? (item.price_cents / 100).toFixed(2).replace(".", ",") : "");
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    try {
      await api(`/archive/${item.id}/listings`, { method: "POST", json: { accountId: Number(accountId), url: url || undefined, priceCents: parseEuro(price) ?? undefined } });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Modal title="Manuell eingestelltes Listing erfassen" onClose={onClose}>
      <div className="stack">
        <ErrorBox error={error} />
        <div className="small muted">Wenn du den Artikel selbst auf Vinted eingestellt hast, verknüpfe ihn hier, damit Verlauf, Verkaufserkennung und Statistik stimmen.</div>
        <label className="field">Account<select value={accountId} onChange={(e) => setAccountId(e.target.value)}><option value="">Bitte wählen…</option>{accounts.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        <label className="field">Vinted-Link<input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.vinted.de/items/123456789-..." /></label>
        <label className="field">Preis (€)<input value={price} onChange={(e) => setPrice(e.target.value)} /></label>
        <div className="row"><div className="spacer" /><button className="btn" onClick={onClose}>Abbrechen</button><button className="btn primary" disabled={!accountId} onClick={submit}>Speichern</button></div>
      </div>
    </Modal>
  );
}
