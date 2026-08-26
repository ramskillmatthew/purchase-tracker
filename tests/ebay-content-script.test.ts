// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

// ---------------------------------------------------------------------
// Browser content-script (vinted-draft-queue-extension/ebay-content-script.js)
// — regression tests proving the reported "not an exact copy" bug (wrong
// title entity, wrong photo set, unrelated recommended/sponsored images)
// cannot return. Loads the REAL, unmodified content-script file into a
// JSDOM document (same pattern as tests/vinted-extension-sidepanel.test.ts's
// own loadSidepanel helper — the content script has no build step and is
// loaded as a plain classic script, so it's exercised here exactly as
// Chrome would load it, never a reimplementation.
//
// This lives in its own file (rather than tests/ebay-extractor.test.ts)
// because it needs the jsdom test environment; tests/ebay-extractor.test.ts
// exercises the separate server-side extractor and needs the default node
// environment for its `vi.mock("server-only", ...)` shim to resolve.
// ---------------------------------------------------------------------
const CONTENT_SCRIPT_SOURCE = readFileSync("vinted-draft-queue-extension/ebay-content-script.js", "utf8");
const HARRODS_ITEM_ID = "267750791701";
const GENUINE_IMAGE = "https://i.ebayimg.com/images/g/SScAAeSwwXppPWrE/s-l1600.jpg";
const ENCODED_TITLE = "Harrods BEAUTY 25 Day Advent Calendar 2025 - Brand New &amp; Unopened 32 Products";
const DECODED_TITLE = "Harrods BEAUTY 25 Day Advent Calendar 2025 - Brand New & Unopened 32 Products";

function harrodsFixtureHtml(overrides: { image?: string | string[] } = {}) {
  const jsonLd = {
    "@type": "Product", name: ENCODED_TITLE, description: "Short JSON-LD summary only.",
    image: overrides.image ?? GENUINE_IMAGE,
    offers: { price: "34.99", priceCurrency: "GBP", inventoryLevel: 1 },
    additionalProperty: [{ name: "Brand", value: "Harrods" }],
  };
  return `<html><head>
    <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
    <meta property="og:image" content="https://i.ebayimg.com/images/g/unrelated-og-image/s-l500.jpg" />
    <meta property="og:title" content="Harrods BEAUTY 25 Day Advent Calendar 2025" />
  </head><body>
    <!-- Recommended/sponsored eBay-hosted images elsewhere on the page —
         a page-wide img[src*="ebayimg.com"] scan would wrongly capture
         these; they must NEVER appear in the extracted result. -->
    <div class="srp-river-results">
      <img src="https://i.ebayimg.com/images/g/recommended-one/s-l225.jpg" />
      <img src="https://i.ebayimg.com/images/g/recommended-two/s-l225.jpg" />
    </div>
    <!-- A gallery-scoped image that is also NOT the genuine product.image —
         proves product.image wins outright, never merged with the gallery. -->
    <div class="ux-image-carousel"><img src="https://i.ebayimg.com/images/g/gallery-decoy/s-l500.jpg" /></div>
    <iframe id="desc_ifr" title="Seller's description of item" src="https://itm.ebaydesc.com/itmdesc/${HARRODS_ITEM_ID}?token=abc"></iframe>
  </body></html>`;
}

/** Loads the real content-script source into a fresh JSDOM document for the given URL/HTML, invokes its EBAY_READ_LISTING handler, and returns the response. */
async function readListingFromFixture(html: string, url = `https://www.ebay.co.uk/itm/${HARRODS_ITEM_ID}`) {
  const dom = new JSDOM(html, { url });
  // JSDOM has no layout engine and does not implement innerText (it requires
  // rendering). The real content script relies on document.body.innerText
  // for captcha detection, so it's shimmed here as textContent — close
  // enough for these plain-text fixtures, and the content script itself is
  // never changed to work around a test-only limitation.
  if (!("innerText" in dom.window.HTMLElement.prototype)) {
    Object.defineProperty(dom.window.HTMLElement.prototype, "innerText", { configurable: true, get() { return this.textContent; } });
  }
  vi.stubGlobal("window", dom.window as any);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("location", dom.window.location);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);

  let handler: ((message: any, sender: any, sendResponse: (r: any) => void) => boolean) | null = null;
  vi.stubGlobal("chrome", { runtime: { onMessage: { addListener: (fn: any) => { handler = fn; } } } });

  // A fresh module instance for every fixture — the script self-registers
  // its listener at import time and has no re-entrant reset otherwise.
  vi.resetModules();
  await import("../vinted-draft-queue-extension/ebay-content-script.js");

  expect(handler).not.toBeNull();
  return new Promise<any>(resolve => {
    handler!({ type: "EBAY_READ_LISTING" }, {}, resolve);
  });
}

