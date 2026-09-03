import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import Papa from "papaparse";
import {
  BASE_HEADERS, METADATA_ROWS, SAMPLE_ROW, SAMPLE_ROW_TITLE, ACTION_HEADER,
  TEMPLATE_VERSION, TEMPLATE_IDENTIFIER, BASE_COLUMN_COUNT, ONLY_ALLOWED_ACTION,
  assertTemplateContractCurrent,
} from "@/lib/listing-studio/ebay-feed/template-contract";

const FIXTURE_PATH = "lib/listing-studio/ebay-feed/template-fixtures/eBay-GB-create-new-drafts-template-v0.0.2.csv";

/**
 * Genuine behavioural compatibility tests — parses the REAL, untouched
 * template the account owner downloaded from Seller Hub (never a
 * hand-typed re-creation) and proves template-contract.ts describes it
 * exactly. If eBay ever changes the real template, re-downloading it and
 * running this test is what catches the drift.
 */
describe("eBay Create-new-drafts template — real fixture vs. locked contract", () => {
  const raw = readFileSync(FIXTURE_PATH, "utf8");
  const parsed = Papa.parse<string[]>(raw);

  it("REQUIREMENT: file encoding is UTF-8, no BOM, CRLF line endings — read directly from the untouched file", () => {
    const buffer = readFileSync(FIXTURE_PATH);
    expect(buffer[0]).not.toBe(0xEF); // no UTF-8 BOM
    expect(raw).toContain("\r\n");
  });

  it("parses with zero errors via a real CSV parser (Papa.parse), never naive comma-splitting", () => {
    expect(parsed.errors).toEqual([]);
  });

  it("REQUIREMENT: exactly 4 #INFO metadata rows, matching the contract's METADATA_ROWS exactly", () => {
    for (let i = 0; i < METADATA_ROWS.length; i++) {
      expect(parsed.data[i], `row ${i}`).toEqual(METADATA_ROWS[i]);
    }
  });

  it("row 3 (index 2) is the one quoted in the raw source — because its own text contains a literal comma; row 2 (index 1) has no comma and is correctly unquoted", () => {
    const lines = raw.split("\r\n");
    expect(lines[2].startsWith('"#INFO After')).toBe(true);
    expect(lines[1].startsWith('"')).toBe(false);
  });

  it("REQUIREMENT: the header row (index 4) matches BASE_HEADERS exactly, same order, same spelling", () => {
    expect(parsed.data[4]).toEqual([...BASE_HEADERS]);
  });

  it("REQUIREMENT: exactly 11 base headers, and every real row (metadata, header, sample) has exactly that many fields", () => {
    expect(BASE_HEADERS.length).toBe(11);
    expect(BASE_COLUMN_COUNT).toBe(11);
    for (let i = 0; i <= 5; i++) expect(parsed.data[i].length, `row ${i}`).toBe(11);
  });

  it("the Action header encodes SiteID=UK|Country=GB|Currency=GBP|Version=1193|CC=UTF-8 exactly", () => {
    expect(ACTION_HEADER).toBe("Action(SiteID=UK|Country=GB|Currency=GBP|Version=1193|CC=UTF-8)");
    expect(parsed.data[4][0]).toBe(ACTION_HEADER);
  });

  it("REQUIREMENT: the sample row (index 5) matches SAMPLE_ROW exactly — Action=Draft, Condition ID='NEW' (a string, not a numeric ID), Format=FixedPrice", () => {
    expect(parsed.data[5]).toEqual([...SAMPLE_ROW]);
    expect(parsed.data[5][0]).toBe("Draft");
    expect(parsed.data[5][8]).toBe("NEW");
    expect(parsed.data[5][10]).toBe("FixedPrice");
  });

  it("REQUIREMENT: the sample row's description contains HTML, and empty UPC/SKU cells are genuinely empty strings, never a placeholder token", () => {
    expect(parsed.data[5][9]).toContain("<p>");
    expect(parsed.data[5][1]).toBe(""); // Custom label (SKU)
    expect(parsed.data[5][4]).toBe(""); // UPC
  });

  it("REQUIREMENT: price in the sample is a plain decimal string ('11'), never integer pence", () => {
    expect(parsed.data[5][5]).toBe("11");
    expect(Number(parsed.data[5][5])).toBe(11);
  });

  it("Version and Template identifier match the locked contract", () => {
    expect(TEMPLATE_VERSION).toBe("0.0.2");
    expect(TEMPLATE_IDENTIFIER).toBe("eBay-draft-listings-template_GB");
    expect(parsed.data[0]).toContain(`Version=${TEMPLATE_VERSION}`);
    expect(parsed.data[0]).toContain(`Template= ${TEMPLATE_IDENTIFIER}`);
  });

  it("REQUIREMENT: the only allowed Action value is 'Draft' — matches the sample row and the contract's own constant", () => {
    expect(ONLY_ALLOWED_ACTION).toBe("Draft");
    expect(SAMPLE_ROW[0]).toBe(ONLY_ALLOWED_ACTION);
  });

  it("SAMPLE_ROW_TITLE exactly matches the real sample row's Title field — the guard used to keep it out of real uploads", () => {
    expect(SAMPLE_ROW_TITLE).toBe("Test Draft Shoe");
    expect(parsed.data[5][3]).toBe(SAMPLE_ROW_TITLE);
  });

  it("assertTemplateContractCurrent() does not throw while the contract matches this fixture", () => {
    expect(() => assertTemplateContractCurrent()).not.toThrow();
  });
});
