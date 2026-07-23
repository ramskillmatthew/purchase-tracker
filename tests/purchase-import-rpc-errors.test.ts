import { describe, expect, it } from "vitest";
import { classifyRpcError } from "@/lib/purchase-import/rpc-errors";

function postgrestError(code: string) {
  // Mirrors what supabaseRequest actually throws: an Error whose message is
  // the raw PostgREST response body text, which — for a plain `raise
  // exception 'CODE'` — contains that code as a substring of the JSON.
  return new Error(JSON.stringify({ code: "P0001", message: code, details: null, hint: null }));
}

describe("classifyRpcError", () => {
  it.each([
    ["CANDIDATE_NOT_FOUND", "candidate_not_found"],
    ["CANDIDATE_NOT_PENDING", "already_processed"],
    ["CANDIDATE_MISSING_KEY", "missing_identity_key"],
    ["POSSIBLE_DUPLICATE_ORDER", "possible_duplicate_order"],
    ["INCOMPLETE_ORDER_SELECTION", "incomplete_selection"],
    ["ORDER_TOTAL_MISMATCH", "order_total_mismatch"],
    ["INCONSISTENT_ORDER_TOTAL", "inconsistent_order_total"],
    ["INVALID_PRICE_PRECISION", "invalid_price_precision"],
  ])("classifies %s as the known conflict %s", (code, reason) => {
    expect(classifyRpcError(postgrestError(code))).toBe(reason);
  });

  it("REGRESSION: an unrecognized error (missing function/migration, permission denied, network failure, etc.) is never classified as a known conflict", () => {
    expect(classifyRpcError(new Error("function public.import_purchase_order(uuid, jsonb) does not exist"))).toBeNull();
    expect(classifyRpcError(new Error("permission denied for function import_purchase_order"))).toBeNull();
    expect(classifyRpcError(new Error("fetch failed"))).toBeNull();
    expect(classifyRpcError(new Error("relation \"public.purchases\" does not exist"))).toBeNull();
  });

  it("returns null for a non-Error thrown value", () => {
    expect(classifyRpcError("some string")).toBeNull();
    expect(classifyRpcError(undefined)).toBeNull();
  });
});
