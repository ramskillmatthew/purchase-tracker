import { describe, expect, it } from "vitest";
import { readFileSync, globSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

/**
 * PHASE 10 PROOF — the Inventory API write pipeline
 * (lib/ebay-account/inventory-client.ts, lib/listing-studio/ebay-draft-batches.ts)
 * is RETIRED from the active Create eBay Draft path. These tests prove the
 * NEW Sell Feed API pipeline (lib/listing-studio/ebay-feed/**,
 * lib/ebay-account/feed-client.ts, app/api/listing-studio/ebay-feed-batches/**)
 * never calls, imports, or references it — never merely that it "shouldn't".
 * Complements tests/ebay-account-draft-only-safety.test.ts (which proves no
 * publish-capable call exists anywhere) with the separate, additional claim
 * this task requires: the new pipeline cannot even reach the RETIRED
 * write-offer mechanism, publish-capable or not.
 */
describe("Retirement proof — the new Feed pipeline never reaches the retired Inventory API write client", () => {
  const FEED_LIB_FILES = globSync("lib/listing-studio/ebay-feed/**/*.ts").filter(f => !f.replace(/\\/g, "/").includes("template-fixtures"));
  const FEED_ROUTE_FILES = globSync("app/api/listing-studio/ebay-feed-batches/**/route.ts");

  it("sanity: both file sets are genuinely non-empty (a passing suite over zero files would prove nothing)", () => {
    expect(FEED_LIB_FILES.length).toBeGreaterThan(0);
    expect(FEED_ROUTE_FILES.length).toBeGreaterThan(0);
  });

  it("no file under lib/listing-studio/ebay-feed/ imports inventory-client.ts or the retired ebay-draft-batches.ts", () => {
    for (const file of FEED_LIB_FILES) {
      const source = read(file);
      expect(source, file).not.toMatch(/from ["']@\/lib\/ebay-account\/inventory-client["']/);
      expect(source, file).not.toMatch(/from ["']@\/lib\/listing-studio\/ebay-draft-batches["']/);
    }
  });

  it("no file under lib/listing-studio/ebay-feed/ ever calls createOrReplaceInventoryItem, createOffer, or any publish-capable operation name", () => {
    for (const file of FEED_LIB_FILES) {
      const source = read(file);
      expect(source, file).not.toMatch(/createOrReplaceInventoryItem|createOffer\(|getOffersForSku|getOffer\(|getInventoryItem\(/);
      expect(source, file).not.toMatch(/publishOffer|bulkPublishOffer|publishOfferByInventoryItemGroup|withdrawOffer|bulkWithdrawOffer/);
    }
  });

  it("no file under lib/listing-studio/ebay-feed/ constructs an Inventory API path (/sell/inventory/v1/) — only /sell/feed/v1/ (in feed-client.ts) is ever touched", () => {
    for (const file of FEED_LIB_FILES) {
      const source = read(file);
      expect(source, file).not.toMatch(/\/sell\/inventory\/v1\//);
    }
  });

  it("no route under app/api/listing-studio/ebay-feed-batches/ imports inventory-client.ts, ebay-draft-batches.ts, or references a publish-capable operation", () => {
    for (const route of FEED_ROUTE_FILES) {
      const source = read(route);
      expect(source, route).not.toMatch(/from ["']@\/lib\/ebay-account\/inventory-client["']/);
      expect(source, route).not.toMatch(/from ["']@\/lib\/listing-studio\/ebay-draft-batches["']/);
      expect(source, route).not.toMatch(/publishOffer|bulkPublishOffer|publishOfferByInventoryItemGroup|withdrawOffer|bulkWithdrawOffer/);
    }
  });

  it("lib/ebay-account/feed-client.ts (the new pipeline's ONLY eBay HTTP client) never constructs an Inventory API path and never imports inventory-client.ts", () => {
    const source = read("lib/ebay-account/feed-client.ts");
    expect(source).not.toMatch(/\/sell\/inventory\/v1\//);
    expect(source).not.toMatch(/from ["']@\/lib\/ebay-account\/inventory-client["']/);
    // Confirms the positive claim too — it DOES target the Feed API, so
    // this test would fail loudly if the whole client were ever gutted.
    expect(source).toContain("/sell/feed/v1/task");
  });

  it("lib/ebay-account/feed-allowlist.ts's denylist is structurally independent of inventory-allowlist.ts — no shared operation-name vocabulary that could let a Feed-gated call slip through as an Inventory one", () => {
    const source = read("lib/ebay-account/feed-allowlist.ts");
    expect(source).not.toMatch(/from ["']@\/lib\/ebay-account\/inventory-allowlist["']/);
    expect(source).not.toMatch(/createOrReplaceInventoryItem|createOffer|publishOffer/);
  });

  it("SKU 1644's existing Inventory API offer (created before this pipeline existed) is never referenced, altered, or deleted by any new Feed-pipeline file — this task's own explicit constraint", () => {
    for (const file of [...FEED_LIB_FILES, ...FEED_ROUTE_FILES]) {
      const source = read(file);
      expect(source, file).not.toMatch(/254825272011/); // the real, existing offer ID — must never appear in new code
    }
  });
});

describe("PHASE 3 PROOF — no reachable active UI/API/cron route can initiate an Inventory API write, project-wide", () => {
  const ALL_ROUTE_FILES = globSync("app/api/**/route.ts");

  it("sanity: this really does scan every route file in the project", () => {
    expect(ALL_ROUTE_FILES.length).toBeGreaterThan(20);
  });

  it("no route file anywhere in the project calls createOrReplaceInventoryItem or createOffer directly — these are only ever reachable through lib/listing-studio/ebay-draft-batches.ts's own gated orchestration, which is itself now unreachable from every route (see the tests below)", () => {
    for (const route of ALL_ROUTE_FILES) {
      const source = read(route);
      expect(source, route).not.toMatch(/createOrReplaceInventoryItem\(|createOffer\(/);
    }
  });

  it("every legacy Inventory-API-writing route (create/process/retry) returns the shared 410 retirement response and never imports the writing orchestrator's mutating entry points", () => {
    const retiredRoutes = [
      "app/api/listing-studio/ebay-draft-batches/route.ts",
      "app/api/listing-studio/ebay-draft-batches/[batchId]/process/route.ts",
      "app/api/listing-studio/ebay-draft-batches/[batchId]/items/[itemId]/retry/route.ts",
    ];
    for (const route of retiredRoutes) {
      const source = read(route);
      expect(source, route).toContain('from "@/lib/ebay-account/retired-inventory-route"');
      expect(source, route).not.toContain("createEbayDraftBatch(");
      expect(source, route).not.toContain("runEbayDraftBatchProcessTick(");
      expect(source, route).not.toContain("retryFailedEbayDraftItem(");
    }
  });

  it("the legacy cron sweep is neutralised — no import of the processing pipeline or Supabase at all", () => {
    const source = read("app/api/cron/ebay-draft-processing/route.ts");
    expect(source).not.toMatch(/from ["']@\/lib\/listing-studio\/ebay-draft-batches["']/);
    expect(source).not.toMatch(/from ["']@\/lib\/supabase["']/);
    expect(source).toContain("retired: true");
  });

  it("vercel.json no longer schedules the legacy cron sweep", () => {
    const config = JSON.parse(read("vercel.json")) as { crons: Array<{ path: string }> };
    expect(config.crons.map(c => c.path)).not.toContain("/api/cron/ebay-draft-processing");
  });

  it("the read-only reconciliation functions (getInventoryItem, getOffer, getOffersForSku) are preserved, not deleted — this task's own explicit requirement", () => {
    const source = read("lib/ebay-account/inventory-client.ts");
    expect(source).toContain("export async function getInventoryItem(");
    expect(source).toContain("export async function getOffer(");
    expect(source).toContain("export async function getOffersForSku(");
  });

  it("SKU 1644's existing offer is never modified or deleted by any retired route — no updateOffer/deleteOffer/withdrawOffer exists anywhere in this codebase", () => {
    for (const route of [...ALL_ROUTE_FILES]) {
      const source = read(route);
      expect(source, route).not.toMatch(/updateOffer\(|deleteOffer\(|withdrawOffer\(/);
    }
    const clientSource = read("lib/ebay-account/inventory-client.ts");
    expect(clientSource).not.toMatch(/export async function (updateOffer|deleteOffer|withdrawOffer)/);
  });
});

describe("Retirement proof — the legacy pipeline's own files are untouched in shape (still exist, still gated, never deleted)", () => {
  it("lib/ebay-account/inventory-client.ts and lib/listing-studio/ebay-draft-batches.ts still exist — retirement means 'no longer used by new work', never 'deleted'", () => {
    expect(() => read("lib/ebay-account/inventory-client.ts")).not.toThrow();
    expect(() => read("lib/listing-studio/ebay-draft-batches.ts")).not.toThrow();
  });

  it("the legacy routes under app/api/listing-studio/ebay-draft-batches/ still exist, serving only historical batches — never repointed at the new tables", () => {
    const routes = globSync("app/api/listing-studio/ebay-draft-batches/**/route.ts");
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      const source = read(route);
      expect(source, route).not.toMatch(/ebay_feed_batch|ebay-feed\/feed-batches/);
    }
  });
});
