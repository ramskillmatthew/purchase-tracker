import { describe, expect, it } from "vitest";
import { classifyListingStudioRpcError, LISTING_STUDIO_RPC_ERRORS } from "@/lib/listing-studio/rpc-errors";

describe("classifyListingStudioRpcError", () => {
  it("maps every known RPC error code to its safe user-facing message", () => {
    for (const [code, message] of Object.entries(LISTING_STUDIO_RPC_ERRORS)) {
      expect(classifyListingStudioRpcError(new Error(`some raw postgres text containing ${code} somewhere`))).toBe(message);
    }
  });

  it("returns null for an unrecognized error, so it propagates as a genuine failure", () => {
    expect(classifyListingStudioRpcError(new Error("relation \"listing_drafts\" does not exist"))).toBeNull();
  });

  it("returns null for a non-Error value", () => {
    expect(classifyListingStudioRpcError("a plain string")).toBeNull();
    expect(classifyListingStudioRpcError(undefined)).toBeNull();
    expect(classifyListingStudioRpcError(null)).toBeNull();
  });

  it("never returns raw Postgres/Storage error text as the message — only the mapped, safe string", () => {
    const result = classifyListingStudioRpcError(new Error("ERROR: NO_IMAGES (SQLSTATE P0001) at character 42"));
    expect(result).toBe(LISTING_STUDIO_RPC_ERRORS.NO_IMAGES);
    expect(result).not.toContain("SQLSTATE");
  });
});
