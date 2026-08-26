import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { buildImportTemplate, IMPORT_TEMPLATE_FILENAME } from "@/lib/purchase-import-sheet/template";

export async function GET() {
  try {
    await requireOwner();
    const buffer = await buildImportTemplate();
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${IMPORT_TEMPLATE_FILENAME}"`,
      },
    });
  } catch (e) { return safeApiError(e, "Could not generate the import template."); }
}
