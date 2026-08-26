"use client";

import { formatShortMarketDate } from "@/lib/investments/format";
import { isPokePulseCodeRetryable, POKEPULSE_UI_MESSAGES } from "@/lib/investments/refresh-classification";
import { groupResultsByOutcome } from "@/lib/investments/sync-status";
import type { RefreshResultEntry } from "@/lib/investments/refresh";

const SOURCE_LABELS: Record<string, string> = { twelve_data: "Twelve Data", eodhd: "EODHD", pokepulse: "PokePulse", manual: "Manual" };

/**
 * PokePulse rows with a typed `code` get precise, accurate wording here
 * instead of the raw adapter `error` string — e.g. never "PokePulse
 * returned no market price" unless the response genuinely and explicitly
 * said so (price_field_missing/empty_response); a rate limit, timeout, or
 * unrecognised response format each get their own honest description. The
 * raw `entry.error` (kept precise for server-side diagnostics) is what
 * every OTHER provider still shows — Twelve Data/EODHD errors are already
 * specific, confirmed-live provider messages, untouched by this change.
 * "Will retry automatically" is computed per ROW here, not per group: two
 * PokePulse codes can share one coarse outcome (e.g. an unrecognised
 * schema and a malformed response both classify as "Unexpected provider
 * response") while differing on whether retrying is actually worthwhile.
 */
function describeEntry(entry: RefreshResultEntry, groupWillRetry: boolean): { message: string | undefined; willRetry: boolean } {
  if (entry.provider === "pokepulse" && entry.code) {
    return { message: POKEPULSE_UI_MESSAGES[entry.code], willRetry: isPokePulseCodeRetryable(entry.code) };
  }
  return { message: entry.error, willRetry: groupWillRetry };
}

/**
 * "Which N prices were unavailable and why?" — answered directly, one row
 * per holding grouped by its real typed outcome (never raw provider text,
 * never a flat "unavailable" bucket). Opened by clicking the header sync
 * status in InvestmentsWorkspace.tsx.
 */
export default function RefreshDetailsPanel({ results, holdingNames, onClose }: {
  results: RefreshResultEntry[];
  holdingNames: Map<string, string>;
  onClose: () => void;
}) {
  const groups = groupResultsByOutcome(results);

  return <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="task-modal investment-modal refresh-details-modal" role="dialog" aria-modal="true" aria-labelledby="refresh-details-title">
      <div className="task-modal-heading">
        <h2 id="refresh-details-title">Refresh details</h2>
        <button type="button" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="task-modal-body">
        {groups.length === 0
          ? <p className="inv-detail-empty">Every price updated normally — nothing needs attention.</p>
          : groups.map(group => <section key={group.outcome} className="refresh-details-group">
            <h3 className="refresh-details-group-title">{group.label} <span className="refresh-details-group-count">{group.entries.length}</span></h3>
            <ul className="refresh-details-list">
              {group.entries.map(entry => {
                const { message, willRetry } = describeEntry(entry, group.willRetry);
                return <li key={entry.assetId} className="refresh-details-row">
                  <div className="refresh-details-row-main">
                    <span className="refresh-details-row-name">{holdingNames.get(entry.assetId) ?? entry.assetId}</span>
                    <span className="refresh-details-row-provider">{SOURCE_LABELS[entry.provider] ?? entry.provider}</span>
                  </div>
                  <div className="refresh-details-row-meta">
                    {entry.priceAt && <span>Price as of {formatShortMarketDate(entry.priceAt)}</span>}
                    {message && <span className="refresh-details-row-reason">{message}</span>}
                    {willRetry && <span className="refresh-details-row-retry">Will retry automatically</span>}
                  </div>
                </li>;
              })}
            </ul>
          </section>)}
      </div>
    </div>
  </div>;
}
