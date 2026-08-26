# Vinted Draft Queue extension

A completely new, from-scratch Chrome (Manifest V3) extension for Trotters
Attire Listing Studio. It fills Vinted's Create Listing form from data the
app already validated as Ready, and saves each item **as a Vinted draft
only**. It never clicks Vinted's Upload/Publish/List-item action, and it
never publishes anything — see "Publishing safety" below.

This is a separate, independent implementation. It does not reuse, import,
or depend on any earlier extension work, the stopped Playwright runner
(`vinted-runner/`), or any dedicated Chromium profile from earlier sessions.
It runs in your **normal Chrome profile**, in the tab where you're already
logged into Vinted.

## What it does

1. In Listings Review, select up to 5 Ready listings and click **Send to
   Chrome extension**. The app validates them again server-side and shows
   a short pairing code.
2. Open this extension's side panel, enter the code.
3. The extension shows the Vinted account it can currently see on the page
   (read from the page itself — never from cookies). Confirm it's the
   right one.
4. Click **Start batch**. The extension processes the 5 listings one at a
   time: opens Vinted's Create Listing form, uploads photos, fills every
   field from the app's own data, and clicks **only** the Save Draft
   action.
5. Each listing's resulting Vinted draft reference is reported back to the
   app automatically.

## Installation (unpacked, for development/testing)

1. Set the two extension-related environment variables in the app's
   `.env.local` (see the main repo README / this feature's completion
   report for the exact values):
   - `EXTENSION_BATCH_SECRET` — a random string, at least 32 characters.
   - `EXTENSION_ORIGIN` — `chrome-extension://ocohhcppeflfggaicbpgmjbmekgbkjcl`
     (this extension's id is FIXED by the `"key"` field already committed
     in `manifest.json` — see "Why the extension id is fixed" below — so
     this value never changes across machines or reinstalls).
2. Before loading the extension, open `manifest.json` and replace
   `https://YOUR-PRODUCTION-APP-DOMAIN.example/*` in `host_permissions`
   with your actual deployed app origin (or remove that line entirely if
   you only ever use this against `localhost`).
3. In Chrome, go to `chrome://extensions`, enable **Developer mode** (top
   right), click **Load unpacked**, and select this folder
   (`vinted-draft-queue-extension/`).
4. Confirm the loaded extension's id matches
   `ocohhcppeflfggaicbpgmjbmekgbkjcl`. It should, because of the fixed key.
5. Click the extension's icon to open the side panel. Under **App URL**,
   confirm/set the app's own URL (defaults to `http://localhost:3000`) and
   click **Save**.
6. Log into Vinted normally in a regular tab in the same Chrome profile,
   the way you always do.

### Why the extension id is fixed

Chrome normally assigns an unpacked extension a *different* random id every
time it's loaded on a different machine (or reloaded after certain
changes), which would make `EXTENSION_ORIGIN` (used for CORS on the app
side) a moving target. `manifest.json` pins a `"key"` field (an RSA public
key) — this is a normal, supported Chrome mechanism, not a workaround —
which makes the id deterministic: it's always
`ocohhcppeflfggaicbpgmjbmekgbkjcl` for this exact key, on any machine. The
corresponding private key was never saved anywhere and isn't needed —
Chrome only needs the public key in the manifest to compute the id for
unpacked/development loading.

## Permissions (and why)

- `storage` — the queue state persists in `chrome.storage.local`, and must
  survive the side panel closing and the service worker being suspended.
- `tabs` — to find or open the one Vinted tab this extension drives.
- `scripting` — declared for Manifest V3 content-script infrastructure
  (the actual field-filling content script is otherwise statically
  declared in `manifest.json`, not injected ad hoc).
- `sidePanel` — the UI surface.
- `alarms` — a periodic (1-minute) self-healing tick so the queue keeps
  moving even if the service worker was suspended between items, and so a
  batch resumes automatically after a browser restart (while it hasn't
  expired).

Host permissions are restricted to: the app's own origin(s) (localhost dev
+ your production domain — edit `manifest.json` before installing, see
above) and `https://www.vinted.co.uk/*`. Nothing else.

`manifest.json` lists `http://localhost:3000/*`, `http://localhost:3001/*`,
and `http://localhost:3002/*` explicitly — `next dev` doesn't always pick
port 3000 (it falls through to the next free port), and the extension's own
**App URL** setting must always be one the extension actually has
permission to fetch. Add another explicit `http://localhost:<port>/*` entry
if your dev server ever lands on a port outside this range. `127.0.0.1` is
deliberately **not** included — this app is only ever accessed via
`localhost` in development, so granting `127.0.0.1` host permission as well
would be an unused, unnecessarily broad grant; add it only if you actually
configure the App URL to point there. **Before shipping to production**,
replace `https://YOUR-PRODUCTION-APP-DOMAIN.example/*` with the exact
deployed app origin — never leave the placeholder in a distributed build,
and never widen it to a wildcard/internet-wide pattern.

