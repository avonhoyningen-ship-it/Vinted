"use client";
import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Empty, ErrorBox, PageHead, Tile } from "@/components/ui";
import { euro } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import type { Account } from "@/lib/types";

interface Overview {
  salesCount: number; revenueCents: number; avgPriceCents: number; profitCents: number | null; activeListings: number; avgDaysToSell: number | null;
  byAccount: { id: number; name: string; domain: string; active_listings: number; sales: number; revenue_cents: number }[];
}
interface Point { period: string; account_id: number; account_name: string; count: number; revenue_cents: number }
interface Top { label: string; count: number; revenue_cents: number }

const RANGES = { "7": "7 Tage", "30": "30 Tage", "90": "90 Tage", "365": "12 Monate", all: "Gesamt" } as const;
const MAX_SERIES = 8;
const seriesVar = (i: number) => `var(--series-${i + 1})`;

function fromDate(range: string) {
  if (range === "all") return null;
  const d = new Date();
  d.setDate(d.getDate() - Number(range) + 1);
  return d.toISOString().slice(0, 10);
}

const axisTick = { fill: "var(--text-2)", fontSize: 12 };

function ChartTooltip({ active, payload, label, metric, names }: {
  active?: boolean; payload?: { dataKey: string; value: number; color: string }[]; label?: string; metric: "revenue" | "count"; names: Record<string, string>;
}) {
  if (!active || !payload?.length) return null;
  const rows = payload.filter((p) => p.value);
  const total = rows.reduce((s, p) => s + p.value, 0);
  const fmt = (v: number) => (metric === "revenue" ? euro(v) : `${v} Verkäufe`);
  return (
    <div className="chart-tooltip">
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{label}</div>
      {rows.map((p) => (
        <div key={p.dataKey} className="row" style={{ gap: 6 }}><i style={{ width: 8, height: 8, borderRadius: 2, background: p.color, display: "inline-block" }} /> {names[p.dataKey]}<span className="spacer" /><span className="mono">{fmt(p.value)}</span></div>
      ))}
      {rows.length > 1 && <div className="row" style={{ borderTop: "1px solid var(--border)", marginTop: 4, paddingTop: 4 }}>Summe<span className="spacer" /><strong className="mono">{fmt(total)}</strong></div>}
    </div>
  );
}

