import { NextResponse } from "next/server";
import { z } from "zod";
import { safeApiError } from "@/lib/auth/api";
import { requireOwner, serverAuthClient } from "@/lib/auth/server";
import { parseVintedAccountInputs, savedVintedAccounts, VINTED_ACCOUNTS_METADATA_KEY } from "@/lib/listing-dashboard/vinted-accounts";

export const runtime = "nodejs";

const inputSchema = z.object({
  accounts: z.array(z.object({
    slot: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    number: z.number().int().min(1).max(9999),
    profileUrl: z.string().max(500),
  })).length(3).refine(accounts => new Set(accounts.map(account => account.slot)).size === 3, "Each Vinted colour slot must appear once."),
});

export async function GET() {
  try {
    const user = await requireOwner();
    return NextResponse.json({ accounts: savedVintedAccounts(user.user_metadata) });
  } catch (error) { return safeApiError(error, "Could not load the saved Vinted accounts."); }
}

export async function PUT(request: Request) {
  try {
    const user = await requireOwner();
    const input = inputSchema.parse(await request.json());
    const accounts = parseVintedAccountInputs(input.accounts);
    const client = await serverAuthClient();
    const { error } = await client.auth.updateUser({
      data: { ...user.user_metadata, [VINTED_ACCOUNTS_METADATA_KEY]: accounts },
    });
    if (error) throw error;
    return NextResponse.json({ accounts });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Each saved Vinted account needs a unique number between 1 and 9999." }, { status: 400 });
    }
    if (error instanceof Error && /Vinted|profile|account slot/i.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return safeApiError(error, "Could not save the Vinted accounts.");
  }
}
