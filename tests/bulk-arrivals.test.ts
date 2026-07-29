import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseSkuLines } from "@/lib/purchases";
import { MAX_BULK_ARRIVAL_SKUS, resolveBulkArrivals, type ArrivalRecord } from "@/lib/bulk-arrivals";

function record(overrides: Partial<ArrivalRecord>): ArrivalRecord {
  return { id: "id", sku: "SKU1", arrived: null, ...overrides };
}

describe("parseSkuLines — pasted/typed SKU text parsing", () => {
  it("one SKU per line", () => {
    expect(parseSkuLines("TA-1042\nTA-1045\nTA-1088")).toEqual(["TA-1042", "TA-1045", "TA-1088"]);
  });

  it("ignores blank lines", () => {
    expect(parseSkuLines("TA-1042\n\n\nTA-1045\n")).toEqual(["TA-1042", "TA-1045"]);
  });

  it("ignores whitespace-only lines", () => {
    expect(parseSkuLines("TA-1042\n   \nTA-1045")).toEqual(["TA-1042", "TA-1045"]);
  });

  it("trims leading and trailing whitespace from each SKU", () => {
    expect(parseSkuLines("  TA-1042  \n\tTA-1045\t")).toEqual(["TA-1042", "TA-1045"]);
  });

  it("removes duplicate entries, keeping the first occurrence's casing", () => {
    expect(parseSkuLines("TA-1042\nTA-1045\nTA-1042")).toEqual(["TA-1042", "TA-1045"]);
  });

  it("de-duplicates case-insensitively (matching mirrors case-insensitive exact matching)", () => {
    expect(parseSkuLines("TA-1042\nta-1042\nTa-1042")).toEqual(["TA-1042"]);
  });

  it("handles Windows \\r\\n line endings", () => {
    expect(parseSkuLines("TA-1042\r\nTA-1045\r\nTA-1088")).toEqual(["TA-1042", "TA-1045", "TA-1088"]);
  });

  it("handles Unix \\n line endings", () => {
    expect(parseSkuLines("TA-1042\nTA-1045\nTA-1088")).toEqual(["TA-1042", "TA-1045", "TA-1088"]);
  });

  it("handles bare \\r line endings", () => {
    expect(parseSkuLines("TA-1042\rTA-1045\rTA-1088")).toEqual(["TA-1042", "TA-1045", "TA-1088"]);
  });

  it("handles a mix of line ending styles in the same paste", () => {
    expect(parseSkuLines("TA-1042\r\nTA-1045\nTA-1088\rTA-1091")).toEqual(["TA-1042", "TA-1045", "TA-1088", "TA-1091"]);
  });

  it("empty input returns an empty list", () => {
    expect(parseSkuLines("")).toEqual([]);
  });

  it("whitespace-only input returns an empty list", () => {
    expect(parseSkuLines("   \n\n   \n")).toEqual([]);
  });

  it("large valid input is parsed completely, in order, deduplicated", () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `SKU-${i}`);
    const withDuplicates = [...lines, ...lines.slice(0, 500)].join("\n");
    const result = parseSkuLines(withDuplicates);
    expect(result).toHaveLength(2000);
    expect(result[0]).toBe("SKU-0");
    expect(result[1999]).toBe("SKU-1999");
  });
});

