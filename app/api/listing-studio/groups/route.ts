import { NextResponse } from "next/server";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { createGroupRequestSchema } from "@/lib/validation/listing-studio-uploads";
import { MAX_GROUPS_IN_WORKSPACE } from "@/lib/listing-studio/upload-limits";
import { getNextAutomaticGroupName } from "@/lib/listing-studio/group-naming";

export const runtime = "nodejs";

/**
 * Creates a new, empty product group ready to receive photos moved in from
 * elsewhere. An explicit `title` (e.g. restoring a specific name via an
 * undo) is honoured as-is; omitting it auto-names the group via the shared
 * getNextAutomaticGroupName helper, computed from the caller's current
 * groups so the server — not the client — is the single source of truth
 * for the next placeholder number.
 */
export async function POST(request: Request) {
  try {
    const user = await requireOwner();
    const { title } = createGroupRequestSchema.parse(await request.json().catch(() => ({})));

    const existingGroups = await supabaseRequestAll<{ id: string; title: string | null }>(`listing_drafts?owner_id=eq.${user.id}&status=neq.archived&select=id,title`);
    if (existingGroups.length >= MAX_GROUPS_IN_WORKSPACE) {
      return NextResponse.json({ error: `This workspace already has ${existingGroups.length} groups. The maximum is ${MAX_GROUPS_IN_WORKSPACE}.` }, { status: 400 });
    }
    const resolvedTitle = title ?? getNextAutomaticGroupName(existingGroups);

    const created = await (await supabaseRequest("listing_drafts", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ owner_id: user.id, title: resolvedTitle, status: "grouping" }),
    })).json() as { id: string }[];

    await supabaseRequest("listing_status_history", {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ draft_id: created[0].id, owner_id: user.id, previous_status: null, new_status: "grouping", reason: "group created manually" }),
    }).catch(() => {});

    return NextResponse.json({ draftId: created[0].id, title: resolvedTitle }, { status: 201 });
  } catch (error) { return safeApiError(error, "Could not create the group."); }
}
