import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_BYTES = 24;

function signingSecret(): string {
  const secret = process.env.EBAY_CLIENT_SECRET || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new Error("The eBay photo-link signing secret is not configured.");
  return secret;
}

function signature(imageId: string, expiresAt: number): string {
  return createHmac("sha256", signingSecret())
    .update(`${imageId}.${expiresAt}`)
    .digest()
    .subarray(0, SIGNATURE_BYTES)
    .toString("base64url");
}

export function createEbayPhotoProxyUrl(imageId: string, expiresAt: number): string {
  const origin = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "");
  if (!origin || !/^https:\/\//i.test(origin)) throw new Error("NEXT_PUBLIC_APP_URL must be an HTTPS URL before listing on eBay.");
  const params = new URLSearchParams({ exp: String(expiresAt), sig: signature(imageId, expiresAt) });
  return `${origin}/api/ebay/photo/${encodeURIComponent(imageId)}?${params}`;
}

export function verifyEbayPhotoProxySignature(imageId: string, expiresAt: number, supplied: string): boolean {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return false;
  const expectedBytes = Buffer.from(signature(imageId, expiresAt));
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}
