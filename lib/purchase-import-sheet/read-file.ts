/**
 * The actual xlsx/csv reading logic is domain-agnostic and now lives in
 * lib/spreadsheet-import/read-file.ts, shared with every import domain
 * (purchases, expenses, ...). Re-exported here unchanged so this path
 * keeps working for existing imports/tests.
 */
export * from "@/lib/spreadsheet-import/read-file";
