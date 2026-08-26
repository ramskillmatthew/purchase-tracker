import { detectFileKind, MAX_IMPORT_FILE_BYTES, readSheetFile, SheetReadError, SUPPORTED_EXTENSIONS } from "./read-file";
import type { CellValue } from "./cell-parsers";

/**
 * Shared by every import domain's own request.ts (preview and commit
 * routes alike) so a file is only ever read, size/type-checked, and handed
 * off to a domain's row-builder one way — never re-implemented per route
 * or per domain. Nothing here writes the upload to disk or any database;
 * the buffer only exists for the lifetime of this function call.
 */
export class ImportRequestError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

export async function parseImportUpload<Result>(
  request: Request,
  buildRows: (aoa: CellValue[][]) => Result,
): Promise<{ fileName: string; result: Result }> {
  let formData: FormData;
  try { formData = await request.formData(); }
  catch { throw new ImportRequestError("Could not read the uploaded file."); }

  const file = formData.get("file");
  if (!(file instanceof File)) throw new ImportRequestError("No file was uploaded.");
  if (file.size === 0) throw new ImportRequestError("The uploaded file is empty.");
  if (file.size > MAX_IMPORT_FILE_BYTES) throw new ImportRequestError(`The file is too large. Maximum size is ${Math.round(MAX_IMPORT_FILE_BYTES / (1024 * 1024))}MB.`, 413);

  const kind = detectFileKind(file.name);
  if (!kind) throw new ImportRequestError(`Unsupported file type. Please upload one of: ${SUPPORTED_EXTENSIONS.join(", ")}.`);

  const buffer = Buffer.from(await file.arrayBuffer());
  let aoa;
  try { aoa = await readSheetFile(buffer, kind); }
  catch (e) { throw new ImportRequestError(e instanceof SheetReadError ? e.message : "Could not read the uploaded file."); }
  if (!aoa.length) throw new ImportRequestError("The file appears to be empty.");

  return { fileName: file.name, result: buildRows(aoa) };
}
