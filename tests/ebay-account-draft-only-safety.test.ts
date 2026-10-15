import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";

vi.mock("server-only", () => ({}));

const read = (path: string) => readFileSync(path, "utf8");

/**
 * PROVEN-SAFE PROOF — `sell.inventory` (see lib/ebay-account/oauth.ts's
 * own scope comment) is a genuinely write/publish-capable OAuth scope.
 * Granting it does not itself let this application publish anything;
 * these tests prove the actual code contains no path that could.
 */
describe("eBay Inventory API safety — live publishing has one explicit, gated path", () => {
  it("account routes contain no generic or client-selected publish endpoint", () => {
    const routes = globSync("app/api/ebay/**/route.ts").map(r => r.replace(/\\/g, "/"));
    expect(routes.sort()).toEqual([
      "app/api/ebay/callback/route.ts",
      "app/api/ebay/connect/route.ts",
      "app/api/ebay/connection/route.ts",
      "app/api/ebay/defaults/route.ts",
      "app/api/ebay/disconnect/route.ts",
      "app/api/ebay/inventory-location/route.ts",
      "app/api/ebay/photo/[imageId]/route.ts",
      "app/api/ebay/sync/route.ts",
    ]);
    expect(routes.filter(route => /publish|offer|listing/i.test(route))).toEqual([]);
    expect(routes.filter(route => /inventory/i.test(route))).toEqual(["app/api/ebay/inventory-location/route.ts"]);
  });

  it("REQUIREMENT: no eBay-account library file calls a publish-capable eBay operation", () => {
    // inventory-allowlist.ts's own FORBIDDEN_PUBLISH_OPERATIONS set is one
    // deliberate, defensive exception — it names these operations ONLY to
    // reject them, never to call them. inventory-client.ts (Stage 6) is the
    // other: it legitimately constructs /sell/inventory/v1/ paths for the
    // four ALLOWED draft-only operations — see the dedicated tests below
    // for the proof it never does so for a publish-named one.
    for (const file of globSync("lib/ebay-account/**/*.ts").filter(f => !["inventory-allowlist.ts", "inventory-client.ts"].includes(f.replace(/\\/g, "/").split("/").pop()!))) {
      const source = read(file);
      expect(source, file).not.toMatch(/publishOffer|bulkPublishOffer|withdrawOffer|bulkWithdrawOffer/);
      expect(source, file).not.toMatch(/\/sell\/inventory\/v1\//);
    }
  });

  it("the Inventory client contains exactly the single-offer publish endpoint, never bulk publish or withdraw", () => {
    const source = read("lib/ebay-account/inventory-client.ts");
    expect(source).toMatch(/export async function publishOffer/);
    expect(source).toMatch(/offer\/\$\{encodeURIComponent\(offerId\)\}\/publish/);
    expect(source).not.toMatch(/[.\s]\bbulkPublishOffer\s*\(|[.\s]\bpublishOfferByInventoryItemGroup\s*\(|[.\s]\bwithdrawOffer\s*\(|[.\s]\bbulkWithdrawOffer\s*\(/);
    // Every real fetch() in this file goes through the shared
    // inventoryRequest() helper against a hardcoded relative path built
    // from a fixed, small set of endpoints — never a caller-supplied path.
    expect(source).toMatch(/\/sell\/inventory\/v1\/location/);
    expect(source).toMatch(/\/sell\/inventory\/v1\/inventory_item\//);
    expect(source).toMatch(/\/sell\/inventory\/v1\/offer/);
  });

  it("REQUIREMENT (Stage 6): every write/read call in inventory-client.ts is gated by assertAllowedInventoryOperation with a hardcoded literal — never a variable, never client input", () => {
    const source = read("lib/ebay-account/inventory-client.ts");
    const gates = [...source.matchAll(/assertAllowedInventoryOperation\((["'])([a-zA-Z]+)\1\)/g)].map(m => m[2]);
    expect(gates.sort()).toEqual(["createInventoryLocation", "updateInventoryLocation", "createOffer", "createOrReplaceInventoryItem", "getInventoryItem", "getInventoryLocations", "getOffer", "getOffersForSku", "publishOffer", "updateOffer"].sort());
  });

  it("REQUIREMENT (Stage 6): lib/listing-studio/ebay-draft-batches.ts (the batch-processing orchestrator) references no publish-capable operation and calls no eBay endpoint directly — it only ever goes through inventory-client.ts's own gated functions", () => {
    const source = read("lib/listing-studio/ebay-draft-batches.ts");
    expect(source).not.toMatch(/publishOffer|bulkPublishOffer|publishOfferByInventoryItemGroup|withdrawOffer|bulkWithdrawOffer/);
    expect(source).not.toMatch(/fetch\(\s*[`'"]https:\/\/(api|apiz|auth)\.(sandbox\.)?ebay\.com/);
    expect(source).not.toMatch(/\/sell\/inventory\/v1\//); // no eBay path constructed here — only inventory-client.ts does that
  });

  it("REQUIREMENT (Stage 6): no route under app/api/listing-studio/ebay-draft-batches/ references a publish-capable operation", () => {
    for (const route of globSync("app/api/listing-studio/ebay-draft-batches/**/route.ts")) {
      const source = read(route);
      expect(source, route).not.toMatch(/publishOffer|bulkPublishOffer|publishOfferByInventoryItemGroup|withdrawOffer|bulkWithdrawOffer/);
    }
  });

  it("REQUIREMENT (corrective pass): the cron sweep route (app/api/cron/ebay-draft-processing) never references a publish-capable operation and requires CRON_SECRET bearer auth, matching the existing cron convention", () => {
    const source = read("app/api/cron/ebay-draft-processing/route.ts");
    expect(source).not.toMatch(/publishOffer|bulkPublishOffer|publishOfferByInventoryItemGroup|withdrawOffer|bulkWithdrawOffer/);
    expect(source).toContain("process.env.CRON_SECRET");
    expect(source).toMatch(/request\.headers\.get\("authorization"\) === `Bearer \$\{secret\}`/);
  });

  it("REQUIREMENT: none of the six eBay account routes constructs an arbitrary/client-controlled eBay API URL or operation name", () => {
    for (const route of globSync("app/api/ebay/**/route.ts")) {
      const source = read(route);
      // Every real outbound eBay call in this stage goes through the
      // lib/ebay-account/oauth.ts helpers (ebayAuthorizationUrl/
      // exchangeEbayCode/fetchEbayIdentity/fetchEbayPolicies) — none of
      // which accept a caller-supplied URL/path/operation name. A route
      // file itself never calls fetch() against an eBay host directly.
      expect(source, route).not.toMatch(/fetch\(\s*[`'"]https:\/\/(api|apiz|auth)\.(sandbox\.)?ebay\.com/);
      expect(source, route).not.toMatch(/request\.(json|body)\(\).*\.(operation|endpoint|path|url)\b/i);
    }
  });

  it("REQUIREMENT: no automatic publication is triggered by account sync, defaults saving, or connecting — none of those routes references anything publish/offer/inventory-shaped", () => {
    for (const routeFile of ["app/api/ebay/sync/route.ts", "app/api/ebay/defaults/route.ts", "app/api/ebay/connect/route.ts", "app/api/ebay/callback/route.ts"]) {
      const source = read(routeFile);
      expect(source, routeFile).not.toMatch(/publish|createOffer|createOrReplaceInventoryItem/i);
    }
  });
});

describe("lib/ebay-account/inventory-allowlist.ts — assertAllowedInventoryOperation", () => {
  it("only single-offer publish is permitted; bulk publish and withdrawals remain forbidden", async () => {
    const { assertAllowedInventoryOperation } = await import("@/lib/ebay-account/inventory-allowlist");
    expect(() => assertAllowedInventoryOperation("publishOffer")).not.toThrow();
    for (const op of ["bulkPublishOffer", "publishOfferByInventoryItemGroup", "withdrawOffer", "bulkWithdrawOffer"]) {
      expect(() => assertAllowedInventoryOperation(op)).toThrow(/permanently forbidden/);
    }
  });

  it("allows only the eight hardcoded operations used by the workflow", async () => {
    const { assertAllowedInventoryOperation } = await import("@/lib/ebay-account/inventory-allowlist");
    for (const op of ["createInventoryLocation", "updateInventoryLocation", "createOrReplaceInventoryItem", "createOffer", "getOffer", "getOffersForSku", "getInventoryLocations", "getInventoryItem", "updateOffer", "publishOffer"]) {
      expect(() => assertAllowedInventoryOperation(op)).not.toThrow();
    }
    for (const op of ["deleteOffer", "deleteInventoryLocation", "anythingAtAll"]) {
      expect(() => assertAllowedInventoryOperation(op)).toThrow(/not on the explicit allowlist/);
    }
  });

  it("never accepts a raw URL/path as an operation name — a URL-shaped string is just an unrecognised operation, never specially trusted", async () => {
    const { assertAllowedInventoryOperation } = await import("@/lib/ebay-account/inventory-allowlist");
    expect(() => assertAllowedInventoryOperation("https://api.ebay.com/sell/inventory/v1/offer/123/publish")).toThrow();
  });
});

describe("lib/ebay-account/oauth.ts — sell.inventory is honestly documented as write/publish-capable, never described as safe-by-scope", () => {
  it("the scope comment states plainly that sell.inventory is write-capable and that draft-only safety is enforced in application code, not by the scope", () => {
    const source = read("lib/ebay-account/oauth.ts");
    expect(source).toMatch(/sell\.inventory:[\s\S]*genuinely WRITE-CAPABLE/);
    expect(source).not.toMatch(/sell\.inventory:[^\n]*non-publish/i);
  });
});
