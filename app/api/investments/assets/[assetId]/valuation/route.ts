import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { buildManualLegoQuote } from "@/lib/investments/providers/lego-manual";

export const runtime = "nodejs";

const manualValuationSchema = z.object({
  gbpPrice: z.number().positive(),
  sourceUrl: z.string().trim().url().max(500).nullable().optional(),
}).strict();

/**
 * Manual valuation entry — currently the ONLY pricing path for LEGO. Every
 * call INSERTS a new investment_price_snapshots row (provider: 'manual',
 * data_quality: 'manual') rather than overwriting anything, so historical
 * charts keep working, matching "every manual update creates a price
 * snapshot". The automated refresh route never calls this — see
 * app/api/investments/refresh/route.ts's own comment — so a manual
 * valuation can never be silently overwritten by automation.
 */
export async function POST(request: Request, { params }: { params: Promise<{ assetId: string }> }) {
  try {
    const user = await requireOwner();
    const { assetId } = await params;
    if (!uuidSchema.safeParse(assetId).success) return NextResponse.json({ error: "Invalid asset id." }, { status: 400 });
    const body = manualValuationSchema.parse(await request.json());

    const assets = await supabaseRequestAll<{ id: string; category: string }>(
      `investment_assets?id=eq.${assetId}&owner_id=eq.${user.id}&select=id,category`,
    );
    const asset = assets[0];
    if (!asset) return NextResponse.json({ error: "Investment not found." }, { status: 404 });
    if (asset.category !== "lego") return NextResponse.json({ error: "Manual valuation is only supported for LEGO investments." }, { status: 400 });

    const quote = buildManualLegoQuote(body.gbpPrice, new Date().toISOString(), body.sourceUrl ?? null);

    await supabaseRequest("investment_price_snapshots", {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        owner_id: user.id, asset_id: assetId, native_unit_price: quote.nativeUnitPrice, gbp_unit_price: quote.nativeUnitPrice,
        fx_rate: 1, price_at: quote.priceAt, provider: "manual", source_url: quote.sourceUrl, data_quality: "manual",
      }),
    });

    return NextResponse.json({ assetId, gbpPrice: quote.nativeUnitPrice, priceAt: quote.priceAt });
  } catch (error) { return safeApiError(error, "Could not record this valuation."); }
}
