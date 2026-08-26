import { NextResponse } from "next/server";
import { supabaseRequest } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { ImportRequestError, parseImportUpload } from "@/lib/expense-import-sheet/request";
import { MAX_IMPORT_ROWS } from "@/lib/expense-import-sheet/schema";

/**
 * Re-parses and re-validates the re-uploaded file from scratch — the
 * client's earlier preview response is never trusted here, since the
 * client-side preview is not a security boundary. Every row must satisfy
 * the exact same expenseInputSchema used by normal expense creation (see
 * lib/expense-import-sheet/schema.ts, which imports it directly rather
 * than re-implementing a weaker copy). All-or-nothing: if any row is
 * invalid the whole batch is rejected, so a partially-broken spreadsheet
 * can never create an incomplete set of expenses.
 */
export async function POST(request: Request) {
  try {
    await requireOwner();
    const { result } = await parseImportUpload(request);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

    const { rows } = result;
    if (!rows.length) return NextResponse.json({ error: "The file has no data rows to import." }, { status: 400 });
    if (rows.length > MAX_IMPORT_ROWS) return NextResponse.json({ error: `You can import up to ${MAX_IMPORT_ROWS} expenses per operation. This file has ${rows.length} rows.` }, { status: 400 });

    const failures = rows.flatMap(row => row.errors.map(error => ({ row: row.row, field: error.field, reason: error.reason })));
    if (failures.length) return NextResponse.json({ error: "Some expenses need attention.", failures }, { status: 400 });

    const expenses = rows.map(row => row.expense);
    await supabaseRequest("expenses", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(expenses) });
    return NextResponse.json({ ok: true, created: expenses.length }, { status: 201 });
  } catch (e) {
    if (e instanceof ImportRequestError) return NextResponse.json({ error: e.message }, { status: e.status });
    return safeApiError(e, "Could not import expenses.");
  }
}
