import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function read(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

describe("Listings Review — eBay 'Needs review' explains every blocking reason", () => {
  const workspace = read("components/listings-review/ListingsReviewWorkspace.tsx");
  const panel = read("components/listings-review/ListingDetailsPanel.tsx");
  const table = read("components/listings-review/ListingsTable.tsx");

  it("uses the server's authoritative blocking and warning validation messages", () => {
    expect(workspace).toContain("function buildEbayReviewReasons");
    expect(workspace).toContain('message.severity === "blocking" || message.severity === "warning"');
    expect(workspace).toContain("message.message.trim()");
  });

  it("has defensive, human-readable fallbacks for every core field", () => {
    for (const reason of [
      "The eBay title is missing.",
      "The eBay description is missing.",
      "An eBay category has not been selected.",
      "An eBay condition has not been selected.",
      "The listing quantity is missing.",
      "Required eBay information is incomplete. Open eBay listing details to review it.",
    ]) expect(workspace).toContain(reason);
  });

  it("shows all reasons in the selected listing panel and gives a direct fix action", () => {
    expect(panel).toContain("What needs review");
    expect(panel).toContain("listing.ebay.reviewReasons.map");
    expect(panel).toContain("Review eBay details");
    expect(panel).toContain("onEditEbayDetails(listing.id)");
  });

  it("shows the first exact reason in the table instead of only the generic badge", () => {
    expect(table).toContain('row.ebayReviewReasons[0] ?? "Required information is incomplete."');
    expect(table).toContain("more)");
  });
});
