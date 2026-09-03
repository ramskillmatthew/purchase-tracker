import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Home dashboard — Pending Orders + Recent Sales are OPERATIONAL widgets:
 * always all-time, never scoped to the financial Compare-period selector, and
 * the Pending Orders header must report the true pre-limit count (from the API
 * `total`) even though only four rows are shown.
 *
 * Layers exercised here:
 *  - lib/sales/process-status.ts  — the shared canonical "pending" definition
 *  - lib/home-sales.ts            — the 4-row / 5-row preview helpers
 *  - app/api/sales/route.ts (GET) — the real authenticated data path, invoked
 *                                    with mocked Supabase + auth, fixtures
 *                                    spanning August and September 2026
 *  - app/page.tsx                 — structural wiring (this project has no
 *                                    React test harness for .tsx components)
 */

import {
  PENDING_PROCESS_STATUSES,
  effectiveSalesProcessStatus,
  isPendingProcessStatus,
} from "@/lib/sales/process-status";
import { HOME_PENDING_STATUSES, pendingHomeSales, recentHomeSales } from "@/lib/home-sales";
import { computeHistoryKpis } from "@/lib/sales/history";
import type { SalesOrder, SalesOrderListItem, SalesProcessStatus } from "@/lib/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function baseOrder(overrides: Partial<SalesOrder> & { id: string; sale_date: string }): SalesOrder {
  return {
    owner_id: "owner-1", platform: "ebay", custom_platform_name: null,
    revenue_input_mode: "total", revenue_input_value: 100, total_revenue: 100,
    platform_fees: 0, postage: 0, status: "completed", process_status: "completed",
    cancelled_at: null, cancellation_stock_action: null,
    created_at: `${overrides.sale_date}T10:00:00Z`, updated_at: `${overrides.sale_date}T10:00:00Z`,
    ...overrides,
  };
}

function listItem(overrides: Partial<SalesOrderListItem> & { id: string; sale_date: string }): SalesOrderListItem {
  return {
    ...baseOrder(overrides),
    itemCount: 1, profitPence: 1000, itemGroups: [{ description: "Box", quantity: 1 }],
    ...overrides,
  };
}

// 11 genuine pending orders (financial status "completed", non-terminal
// process_status), all dated in August; "today" in the tests is 1 Sep 2026.
const PENDING_ORDERS: SalesOrder[] = [
  baseOrder({ id: "p11", sale_date: "2026-08-30", process_status: "awaiting_dispatch" }),
  baseOrder({ id: "p10", sale_date: "2026-08-29", process_status: "sent" }),
  baseOrder({ id: "p09", sale_date: "2026-08-28", process_status: "awaiting_dispatch", created_at: "2026-08-28T12:00:00Z" }),
  baseOrder({ id: "p08", sale_date: "2026-08-28", process_status: "delivered_awaiting_payout", created_at: "2026-08-28T09:00:00Z" }),
  baseOrder({ id: "p07", sale_date: "2026-08-27", process_status: "return_in_process" }),
  baseOrder({ id: "p06", sale_date: "2026-08-20", process_status: "awaiting_dispatch" }),
  baseOrder({ id: "p05", sale_date: "2026-08-18", process_status: "sent" }),
  baseOrder({ id: "p04", sale_date: "2026-08-12", process_status: "awaiting_dispatch" }),
  baseOrder({ id: "p03", sale_date: "2026-08-09", process_status: "delivered_awaiting_payout" }),
  baseOrder({ id: "p02", sale_date: "2026-08-05", process_status: "awaiting_dispatch" }),
  baseOrder({ id: "p01", sale_date: "2026-08-02", process_status: "sent" }),
];

