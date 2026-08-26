"use client";

import { useEffect, useState } from "react";
import {
  contentModes, contentModeLabels, listingFormats, packageSizes, packageSizeLabels,
  automationModes, automationModeLabels, type MarketplaceDraftSettings,
} from "@/lib/listing-studio/marketplace-types";
import { FALLBACK_MARKETPLACE_DRAFT_SETTINGS } from "@/lib/listing-studio/marketplace-settings";

/**
 * Stage 3 — eBay draft settings, shown when eBay UK or Both is selected in
 * MarketplaceSelector. Edits the ACCOUNT-level defaults (lowest priority of
 * the 3-level settings hierarchy — see lib/listing-studio/
 * marketplace-settings.ts) via GET/PATCH /api/listing-studio/
 * marketplace-settings?marketplace=EBAY_UK; the next "Generate listings"
 * run picks these up automatically (see the generate route's own
 * getMarketplaceSettingsDefaults call). A per-draft override (editable
 * later, once a draft exists) always wins over whatever is saved here.
 *
 * Postage/return/payment profiles are deliberately plain text LABELS, never
 * a dropdown of real eBay policies — eBay account-policy retrieval requires
 * OAuth, which is a later milestone (see this component's own caption
 * text). Payment profile has no input at all yet: unlike postage/returns,
 * there is nothing honest to let the owner type today (eBay's own payment
 * setup is account-wide, not something a local label can usefully stand in
 * for) — the database column exists so this can be added later without a
 * schema change.
 */
export function EbayDraftSettingsPanel() {
  const [settings, setSettings] = useState<MarketplaceDraftSettings>(FALLBACK_MARKETPLACE_DRAFT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "failed">("idle");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/listing-studio/marketplace-settings?marketplace=EBAY_UK");
        if (!response.ok) return;
        const body = await response.json();
        if (!cancelled) setSettings({ ...FALLBACK_MARKETPLACE_DRAFT_SETTINGS, ...body.settings });
      } finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  async function save(patch: Partial<MarketplaceDraftSettings>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    setSaveState("saving");
    try {
      const response = await fetch("/api/listing-studio/marketplace-settings", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marketplace: "EBAY_UK", settings: patch }),
      });
      setSaveState(response.ok ? "saved" : "failed");
    } catch { setSaveState("failed"); }
  }

  if (loading) return null;

  return (
    <div className="ebay-settings-panel data-panel">
      <h3 className="ebay-settings-title">eBay UK draft settings</h3>
      <p className="ebay-settings-caption">Applies to eBay drafts you generate next. A specific draft&apos;s own edits always take priority over these defaults.</p>

      <div className="field">
        <span className="label">Content</span>
        <div className="period-switch" role="group" aria-label="Content mode">
          {contentModes.map(mode => (
            <button key={mode} type="button" className={settings.contentMode === mode ? "period-active" : ""} onClick={() => save({ contentMode: mode })}>
              {contentModeLabels[mode]}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <span className="label">Listing format</span>
        <div className="period-switch" role="group" aria-label="Listing format">
          {listingFormats.map(format => (
            <button key={format} type="button" className={settings.listingFormat === format ? "period-active" : ""} onClick={() => save({ listingFormat: format })}>
              Buy It Now
            </button>
          ))}
        </div>
      </div>

      <label className="field">
        <span className="label">Default quantity</span>
        <input
          className="input" type="number" min={1} max={1000} value={settings.quantity}
          onChange={event => { const value = Number(event.target.value); if (Number.isInteger(value) && value > 0) save({ quantity: value }); }}
        />
      </label>

      <label className="ebay-settings-checkbox">
        <input type="checkbox" checked={settings.allowOffers} onChange={event => save({ allowOffers: event.target.checked })} />
        <span>Allow offers</span>
      </label>

      <label className="field">
        <span className="label">Postage profile (label only — not yet connected to your eBay account)</span>
        <input
          className="input" type="text" placeholder="e.g. Royal Mail Tracked 48" value={settings.postageProfileLabel ?? ""}
          onBlur={event => save({ postageProfileLabel: event.target.value.trim() || null })}
          onChange={event => setSettings(current => ({ ...current, postageProfileLabel: event.target.value }))}
        />
      </label>

      <label className="field">
        <span className="label">Return profile (label only — not yet connected to your eBay account)</span>
        <input
          className="input" type="text" placeholder="e.g. 30-day returns" value={settings.returnProfileLabel ?? ""}
          onBlur={event => save({ returnProfileLabel: event.target.value.trim() || null })}
          onChange={event => setSettings(current => ({ ...current, returnProfileLabel: event.target.value }))}
        />
      </label>

      <label className="field">
        <span className="label">Package size</span>
        <select className="input" value={settings.packageSize ?? ""} onChange={event => save({ packageSize: (event.target.value || null) as MarketplaceDraftSettings["packageSize"] })}>
          <option value="">Not set</option>
          {packageSizes.map(size => <option key={size} value={size}>{packageSizeLabels[size]}</option>)}
        </select>
      </label>

      <div className="field">
        <span className="label">Automation</span>
        <div className="period-switch" role="group" aria-label="Automation mode">
          {automationModes.map(mode => (
            <button key={mode} type="button" className={settings.automationMode === mode ? "period-active" : ""} onClick={() => save({ automationMode: mode })}>
              {automationModeLabels[mode]}
            </button>
          ))}
        </div>
      </div>

      <div className="ebay-settings-save-state" role="status">
        {saveState === "saving" && "Saving…"}
        {saveState === "saved" && "Saved"}
        {saveState === "failed" && "Could not save — try again."}
      </div>
    </div>
  );
}
