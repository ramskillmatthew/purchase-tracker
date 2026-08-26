import "server-only";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";

const yahooPayload = z.object({ provider: z.literal("yahoo").optional(), folder: z.string().min(1).max(250), uid: z.number().int().positive(), uidValidity: z.string().min(1) });
const gmailPayload = z.object({ provider: z.literal("gmail"), messageId: z.string().min(1).max(200) });
const idPayload = z.union([yahooPayload, gmailPayload]);
function key() {
  const value = process.env.EMAIL_ID_SECRET;
  if (!value || value.length < 32) throw new Error("EMAIL_ID_SECRET must contain at least 32 characters.");
  return new TextEncoder().encode(value);
}
export async function signEmailId(payload: z.infer<typeof idPayload>) {
  return new SignJWT(payload).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("15m").sign(key());
}
export async function verifyEmailId(token: string) {
  const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"] });
  return idPayload.parse(payload);
}
export async function verifyYahooEmailId(token:string){const payload=await verifyEmailId(token);if(payload.provider==="gmail")throw new Error("Email provider mismatch.");return payload;}