// Terminal / non-pending orders that must never be counted as pending.
const TERMINAL_ORDERS: SalesOrder[] = [
  baseOrder({ id: "c01", sale_date: "2026-08-31", process_status: "completed" }), // newest sale overall
  baseOrder({ id: "x01", sale_date: "2026-08-25", status: "cancelled", process_status: "returned_cancelled", cancellation_stock_action: "returned_to_stock", cancelled_at: "2026-08-26T00:00:00Z" }),
  baseOrder({ id: "c02", sale_date: "2026-07-15", process_status: "completed" }), // July — older
];

const ALL_ORDERS: SalesOrder[] = [...PENDING_ORDERS, ...TERMINAL_ORDERS];

// ---------------------------------------------------------------------------
// lib/sales/process-status.ts — the shared canonical pending definition
// ---------------------------------------------------------------------------

describe("canonical pending-process-status definition (shared by Sales page + Home)", () => {
  it("is exactly the four non-terminal workflow states", () => {
    expect([...PENDING_PROCESS_STATUSES]).toEqual(["awaiting_dispatch", "sent", "delivered_awaiting_payout", "return_in_process"]);
  });

  it("HOME_PENDING_STATUSES is the same list (re-export, not a second hard-coded copy)", () => {
    expect(HOME_PENDING_STATUSES).toBe(PENDING_PROCESS_STATUSES);
  });

  it("isPendingProcessStatus accepts every pending state and rejects terminal / null", () => {
    for (const s of PENDING_PROCESS_STATUSES) expect(isPendingProcessStatus(s)).toBe(true);
    for (const s of ["completed", "cancelled", "returned_cancelled"] as SalesProcessStatus[]) expect(isPendingProcessStatus(s)).toBe(false);
    expect(isPendingProcessStatus(null)).toBe(false);
    expect(isPendingProcessStatus(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// lib/home-sales.ts — preview helpers
// ---------------------------------------------------------------------------

describe("pendingHomeSales — 4 most-recent preview, canonical pending only", () => {
  const rows = ALL_ORDERS.map(o => listItem({ ...o }));

  it("returns at most four rows even when many more are pending", () => {
    expect(pendingHomeSales(rows)).toHaveLength(4);
  });

  it("returns the four most recent by sale_date desc, then created_at desc, then id desc", () => {
    expect(pendingHomeSales(rows).map(r => r.id)).toEqual(["p11", "p10", "p09", "p08"]);
  });

  it("18. awaiting-dispatch orders are included (not excluded for being unfinished)", () => {
    const onlyAwaiting = [listItem({ id: "a1", sale_date: "2026-08-10", process_status: "awaiting_dispatch" })];
    expect(pendingHomeSales(onlyAwaiting).map(r => r.id)).toEqual(["a1"]);
  });

  it("excludes completed and cancelled/returned orders", () => {
    expect(pendingHomeSales(rows).some(r => ["c01", "c02", "x01"].includes(r.id))).toBe(false);
  });

  it("11. an old August pending order is still returned after the month rolls to September", () => {
    // "today" is irrelevant to this pure helper — it never looks at the clock.
    expect(pendingHomeSales(rows).map(r => r.id)).toContain("p11");
  });

  it("9. the header count must NOT be derived from this array (it is capped at four)", () => {
    expect(pendingHomeSales(rows).length).toBe(4);
    expect(pendingHomeSales(rows).length).not.toBe(ALL_ORDERS.filter(o => isPendingProcessStatus(effectiveSalesProcessStatus(o))).length);
  });
});

describe("recentHomeSales — latest 5 valid sales, all dates, deterministic", () => {
  it("14/2. returns the five newest by sale_date across months, ignoring the calendar month", () => {
    const rows = ALL_ORDERS.map(o => listItem({ ...o }));
    expect(recentHomeSales(rows).map(r => r.id)).toEqual(["c01", "p11", "p10", "p09", "p08"]);
  });

  it("spans multiple months when that is where the newest sales are", () => {
    const rows = [
      listItem({ id: "sep", sale_date: "2026-09-03" }),
      listItem({ id: "aug", sale_date: "2026-08-28" }),
      listItem({ id: "jul", sale_date: "2026-07-30" }),
    ];
    expect(recentHomeSales(rows).map(r => r.id)).toEqual(["sep", "aug", "jul"]);
  });

  it("16. never returns more than five rows", () => {
    const rows = Array.from({ length: 12 }, (_, i) => listItem({ id: `s${String(i).padStart(2, "0")}`, sale_date: `2026-08-${String(i + 1).padStart(2, "0")}` }));
    expect(recentHomeSales(rows)).toHaveLength(5);
  });

  it("17/19. equal sale dates fall back to created_at desc then id desc — an unrelated updated_at edit cannot reorder them", () => {
    const rows = [
      listItem({ id: "b", sale_date: "2026-08-20", created_at: "2026-08-20T08:00:00Z", updated_at: "2026-09-01T23:59:00Z" }),
      listItem({ id: "a", sale_date: "2026-08-20", created_at: "2026-08-20T09:00:00Z", updated_at: "2026-08-20T09:00:00Z" }),
    ];
    expect(recentHomeSales(rows).map(r => r.id)).toEqual(["a", "b"]); // created_at desc wins; the late updated_at on "b" is ignored
  });

  it("15. a newly-added sale sorts to the front", () => {
    const rows = [listItem({ id: "old", sale_date: "2026-08-28" }), listItem({ id: "new", sale_date: "2026-09-04" })];
    expect(recentHomeSales(rows)[0].id).toBe("new");
  });

  it("18. awaiting-dispatch sales remain valid Recent Sales entries", () => {
    const rows = [listItem({ id: "await", sale_date: "2026-08-30", process_status: "awaiting_dispatch" })];
    expect(recentHomeSales(rows).map(r => r.id)).toEqual(["await"]);
  });
});

// ---------------------------------------------------------------------------
// REAL DATA PATH — app/api/sales/route.ts GET, mocked Supabase + auth
// ---------------------------------------------------------------------------

const { supabaseRequestAll, supabaseRequest, requireOwner } = vi.hoisted(() => ({
  supabaseRequestAll: vi.fn(),
  supabaseRequest: vi.fn(),
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "owner@example.com" })),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase", () => ({ supabaseRequestAll, supabaseRequest }));
vi.mock("@/lib/auth/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return { ...actual, requireOwner };
});

import { GET } from "@/app/api/sales/route";

function itemsFor(id: string) {
  return [{ sales_order_id: id, item_description_snapshot: "Box", category_snapshot: "Pokémon", profit: 10 }];
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-01T09:00:00Z")); // September — no September sales exist
  requireOwner.mockResolvedValue({ id: "owner-1", email: "owner@example.com" });
  supabaseRequest.mockImplementation(async () => ({ json: async () => [] }));
  supabaseRequestAll.mockImplementation(async (path: string) => {
    if (path.startsWith("sale_items?")) {
      const ids = (/in\.\(([^)]+)\)/.exec(path)?.[1] ?? "").split(",").filter(Boolean);
      return ids.flatMap(itemsFor);
    }
    if (path.includes("select=platform,custom_platform_name")) {
      return ALL_ORDERS.map(o => ({ platform: o.platform, custom_platform_name: o.custom_platform_name }));
    }
    if (path.includes("sale_date=eq.")) return []; // "today" completed sales — none in September
    if (path.startsWith("sales_orders?")) {
      let rows = ALL_ORDERS;
      if (path.includes("status=eq.completed")) rows = rows.filter(o => o.status === "completed");
      if (path.includes("status=eq.cancelled")) rows = rows.filter(o => o.status === "cancelled");
      const gte = /sale_date=gte\.([0-9-]+)/.exec(path)?.[1];
      const lte = /sale_date=lte\.([0-9-]+)/.exec(path)?.[1];
      if (gte) rows = rows.filter(o => o.sale_date >= gte);
      if (lte) rows = rows.filter(o => o.sale_date <= lte);
      return rows.map(o => ({ ...o }));
    }
    return [];
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function callSales(query: string) {
  const response = await GET(new Request(`http://localhost/api/sales?${query}`));
  expect(response.status).toBe(200);
  return response.json() as Promise<import("@/lib/sales/history").SalesHistoryResponse>;
}

describe("GET /api/sales — operational all-time pending scope (the Home Pending Orders source)", () => {
  it("5/8/20. reports the exact pre-limit pending total (11) while returning only a limited page", async () => {
    const body = await callSales("status=pending&preset=all-time&pageSize=10&sort=date&direction=desc");
    expect(body.total).toBe(11); // computed from `filtered.length`, BEFORE .slice()
    expect(body.kpis.completedSales).toBe(11); // the same number the Sales page KPI strip shows
    expect(body.rows.length).toBeLessThanOrEqual(10); // server-side page limit
    expect(body.rows.length).toBe(10);
  });

  it("10. the Home 4-row preview is the four most recent pending orders by canonical ordering", async () => {
    const body = await callSales("status=pending&preset=all-time&pageSize=10&sort=date&direction=desc");
    expect(pendingHomeSales(body.rows as SalesOrderListItem[]).map(r => r.id)).toEqual(["p11", "p10", "p09", "p08"]);
  });

  it("1/11. August pending orders are returned even though today is September (no date filter applied for all-time)", async () => {
    const body = await callSales("status=pending&preset=all-time&pageSize=10&sort=date&direction=desc");
    expect(body.rows.every(r => r.sale_date.startsWith("2026-08"))).toBe(true);
    expect(body.total).toBe(11);
    // no sale_date filter was sent for the all-time pending query
    const pendingCalls = supabaseRequestAll.mock.calls.map(c => c[0] as string).filter(p => p.startsWith("sales_orders?") && p.includes("status=eq.completed") && !p.includes("sale_date=eq."));
    expect(pendingCalls.length).toBeGreaterThan(0);
    expect(pendingCalls.every(p => !p.includes("sale_date=gte") && !p.includes("sale_date=lte"))).toBe(true);
  });

  it("21. every sales_orders query is scoped to the authenticated owner", async () => {
    await callSales("status=pending&preset=all-time&pageSize=10&sort=date&direction=desc");
    const orderQueries = supabaseRequestAll.mock.calls.map(c => c[0] as string).filter(p => p.startsWith("sales_orders?"));
    expect(orderQueries.length).toBeGreaterThan(0);
    expect(orderQueries.every(p => p.includes("owner_id=eq.owner-1"))).toBe(true);
  });

  it("13. a pending order that gets cancelled drops out of the total (canonical financial status)", async () => {
    supabaseRequestAll.mockImplementationOnce(async (path: string) => {
      // first call is the main list query — return the fixture set with p01 now cancelled
      if (path.startsWith("sales_orders?") && path.includes("status=eq.completed")) {
        return ALL_ORDERS.filter(o => o.id !== "p01").map(o => ({ ...o }));
      }
      return [];
    });
    const body = await callSales("status=pending&preset=all-time&pageSize=10&sort=date&direction=desc");
    expect(body.total).toBe(10);
  });
});

describe("GET /api/sales — operational all-time recent-sales scope (the Home Recent Sales source)", () => {
  it("2/14. returns every date; the Home helper then shows the latest five (spanning into August under a September clock)", async () => {
    const body = await callSales("status=all&preset=all-time&pageSize=10&sort=date&direction=desc");
    const latestFive = recentHomeSales(body.rows as SalesOrderListItem[]);
    expect(latestFive).toHaveLength(5);
    expect(latestFive.map(r => r.id)).toEqual(["c01", "p11", "p10", "p09", "p08"]);
    // every order was considered (no date filter) — the July sale is in the
    // dataset, just ranked below the newest five.
    expect(body.total).toBe(ALL_ORDERS.length);
    const wide = await callSales("status=all&preset=all-time&pageSize=25&sort=date&direction=desc");
    expect(wide.rows.some(r => r.id === "c02" && r.sale_date === "2026-07-15")).toBe(true);
  });

  it("Recent Sales keeps the existing status inclusion — cancelled sales are not filtered out by the widget path", async () => {
    const body = await callSales("status=all&preset=all-time&pageSize=25&sort=date&direction=desc");
    expect(body.rows.some(r => r.id === "x01" && r.status === "cancelled")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// app/page.tsx — structural wiring
// ---------------------------------------------------------------------------

describe("app/page.tsx — operational widgets are decoupled from the Compare-period selector", () => {
  const source = readFileSync("app/page.tsx", "utf8");

  it("fetches Pending Orders + Recent Sales from an all-time, small-page operational URL", () => {
    expect(source).toContain("function operationalSalesUrl(status:");
    expect(source).toContain("preset=all-time&pageSize=10&sort=date&direction=desc");
    expect(source).toContain('operationalSalesUrl("pending")');
    expect(source).toContain('operationalSalesUrl("all")');
  });

  it("loads operational data in its own effect that never re-runs on period change (only on a returns/losses mutation)", () => {
    const opsEffect = source.slice(source.indexOf("OPERATIONAL scope"), source.indexOf("const report = useMemo"));
    expect(opsEffect).toContain("operationalSalesUrl");
    expect(opsEffect).toContain("setPendingTotal(pendingBody.total)");
    // deps: NOT `period`; re-runs only when a returns/losses mutation broadcasts.
    expect(opsEffect.trimEnd().endsWith("}, [returnsRefreshKey]);")).toBe(true);
    expect(opsEffect).not.toMatch(/}, \[[^\]]*\bperiod\b[^\]]*\]\);/);
  });

  it("the period-scoped sales effect no longer touches pending / recent sales, and re-runs on period OR a returns mutation", () => {
    const periodEffect = source.slice(source.indexOf("FINANCIAL scope"), source.indexOf("OPERATIONAL scope"));
    expect(periodEffect).toContain("}, [period, returnsRefreshKey]);");
    expect(periodEffect).not.toContain('salesUrl(period, "pending")');
    expect(periodEffect).not.toContain("setPending(");
    expect(periodEffect).not.toContain("setRecentSales(");
  });

  it("the Pending Orders header uses the API total with singular/plural, never the 4-row slice length", () => {
    expect(source).toContain("orderCountLabel(pendingTotal)");
    expect(source).toContain('total === 1 ? "order" : "orders"');
    expect(source).not.toContain("${pending.length} orders");
    expect(source).not.toMatch(/pending\.slice\([^)]*\)\.length/);
  });

  it("both operational widgets key their loading / empty / error states off opsLoading + opsError", () => {
    expect(source).toContain("<h2>Pending Orders</h2><span>{opsLoading || opsError ? \"\" : orderCountLabel(pendingTotal)}");
    expect(source).toContain('opsLoading ? "Loading orders…" : opsError ? "Pending orders could not be loaded." : "No pending orders."');
    expect(source).toContain('opsLoading ? "Loading sales…" : opsError ? "Recent sales could not be loaded." : "No recent sales."');
  });

  it("financial cards remain period-scoped and the Net Profit fix is preserved", () => {
    expect(source).toContain('salesUrl(period, "completed")');
    expect(source).toContain('salesUrl(period, "all")');
    expect(source).toContain("netProfitWithReturnsLossesPence(allSalesKpis?.profitPence ?? 0, operatingExpensePence, returnLossAdjustmentPence)");
    expect(source).toContain("periodOperatingExpensePence(period, expenses)");
    expect(source).toContain("computeHomeReport(period, purchases, expenses)");
  });
});
