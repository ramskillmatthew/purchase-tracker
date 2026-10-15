import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

describe("eBay live listing safety boundary", () => {
  it("requires the exact live-listing confirmation at the HTTP boundary", () => {
    const route = read("app/api/listing-studio/ebay-live-listings/route.ts");
    expect(route).toContain("z.literal(EBAY_LIVE_CONFIRMATION)");
    expect(route).toContain("MAX_EBAY_LIVE_LISTINGS");
    expect(route).toContain("requireOwner()");
  });

  it("preview cannot publish and the PUT is the only route branch that invokes publication", () => {
    const route = read("app/api/listing-studio/ebay-live-listings/route.ts");
    const post = route.slice(route.indexOf("export async function POST"), route.indexOf("export async function PUT"));
    expect(post).not.toContain("publishOneEbayLiveListing(");
    expect(route.slice(route.indexOf("export async function PUT"))).toContain("publishOneEbayLiveListing(");
  });

  it("reconciles an uncertain publish response before allowing a retry", () => {
    const service = read("lib/listing-studio/ebay-live-listings.ts");
    expect(service).toContain("const reconciled = await getOffer");
    expect(service).toContain('reconciled?.status === "PUBLISHED"');
    expect(service).toContain("reads.length > 1");
  });

  it("uses saved account defaults when a listing has no per-item policy overrides", () => {
    const service = read("lib/listing-studio/ebay-live-listings.ts");
    expect(service).toContain('choosePolicy("FULFILLMENT", draft.ebayFulfillmentPolicyId, connection.defaultFulfillmentPolicyId)');
    expect(service).toContain('choosePolicy("RETURN", draft.ebayReturnPolicyId, connection.defaultReturnPolicyId)');
    expect(service).toContain('choosePolicy("PAYMENT", draft.ebayPaymentPolicyId, connection.defaultPaymentPolicyId)');
    expect(service).toContain("draft.ebayMerchantLocationKey ?? connection.defaultInventoryLocationKey");
    expect(service).toContain("offerPayload(draft, preview.sku, listingPolicies)");
  });

  it("falls back to saved defaults when an older listing contains unavailable policy overrides", () => {
    const service = read("lib/listing-studio/ebay-live-listings.ts");
    expect(service).toContain("usablePolicy(type, override) ? override : fallback");
    expect(service).toContain("resolveEbayListingPolicies(draft, connection, policies)");
  });

  it("uses short signed app photo URLs instead of long storage signed URLs", () => {
    const batches = read("lib/listing-studio/ebay-draft-batches.ts");
    const photoUrls = read("lib/listing-studio/ebay-photo-urls.ts");
    const photoRoute = read("app/api/ebay/photo/[imageId]/route.ts");
    expect(batches).toContain("createEbayPhotoProxyUrl(image.id, proxyExpiresAt)");
    expect(photoUrls).toContain('createHmac("sha256"');
    expect(photoUrls).toContain("timingSafeEqual");
    expect(photoRoute).toContain("verifyEbayPhotoProxySignature");
    expect(photoRoute).toContain("createSignedDownloadUrl");
    expect(photoRoute).toContain("LISTING_STUDIO_BUCKET");
    expect(photoRoute).not.toContain('const BUCKET = "listing-studio"');
  });
});
