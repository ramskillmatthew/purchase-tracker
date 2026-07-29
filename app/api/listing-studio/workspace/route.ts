import { NextResponse } from "next/server";
import { supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";

export const runtime = "nodejs";

type DraftRow = { id: string; title: string | null; status: string; created_at: string; updated_at: string };
type ImageRow = {
  id: string; draft_id: string; original_filename: string; mime_type: string; file_size: number;
  width: number | null; height: number | null; sort_order: number;
  detected_role: string | null; confirmed_role: string | null; upload_state: string; preview_available: boolean;
};

/**
 * Fetches everything the Create view needs to render: every non-archived
 * group and every image in them, ordered for direct rendering (groups by
 * creation order, images by their persisted sort_order — never inferred
 * from anything else). Deliberately never selects the underlying Storage
 * key column — the client only ever needs /api/listing-studio/images/{id}
 * /view for display.
 */
export async function GET() {
  try {
    const user = await requireOwner();
    const [drafts, images] = await Promise.all([
      supabaseRequestAll<DraftRow>(`listing_drafts?owner_id=eq.${user.id}&status=neq.archived&select=id,title,status,created_at,updated_at&order=created_at.asc`),
      supabaseRequestAll<ImageRow>(
        `listing_draft_images?owner_id=eq.${user.id}&select=id,draft_id,original_filename,mime_type,file_size,width,height,sort_order,detected_role,confirmed_role,upload_state,preview_available&order=sort_order.asc`,
      ),
    ]);
    return NextResponse.json({ drafts, images });
  } catch (error) { return safeApiError(error); }
}
