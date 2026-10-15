import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
const read = (path: string) => readFileSync(path, "utf8");
const source = read("app/settings/page.tsx");

describe("app/settings/page.tsx — eBay UK section placement and structure", () => {
  it("REQUIREMENT: sits in the SAME long Settings panel — no new page/route is introduced", () => {
    // The whole file is one component rendering into the existing
    // .settings-panel; a genuinely separate page would need its own
    // app/**/page.tsx — confirmed none exists for this feature.
    expect(source).toContain("<h2>eBay UK</h2>");
    expect(source).toContain('className="settings-panel"');
  });

  it("REQUIREMENT: appears below Yahoo Mail and above Private email index", () => {
    const yahooIndex = source.indexOf("<h2>Yahoo Mail</h2>");
    const ebayIndex = source.indexOf("<h2>eBay UK</h2>");
    const privateIndexIndex = source.indexOf("<h2>Private email index</h2>");
    expect(yahooIndex).toBeGreaterThan(-1);
    expect(ebayIndex).toBeGreaterThan(yahooIndex);
    expect(privateIndexIndex).toBeGreaterThan(ebayIndex);
  });

  it("reuses the existing settings-section/yahoo-settings wrapper — never a bespoke card/panel/design system", () => {
    const ebaySection = source.slice(source.lastIndexOf('<div className="settings-section yahoo-settings">', source.indexOf("<h2>eBay UK</h2>")), source.indexOf("<h2>eBay UK</h2>") + 4000);
    expect(ebaySection).toContain('className="settings-section yahoo-settings"');
  });

  it("no eBay-specific button uses an icon-only tiny control — every action is a normal-sized text button", () => {
    const ebaySection = source.slice(source.indexOf("<h2>eBay UK</h2>"), source.indexOf("<h2>Private email index</h2>"));
    expect(ebaySection).toContain(">Connect eBay account<");
    expect(ebaySection).toContain("Sync account");
    expect(ebaySection).toContain(">Change account<");
    expect(ebaySection).toContain("Save defaults");
  });
});

