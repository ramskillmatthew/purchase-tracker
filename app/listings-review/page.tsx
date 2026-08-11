import ListingsReviewWorkspace from "@/components/listings-review/ListingsReviewWorkspace";

// Milestone 5 — the primary place generated listings are reviewed before
// exporting/auto-listing (both still future work). Listing Studio remains
// the place products are created and organised into groups; this page is
// purely for reviewing what's already been generated there.
// Operations-console redesign — the heading now renders inside
// ListingsReviewWorkspace itself, alongside the real KPI cards (which need
// client-fetched data this server component doesn't have), so both sit in
// one row exactly like the approved reference. See that component's own
// header markup.
export default function ListingsReviewPage() {
  return <section className="page-shell listings-review-page">
    <ListingsReviewWorkspace />
  </section>;
}
