#!/usr/bin/env node
// Lightweight validation for vinted-draft-queue-extension/ — no Chrome
// install required. Checks:
//   1. manifest.json is valid JSON with the required MV3 fields.
//   2. Every file manifest.json references actually exists on disk.
//   3. Every .js file in the extension parses as valid JavaScript
//      (node --check) — catches a syntax error before it ever reaches a
//      real browser.
//   4. The permission/host_permission allowlist hasn't grown unexpectedly
//      (a cheap structural safety net alongside the vitest publishing-
//      safety tests, which check this content-wise in more depth).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT_DIR = path.join(ROOT, "vinted-draft-queue-extension");

let failures = 0;
function fail(message) {
  failures += 1;
  console.error(`✗ ${message}`);
}
function ok(message) {
  console.log(`✓ ${message}`);
}

if (!existsSync(EXT_DIR)) {
  console.error(`✗ extension directory not found: ${EXT_DIR}`);
  process.exit(1);
}

const manifestPath = path.join(EXT_DIR, "manifest.json");
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  ok("manifest.json is valid JSON");
} catch (error) {
  fail(`manifest.json is not valid JSON: ${error.message}`);
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}

for (const field of ["manifest_version", "name", "version", "key", "permissions", "host_permissions", "background", "side_panel", "content_scripts"]) {
  if (manifest[field] === undefined) fail(`manifest.json is missing required field "${field}"`);
  else ok(`manifest.json has "${field}"`);
}

if (manifest.manifest_version !== 3) fail(`manifest_version must be 3, got ${manifest.manifest_version}`);
else ok("manifest_version is 3");

const REQUIRED_PERMISSIONS = ["storage", "tabs", "scripting", "sidePanel"];
for (const permission of REQUIRED_PERMISSIONS) {
  if (!manifest.permissions?.includes(permission)) fail(`manifest.json is missing expected permission "${permission}"`);
}
const FORBIDDEN_PERMISSIONS = ["cookies", "history", "proxy", "webRequest", "management", "debugger", "geolocation"];
for (const permission of manifest.permissions ?? []) {
  if (FORBIDDEN_PERMISSIONS.includes(permission)) fail(`manifest.json requests a permission it must never request: "${permission}"`);
}
ok(`permissions: [${(manifest.permissions ?? []).join(", ")}]`);

// The exact, deployed production origin (https://purchase-tracker-one.vercel.app)
// this extension is permitted to talk to — an EXACT match, never a substring/prefix
// check, so a lookalike or broader origin can never silently pass this gate.
const ALLOWED_PRODUCTION_ORIGIN = "https://purchase-tracker-one.vercel.app/*";
for (const origin of manifest.host_permissions ?? []) {
  const isAllowed = origin === "https://www.vinted.co.uk/*" || origin === "https://www.ebay.co.uk/*" || origin === "https://*.ebaydesc.com/*" || origin.includes("localhost") || origin === ALLOWED_PRODUCTION_ORIGIN;
  if (!isAllowed) fail(`host_permissions contains an unexpected origin: "${origin}"`);
}
ok(`host_permissions: [${(manifest.host_permissions ?? []).join(", ")}]`);

function checkFileExists(relativePath, label) {
  const fullPath = path.join(EXT_DIR, relativePath);
  if (!existsSync(fullPath)) fail(`${label} references a missing file: ${relativePath}`);
  else ok(`${label} -> ${relativePath} exists`);
}

if (manifest.background?.service_worker) checkFileExists(manifest.background.service_worker, "background.service_worker");
if (manifest.background?.type !== "module") fail("background.type must be \"module\" (service-worker.js uses ES module imports)");

if (manifest.side_panel?.default_path) checkFileExists(manifest.side_panel.default_path, "side_panel.default_path");

for (const entry of manifest.content_scripts ?? []) {
  for (const file of entry.js ?? []) checkFileExists(file, "content_scripts.js");
}

for (const entry of manifest.web_accessible_resources ?? []) {
  for (const resource of entry.resources ?? []) checkFileExists(resource, "web_accessible_resources.resources");
}

for (const size of ["16", "48", "128"]) {
  if (manifest.icons?.[size]) checkFileExists(manifest.icons[size], `icons["${size}"]`);
  else fail(`manifest.json is missing icons["${size}"]`);
}

// Every .js file in the extension must at least parse — catches a typo/
// syntax error that would otherwise only surface once loaded in Chrome.
function walkJsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkJsFiles(fullPath));
    else if (entry.name.endsWith(".js")) files.push(fullPath);
  }
  return files;
}
// service-worker.js/sidepanel.js/shared/*.js all use ES module import/
// export syntax (background.type is "module"; sidepanel.html loads
// sidepanel.js as <script type="module">; content scripts load the shared
// files via dynamic import()) — --input-type=module is required or `node
// --check` rejects the import/export syntax itself as a parse error.
for (const file of walkJsFiles(EXT_DIR)) {
  try {
    execFileSync(process.execPath, ["--input-type=module", "--check"], { input: readFileSync(file), stdio: ["pipe", "pipe", "pipe"] });
    ok(`${path.relative(EXT_DIR, file)} parses as valid JavaScript (ES module)`);
  } catch (error) {
    fail(`${path.relative(EXT_DIR, file)} failed to parse: ${error.stderr?.toString().trim() || error.message}`);
  }
}

if (!existsSync(path.join(EXT_DIR, "README.md"))) fail("README.md is missing");
else ok("README.md exists");

console.log("");
if (failures > 0) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
}
console.log("All extension validation checks passed.");
