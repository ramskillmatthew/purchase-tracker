import { describe, expect, it } from "vitest";
import { classifySaleRpcError } from "@/lib/sales/rpc-errors";

function postgrestError(code: string) {
  // Mirrors what supabaseRequest actually throws: an Error whose message is
  // the raw PostgREST response body text, which — for a plain `raise
  // exception 'CODE'` — contains that code as a substring of the JSON.
  return new Error(JSON.stringify({ code: "P0001", message: code, details: null, hint: null }));
}

describe("classifySaleRpcError", () => {
  it.each([
    ["INVALID_PLATFORM", "invalid_platform"],
    ["CUSTOM_PLATFORM_NAME_REQUIRED", "custom_platform_name_required"],
    ["CUSTOM_PLATFORM_NAME_NOT_ALLOWED", "custom_platform_name_not_allowed"],
    ["INVALID_REVENUE_MODE", "invalid_revenue_mode"],
    ["NEGATIVE_AMOUNT", "negative_amount"],
    ["NO_ITEMS", "no_items"],
    ["TOO_MANY_ITEMS", "too_many_items"],
    ["DUPLICATE_PURCHASE_IDS", "duplicate_purchase_ids"],
    ["PURCHASE_NOT_FOUND", "purchase_not_found"],
    ["PURCHASE_NOT_AVAILABLE", "purchase_not_available"],
    ["PURCHASE_ALREADY_SOLD", "purchase_already_sold"],
    ["ITEMISED_LINES_REQUIRED", "itemised_lines_required"],
    ["ITEMISED_LINE_COUNT_MISMATCH", "itemised_line_count_mismatch"],
    ["ITEMISED_LINE_PURCHASE_MISMATCH", "itemised_line_purchase_mismatch"],
    ["ITEMISED_REVENUE_MISMATCH", "itemised_revenue_mismatch"],
    ["ITEMISED_DATA_NOT_ALLOWED", "itemised_data_not_allowed"],
  ])("classifies %s as the known conflict %s", (code, reason) => {
    expect(classifySaleRpcError(postgrestError(code))).toBe(reason);
  });

  it("REGRESSION: an unrecognized error (missing function/migration, permission denied, network failure, etc.) is never classified as a known conflict", () => {
    expect(classifySaleRpcError(new Error("function public.create_completed_sale(...) does not exist"))).toBeNull();
    expect(classifySaleRpcError(new Error("permission denied for function create_completed_sale"))).toBeNull();
    expect(classifySaleRpcError(new Error("fetch failed"))).toBeNull();
    expect(classifySaleRpcError(new Error("relation \"public.sales_orders\" does not exist"))).toBeNull();
  });

  it("returns null for a non-Error thrown value", () => {
    expect(classifySaleRpcError("some string")).toBeNull();
    expect(classifySaleRpcError(undefined)).toBeNull();
  });
});
