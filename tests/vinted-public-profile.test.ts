import { describe, expect, it } from "vitest";
import { fetchAllVintedProfileListings, normaliseVintedProfileUrl, parseVintedProfilePage, parseVintedWardrobeApi } from "@/lib/listing-dashboard/vinted-public-profile";

function page(payload: unknown) {
  const flight = `1:${JSON.stringify({ initialWardrobeItems: payload })}`;
  return `<html><body><script>self.__next_f.push(${JSON.stringify([1, flight])})</script></body></html>`;
}

describe("public Vinted profile parsing", () => {
  it("normalises only real Vinted UK member links", () => {
    expect(normaliseVintedProfileUrl("https://vinted.co.uk/member/12345-example-user?ref=share", 2, 27)).toEqual({
      slot: 2,
      number: 27,
      profileUrl: "https://www.vinted.co.uk/member/12345-example-user",
      profileId: "12345",
      username: "example user",
    });
    expect(() => normaliseVintedProfileUrl("https://vinted.co.uk/member/12345-example-user", 1, 0)).toThrow(/between 1 and 9999/i);
    expect(() => normaliseVintedProfileUrl("https://example.com/member/12345", 1)).toThrow(/vinted\.co\.uk/i);
  });

  it("reads listings, photos, price, favourites and pagination from the streamed page data", () => {
    const result = parseVintedProfilePage(page({
      items: [{
        id: 987654321,
        title: "New Balance 530",
        url: "https://www.vinted.co.uk/items/987654321-new-balance-530",
        photos: [{ url: "https://images1.vinted.net/photo.jpeg", isMain: true }],
        favouriteCount: 14,
        price: { amount: "30.00", currencyCode: "GBP" },
      }],
      pagination: { currentPage: 1, totalPages: 4, totalEntries: 61, perPage: 20 },
    }));
    expect(result).toEqual({
      listings: [{ id: "987654321", title: "New Balance 530", url: "https://www.vinted.co.uk/items/987654321-new-balance-530", photoUrl: "https://images1.vinted.net/photo.jpeg", pricePence: 3000, currency: "GBP", favouriteCount: 14 }],
      currentPage: 1,
      totalPages: 4,
      totalEntries: 61,
    });
  });

  it("surfaces Vinted browser checks instead of silently returning no listings", () => {
    expect(() => parseVintedProfilePage("<title>Please wait</title><script src='/challenge-platform/test.js'></script>"))
      .toThrow(/browser check/i);
  });

  it("reads the additional wardrobe pages returned by Vinted", () => {
    expect(parseVintedWardrobeApi({
      items: [{
        id: 123456789,
        title: "Nike Air Max 95",
        path: "/items/123456789-nike-air-max-95",
        photos: [{ url: "https://images1.vinted.net/photo.jpeg", is_main: true }],
        favourite_count: 8,
        price: { amount: "42.00", currency_code: "GBP" },
      }],
      pagination: { current_page: 2, total_pages: 3, total_entries: 41, per_page: 20 },
    })).toEqual({
      listings: [{ id: "123456789", title: "Nike Air Max 95", url: "https://www.vinted.co.uk/items/123456789-nike-air-max-95", photoUrl: "https://images1.vinted.net/photo.jpeg", pricePence: 4200, currency: "GBP", favouriteCount: 8 }],
      currentPage: 2,
      totalPages: 3,
      totalEntries: 41,
    });
  });

  it.skipIf(process.env.LIVE_VINTED_PROFILE_TEST !== "1")("parses Vinted's current public profile response", async () => {
    const response = await fetch("https://www.vinted.co.uk/member/135585946", {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36", "Accept-Language": "en-GB,en;q=0.9" },
    });
    expect(response.ok).toBe(true);
    const result = parseVintedProfilePage(await response.text());
    expect(result.listings.length).toBeGreaterThan(0);
    expect(result.totalEntries).toBeGreaterThanOrEqual(result.listings.length);
    expect(result.listings[0].url).toMatch(/^https:\/\/www\.vinted\.co\.uk\/items\//);
    const all = await fetchAllVintedProfileListings(normaliseVintedProfileUrl("https://www.vinted.co.uk/member/135585946", 1));
    expect(all.length).toBe(result.totalEntries);
    expect(new Set(all.map(item => item.id)).size).toBe(all.length);
  });
});