**Not requested, deliberately**: `cookies`, browsing history, proxy
control, password access, or access to any other website. This extension
never reads Vinted's cookies or session — it only reads what's visibly on
the page (see "Account awareness" below), and it only ever talks to the
app's own API and to `vinted.co.uk` pages you already have open.

## Publishing safety — a hard architectural rule, not just wording

- There is no publish/upload/list-live function anywhere in this
  extension's code. Not behind a flag, not commented out — absent.
- The only click a state-machine step is ever allowed to perform against a
  final-save-shaped control goes through `resolveSaveDraftButton()` in
  `shared/vinted-fields.js`, which requires the control's accessible name
  to match an explicit "save draft" allowlist **and** fail an independent
  forbidden-word check (`Upload`, `Publish`, `List item`, `Post`, `Submit
  listing`, and related phrasings) before it is ever touched.
- Every other click in the state machine (dropdown options, photo
  triggers, condition radios) is also gated through the same
  forbidden-word guard, `assertNotForbiddenAction()`, as defence in depth.
- If the Save Draft control can't be found, or more than one match exists,
  the step fails — it never falls back to "the first button" or "the
  visually primary button".
- The form is never submitted by pressing Enter, and no coordinates-based
  clicking is used anywhere.
- No undocumented Vinted API is ever called directly — every action is a
  simulated user interaction with the rendered page.
- `tests/vinted-extension-publishing-safety.test.ts` (in the main repo)
  structurally proves: no function in this extension ever clicks a
  forbidden-named control, the save-draft allowlist and the forbidden list
  are disjoint by construction, and there is no code path that could
  publish a listing.
- The side panel permanently displays **"Drafts only — never publishes"**.

## Vinted field strategy — what's verified vs. best-effort

`shared/vinted-fields.js` is split into two parts:

- **The framework** (accessible-name resolution, unique-match requirement,
  the forbidden-action guard, the save-draft allowlist) — fully unit
  tested against synthetic DOM fixtures. This part does not depend on
  Vinted's actual markup at all.
- **`VINTED_FIELD_STRATEGIES`** (the actual label text / test-id guesses
  for Title, Category, Brand, Size, Condition, Colour, Material, Price,
  the photo input, and the Save Draft button) — **best-effort**, not
  verified against Vinted's real, live DOM. No live browser inspection of
  vinted.co.uk was performed while building this extension.

This is safe by construction: if a strategy's guess doesn't match the real
page, the step fails to find a unique element and the item is reported as
failed with a clear reason — it never guesses, never falls back to a
generic control, and never partially fills a listing. Stage 1 testing
(a synthetic mock fixture) proves the state machine and safety guards work
correctly, independent of whether the Vinted-specific guesses are right.
Stage 2 (one real listing, a human watching) is where you'll find out
which guesses need adjusting — update ONLY the relevant entry in
`VINTED_FIELD_STRATEGIES`; the framework functions around it should not
need to change.

## Architecture

- **`service-worker.js`** — the only place `chrome.storage.local` is
  written. Owns claiming a batch, fetching its payload, managing the
  Vinted tab, dispatching one item at a time, and reporting results.
  Holds no state in memory — every handler reads state fresh from storage
  and writes it back before returning, because Chrome can suspend the
  service worker at any time.
- **`content-script.js`** — runs on `vinted.co.uk`, executes the state
  machine for exactly one item at a time when told to by the service
  worker, reports every step transition back.
- **`sidepanel.html`/`.js`/`.css`** — the UI. Talks only to the service
  worker; re-renders from `chrome.storage.onChanged`.
- **`shared/messages.js`** — the one message-type contract every part
  uses.
- **`shared/queue-state.js`** — pure functions computing the next queue
  state from the current one. No `chrome.*` calls, no mutation, no hidden
  clock reads (timestamps are passed in) — this is what makes it directly
  unit-testable and is the actual "state machine" the task asked for.
- **`shared/vinted-fields.js`** — DOM query framework + field strategies
  (see above).
- **`shared/validation.js`** — dependency-free defensive re-validation of
  data received from the app.

No remotely-hosted JavaScript is loaded anywhere — every file the
extension runs is packaged inside this folder.

## Queue persistence and resume

The full queue (pairing, batch id, every item's status/attempt
count/error/result) lives in `chrome.storage.local` under one `state` key.
On every service worker start (`chrome.runtime.onInstalled` /
`chrome.runtime.onStartup`) and on a 1-minute alarm tick, the service
worker calls `resumeAfterRestart()`: any item still showing an in-flight
status (`preparing`/`filling`/`saving`) at that moment is reset to
`queued` — the content script that was running it is gone, so its
mid-flight DOM state can never be trusted, and the safest, simplest
correct behaviour is to cleanly reprocess that item from the start (Vinted
form navigation is always safe to redo — it never creates anything by
itself). This is what "resume safely after service-worker suspension /
tab reload / browser restart" means in this implementation.
