import { describe, expect, it, vi } from "vitest";
import Papa from "papaparse";

vi.mock("server-only", () => ({}));
import { generateFeedDraftCsv, validateFeedDraftRow, previewFeedDraftRow, type FeedDraftRowInput } from "@/lib/listing-studio/ebay-feed/csv-generator";
import { BASE_HEADERS, SAMPLE_ROW_TITLE } from "@/lib/listing-studio/ebay-feed/template-contract";

function row(overrides: Partial<FeedDraftRowInput> = {}): FeedDraftRowInput {
  return {
    sku: "1644", categoryId: "95672", title: "On Running Cloud 5 Womens UK 4",
    pricePence: 3500, quantity: 1, primaryPhotoUrl: "https://project.supabase.co/storage/v1/object/sign/listing-drafts/x?token=abcdef123456",
    conditionValue: "Used – Very Good", description: "Genuine On Running Cloud 5.",
    ...overrides,
  };
}

describe("generateFeedDraftCsv — real behavioural tests against the locked template contract", () => {
  it("REQUIREMENT 4: one selected item creates exactly one Draft row", () => {
    const { csv, rowCount } = generateFeedDraftCsv([row()]);
    expect(rowCount).toBe(1);
    const parsed = Papa.parse<string[]>(csv);
    expect(parsed.data.filter(r => r.length > 1)).toHaveLength(2); // header + 1 data row
  });

  it("REQUIREMENT 5: multiple selected items create the correct row count", () => {
    const { rowCount } = generateFeedDraftCsv([row({ sku: "1" }), row({ sku: "2" }), row({ sku: "3" })]);
    expect(rowCount).toBe(3);
  });

  it("REQUIREMENT 2/3: exact 11 base headers, in order, and the generated header row never includes the sample row", () => {
    const { csv, headers } = generateFeedDraftCsv([row()]);
    expect(headers).toEqual([...BASE_HEADERS]);
    expect(csv).not.toContain(SAMPLE_ROW_TITLE);
  });

  it("REQUIREMENT 18: Action is always exactly 'Draft'", () => {
    const { csv } = generateFeedDraftCsv([row()]);
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true });
    expect(parsed.data[0]["Action(SiteID=UK|Country=GB|Currency=GBP|Version=1193|CC=UTF-8)"]).toBe("Draft");
  });

  it("REQUIREMENT 6: CSV quoting for embedded commas is handled by the real encoder, never manual concatenation", () => {
    const { csv } = generateFeedDraftCsv([row({ title: "Trainers, Blue & White, UK 4" })]);
    const parsed = Papa.parse<string[]>(csv);
    expect(parsed.errors).toEqual([]);
    expect(parsed.data[1][3]).toBe("Trainers, Blue & White, UK 4");
  });

  it("REQUIREMENT 7: CSV quoting for embedded double quotes", () => {
    const { csv } = generateFeedDraftCsv([row({ title: 'Nike "Air Max" 90' })]);
    const parsed = Papa.parse<string[]>(csv);
    expect(parsed.errors).toEqual([]);
    expect(parsed.data[1][3]).toBe('Nike "Air Max" 90');
  });

  it("REQUIREMENT 8: CSV quoting for multiline descriptions", () => {
    const { csv } = generateFeedDraftCsv([row({ description: "Line one.\nLine two.\nLine three." })]);
    const parsed = Papa.parse<string[]>(csv);
    expect(parsed.errors).toEqual([]);
    expect(parsed.data[1][9]).toBe("Line one.\nLine two.\nLine three.");
  });

  it("REQUIREMENT 9: UTF-8 characters (emoji, accents, currency symbols) survive a round trip", () => {
    const { csv } = generateFeedDraftCsv([row({ description: "Café münchën £5 discount 🎉" })]);
    const parsed = Papa.parse<string[]>(csv);
    expect(parsed.data[1][9]).toBe("Café münchën £5 discount 🎉");
  });

  it("CORRECTIVE PASS (audit point 9): a title/description starting with =, +, -, or @ is sent to eBay EXACTLY as given — no leading quote is ever prepended, because that would corrupt real eBay data (this pipeline never opens the file in a spreadsheet — see csv-generator.ts's own corrective-pass comment)", () => {
    for (const legitimate of ["-50% off retail, tags attached", "+VAT included", "=EQ Sneakers UK 9", "@Home fitness kit"]) {
      const { csv } = generateFeedDraftCsv([row({ title: legitimate, sku: `sku-${Math.random()}` })]);
      const parsed = Papa.parse<string[]>(csv);
      expect(parsed.data[1][3]).toBe(legitimate);
    }
  });

  it("a normal title never gets a spurious leading quote", () => {
    const { csv } = generateFeedDraftCsv([row({ title: "Normal Title" })]);
    const parsed = Papa.parse<string[]>(csv);
    expect(parsed.data[1][3]).toBe("Normal Title");
  });

  it("REQUIREMENT: a description starting with a dangerous-looking character round-trips unchanged too", () => {
    const { csv } = generateFeedDraftCsv([row({ description: "-1 previous owner, excellent condition" })]);
    const parsed = Papa.parse<string[]>(csv);
    expect(parsed.data[1][9]).toBe("-1 previous owner, excellent condition");
  });

  it("REQUIREMENT: an aspect value starting with a dangerous-looking character round-trips unchanged too", () => {
    const { csv, headers } = generateFeedDraftCsv([row({ aspects: { Size: "=42" } })], ["Size"]);
    expect(headers).toContain("C:Size");
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true });
    expect(parsed.data[0]["C:Size"]).toBe("=42");
  });

  it("REQUIREMENT 13: price converts correctly from integer pence to a GBP decimal string", () => {
    const { csv } = generateFeedDraftCsv([row({ pricePence: 3500 })]);
    const parsed = Papa.parse<string[]>(csv);
    expect(parsed.data[1][5]).toBe("35.00");
  });

  it("REQUIREMENT 14: quantity is emitted as a plain positive integer string", () => {
    const { csv } = generateFeedDraftCsv([row({ quantity: 4 })]);
    const parsed = Papa.parse<string[]>(csv);
    expect(parsed.data[1][6]).toBe("4");
  });

  it("REQUIREMENT 15: category ID is emitted exactly as provided", () => {
    const { csv } = generateFeedDraftCsv([row({ categoryId: "95672" })]);
    const parsed = Papa.parse<string[]>(csv);
    expect(parsed.data[1][2]).toBe("95672");
  });

  it("REQUIREMENT 16: condition is emitted as the template-supported string enum, never the raw display label", () => {
    const { csv } = generateFeedDraftCsv([row({ conditionValue: "Used – Very Good" })]);
    const parsed = Papa.parse<string[]>(csv);
    expect(parsed.data[1][8]).toBe("USED_VERY_GOOD");
    expect(csv).not.toContain("Used – Very Good");
  });

  it("REQUIREMENT 17: an ambiguous condition fails validation before any row is built — never silently upgraded", () => {
    expect(validateFeedDraftRow(row({ conditionValue: "Used" }))).toEqual({ ok: false, reason: "Choose a specific eBay condition." });
    expect(() => generateFeedDraftCsv([row({ conditionValue: "Used" })])).toThrow(/Choose a specific eBay condition/);
  });

  it("the sample row's own title is blocked even if somehow selected as a real listing's title", () => {
    expect(validateFeedDraftRow(row({ title: SAMPLE_ROW_TITLE })).ok).toBe(false);
    expect(() => generateFeedDraftCsv([row({ title: SAMPLE_ROW_TITLE })])).toThrow(/sample row/);
  });

  it("refuses to generate an empty file", () => {
    expect(() => generateFeedDraftCsv([])).toThrow(/at least one row/i);
  });

  it("REQUIREMENT: item-specific aspects become their own C:-prefixed columns, sorted deterministically", () => {
    const { csv, headers } = generateFeedDraftCsv([row({ aspects: { Brand: "On Running", Colour: "Blue" } })], ["Brand", "Colour"]);
    expect(headers).toContain("C:Brand");
    expect(headers).toContain("C:Colour");
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true });
    expect(parsed.data[0]["C:Brand"]).toBe("On Running");
  });

  it("REQUIREMENT: line endings are CRLF, matching the real template", () => {
    const { csv } = generateFeedDraftCsv([row()]);
    expect(csv).toContain("\r\n");
  });
});

