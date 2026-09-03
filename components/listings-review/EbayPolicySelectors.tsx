"use client";

import { useState } from "react";

export type EbayPolicyOption = { policyType: "FULFILLMENT" | "RETURN" | "PAYMENT"; ebayPolicyId: string; name: string; available: boolean };
export type EbayLocationOption = { merchantLocationKey: string; name: string | null; addressSummary: string | null; available: boolean };

export type EbayPolicySelection = {
  fulfillmentPolicyId: string | null; returnPolicyId: string | null; paymentPolicyId: string | null; merchantLocationKey: string | null;
};

type FieldKey = "fulfillmentPolicyId" | "returnPolicyId" | "paymentPolicyId" | "merchantLocationKey";

/**
 * Stage 6 (eBay draft batches) — the eBay tab's own policy/location
 * selectors. Auto-saves on change (no separate Save button per field —
 * matches the reference design's own plain "Shipping policy [dropdown]"
 * layout with no adjacent button). Each field tracks its own inline
 * saving/error state independently, so one field's save failing never
 * blocks or clears another's already-saved value. A selected id that is no
 * longer present among the CURRENTLY available options for its type is
 * flagged stale and must be re-chosen — never silently kept or
 * auto-replaced with "the first option".
 */
export default function EbayPolicySelectors({ listingId, policies, locations, selection, onSaved }: {
  listingId: string;
  policies: EbayPolicyOption[];
  locations: EbayLocationOption[];
  selection: EbayPolicySelection;
  onSaved: (next: Partial<EbayPolicySelection>) => void;
}) {
  const [saving, setSaving] = useState<FieldKey | null>(null);
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});

  const availablePolicies = (type: EbayPolicyOption["policyType"]) => policies.filter(p => p.policyType === type && p.available);
  const availableLocations = locations.filter(l => l.available);
  const isStale = (type: EbayPolicyOption["policyType"], id: string | null) => Boolean(id) && !availablePolicies(type).some(p => p.ebayPolicyId === id);
  const locationIsStale = Boolean(selection.merchantLocationKey) && !availableLocations.some(l => l.merchantLocationKey === selection.merchantLocationKey);

  async function save(field: FieldKey, patchKey: string, value: string) {
    setSaving(field);
    setErrors(current => ({ ...current, [field]: undefined }));
    try {
      const response = await fetch(`/api/listing-studio/groups/${listingId}/ebay-listing-settings`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ [patchKey]: value || null }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { setErrors(current => ({ ...current, [field]: body.error || "Could not save." })); return; }
      onSaved({ [field]: value || null });
    } catch {
      setErrors(current => ({ ...current, [field]: "Network error — could not save." }));
    } finally {
      setSaving(null);
    }
  }

  return <div className="lr-ebay-policies">
    <p className="lr-ebay-policies-heading">eBay policies</p>
    <label className="field">
      <span className="label">Shipping policy</span>
      <select
        className="input" value={selection.fulfillmentPolicyId ?? ""} disabled={saving === "fulfillmentPolicyId"}
        onChange={event => save("fulfillmentPolicyId", "fulfillmentPolicyId", event.target.value)}
      >
        <option value="">Not set</option>
        {isStale("FULFILLMENT", selection.fulfillmentPolicyId) && selection.fulfillmentPolicyId && <option value={selection.fulfillmentPolicyId}>Unavailable — choose another</option>}
        {availablePolicies("FULFILLMENT").map(p => <option key={p.ebayPolicyId} value={p.ebayPolicyId}>{p.name}</option>)}
      </select>
      {isStale("FULFILLMENT", selection.fulfillmentPolicyId) && <small className="purchase-form-error">This shipping policy is no longer available — choose another.</small>}
      {errors.fulfillmentPolicyId && <small className="purchase-form-error">{errors.fulfillmentPolicyId}</small>}
    </label>
    <label className="field">
      <span className="label">Return policy</span>
      <select
        className="input" value={selection.returnPolicyId ?? ""} disabled={saving === "returnPolicyId"}
        onChange={event => save("returnPolicyId", "returnPolicyId", event.target.value)}
      >
        <option value="">Not set</option>
        {isStale("RETURN", selection.returnPolicyId) && selection.returnPolicyId && <option value={selection.returnPolicyId}>Unavailable — choose another</option>}
        {availablePolicies("RETURN").map(p => <option key={p.ebayPolicyId} value={p.ebayPolicyId}>{p.name}</option>)}
      </select>
      {isStale("RETURN", selection.returnPolicyId) && <small className="purchase-form-error">This return policy is no longer available — choose another.</small>}
      {errors.returnPolicyId && <small className="purchase-form-error">{errors.returnPolicyId}</small>}
    </label>
    <label className="field">
      <span className="label">Payment policy</span>
      <select
        className="input" value={selection.paymentPolicyId ?? ""} disabled={saving === "paymentPolicyId"}
        onChange={event => save("paymentPolicyId", "paymentPolicyId", event.target.value)}
      >
        <option value="">Not set</option>
        {isStale("PAYMENT", selection.paymentPolicyId) && selection.paymentPolicyId && <option value={selection.paymentPolicyId}>Unavailable — choose another</option>}
        {availablePolicies("PAYMENT").map(p => <option key={p.ebayPolicyId} value={p.ebayPolicyId}>{p.name}</option>)}
      </select>
      {isStale("PAYMENT", selection.paymentPolicyId) && <small className="purchase-form-error">This payment policy is no longer available — choose another.</small>}
      {errors.paymentPolicyId && <small className="purchase-form-error">{errors.paymentPolicyId}</small>}
    </label>
    <label className="field">
      <span className="label">Inventory location</span>
      <select
        className="input" value={selection.merchantLocationKey ?? ""} disabled={saving === "merchantLocationKey"}
        onChange={event => save("merchantLocationKey", "merchantLocationKey", event.target.value)}
      >
        <option value="">Not set</option>
        {locationIsStale && selection.merchantLocationKey && <option value={selection.merchantLocationKey}>Unavailable — choose another</option>}
        {availableLocations.map(l => <option key={l.merchantLocationKey} value={l.merchantLocationKey}>{l.name || l.merchantLocationKey}</option>)}
      </select>
      {availableLocations.length === 0 && !locationIsStale && <small>No inventory locations synced yet — set one in Settings once your eBay account has one.</small>}
      {locationIsStale && <small className="purchase-form-error">This location is no longer available — choose another.</small>}
      {errors.merchantLocationKey && <small className="purchase-form-error">{errors.merchantLocationKey}</small>}
    </label>
  </div>;
}
