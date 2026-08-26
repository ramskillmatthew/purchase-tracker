#!/usr/bin/env node
// Read-only EODHD verification for VWRP/V3AB/VUAG — see this feature's own
// completion report for the full design rationale.
//
// GUARANTEES (read the code below to verify these, don't just trust this
// comment):
//   - ZERO database writes of any kind (only GET requests to Supabase).
//   - Never updates investment_assets.pricing_provider.
//   - Never creates a row in investment_price_snapshots.
//   - Never changes any portfolio total.
//   - Requires EODHD_API_KEY server-side; never prints or logs it (or the
//     Supabase secret key) anywhere, including in error messages.
//   - Fails closed (non-zero exit, "FAIL" status) on: instrument not found,
//     unrecognised/missing quote unit, empty/malformed EODHD response,
//     implausible observation date, non-positive price, or a normalized
//     price differing from the independent reference by more than a
//     conservative threshold (never just a warning for a genuine ~10x+
//     scale mismatch — that's always a hard fail).
//
// Usage: node scripts/eodhd-dry-run.mjs
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadEnvFile(relativePath) {
  const fullPath = path.join(ROOT, relativePath);
  if (!existsSync(fullPath)) return {};
  const env = {};
  for (const line of readFileSync(fullPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

const fileEnv = loadEnvFile(".env.local");
function envVar(name) { return process.env[name] ?? fileEnv[name]; }

const EODHD_API_KEY = envVar("EODHD_API_KEY");
const SUPABASE_URL = envVar("NEXT_PUBLIC_SUPABASE_URL");
const SUPABASE_SECRET_KEY = envVar("SUPABASE_SECRET_KEY");

if (!EODHD_API_KEY) {
  console.error("EODHD_API_KEY is not set — this dry run cannot proceed.");
  console.error("See this feature's completion report for exactly how to obtain and configure a free key.");
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY are not set — cannot read current asset state (read-only).");
  process.exit(1);
}

// Mirrors lib/investments/providers/eodhd.ts's SUB_UNIT_MULTIPLIER exactly.
// This standalone script cannot import that module directly — it uses
// Next.js's own "server-only" marker, which only resolves inside Next's
// build pipeline, not a plain Node script — so this tiny, already
// unit-tested (tests/investments-eodhd-provider.test.ts) arithmetic is
// intentionally duplicated here. Any change to the real multiplier table
// must be mirrored here too.
const SUB_UNIT_MULTIPLIER = { GBP: 1, GBX: 0.01, USD: 1, EUR: 1 };

// A genuine unit mismatch (the ~100x GBX/GBP class of bug this whole
// feature exists to prevent) produces a ratio far beyond this — matches
// lib/investments/refresh-classification.ts's own isImplausiblePriceMovement threshold.
const IMPLAUSIBLE_RATIO = 10;
// A difference this large from the independently verified reference is
// flagged but not fatal on its own (real market movement between when the
// reference was captured and when this script runs) — for visibility only.
const MATERIAL_WARN_PERCENT = 15;
// Beyond THIS, "real market movement" stops being a credible explanation —
// fails closed rather than silently trusting an unexplained large gap.
const MATERIAL_FAIL_PERCENT = 50;

// Independently verified instrument identity + reference prices — see this
// feature's own completion report for the full citation list (ISIN/SEDOL
// cross-checked via justetf.com and hl.co.uk; Vanguard's own fund-docs PDFs
// independently confirm ISIN and Accumulating share class). Reference
// prices from hl.co.uk (VWRP, V3AB) and stockanalysis.com (VUAG), fetched
// 2026-08-17. `expectedUnit` is used ONLY as a fallback when the asset's
// own provider_quote_unit isn't set in the database yet (Phase A not
// applied) — CONFIRMED as 'GBP' via a real run of this exact script
// against live EODHD responses on 2026-08-17: the initial 'GBX' working
// hypothesis was wrong (raw values matched the reference within 0.3% when
// read as GBP directly, not ~0.3% of the reference when divided by 100).
const INSTRUMENTS = [
  { ticker: "VWRP", eodhdSymbol: "VWRP.LSE", isin: "IE00BK5BQT80", name: "Vanguard FTSE All-World UCITS ETF (USD) Accumulating", expectedUnit: "GBP", referencePrice: 144.62, referenceSource: "hl.co.uk" },
  { ticker: "V3AB", eodhdSymbol: "V3AB.LSE", isin: "IE00BNG8L278", name: "Vanguard ESG Global All Cap UCITS ETF (USD) Accumulating", expectedUnit: "GBP", referencePrice: 6.65, referenceSource: "hl.co.uk" },
  { ticker: "VUAG", eodhdSymbol: "VUAG.LSE", isin: "IE00BFMXXD54", name: "Vanguard S&P 500 UCITS ETF (USD) Accumulating", expectedUnit: "GBP", referencePrice: 111.08, referenceSource: "stockanalysis.com" },
];

async function supabaseGet(pathAndQuery) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, { headers: { apikey: SUPABASE_SECRET_KEY, Authorization: `Bearer ${SUPABASE_SECRET_KEY}` } });
  return res.json();
}

async function fetchAsset(ticker) {
  const rows = await supabaseGet(`investment_assets?ticker=eq.${ticker}&exchange=eq.LSE&select=id,display_name,ticker,exchange,pricing_provider,provider_quote_unit,native_currency`);
  return Array.isArray(rows) ? rows[0] ?? null : null;
}

/** Purchase-price fallback + net held quantity — read-only, for the reconciliation table only. */
async function fetchPositionSummary(assetId) {
  const rows = await supabaseGet(`investment_transactions?asset_id=eq.${assetId}&transaction_type=in.(buy,sell)&reversed_at=is.null&select=transaction_type,native_unit_price,quantity,trade_at&order=trade_at.asc`);
  if (!Array.isArray(rows) || rows.length === 0) return { fallbackPrice: null, quantity: 0 };
  const firstBuy = rows.find(r => r.transaction_type === "buy");
  let quantity = 0;
  for (const r of rows) {
    const q = Number(r.quantity ?? 0);
    quantity += r.transaction_type === "buy" ? q : -q;
  }
  return { fallbackPrice: firstBuy ? Number(firstBuy.native_unit_price) : null, quantity };
}

async function fetchEod(symbol) {
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const url = `https://eodhd.com/api/eod/${symbol}?api_token=${EODHD_API_KEY}&fmt=json&period=d&order=a&from=${from}&to=${to}`;
  let res;
  try {
    res = await fetch(url);
  } catch (error) {
    return { status: 0, body: null, error: error instanceof Error ? error.message : "network error" };
  }
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* leave null — reported as malformed below */ }
  return { status: res.status, body };
}

