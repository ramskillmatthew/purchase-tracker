"use client";

// Purely informational — no step is a link or button, so a step can never
// be clicked as if it navigated anywhere (UX refinement spec §2: "Do not
// make unfinished steps clickable"). Visual redesign follow-up: this now
// reflects REAL workspace state (passed down from GroupingWorkspace, which
// already holds it — no separate fetch, no duplicated copy of workspace
// data) instead of two steps being permanently hardcoded as unavailable.
// AI listing generation and category assignment already ship (Milestone
// 4+), so a permanently-unavailable label for those steps would now be
// simply wrong — this file computes each step's real state instead.
export type WorkflowStepsState = {
  /** At least one photo has been uploaded anywhere in the workspace. */
  hasPhotos: boolean;
  /** The Unsorted inbox still has at least one photo waiting to be grouped. */
  needsGrouping: boolean;
  /** At least one real product group has photos but no generated listing yet. */
  hasEligibleGroups: boolean;
  /** At least one product group has a generated listing (draft.status === "ready"). */
  hasGeneratedDrafts: boolean;
};

const STEP_LABELS = ["Upload", "Group products", "Generate drafts", "Review"] as const;

/**
 * Exactly one step is ever "current" at a time — the furthest along the
 * workspace has genuinely progressed, per the four rules this component is
 * given (Upload active with no photos; Group products active while photos
 * still need grouping; Generate drafts active once ungenerated groups
 * exist; Review available once anything has actually been generated).
 * Every step before it is "complete", every step after it is "upcoming".
 */
function currentStepIndex(state: WorkflowStepsState): number {
  if (state.hasGeneratedDrafts) return 3;
  if (state.hasEligibleGroups) return 2;
  if (state.needsGrouping) return 1;
  return 0;
}

export default function WorkflowSteps(state: WorkflowStepsState) {
  const current = currentStepIndex(state);
  return <ol className="listing-workflow-steps" aria-label="Listing Studio workflow">
    {STEP_LABELS.map((label, index) => {
      const status = index < current ? "complete" : index === current ? "current" : "upcoming";
      return <li key={label} className={`listing-workflow-step listing-workflow-step-${status}`}>
        <span className="listing-workflow-step-index" aria-hidden="true">{status === "complete" ? "✓" : index + 1}</span>
        <span className="listing-workflow-step-label">{label}</span>
        {index < STEP_LABELS.length - 1 && <span className="listing-workflow-step-arrow" aria-hidden="true">→</span>}
      </li>;
    })}
  </ol>;
}