describe("validateFeedDraftRow — real per-field checks", () => {
  it("requires a valid HTTPS photo URL", () => {
    expect(validateFeedDraftRow(row({ primaryPhotoUrl: "http://insecure.example/x.jpg" })).ok).toBe(false);
    expect(validateFeedDraftRow(row({ primaryPhotoUrl: "" })).ok).toBe(false);
  });

  it("rejects a title over eBay's 80-character limit", () => {
    expect(validateFeedDraftRow(row({ title: "x".repeat(81) })).ok).toBe(false);
    expect(validateFeedDraftRow(row({ title: "x".repeat(80) })).ok).toBe(true);
  });

  it("rejects a non-numeric category id", () => {
    expect(validateFeedDraftRow(row({ categoryId: "not-a-number" })).ok).toBe(false);
  });

  it("rejects a zero or negative price/quantity", () => {
    expect(validateFeedDraftRow(row({ pricePence: 0 })).ok).toBe(false);
    expect(validateFeedDraftRow(row({ quantity: 0 })).ok).toBe(false);
  });
});

describe("previewFeedDraftRow — REQUIREMENT 11/12: safe preview, never a full signed URL", () => {
  it("masks the photo URL down to origin + a truncated path, never the full signed query string (which carries a live access token)", () => {
    const preview = previewFeedDraftRow(row({ primaryPhotoUrl: "https://project.supabase.co/storage/v1/object/sign/listing-drafts/secret-path.jpg?token=super-secret-signed-token-value" }));
    expect(preview["Item photo URL"]).not.toContain("super-secret-signed-token-value");
    expect(preview["Item photo URL"]).not.toContain("token=");
  });

  it("shows the real, useful preview fields the user needs to review before submission", () => {
    const preview = previewFeedDraftRow(row());
    expect(preview.Title).toBe("On Running Cloud 5 Womens UK 4");
    expect(preview.Price).toBe("35.00");
    expect(preview["Condition ID"]).toBe("USED_VERY_GOOD");
  });
});
