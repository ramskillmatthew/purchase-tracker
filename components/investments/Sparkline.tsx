const WIDTH = 56;
const HEIGHT = 20;

/** A tiny, genuine-data-only trend line — up to the 10 most recent real price snapshots for one asset. Renders nothing (not a flat fake line) when fewer than 2 points exist. */
export default function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * WIDTH;
    const y = HEIGHT - ((v - min) / range) * HEIGHT;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const trendUp = values[values.length - 1] >= values[0];
  return <svg className="inv-sparkline" width={WIDTH} height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} aria-hidden="true">
    <polyline points={points} fill="none" stroke={trendUp ? "var(--inv-green)" : "var(--inv-red)"} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}
