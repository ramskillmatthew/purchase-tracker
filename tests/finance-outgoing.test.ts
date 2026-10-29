import { describe,expect,it } from "vitest";
import { outgoingTiming,outstandingPence,summariseOutgoings } from "@/lib/finance/outgoing";
const row=(overrides={})=>({id:"1",totalPence:100000,paidPence:0,status:"planned" as const,dateKind:"exact" as const,dueDate:"2026-09-06",...overrides});
describe("planned outgoing calculations",()=>{
  it("uses only the unpaid amount",()=>expect(outstandingPence(row({paidPence:25000,status:"partially_paid"}))).toBe(75000));
  it("allows unknown dates without inventing one",()=>expect(outgoingTiming(row({dateKind:"unknown",dueDate:null}),"2026-09-03","2026-09-10","2026-10-03")).toBe("no_date"));
  it("separates overdue, next seven and next thirty day totals",()=>expect(summariseOutgoings([row({dueDate:"2026-09-01"}),row(),row({id:"2",dueDate:"2026-09-20",totalPence:50000})],"2026-09-03","2026-09-10","2026-10-03")).toEqual({overduePence:100000,next7Pence:100000,next30Pence:150000,recurringPence:0}));
});
