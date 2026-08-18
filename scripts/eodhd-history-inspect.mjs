#!/usr/bin/env node
// Read-only inspection for the EODHD historical backfill task — gathers the
// exact facts the task's own Step 1 requires before any write is attempted.
// ZERO database writes. GET requests only.
//
// Usage: node scripts/eodhd-history-inspect.mjs
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

const SUPABASE_URL = envVar("NEXT_PUBLIC_SUPABASE_URL");
const SUPABASE_SECRET_KEY = envVar("SUPABASE_SECRET_KEY");
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY are not set.");
  process.exit(1);
}

const TICKERS = [
  { ticker: "VWRP", isin: "IE00BK5BQT80", eodhdSymbol: "VWRP.LSE" },
  { ticker: "V3AB", isin: "IE00BNG8L278", eodhdSymbol: "V3AB.LSE" },
  { ticker: "VUAG", isin: "IE00BFMXXD54", eodhdSymbol: "VUAG.LSE" },
];

async function supabaseGet(pathAndQuery) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, { headers: { apikey: SUPABASE_SECRET_KEY, Authorization: `Bearer ${SUPABASE_SECRET_KEY}` } });
  return res.json();
}

async function main() {
  console.log("=== EODHD history backfill — read-only pre-flight inspection ===\n");

  let ownerId = null;
  let portfolioTotalNote = "computed separately via /api/investments/portfolio (owner-authenticated)";

  for (const t of TICKERS) {
    const assets = await supabaseGet(`investment_assets?ticker=eq.${t.ticker}&exchange=eq.LSE&select=id,owner_id,display_name,ticker,exchange,pricing_provider,provider_quote_unit,native_currency,archived_at`);
    const asset = Array.isArray(assets) ? assets[0] : null;
    console.log(`--- ${t.ticker} (${t.isin}) — EODHD symbol ${t.eodhdSymbol} ---`);
    if (!asset) { console.log("  NOT FOUND\n"); continue; }
    ownerId = asset.owner_id;

    const buys = await supabaseGet(`investment_transactions?asset_id=eq.${asset.id}&transaction_type=in.(buy,deposit)&reversed_at=is.null&select=trade_at,quantity&order=trade_at.asc`);
    const firstBuy = Array.isArray(buys) && buys.length > 0 ? buys[0].trade_at : null;

    const allTx = await supabaseGet(`investment_transactions?asset_id=eq.${asset.id}&transaction_type=in.(buy,sell)&reversed_at=is.null&select=transaction_type,quantity&order=trade_at.asc`);
    let quantity = 0;
    if (Array.isArray(allTx)) for (const r of allTx) { const q = Number(r.quantity ?? 0); quantity += r.transaction_type === "buy" ? q : -q; }

    const eodhdSnaps = await supabaseGet(`investment_price_snapshots?asset_id=eq.${asset.id}&provider=eq.eodhd&select=price_at,native_unit_price,gbp_unit_price,raw_provider_price,provider_quote_unit,normalization_multiplier&order=price_at.asc`);
    const otherSnaps = await supabaseGet(`investment_price_snapshots?asset_id=eq.${asset.id}&provider=neq.eodhd&select=price_at,provider,native_unit_price,data_quality&order=price_at.asc`);

    console.log(`  Asset ID:                 ${asset.id}`);
    console.log(`  Ticker/Exchange:          ${asset.ticker}.${asset.exchange}`);
    console.log(`  pricing_provider:         ${asset.pricing_provider}`);
    console.log(`  provider_quote_unit:      ${asset.provider_quote_unit}`);
    console.log(`  First non-reversed buy:   ${firstBuy}`);
    console.log(`  Current net quantity:     ${quantity}`);
    console.log(`  Existing EODHD snapshots: ${Array.isArray(eodhdSnaps) ? eodhdSnaps.length : "ERR"}`);
    if (Array.isArray(eodhdSnaps) && eodhdSnaps.length > 0) {
      console.log(`  Earliest EODHD snapshot:  ${eodhdSnaps[0].price_at}`);
      console.log(`  Latest EODHD snapshot:    ${eodhdSnaps[eodhdSnaps.length - 1].price_at}`);
      console.log(`  Latest EODHD price:       raw=${eodhdSnaps[eodhdSnaps.length - 1].raw_provider_price} unit=${eodhdSnaps[eodhdSnaps.length - 1].provider_quote_unit} mult=${eodhdSnaps[eodhdSnaps.length - 1].normalization_multiplier} native=${eodhdSnaps[eodhdSnaps.length - 1].native_unit_price} gbp=${eodhdSnaps[eodhdSnaps.length - 1].gbp_unit_price}`);
      console.log(`  All EODHD dates:          ${eodhdSnaps.map(s => s.price_at.slice(0, 10)).join(", ")}`);
      const bad = eodhdSnaps.filter(s => s.normalization_multiplier !== null && Number(s.normalization_multiplier) !== 1);
      console.log(`  Rows with multiplier!=1:  ${bad.length}`);
      const mismatch = eodhdSnaps.filter(s => s.raw_provider_price !== null && Math.abs(Number(s.raw_provider_price) - Number(s.native_unit_price)) > 0.001);
      console.log(`  Rows raw!=native:         ${mismatch.length}`);
    }
    console.log(`  Non-EODHD snapshots:      ${Array.isArray(otherSnaps) ? otherSnaps.length : "ERR"}${Array.isArray(otherSnaps) && otherSnaps.length > 0 ? " (" + otherSnaps.map(s => `${s.provider}/${s.data_quality}@${s.price_at.slice(0,10)}`).join(", ") + ")" : ""}`);
    console.log();
  }

  console.log(`Owner ID (for portfolio total lookup): ${ownerId}`);
  console.log(portfolioTotalNote);
}

main().catch(error => {
  console.error("FATAL:", error instanceof Error ? error.message : error);
  process.exit(1);
});
