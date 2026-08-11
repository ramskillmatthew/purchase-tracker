"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import GroupingWorkspace from "@/components/listing-studio/GroupingWorkspace";

// Wrapped in Suspense because it reads useSearchParams (?view=create|saved),
// matching the existing pattern in app/purchases/page.tsx.
export default function ListingStudioPage() {
  return <Suspense fallback={null}><ListingStudioPageInner /></Suspense>;
}

function ListingStudioPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const view = searchParams.get("view") === "saved" ? "saved" : "create";

  function changeView(next: "create" | "saved") {
    router.push(`/listing-studio?view=${next}`);
  }

  return <section className="page-shell">
    <header className="purchase-topbar">
      <div className="title-row"><h1>Listing Studio</h1></div>
      <div className="period-switch" role="group" aria-label="Listing Studio view">
        <button type="button" className={view === "create" ? "period-active" : ""} onClick={() => changeView("create")}>Create</button>
        <button type="button" className={view === "saved" ? "period-active" : ""} onClick={() => changeView("saved")}>Saved drafts</button>
      </div>
    </header>

    {view === "create" ? <GroupingWorkspace /> : <SavedDraftsPlaceholder />}
  </section>;
}

// Milestone 2 explicitly scopes Saved Drafts management to a later
// milestone (§17: "Do not implement yet: Full Saved Drafts management") —
// this is a deliberate placeholder, not an oversight.
function SavedDraftsPlaceholder() {
  return <div className="data-panel">
    <div className="listing-saved-placeholder">
      <strong>Saved drafts is coming in a later milestone</strong>
      <span>Search, filters, and bulk actions for saved listing drafts will land once the review and Ready-validation stages are built. For now, use Create drafts to upload photos and organise them into product groups.</span>
    </div>
  </div>;
}
