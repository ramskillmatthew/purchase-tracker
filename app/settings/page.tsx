"use client";
import { useEffect, useState } from "react";

type YahooStatus = { configured: boolean; maskedAddress: string | null; connected?: boolean; testedAt?: string; lastSuccessful?: string | null };
type GmailStatus = { configured: boolean; accounts: Array<{ id:string; emailAddress:string; status:string; connectedAt:string }> };
// eBay UK account connection (Stage 1: connect, identity, business-policy
// sync — see lib/ebay-account/client.ts's own EbayConnection type, which
// this mirrors exactly; never includes a token field, since the API route
// never selects one into its response).
type EbayConnectionStatus = "connected" | "needs_reconnect" | "disconnected";
type EbayConnection = {
  id: string; environment: string; ebayUserId: string; email: string | null; accountType: string | null;
  registrationMarketplace: string | null; accountStatus: string | null; connectionStatus: EbayConnectionStatus;
  hasRefreshToken: boolean; grantedScopes: string | null;
  lastIdentitySyncAt: string | null; lastPolicySyncAt: string | null;
  lastSyncErrorCode: string | null; lastSyncErrorMessage: string | null;
  draftOnly: boolean;
  defaultFulfillmentPolicyId: string | null; defaultReturnPolicyId: string | null; defaultPaymentPolicyId: string | null;
  defaultInventoryLocationKey: string | null;
  createdAt: string; updatedAt: string;
};
type EbayPolicy = { id: string; policyType: "FULFILLMENT" | "RETURN" | "PAYMENT"; ebayPolicyId: string; name: string; marketplaceId: string; available: boolean; lastSyncedAt: string };
// Stage 6 (eBay draft batches) — mirrors lib/ebay-account/client.ts's own
// EbayInventoryLocationRecord exactly.
type EbayInventoryLocation = { id: string; merchantLocationKey: string; name: string | null; status: string | null; addressSummary: string | null; available: boolean };
type EbayState = { connection: EbayConnection | null; policies: EbayPolicy[]; locations: EbayInventoryLocation[] };
type IndexStatus = {
  count: number; lastSyncedAt: string | null;
  currentlyIndexing: { rangeStart: string; rangeEnd: string; startedAt: string } | null;
  inProgress: { rangeStart: string; rangeEnd: string; indexedSoFar: number; lastPassAt: string } | null;
  lastFailure: { rangeStart: string; rangeEnd: string; occurredAt: string; reason: string | null } | null;
};
// Milestone 7 (Vinted category catalogue sync) — backs the admin refresh
// control below. Mirrors app/api/listing-studio/vinted-categories/status/route.ts's
// response shape exactly.
type VintedCategoryStatus = {
  sourceMarket: string; sourceEndpoint: string;
  lastAttemptedAt: string | null; lastSucceededAt: string | null;
  lastStatus: "success" | "failed" | "rejected_shrinkage" | "rejected_invalid_response" | null;
  lastError: string | null; fetchedCount: number | null; activeCount: number | null;
  // Milestone 7 follow-up (2026-08-03, verified browser snapshot import) —
  // which path produced the last successful import.
  lastSourceType: "live_endpoint" | "verified_browser_snapshot" | null;
  lastCapturedAt: string | null;
};
// A verified snapshot's own validated preview, held in state between
// "choose file" and "confirm import" — `snapshot` is the exact parsed
// JSON re-sent unchanged on confirm, so the server validates the SAME
// data twice rather than trusting the first validation's result.
type VintedSnapshotPreview = {
  fileName: string; snapshot: unknown;
  pageUrl: string; capturedAt: string; categoryCount: number; leafCount: number;
  selectableCount: number; maxDepth: number; rootIds: number[]; fingerprint: string;
};

