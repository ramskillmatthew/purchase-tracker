#!/usr/bin/env node
// One-off, narrowly-scoped recovery for the two CONFIRMED orphaned Vinted
// extension batches diagnosed via scripts/inspect-extension-batches.mjs.
// Mirrors rpc/listing_studio_recover_stuck_extension_batch's own exact
// logic (see supabase-listing-studio.sql) via direct, owner-scoped REST
// PATCHes — used ONLY because that RPC does not yet exist in the live
// database (no DDL access is available to this script; the migration
// still needs to be run once via the Supabase SQL editor for the new
// in-app /recover route and heartbeat column to work going forward).
//
// NEVER a broad sweep: only the two explicit batch ids below are ever
// touched. Re-reads each batch immediately before mutating it. Refuses to
// touch a batch whose expires_at has not yet passed (this script has no
// last_extension_activity_at signal to check yet, since that column
// doesn't exist in the live DB until the migration runs — expires_at
// alone is the ONLY signal available here, and both confirmed batches are
// already well past it). Never touches a completed item.
//
// Usage: node scripts/recover-stuck-extension-batches.mjs
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
const SUPABASE_SECRET_KEY = envVar("SUPABASE_SECRET_KEY") ?? envVar("SUPABASE_SERVICE_ROLE_KEY");
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY are not set.");
  process.exit(1);
}

function headers(extra = {}) {
  const h = { apikey: SUPABASE_SECRET_KEY, "Content-Type": "application/json", ...extra };
  if (!SUPABASE_SECRET_KEY.startsWith("sb_secret_")) h.Authorization = `Bearer ${SUPABASE_SECRET_KEY}`;
  return h;
}
async function supabaseGet(pathAndQuery) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, { headers: headers(), cache: "no-store" });
  if (!res.ok) throw new Error(`GET ${pathAndQuery} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}
async function supabasePatch(pathAndQuery, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    method: "PATCH", headers: headers({ Prefer: "return=representation" }), body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${pathAndQuery} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const OWNER_ID = "4e2db2dd-f355-41b5-a503-67d45c99f233";
const CONFIRMED_ORPHANED_BATCH_IDS = [
  "df6236c5-cfbc-4e7f-b8cf-5083b76fb10a", // display #2
  "2f33f9c5-f7c2-4d5f-bb12-648fbf4e35e0", // display #1
];
const NONTERMINAL_BATCH_STATUSES = new Set(["pending_claim", "claimed", "in_progress"]);
const NONTERMINAL_ITEM_STATUSES = new Set(["queued", "preparing", "filling", "saving", "paused"]);

let totalReleased = 0;
for (const batchId of CONFIRMED_ORPHANED_BATCH_IDS) {
  console.log(`\n=== Recovering batch ${batchId} ===`);

  // Re-read immediately before mutating — the freshest possible view.
  const [batch] = await supabaseGet(
    `vinted_extension_batches?id=eq.${batchId}&owner_id=eq.${OWNER_ID}`
    + `&select=id,status,expires_at,completed_at,display_number,owner_id`,
  );
  if (!batch) { console.log("  Not found for this owner — skipping (never touched)."); continue; }
  if (!NONTERMINAL_BATCH_STATUSES.has(batch.status)) {
    console.log(`  Already terminal (status=${batch.status}) — nothing to recover, skipping.`);
    continue;
  }
  const expired = new Date(batch.expires_at).getTime() <= Date.now();
  if (!expired) {
    console.log(`  REFUSING: expires_at (${batch.expires_at}) has not yet passed — this batch could still be genuinely active. Not touched.`);
    continue;
  }

  const items = await supabaseGet(
    `vinted_extension_batch_items?batch_id=eq.${batchId}&select=id,draft_id,status,vinted_draft_id`,
  );
  const nonterminal = items.filter(i => NONTERMINAL_ITEM_STATUSES.has(i.status));
  const preservedCompleted = items.filter(i => i.status === "completed" && i.vinted_draft_id).length;
  console.log(`  status=${batch.status} display=#${batch.display_number} items=${items.length} nonterminal=${nonterminal.length} preservedCompleted=${preservedCompleted}`);

  if (nonterminal.length === 0) {
    console.log("  No nonterminal items — batch itself will still be marked cancelled for consistency, but nothing was locking a draft.");
  }

  const nowIso = new Date().toISOString();
  await supabasePatch(`vinted_extension_batches?id=eq.${batchId}&owner_id=eq.${OWNER_ID}`, {
    status: "cancelled", completed_at: batch.completed_at ?? nowIso,
  });

  for (const item of nonterminal) {
    await supabasePatch(`vinted_extension_batch_items?id=eq.${item.id}&batch_id=eq.${batchId}`, {
      status: "cancelled", completed_at: nowIso, current_step: null, step_detail: null,
      error_code: "BATCH_RECOVERED",
      error_message: "This batch was recovered as stuck by the owner — the associated extension had stopped without reporting a final result.",
    });
  }

  totalReleased += nonterminal.length;
  console.log(`  Recovered: batch -> cancelled, ${nonterminal.length} item(s) -> cancelled, ${preservedCompleted} completed item(s) preserved untouched.`);
}

console.log(`\n=== Done. ${totalReleased} listing(s) released across ${CONFIRMED_ORPHANED_BATCH_IDS.length} confirmed orphaned batch(es). ===`);
