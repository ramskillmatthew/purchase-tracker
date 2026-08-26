import { NextResponse } from "next/server";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { ImportRequestError, parseImportUpload } from "@/lib/investments-import/request";
import { MAX_IMPORT_ROWS, type InvestmentImportCandidate } from "@/lib/investments-import/schema";
import { resolvePokePulseIdentity } from "@/lib/investments/providers/pokepulse";

export const runtime = "nodejs";
export const maxDuration = 60;

const ACCOUNT_TYPE_BY_CATEGORY: Record<InvestmentImportCandidate["assetCategory"], string> = {
  stock: "gia", pokemon: "pokemon_collection", lego: "lego_collection", cash: "cash",
};

type CommitFailure = { row: number; reason: string };

/**
 * Re-parses and re-validates the re-uploaded file from scratch (the
 * client's earlier preview is never trusted here, matching every other
 * import commit route's own convention). For each valid row: resolve or
 * create the account (by exact name match), resolve or create the asset
 * (by category + identity — a Pokémon row genuinely re-resolves its
 * PokePulse URL, since the asset's real identity/name/image can only come
 * from there), then insert the transaction — skipped (not an error) if its
 * import_reference was already imported, which is what makes re-running
 * the same file safe.
 *
 * "Never partially import a ROW's transaction" holds: a transaction is
 * only ever inserted once its account and asset both genuinely exist. An
 * account/asset created for an earlier-failing row simply stays around
 * (harmless — the same safe, idempotent state a manual "Add investment"
 * would leave), never rolled back, since Postgres row-level creates here
 * have no meaningful "financial" consequence on their own; only the
 * transaction insert does, and that step is guarded by the import
 * reference's own unique index.
 */
