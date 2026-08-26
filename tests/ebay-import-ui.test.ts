import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const dialog = readFileSync("components/listing-studio/ImportEbayListingsDialog.tsx", "utf8");
const workspace = readFileSync("components/listing-studio/GroupingWorkspace.tsx", "utf8");
const card = readFileSync("components/listing-studio/ProductGroupCard.tsx", "utf8");
const migration = readFileSync("supabase-listing-studio.sql", "utf8");
const extensionQueueRoute = readFileSync("app/api/extension/ebay-imports/route.ts", "utf8");

describe("Listing Studio eBay import integration", () => {
  it("uses the requested plural label and accepts one URL per line", () => {
    expect(workspace).toContain("Import listings");
    expect(dialog).toContain("Paste one eBay item URL per line");
    expect(dialog).toContain("rawUrls.split(/\\r?\\n/)");
  });

  it("shows every extension-driven persistent processing stage", () => {
    for (const label of ["Waiting for extension", "Reading in extension", "Saving photos", "Adding to Listing Studio", "Imported", "Failed", "Open Listing Assistant"]) expect(dialog).toContain(label);
    expect(dialog).toContain("/api/listing-studio/ebay-imports");
  });

  it("shows the combined queue and allows waiting imports to be cleared", () => {
    expect(dialog).toContain("batches.flatMap");
    expect(dialog).toContain("Clear waiting");
    expect(dialog).toContain('method: "DELETE"');
  });

  it("marks imported rows without creating a parallel listing card", () => {
    expect(card).toContain("Imported from eBay");
    expect(card).toContain('group.source_type === "ebay_uk"');
  });

  it("persists batches, items and source provenance in Supabase", () => {
    expect(migration).toContain("create table if not exists public.ebay_import_batches");
    expect(migration).toContain("create table if not exists public.ebay_import_items");
    expect(migration).toContain("source_type in ('photos', 'ebay_uk')");
  });

  it("offers the newest waiting import batches before retained completed history", () => {
    expect(extensionQueueRoute).toMatch(/ebay_import_batches\?[^`]+order=created_at\.desc/);
  });
});
