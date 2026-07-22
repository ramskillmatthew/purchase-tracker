import { describe,expect,it } from "vitest";
import { readFileSync } from "node:fs";
const read=(path:string)=>readFileSync(path,"utf8");
describe("Gmail integration",()=>{
  it("stores encrypted refresh tokens in a protected table",()=>{const sql=read("supabase-gmail-accounts.sql");expect(sql).toContain("encrypted_refresh_token");expect(sql).toContain("enable row level security");expect(sql).toContain("revoke all");});
  it("requests read-only offline OAuth",()=>{const source=read("lib/gmail/oauth.ts");expect(source).toContain("gmail.readonly");expect(source).toContain('access_type: "offline"');expect(source).toContain("encryptToken(refreshToken)");});
  it("preserves Yahoo behind a shared client",()=>{const source=read("lib/email/client.ts");expect(source).toContain("searchYahoo(criteria)");expect(source).toContain("searchGmail(ownerId,criteria)");expect(source).toContain("getYahooEmails(yahoo)");expect(source).toContain("getGmailEmails(ownerId,gmail)");});
  it("uses shared mail in assistant and purchase import",()=>{expect(read("lib/anthropic/assistant.ts")).toContain('from "@/lib/email/client"');expect(read("app/api/vinted/sync/route.ts")).toContain("getMails(user.id");});
  it("does not serialize encrypted tokens in the accounts API",()=>{const source=read("app/api/gmail/accounts/route.ts");expect(source).not.toContain("encrypted_refresh_token:");expect(source).toContain("emailAddress:email_address");});
});
