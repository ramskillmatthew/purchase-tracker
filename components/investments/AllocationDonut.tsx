"use client";

import { useState } from "react";

export type AllocationSlice = { category: string; label: string; gbpValue: number; percent: number; color: string };

const SIZE = 170;
const STROKE = 20;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * A small, dependency-free donut — four categories at most in this
 * version's initial set, so a hand-built SVG (stroke-dasharray per slice
 * around a circle) is simpler and lighter than pulling in a charting
 * library for one small chart.
 */
export default function AllocationDonut({ slices }: { slices: AllocationSlice[] }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const total = slices.reduce((sum, s) => sum + s.percent, 0);

  const { segments } = slices.reduce<{ segments: Array<AllocationSlice & { index: number; dashArray: string; dashOffset: number }>; cumulativeLength: number }>(
    (acc, slice, index) => {
      const length = (slice.percent / 100) * CIRCUMFERENCE;
      return {
        segments: [...acc.segments, { ...slice, index, dashArray: `${length} ${CIRCUMFERENCE - length}`, dashOffset: -acc.cumulativeLength }],
        cumulativeLength: acc.cumulativeLength + length,
      };
    },
    { segments: [], cumulativeLength: 0 },
  );

  const centerLabel = hoverIndex !== null ? slices[hoverIndex] : null;

  if (slices.length === 0 || total === 0) {
    return <div className="inv-donut-row">
      <div className="inv-donut-wrap" style={{ width: SIZE, height: SIZE }}>
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label="No allocation data yet">
          <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" stroke="var(--inv-border-subtle)" strokeWidth={STROKE} />
        </svg>
        <div className="inv-donut-center"><span>No holdings yet</span></div>
      </div>
    </div>;
  }

  return <div className="inv-donut-row">
    <div className="inv-donut-wrap" style={{ width: SIZE, height: SIZE }}>
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={`Portfolio allocation: ${slices.map(s => `${s.label} ${s.percent}%`).join(", ")}`}>
        <g transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}>
          {segments.map(segment => <circle
            key={segment.category} cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" stroke={segment.color} strokeWidth={STROKE}
            strokeDasharray={segment.dashArray} strokeDashoffset={segment.dashOffset}
            opacity={hoverIndex === null || hoverIndex === segment.index ? 1 : 0.35}
            style={{ transition: "opacity 140ms ease" }}
            onMouseEnter={() => setHoverIndex(segment.index)} onMouseLeave={() => setHoverIndex(null)}
          />)}
        </g>
      </svg>
      {centerLabel && <div className="inv-donut-center"><strong>{centerLabel.percent}%</strong><span>{centerLabel.label}</span></div>}
    </div>
    <ul className="inv-legend">
      {slices.map((slice, index) => <li key={slice.category} className="inv-legend-row" onMouseEnter={() => setHoverIndex(index)} onMouseLeave={() => setHoverIndex(null)}>
        <i className="inv-legend-dot" style={{ background: slice.color }} aria-hidden="true" />
        <span className="inv-legend-name">{slice.label}</span>
        <span className="inv-legend-percent">{slice.percent}%</span>
      </li>)}
    </ul>
  </div>;
}
