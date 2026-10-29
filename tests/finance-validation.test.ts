import { describe,expect,it } from "vitest";
import { bulkSaleExpectedDateSchema, editManualIncomingSchema, plannedOutgoingInputSchema, receiveManualIncomingSchema } from "@/lib/validation/finance";
const base={kind:"other",description:"Supplier payment",category:null,payee:"Supplier",totalPence:100000,dateKind:"exact",dueDate:"2026-09-20",rangeStart:null,rangeEnd:null,paymentReference:null,preferredMethodType:null,preferredMethodId:null,allocationId:null,recurringMonthly:false,notes:null,paymentParts:[],purchase:null,expense:null};
describe("planned outgoing validation",()=>{
  it("accepts a future reminder without a payment method",()=>expect(plannedOutgoingInputSchema.safeParse(base).success).toBe(true));
  it("rejects split parts above the planned total",()=>expect(plannedOutgoingInputSchema.safeParse({...base,paymentParts:[{methodType:"account",methodId:"00000000-0000-4000-8000-000000000001",amountPence:100001,paymentOn:null}]}).success).toBe(false));
  it("requires full stock details but does not create a purchase",()=>expect(plannedOutgoingInputSchema.safeParse({...base,kind:"stock_purchase"}).success).toBe(false));
});

describe("pending sale expected payment timing",()=>{
  const salesOrderIds=["00000000-0000-4000-8000-000000000001"];
  it("accepts an exact payment date",()=>expect(bulkSaleExpectedDateSchema.safeParse({salesOrderIds,dateKind:"exact",expectedDate:"2026-09-20"}).success).toBe(true));
  it("accepts a payment date range",()=>expect(bulkSaleExpectedDateSchema.safeParse({salesOrderIds,dateKind:"range",rangeStart:"2026-09-20",rangeEnd:"2026-09-27"}).success).toBe(true));
  it("accepts an unknown payment date",()=>expect(bulkSaleExpectedDateSchema.safeParse({salesOrderIds,dateKind:"unknown"}).success).toBe(true));
  it("rejects a backwards payment date range",()=>expect(bulkSaleExpectedDateSchema.safeParse({salesOrderIds,dateKind:"range",rangeStart:"2026-09-27",rangeEnd:"2026-09-20"}).success).toBe(false));
});

describe("manual incoming receipts",()=>{
  const receipt={incomingId:"00000000-0000-4000-8000-000000000001",receivedPence:2500,accountId:"00000000-0000-4000-8000-000000000002",receivedOn:"2026-09-04",paymentReference:"REF-1",notes:null,idempotencyKey:"00000000-0000-4000-8000-000000000003"};
  it("accepts a receipt into a selected bank account",()=>expect(receiveManualIncomingSchema.safeParse(receipt).success).toBe(true));
  it("rejects zero-value receipts",()=>expect(receiveManualIncomingSchema.safeParse({...receipt,receivedPence:0}).success).toBe(false));
});

describe("manual incoming edits",()=>{
  const edit={incomingId:"00000000-0000-4000-8000-000000000001",marketplace:"ebay",sourceName:"Old eBay account",description:"Historic sales payout",category:"Sales",paymentReference:null,amountPence:90040,dateKind:"range",expectedDate:null,rangeStart:"2026-09-12",rangeEnd:"2026-09-12"};
  it("accepts an update to an existing pending payment",()=>expect(editManualIncomingSchema.safeParse(edit).success).toBe(true));
  it("rejects a backwards expected-date range",()=>expect(editManualIncomingSchema.safeParse({...edit,rangeStart:"2026-09-13",rangeEnd:"2026-09-12"}).success).toBe(false));
});
