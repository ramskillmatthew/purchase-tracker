#!/usr/bin/env node
// Verification-only: proves a just-recovered draft can enter a NEW batch
// (requirement: "Recovered listings can enter a new batch"). Calls the
// EXISTING rpc/listing_studio_create_extension_batch directly (the same
// RPC the app's own create route calls) with exactly one of the released
// draft ids, confirms success, then immediately soft-cancels that test
// batch (status='cancelled' — the same cooperative-cancel the app's own
// DELETE route performs) so nothing lingers. NEVER claims, fetches a
// payload for, or processes this batch through the extension — no photo
// I/O, no pairing code is ever revealed to anything, nothing is saved or
// published.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

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
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) { console.error("Supabase env vars not set."); process.exit(1); }
function headers(extra = {}) {
  const h = { apikey: SUPABASE_SECRET_KEY, "Content-Type": "application/json", ...extra };
  if (!SUPABASE_SECRET_KEY.startsWith("sb_secret_")) h.Authorization = `Bearer ${SUPABASE_SECRET_KEY}`;
  return h;
}
async function supabasePost(pathAndQuery, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${pathAndQuery} -> ${res.status} ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}
async function supabasePatch(pathAndQuery, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, { method: "PATCH", headers: headers({ Prefer: "return=minimal" }), body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`PATCH ${pathAndQuery} -> ${res.status} ${(await res.text()).slice(0, 400)}`);
}

const OWNER_ID = "4e2db2dd-f355-41b5-a503-67d45c99f233";
const RELEASED_DRAFT_ID = "757fa220-f15a-4b77-8fa7-9b552702afe1"; // Merrell Greylock Waterproof Hiking Boots — was locked by the now-recovered batch #2

const pairingCodeHash = crypto.createHash("sha256").update(`verify-only-${crypto.randomUUID()}`).digest("hex");
const expiresAt = new Date(Date.now() + 60 * 1000).toISOString(); // 1 minute — this test batch is cancelled well before that anyway

console.log(`Attempting to create a batch containing the recovered draft ${RELEASED_DRAFT_ID}...`);
let created;
try {
  const rows = await supabasePost("rpc/listing_studio_create_extension_batch", {
    p_owner_id: OWNER_ID, p_pairing_code_hash: pairingCodeHash, p_expires_at: expiresAt, p_draft_ids: [RELEASED_DRAFT_ID],
  });
  created = rows[0];
} catch (error) {
  console.error("FAILED — the draft is still locked:", error.message);
  process.exit(1);
}
console.log(`SUCCESS — created batch ${created.batch_id} (display #${created.display_number}) — the recovered draft is no longer locked.`);

console.log("Immediately soft-cancelling this verification-only batch (never claimed, never processed)...");
await supabasePatch(`vinted_extension_batches?id=eq.${created.batch_id}&owner_id=eq.${OWNER_ID}`, { status: "cancelled", completed_at: new Date().toISOString() });
await supabasePatch(`vinted_extension_batch_items?batch_id=eq.${created.batch_id}&status=eq.queued`, { status: "cancelled" });
console.log("Done — verification batch cancelled and left in a clean, harmless terminal state.");
