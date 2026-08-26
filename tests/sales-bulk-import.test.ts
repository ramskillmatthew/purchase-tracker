import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { inferBulkSaleMapping, parseBulkSaleRows, splitPastedTable } from "@/lib/sales/bulk-import";

describe("bulk sales spreadsheet parsing", () => {
  const headers = ["Date Sold or returned", "eBay", "Vinted", "Depop", "Other", "Item Description", "Price Sold", "Purchase Price", "Shipping Cost"];

  it("infers the spreadsheet columns and resolves a Yes platform", () => {
    const table = splitPastedTable(`${headers.join("\t")}\n20/08/2026\t\tYes\t\t\tNike Air Max 95\t35.00\t18.50\t2.99`);
    const rows = parseBulkSaleRows(table, inferBulkSaleMapping(table[0]), true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ saleDate: "2026-08-20", platform: "vinted", customPlatformName: "", itemDescription: "Nike Air Max 95", salePrice: 35, purchasePrice: 18.5, shipping: 2.99, errors: [] });
  });

  it("uses free text in Other as the custom platform", () => {
    const table = [headers, ["21/08/2026", "", "", "", "Facebook Marketplace", "Pool", "69.99", "40", "0"]];
    const [row] = parseBulkSaleRows(table, inferBulkSaleMapping(headers), true);
    expect(row.platform).toBe("other");
    expect(row.customPlatformName).toBe("Facebook Marketplace");
    expect(row.errors).toEqual([]);
  });

  it("blocks ambiguous platforms, invalid dates, and invalid prices", () => {
    const table = [headers, ["31/02/2026", "Yes", "Yes", "", "", "Broken row", "not money", "", ""]];
    const [row] = parseBulkSaleRows(table, inferBulkSaleMapping(headers), true);
    expect(row.platform).toBeNull();
    expect(row.errors).toEqual(["Enter a valid date sold.", "Enter a valid price sold.", "Choose exactly one selling platform."]);
  });
});

describe("bulk sales inventory search", () => {
  it("requests enough identical in-stock units for a genuine bulk batch", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "app/sales/bulk/page.tsx"), "utf8");
    expect(source).toContain("/api/sales/available-purchases?q=${encodeURIComponent(query)}&limit=100");
    expect(source).not.toContain("&limit=12");
  });
});
