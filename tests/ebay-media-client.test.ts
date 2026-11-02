import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createEbayImageFromFile } from "@/lib/ebay-account/media-client";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  delete process.env.EBAY_ENVIRONMENT;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.EBAY_ENVIRONMENT;
});

describe("eBay Media API image upload", () => {
  it("uploads image bytes as multipart data and returns eBay's EPS URL", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      imageUrl: "https://i.ebayimg.com/images/g/example/s-l1600.jpg",
      expirationDate: "2028-01-01T00:00:00.000Z",
    }), {
      status: 201,
      headers: { "Content-Type": "application/json", Location: "https://apim.ebay.com/commerce/media/v1_beta/image/abc123" },
    }));

    const result = await createEbayImageFromFile("token", new Uint8Array([1, 2, 3]).buffer, "image/jpeg", "photo.jpg");
    expect(result.imageUrl).toBe("https://i.ebayimg.com/images/g/example/s-l1600.jpg");
    expect(result.imageResourceUrl).toContain("/image/abc123");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://apim.ebay.com/commerce/media/v1_beta/image/create_image_from_file");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.headers["Content-Type"]).toBeUndefined();
    expect((init.body as FormData).get("image")).toBeInstanceOf(Blob);
  });

  it("uses the sandbox Media API host in sandbox mode", async () => {
    process.env.EBAY_ENVIRONMENT = "SANDBOX";
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ imageUrl: "https://i.ebayimg.com/images/g/example/s-l1600.jpg" }), { status: 201 }));
    await createEbayImageFromFile("token", new Uint8Array([1]).buffer, "image/png", "photo.png");
    expect(String(fetchMock.mock.calls[0][0])).toContain("https://apim.sandbox.ebay.com/");
  });

  it("rejects an unusable response URL rather than forwarding it to Inventory API", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ imageUrl: "http://not-secure.example/photo.jpg" }), { status: 201 }));
    await expect(createEbayImageFromFile("token", new Uint8Array([1]).buffer, "image/jpeg", "photo.jpg"))
      .rejects.toThrow(/usable picture URL/);
  });

  it("surfaces eBay's detailed upload error", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ errors: [{ message: "Invalid image", longMessage: "The supplied image format is not supported." }] }), { status: 400 }));
    await expect(createEbayImageFromFile("token", new Uint8Array([1]).buffer, "image/jpeg", "photo.jpg"))
      .rejects.toThrow(/supplied image format is not supported/i);
  });
});
