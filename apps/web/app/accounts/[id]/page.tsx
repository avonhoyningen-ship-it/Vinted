"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { AccountForm } from "@/components/AccountForm";
import { useToast } from "@/components/Toasts";
import { Empty, ErrorBox, Modal, PageHead, StatusBadge, Thumb, Tile } from "@/components/ui";
import { api, dateTime, euro, photoUrl, relative } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import type { Account, Listing } from "@/lib/types";

interface Detail {
  account: Account;
  listings: Listing[];
  recentSales: { id: number; title: string; price_cents: number; currency: string; buyer: string | null; sold_at: string; item_id: number | null }[];
  recentEvents: { id: number; type: string; vinted_username: string | null; occurred_at: string; payload: string }[];
  totals: { sales: number; revenue_cents: number };
  queuedCount: number;
}

export default function AccountDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const { data, error, reload } = useApi<Detail>(`/accounts/${id}`);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      toast({ kind: "info", text: label });
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
      void reload();
    }
  }

  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  const a = data.account;

  return (
    <>
      <PageHead title={a.name} sub={<>{a.domain}{a.username && <> · @{a.username}</>} · <StatusBadge status={a.status} /></>}>
        <button className="btn" disabled={busy || !a.has_session} onClick={() => run("Synchronisiert", () => api<{ result: { warnings: string[] } }>(`/accounts/${id}/sync`, { method: "POST" })
          .then((r) => r.result.warnings.forEach((w) => toast({ kind: "error", text: w }))))}>Synchronisieren</button>
        <button className="btn" onClick={() => setEditing(true)}>Bearbeiten</button>
        {a.has_session && (
          <button className="btn danger" disabled={busy} onClick={() => confirm("Session-Token löschen? Archivdaten bleiben erhalten.") && run("Getrennt", () => api(`/accounts/${id}/disconnect`, { method: "POST" }))}>Trennen</button>
        )}
        <button className="btn danger" disabled={busy} onClick={() => confirm("Account endgültig löschen? (Nur möglich, wenn keine Listings existieren)") &&
          api(`/accounts/${id}`, { method: "DELETE" }).then(() => router.push("/accounts")).catch((e) => toast({ kind: "error", text: e.message }))}>Löschen</button>
      </PageHead>
      {a.last_error && <div className="alert bad" style={{ marginBottom: 16 }}>{a.last_error}</div>}

      <div className="stack">
        <div className="tiles">
          <Tile label="Aktive Listings" value={a.active_listings} />
          <Tile label="Verkäufe (Vinted)" value={a.total_sales} sub={`${data.totals.sales} im Dashboard erfasst`} />
          <Tile label="Umsatz (erfasst)" value={euro(data.totals.revenue_cents)} />
          <Tile label="Ungelesene Nachrichten" value={a.unread_messages} />
          <Tile label="Follower" value={a.followers} />
          <Tile label="In Warteschlange" value={data.queuedCount} sub={`Letzter Sync ${relative(a.last_sync_at)}`} />
        </div>


        <div className="card">
          <h2>Aktive Listings ({data.listings.length})</h2>
          {data.listings.length ? (
            <div className="table-wrap">
              <table>
                <thead><tr><th></th><th>Titel</th><th className="num">Preis</th><th className="num">❤️</th><th className="num">👁</th><th>Online seit</th><th></th></tr></thead>
                <tbody>
                  {data.listings.map((l) => (
                    <tr key={l.id}>
                      <td style={{ width: 56 }}><Thumb src={photoUrl(l.cover_photo)} /></td>
                      <td><Link href={`/archive/${l.item_id}`}>{l.title}</Link></td>
                      <td className="num">{euro(l.price_cents, l.currency)}</td>
                      <td className="num">{l.favourites}</td>
                      <td className="num">{l.views}</td>
                      <td>{dateTime(l.listed_at)}</td>
                      <td>{l.url && <a href={l.url} target="_blank" rel="noreferrer">Vinted ↗</a>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <Empty>Keine aktiven Listings.</Empty>}
        </div>

        <div className="grid grid-2">
          <div className="card">
            <h2>Letzte Verkäufe</h2>
            {data.recentSales.length ? (
              <ul className="timeline">
                {data.recentSales.map((s) => (
                  <li key={s.id}>
                    <span style={{ flex: 1 }}>{s.item_id ? <Link href={`/archive/${s.item_id}`}>{s.title}</Link> : s.title}{s.buyer && <span className="muted"> · {s.buyer}</span>}</span>
                    <strong className="mono">{euro(s.price_cents, s.currency)}</strong>
                    <span className="small muted">{dateTime(s.sold_at)}</span>
                  </li>
                ))}
              </ul>
            ) : <Empty>Noch keine Verkäufe erfasst.</Empty>}
          </div>
          <div className="card">
            <h2>Ereignisse</h2>
            {data.recentEvents.length ? (
              <ul className="timeline">
                {data.recentEvents.map((e) => (
                  <li key={e.id}>
                    <span style={{ minWidth: 90 }}>{e.type === "sale" ? "💰 Verkauf" : e.type === "favourite" ? "❤️ Favorit" : "💬 Nachricht"}</span>
                    <span style={{ flex: 1 }}>{e.vinted_username}{e.type === "message" && <span className="muted"> – {JSON.parse(e.payload).text}</span>}</span>
                    <span className="small muted">{dateTime(e.occurred_at)}</span>
                  </li>
                ))}
              </ul>
            ) : <Empty>Keine Ereignisse.</Empty>}
          </div>
        </div>
      </div>

      {editing && (
        <Modal title="Account bearbeiten" onClose={() => setEditing(false)}>
          <AccountForm initial={a} onSaved={() => { setEditing(false); void reload(); }} onCancel={() => setEditing(false)} />
        </Modal>
      )}
    </>
  );
}
