import { parseImportUpload as parseGenericUpload, ImportRequestError } from "@/lib/spreadsheet-import/request";
import { buildImportRows, type BuildImportRowsResult } from "./schema";

export { ImportRequestError };

export async function parseImportUpload(request: Request): Promise<{ fileName: string; result: BuildImportRowsResult }> {
  return parseGenericUpload(request, buildImportRows);
}
