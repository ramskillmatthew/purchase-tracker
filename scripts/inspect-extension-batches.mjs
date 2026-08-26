#!/usr/bin/env node
// Read-only diagnosis for orphaned Vinted extension batches — gathers the
// exact facts required before any recovery is attempted. ZERO database
// writes. GET requests only.
//
// Usage: node scripts/inspect-extension-batches.mjs
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

async function supabaseGet(pathAndQuery) {
  const headers = { apikey: SUPABASE_SECRET_KEY };
  if (!SUPABASE_SECRET_KEY.startsWith("sb_secret_")) headers.Authorization = `Bearer ${SUPABASE_SECRET_KEY}`;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, { headers, cache: "no-store" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GET ${pathAndQuery} -> ${res.status} ${text.slice(0, 500)}`);
  }
  return res.json();
}

console.log("=== vinted_extension_batches — every non-purely-historical-terminal row ===\n");
const batches = await supabaseGet(
  "vinted_extension_batches?select=id,owner_id,status,listing_count,created_at,claimed_at,expires_at,completed_at,box_dismissed_at,activity_dismissed_at,display_number,extension_id,extension_version,browser_label&order=created_at.desc&limit=200",
);
const NONTERMINAL_BATCH_STATUSES = new Set(["pending_claim", "claimed", "in_progress"]);
const nonterminalBatches = batches.filter(b => NONTERMINAL_BATCH_STATUSES.has(b.status));
const now = Date.now();

for (const b of batches) {
  const isNonterminal = NONTERMINAL_BATCH_STATUSES.has(b.status);
  const marker = isNonterminal ? " <-- NONTERMINAL (potentially locking)" : "";
  console.log(
    `id=${b.id} owner=${b.owner_id} status=${b.status} display#=${b.display_number} items=${b.listing_count}`
    + ` created=${b.created_at} claimed=${b.claimed_at ?? "—"} expires=${b.expires_at} completed=${b.completed_at ?? "—"}`
    + ` box_dismissed=${b.box_dismissed_at ?? "—"} activity_dismissed=${b.activity_dismissed_at ?? "—"}`
    + ` ext=${b.extension_id ?? "—"}/${b.extension_version ?? "—"} browser=${b.browser_label ?? "—"}${marker}`,
  );
  if (isNonterminal) {
    const expired = new Date(b.expires_at).getTime() < now;
    console.log(`    -> expires_at is ${expired ? "PAST (expired by wall clock, but status never flipped)" : "still in the future"}`);
    console.log(`    -> box_dismissed_at is ${b.box_dismissed_at ? "SET (hidden from Listings Review grid despite being nonterminal)" : "null (should still be visible)"}`);
  }
}

console.log(`\nTotal batches: ${batches.length}. Nonterminal (pending_claim/claimed/in_progress): ${nonterminalBatches.length}.\n`);

if (nonterminalBatches.length === 0) {
  console.log("No nonterminal batches found — nothing to recover.");
  process.exit(0);
}

console.log("=== vinted_extension_batch_items for each nonterminal batch ===\n");
const NONTERMINAL_ITEM_STATUSES = new Set(["queued", "preparing", "filling", "saving", "paused"]);
for (const b of nonterminalBatches) {
  console.log(`--- batch ${b.id} (display #${b.display_number}, status=${b.status}) ---`);
  const items = await supabaseGet(
    `vinted_extension_batch_items?batch_id=eq.${b.id}&select=id,draft_id,queue_position,status,attempt_count,error_code,error_message,vinted_draft_id,started_at,completed_at,current_step,step_detail&order=queue_position.asc`,
  );
  for (const it of items) {
    const locking = NONTERMINAL_ITEM_STATUSES.has(it.status);
    console.log(
      `  item=${it.id} draft=${it.draft_id} pos=${it.queue_position} status=${it.status}${locking ? " <-- LOCKS this draft" : ""}`
      + ` attempts=${it.attempt_count} vinted_draft_id=${it.vinted_draft_id ?? "—"} current_step=${it.current_step ?? "—"} step_detail=${it.step_detail ?? "—"}`
      + ` error=${it.error_code ?? "—"}`,
    );
  }

  // Cross-reference: what does listing_drafts currently show for each locked draft?
  const lockedDraftIds = items.filter(it => NONTERMINAL_ITEM_STATUSES.has(it.status)).map(it => it.draft_id);
  if (lockedDraftIds.length > 0) {
    const drafts = await supabaseGet(
      `listing_drafts?id=in.(${lockedDraftIds.join(",")})&select=id,title,status,generated_title`,
    );
    console.log("  Cross-referenced listing_drafts:");
    for (const d of drafts) console.log(`    draft=${d.id} title="${d.generated_title ?? d.title ?? "(untitled)"}" status=${d.status}`);
  }
  console.log("");
}

console.log("=== Diagnosis summary ===");
console.log(
  "The active-batch creation guard (rpc listing_studio_create_extension_batch) blocks a draft when it has\n"
  + "a batch_item row where the PARENT BATCH status is NOT IN ('completed','cancelled','expired') AND the\n"
  + "ITEM's own status is NOT IN ('completed','failed','cancelled'). Every batch/item pair marked LOCKS above\n"
  + "is therefore actively blocking a new batch from being created for that draft.\n\n"
  + "These batches do not appear in Listings Review because the UI's GET /api/listing-studio/extension-batches\n"
  + "route only returns rows where box_dismissed_at is null — if box_dismissed_at is set on a still-nonterminal\n"
  + "batch (see 'box_dismissed_at is SET' markers above), it becomes invisible while still legally locking its\n"
  + "drafts (this is the 'hidden active batch' gap). If box_dismissed_at is null but the row is simply old and\n"
  + "the client never resumed tracking it (e.g. across a full page reload before the resume-fetch existed, or\n"
  + "the extension abandoned it before ever completing/failing every item), it can also just silently sit there\n"
  + "with no periodic sweep ever touching it (confirmed: there is no cron/sweep in this codebase today).",
);