describe("app/settings/page.tsx — Stage 6 (eBay draft batches): evidence-based readiness and inventory location default", () => {
  const ebaySection = source.slice(source.indexOf("<h2>eBay UK</h2>"), source.indexOf("<h2>Private email index</h2>"));

  it("REQUIREMENT: Photo upload / Draft creation readiness are computed from real connection/policy/location state, never a hardcoded string", () => {
    expect(ebaySection).not.toContain("<span>Photo upload — Needs attention</span>");
    expect(ebaySection).not.toContain("<span>Draft creation — Needs attention</span>");
    expect(ebaySection).toMatch(/Photo upload — \{photoUploadReady/);
    expect(ebaySection).toMatch(/Live listing — \{draftCreationReady/);
  });

  it("REQUIREMENT: draft-creation readiness requires policies synced AND a usable inventory location, not connection status alone", () => {
    expect(ebaySection).toMatch(/draftCreationReady\s*=\s*!needsReconnect\s*&&\s*connection\.hasRefreshToken\s*&&\s*Boolean\(connection\.lastPolicySyncAt\)\s*&&\s*hasUsableLocation/);
  });

  it("REQUIREMENT: a default inventory location selector exists, offering only currently-available synced locations, with a real 'No default' option", () => {
    expect(ebaySection).toContain("Default inventory location");
    expect(ebaySection).toContain("No default — choose in Listings Review");
    expect(ebaySection).toMatch(/availableLocations\.map\(l => <option key=\{l\.merchantLocationKey\}/);
  });

  it("never creates/edits/enables/disables/deletes a location — only ever reads/selects an existing one", () => {
    expect(ebaySection).not.toMatch(/createInventoryLocation|updateInventoryLocation|deleteInventoryLocation|enableInventoryLocation|disableInventoryLocation/i);
  });
});

describe("app/settings/page.tsx — disconnected state (exact required copy)", () => {
  const ebaySection = source.slice(source.indexOf("<h2>eBay UK</h2>"), source.indexOf("<h2>Private email index</h2>"));

  it("shows the exact required heading/description/supporting copy", () => {
    expect(ebaySection).toContain("Connect your eBay selling account to review and publish listings from Listing Studio.");
    expect(ebaySection).toContain("Secure OAuth connection through eBay.");
    expect(ebaySection).toContain("Nothing is published automatically — every live listing requires a final review and confirmation.");
  });

  it('shows "Not connected" status and a "Connect eBay account" primary action linking straight to the OAuth start route', () => {
    expect(ebaySection).toContain("Not connected");
    expect(ebaySection).toContain('href="/api/ebay/connect"');
  });

  it("REQUIREMENT: never asks the user to paste a token or enter eBay credentials — the action is a plain navigation link, no token input field anywhere in this file", () => {
    expect(source).not.toMatch(/access.?token.*<input/i);
    expect(source).not.toContain('placeholder="Paste your eBay token"');
  });

  it("shows the exact required capability summary when disconnected", () => {
    expect(ebaySection).toContain("Seller account — Connect to enable");
    expect(ebaySection).toContain("Business policies — Connect to enable");
    expect(ebaySection).toContain("Photo upload — Connect to enable");
    expect(ebaySection).toContain("Draft creation — Connect to enable");
  });
});

describe("app/settings/page.tsx — connected state", () => {
  const ebaySection = source.slice(source.indexOf("<h2>eBay UK</h2>"), source.indexOf("<h2>Private email index</h2>"));

  it("REQUIREMENT: displays the connected EMAIL as the primary label, never the eBay username", () => {
    expect(ebaySection).toContain("connection.email || \"Email not supplied by eBay\"");
    expect(ebaySection).not.toMatch(/connection\.ebayUsername|connection\.username/);
  });

  it('REQUIREMENT (email fallback): shows "Email not supplied by eBay" with a supporting explanation, never inferring one, and (Stage 6 correction) never suggests reconnecting for an unavailable identity permission', () => {
    expect(ebaySection).toContain("Email not supplied by eBay");
    expect(ebaySection).toContain("eBay did not supply an email address for this account. This does not affect listing drafts.");
    expect(ebaySection).not.toMatch(/[Rr]econnect(ing)? with the identity permission/);
  });

  it("REQUIREMENT: never exposes the immutable eBay user id in the ordinary UI", () => {
    expect(ebaySection).not.toContain("connection.ebayUserId}");
    expect(ebaySection).not.toContain("ebayUserId }");
  });

  it("shows account type, marketplace, and last sync times", () => {
    expect(ebaySection).toContain('"Business seller"');
    expect(ebaySection).toContain('"United Kingdom"');
    expect(ebaySection).toContain("Last account sync");
    expect(ebaySection).toContain("Last policy sync");
  });

  it("offers Sync account / Change account / Disconnect, each a real action", () => {
    expect(ebaySection).toContain("onClick={syncEbay}");
    expect(ebaySection).toContain("onClick={changeEbayAccount}");
    expect(ebaySection).toContain("onClick={disconnectEbay}");
  });

  it("REQUIREMENT: Change account and Disconnect both require confirmation before acting", () => {
    expect(source).toContain("window.confirm(\"Connecting a different eBay account will replace the active connection for future draft creation. Existing local drafts are kept. Continue?\")");
    expect(source).toContain("window.confirm(\"Disconnect this eBay account? Existing Listing Studio drafts are kept — you can reconnect at any time.\")");
  });

  it("REQUIREMENT: Change account never deletes local drafts and starts a fresh OAuth flow", () => {
    expect(source).toContain('window.location.href = "/api/ebay/connect?intent=change_account"');
    expect(source).not.toMatch(/listing_drafts.*DELETE|DELETE.*listing_drafts/);
  });
});

describe("app/settings/page.tsx — eBay listing defaults (postage/return/payment policy selection)", () => {
  const ebaySection = source.slice(source.indexOf("<h2>eBay UK</h2>"), source.indexOf("<h2>Private email index</h2>"));

  it("REQUIREMENT: renders ALL available policies of each type, never collapsed to one", () => {
    expect(ebaySection).toContain('availablePolicies("FULFILLMENT").map(p =>');
    expect(ebaySection).toContain('availablePolicies("RETURN").map(p =>');
    expect(ebaySection).toContain('availablePolicies("PAYMENT").map(p =>');
  });

  it("REQUIREMENT: selects/saves by eBay policy ID (option value), while showing the policy NAME to the user", () => {
    expect(ebaySection).toContain("value={p.ebayPolicyId}>{p.name}</option>");
  });

  it('REQUIREMENT: a stale saved default that is no longer available shows "Default policy needs attention", never silently swapped', () => {
    expect(ebaySection).toContain("Default policy needs attention");
    expect(ebaySection).toContain("defaultNeedsAttention(");
  });

  it("REQUIREMENT: shows the real, live policy counts, never invented numbers", () => {
    expect(ebaySection).toContain("{fulfillmentCount} postage polic");
    expect(ebaySection).toContain("{returnCount} return polic");
    expect(ebaySection).toContain("{paymentCount} payment polic");
    expect(ebaySection).toContain("Synced from eBay");
  });

  it("Save defaults sends real policy IDs to the defaults route and cannot be double-submitted while saving", () => {
    expect(source).toContain('fetch("/api/ebay/defaults"');
    expect(ebaySection).toContain("disabled={ebaySavingDefaults}");
    expect(source).toContain("if (ebaySavingDefaults) return;");
  });

  it("REQUIREMENT: a save failure keeps the previous message state distinguishable from success (not silently treated as saved)", () => {
    expect(source).toContain('setEbayDefaultsMessage(body.error || "Defaults could not be saved.")');
  });
});

describe("app/settings/page.tsx — explicit live-listing safety", () => {
  const ebaySection = source.slice(source.indexOf("<h2>eBay UK</h2>"), source.indexOf("<h2>Private email index</h2>"));

  it("visibly states that publication is never automatic and requires final confirmation", () => {
    expect(ebaySection).toContain("Never publish automatically");
    expect(ebaySection).toContain("press the final live-listing confirmation");
    expect(ebaySection).toMatch(/type="checkbox" checked disabled/);
  });

  it("the live-listing route is separate from account settings and requires an explicit confirmation", () => {
    const route = readFileSync("app/api/listing-studio/ebay-live-listings/route.ts", "utf8");
    expect(route).toContain("z.literal(EBAY_LIVE_CONFIRMATION)");
    expect(route).toContain("requireOwner()");
  });
});

describe("app/settings/page.tsx — connection notice (OAuth callback redirect)", () => {
  it("reads the one-time ?ebay= query param and clears it from the URL immediately (no stale banner on refresh)", () => {
    expect(source).toContain('params.get("ebay")');
    expect(source).toContain('window.history.replaceState(null, "", "/settings")');
  });

  it("distinguishes every documented failure reason with its own safe message, never a single generic 'Something went wrong'", () => {
    for (const reason of ["access_denied", "state_invalid", "missing_code", "token_exchange_failed", "connection_failed", "auth_required"]) {
      expect(source).toContain(`${reason}:`);
    }
  });
});

describe("app/settings/page.tsx — regression: existing Settings functionality is untouched", () => {
  it("Appearance/Workspace/Vinted categories/Gmail accounts sections all still exist with their own original copy", () => {
    expect(source).toContain("<h2>Appearance</h2>");
    expect(source).toContain("<h2>Workspace</h2>");
    expect(source).toContain("<h2>Vinted categories</h2>");
    expect(source).toContain("<h2>Gmail accounts</h2>");
    expect(source).toContain("Choose how Purchase Tracker looks on this device.");
    expect(source).toContain("Personal workspace · Supabase database");
  });

  it("Gmail's own OAuth connect link and disconnect handler are unchanged", () => {
    expect(source).toContain('href="/api/gmail/connect"');
    expect(source).toContain("onClick={()=>disconnectGmail(account.id)}");
  });
});
