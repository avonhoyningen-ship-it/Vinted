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

statsRouter.get("/overview", h((req, res) => {
  const p = params(range.parse(req.query));
  const sales = db.prepare(`SELECT COUNT(*) count, COALESCE(SUM(price_cents), 0) revenue_cents, COALESCE(AVG(price_cents), 0) avg_price_cents
    FROM sales s WHERE ${SALES_WHERE}`).get(p) as { count: number; revenue_cents: number; avg_price_cents: number };
  const profit = db.prepare(`SELECT COALESCE(SUM(s.price_cents - i.purchase_price_cents), 0) profit_cents, COUNT(*) n
    FROM sales s JOIN items i ON i.id = s.item_id WHERE i.purchase_price_cents IS NOT NULL AND ${SALES_WHERE}`).get(p) as { profit_cents: number; n: number };
  const active = db.prepare("SELECT COUNT(*) c FROM listings WHERE status = 'active' AND (@accountId IS NULL OR account_id = @accountId)").get(p) as { c: number };
  const avgDays = db.prepare(`SELECT AVG(julianday(l.sold_at) - julianday(l.listed_at)) d
    FROM listings l WHERE l.status = 'sold' AND l.sold_at >= @from AND l.sold_at <= @to AND (@accountId IS NULL OR l.account_id = @accountId)`).get(p) as { d: number | null };
  const byAccount = db.prepare(`
    SELECT a.id, a.name, a.domain, a.followers, a.status,
      (SELECT COUNT(*) FROM listings l WHERE l.account_id = a.id AND l.status = 'active') active_listings,
      (SELECT COUNT(*) FROM sales s WHERE s.account_id = a.id AND s.sold_at >= @from AND s.sold_at <= @to) sales,
      (SELECT COALESCE(SUM(price_cents), 0) FROM sales s WHERE s.account_id = a.id AND s.sold_at >= @from AND s.sold_at <= @to) revenue_cents
    FROM accounts a WHERE (@accountId IS NULL OR a.id = @accountId) ORDER BY revenue_cents DESC
  `).all(p);
  res.json({
    salesCount: sales.count,
    revenueCents: sales.revenue_cents,
    avgPriceCents: Math.round(sales.avg_price_cents),
    profitCents: profit.n ? profit.profit_cents : null,
    activeListings: active.c,
    avgDaysToSell: avgDays.d === null ? null : Math.round(avgDays.d * 10) / 10,
    byAccount,
  });
}));

const FORMATS = { day: "%Y-%m-%d", week: "%Y-W%W", month: "%Y-%m" } as const;

statsRouter.get("/timeseries", h((req, res) => {
  const q = range.extend({ granularity: z.enum(["day", "week", "month"]).default("day") }).parse(req.query);
  const rows = db.prepare(`
    SELECT strftime('${FORMATS[q.granularity]}', s.sold_at) period, s.account_id, a.name account_name,
      COUNT(*) count, SUM(s.price_cents) revenue_cents
    FROM sales s JOIN accounts a ON a.id = s.account_id
    WHERE ${SALES_WHERE}
    GROUP BY period, s.account_id ORDER BY period
  `).all(params(q));
  res.json(rows);
}));

statsRouter.get("/top", h((req, res) => {
  const q = range.extend({ by: z.enum(["category", "brand"]).default("brand"), limit: z.coerce.number().int().min(1).max(50).default(10) }).parse(req.query);
  const col = q.by === "brand" ? "s.brand" : "s.category";
  res.json(db.prepare(`
    SELECT COALESCE(${col}, 'Unbekannt') label, COUNT(*) count, SUM(s.price_cents) revenue_cents
    FROM sales s WHERE ${SALES_WHERE}
    GROUP BY label ORDER BY count DESC, revenue_cents DESC LIMIT @limit
  `).all({ ...params(q), limit: q.limit }));
}));

statsRouter.get("/recent-sales", h((req, res) => {
  const q = range.parse(req.query);
  res.json(db.prepare(`
    SELECT s.*, a.name account_name FROM sales s JOIN accounts a ON a.id = s.account_id
    WHERE ${SALES_WHERE} ORDER BY s.sold_at DESC LIMIT 20
  `).all(params(q)));
}));
