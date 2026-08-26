import { describe, expect, it } from "vitest";
import {
  classifyProviderError, isExchangeCurrentlyClosed, isGenuineFailure, isImplausiblePriceMovement, isPokePulseCodeRetryable, isPriceCurrentForLatestSession,
  latestCompletedTradingDate, POKEPULSE_UI_MESSAGES, willRetryAutomatically,
} from "@/lib/investments/refresh-classification";
import type { ProviderErrorCode } from "@/lib/investments/providers/types";

describe("classifyProviderError — real, confirmed-live provider error text", () => {
  it("Twelve Data's exact confirmed plan-restriction message classifies as unsupported_by_plan", () => {
    expect(classifyProviderError("This symbol is available starting with the Grow or Venture plan.", false)).toBe("unsupported_by_plan");
  });

  it("Twelve Data's exact confirmed per-minute rate-limit message classifies as rate_limited", () => {
    expect(classifyProviderError(
      "You have run out of API credits for the current minute. 9 API credits were used, with the current limit being 8. Wait for the next minute or consider switching to a higher tier plan",
      true,
    )).toBe("rate_limited");
  });

  it("PokePulse's exact confirmed no-price message classifies as no_data, never a generic failure", () => {
    expect(classifyProviderError("PokePulse returned no market price for this item.", true)).toBe("no_data");
  });

  it("a missing ticker/PokePulse-identity message classifies as provider_mapping_missing", () => {
    expect(classifyProviderError("This investment has no ticker on record.", false)).toBe("provider_mapping_missing");
    expect(classifyProviderError("This investment has no PokePulse identity on record.", false)).toBe("provider_mapping_missing");
  });

  it("an invalid-symbol message classifies as symbol_not_found, distinct from a plan restriction", () => {
    expect(classifyProviderError("Invalid symbol", false)).toBe("symbol_not_found");
  });

  it("a genuinely unrecognised retryable error falls back to provider_unavailable, never masquerading as a specific known cause", () => {
    expect(classifyProviderError("upstream timed out", true)).toBe("provider_unavailable");
  });

  it("a genuinely unrecognised non-retryable error falls back to invalid_response", () => {
    expect(classifyProviderError("unexpected shape", false)).toBe("invalid_response");
  });
});

describe("isGenuineFailure / willRetryAutomatically", () => {
  it("manual, fallback, unchanged, market-closed, and skipped outcomes are never genuine failures", () => {
    for (const outcome of ["updated", "unchanged_current", "market_closed_current", "manual", "fallback_purchase_price", "skipped_inactive"] as const) {
      expect(isGenuineFailure(outcome)).toBe(false);
    }
  });

  it("plan restriction, missing mapping, symbol-not-found, and invalid-response are genuine failures but never auto-retried", () => {
    for (const outcome of ["unsupported_by_plan", "symbol_not_found", "provider_mapping_missing", "invalid_response"] as const) {
      expect(isGenuineFailure(outcome)).toBe(true);
      expect(willRetryAutomatically(outcome)).toBe(false);
    }
  });

  it("rate_limited, provider_unavailable, and no_data are genuine failures that DO retry automatically", () => {
    for (const outcome of ["rate_limited", "provider_unavailable", "no_data"] as const) {
      expect(isGenuineFailure(outcome)).toBe(true);
      expect(willRetryAutomatically(outcome)).toBe(true);
    }
  });
});

