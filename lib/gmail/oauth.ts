import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { supabaseRequest } from "@/lib/supabase";

const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
function required(name: string) { const value = process.env[name]; if (!value) throw new Error(`${name} is not configured.`); return value; }
function stateKey() { return new TextEncoder().encode(required("EMAIL_ID_SECRET")); }
function encryptionKey() { return Buffer.from(required("GOOGLE_TOKEN_ENCRYPTION_KEY"), "base64url"); }

export async function createGoogleState(ownerId: string) {
  return new SignJWT({ ownerId, purpose: "gmail-oauth" }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("10m").sign(stateKey());
}
export async function verifyGoogleState(state: string) {
  const { payload } = await jwtVerify(state, stateKey(), { algorithms: ["HS256"] });
  if (payload.purpose !== "gmail-oauth" || typeof payload.ownerId !== "string") throw new Error("Invalid Gmail OAuth state.");
  return payload.ownerId;
}
export function googleRedirectUri(origin?: string) { return process.env.GOOGLE_REDIRECT_URI || `${origin || required("NEXT_PUBLIC_APP_URL")}/api/gmail/callback`; }
export async function googleAuthorizationUrl(ownerId: string, origin: string) {
  const query = new URLSearchParams({ client_id: required("GOOGLE_CLIENT_ID"), redirect_uri: googleRedirectUri(origin), response_type: "code", scope: `openid email ${SCOPE}`, access_type: "offline", prompt: "consent", include_granted_scopes: "true", state: await createGoogleState(ownerId) });
  return `https://accounts.google.com/o/oauth2/v2/auth?${query}`;
}
export function encryptToken(value: string) {
  const key = encryptionKey(); if (key.length !== 32) throw new Error("GOOGLE_TOKEN_ENCRYPTION_KEY must be a 32-byte base64url value.");
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv); const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}
export function decryptToken(value: string) {
  const [iv, tag, encrypted] = value.split("."); const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url")); decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
}
async function tokenRequest(params: Record<string,string>) {
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params), cache: "no-store" });
  if (!response.ok) throw new Error("Google OAuth token exchange failed."); return response.json() as Promise<{ access_token: string; refresh_token?: string; expires_in: number }>;
}
export async function exchangeGoogleCode(code: string, origin: string) {
  return tokenRequest({ code, client_id: required("GOOGLE_CLIENT_ID"), client_secret: required("GOOGLE_CLIENT_SECRET"), redirect_uri: googleRedirectUri(origin), grant_type: "authorization_code" });
}
export async function gmailProfile(accessToken: string) {
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" });
  if (!response.ok) throw new Error("Gmail profile could not be read."); return response.json() as Promise<{ emailAddress: string; historyId: string }>;
}
export async function saveGmailAccount(ownerId: string, email: string, refreshToken: string) {
  await supabaseRequest("email_accounts?on_conflict=owner_id,provider,email_address", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ owner_id: ownerId, provider: "gmail", email_address: email.toLowerCase(), encrypted_refresh_token: encryptToken(refreshToken), status: "connected", updated_at: new Date().toISOString() }) });
}
export async function gmailAccounts(ownerId: string) {
  const response = await supabaseRequest(`email_accounts?owner_id=eq.${ownerId}&provider=eq.gmail&select=id,email_address,encrypted_refresh_token,status,created_at,updated_at&order=created_at.asc`);
  return response.json() as Promise<Array<{ id:string; email_address:string; encrypted_refresh_token:string; status:string; created_at:string; updated_at:string }>>;
}
export async function gmailAccessToken(ownerId: string, accountId?: string) {
  const accounts = await gmailAccounts(ownerId); const account = accountId ? accounts.find(item => item.id === accountId) : accounts[0]; if (!account) throw new Error("No Gmail account is connected.");
  const token = await tokenRequest({ refresh_token: decryptToken(account.encrypted_refresh_token), client_id: required("GOOGLE_CLIENT_ID"), client_secret: required("GOOGLE_CLIENT_SECRET"), grant_type: "refresh_token" });
  return { accessToken: token.access_token, account };
}
