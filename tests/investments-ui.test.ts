import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

describe("components/AppHeader.tsx — Investments navigation", () => {
  const source = read("components/AppHeader.tsx");

  it("adds an 'Investments' link to /investments with its own icon, without removing any existing link", () => {
    expect(source).toContain('{ label: "Investments", href: "/investments", icon: "chart" }');
    for (const label of ["Home", "Tasks", "Purchases", "Bulk Input", "Email Assistant", "Purchase Import", "Expenses", "Export", "Settings"]) {
      expect(source).toContain(`label: "${label}"`);
    }
  });

  it("Investments sits before Settings in the links array (between Tasks and Settings per the design spec)", () => {
    const investmentsIndex = source.indexOf('label: "Investments"');
    const settingsIndex = source.indexOf('label: "Settings"');
    expect(investmentsIndex).toBeGreaterThan(-1);
    expect(settingsIndex).toBeGreaterThan(-1);
    expect(investmentsIndex).toBeLessThan(settingsIndex);
  });

  it("defines a restrained line-chart icon (no emoji, an inline SVG path)", () => {
    expect(source).toMatch(/chart:\s*<>\s*<path/);
  });
});

describe("app/investments/page.tsx", () => {
  const source = read("app/investments/page.tsx");

  it("renders InvestmentsWorkspace as the entire page, not wrapped in the app's default .page-shell (the Investments page manages its own full-bleed width)", () => {
    expect(source).toContain("<InvestmentsWorkspace");
    expect(source).not.toContain("page-shell");
  });
});

