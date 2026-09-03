import { describe, expect, it } from "vitest";
import { parseFeedResultCsv } from "@/lib/listing-studio/ebay-feed/feed-result-parser";

describe("parseFeedResultCsv — fail-closed, disclosed-uncertainty result parsing", () => {
  it("recognises a Status column with an unambiguous success word", () => {
    const csv = 'Custom label (SKU),Status\r\n1644,Success\r\n';
    const result = parseFeedResultCsv(csv);
    expect(result.rows).toEqual([{ sku: "1644", ok: true, message: null, rawStatus: "Success" }]);
    expect(result.recognisedStatusColumn).toBe(true);
  });

  it("recognises a Status column with an unambiguous failure word, and captures the message from an Errors column", () => {
    const csv = 'Custom label (SKU),Status,Errors\r\n1644,Error,Category ID is invalid\r\n';
    const result = parseFeedResultCsv(csv);
    expect(result.rows).toEqual([{ sku: "1644", ok: false, message: "Category ID is invalid", rawStatus: "Error" }]);
  });

  it("FAIL-CLOSED: an unrecognised status word is treated as a failure, never assumed to be success", () => {
    const csv = 'Custom label (SKU),Status\r\n1644,SomeUnrecognisedFutureStatus\r\n';
    const result = parseFeedResultCsv(csv);
    expect(result.rows[0].ok).toBe(false);
    expect(result.rows[0].message).toContain("SomeUnrecognisedFutureStatus");
  });

  it("a status containing BOTH a success and a failure word is treated as a failure (ambiguous, never optimistic)", () => {
    const csv = 'Custom label (SKU),Status\r\n1644,"Completed with Error"\r\n';
    const result = parseFeedResultCsv(csv);
    expect(result.rows[0].ok).toBe(false);
  });

  it("finds the SKU column even under a slightly different header name", () => {
    const csv = 'SKU,Status\r\n1644,Success\r\n';
    const result = parseFeedResultCsv(csv);
    expect(result.rows[0].sku).toBe("1644");
  });

  it("throws a clear, diagnostic error when no SKU-like column exists at all, rather than silently returning zero rows", () => {
    const csv = 'Title,Status\r\nBoots,Success\r\n';
    expect(() => parseFeedResultCsv(csv)).toThrow(/recognisable SKU column/);
  });

  it("handles multiple rows independently", () => {
    const csv = 'Custom label (SKU),Status,Errors\r\n1,Success,\r\n2,Error,Bad category\r\n3,Success,\r\n';
    const result = parseFeedResultCsv(csv);
    expect(result.rows.map(r => r.ok)).toEqual([true, false, true]);
  });

  it("no Status column at all: recognisedStatusColumn is false and every row fails closed with a generic message", () => {
    const csv = 'Custom label (SKU)\r\n1644\r\n';
    const result = parseFeedResultCsv(csv);
    expect(result.recognisedStatusColumn).toBe(false);
    expect(result.rows[0]).toEqual({ sku: "1644", ok: false, message: "eBay did not report a recognisable result for this row.", rawStatus: null });
  });

  it("skips a row with an empty SKU cell rather than crashing", () => {
    const csv = 'Custom label (SKU),Status\r\n,Success\r\n1644,Success\r\n';
    const result = parseFeedResultCsv(csv);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].sku).toBe("1644");
  });
});