describe("resolveBulkArrivals — pure matching/aggregation core", () => {
  it("exact matching only — 'TA-100' must not match 'TA-1001'", () => {
    const result = resolveBulkArrivals(["TA-100"], [record({ id: "p1", sku: "TA-1001" })]);
    expect(result.matchedPurchaseCount).toBe(0);
    expect(result.notFoundSkus).toEqual(["TA-100"]);
  });

  it("exact matching only — a substring match is not enough even the other direction ('TA-1001' input vs 'TA-100' stored)", () => {
    const result = resolveBulkArrivals(["TA-1001"], [record({ id: "p1", sku: "TA-100" })]);
    expect(result.matchedPurchaseCount).toBe(0);
    expect(result.notFoundSkus).toEqual(["TA-1001"]);
  });

  it("matches an exact SKU and reports it as matched", () => {
    const result = resolveBulkArrivals(["TA-1042"], [record({ id: "p1", sku: "TA-1042", arrived: false })]);
    expect(result.matchedPurchaseCount).toBe(1);
    expect(result.updateIds).toEqual(["p1"]);
    expect(result.notFoundSkus).toEqual([]);
  });

  it("matching is case-insensitive", () => {
    const result = resolveBulkArrivals(["ta-1042"], [record({ id: "p1", sku: "TA-1042", arrived: false })]);
    expect(result.matchedPurchaseCount).toBe(1);
    expect(result.updateIds).toEqual(["p1"]);
  });

  it("leading/trailing spaces on the stored SKU never prevent a match", () => {
    const result = resolveBulkArrivals(["TA-1042"], [record({ id: "p1", sku: "  TA-1042  ", arrived: false })]);
    expect(result.matchedPurchaseCount).toBe(1);
  });

  it("a SKU with no matching purchase is reported as not found", () => {
    const result = resolveBulkArrivals(["TA-9999"], [record({ id: "p1", sku: "TA-1042" })]);
    expect(result.notFoundSkus).toEqual(["TA-9999"]);
    expect(result.matchedPurchaseCount).toBe(0);
  });

  it("an already-arrived match is counted separately and not queued for update", () => {
    const result = resolveBulkArrivals(["TA-1042"], [record({ id: "p1", sku: "TA-1042", arrived: true })]);
    expect(result.alreadyArrivedCount).toBe(1);
    expect(result.updatedPurchaseCount).toBe(0);
    expect(result.updateIds).toEqual([]);
  });

  it("null arrived is treated as not-arrived and queued for update, same as isArrived's rule elsewhere in the app", () => {
    const result = resolveBulkArrivals(["TA-1042"], [record({ id: "p1", sku: "TA-1042", arrived: null })]);
    expect(result.alreadyArrivedCount).toBe(0);
    expect(result.updateIds).toEqual(["p1"]);
  });

  it("REGRESSION: false (not just null) is also treated as not-arrived", () => {
    const result = resolveBulkArrivals(["TA-1042"], [record({ id: "p1", sku: "TA-1042", arrived: false })]);
    expect(result.updateIds).toEqual(["p1"]);
  });

  it("multiple purchase records sharing one SKU (e.g. a multi-quantity order) are all matched and reported as a duplicate match", () => {
    const records = [
      record({ id: "p1", sku: "TA-1042", arrived: false }),
      record({ id: "p2", sku: "TA-1042", arrived: false }),
      record({ id: "p3", sku: "TA-1042", arrived: true }),
    ];
    const result = resolveBulkArrivals(["TA-1042"], records);
    expect(result.matchedPurchaseCount).toBe(3);
    expect(result.duplicateMatches).toEqual([{ sku: "TA-1042", purchaseCount: 3 }]);
    expect(result.alreadyArrivedCount).toBe(1);
    expect(result.updateIds.sort()).toEqual(["p1", "p2"]);
  });

  it("a SKU matching exactly one purchase is never listed in duplicateMatches", () => {
    const result = resolveBulkArrivals(["TA-1042"], [record({ id: "p1", sku: "TA-1042" })]);
    expect(result.duplicateMatches).toEqual([]);
  });

  it("mixed matched and unmatched SKUs are both reported in the same call", () => {
    const records = [record({ id: "p1", sku: "TA-1042", arrived: false }), record({ id: "p2", sku: "TA-1045", arrived: true })];
    const result = resolveBulkArrivals(["TA-1042", "TA-1045", "TA-9999"], records);
    expect(result.enteredCount).toBe(3);
    expect(result.matchedPurchaseCount).toBe(2);
    expect(result.updatedPurchaseCount).toBe(1);
    expect(result.alreadyArrivedCount).toBe(1);
    expect(result.notFoundSkus).toEqual(["TA-9999"]);
  });

  it("purchases with a null/blank sku are never matched by anything", () => {
    const records = [record({ id: "p1", sku: null }), record({ id: "p2", sku: "" })];
    const result = resolveBulkArrivals(["TA-1042"], records);
    expect(result.matchedPurchaseCount).toBe(0);
    expect(result.notFoundSkus).toEqual(["TA-1042"]);
  });

  it("REQUIREMENT: matches the worked example shape (unique entered / matched / already arrived / to update / not found)", () => {
    const records = [
      ...Array.from({ length: 17 }, (_, i) => record({ id: `p${i}`, sku: `SKU-${i}`, arrived: i < 3 })),
    ];
    const skus = [...records.map(r => r.sku as string), "MISSING-1", "MISSING-2", "MISSING-3"];
    const result = resolveBulkArrivals(skus, records);
    expect(result.enteredCount).toBe(20);
    expect(result.matchedPurchaseCount).toBe(17);
    expect(result.alreadyArrivedCount).toBe(3);
    expect(result.updatedPurchaseCount).toBe(14);
    expect(result.notFoundSkus).toEqual(["MISSING-1", "MISSING-2", "MISSING-3"]);
  });

  it("retrying the exact same SKU list after an update is idempotent — everything now reports as already arrived, nothing left to update", () => {
    const records = [record({ id: "p1", sku: "TA-1042", arrived: true }), record({ id: "p2", sku: "TA-1045", arrived: true })];
    const result = resolveBulkArrivals(["TA-1042", "TA-1045"], records);
    expect(result.updateIds).toEqual([]);
    expect(result.updatedPurchaseCount).toBe(0);
    expect(result.alreadyArrivedCount).toBe(2);
  });

  it("exposes a sensible default maximum for a bulk request", () => {
    expect(MAX_BULK_ARRIVAL_SKUS).toBeGreaterThanOrEqual(500);
  });
});

