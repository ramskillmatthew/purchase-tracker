"use client";

import { formatGbp, formatPercent, formatRelativeSync } from "@/lib/investments/format";
import type { AccountResponse } from "@/lib/investments/view-model-types";

const ACCOUNT_TYPE_ICON: Record<string, { icon: React.ReactNode; tone: string }> = {
  isa: { tone: "var(--inv-green)", icon: <><path d="M2.5 9l4-4.5L10 9l6-7" /></> },
  gia: { tone: "var(--inv-green)", icon: <><path d="M2.5 9l4-4.5L10 9l6-7" /></> },
  pokemon_collection: { tone: "var(--inv-purple)", icon: <><circle cx="9" cy="9" r="6.5" /><path d="M2.5 9h13M9 2.5v13" /></> },
  lego_collection: { tone: "var(--inv-amber)", icon: <><rect x="3" y="7" width="12" height="8" rx="1" /><rect x="5.5" y="3.5" width="3" height="3.5" rx=".8" /><rect x="9.5" y="3.5" width="3" height="3.5" rx=".8" /></> },
  cash: { tone: "var(--inv-blue)", icon: <><rect x="2.5" y="5.5" width="13" height="8" rx="1.5" /><path d="M2.5 9h13" /></> },
  other: { tone: "var(--inv-muted)", icon: <><circle cx="9" cy="9" r="6.5" /></> },
};

/**
 * Real, user-created investment accounts — never hard-coded decorative
 * cards. Renders nothing extra when the owner has no accounts yet; the
 * "Add investment" flow is what creates the first one.
 */
export default function CollectionCards({ accounts, onSelectAccount }: { accounts: AccountResponse[]; onSelectAccount: (accountId: string) => void }) {
  if (accounts.length === 0) return null;

  return <div className="inv-collections">
    {accounts.map(account => {
      const style = ACCOUNT_TYPE_ICON[account.accountType] ?? ACCOUNT_TYPE_ICON.other;
      const tone = account.returnGbp > 0 ? "positive" : account.returnGbp < 0 ? "negative" : "neutral";
      return <button key={account.id} type="button" className="inv-collection-card" onClick={() => onSelectAccount(account.id)}>
        <span className="inv-collection-icon" style={{ background: `color-mix(in srgb, ${style.tone} 16%, transparent)`, color: style.tone }} aria-hidden="true">
          <svg viewBox="0 0 18 18">{style.icon}</svg>
        </span>
        <span className="inv-collection-body">
          <span className="inv-collection-name" title={account.name}>{account.name}</span>
          <span className="inv-collection-value">{formatGbp(account.gbpValue)}</span>
          <span className={`inv-collection-return inv-hero-delta-${tone}`}>
            {formatGbp(account.returnGbp, { signed: true })} {account.returnPercent !== null ? formatPercent(account.returnPercent, { signed: true }) : ""}
          </span>
          {account.hasPriceableAssets && <span className="inv-collection-status">
            <i className={account.allLive ? "inv-live-dot" : "inv-stale-dot"} aria-hidden="true" />
            {account.lastSyncedAt ? `Synced ${formatRelativeSync(account.lastSyncedAt)}` : "Not yet priced"}
          </span>}
        </span>
        <span className="inv-collection-chevron" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M6 3.5 11 8l-5 4.5" /></svg></span>
      </button>;
    })}
  </div>;
}
