import type { SalesPlatform } from "@/lib/types";

export const BULK_SALE_FIELDS = ["sale_date", "ebay", "vinted", "depop", "other", "item_description", "sale_price", "purchase_price", "shipping"] as const;
export type BulkSaleField = typeof BULK_SALE_FIELDS[number];
export type BulkSaleMapping = Record<BulkSaleField, number | null>;

export type ParsedBulkSaleRow = {
  sourceRow: number;
  saleDate: string;
  platform: SalesPlatform | null;
  customPlatformName: string;
  itemDescription: string;
  salePrice: number | null;
  purchasePrice: number | null;
  shipping: number | null;
  errors: string[];
};

const HEADER_ALIASES: Record<BulkSaleField, string[]> = {
  sale_date: ["date sold", "date sold or returned", "sale date", "sold date"],
  ebay: ["ebay", "e bay"], vinted: ["vinted"], depop: ["depop"], other: ["other", "other platform"],
  item_description: ["item description", "description", "item"],
  sale_price: ["price sold", "sale price", "sold price", "revenue"],
  purchase_price: ["purchase price", "price purchased", "cost"],
  shipping: ["shipping cost", "shipping", "postage"],
};

const normalize = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const affirmative = (value: string) => ["yes", "y", "true", "1", "x"].includes(normalize(value));

export function splitPastedTable(text: string): string[][] {
  return text.replace(/\r\n?/g, "\n").split("\n").filter(line => line.trim()).map(line => line.split("\t").map(cell => cell.trim()));
}
export function inferBulkSaleMapping(headers: string[]): BulkSaleMapping {
  const mapping = Object.fromEntries(BULK_SALE_FIELDS.map(field => [field, null])) as BulkSaleMapping;
  headers.forEach((header, index) => {
    const normalized = normalize(header);
    for (const field of BULK_SALE_FIELDS) if (mapping[field] === null && HEADER_ALIASES[field].includes(normalized)) mapping[field] = index;
  });
  return mapping;
}

function parseMoney(value: string): number | null {
  const cleaned = value.replace(/[£,$\s]/g, "");
  if (!cleaned) return null;
  const number = Number(cleaned);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 100) / 100 : null;
}

function parseDate(value: string): string {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const match = trimmed.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if (!match) return "";
  const [, day, month, year] = match;
  const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return parsed.getUTCFullYear() === Number(year) && parsed.getUTCMonth() + 1 === Number(month) && parsed.getUTCDate() === Number(day) ? iso : "";
}

export function parseBulkSaleRows(table: string[][], mapping: BulkSaleMapping, hasHeader: boolean): ParsedBulkSaleRow[] {
  const start = hasHeader ? 1 : 0;
  const value = (row: string[], field: BulkSaleField) => mapping[field] === null ? "" : row[mapping[field]!] ?? "";
  return table.slice(start).map((row, index) => {
    const errors: string[] = [];
    const saleDate = parseDate(value(row, "sale_date"));
    const salePrice = parseMoney(value(row, "sale_price"));
    const purchasePrice = parseMoney(value(row, "purchase_price"));
    const shipping = parseMoney(value(row, "shipping")) ?? 0;
    const flags = (["ebay", "vinted", "depop"] as const).filter(field => affirmative(value(row, field)));
    const other = value(row, "other").trim();
    if (!saleDate) errors.push("Enter a valid date sold.");
    if (salePrice === null) errors.push("Enter a valid price sold.");
    if (flags.length + (other ? 1 : 0) !== 1) errors.push("Choose exactly one selling platform.");
    const platform: SalesPlatform | null = flags.length === 1 && !other ? flags[0] : other && flags.length === 0 ? "other" : null;
    return { sourceRow: start + index + 1, saleDate, platform, customPlatformName: platform === "other" ? other : "", itemDescription: value(row, "item_description"), salePrice, purchasePrice, shipping, errors };
  });
}
