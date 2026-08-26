import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { ImportRequestError, parseImportUpload } from "@/lib/investments-import/request";
import { IMPORT_PREVIEW_ROW_LIMIT, MAX_IMPORT_ROWS } from "@/lib/investments-import/schema";
import type { SpreadsheetImportFailure } from "@/lib/spreadsheet-import/types";

export const runtime = "nodejs";

/** Parses and validates only — never inserts anything. Mirrors app/api/purchases/import/preview/route.ts's own shape exactly. */
export async function POST(request: Request) {
  try {
    await requireOwner();
    const { fileName, result } = await parseImportUpload(request);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

    const { rows, ignoredColumns } = result;
    const invalidRows = rows.filter(row => row.errors.length);
    const validCount = rows.length - invalidRows.length;
    const failures: SpreadsheetImportFailure[] = invalidRows.flatMap(row =>
      row.errors.map(error => ({ row: row.row, field: error.field, reason: error.reason, value: row.values[error.field] || undefined })),
    );
    return NextResponse.json({
      fileName, totalDataRows: rows.length, validCount, invalidCount: invalidRows.length, ignoredColumns,
      rows: rows.slice(0, IMPORT_PREVIEW_ROW_LIMIT).map(row => ({ row: row.row, values: row.values, errors: row.errors })),
      invalidRows: invalidRows.map(row => ({ row: row.row, values: row.values, errors: row.errors })),
      failures, truncated: rows.length > IMPORT_PREVIEW_ROW_LIMIT, previewRowLimit: IMPORT_PREVIEW_ROW_LIMIT, maxImportRows: MAX_IMPORT_ROWS,
    });
  } catch (e) {
    if (e instanceof ImportRequestError) return NextResponse.json({ error: e.message }, { status: e.status });
    return safeApiError(e, "Could not read the uploaded file.");
  }
}
