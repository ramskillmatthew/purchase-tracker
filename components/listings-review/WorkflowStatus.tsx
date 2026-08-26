"use client";

import { type CSSProperties } from "react";

/**
 * The ONE place a workflow/readiness status is ever rendered — used
 * identically by the table, the mobile card list, and the selected-listing
 * inspector, so a listing can never show a different status treatment in
 * two places at once. A bare circular dot (never a square/pill/badge
 * backplate) plus adjacent text — colour is never the only signal — with
 * an optional truthful secondary line underneath (see
 * lib/listing-studio/extension-workflow-status.ts's computeWorkflowSecondaryLine,
 * the single source for what that line says). The halo pulses only for the
 * one item genuinely "in_progress" right now, and is skipped entirely
 * under prefers-reduced-motion (app/globals.css).
 */
export function WorkflowStatus({ label, tone, pulse, secondaryLine }: {
  label: string;
  tone: string;
  pulse: boolean;
  secondaryLine?: string | null;
}) {
  return <span className="lr-workflow-status">
    <span className="lr-workflow-status-row">
      <i aria-hidden="true" className={`lr-workflow-dot${pulse ? " lr-workflow-dot-pulse" : ""}`} style={{ "--tone": tone } as CSSProperties} />
      <span className="lr-workflow-label">{label}</span>
    </span>
    {secondaryLine && <span className="lr-workflow-secondary">{secondaryLine}</span>}
  </span>;
}
