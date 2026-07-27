import { parseImportUpload as parseGenericUpload, ImportRequestError } from "@/lib/spreadsheet-import/request";
import { buildImportRows, type BuildImportRowsResult } from "./schema";

/**
 * Mirrors lib/purchase-import-sheet/request.ts exactly: the generic
 * upload-parsing (multipart extraction, size/type checks, file reading)
 * lives in lib/spreadsheet-import/request.ts; this just supplies the
 * expense-specific row builder.
 */
export { ImportRequestError };

export async function parseImportUpload(request: Request): Promise<{ fileName: string; result: BuildImportRowsResult }> {
  return parseGenericUpload(request, buildImportRows);
}