function normalize(rawPrice, unit) {
  const multiplier = SUB_UNIT_MULTIPLIER[unit];
  if (multiplier === undefined) return null;
  return rawPrice * multiplier;
}

async function main() {
  console.log("EODHD read-only dry run — VWRP / V3AB / VUAG");
  console.log("ZERO database writes. Does not change pricing_provider. Does not create snapshots.\n");

  const rows = [];
  let anyFail = false;

  for (const inst of INSTRUMENTS) {
    console.log(`--- ${inst.ticker} — ${inst.name} ---`);
    const asset = await fetchAsset(inst.ticker);
    if (!asset) {
      console.log(`  STATUS: FAIL — no matching asset found in the database for ticker ${inst.ticker} on LSE.\n`);
      anyFail = true;
      rows.push({ ticker: inst.ticker, pass: false, reason: "asset not found" });
      continue;
    }

    const { fallbackPrice, quantity } = await fetchPositionSummary(asset.id);
    const { status, body } = await fetchEod(inst.eodhdSymbol);

    if (status !== 200 || !Array.isArray(body) || body.length === 0) {
      console.log(`  Internal asset ID:        ${asset.id}`);
      console.log(`  Currently routed via:     ${asset.pricing_provider} (unchanged by this dry run)`);
      console.log(`  EODHD symbol requested:   ${inst.eodhdSymbol}`);
      console.log(`  HTTP status:              ${status}`);
      console.log(`  STATUS: FAIL — EODHD did not return usable data.\n`);
      anyFail = true;
      rows.push({ ticker: inst.ticker, assetId: asset.id, pass: false, reason: `HTTP ${status} or empty/malformed response` });
      continue;
    }

    const latest = body[body.length - 1];
    const rawClose = Number(latest.close);
    if (!Number.isFinite(rawClose) || rawClose <= 0) {
      console.log(`  STATUS: FAIL — latest close is not a usable positive number (raw value: ${JSON.stringify(latest.close)}).\n`);
      anyFail = true;
      rows.push({ ticker: inst.ticker, assetId: asset.id, pass: false, reason: "non-positive/non-finite close" });
      continue;
    }

    const obsDate = new Date(`${latest.date}T00:00:00Z`);
    const daysOld = (Date.now() - obsDate.getTime()) / 86400000;
    if (Number.isNaN(obsDate.getTime()) || daysOld < -1 || daysOld > 10) {
      console.log(`  STATUS: FAIL — observation date ${latest.date} is not plausible (${daysOld.toFixed(1)} days from now).\n`);
      anyFail = true;
      rows.push({ ticker: inst.ticker, assetId: asset.id, pass: false, reason: `implausible observation date ${latest.date}` });
      continue;
    }

    // Prefer the asset's own stored provider_quote_unit (post-Phase-A) —
    // falls back to this instrument's documented working hypothesis ONLY
    // if Phase A hasn't been applied to the database yet, so this dry run
    // is still runnable before/after Phase A.
    const unit = asset.provider_quote_unit ?? inst.expectedUnit;
    const normalized = normalize(rawClose, unit);
    if (normalized === null) {
      console.log(`  STATUS: FAIL — unrecognised quote unit '${unit}'.\n`);
      anyFail = true;
      rows.push({ ticker: inst.ticker, assetId: asset.id, pass: false, reason: `unrecognised unit ${unit}` });
      continue;
    }

    const diffFromReferencePercent = ((normalized - inst.referencePrice) / inst.referencePrice) * 100;
    const ratioFromReference = normalized / inst.referencePrice;
    const implausible = ratioFromReference >= IMPLAUSIBLE_RATIO || ratioFromReference <= 1 / IMPLAUSIBLE_RATIO;
    const materialFail = Math.abs(diffFromReferencePercent) > MATERIAL_FAIL_PERCENT;
    const materialWarn = !materialFail && Math.abs(diffFromReferencePercent) > MATERIAL_WARN_PERCENT;
    const diffFromFallbackPercent = fallbackPrice ? ((normalized - fallbackPrice) / fallbackPrice) * 100 : null;
    const proposedHoldingGbp = normalized * quantity;
    const currentHoldingGbp = (fallbackPrice ?? 0) * quantity;
    const pass = !implausible && !materialFail;

    console.log(`  Internal asset ID:        ${asset.id}`);
    console.log(`  Fund name:                ${inst.name}`);
    console.log(`  ISIN:                     ${inst.isin}`);
    console.log(`  Internal ticker/exchange: ${asset.ticker}.${asset.exchange}`);
    console.log(`  EODHD symbol requested:   ${inst.eodhdSymbol}`);
    console.log(`  Raw EODHD close:          ${rawClose}`);
    console.log(`  Provider observation date:${latest.date}`);
    console.log(`  Quote unit:               ${unit}${asset.provider_quote_unit ? "" : " (Phase A not yet applied — using documented working hypothesis)"}`);
    console.log(`  Normalization multiplier: ${SUB_UNIT_MULTIPLIER[unit]}`);
    console.log(`  Normalized GBP price:     £${normalized.toFixed(2)}`);
    console.log(`  Existing purchase fallback:${fallbackPrice !== null ? `£${fallbackPrice.toFixed(2)}` : "n/a"}`);
    console.log(`  Diff from fallback:       ${diffFromFallbackPercent !== null ? diffFromFallbackPercent.toFixed(1) + "%" : "n/a"}`);
    console.log(`  Independent reference:    £${inst.referencePrice.toFixed(2)} (${inst.referenceSource})`);
    console.log(`  Diff from reference:      ${diffFromReferencePercent.toFixed(1)}%${materialWarn ? "  ⚠ material — review" : ""}${materialFail ? "  ✗ EXCEEDS FAIL THRESHOLD" : ""}`);
    console.log(`  Held quantity:            ${quantity}`);
    console.log(`  Proposed holding value:   £${proposedHoldingGbp.toFixed(2)} (was £${currentHoldingGbp.toFixed(2)} on fallback, delta £${(proposedHoldingGbp - currentHoldingGbp).toFixed(2)})`);
    console.log(`  STATUS: ${pass ? "PASS" : "FAIL"}${implausible ? " — implausible scale mismatch (>=10x or <=0.1x the reference), refusing" : ""}\n`);

    rows.push({ ticker: inst.ticker, assetId: asset.id, rawClose, unit, normalized, fallbackPrice, quantity, proposedHoldingGbp, reference: inst.referencePrice, diffFromReferencePercent, pass });
    if (!pass) anyFail = true;
  }

  console.log("=== Summary ===");
  for (const r of rows) console.log(`  ${r.ticker}: ${r.pass ? "PASS" : "FAIL" + (r.reason ? ` (${r.reason})` : "")}`);
  console.log();

  if (anyFail || rows.length < INSTRUMENTS.length) {
    console.log("At least one instrument FAILED verification. Do NOT proceed to Phase B (provider-routing activation) until every row passes.");
    process.exit(1);
  }
  console.log("All three instruments passed. Review the reconciliation above in full before proceeding to Phase B with explicit approval.");
}

main().catch(error => {
  console.error("FATAL — the dry run itself failed before completing (no writes were attempted regardless):", error instanceof Error ? error.message : error);
  process.exit(1);
});
