"use client";

import { useState } from "react";
import { parseSellingPricePounds } from "@/lib/listing-studio/selling-price";

type SaveStatus = "idle" | "saving" | "saved" | "error";

/**
 * Milestone 6 (purchase-price lookup and manual Vinted selling price) —
 * the Listings Review details panel's own dedicated, single-field control
 * for listing_drafts.confirmed_price_pence. The parent renders this with
 * `key={listing.id}` so switching the selected listing always remounts a
 * fresh instance (matches EditListingFieldsDialog's own "fresh useState
 * per mount" convention) — this component never needs to reconcile a prop
 * change against unsaved local edits for a DIFFERENT listing.
 *
 * User-entered only — no AI suggestion of any kind. Client-side validation
 * reuses the exact same parseSellingPricePounds the save route itself
 * calls authoritatively, purely for instant feedback before a network
 * round-trip; the server never trusts this client-side pass alone.
 */
export default function SellingPriceField({ listingId, sellingPricePence, onSaved }: {
  listingId: string;
  sellingPricePence: number | null;
  onSaved: (pence: number) => void;
}) {
  const [inputValue, setInputValue] = useState(sellingPricePence !== null ? (sellingPricePence / 100).toFixed(2) : "");
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [errorMessage, setErrorMessage] = useState("");

  function handleChange(value: string) {
    setInputValue(value);
    // Editing after a save/failure clears the stale status — the visible
    // state always reflects THIS value, never a previous attempt's.
    if (status !== "idle") setStatus("idle");
    if (errorMessage) setErrorMessage("");
  }

  async function handleSave() {
    if (status === "saving") return; // prevent duplicate submissions
    const parsed = parseSellingPricePounds(inputValue);
    if (!parsed.valid) {
      setStatus("error");
      setErrorMessage(parsed.error);
      return;
    }
    setStatus("saving");
    setErrorMessage("");
    try {
      const response = await fetch(`/api/listing-studio/groups/${listingId}/selling-price`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sellingPrice: inputValue }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        // The entered value is deliberately left exactly as typed — never
        // reverted to the previous saved value on a failed save.
        setStatus("error");
        setErrorMessage(body.error || "Could not save this price.");
        return;
      }
      setStatus("saved");
      setInputValue((body.sellingPricePence / 100).toFixed(2));
      onSaved(body.sellingPricePence);
    } catch {
      setStatus("error");
      setErrorMessage("Network error — could not save this price.");
    }
  }

  return <div className="lr-selling-price">
    <label className="field">
      <span className="label">Vinted selling price</span>
      <div className="lr-selling-price-row">
        <span className="lr-selling-price-prefix" aria-hidden="true">£</span>
        <input
          className="input"
          type="number"
          min="0.01"
          step="0.01"
          value={inputValue}
          disabled={status === "saving"}
          onChange={event => handleChange(event.target.value)}
          onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); handleSave(); } }}
          aria-label="Vinted selling price"
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