export async function POST(request: Request) {
  try {
    const user = await requireOwner();
    const { result } = await parseImportUpload(request);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

    const { rows } = result;
    if (!rows.length) return NextResponse.json({ error: "The file has no data rows to import." }, { status: 400 });
    if (rows.length > MAX_IMPORT_ROWS) return NextResponse.json({ error: `You can import up to ${MAX_IMPORT_ROWS} transactions per operation. This file has ${rows.length} rows.` }, { status: 400 });

    const preFailures = rows.filter(r => r.errors.length).flatMap(r => r.errors.map(e => ({ row: r.row, reason: `${e.field}: ${e.reason}` })));
    if (preFailures.length) return NextResponse.json({ error: "Some rows need attention before importing.", failures: preFailures }, { status: 400 });

    const existingAccounts = await supabaseRequestAll<{ id: string; name: string; account_type: string }>(
      `investment_accounts?owner_id=eq.${user.id}&archived_at=is.null&select=id,name,account_type`,
    );
    const accountsByName = new Map(existingAccounts.map(a => [a.name.trim().toLowerCase(), a]));

    const existingAssets = await supabaseRequestAll<{ id: string; category: string; external_id: string | null }>(
      `investment_assets?owner_id=eq.${user.id}&archived_at=is.null&select=id,category,external_id`,
    );
    const assetsByIdentity = new Map(existingAssets.filter(a => a.external_id).map(a => [`${a.category}:${a.external_id}`, a.id]));

    const existingRefs = new Set(
      (await supabaseRequestAll<{ import_reference: string }>(
        `investment_transactions?owner_id=eq.${user.id}&import_reference=not.is.null&select=import_reference`,
      )).map(r => r.import_reference),
    );

    let created = 0;
    let skippedDuplicate = 0;
    const failures: CommitFailure[] = [];

    for (const row of rows) {
      const candidate = row.candidate!;
      try {
        if (candidate.importReference && existingRefs.has(candidate.importReference)) { skippedDuplicate++; continue; }

        // Resolve or create the account.
        const accountKey = candidate.accountName.trim().toLowerCase();
        let account = accountsByName.get(accountKey);
        if (!account) {
          const response = await supabaseRequest("investment_accounts", {
            method: "POST", headers: { Prefer: "return=representation" },
            body: JSON.stringify({ owner_id: user.id, name: candidate.accountName.trim(), account_type: ACCOUNT_TYPE_BY_CATEGORY[candidate.assetCategory] }),
          });
          const [row2] = await response.json() as Array<{ id: string; name: string; account_type: string }>;
          account = row2;
          accountsByName.set(accountKey, account);
        }

        // Deposit/withdrawal need no asset at all.
        if (candidate.transactionType === "deposit" || candidate.transactionType === "withdrawal") {
          await insertTransaction(user.id, account.id, null, candidate, "GBP");
          if (candidate.importReference) existingRefs.add(candidate.importReference);
          created++;
          continue;
        }

        // Resolve or create the asset.
        let externalId: string; let nativeCurrency: string; let displayName: string; let imageUrl: string | null = candidate.imageUrl;
        if (candidate.assetCategory === "stock") {
          externalId = `${candidate.ticker!.toUpperCase()}:${candidate.exchange ?? ""}`;
          nativeCurrency = candidate.currency || "USD";
          displayName = candidate.assetName;
        } else if (candidate.assetCategory === "pokemon") {
          const identity = await resolvePokePulseIdentity(candidate.pokePulseUrl!);
          if (!identity.ok) { failures.push({ row: row.row, reason: `PokePulse URL: ${identity.error}` }); continue; }
          externalId = identity.data.productId;
          nativeCurrency = "GBP";
          displayName = identity.data.name;
          imageUrl = identity.data.imageUrl;
        } else if (candidate.assetCategory === "lego") {
          externalId = candidate.legoSetNumber!;
          nativeCurrency = "GBP";
          displayName = candidate.assetName;
        } else {
          externalId = `cash:${account.id}:${candidate.currency}`;
          nativeCurrency = candidate.currency;
          displayName = `${candidate.currency} cash`;
        }

        const identityKey = `${candidate.assetCategory}:${externalId}`;
        let assetId = assetsByIdentity.get(identityKey);
        if (!assetId) {
          const insertBody: Record<string, unknown> = {
            owner_id: user.id, category: candidate.assetCategory, display_name: displayName, native_currency: nativeCurrency,
            pricing_provider: candidate.assetCategory === "stock" ? "twelve_data" : candidate.assetCategory === "pokemon" ? "pokepulse" : candidate.assetCategory === "lego" ? "manual" : "none",
            external_id: externalId, image_url: imageUrl,
          };
          if (candidate.assetCategory === "stock") { insertBody.ticker = candidate.ticker!.toUpperCase(); insertBody.exchange = candidate.exchange; }
          if (candidate.assetCategory === "pokemon") insertBody.source_url = candidate.pokePulseUrl;
          if (candidate.assetCategory === "lego") insertBody.lego_set_number = candidate.legoSetNumber;

          const response = await supabaseRequest("investment_assets", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(insertBody) });
          const [assetRow] = await response.json() as Array<{ id: string }>;
          assetId = assetRow.id;
          assetsByIdentity.set(identityKey, assetId);
        }

        await insertTransaction(user.id, account.id, assetId, candidate, nativeCurrency);
        if (candidate.importReference) existingRefs.add(candidate.importReference);
        created++;
      } catch (error) {
        failures.push({ row: row.row, reason: error instanceof Error ? error.message : "Could not import this row." });
      }
    }

    return NextResponse.json({ ok: failures.length === 0, created, skippedDuplicate, failed: failures.length, failures }, { status: failures.length && !created ? 400 : 200 });
  } catch (e) {
    if (e instanceof ImportRequestError) return NextResponse.json({ error: e.message }, { status: e.status });
    return safeApiError(e, "Could not import transactions.");
  }
}

async function insertTransaction(ownerId: string, accountId: string, assetId: string | null, candidate: InvestmentImportCandidate, nativeCurrency: string) {
  const gbpTotal = candidate.actualTotalGbp ?? (
    candidate.transactionType === "fee" ? 0
      : nativeCurrency === "GBP" ? (candidate.nativeUnitPrice ?? 0) * (candidate.quantity ?? 0)
        : (candidate.nativeUnitPrice ?? 0) * (candidate.quantity ?? 0) * (candidate.fxRateAtTrade ?? 0)
  );
  await supabaseRequest("investment_transactions", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      owner_id: ownerId, account_id: accountId, asset_id: assetId, transaction_type: candidate.transactionType,
      trade_at: candidate.tradeAt, quantity: candidate.quantity, native_unit_price: candidate.nativeUnitPrice,
      native_currency: nativeCurrency, gbp_total: gbpTotal, fx_rate_at_trade: nativeCurrency === "GBP" ? null : candidate.fxRateAtTrade,
      gbp_fees: candidate.feesGbp, notes: candidate.notes, import_reference: candidate.importReference,
    }),
  });
}
