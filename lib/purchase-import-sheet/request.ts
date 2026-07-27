import { parseImportUpload as parseGenericUpload, ImportRequestError } from "@/lib/spreadsheet-import/request";
import { buildImportRows, type BuildImportRowsResult } from "./schema";

/**
 * The generic upload-parsing (multipart extraction, size/type checks, file
 * reading) now lives in lib/spreadsheet-import/request.ts, shared with
 * every import domain. This file just supplies the purchase-specific row
 * builder, preserving the exact original call signature so the existing
 * preview/commit routes need no changes.
 */
export { ImportRequestError };

export async function parseImportUpload(request: Request): Promise<{ fileName: string; result: BuildImportRowsResult }> {
  return parseGenericUpload(request, buildImportRows);
}
