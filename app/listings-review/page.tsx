import ListingsReviewWorkspace from "@/components/listings-review/ListingsReviewWorkspace";

// Milestone 5 — the primary place generated listings are reviewed before
// exporting/auto-listing (both still future work). Listing Studio remains
// the place products are created and organised into groups; this page is
// purely for reviewing what's already been generated there.
export default function ListingsReviewPage() {
  return <section className="page-shell listings-review-page">
    <header className="purchase-topbar">
      <div className="title-row"><h1>Listings Review</h1></div>
    </header>
    <ListingsReviewWorkspace />
  </section>;
}
