import type { Expense, Purchase } from "./types";

export type ExportColumn<T> = {
  heading: string;
  value: (row: T) => string | number;
};

function ukDate(value: string) {
  const [year, month, day] = value.split("-");
  return year && month && day ? `${day}/${month}/${year}` : value;
}

function arrived(value: boolean | null) {
  return value === null ? "" : value ? "Yes" : "No";
}

// These arrays define the exact spreadsheet headings and column order.
export const purchaseExportColumns: ExportColumn<Purchase>[] = [
  { heading: "Order Date", value: (row) => ukDate(row.order_date) },
  { heading: "Purchased From", value: (row) => row.purchased_from },
  { heading: "SKU", value: (row) => row.sku },
  { heading: "Arrived", value: (row) => arrived(row.arrived) },
  { heading: "Item Description", value: (row) => row.item_description },
  { heading: "Item Size", value: (row) => row.item_size },
  { heading: "Item Condition", value: (row) => row.item_condition },
  { heading: "Price Purchased", value: (row) => Number(row.price_purchased) },
];

export const expenseExportColumns: ExportColumn<Expense>[] = [
  { heading: "Order Date", value: (row) => ukDate(row.purchase_date) },
  { heading: "Purchased From", value: (row) => row.purchased_from },
  { heading: "Arrived", value: (row) => arrived(row.arrived) },
  { heading: "Item Description", value: (row) => row.item_description },
  { heading: "Cost", value: (row) => Number(row.cost) },
];

function escapeCsv(value: string | number) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function makeCsv<T>(rows: T[], columns: ExportColumn<T>[]) {
  return [
    columns.map((column) => escapeCsv(column.heading)).join(","),
    ...rows.map((row) => columns.map((column) => escapeCsv(column.value(row))).join(",")),
  ].join("\r\n");
}
