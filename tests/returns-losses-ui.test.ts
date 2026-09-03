import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Stage 2 UI — the Returns, Losses & Write-offs page and its dialogs. This
 * project has no React test harness for .tsx, so the component checks are
 * structural (wiring, endpoints, reuse of the Stage 1 domain/format layers,
 * no product photos). The final block mounts the REAL preview + PATCH route
 * handlers and proves they agree on the net-profit-impact pence.
 */

const read = (p: string) => readFileSync(p, "utf8");

describe("components/AppHeader.tsx — single nav entry", () => {
  const source = read("components/AppHeader.tsx");
  it("has exactly one 'Returns, Losses & Write-offs' link to /returns-losses with a line icon", () => {
    expect(source).toContain('{ label: "Returns, Losses & Write-offs", href: "/returns-losses", icon: "returns" }');
    expect(source.match(/href: "\/returns-losses"/g)).toHaveLength(1);
    expect(source).toMatch(/returns:\s*<>/);
  });
});

describe("app/returns-losses/page.tsx — page shell", () => {
  const source = read("app/returns-losses/page.tsx");

  it("is a client component that loads list + KPIs from the Stage 1 GET /api/returns", () => {
    expect(source).toContain('"use client"');
    expect(source).toContain("fetch(`/api/returns?${qs.toString()}`");
    expect(source).toContain("data?.kpis");
  });

  it("fails gracefully when the migration is not applied — a banner, never a crash", () => {
    expect(source).toContain("migrationMissing");
    expect(source).toContain("supabase-returns-losses.sql");
    expect(source).toMatch(/does not exist|relation|not installed/);
  });

  it("offers the full period preset set plus a custom range", () => {
    expect(source).toContain("RETURNS_PERIOD_OPTIONS");
    expect(source).toContain('preset === "custom"');
    expect(source).toContain('qs.set("start", customStart)');
  });

  it("renders the 'Total losses' KPI from the server total, not a React recomputation", () => {
    expect(source).toContain('key: "totalLossesPence"');
    expect(source).toContain("money(kpis[c.key] as number)");
    expect(source).not.toMatch(/computeReturnsLossesKpis|reduce\(\(s/);
  });

  it("has Returns / Losses / All tabs and paginates the table independently of the KPI dataset", () => {
    expect(source).toContain('role="tablist"');
    expect(source).toContain('pageSize: "25"');
    expect(source).toContain("data.totalPages");
  });

  it("wires every dialog and refreshes the list after each save", () => {
    for (const c of [
      "LogReturnDialog", "LogLossDialog", "CompleteReturnDialog", "CancelReturnDialog",
      "AdvanceReturnDialog", "EditReturnDialog", "EditLossDialog", "DeleteReturnLossDialog", "RecordDetailDialog",
    ]) {
      expect(source).toContain(`import ${c} from "@/components/returns-losses/${c}"`);
    }
    expect(source).toContain("refresh();");
  });

  it("contains no product-photo markup", () => {
    expect(source).not.toMatch(/<img|<Image|photo|thumbnail/i);
  });
});

describe("components/returns-losses — dialog wiring", () => {
  it("LogReturnDialog: sale-search → exact unit selection → POST /api/returns", () => {
    const s = read("components/returns-losses/LogReturnDialog.tsx");
    expect(s).toContain("/api/returns/sale-search?");
    expect(s).toContain('fetch("/api/returns", {');
    expect(s).toContain("quantity: unitIds.length");
    expect(s).not.toMatch(/<img|<Image/i);
  });

  it("CompleteReturnDialog: two outcomes only, live preview, POST complete", () => {
    const s = read("components/returns-losses/CompleteReturnDialog.tsx");
    expect(s).toContain('"returned_safely"');
    expect(s).toContain('"buyer_refunded_no_return"');
    expect(s).not.toContain("returned damaged");
    expect(s).not.toContain("returned_damaged");
    expect(s).toContain("/complete/preview");
    expect(s).toContain("stockValueRestoredPence");
    expect(s).toMatch(/balance sheet, not profit/i);
  });

  it("CancelReturnDialog: asks which canonical sale status to restore", () => {
    const s = read("components/returns-losses/CancelReturnDialog.tsx");
    expect(s).toContain("SALES_PROCESS_STATUS_OPTIONS");
    expect(s).toMatch(/\/cancel`/);
    expect(s).toContain('o.value !== "return_in_process"');
  });

  it("AdvanceReturnDialog: only the two intermediate stages, POST /status", () => {
    const s = read("components/returns-losses/AdvanceReturnDialog.tsx");
    expect(s).toContain('"item_sent"');
    expect(s).toContain('"return_delivered"');
    expect(s).toContain("/status`");
    expect(s).not.toContain("return_completed");
  });

  it("EditReturnDialog / EditLossDialog: difference preview endpoints + before/after, block on stock conflict", () => {
    const r = read("components/returns-losses/EditReturnDialog.tsx");
    expect(r).toContain("/api/returns/${returnRow.id}/preview");
    expect(r).toContain('method: "PATCH"');
    expect(r).toContain("stockConflicts");
    const l = read("components/returns-losses/EditLossDialog.tsx");
    expect(l).toContain("/api/losses/${lossRow.id}/preview");
    expect(l).toContain('method: "PATCH"');
    expect(l).toContain("netProfitImpactDeltaPence");
  });

  it("LogLossDialog: 4 loss types, purchase-search + preview, POST /api/losses", () => {
    const s = read("components/returns-losses/LogLossDialog.tsx");
    for (const t of ["lost_inventory", "unsellable_purchase", "refund_without_return", "other_write_off"]) {
      expect(s).toContain(t);
    }
    expect(s).toContain("/api/losses/purchase-search");
    expect(s).toContain('fetch("/api/losses/preview"');
    expect(s).toContain('fetch("/api/losses", {');
    expect(s).toContain("ownershipNote");
  });

  it("DeleteReturnLossDialog: confirm:true reversal for both record types", () => {
    const s = read("components/returns-losses/DeleteReturnLossDialog.tsx");
    expect(s).toContain('method: "DELETE"');
    expect(s).toContain("confirm: true");
    expect(s).toContain("/api/returns/${row.id}");
    expect(s).toContain("/api/losses/${row.id}");
  });

  it("RecordDetailDialog: reads the detail endpoint and renders human-readable audit history", () => {
    const s = read("components/returns-losses/RecordDetailDialog.tsx");
    expect(s).toContain("/api/${isReturn ? \"returns\" : \"losses\"}/${row.id}");
    expect(s).toContain("Audit history");
    expect(s).toContain("EVENT_LABELS");
    expect(s).toMatch(/balance-sheet movement/i);
  });

  it("every dialog reuses the shared client formatter, never its own money maths", () => {
    for (const f of [
      "LogReturnDialog", "LogLossDialog", "CompleteReturnDialog",
      "EditReturnDialog", "EditLossDialog", "RecordDetailDialog",
    ]) {
      const s = read(`components/returns-losses/${f}.tsx`);
      expect(s).toContain('from "@/lib/returns/format"');
      expect(s).not.toContain("toFixed(2)");
    }
  });
});

// ---------------------------------------------------------------------------
// Preview and PATCH agree on the net-profit-impact pence
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));
const { requireOwner, supabaseRequest, supabaseRequestAll } = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "owner@example.com" })),
  supabaseRequest: vi.fn(),
  supabaseRequestAll: vi.fn(),
}));
vi.mock("@/lib/auth/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/server")>()),
  requireOwner,
}));
vi.mock("@/lib/supabase", () => ({ supabaseRequest, supabaseRequestAll }));
vi.mock("@/lib/returns/route-helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/returns/route-helpers")>()),
  callTransition: vi.fn(),
}));

