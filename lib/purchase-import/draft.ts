// Pure review-form defaulting logic, shared by the review UI
// (app/vinted-import/page.tsx) — pulled out into its own module so it can be
// unit-tested directly, without importing a "use client" React component
// into vitest.

export type Edit = {
  selected: boolean; purchased_from: string; sku: string; item_description: string; seller_name: string;
  item_size: string; item_condition: string; price_purchased: string; order_date: string; arrived: "" | "true" | "false";
};
export type Draft = Omit<Edit, "selected">;

export type DraftSourceCandidate = {
  purchased_from: string | null; candidate_type: "vinted" | "general";
  item_title: string | null; seller_name: string | null; item_size: string | null;
  item_condition_hint: string | null; price_paid: number | null; purchase_date: string | null; email_date: string;
  draft: Draft | null;
};

// Arrived defaults to No rather than forcing an explicit choice. A saved
// draft (persisted server-side — see app/api/vinted/candidates/route.ts's
// save_draft action) takes priority over those computed defaults, so edits
// survive a page reload — but never overrides edits already live in the
// caller's own in-memory state (`old`), so a re-sync's refreshed candidate
// list can't stomp on what's being typed right now.
export function draftFor(x: DraftSourceCandidate, old?: Edit): Edit {
  if (old) return old;
  const d = x.draft;
  return {
    selected: false,
    purchased_from: d?.purchased_from ?? (x.purchased_from || (x.candidate_type === "vinted" ? "Vinted" : "")),
    sku: d?.sku ?? "",
    item_description: d?.item_description ?? (x.item_title || ""),
    seller_name: d?.seller_name ?? (x.candidate_type === "vinted" ? (x.seller_name || "") : ""),
    item_size: d?.item_size ?? (x.item_size || (x.candidate_type === "general" ? "N/A" : "")),
    item_condition: d?.item_condition ?? (x.item_condition_hint || (x.candidate_type === "general" ? "Brand new" : "")),
    price_purchased: d?.price_purchased ?? (x.price_paid == null ? "" : String(x.price_paid)),
    order_date: d?.order_date ?? (x.purchase_date || x.email_date.slice(0, 10)),
    arrived: d?.arrived ?? "false",
  };
}
