"use client";
import Link from "next/link";
import { useEffect } from "react";
import { PageHead, Tile, Empty, ErrorBox, StatusBadge } from "@/components/ui";
import { dateTime, euro, relative } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import type { Account } from "@/lib/types";

interface Dashboard {
  accounts: { total: number; connected: number | null; errors: number | null };
  today: { sales: number; revenue_cents: number };
  month: { sales: number; revenue_cents: number };
  activeListings: number;
  queue: { pending: number; next_at: string | null };
  failedQueue: number;
  pendingActions: number;
  drafts: number;
  archiveTotal: number;
  recentEvents: { type: string; vinted_username: string | null; occurred_at: string; account_name: string; title: string | null; payload: string }[];
}

const EVENT_LABEL: Record<string, string> = { sale: "💰 Verkauf", favourite: "❤️ Favorit", message: "💬 Nachricht" };

export default function DashboardPage() {
  const { data, error, reload } = useApi<Dashboard>("/dashboard");
  const accounts = useApi<Account[]>("/accounts");

  useEffect(() => {
    const r = () => { void reload(); void accounts.reload(); };
    window.addEventListener("dashboard-refresh", r);
    return () => window.removeEventListener("dashboard-refresh", r);
  }, [reload, accounts]);

  return (
    <>
      <PageHead title="Übersicht" sub="Alle Accounts auf einen Blick">
        <Link className="btn primary" href="/listings">+ Neuer Artikel</Link>
      </PageHead>
      <ErrorBox error={error} />
      {data && (
        <div className="stack">
          <div className="tiles">
            <Tile label="Umsatz heute" value={euro(data.today.revenue_cents)} sub={`${data.today.sales} Verkäufe`} />
            <Tile label="Umsatz diesen Monat" value={euro(data.month.revenue_cents)} sub={`${data.month.sales} Verkäufe`} />
            <Tile label="Aktive Listings" value={data.activeListings} sub={`${data.accounts.connected ?? 0} / ${data.accounts.total} Accounts verbunden`} />
            <Tile label="Warteschlange" value={data.queue.pending} sub={data.queue.next_at ? `nächste ${relative(data.queue.next_at)}` : "leer"} />
            <Tile label="Archiv" value={data.archiveTotal} sub={`${data.drafts} Entwürfe`} />
          </div>

          {(data.failedQueue > 0 || (data.accounts.errors ?? 0) > 0) && (
            <div className="alert bad">
              {data.failedQueue > 0 && <div>{data.failedQueue} Veröffentlichung(en) fehlgeschlagen – <Link href="/listings?tab=queue">Warteschlange prüfen</Link></div>}
              {(data.accounts.errors ?? 0) > 0 && <div>{data.accounts.errors} Account(s) mit Fehler – <Link href="/accounts">Accounts prüfen</Link></div>}
            </div>
          )}

          <div className="grid grid-2">
            <div className="card">
              <h2>Accounts</h2>
              {accounts.data?.length ? (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Account</th><th>Status</th><th className="num">Aktiv</th><th className="num">Verkäufe</th><th className="num">Nachr.</th><th className="num">Follower</th></tr></thead>
                    <tbody>
                      {accounts.data.map((a) => (
                        <tr key={a.id}>
                          <td><Link href={`/accounts/${a.id}`}>{a.name}</Link><div className="small muted">{a.domain} · Sync {relative(a.last_sync_at)}</div></td>
                          <td><StatusBadge status={a.status} /></td>
                          <td className="num">{a.active_listings}</td>
                          <td className="num">{a.total_sales}</td>
                          <td className="num">{a.unread_messages}</td>
                          <td className="num">{a.followers}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty>Noch keine Accounts. <Link href="/accounts">Account verbinden →</Link></Empty>
              )}
            </div>
            <div className="card">
              <h2>Letzte Aktivität</h2>
              {data.recentEvents.length ? (
                <ul className="timeline">
                  {data.recentEvents.map((e, i) => (
                    <li key={i}>
                      <span style={{ minWidth: 100 }}>{EVENT_LABEL[e.type] ?? e.type}</span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <strong>{e.vinted_username ?? "–"}</strong>{e.title ? ` · ${e.title}` : ""}
                        {e.type === "message" && <div className="small muted">{(JSON.parse(e.payload).text as string)?.slice(0, 80)}</div>}
                      </span>
                      <span className="small muted">{e.account_name} · {dateTime(e.occurred_at)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>Noch keine Ereignisse.</Empty>
              )}
              <div className="small muted" style={{ marginTop: 8 }}>{data.pendingActions} automatische Aktion(en) geplant</div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
