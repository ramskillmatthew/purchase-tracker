"use client";

import { useState } from "react";
import { parseSellingPricePounds } from "@/lib/listing-studio/selling-price";

type SaveStatus = "idle" | "saving" | "saved" | "error";

/**
 * Stage 6 (eBay draft batches) — the eBay tab's own dedicated selling-price
 * control, mirroring SellingPriceField.tsx exactly (same fresh-per-mount
 * convention via `key={listing.id}` from the parent, same client-side
 * pre-validation reusing the identical parseSellingPricePounds the server
 * itself is authoritative with) but posting to
 * /api/listing-studio/groups/[draftId]/ebay-listing-settings instead —
 * saving this NEVER touches listing_drafts.confirmed_price_pence (the
 * Vinted price), and saving the Vinted price never touches this one.
 */
export default function EbaySellingPriceField({ listingId, sellingPricePence, onSaved }: {
  listingId: string;
  sellingPricePence: number | null;
  onSaved: (pence: number) => void;
}) {
  const [inputValue, setInputValue] = useState(sellingPricePence !== null ? (sellingPricePence / 100).toFixed(2) : "");
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [errorMessage, setErrorMessage] = useState("");

  function handleChange(value: string) {
    setInputValue(value);
    if (status !== "idle") setStatus("idle");
    if (errorMessage) setErrorMessage("");
  }

  async function handleSave() {
    if (status === "saving") return;
    const parsed = parseSellingPricePounds(inputValue);
    if (!parsed.valid) { setStatus("error"); setErrorMessage(parsed.error); return; }
    setStatus("saving");
    setErrorMessage("");
    try {
      const response = await fetch(`/api/listing-studio/groups/${listingId}/ebay-listing-settings`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sellingPrice: inputValue }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { setStatus("error"); setErrorMessage(body.error || "Could not save this price."); return; }
      setStatus("saved");
      setInputValue((body.sellingPricePence / 100).toFixed(2));
      onSaved(body.sellingPricePence);
    } catch {
      setStatus("error"); setErrorMessage("Network error — could not save this price.");
    }
  }

  return <div className="lr-selling-price">
    <label className="field">
      <span className="label">eBay selling price</span>
      <div className="lr-selling-price-row">
        <span className="lr-selling-price-prefix" aria-hidden="true">£</span>
        <input
          className="input" type="number" min="0.01" step="0.01" value={inputValue} disabled={status === "saving"}
          onChange={event => handleChange(event.target.value)}
          onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); handleSave(); } }}
          aria-label="eBay selling price"
        />
        <button type="button" className="button-secondary" disabled={status === "saving"} onClick={handleSave}>
          {status === "saving" ? "Saving…" : "Save"}
        </button>
      </div>
    </label>
    {status === "saved" && <p className="lr-selling-price-status lr-selling-price-saved" role="status">Saved</p>}
    {status === "error" && <p className="lr-selling-price-status lr-selling-price-error" role="alert">{errorMessage || "Save failed"}</p>}
  </div>;
}
