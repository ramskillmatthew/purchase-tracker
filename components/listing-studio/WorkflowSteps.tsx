"use client";

// Purely informational — no step is a link or button, so an unfinished
// stage (Generate drafts / Review) can never be clicked as if it worked
// (UX refinement spec §2: "Do not make unfinished steps clickable" / "Do
// not make the interface imply that AI generation currently works").
const STEPS: { label: string; available: boolean }[] = [
  { label: "Upload photos", available: true },
  { label: "Group products", available: true },
  { label: "Generate drafts", available: false },
  { label: "Review", available: false },
];

export default function WorkflowSteps() {
  return <ol className="listing-workflow-steps" aria-label="Listing Studio workflow">
    {STEPS.map((step, index) => <li key={step.label} className={`listing-workflow-step${step.available ? "" : " listing-workflow-step-upcoming"}`}>
      <span className="listing-workflow-step-index" aria-hidden="true">{index + 1}</span>
      <span className="listing-workflow-step-label">{step.label}</span>
      {!step.available && <span className="listing-workflow-step-badge">Coming next</span>}
      {index < STEPS.length - 1 && <span className="listing-workflow-step-arrow" aria-hidden="true">→</span>}
    </li>)}
  </ol>;
}
