import { describe, expect, it } from "vitest";
import { emailSearchSchema, getEmailSchema } from "@/lib/validation/email";
describe("controlled email search", () => {
  it("validates sender, subject, keywords, date range and pagination", () => { const value=emailSearchSchema.parse({sender:"receipts@example.test",subject:"order",terms:["tracking"],startDate:"2026-06-01",endDate:"2026-06-30",maxResults:10,cursor:"MTA",readStatus:"unread"}); expect(value.sender).toBe("receipts@example.test"); expect(value.maxResults).toBe(10); });
  it("rejects inverted dates and oversized pages", () => { expect(()=>emailSearchSchema.parse({startDate:"2026-07-02",endDate:"2026-07-01"})).toThrow(); expect(()=>emailSearchSchema.parse({maxResults:100})).toThrow(); });
  it("rejects arbitrary IMAP commands and unknown fields", () => { expect(()=>emailSearchSchema.parse({imapCommand:"STORE 1 +FLAGS \\Deleted"})).toThrow(); expect(()=>getEmailSchema.parse({id:"1 FETCH BODY[]"})).toThrow(); });
});