describe("latestCompletedTradingDate — the direct fix for 'Friday close viewed on Sunday looks stale'", () => {
  it("on a Sunday, the latest completed US/LSE session is the preceding Friday", () => {
    const sunday = new Date("2026-08-16T15:00:00Z"); // confirmed: 2026-08-16 is a Sunday
    expect(latestCompletedTradingDate("US", sunday)).toBe("2026-08-14");
    expect(latestCompletedTradingDate("LSE", sunday)).toBe("2026-08-14");
  });

  it("on a Saturday, the latest completed session is also the preceding Friday", () => {
    const saturday = new Date("2026-08-15T12:00:00Z");
    expect(latestCompletedTradingDate("US", saturday)).toBe("2026-08-14");
  });

  it("on a weekday AFTER the exchange's own close, today itself is the latest completed session", () => {
    // 2026-08-13 is a Thursday. 20:00 UTC is 16:00 ET (US close) / 21:00 London (after LSE close).
    const afterClose = new Date("2026-08-13T20:00:00Z");
    expect(latestCompletedTradingDate("US", afterClose)).toBe("2026-08-13");
    expect(latestCompletedTradingDate("LSE", afterClose)).toBe("2026-08-13");
  });

  it("on a weekday BEFORE the exchange opens, the latest completed session is the previous weekday", () => {
    // 06:00 UTC is 02:00 ET (well before US open) and 07:00 London (before LSE's 08:00 open).
    const beforeOpen = new Date("2026-08-13T06:00:00Z");
    expect(latestCompletedTradingDate("US", beforeOpen)).toBe("2026-08-12");
    expect(latestCompletedTradingDate("LSE", beforeOpen)).toBe("2026-08-12");
  });

  it("on a Monday before open, the latest completed session rolls back over the weekend to Friday", () => {
    const mondayBeforeOpen = new Date("2026-08-17T06:00:00Z"); // 2026-08-17 is a Monday
    expect(latestCompletedTradingDate("US", mondayBeforeOpen)).toBe("2026-08-14");
  });
});

describe("isPriceCurrentForLatestSession", () => {
  it("a Friday close observed on the following Sunday IS current — never flagged as stale", () => {
    const sunday = new Date("2026-08-16T15:00:00Z");
    expect(isPriceCurrentForLatestSession("2026-08-14T00:00:00.000Z", "US", sunday)).toBe(true);
    expect(isPriceCurrentForLatestSession("2026-08-14T00:00:00.000Z", "LSE", sunday)).toBe(true);
  });

  it("a genuinely older close (before the latest completed session) is NOT current", () => {
    const sunday = new Date("2026-08-16T15:00:00Z");
    expect(isPriceCurrentForLatestSession("2026-08-11T00:00:00.000Z", "US", sunday)).toBe(false);
  });
});

describe("isExchangeCurrentlyClosed", () => {
  it("weekends are always closed for both exchanges", () => {
    const sunday = new Date("2026-08-16T15:00:00Z");
    expect(isExchangeCurrentlyClosed("US", sunday)).toBe(true);
    expect(isExchangeCurrentlyClosed("LSE", sunday)).toBe(true);
  });

  it("a weekday during regular trading hours is open", () => {
    const midday = new Date("2026-08-13T15:00:00Z"); // 11:00 ET / 16:00 London on a Thursday
    expect(isExchangeCurrentlyClosed("US", midday)).toBe(false);
    expect(isExchangeCurrentlyClosed("LSE", midday)).toBe(false);
  });

  it("a weekday outside trading hours (late night) is closed", () => {
    const lateNight = new Date("2026-08-13T03:00:00Z");
    expect(isExchangeCurrentlyClosed("US", lateNight)).toBe(true);
    expect(isExchangeCurrentlyClosed("LSE", lateNight)).toBe(true);
  });
});

describe("classifyProviderError — code-based classification (PokePulse's typed outcomes)", () => {
  const CASES: Array<[ProviderErrorCode, ReturnType<typeof classifyProviderError>]> = [
    ["product_not_found", "symbol_not_found"],
    ["variant_not_found", "symbol_not_found"],
    ["price_field_missing", "no_data"],
    ["response_schema_unrecognised", "invalid_response"],
    ["invalid_price", "invalid_response"],
    ["empty_response", "no_data"],
    ["rate_limited", "rate_limited"],
    ["provider_unavailable", "provider_unavailable"],
    ["authentication_failed", "provider_unavailable"],
    ["timeout", "provider_unavailable"],
    ["malformed_response", "invalid_response"],
  ];

  it.each(CASES)("code %s classifies as %s, bypassing string-matching entirely", (code, expected) => {
    // Deliberately passes error text that would classify DIFFERENTLY via
    // string-matching alone (a Twelve Data-style phrase), to prove `code`
    // — when present — always wins.
    expect(classifyProviderError("This symbol is available starting with the Grow or Venture plan.", true, code)).toBe(expected);
  });

  it("REGRESSION: isGenuineFailure/willRetryAutomatically stay consistent for every code's mapped outcome", () => {
    for (const [code, outcome] of CASES) {
      expect(isGenuineFailure(outcome)).toBe(true); // every one of these codes represents a genuine failure
      // no_data (price_field_missing, empty_response) auto-retries on the
      // NEXT scheduled refresh; a permanent mapping/schema problem doesn't.
      const shouldAutoRetryNextRefresh = outcome === "no_data" || outcome === "rate_limited" || outcome === "provider_unavailable";
      expect(willRetryAutomatically(outcome)).toBe(shouldAutoRetryNextRefresh);
      void code;
    }
  });
});

