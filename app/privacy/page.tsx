export const metadata = { title: "Privacy — Trotter's Attire HQ" };

/**
 * Public privacy statement — deliberately reachable with NO app session
 * (see middleware.ts's own `publicPage` exception). This is the page
 * shown during the eBay OAuth consent flow (eBay's Accepted/Declined
 * callback URLs are configured against this app's domain, and eBay's own
 * review of the connection references this URL), so it must be reachable
 * by eBay and by anyone reviewing the connection, never gated behind
 * sign-in. Every statement below is deliberately scoped to what this
 * codebase actually does today (see lib/ebay-account/*) — nothing here
 * describes a capability that doesn't exist yet, and nothing invents a
 * business address, company registration, or contact email that hasn't
 * actually been supplied.
 */
export default function PrivacyPage() {
  return <section className="page-shell page-narrow">
    <header className="page-header"><div className="title-row"><h1>Privacy</h1></div></header>
    <div className="card settings-panel">
      <div className="settings-section">
        <div className="settings-copy">
          <h2>eBay account connection</h2>
          <p>This application connects to your eBay UK seller account only after you explicitly grant permission through eBay&apos;s own sign-in and consent screens. It never asks for, receives, or stores your eBay password.</p>
        </div>
      </div>
      <div className="settings-section">
        <div className="settings-copy">
          <h2>What is stored</h2>
          <p>Once you approve the connection, this app stores your connected eBay account identifier and, where eBay supplies it, your account email address.</p>
          <p>OAuth access and refresh tokens are encrypted before being stored, and are only ever used server-side to make requests on your behalf — they are never exposed to the browser.</p>
        </div>
      </div>
      <div className="settings-section">
        <div className="settings-copy">
          <h2>What is read from your eBay account</h2>
          <p>This app reads your eBay account identity (account type, registration marketplace, and email where permitted) and your own eBay UK seller business policies (postage/fulfilment, returns, and payment policies), so they can be used to prepare listing drafts.</p>
        </div>
      </div>
      <div className="settings-section">
        <div className="settings-copy">
          <h2>What this app does not do</h2>
          <p>This app does not currently publish live eBay listings. It may, only when you explicitly request it, create unpublished eBay inventory drafts for your review — nothing is made live automatically, during a sync, or as a side effect of any other action.</p>
        </div>
      </div>
      <div className="settings-section">
        <div className="settings-copy">
          <h2>Disconnecting</h2>
          <p>You can disconnect your eBay account at any time from Settings. Disconnecting removes this app&apos;s local access to your saved OAuth credentials. You can also independently revoke this app&apos;s access at any time from eBay&apos;s own third-party application settings in your eBay account.</p>
        </div>
      </div>
      <div className="settings-section">
        <div className="settings-copy">
          <h2>Data is not sold</h2>
          <p>Data read from your eBay account is used only to operate this application&apos;s own features and is never sold.</p>
        </div>
      </div>
    </div>
  </section>;
}