describe("app/api/purchases/bulk-arrivals/route.ts — structural (Next.js server route touching Supabase directly; consistent with tests/security-boundaries.test.ts convention)", () => {
  const source = readFileSync("app/api/purchases/bulk-arrivals/route.ts", "utf8");

  it("requires owner authentication, same as the other purchase routes", () => {
    expect(source).toContain("await requireOwner();");
  });

  it("validates the request body with a strict zod schema", () => {
    expect(source).toContain("bulkArrivalsRequestSchema.parse(await request.json())");
  });

  it("rejects an empty SKU list", () => {
    expect(source).toContain("if (!uniqueSkus.length)");
    expect(source).toContain('{ error: "Enter at least one SKU." }');
  });

  it("enforces a maximum number of unique SKUs per request", () => {
    expect(source).toContain("uniqueSkus.length > MAX_BULK_ARRIVAL_SKUS");
  });

  it("re-derives the deduplicated SKU list itself rather than trusting the client's array as-is", () => {
    expect(source).toContain("parseSkuLines(skus.join(\"\\n\"))");
  });

  it("fetches the full purchases table server-side via supabaseRequestAll, never sending it to the browser", () => {
    expect(source).toContain("supabaseRequestAll<ArrivalRecord>(\"purchases?select=id,sku,arrived&sku=not.is.null&order=created_at.asc\")");
  });

  it("recomputes matches from a fresh fetch for BOTH preview and update — a client-supplied preview is never trusted for the final write", () => {
    const fetchIndex = source.indexOf("supabaseRequestAll<ArrivalRecord>");
    const actionCheckIndex = source.indexOf('action === "update"');
    expect(fetchIndex).toBeGreaterThan(-1);
    expect(actionCheckIndex).toBeGreaterThan(fetchIndex);
  });

  it("performs exactly one bulk PATCH via id=in.(...) — never a per-SKU loop of requests", () => {
    expect(source).toContain("purchases?id=in.(${updateIds.join(\",\")})");
    expect(source).toContain('method: "PATCH"');
    expect(source.match(/supabaseRequest\(/g)?.length).toBe(1);
  });

  it("sets arrived: true on the update, and nothing else", () => {
    expect(source).toContain("body: JSON.stringify({ arrived: true })");
  });

  it("never touches the expenses table", () => {
    expect(source).not.toContain("expenses");
  });

  it("skips the write entirely for a preview action", () => {
    expect(source).toContain('if (action === "update" && updateIds.length)');
  });

  it("returns updatedIds only for the update action, not the preview action", () => {
    expect(source).toContain('updatedIds: action === "update" ? updateIds : []');
  });

  it("routes failures through the shared safeApiError helper, never leaking raw errors", () => {
    expect(source).toContain('return safeApiError(error, "Could not process bulk arrivals.");');
  });
});

describe("components/BulkArrivalsDialog.tsx — structural (no React test harness in this project, per tests/purchases-arrival.test.ts convention)", () => {
  const source = readFileSync("components/BulkArrivalsDialog.tsx", "utf8");

  it("titles the modal 'Bulk mark arrivals' with the required explanation copy", () => {
    expect(source).toContain('<h2 id="bulk-arrivals-title">Bulk mark arrivals</h2>');
    expect(source).toContain("Enter one SKU per line. Matching purchases will be marked as arrived.");
  });

  it("never wraps the content in a <form> — Enter can never trigger an implicit submit", () => {
    expect(source).not.toContain("<form");
  });

  it("the textarea has an accessible label and a live SKU count", () => {
    expect(source).toContain('<label className="label" htmlFor="bulk-arrivals-skus">SKUs</label>');
    expect(source).toContain('id="bulk-arrivals-skus"');
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain("{uniqueSkus.length} SKU");
  });

  it("only Cmd/Ctrl+Enter triggers the preview action from the textarea — plain Enter is left alone (default newline behaviour)", () => {
    const fn = source.slice(source.indexOf("function handleTextareaKeyDown"), source.indexOf("const summary ="));
    expect(fn).toContain('(event.metaKey || event.ctrlKey) && event.key === "Enter"');
  });

  it("the primary compose-step button is disabled with no SKUs entered or while loading", () => {
    expect(source).toContain("disabled={!uniqueSkus.length || loading}");
  });

  it("the compose-step primary button is labelled 'Mark as arrived'", () => {
    expect(source).toContain('"Mark as arrived"');
  });

  it("Escape only closes the dialog when nothing is in flight", () => {
    expect(source).toContain('if (event.key === "Escape" && !loading) onClose();');
  });

  it("clicking the backdrop only closes while not loading", () => {
    expect(source).toContain("event.target === event.currentTarget && !loading");
  });

  it("sends the update action with the exact same parsed SKU list as the preview — the server, not this call, is what recomputes freshly", () => {
    expect(source).toContain('body: JSON.stringify({ action: "preview", skus: uniqueSkus })');
    expect(source).toContain('body: JSON.stringify({ action: "update", skus: uniqueSkus })');
  });

  it("shows the confirmation summary counts required before any update", () => {
    for (const label of ["unique SKU", "matching purchase", "already arrived", "will be marked as arrived"]) {
      expect(source).toContain(label);
    }
  });

  it("shows not-found SKUs with a copy-to-clipboard action, rather than silently ignoring them", () => {
    expect(source).toContain("navigator.clipboard.writeText");
    expect(source).toContain('aria-label="SKUs not found"');
  });

  it("REGRESSION: does not auto-close on success when there are unmatched SKUs — the result step always requires an explicit Done click", () => {
    expect(source).toContain('<button type="button" className="button" onClick={onClose}>Done</button>');
    expect(source).not.toMatch(/setTimeout\(\s*onClose/);
  });

  it("keeps the entered SKU text intact on a failed request (no clearing of `text` on error)", () => {
    expect(source).not.toMatch(/catch[\s\S]{0,40}setText\(/);
  });

  it("disables Cancel/Close controls while a request is in flight, preventing duplicate submission", () => {
    expect(source).toContain('<button type="button" className="button-secondary" onClick={onClose} disabled={loading}>Cancel</button>');
  });

  it("guards every submit path against a duplicate concurrent submission via the submitting ref", () => {
    expect(source).toContain("if (submitting.current || loading || !uniqueSkus.length) return;");
    expect(source).toContain("if (submitting.current || loading) return;");
  });
});

describe("app/purchases/page.tsx — Bulk mark arrivals button and page-state wiring", () => {
  const source = readFileSync("app/purchases/page.tsx", "utf8");

  it("renders a 'Bulk mark arrivals' button alongside the other purchase actions", () => {
    expect(source).toContain('<button type="button" className="button-secondary" onClick={() => setBulkArrivalsOpen(true)}>Bulk mark arrivals</button>');
  });

  it("renders BulkArrivalsDialog wired to close and apply handlers", () => {
    expect(source).toContain('{bulkArrivalsOpen && <BulkArrivalsDialog onClose={() => setBulkArrivalsOpen(false)} onApplied={applyBulkArrivals} />}');
  });

  it("patches only the updated rows in place (never a full-table replace) and still revalidates via the existing load() pattern", () => {
    const fn = source.slice(source.indexOf("function applyBulkArrivals"), source.indexOf("return <section"));
    expect(fn).toContain("setRows(current => current.map(row => updated.has(row.id) ? { ...row, arrived: true } : row))");
    expect(fn).toContain("load();");
  });

  it("does not touch the existing individual ArrivalToggle wiring", () => {
    expect(source).toContain("<ArrivalToggle id={row.id} arrived={row.arrived} description={row.item_description} onToggle={toggleArrived} />");
  });
});