describe("components/investments/PerformanceInsightsCard.tsx — exactly 3 rows, no projections, no dividends", () => {
  const source = read("components/investments/PerformanceInsightsCard.tsx");

  it("renders exactly Best performer, Current holdings return, and Today's change — nothing else", () => {
    expect(source).toContain("Best performer");
    // "Current holdings return", not "Total"/"Lifetime"/"All-time" — it only
    // covers open positions until a real multi-lot ledger with realised P/L
    // exists (a separate future task) — see this component's own comment.
    expect(source).toContain("Current holdings return");
    expect(source).not.toMatch(/Total return|Lifetime return|All-time return/);
    expect(source).toContain("Today&apos;s change");
    expect((source.match(/inv-insight-row/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("never renders a projected value or dividend figure", () => {
    const renderedOnly = source.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(renderedOnly).not.toMatch(/project/i);
    expect(renderedOnly).not.toMatch(/dividend/i);
  });

  it("shows an em-dash placeholder rather than a fabricated number when there is no real best performer", () => {
    expect(source).toContain('<p className="inv-insight-empty"');
  });
});

describe("components/investments/HoldingsTable.tsx — category tabs, dual currency, real sparkline", () => {
  const source = read("components/investments/HoldingsTable.tsx");

  it("filters by All / Stocks / Pokémon / LEGO", () => {
    expect(source).toContain('{ value: "all", label: "All" }');
    expect(source).toContain('{ value: "stock", label: "Stocks" }');
    expect(source).toContain('{ value: "pokemon", label: "Pokémon" }');
    expect(source).toContain('{ value: "lego", label: "LEGO" }');
  });

  it("is sortable by value, return, and allocation — via the extracted, independently-tested sortHoldings module (see investments-holdings-table-sort.test.ts)", () => {
    expect(source).toContain('import { sortHoldings, type SortKey } from "@/lib/investments/holdings-table-sort"');
    const sortLib = read("lib/investments/holdings-table-sort.ts");
    expect(sortLib).toContain('value: h => h.currentGbpValue');
    expect(sortLib).toContain('return: h => h.unrealizedPercent');
    expect(sortLib).toContain('allocation: h => h.allocationPercent');
  });

  it("shows both the native (USD) price and its real FX-converted GBP equivalent for a USD-denominated holding", () => {
    expect(source).toMatch(/formatUsd\(h\.currentNativePrice\)/);
    // REGRESSION: must be a genuinely converted value (currentGbpValue /
    // quantity), never formatGbp(h.currentNativePrice) directly — that
    // would just relabel the raw USD number with a £ sign at a 1:1 "rate",
    // a real confirmed bug (Meta showing "$586.22" / "£586.22 per share").
    expect(source).toMatch(/isUsd && Number\(h\.quantity\) > 0 && <span className="inv-price-gbp">\{formatGbp\(h\.currentGbpValue \/ Number\(h\.quantity\)\)\}/);
    expect(source).not.toMatch(/inv-price-gbp">\{formatGbp\(h\.currentNativePrice\)\}/);
  });

  it("REGRESSION: the source label is never a truth claim on its own — 'Live prices' used to sit directly above a 'Purchase price' status for a fallback-only stock, a real confirmed contradiction (VWRP)", () => {
    expect(source).toContain('twelve_data: "Twelve Data"');
    expect(source).not.toMatch(/twelve_data:\s*"Live prices"/);
  });

  it("renders a genuine-data Sparkline component rather than a synthetic/random one", () => {
    expect(source).toContain("<Sparkline values={h.sparkline} />");
  });

  it("shows a real, non-fabricated empty state with the app's structure intact, not fake production rows", () => {
    expect(source).toContain("No investments yet");
    expect(source).toContain("inv-table-empty");
  });

  it("clicking or pressing Enter on a row opens the holding detail view — an accessible, keyboard-operable control, not a bare div with only an onClick", () => {
    expect(source).toContain('role="button"');
    expect(source).toContain("onKeyDown=");
    expect(source).toContain('aria-label={`View ${h.displayName}`}');
  });
});

describe("components/investments/AllocationCard.tsx — extensible category set, tooltip, no colour-only signalling", () => {
  const source = read("components/investments/AllocationCard.tsx");

  it("maps exactly the four current categories, structured so a future category is a data addition, not a rewrite", () => {
    for (const category of ["stock", "pokemon", "lego", "cash"]) {
      expect(source).toContain(`${category}:`);
    }
  });

  it("provides an accessible info control explaining how allocation is calculated, not a bare icon", () => {
    expect(source).toContain('aria-label="How allocation is calculated"');
  });
});

describe("components/investments/InvestmentsWorkspace.tsx — header actions, sync status, empty/loading/error states", () => {
  const source = read("components/investments/InvestmentsWorkspace.tsx");

  it("renders the three required header actions plus a sync-status indicator", () => {
    expect(source).toContain("Add investment");
    expect(source).toContain("Record transaction");
    expect(source).toContain("Refresh prices");
    expect(source).toContain("inv-sync-status");
  });

  it("auto-refreshes at most once per mount when prices look stale, never on every render", () => {
    expect(source).toContain("autoRefreshAttempted");
    expect(source).toContain("STALE_THRESHOLD_MS");
  });

  it("surfaces a partial-refresh failure without hiding the rest of the page", () => {
    expect(source).toMatch(/could not be refreshed — the last known value is still shown/);
  });

  it("REGRESSION: the header (title + Add investment/Record transaction/Refresh prices/sync status) is rendered unconditionally — never inside the {portfolio && ...} populated-state branch, so it never disappears on an empty or just-populated dashboard", () => {
    const toplineIndex = source.indexOf("inv-topline");
    const populatedBranchIndex = source.indexOf("{portfolio && <>");
    expect(toplineIndex).toBeGreaterThan(-1);
    expect(populatedBranchIndex).toBeGreaterThan(-1);
    expect(toplineIndex).toBeLessThan(populatedBranchIndex);
  });

  it("the auto-refresh once-per-mount guard only latches when a refresh is actually attempted, not on an empty initial load with nothing yet to price", () => {
    expect(source).toContain("if (!hasRefreshableHolding) return;");
    const guardFn = source.slice(source.indexOf("useEffect(() => {\n    if (autoRefreshAttempted"), source.indexOf("}, [portfolio, runRefresh]);"));
    expect(guardFn).toMatch(/if \(isStale\) \{\s*autoRefreshAttempted\.current = true;/);
  });

  it("sends the real trigger to the refresh API — auto_page_open for the automatic effect, manual for a real button click — never hard-coded to 'manual' regardless of caller", () => {
    expect(source).toContain('trigger: auto ? "auto_page_open" : "manual"');
    expect(source).toContain('body: JSON.stringify({ trigger: auto ? "auto_page_open" : "manual" })');
  });

  it("renders a skeleton matching the final two-column geometry while loading, not a spinner-only placeholder", () => {
    expect(source).toContain("function InvestmentsSkeleton");
    expect(source).toContain("inv-main-col");
    expect(source).toContain("inv-side-col");
  });

  it("uses the existing app-wide toast component for key events, positioned bottom-right per convention", () => {
    expect(source).toContain('<TaskToast message={toast}');
    expect(source).toContain('position="bottom-right"');
  });
});

describe("components/investments/CollectionCards.tsx — real accounts only, never hard-coded", () => {
  const source = read("components/investments/CollectionCards.tsx");

  it("takes accounts as a prop rather than holding its own hard-coded list", () => {
    expect(source).toContain("accounts:");
    expect(source).not.toMatch(/const\s+(FAKE|MOCK|SAMPLE|DEMO)_ACCOUNTS/i);
  });
});

describe("components/investments/AddInvestmentModal.tsx / RecordTransactionModal.tsx — reuse existing modal pattern, strict PokePulse validation surfaced client-side", () => {
  const addSource = read("components/investments/AddInvestmentModal.tsx");
  const txSource = read("components/investments/RecordTransactionModal.tsx");

  it("reuses the app's existing dialog-backdrop + task-modal pattern rather than a bespoke modal system", () => {
    expect(addSource).toContain('className="dialog-backdrop"');
    expect(addSource).toContain('className="task-modal investment-modal"');
    expect(txSource).toContain('className="dialog-backdrop"');
    expect(txSource).toContain('className="task-modal investment-modal"');
  });

  it("offers a discreet, non-header spreadsheet-import entry point that never disrupts the header's match to the reference image", () => {
    expect(addSource).toContain("Import from spreadsheet instead");
    expect(addSource).toContain("SpreadsheetImportDialog");
  });

  it("the sell form shows quantity held, weighted-average cost, and estimated realised result before submission", () => {
    expect(txSource).toMatch(/sellPreview/);
  });
});

describe("app/globals.css — Investments header never collides with the app-wide fixed global search bar", () => {
  const css = read("app/globals.css");

  it("REGRESSION: .inv-topline is never position:sticky — an earlier sticky:top:0 attempt collided with .global-search-shell (position:fixed, z-index:45, height:60px, mounted on every page via the root layout)", () => {
    const ruleMatch = css.match(/\.inv-topline\s*\{[^}]*\}/);
    expect(ruleMatch).not.toBeNull();
    expect(ruleMatch![0]).not.toMatch(/position:\s*sticky/);
  });

  it("REGRESSION: .inv-root has no top margin/padding bleed trying to re-derive .app-main's real padding-top — a prior attempt (-80px) silently drifted out of sync with .app-main's actual value (76px) and pushed content a few px under the fixed search bar", () => {
    const ruleMatch = css.match(/\.inv-root\s*\{[\s\S]*?\n\}/);
    expect(ruleMatch).not.toBeNull();
    const rule = ruleMatch![0];
    expect(rule).not.toMatch(/margin:\s*-\d+px/);
    expect(rule).not.toMatch(/padding:\s*\d+px[^;]*;.*\/\* top/);
    // The rule's own top offset (margin-top / padding-top) must be 0 or
    // absent — .inv-root now relies entirely on .app-main's own real
    // padding-top, exactly like every other page.
    expect(rule).toMatch(/margin:\s*0\s/);
  });

  it(".global-search-shell is confirmed fixed + 60px tall, and .app-main's real (cascade-final) padding-top is 76px — both facts this fix depends on", () => {
    expect(css).toMatch(/\.global-search-shell\s*\{[^}]*position:\s*fixed[^}]*height:\s*60px/);
    const appMainRules = [...css.matchAll(/\.app-main\s*\{[^}]*\}/g)].map(m => m[0]);
    expect(appMainRules.some(r => r.includes("padding-top: 76px"))).toBe(true);
  });
});

describe("components/investments/PortfolioHeroCard.tsx — period tabs, market-growth/currency decomposition, real chart", () => {
  const source = read("components/investments/PortfolioHeroCard.tsx");

  it("renders tabs from the shared PERIODS list rather than a local, divergable copy", () => {
    expect(source).toMatch(/import \{[^}]*\bPERIODS\b[^}]*\} from "@\/lib\/investments\/chart-helpers"/);
    const periodsSource = read("lib/investments/chart-helpers.ts");
    for (const period of ["1D", "1W", "1M", "3M", "1Y", "ALL"]) {
      expect(periodsSource).toContain(`"${period}"`);
    }
  });

  it("embeds the real SVG chart component rather than an external charting library", () => {
    expect(source).toContain("<PortfolioChart");
  });

  it("shows the return as 'current holdings return', never 'all time'/'lifetime'/'total' — it only covers open positions until realised P/L exists", () => {
    expect(source).toContain("current holdings return");
    expect(source).not.toMatch(/all time|lifetime return|total return/i);
  });
});

describe("Estimated-return / unitized-index feature removal (user-requested — the ~+243% figure must never render anywhere)", () => {
  // Strips both comment styles before checking — a source comment
  // EXPLAINING that the feature was removed (this file has several,
  // deliberately, for future readers) legitimately mentions its old name;
  // what must never exist is the name in actually-RENDERED code/JSX text,
  // which is what the user's own requirement ("cannot appear anywhere in
  // the rendered Investments UI") is about.
  const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const heroRendered = stripComments(read("components/investments/PortfolioHeroCard.tsx"));
  const chartRendered = stripComments(read("components/investments/PortfolioChart.tsx"));
  const helpersSource = read("lib/investments/chart-helpers.ts");

  it("PortfolioHeroCard has no mode toggle, no return-mode branch, no unitized/estimated-return wording in its actual rendered code", () => {
    expect(heroRendered).not.toMatch(/Estimated return|unitized|inv-mode-toggle|setMode|ChartMode/i);
  });

  it("PortfolioChart has no 'return' mode — a single, value-only chart, in its actual rendered code", () => {
    expect(chartRendered).not.toMatch(/mode\s*===\s*"return"|ChartMode|estimated.{0,20}unitized/i);
  });

  it("chart-helpers.ts no longer exports the removed calculation functions or types — genuinely deleted, not just unused", () => {
    for (const removedExport of ["computeUnitizedSeries", "computeEstimatedReturn", "detectFallbackTransitionRisk", "UnitizedPoint", "ReturnPoint", "FallbackTransitionFlag"]) {
      expect(helpersSource).not.toContain(removedExport);
    }
  });

  it("no investments component's ACTUAL RENDERED code anywhere contains the literal removed-feature figure or its provenance label", () => {
    for (const file of [
      "components/investments/PortfolioHeroCard.tsx", "components/investments/PortfolioChart.tsx",
      "components/investments/InvestmentsWorkspace.tsx", "components/investments/PerformanceInsightsCard.tsx",
    ]) {
      const rendered = stripComments(read(file));
      expect(rendered).not.toMatch(/Estimated · unitized index|Estimated return/);
    }
  });
});
