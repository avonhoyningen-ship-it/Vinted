import { Router } from "express";
import { z } from "zod";
import { db } from "../../db/index.js";
import { h } from "../../lib/http.js";

export const statsRouter = Router();

const range = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  accountId: z.coerce.number().int().positive().optional(),
});

function params(q: z.infer<typeof range>) {
  return {
    from: q.from ?? "0000",
    to: q.to ? (q.to.length === 10 ? `${q.to}T23:59:59.999Z` : q.to) : "9999",
    accountId: q.accountId ?? null,
  };
}
const SALES_WHERE = "s.sold_at >= @from AND s.sold_at <= @to AND (@accountId IS NULL OR s.account_id = @accountId)";

statsRouter.get("/overview", h(async (req, res) => {
  const p = params(range.parse(req.query));
  const sales = (await db.get<{ count: number; revenue_cents: number; avg_price_cents: number }>(`SELECT COUNT(*) count, COALESCE(SUM(price_cents), 0) revenue_cents, COALESCE(AVG(price_cents), 0) avg_price_cents
    FROM sales s WHERE ${SALES_WHERE}`, p))!;
  const profit = (await db.get<{ profit_cents: number; n: number }>(`SELECT COALESCE(SUM(s.price_cents - i.purchase_price_cents), 0) profit_cents, COUNT(*) n
    FROM sales s JOIN items i ON i.id = s.item_id WHERE i.purchase_price_cents IS NOT NULL AND ${SALES_WHERE}`, p))!;
  const active = (await db.get<{ c: number }>("SELECT COUNT(*) c FROM listings WHERE status = 'active' AND (@accountId IS NULL OR account_id = @accountId)", p))!;
  // Days between listing and sale, computed here (portable across SQLite and Postgres).
  const sold = await db.all<{ listed_at: string; sold_at: string }>(`SELECT l.listed_at, l.sold_at
    FROM listings l WHERE l.status = 'sold' AND l.sold_at >= @from AND l.sold_at <= @to AND (@accountId IS NULL OR l.account_id = @accountId)`, p);
  const days = sold.map((l) => (Date.parse(l.sold_at) - Date.parse(l.listed_at)) / 86400_000).filter((d) => Number.isFinite(d));
  const byAccount = (await db.all<Record<string, unknown>>(`
    SELECT a.id, a.name, a.domain, a.followers, a.status,
      (SELECT COUNT(*) FROM listings l WHERE l.account_id = a.id AND l.status = 'active') active_listings,
      (SELECT COUNT(*) FROM sales s WHERE s.account_id = a.id AND s.sold_at >= @from AND s.sold_at <= @to) sales,
      (SELECT COALESCE(SUM(price_cents), 0) FROM sales s WHERE s.account_id = a.id AND s.sold_at >= @from AND s.sold_at <= @to) revenue_cents
    FROM accounts a WHERE (@accountId IS NULL OR a.id = @accountId) ORDER BY revenue_cents DESC
  `, p)).map((r) => ({ ...r, active_listings: Number(r.active_listings), sales: Number(r.sales), revenue_cents: Number(r.revenue_cents) }));
  res.json({
    salesCount: Number(sales.count),
    revenueCents: Number(sales.revenue_cents),
    avgPriceCents: Math.round(Number(sales.avg_price_cents)),
    profitCents: Number(profit.n) ? Number(profit.profit_cents) : null,
    activeListings: Number(active.c),
    avgDaysToSell: days.length ? Math.round((days.reduce((a, b) => a + b, 0) / days.length) * 10) / 10 : null,
    byAccount,
  });
}));

/** Period label like SQLite's strftime: day "2026-09-25", week "2026-W38" (Monday weeks, %W), month "2026-09". */
export function periodOf(iso: string, granularity: "day" | "week" | "month"): string {
  if (granularity === "day") return iso.slice(0, 10);
  if (granularity === "month") return iso.slice(0, 7);
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
  const yday = Math.floor((d.getTime() - jan1) / 86400_000);
  const week = Math.floor((yday + 7 - ((d.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

statsRouter.get("/timeseries", h(async (req, res) => {
  const q = range.extend({ granularity: z.enum(["day", "week", "month"]).default("day") }).parse(req.query);
  const sales = await db.all<{ sold_at: string; account_id: number; account_name: string; price_cents: number }>(`
    SELECT s.sold_at, s.account_id, a.name account_name, s.price_cents
    FROM sales s JOIN accounts a ON a.id = s.account_id
    WHERE ${SALES_WHERE}
  `, params(q));
  const buckets = new Map<string, { period: string; account_id: number; account_name: string; count: number; revenue_cents: number }>();
  for (const s of sales) {
    const period = periodOf(s.sold_at, q.granularity);
    const key = `${period}|${s.account_id}`;
    const b = buckets.get(key) ?? { period, account_id: Number(s.account_id), account_name: s.account_name, count: 0, revenue_cents: 0 };
    b.count++;
    b.revenue_cents += Number(s.price_cents);
    buckets.set(key, b);
  }
  res.json([...buckets.values()].sort((a, b) => a.period.localeCompare(b.period)));
}));

statsRouter.get("/top", h(async (req, res) => {
  const q = range.extend({ by: z.enum(["category", "brand"]).default("brand"), limit: z.coerce.number().int().min(1).max(50).default(10) }).parse(req.query);
  const col = q.by === "brand" ? "s.brand" : "s.category";
  const rows = await db.all<{ label: string; count: number; revenue_cents: number }>(`
    SELECT COALESCE(${col}, 'Unbekannt') label, COUNT(*) count, SUM(s.price_cents) revenue_cents
    FROM sales s WHERE ${SALES_WHERE}
    GROUP BY COALESCE(${col}, 'Unbekannt') ORDER BY count DESC, revenue_cents DESC LIMIT @limit
  `, { ...params(q), limit: q.limit });
  res.json(rows.map((r) => ({ ...r, count: Number(r.count), revenue_cents: Number(r.revenue_cents) })));
}));

statsRouter.get("/recent-sales", h(async (req, res) => {
  const q = range.parse(req.query);
  res.json(await db.all(`
    SELECT s.*, a.name account_name FROM sales s JOIN accounts a ON a.id = s.account_id
    WHERE ${SALES_WHERE} ORDER BY s.sold_at DESC LIMIT 20
  `, params(q)));
}));
