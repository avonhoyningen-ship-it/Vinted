"use client";
import Link from "next/link";
import { useState } from "react";
import { useToast } from "@/components/Toasts";
import { AccountForm } from "@/components/AccountForm";
import { HelperCard } from "@/components/HelperCard";
import { downloadChromeBat } from "@/lib/chromeBat";
import { CLOUD } from "@/lib/mode";
import { Empty, ErrorBox, Modal, PageHead, StatusBadge } from "@/components/ui";
import { api, relative } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import type { Account } from "@/lib/types";

export default function AccountsPage() {
  const toast = useToast();
  const { data, error, reload } = useApi<Account[]>("/accounts");
  const [adding, setAdding] = useState(false);
  const [syncing, setSyncing] = useState<number | null>(null);
  const [connecting, setConnecting] = useState<number | null>(null);

  /** Cloud: the PC helper takes the login from the Vinted-Chrome. */
  async function connectHelper(id: number) {
    setConnecting(id);
    try {
      const r = await api<{ account: Account; error: string | null }>(`/accounts/${id}/connect-helper`, { method: "POST" });
      if (r.error) toast({ kind: "error", text: `Verbunden, aber Abruf fehlgeschlagen: ${r.error}` });
      else toast({ kind: "info", text: `Verbunden${r.account.username ? ` als @${r.account.username}` : ""}` });
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    } finally {
      setConnecting(null);
      void reload();
    }
  }

  async function sync(id: number) {
    setSyncing(id);
    try {
      const r = await api<{ result: { imported: number; newSales: number; newFavourites: number; newMessages: number; warnings: string[] } }>(`/accounts/${id}/sync`, { method: "POST" });
      toast({ kind: "info", text: `Synchronisiert: ${r.result.imported} importiert, ${r.result.newSales} neue Verkäufe, ${r.result.newFavourites} Favoriten, ${r.result.newMessages} Nachrichten` });
      r.result.warnings.forEach((w) => toast({ kind: "error", text: w }));
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    } finally {
      setSyncing(null);
      void reload();
    }
  }

  return (
    <>
      <PageHead title="Accounts" sub="Eigene Vinted-Accounts verbinden und verwalten">
        <button className="btn primary" onClick={() => setAdding(true)}>+ Account verbinden</button>
      </PageHead>
      <ErrorBox error={error} />
      {CLOUD && <div style={{ marginBottom: 16 }}><HelperCard /></div>}
      {data && !data.length && <div className="card"><Empty>Noch kein Account verbunden.</Empty></div>}
      <div className="grid grid-3">
        {data?.map((a) => (
          <div className="card stack" key={a.id}>
            <div className="row">
              <div>
                <h2 style={{ margin: 0 }}><Link href={`/accounts/${a.id}`}>{a.name}</Link></h2>
                <div className="small muted">{a.domain}{a.username ? ` · @${a.username}` : ""}</div>
              </div>
              <div className="spacer" />
              <StatusBadge status={a.status} />
            </div>
            {a.last_error && <div className="alert bad small">{a.last_error}</div>}
            <div className="tiles" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
              {[["Aktiv", a.active_listings], ["Verkäufe", a.total_sales], ["Nachr.", a.unread_messages], ["Follower", a.followers]].map(([l, v]) => (
                <div key={l as string}><div className="small muted">{l}</div><div style={{ fontWeight: 650, fontSize: 18 }} className="mono">{v}</div></div>
              ))}
            </div>
            <div className="row small muted">Letzter Sync {relative(a.last_sync_at)}{!a.polling_enabled && " · Polling pausiert"}</div>
            <div className="row">
              <button className="btn small" disabled={syncing === a.id || !a.has_session} onClick={() => sync(a.id)}>{syncing === a.id ? "Synchronisiere…" : "Jetzt synchronisieren"}</button>
              {CLOUD && (
                <button className="btn small" disabled={connecting === a.id} onClick={() => connectHelper(a.id)}>
                  {connecting === a.id ? "Verbinde…" : a.has_session ? "Login neu übernehmen" : "Mit PC-Helfer verbinden"}
                </button>
              )}
              {a.chrome_port && (
                <button className="btn small" title={`Eigenes Chrome-Profil auf Port ${a.chrome_port}`} onClick={() => downloadChromeBat(a.name, a.chrome_port!, a.domain)}>
                  Chrome für diesen Account
                </button>
              )}
              <Link className="btn small" href={`/accounts/${a.id}`}>Details</Link>
            </div>
          </div>
        ))}
      </div>
      {adding && (
        <Modal title="Account verbinden" onClose={() => setAdding(false)}>
          <AccountForm onSaved={() => { setAdding(false); void reload(); }} onCancel={() => { setAdding(false); void reload(); }} />
        </Modal>
      )}
    </>
  );
}
