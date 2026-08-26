import { extractBearerToken, verifyConnectionToken } from "@/lib/listing-studio/extension-batch-tokens";
import { extensionCorsJson, extensionCorsPreflight, extensionSafeApiError } from "@/lib/listing-studio/extension-cors";
import { supabaseRequestAll } from "@/lib/supabase";

export const runtime = "nodejs";

type ImportBatch = { id: string; status: string; total_count: number; created_at: string; updated_at: string };
type ImportItem = { id: string; batch_id: string; source_url: string; ebay_item_id: string; status: string; title: string | null; photo_count: number; draft_id: string | null; safe_error: string | null; attempt_count: number; created_at: string; updated_at: string };

export async function OPTIONS(request: Request) { return extensionCorsPreflight(request); }

async function ownerFromPairing(request: Request): Promise<string> {
  const token = extractBearerToken(request.headers.get("authorization"));
  if (!token) throw new Error("Missing extension connection token.");
  return (await verifyConnectionToken(token)).ownerId;
}

export async function GET(request: Request) {
  try {
    const ownerId = await ownerFromPairing(request);
    // Newest first is essential: completed history is retained permanently,
    // so taking the oldest ten would eventually hide a newly-created waiting
    // batch from the extension entirely.
    const batches = await supabaseRequestAll<ImportBatch>(`ebay_import_batches?owner_id=eq.${ownerId}&status=in.(waiting,processing,completed)&select=id,status,total_count,created_at,updated_at&order=created_at.desc`);
    const visible = batches.slice(0, 10);
    const items = visible.length
      ? await supabaseRequestAll<ImportItem>(`ebay_import_items?owner_id=eq.${ownerId}&batch_id=in.(${visible.map(row => row.id).join(",")})&status=in.(waiting,failed,extracting)&select=id,batch_id,source_url,ebay_item_id,status,title,photo_count,draft_id,safe_error,attempt_count,created_at,updated_at&order=created_at.asc`)
      : [];
    return extensionCorsJson(request, { batches: visible.map(batch => ({ ...batch, items: items.filter(item => item.batch_id === batch.id) })) });
  } catch (error) {
    return extensionSafeApiError(request, error, "Could not load eBay imports for this extension.");
  }
}
