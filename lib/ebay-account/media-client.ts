import "server-only";
import { ebayEnvironment } from "@/lib/ebay-account/oauth";
import { formatEbayErrorForUser, parseEbayErrors, type SanitizedEbayError } from "@/lib/ebay-account/ebay-error";

export type EbayHostedImage = {
  imageUrl: string;
  expirationDate: string | null;
  imageResourceUrl: string | null;
};

function mediaApiBase(): string {
  return ebayEnvironment() === "SANDBOX"
    ? "https://apim.sandbox.ebay.com"
    : "https://apim.ebay.com";
}

async function mediaError(response: Response): Promise<Error & { status: number; ebayErrors: SanitizedEbayError[] }> {
  let ebayErrors: SanitizedEbayError[] = [];
  try { ebayErrors = parseEbayErrors(await response.json()); } catch { /* Empty/non-JSON eBay response. */ }
  const error = new Error(formatEbayErrorForUser(ebayErrors, "eBay could not store this listing photo.")) as Error & {
    status: number;
    ebayErrors: SanitizedEbayError[];
  };
  error.status = response.status;
  error.ebayErrors = ebayErrors;
  return error;
}

/** Uploads the actual image bytes to eBay Picture Services (EPS).
 *
 * Inventory API photo fields have strict per-URL and aggregate URL-length
 * limits. Supplying private Storage signed URLs can exceed those limits even
 * though the URLs themselves are reachable. Media API returns a short,
 * eBay-hosted EPS URL, so Inventory API never receives a temporary Storage
 * token or depends on this app being publicly reachable. */
export async function createEbayImageFromFile(
  accessToken: string,
  bytes: ArrayBuffer,
  mimeType: string,
  filename: string,
): Promise<EbayHostedImage> {
  if (!bytes.byteLength) throw new Error("This listing photo is empty.");
  if (!/^image\/(?:jpeg|png|gif|bmp|tiff|avif|heic|heif|webp)$/i.test(mimeType)) {
    throw new Error(`This listing photo uses an unsupported format (${mimeType || "unknown"}).`);
  }
  const safeFilename = filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(-120) || "listing-photo.jpg";
  const form = new FormData();
  form.append("image", new Blob([bytes], { type: mimeType }), safeFilename);

  let response: Response;
  try {
    response = await fetch(`${mediaApiBase()}/commerce/media/v1_beta/image/create_image_from_file`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      body: form,
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
  } catch (cause) {
    const error = new Error("Could not reach eBay's picture service.") as Error & { cause?: unknown };
    error.cause = cause;
    throw error;
  }
  if (!response.ok) throw await mediaError(response);
  const body = await response.json() as { imageUrl?: unknown; expirationDate?: unknown };
  const imageUrl = typeof body.imageUrl === "string" ? body.imageUrl.trim() : "";
  if (!/^https:\/\//i.test(imageUrl) || imageUrl.length > 500) {
    throw new Error("eBay stored the photo but did not return a usable picture URL.");
  }
  return {
    imageUrl,
    expirationDate: typeof body.expirationDate === "string" ? body.expirationDate : null,
    imageResourceUrl: response.headers.get("location"),
  };
}