import { POST as returnEditPreview } from "@/app/api/returns/[id]/preview/route";
import { PATCH as returnPatch } from "@/app/api/returns/[id]/route";
import { callTransition } from "@/lib/returns/route-helpers";
import { returnRow } from "./returns-fixtures";

const RID = "22222222-2222-4222-8222-222222222222";
const SI1 = "44444444-4444-4444-8444-444444444444";
const ITEM = {
  id: SI1, sales_order_id: "sale-1", sku_snapshot: "1644", item_description_snapshot: "On Running Cloud 5",
  purchase_cost_snapshot: 22.6, allocated_revenue: 69.71, allocated_platform_fee: 1.2, allocated_postage: 0,
  profit: 12.4, purchase_id: "p1", is_active: true, created_at: "2026-08-28T10:00:00Z",
};

function jreq(body: unknown) {
  return new Request("http://test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
function preq(body: unknown) {
  return new Request("http://test", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
const params = { params: Promise.resolve({ id: RID }) };

describe("preview and PATCH agree on net-profit-impact pence", () => {
  beforeEach(() => {
    requireOwner.mockResolvedValue({ id: "owner-1", email: "owner@example.com" });
    supabaseRequest.mockReset();
    supabaseRequestAll.mockReset();
    (callTransition as unknown as ReturnType<typeof vi.fn>).mockReset();
  });

  it("a postage-only change on a completed return yields the same pence in both paths", async () => {
    const record = returnRow({ id: RID, sale_item_ids: [SI1], restock_purchase_ids: ["p1"], return_postage: 0, other_costs: 0 });
    supabaseRequest.mockImplementation(async () => new Response(JSON.stringify([record])));
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("sale_items?id=in.")) return [ITEM];
      return [];
    });
    let capturedUpdates: Record<string, unknown> = {};
    (callTransition as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (_fn: string, body: { p_updates: Record<string, unknown> }) => {
      capturedUpdates = body.p_updates;
      return { ok: true, data: { record: { ...record, ...body.p_updates } } };
    });

    const zeroPreview = await (await returnEditPreview(jreq({ returnPostage: 0 }), params)).json();
    const editBody = { returnPostage: 5 };
    const previewJson = await (await returnEditPreview(jreq(editBody), params)).json();
    await returnPatch(preq(editBody), params);

    // 1) The real mutation and the preview compute the SAME net-profit-impact pence.
    const patchPence = Math.round(Number(capturedUpdates.net_profit_impact) * 100);
    expect(patchPence).toBe(previewJson.after.netProfitImpact);
    // 2) A £5 return-postage change moves the after-impact by exactly -500p.
    expect(previewJson.after.netProfitImpact - zeroPreview.after.netProfitImpact).toBe(-500);
  });
});

describe("v4 UI defects — status colour + filter-row background", () => {
  const format = read("lib/returns/format.ts");
  const moduleCss = read("app/returns-losses/returns-losses.module.css");

  it("34/35. return_delivered uses a vivid rose/pink-red tone (not green, distinct from return_started's amber and return_cancelled's muted red)", () => {
    const tone = (k: string) => format.match(new RegExp(`${k}:\\s*"(#[0-9a-fA-F]{3,8})"`))?.[1]?.toLowerCase();
    const delivered = tone("return_delivered");
    expect(delivered).toBeTruthy();
    expect(delivered).not.toBe("#4bc9d9");            // the old dull cyan is gone
    expect(delivered).not.toBe(tone("return_started")); // distinct from amber
    expect(delivered).not.toBe(tone("return_cancelled"));
    // vivid warm/negative: red channel dominant and high
    const [r, g, b] = [delivered!.slice(1, 3), delivered!.slice(3, 5), delivered!.slice(5, 7)].map(h => parseInt(h, 16));
    expect(r).toBeGreaterThan(200);
    expect(r).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(b);
    // not green
    expect(g).toBeLessThan(r);
  });

  it("35. the other four status tones are unchanged", () => {
    expect(format).toContain('return_started: "#e0a54b"');
    expect(format).toContain('item_sent: "#4b8fe0"');
    expect(format).toContain('return_completed: "#36c98f"');
    expect(format).toContain('return_cancelled: "#d96b6b"');
  });

  it("36. the filter-row select/search controls get the app's neutral-dark field treatment (var(--surface-2) bg, var(--line-strong) border) — no bare min-height only", () => {
    const rule = moduleCss.slice(moduleCss.indexOf(".filterBar select"), moduleCss.indexOf(".filterBar .search"));
    expect(rule).toMatch(/background:\s*var\(--surface-2\)/);
    expect(rule).toMatch(/border:\s*1px solid var\(--line-strong\)/);
    expect(rule).toMatch(/color:\s*var\(--text\)/);
    // no brown/bronze/named colour, no selected-row tint
    expect(rule).not.toMatch(/#(?!fff|000)[0-9a-f]{3,6}/i);
    expect(rule).not.toMatch(/primary-soft|--selected|bronze|brown/i);
  });

  it("36/37. autofill is neutralised and the purple Reset link + layout are untouched", () => {
    expect(moduleCss).toMatch(/\.filterBar input:-webkit-autofill/);
    expect(moduleCss).toMatch(/-webkit-box-shadow: 0 0 0 1000px var\(--surface-2\) inset/);
    expect(moduleCss).toContain(".reset { margin-left: auto;");
    expect(moduleCss).toContain("color: var(--primary)");
    expect(moduleCss).toContain(".filterBar .search { flex: 1; min-width: 180px; }");
  });
});
