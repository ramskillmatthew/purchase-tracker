import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { buildInvestmentsImportTemplate, INVESTMENTS_IMPORT_TEMPLATE_FILENAME } from "@/lib/investments-import/template";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireOwner();
    const buffer = await buildInvestmentsImportTemplate();
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${INVESTMENTS_IMPORT_TEMPLATE_FILENAME}"`,
      },
    });
  } catch (e) { return safeApiError(e, "Could not generate the import template."); }
}