describe("eBay content-script (browser) — exact-copy regression tests", () => {
  it("REGRESSION: no longer contains or uses the old page-wide eBay-image scan", () => {
    expect(CONTENT_SCRIPT_SOURCE).not.toContain('img[src*="ebayimg.com"]');
  });

  it("REQUIREMENT: prefers Product JSON-LD's own image field", () => {
    expect(CONTENT_SCRIPT_SOURCE).toContain("const productImages = strings(product.image);");
    expect(CONTENT_SCRIPT_SOURCE).toContain("productImages.length ? productImages :");
  });

  it("REQUIREMENT: the fallback (when JSON-LD has no image) is limited to listing-gallery-scoped selectors only", () => {
    expect(CONTENT_SCRIPT_SOURCE).toMatch(/ux-image-carousel|ux-image-grid|ux-image/);
  });

  it("REQUIREMENT: decodes HTML entities in the title (via a textarea, never regex-only stripping)", () => {
    expect(CONTENT_SCRIPT_SOURCE).toContain('document.createElement("textarea")');
  });

  it("REQUIREMENT: returns the seller-description iframe URL", () => {
    expect(CONTENT_SCRIPT_SOURCE).toContain("descriptionUrl");
    expect(CONTENT_SCRIPT_SOURCE).toContain("desc_ifr");
  });

  it("REGRESSION (Harrods listing, exact reported bug): the extracted result has exactly the one genuine product image and a decoded title — never the recommended/sponsored/gallery-decoy images, never an encoded &amp;", async () => {
    const response = await readListingFromFixture(harrodsFixtureHtml());
    expect(response.ok).toBe(true);
    expect(response.listing.title).toBe(DECODED_TITLE);
    expect(response.listing.title).not.toContain("&amp;");
    expect(response.listing.imageUrls).toEqual([GENUINE_IMAGE]);
    expect(response.listing.imageUrls).toHaveLength(1);
    expect(response.listing.descriptionUrl).toBe(`https://itm.ebaydesc.com/itmdesc/${HARRODS_ITEM_ID}?token=abc`);
    expect(response.listing.itemId).toBe(HARRODS_ITEM_ID);
  });

  it("REGRESSION: none of the recommended/sponsored/gallery-decoy image URLs ever leak into the result, under any circumstance", async () => {
    const response = await readListingFromFixture(harrodsFixtureHtml());
    const imageSet = new Set(response.listing.imageUrls as string[]);
    expect(imageSet.has("https://i.ebayimg.com/images/g/recommended-one/s-l1600.jpg")).toBe(false);
    expect(imageSet.has("https://i.ebayimg.com/images/g/recommended-two/s-l1600.jpg")).toBe(false);
    expect(imageSet.has("https://i.ebayimg.com/images/g/gallery-decoy/s-l1600.jpg")).toBe(false);
    expect(imageSet.has("https://i.ebayimg.com/images/g/unrelated-og-image/s-l1600.jpg")).toBe(false);
  });

  it("falls back to the gallery-scoped selector ONLY when JSON-LD has no image at all — and still never picks up the unrelated recommended images", async () => {
    const html = harrodsFixtureHtml({ image: [] });
    const response = await readListingFromFixture(html);
    expect(response.ok).toBe(true);
    // The gallery decoy (inside .ux-image-carousel) is picked up — it is a
    // genuine gallery-scoped element in this fixture — but the page-wide
    // "recommended" images (outside any gallery container) are not.
    expect(response.listing.imageUrls).toContain("https://i.ebayimg.com/images/g/gallery-decoy/s-l1600.jpg");
    expect(response.listing.imageUrls).not.toContain("https://i.ebayimg.com/images/g/recommended-one/s-l1600.jpg");
    expect(response.listing.imageUrls).not.toContain("https://i.ebayimg.com/images/g/recommended-two/s-l1600.jpg");
  });

  it("deduplicates multiple size/format variants of the same JSON-LD image into one photo", async () => {
    const response = await readListingFromFixture(harrodsFixtureHtml({
      image: [
        "https://i.ebayimg.com/images/g/SScAAeSwwXppPWrE/s-l500.jpg",
        "https://i.ebayimg.com/images/g/SScAAeSwwXppPWrE/s-l64.jpg",
        "https://i.ebayimg.com/images/g/SScAAeSwwXppPWrE/s-l1600.jpg",
      ],
    }));
    expect(response.listing.imageUrls).toHaveLength(1);
    expect(response.listing.imageUrls[0]).toBe(GENUINE_IMAGE);
  });

  it("REGRESSION: fails clearly with no listing when eBay shows a human-verification page, rather than returning junk data", async () => {
    const response = await readListingFromFixture("<html><body>Please complete this CAPTCHA to verify you are human.</body></html>");
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/security check/i);
  });

  it("REGRESSION: never throws for a listing with no seller-description iframe present — descriptionUrl is simply null", async () => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      "@type": "Product", name: "No iframe here", image: GENUINE_IMAGE, offers: { price: "5", priceCurrency: "GBP" },
    })}</script></head><body></body></html>`;
    const response = await readListingFromFixture(html);
    expect(response.ok).toBe(true);
    expect(response.listing.descriptionUrl).toBeNull();
  });
});