function TopList({ title, rows }: { title: string; rows: Top[] | null }) {
  const max = Math.max(1, ...(rows ?? []).map((r) => r.count));
  return (
    <div className="card">
      <h2>{title}</h2>
      {rows && !rows.length && <Empty>Noch keine Verkäufe.</Empty>}
      <div className="stack" style={{ gap: 8 }}>
        {rows?.map((r) => (
          <div key={r.label} title={`${r.label}: ${r.count} Verkäufe, ${euro(r.revenue_cents)}`}>
            <div className="row small"><span>{r.label}</span><span className="spacer" /><span className="mono muted">{r.count} · {euro(r.revenue_cents)}</span></div>
            <div style={{ height: 8, background: "var(--surface-2)", borderRadius: 4 }}>
              <div style={{ height: 8, width: `${(r.count / max) * 100}%`, background: "var(--series-1)", borderRadius: 4 }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function StatsPage() {
  const [range, setRange] = useState<keyof typeof RANGES>("30");
  const [granularity, setGranularity] = useState("day");
  const [accountId, setAccountId] = useState("");
  const [metric, setMetric] = useState<"revenue" | "count">("revenue");
  const [showTable, setShowTable] = useState(false);
  const accounts = useApi<Account[]>("/accounts");

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    const from = fromDate(range);
    if (from) p.set("from", from);
    if (accountId) p.set("accountId", accountId);
    return p.toString();
  }, [range, accountId]);

  const overview = useApi<Overview>(`/stats/overview?${qs}`);
  const series = useApi<Point[]>(`/stats/timeseries?${qs}&granularity=${granularity}`);
  const brands = useApi<Top[]>(`/stats/top?${qs}&by=brand`);
  const cats = useApi<Top[]>(`/stats/top?${qs}&by=category`);

  // Colour follows the account (fixed order by id), never its rank in the current range.
  const { rows, keys, names, colors } = useMemo(() => {
    const ordered = [...(accounts.data ?? [])].sort((a, b) => a.id - b.id);
    const slot = new Map(ordered.map((a, i) => [a.id, i]));
    const keyFor = (id: number) => ((slot.get(id) ?? MAX_SERIES) >= MAX_SERIES - 1 && ordered.length > MAX_SERIES ? "other" : `a${id}`);
    const byPeriod = new Map<string, Record<string, number | string>>();
    const names: Record<string, string> = { other: "Andere" };
    const colors: Record<string, string> = { other: "var(--text-3)" };
    for (const p of series.data ?? []) {
      const k = keyFor(p.account_id);
      if (k !== "other") { names[k] = p.account_name; colors[k] = seriesVar(slot.get(p.account_id) ?? 0); }
      const row = byPeriod.get(p.period) ?? { period: p.period };
      row[k] = ((row[k] as number) ?? 0) + (metric === "revenue" ? p.revenue_cents : p.count);
      byPeriod.set(p.period, row);
    }
    const keys = [...new Set((series.data ?? []).map((p) => keyFor(p.account_id)))].sort((a, b) => (a === "other" ? 1 : b === "other" ? -1 : (slot.get(Number(a.slice(1))) ?? 0) - (slot.get(Number(b.slice(1))) ?? 0)));
    return { rows: [...byPeriod.values()], keys, names, colors };
  }, [series.data, accounts.data, metric]);

  const o = overview.data;
  return (
    <>
      <PageHead title="Statistik" sub="Verkäufe, Umsatz und Bestseller" />
      <div className="card row" style={{ marginBottom: 16 }}>
        <div className="row" role="group" aria-label="Zeitraum">
          {(Object.keys(RANGES) as (keyof typeof RANGES)[]).map((r) => (
            <button key={r} className={`btn small ${range === r ? "primary" : ""}`} onClick={() => setRange(r)}>{RANGES[r]}</button>
          ))}
        </div>
        <div className="spacer" />
        <select style={{ width: "auto" }} value={accountId} onChange={(e) => setAccountId(e.target.value)} aria-label="Account">
          <option value="">Alle Accounts</option>
          {accounts.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>
      <ErrorBox error={overview.error} />
      {o && (
        <div className="stack">
          <div className="tiles">
            <Tile label="Umsatz" value={euro(o.revenueCents)} sub={o.profitCents !== null ? `Gewinn ${euro(o.profitCents)} (mit Einkaufspreis)` : undefined} />
            <Tile label="Verkäufe" value={o.salesCount} sub={`Ø ${euro(o.avgPriceCents)} pro Verkauf`} />
            <Tile label="Aktive Listings" value={o.activeListings} />
            <Tile label="Ø Verkaufsdauer" value={o.avgDaysToSell === null ? "–" : `${o.avgDaysToSell.toLocaleString("de-DE")} Tage`} sub="vom Einstellen bis Verkauf" />
          </div>

          <div className="card">
            <div className="row" style={{ marginBottom: 8 }}>
              <h2 style={{ margin: 0 }}>{metric === "revenue" ? "Umsatz" : "Verkäufe"} pro {granularity === "day" ? "Tag" : granularity === "week" ? "Woche" : "Monat"}</h2>
              <div className="spacer" />
              <select style={{ width: "auto" }} value={metric} onChange={(e) => setMetric(e.target.value as "revenue" | "count")} aria-label="Kennzahl">
                <option value="revenue">Umsatz</option><option value="count">Anzahl</option>
              </select>
              <select style={{ width: "auto" }} value={granularity} onChange={(e) => setGranularity(e.target.value)} aria-label="Auflösung">
                <option value="day">Tag</option><option value="week">Woche</option><option value="month">Monat</option>
              </select>
              <button className="btn small" onClick={() => setShowTable(!showTable)}>{showTable ? "Diagramm" : "Tabelle"}</button>
            </div>
            {!rows.length ? <Empty>Keine Verkäufe im Zeitraum.</Empty> : showTable ? (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Zeitraum</th>{keys.map((k) => <th key={k} className="num">{names[k]}</th>)}</tr></thead>
                  <tbody>{rows.map((r) => (
                    <tr key={r.period as string}><td>{r.period}</td>{keys.map((k) => <td key={k} className="num">{metric === "revenue" ? euro((r[k] as number) ?? 0) : (r[k] ?? 0)}</td>)}</tr>
                  ))}</tbody>
                </table>
              </div>
            ) : (
              <>
                {keys.length > 1 && (
                  <div className="chart-legend">{keys.map((k) => <span key={k}><i style={{ background: colors[k] }} />{names[k]}</span>)}</div>
                )}
                <div style={{ width: "100%", height: 280 }}>
                  <ResponsiveContainer>
                    <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                      <CartesianGrid vertical={false} stroke="var(--grid)" />
                      <XAxis dataKey="period" tick={axisTick} tickLine={false} axisLine={{ stroke: "var(--border)" }} />
                      <YAxis tick={axisTick} tickLine={false} axisLine={false} width={64}
                        tickFormatter={(v: number) => (metric === "revenue" ? `${Math.round(v / 100)} €` : String(v))} allowDecimals={false} />
                      <Tooltip cursor={{ fill: "var(--surface-2)" }} content={<ChartTooltip metric={metric} names={names} />} />
                      {keys.map((k, i) => (
                        <Bar key={k} dataKey={k} stackId="s" fill={colors[k]} stroke="var(--surface)" strokeWidth={2}
                          radius={i === keys.length - 1 ? [4, 4, 0, 0] : 0} maxBarSize={48} isAnimationActive={false} />
                      ))}
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </>
            )}
          </div>

          <div className="grid grid-2">
            <TopList title="Meistverkaufte Marken" rows={brands.data} />
            <TopList title="Meistverkaufte Kategorien" rows={cats.data} />
          </div>

          <div className="card table-wrap">
            <h2>Pro Account</h2>
            <table>
              <thead><tr><th>Account</th><th className="num">Aktive Listings</th><th className="num">Verkäufe</th><th className="num">Umsatz</th></tr></thead>
              <tbody>{o.byAccount.map((a) => (
                <tr key={a.id}><td>{a.name} <span className="muted small">{a.domain}</span></td><td className="num">{a.active_listings}</td><td className="num">{a.sales}</td><td className="num">{euro(a.revenue_cents)}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
