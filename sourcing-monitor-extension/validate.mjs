#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir=path.dirname(fileURLToPath(import.meta.url));
let failures=0; const fail=m=>{failures++;console.error(`✗ ${m}`)}; const ok=m=>console.log(`✓ ${m}`);
const manifest=JSON.parse(readFileSync(path.join(dir,"manifest.json"),"utf8"));
if(manifest.manifest_version!==3) fail("Manifest must use MV3"); else ok("Manifest uses MV3");
if(JSON.stringify(manifest.host_permissions)!==JSON.stringify(["https://discord.com/*","https://*.vinted.co.uk/*"])) fail("Host permissions must be restricted to Discord and Vinted UK"); else ok("Host permissions are restricted to Discord and Vinted UK");
for(const forbidden of ["scripting","debugger","webRequest","cookies"]){if(manifest.permissions.includes(forbidden))fail(`Forbidden permission: ${forbidden}`)}
for(const file of [manifest.background.service_worker,manifest.action.default_popup,...manifest.content_scripts.flatMap(x=>x.js),...(manifest.web_accessible_resources ?? []).flatMap(x=>x.resources)]){if(!existsSync(path.join(dir,file)))fail(`Missing ${file}`)}
function walk(d){return readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):(e.name.endsWith(".js")?[path.join(d,e.name)]:[]))}
for(const file of walk(dir)){try{execFileSync(process.execPath,["--input-type=module","--check"],{input:readFileSync(file),stdio:["pipe","pipe","pipe"]});ok(`${path.relative(dir,file)} parses`)}catch(e){fail(`${path.relative(dir,file)}: ${e.stderr?.toString()||e.message}`)}}
const executableSource=walk(dir).map(file=>readFileSync(file,"utf8")).join("\n");
if(/dispatchEvent\s*\(|chrome\.debugger|sendInput/i.test(executableSource))fail("Extension contains an unsafe activation primitive");else ok("Click testing uses no debugger, synthetic event dispatch, or OS input");
if(failures)process.exit(1); console.log("All sourcing monitor extension checks passed.");