export default function SettingsPage() {
  const today = new Date().toISOString().slice(0, 10); const ago = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  const [theme, setTheme] = useState<"light" | "dark">("light"); const [yahoo, setYahoo] = useState<YahooStatus | null>(null); const [gmail,setGmail]=useState<GmailStatus|null>(null); const [testing, setTesting] = useState(false); const [connectionError, setConnectionError] = useState("");
  const [index, setIndex] = useState<IndexStatus | null>(null); const [startDate, setStartDate] = useState(ago); const [endDate, setEndDate] = useState(today); const [syncing, setSyncing] = useState(false); const [indexMessage, setIndexMessage] = useState("");
  const [vintedStatus, setVintedStatus] = useState<VintedCategoryStatus | null>(null); const [vintedRefreshing, setVintedRefreshing] = useState(false); const [vintedResult, setVintedResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [vintedImportPreview, setVintedImportPreview] = useState<VintedSnapshotPreview | null>(null);
  const [vintedImportBusy, setVintedImportBusy] = useState(false);
  const [vintedImportError, setVintedImportError] = useState("");
  const [vintedImportResult, setVintedImportResult] = useState<{ ok: boolean; message: string } | null>(null);
  // eBay UK — `ebayNotice` reflects the one-time `?ebay=connected|error`
  // query param the OAuth callback redirects back with (see
  // app/api/ebay/callback/route.ts); cleared from the URL immediately so
  // a later page refresh never re-shows a stale banner.
  const [ebay, setEbay] = useState<EbayState | null>(null);
  const [ebaySyncing, setEbaySyncing] = useState(false);
  const [ebayDisconnecting, setEbayDisconnecting] = useState(false);
  const [ebaySavingDefaults, setEbaySavingDefaults] = useState(false);
  const [ebayDefaultsDraft, setEbayDefaultsDraft] = useState<{ fulfillment: string; returns: string; payment: string; location: string }>({ fulfillment: "", returns: "", payment: "", location: "" });
  const [ebaySyncMessage, setEbaySyncMessage] = useState("");
  const [ebayDefaultsMessage, setEbayDefaultsMessage] = useState("");
  const [ebayLocationDraft, setEbayLocationDraft] = useState({ name: "Main stock", postalCode: "" });
  const [ebayCreatingLocation, setEbayCreatingLocation] = useState(false);
  const [ebayUpdatingLocation, setEbayUpdatingLocation] = useState(false);
  const [ebayLocationMessage, setEbayLocationMessage] = useState("");
  const [ebayNotice, setEbayNotice] = useState<{ ok: boolean; reason: string | null } | null>(null);
  async function loadIndex() { const response = await fetch("/api/yahoo/index"); if (response.ok) setIndex(await response.json()); }
  async function loadVintedStatus() { const response = await fetch("/api/listing-studio/vinted-categories/status"); if (response.ok) setVintedStatus(await response.json()); }
  async function loadEbay() {
    const response = await fetch("/api/ebay/connection");
    if (!response.ok) return;
    const body = await response.json() as EbayState;
    setEbay(body);
    setEbayDefaultsDraft({
      fulfillment: body.connection?.defaultFulfillmentPolicyId || "", returns: body.connection?.defaultReturnPolicyId || "",
      payment: body.connection?.defaultPaymentPolicyId || "", location: body.connection?.defaultInventoryLocationKey || "",
    });
  }
  useEffect(() => {
    setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
    fetch("/api/yahoo/connection").then(async response => response.ok && setYahoo(await response.json()));
    fetch("/api/gmail/accounts").then(async response=>response.ok&&setGmail(await response.json()));
    loadIndex(); loadVintedStatus(); loadEbay();
    const params = new URLSearchParams(window.location.search);
    const ebayParam = params.get("ebay");
    if (ebayParam) {
      setEbayNotice({ ok: ebayParam === "connected", reason: params.get("reason") });
      window.history.replaceState(null, "", "/settings");
    }
  }, []);
  async function syncEbay() {
    if (ebaySyncing) return;
    setEbaySyncing(true); setEbaySyncMessage("");
    try {
      const response = await fetch("/api/ebay/sync", { method: "POST" });
      const body = await response.json();
      if (!response.ok) { setEbaySyncMessage(body.error || "eBay could not be synced right now. Your account remains connected."); return; }
      const addedOrUpdated = (body.policies as Array<{ type: string; status: string; count: number }>).map(p => `${p.count} ${p.type.toLowerCase()}${p.status === "failed" ? " (failed)" : ""}`).join(" · ");
      setEbaySyncMessage(`Synced: ${addedOrUpdated}.`);
      await loadEbay();
    } catch { setEbaySyncMessage("Network error — eBay could not be synced."); }
    finally { setEbaySyncing(false); }
  }
  async function disconnectEbay() {
    if (ebayDisconnecting || !window.confirm("Disconnect this eBay account? Existing Listing Studio drafts are kept — you can reconnect at any time.")) return;
    setEbayDisconnecting(true);
    try { const response = await fetch("/api/ebay/disconnect", { method: "POST" }); if (response.ok) await loadEbay(); }
    finally { setEbayDisconnecting(false); }
  }
  function changeEbayAccount() {
    if (!window.confirm("Connecting a different eBay account will replace the active connection for future draft creation. Existing local drafts are kept. Continue?")) return;
    window.location.href = "/api/ebay/connect?intent=change_account";
  }
  async function saveEbayDefaults() {
    if (ebaySavingDefaults) return;
    setEbaySavingDefaults(true); setEbayDefaultsMessage("");
    try {
      const response = await fetch("/api/ebay/defaults", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fulfillmentPolicyId: ebayDefaultsDraft.fulfillment || null, returnPolicyId: ebayDefaultsDraft.returns || null,
          paymentPolicyId: ebayDefaultsDraft.payment || null, inventoryLocationKey: ebayDefaultsDraft.location || null,
        }),
      });
      const body = await response.json();
      if (!response.ok) { setEbayDefaultsMessage(body.error || "Defaults could not be saved."); return; }
      setEbayDefaultsMessage("Defaults saved.");
      await loadEbay();
    } catch { setEbayDefaultsMessage("Network error — defaults could not be saved."); }
    finally { setEbaySavingDefaults(false); }
  }
  async function createEbayLocation() {
    if (ebayCreatingLocation || !ebayLocationDraft.postalCode.trim()) return;
    setEbayCreatingLocation(true); setEbayLocationMessage("");
    try {
      const response = await fetch("/api/ebay/inventory-location", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ebayLocationDraft) });
      const body = await response.json();
      if (!response.ok) { setEbayLocationMessage(body.error || "Could not create this location."); return; }
      await loadEbay();
      setEbayDefaultsDraft(current => ({ ...current, location: body.merchantLocationKey }));
      setEbayLocationMessage("Location created. Save defaults to use it for new listings.");
    } catch { setEbayLocationMessage("Network error — could not create this location."); }
    finally { setEbayCreatingLocation(false); }
  }
  async function updateEbayLocation() {
    const selected = ebay?.locations.find(location => location.merchantLocationKey === ebayDefaultsDraft.location);
    if (ebayUpdatingLocation || !selected || !ebayLocationDraft.postalCode.trim()) return;
    setEbayUpdatingLocation(true); setEbayLocationMessage("");
    try {
      const response = await fetch("/api/ebay/inventory-location", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ merchantLocationKey: selected.merchantLocationKey, name: selected.name || ebayLocationDraft.name, postalCode: ebayLocationDraft.postalCode }),
      });
      const body = await response.json();
      if (!response.ok) { setEbayLocationMessage(body.error || "Could not update this location."); return; }
      await loadEbay();
      setEbayLocationDraft(current => ({ ...current, postalCode: "" }));
      setEbayLocationMessage("Location postcode updated and synced from eBay.");
    } catch { setEbayLocationMessage("Network error — could not update this location."); }
    finally { setEbayUpdatingLocation(false); }
  }
  async function refreshVintedCategories() {
    if (vintedRefreshing) return;
    setVintedRefreshing(true); setVintedResult(null);
    const response = await fetch("/api/listing-studio/vinted-categories/refresh", { method: "POST" });
    const body = await response.json();
    setVintedResult(response.ok
      ? { ok: true, message: `Refreshed: ${body.activeCount} active categories (${body.createdCount} new, ${body.updatedCount} updated, ${body.deactivatedCount} deactivated).` }
      : { ok: false, message: body.error || "Refresh failed." });
    await loadVintedStatus();
    setVintedRefreshing(false);
  }
  // Milestone 7 follow-up (2026-08-03) — the "Import verified browser
  // snapshot" workflow. Choosing a file only ever previews it (a
  // server-side validate-only call, confirm:false — no database write);
  // the exact same parsed JSON is re-sent unchanged on explicit confirm,
  // so the import is validated twice, never trusted from the preview
  // alone. Deliberately distinct from "Refresh from Vinted" above, which
  // never touches a locally chosen file at all.
  async function handleVintedSnapshotSelected(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ""; // lets the same file be re-selected later (e.g. after fixing it)
    if (!file) return;
    setVintedImportError(""); setVintedImportResult(null); setVintedImportPreview(null); setVintedImportBusy(true);
    try {
      const text = await file.text();
      let snapshot: unknown;
      try { snapshot = JSON.parse(text); } catch { setVintedImportError("That file is not valid JSON."); return; }
      const response = await fetch("/api/listing-studio/vinted-categories/import", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ snapshot, confirm: false }),
      });
      const body = await response.json();
      if (!response.ok) { setVintedImportError(body.error || "This snapshot could not be validated."); return; }
      setVintedImportPreview({
        fileName: file.name, snapshot,
        pageUrl: body.pageUrl, capturedAt: body.capturedAt, categoryCount: body.categoryCount,
        leafCount: body.leafCount, selectableCount: body.selectableCount, maxDepth: body.maxDepth,
        rootIds: body.rootIds, fingerprint: body.fingerprint,
      });
    } catch {
      setVintedImportError("Network error — could not validate this snapshot.");
    } finally {
      setVintedImportBusy(false);
    }
  }
  async function confirmVintedSnapshotImport() {
    if (!vintedImportPreview || vintedImportBusy) return;
    setVintedImportBusy(true); setVintedImportError("");
    try {
      const response = await fetch("/api/listing-studio/vinted-categories/import", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ snapshot: vintedImportPreview.snapshot, confirm: true }),
      });
      const body = await response.json();
      if (!response.ok) { setVintedImportError(body.error || "This snapshot could not be imported."); return; }
      setVintedImportResult({ ok: true, message: `Imported: ${body.activeCount} active categories (${body.createdCount} new, ${body.updatedCount} updated, ${body.deactivatedCount} deactivated).` });
      setVintedImportPreview(null);
      await loadVintedStatus();
    } catch {
      setVintedImportError("Network error — could not import this snapshot.");
    } finally {
      setVintedImportBusy(false);
    }
  }
  function cancelVintedSnapshotImport() { setVintedImportPreview(null); setVintedImportError(""); }
  async function disconnectGmail(id:string){if(!window.confirm("Disconnect this Gmail account?"))return;const response=await fetch("/api/gmail/accounts",{method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({id})});if(response.ok)setGmail(current=>current?{...current,accounts:current.accounts.filter(account=>account.id!==id)}:current);}
  function chooseTheme(next: "light" | "dark") { setTheme(next); document.documentElement.classList.toggle("dark", next === "dark"); localStorage.setItem("purchase-tracker-theme", next); window.dispatchEvent(new Event("purchase-theme-change")); }
  async function testConnection() { setTesting(true); setConnectionError(""); const response = await fetch("/api/yahoo/connection", { method: "POST" }); const body = await response.json(); if (response.ok) setYahoo(current => ({ configured: true, maskedAddress: body.maskedAddress || current?.maskedAddress || null, connected: true, testedAt: body.testedAt })); else setConnectionError(body.error || "Connection test failed."); setTesting(false); }
  function describePass(pass: { status: string; rangeStart?: string; rangeEnd?: string; indexed?: number; note?: string } | null, label: string) {
    if (!pass || pass.status === "already_covered") return "";
    if (pass.status === "completed") return `${label}: indexed ${pass.indexed} metadata records for ${pass.rangeStart} to ${pass.rangeEnd}. `;
    if (pass.status === "partial") return `${label}: ${pass.note} `;
    return "";
  }
  async function syncIndex() { setSyncing(true); setIndexMessage(""); const response = await fetch("/api/yahoo/index", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ startDate, endDate }) }); const body = await response.json(); setIndexMessage(response.ok ? (describePass(body.historical, "Historical") + describePass(body.today, "Today")).trim() || "This range is already fully indexed." : body.error || "Metadata sync failed."); if (response.ok) await loadIndex(); setSyncing(false); }
  async function clearIndex() { if (!window.confirm("Clear the private email metadata index? This does not delete anything from Yahoo and it can be rebuilt.")) return; const response = await fetch("/api/yahoo/index", { method: "DELETE" }); setIndexMessage(response.ok ? "Metadata index cleared. Yahoo Mail was not changed." : "The index could not be cleared."); if (response.ok) await loadIndex(); }
  return <section className="page-shell page-narrow"><header className="page-header"><div className="title-row"><h1>Settings</h1></div></header><div className="settings-panel">
    <div className="settings-section"><div className="settings-copy"><h2>Appearance</h2><p>Choose how Purchase Tracker looks on this device.</p></div><div className="theme-options"><button type="button" className={theme === "light" ? "theme-option theme-option-active" : "theme-option"} onClick={() => chooseTheme("light")}><span className="theme-preview theme-preview-light"><i /><i /></span><strong>Light</strong></button><button type="button" className={theme === "dark" ? "theme-option theme-option-active" : "theme-option"} onClick={() => chooseTheme("dark")}><span className="theme-preview theme-preview-dark"><i /><i /></span><strong>Dark</strong></button></div></div>
    <div className="settings-row"><div><h2>Workspace</h2><p>Personal workspace · Supabase database</p></div><span className="status-badge"><i />Protected</span></div>
    <div className="settings-section yahoo-settings"><div className="settings-copy"><h2>Yahoo Mail</h2><p>Read-only IMAP access is configured only through server environment variables.</p><ol><li>Enable Yahoo two-step verification.</li><li>Create a Yahoo app password.</li><li>Set YAHOO_EMAIL and YAHOO_APP_PASSWORD locally and in Vercel.</li></ol></div><div className="yahoo-status"><span className={yahoo?.configured ? "status-badge" : "status-badge status-off"}><i />{yahoo?.configured ? "Configured" : "Not configured"}</span><strong>{yahoo?.maskedAddress || "No address configured"}</strong>{yahoo?.connected && <small>Connected · tested {yahoo.testedAt ? new Date(yahoo.testedAt).toLocaleString() : "just now"}</small>}{!yahoo?.connected && yahoo?.lastSuccessful && <small>Last successful connection or sync: {new Date(yahoo.lastSuccessful).toLocaleString()}</small>}{connectionError && <small className="purchase-form-error">{connectionError}</small>}<button className="button-secondary" disabled={testing || !yahoo?.configured} onClick={testConnection}>{testing ? "Testing…" : "Test connection"}</button></div></div>
    <div className="settings-section yahoo-settings">
      <div className="settings-copy">
        <h2>eBay UK</h2>
        <p>Connect your eBay selling account to review and publish listings from Listing Studio.</p>
        <p>Secure OAuth connection through eBay.</p>
        <p>Nothing is published automatically — every live listing requires a final review and confirmation.</p>
        {ebayNotice && !ebayNotice.ok && (
          <p className="purchase-form-error">
            {{
              access_denied: "eBay access was not granted.", state_invalid: "This eBay connection link is invalid, expired, or was already used. Try connecting again.",
              missing_code: "eBay did not return an authorization code.", token_exchange_failed: "eBay rejected the connection request. Check the configured eBay credentials and try again.",
              connection_failed: "eBay is temporarily unavailable. Try connecting again shortly.", auth_required: "Sign in and try connecting again.",
            }[ebayNotice.reason || ""] || "The eBay connection could not be completed."}
          </p>
        )}
        {ebayNotice?.ok && <p className="ebay-account-connected-notice">eBay account connected.</p>}
      </div>

      {(!ebay?.connection || ebay.connection.connectionStatus === "disconnected") && <div className="yahoo-status">
        <span className="status-badge status-off"><i />Not connected</span>
        <a className="button-secondary" href="/api/ebay/connect">Connect eBay account</a>
        <div className="ebay-account-capability-summary">
          <span>Seller account — Connect to enable</span>
          <span>Business policies — Connect to enable</span>
          <span>Photo upload — Connect to enable</span>
          <span>Draft creation — Connect to enable</span>
        </div>
      </div>}

      {ebay?.connection && ebay.connection.connectionStatus !== "disconnected" && (() => {
        const connection = ebay.connection;
        const needsReconnect = connection.connectionStatus === "needs_reconnect";
        const policiesByType = (type: EbayPolicy["policyType"]) => ebay.policies.filter(p => p.policyType === type);
        const availablePolicies = (type: EbayPolicy["policyType"]) => policiesByType(type).filter(p => p.available);
        const defaultNeedsAttention = (type: EbayPolicy["policyType"], selected: string) => Boolean(selected) && !availablePolicies(type).some(p => p.ebayPolicyId === selected);
        const fulfillmentCount = policiesByType("FULFILLMENT").filter(p => p.available).length;
        const returnCount = policiesByType("RETURN").filter(p => p.available).length;
        const paymentCount = policiesByType("PAYMENT").filter(p => p.available).length;
        // Stage 6 — evidence-based readiness (never a hardcoded "Needs
        // attention"). Photo upload never performs a real product upload
        // just to render Settings — "Ready" here means the server-side
        // integration and permissions genuinely exist: a usable, connected
        // account with a real refresh token (proving sell.inventory was
        // actually granted at connect time). Draft creation additionally
        // needs business policies synced AND a usable inventory location
        // (a default chosen here, or at least one synced location an
        // owner can choose per-listing in Listings Review) — missing email
        // never affects either.
        const availableLocations = ebay.locations.filter(l => l.available);
        const hasUsableLocation = Boolean(ebayDefaultsDraft.location) || availableLocations.length > 0;
        const photoUploadReady = !needsReconnect && connection.hasRefreshToken;
        const draftCreationReady = !needsReconnect && connection.hasRefreshToken && Boolean(connection.lastPolicySyncAt) && hasUsableLocation;
        return <>
          <div className="yahoo-status">
            <span className={needsReconnect ? "status-badge status-off" : "status-badge"}><i />{needsReconnect ? "Needs reconnect" : "Connected"}</span>
            <strong>{connection.email || "Email not supplied by eBay"}</strong>
            {/* Stage 6 correction — the exact required copy, with no
                suggestion to reconnect for an unavailable identity
                permission (commerce.identity.email.readonly isn't
                available on this keyset at all — see
                lib/ebay-account/oauth.ts's own scope comment — so
                reconnecting can never fix this). */}
            {!connection.email && <small>eBay did not supply an email address for this account. This does not affect listing drafts.</small>}
            <small>{connection.accountType === "BUSINESS" ? "Business seller" : connection.accountType === "INDIVIDUAL" ? "Individual seller" : "Account type not supplied"} · {connection.registrationMarketplace === "EBAY_GB" ? "United Kingdom" : connection.registrationMarketplace || "Marketplace not supplied"}</small>
            <small>{connection.lastIdentitySyncAt ? `Last account sync: ${new Date(connection.lastIdentitySyncAt).toLocaleString()}` : "Not yet synced"}</small>
            <small>{connection.lastPolicySyncAt ? `Last policy sync: ${new Date(connection.lastPolicySyncAt).toLocaleString()}` : "Policies not yet synced"}</small>
            {connection.lastSyncErrorMessage && <small className="purchase-form-error">{connection.lastSyncErrorMessage}</small>}
            {needsReconnect && <small className="purchase-form-error">Your eBay permission has expired. Reconnect the account to continue.</small>}
            {ebaySyncMessage && <small>{ebaySyncMessage}</small>}
            <div className="settings-section-actions">
              <button type="button" className="button-secondary" disabled={ebaySyncing} onClick={syncEbay}>{ebaySyncing ? "Syncing…" : "Sync account"}</button>
              <button type="button" className="button-secondary" onClick={changeEbayAccount}>Change account</button>
              <button type="button" className="button-danger" disabled={ebayDisconnecting} onClick={disconnectEbay}>{ebayDisconnecting ? "Disconnecting…" : "Disconnect"}</button>
            </div>
            <div className="ebay-account-capability-summary">
              <span>Seller account — {needsReconnect ? "Not authorised" : "Ready"}</span>
              <span>Business policies — {needsReconnect ? "Not authorised" : connection.lastPolicySyncAt ? "Ready" : connection.lastSyncErrorMessage ? "Needs attention" : "Not yet synced"}</span>
              <span>Photo upload — {photoUploadReady ? "Ready" : "Needs attention"}</span>
              <span>Live listing — {draftCreationReady ? "Ready" : "Needs attention"}</span>
            </div>
          </div>

          <div className="ebay-account-defaults">
            <h3>eBay listing defaults</h3>
            <div className="ebay-account-policy-fields">
              <label className="field">
                <span>Default postage policy</span>
                <select className="input" value={ebayDefaultsDraft.fulfillment} onChange={event => setEbayDefaultsDraft(current => ({ ...current, fulfillment: event.target.value }))}>
                  <option value="">Not set</option>
                  {availablePolicies("FULFILLMENT").map(p => <option key={p.ebayPolicyId} value={p.ebayPolicyId}>{p.name}</option>)}
                </select>
                {defaultNeedsAttention("FULFILLMENT", ebayDefaultsDraft.fulfillment) && <small className="purchase-form-error">Default policy needs attention — it is no longer available. Choose another.</small>}
              </label>
              <label className="field">
                <span>Default return policy</span>
                <select className="input" value={ebayDefaultsDraft.returns} onChange={event => setEbayDefaultsDraft(current => ({ ...current, returns: event.target.value }))}>
                  <option value="">Not set</option>
                  {availablePolicies("RETURN").map(p => <option key={p.ebayPolicyId} value={p.ebayPolicyId}>{p.name}</option>)}
                </select>
                {defaultNeedsAttention("RETURN", ebayDefaultsDraft.returns) && <small className="purchase-form-error">Default policy needs attention — it is no longer available. Choose another.</small>}
              </label>
              <label className="field">
                <span>Default payment policy</span>
                <select className="input" value={ebayDefaultsDraft.payment} onChange={event => setEbayDefaultsDraft(current => ({ ...current, payment: event.target.value }))}>
                  <option value="">Not set</option>
                  {availablePolicies("PAYMENT").map(p => <option key={p.ebayPolicyId} value={p.ebayPolicyId}>{p.name}</option>)}
                </select>
                {defaultNeedsAttention("PAYMENT", ebayDefaultsDraft.payment) && <small className="purchase-form-error">Default policy needs attention — it is no longer available. Choose another.</small>}
              </label>
              <label className="field">
                <span>Default inventory location</span>
                <select className="input" value={ebayDefaultsDraft.location} onChange={event => setEbayDefaultsDraft(current => ({ ...current, location: event.target.value }))}>
                  <option value="">No default — choose in Listings Review</option>
                  {availableLocations.map(l => <option key={l.merchantLocationKey} value={l.merchantLocationKey}>{l.name || l.merchantLocationKey}{l.addressSummary ? ` — ${l.addressSummary}` : ""}</option>)}
                </select>
                {availableLocations.length === 0 && <small>No inventory locations found on this account yet — sync again after adding one on eBay, or choose one per-listing later.</small>}
              </label>
            </div>
            {availableLocations.length === 0 && <div className="ebay-location-create">
              <strong>Create your first eBay stock location</strong>
              <label className="field"><span>Location name</span><input className="input" value={ebayLocationDraft.name} onChange={event => setEbayLocationDraft(current => ({ ...current, name: event.target.value }))} /></label>
              <label className="field"><span>UK postcode</span><input className="input" value={ebayLocationDraft.postalCode} onChange={event => setEbayLocationDraft(current => ({ ...current, postalCode: event.target.value.toUpperCase() }))} placeholder="e.g. SW1A 1AA" /></label>
              {ebayLocationMessage && <small>{ebayLocationMessage}</small>}
              <button type="button" className="button-secondary" disabled={ebayCreatingLocation || !ebayLocationDraft.postalCode.trim()} onClick={createEbayLocation}>{ebayCreatingLocation ? "Creating…" : "Create eBay location"}</button>
            </div>}
            {availableLocations.length > 0 && ebayDefaultsDraft.location && <div className="ebay-location-create">
              <strong>Update selected location postcode</strong>
              <small>Enter the complete postcode for {availableLocations.find(location => location.merchantLocationKey === ebayDefaultsDraft.location)?.name || "this location"}. eBay will reject a district-only value such as HG5.</small>
              <label className="field"><span>Full UK postcode</span><input className="input" value={ebayLocationDraft.postalCode} onChange={event => setEbayLocationDraft(current => ({ ...current, postalCode: event.target.value.toUpperCase() }))} placeholder="e.g. HG5 8XX" /></label>
              {ebayLocationMessage && <small>{ebayLocationMessage}</small>}
              <button type="button" className="button-secondary" disabled={ebayUpdatingLocation || !ebayLocationDraft.postalCode.trim()} onClick={updateEbayLocation}>{ebayUpdatingLocation ? "Updating…" : "Update eBay location"}</button>
            </div>}
            <p className="ebay-account-policy-summary">{fulfillmentCount} postage polic{fulfillmentCount === 1 ? "y" : "ies"} · {returnCount} return polic{returnCount === 1 ? "y" : "ies"} · {paymentCount} payment polic{paymentCount === 1 ? "y" : "ies"} · {availableLocations.length} inventory location{availableLocations.length === 1 ? "" : "s"} · Synced from eBay</p>
            <div className="ebay-account-draft-only">
              <label className="ebay-account-draft-only-toggle">
                <input type="checkbox" checked disabled aria-describedby="ebay-account-draft-only-note" />
                <span>Never publish automatically</span>
              </label>
              <small id="ebay-account-draft-only-note">A listing can only go live after you select it, review its eBay details, and press the final live-listing confirmation.</small>
            </div>
            {ebayDefaultsMessage && <small className={ebayDefaultsMessage === "Defaults saved." ? undefined : "purchase-form-error"}>{ebayDefaultsMessage}</small>}
            <button type="button" className="button" disabled={ebaySavingDefaults} onClick={saveEbayDefaults}>{ebaySavingDefaults ? "Saving…" : "Save defaults"}</button>
          </div>
        </>;
      })()}
    </div>
    <div className="settings-section yahoo-settings"><div className="settings-copy"><h2>Private email index</h2><p>Stores only sender, subject, date, email type and extracted order fields in your protected Supabase workspace. Bodies, HTML, attachments and Yahoo credentials stay out of the index.</p><p>An automatic sync runs once a day and keeps the index up to date on its own. Use &quot;Sync now&quot; for an immediate update or to backfill an older date range.</p><p>{index?.count || 0} metadata records indexed{index?.lastSyncedAt ? ` · last successful sync ${new Date(index.lastSyncedAt).toLocaleString()}` : ""}.</p>{index?.currentlyIndexing && <p className="status-badge"><i />Currently indexing {index.currentlyIndexing.rangeStart} to {index.currentlyIndexing.rangeEnd} (started {new Date(index.currentlyIndexing.startedAt).toLocaleString()})</p>}{index?.inProgress && <p className="status-badge"><i />In progress: {index.inProgress.rangeStart} to {index.inProgress.rangeEnd} — {index.inProgress.indexedSoFar} indexed so far, last pass {new Date(index.inProgress.lastPassAt).toLocaleString()}. Continues automatically.</p>}{index?.lastFailure && <p className="purchase-form-error">Last failed sync: {index.lastFailure.rangeStart} to {index.lastFailure.rangeEnd} at {new Date(index.lastFailure.occurredAt).toLocaleString()} — {index.lastFailure.reason || "Unknown reason."}</p>}</div><div className="index-controls"><label>From<input type="date" value={startDate} max={endDate} onChange={event => setStartDate(event.target.value)} /></label><label>To<input type="date" value={endDate} min={startDate} max={today} onChange={event => setEndDate(event.target.value)} /></label>{indexMessage && <small>{indexMessage}</small>}<button className="button-secondary" disabled={syncing || !yahoo?.configured} onClick={syncIndex}>{syncing ? "Syncing…" : "Sync now"}</button><button className="button-danger" disabled={syncing || !index?.count} onClick={clearIndex}>Clear index</button></div></div>
    <div className="settings-section yahoo-settings">
      <div className="settings-copy">
        <h2>Vinted categories</h2>
        <p>
          {vintedStatus?.lastSourceType === "verified_browser_snapshot"
            ? `Current source: verified browser snapshot${vintedStatus.lastCapturedAt ? ` (captured ${new Date(vintedStatus.lastCapturedAt).toLocaleDateString()})` : ""}.`
            : vintedStatus?.lastSourceType === "live_endpoint"
              ? "Current source: Vinted UK (live refresh)."
              : "Current source: not yet synced."}
          {" "}Neither path ever refreshes automatically when this page loads.
        </p>
      </div>
      <div className="yahoo-status">
        <span className={vintedStatus?.lastSucceededAt ? "status-badge" : "status-badge status-off"}><i />{vintedStatus?.lastSucceededAt ? "Synced" : "Never synced"}</span>
        <strong>{vintedStatus?.activeCount ?? 0} active categories</strong>
        {vintedStatus?.lastSucceededAt ? <small>Last successful sync: {new Date(vintedStatus.lastSucceededAt).toLocaleString()}</small> : <small>No successful sync yet.</small>}
        {vintedStatus?.lastStatus && vintedStatus.lastStatus !== "success" && vintedStatus.lastError && <small className="purchase-form-error">Last attempt failed: {vintedStatus.lastError}</small>}
        {vintedResult && <small className={vintedResult.ok ? undefined : "purchase-form-error"}>{vintedResult.message}</small>}
        <button className="button-secondary" disabled={vintedRefreshing} onClick={refreshVintedCategories}>{vintedRefreshing ? "Refreshing…" : "Refresh from Vinted"}</button>
      </div>

      <div className="yahoo-status vinted-snapshot-import">
        <strong>Import verified browser snapshot</strong>
        <small>Use this when &quot;Refresh from Vinted&quot; fails (Vinted currently blocks unauthenticated requests to its live category endpoint). Export a snapshot from Vinted UK&apos;s signed-in Create Listing page, then choose the file below.</small>
        <label className="button-secondary vinted-snapshot-file-label">
          {vintedImportBusy && !vintedImportPreview ? "Validating…" : "Choose snapshot file…"}
          <input type="file" accept="application/json" onChange={handleVintedSnapshotSelected} disabled={vintedImportBusy} hidden />
        </label>
        {vintedImportError && <small className="purchase-form-error">{vintedImportError}</small>}
        {vintedImportResult && <small className={vintedImportResult.ok ? undefined : "purchase-form-error"}>{vintedImportResult.message}</small>}

        {vintedImportPreview && <div className="vinted-snapshot-preview">
          <p><strong>{vintedImportPreview.fileName}</strong> — captured {new Date(vintedImportPreview.capturedAt).toLocaleString()}</p>
          <p>{vintedImportPreview.categoryCount} categories · {vintedImportPreview.selectableCount} selectable · {vintedImportPreview.leafCount} leaves · max depth {vintedImportPreview.maxDepth}</p>
          <p>Roots: {vintedImportPreview.rootIds.join(", ")}</p>
          <p className="vinted-snapshot-fingerprint">Fingerprint: {vintedImportPreview.fingerprint}</p>
          <div className="vinted-snapshot-preview-actions">
            <button type="button" className="button-secondary" disabled={vintedImportBusy} onClick={cancelVintedSnapshotImport}>Cancel</button>
            <button type="button" className="button" disabled={vintedImportBusy} onClick={confirmVintedSnapshotImport}>{vintedImportBusy ? "Importing…" : "Confirm import"}</button>
          </div>
        </div>}
      </div>
    </div>
    <div className="settings-section yahoo-settings"><div className="settings-copy"><h2>Gmail accounts</h2><p>Connect Gmail with read-only OAuth. Connected accounts are searched alongside Yahoo by Email Assistant and Purchase Import.</p><p>Refresh tokens are encrypted server-side.</p></div><div className="yahoo-status">{gmail?.accounts.map(account=><div key={account.id}><span className="status-badge"><i />Connected</span><strong>{account.emailAddress}</strong><button className="button-danger" onClick={()=>disconnectGmail(account.id)}>Disconnect</button></div>)}{!gmail?.accounts.length&&<span className="status-badge status-off"><i />Not connected</span>}<a className="button-secondary" href="/api/gmail/connect">Connect Gmail</a>{gmail&&!gmail.configured&&<small className="purchase-form-error">Google OAuth environment variables are not configured.</small>}</div></div>
  </div></section>;
}