describe("POKEPULSE_UI_MESSAGES / isPokePulseCodeRetryable", () => {
  it("never claims 'no market price' unless the code genuinely represents an explicit absence of a price", () => {
    expect(POKEPULSE_UI_MESSAGES.price_field_missing).toMatch(/no current price/i);
    expect(POKEPULSE_UI_MESSAGES.empty_response).toMatch(/no current price/i);
    // Every other message must NOT claim the price is confirmed absent —
    // each describes a REQUEST or MATCHING problem instead.
    for (const code of ["product_not_found", "variant_not_found", "response_schema_unrecognised", "invalid_price", "rate_limited", "provider_unavailable", "authentication_failed", "timeout", "malformed_response"] as const) {
      expect(POKEPULSE_UI_MESSAGES[code]).not.toMatch(/no current price/i);
    }
  });

  it("is not retryable for permanent mapping/schema problems", () => {
    expect(isPokePulseCodeRetryable("product_not_found")).toBe(false);
    expect(isPokePulseCodeRetryable("variant_not_found")).toBe(false);
    expect(isPokePulseCodeRetryable("response_schema_unrecognised")).toBe(false);
    expect(isPokePulseCodeRetryable("invalid_price")).toBe(false);
  });

  it("is retryable (on a future refresh) for transient/data-availability problems", () => {
    for (const code of ["rate_limited", "provider_unavailable", "authentication_failed", "timeout", "empty_response", "malformed_response", "price_field_missing"] as const) {
      expect(isPokePulseCodeRetryable(code)).toBe(true);
    }
  });
});

describe("isImplausiblePriceMovement — defense-in-depth against a GBX/GBP-class unit mismatch", () => {
  it("REGRESSION: a proposed price ~100x the reference (V3AB's £6.65 becoming £665) is flagged implausible", () => {
    expect(isImplausiblePriceMovement(6.65, 665)).toBe(true);
  });

  it("REGRESSION: a proposed price ~0.01x the reference (the inverse mismatch) is flagged implausible", () => {
    expect(isImplausiblePriceMovement(665, 6.65)).toBe(true);
  });

  it("a normal, even if large, single-day move is NOT flagged", () => {
    expect(isImplausiblePriceMovement(129.79, 144.62)).toBe(false); // VWRP's real ~11% move since purchase
    expect(isImplausiblePriceMovement(100, 150)).toBe(false); // a genuine +50% move
    expect(isImplausiblePriceMovement(100, 60)).toBe(false); // a genuine -40% move
  });

  it("an identical price is never flagged", () => {
    expect(isImplausiblePriceMovement(129.79, 129.79)).toBe(false);
  });

  it("zero, negative, or non-finite values are always treated as implausible — never divided by", () => {
    expect(isImplausiblePriceMovement(0, 100)).toBe(true);
    expect(isImplausiblePriceMovement(100, 0)).toBe(true);
    expect(isImplausiblePriceMovement(-5, 100)).toBe(true);
    expect(isImplausiblePriceMovement(100, NaN)).toBe(true);
    expect(isImplausiblePriceMovement(100, Infinity)).toBe(true);
  });

  it("the boundary itself (exactly 10x) is flagged, with a comfortable margin below the ~100x a real unit mismatch produces", () => {
    expect(isImplausiblePriceMovement(10, 100)).toBe(true);
    expect(isImplausiblePriceMovement(10, 99)).toBe(false);
  });
});
