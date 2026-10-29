import { z } from "zod";
import { conditions,purchaseCategories } from "@/lib/validation/purchase";

const pence = z.number().int().safe();
const nonNegativePence = pence.min(0);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a valid date.");

export const financeDateSchema = z.discriminatedUnion("dateKind", [
  z.object({ dateKind: z.literal("exact"), expectedDate: isoDate, rangeStart: z.null().optional(), rangeEnd: z.null().optional() }),
  z.object({ dateKind: z.literal("range"), expectedDate: z.null().optional(), rangeStart: isoDate, rangeEnd: isoDate }).refine(value => value.rangeStart <= value.rangeEnd, { message: "The date range end must not be before its start." }),
  z.object({ dateKind: z.literal("unknown"), expectedDate: z.null().optional(), rangeStart: z.null().optional(), rangeEnd: z.null().optional() }),
]);

export const confirmMarketplacePayoutSchema = z.object({
  salesOrderIds: z.array(z.string().uuid()).min(1).max(500),
  receivedPence: nonNegativePence,
  accountId: z.string().uuid(),
  receivedOn: isoDate,
  paymentReference: z.string().trim().max(120).nullish(),
  varianceExplanation: z.string().trim().max(1000).nullish(),
  idempotencyKey: z.string().uuid(),
}).strict();

export const manualIncomingSchema = z.object({
  marketplace: z.enum(["vinted","ebay","other"]),
  sourceName: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(500),
  category: z.string().trim().min(1).max(100),
  paymentReference: z.string().trim().max(120).nullish(),
  amountPence: nonNegativePence.min(1),
  status: z.enum(["confirmed","estimated"]),
  dateKind: z.enum(["exact","range","unknown"]),
  expectedDate: isoDate.nullish(),
  rangeStart: isoDate.nullish(),
  rangeEnd: isoDate.nullish(),
  destinationAccountId: z.string().uuid().nullish(),
  notes: z.string().trim().max(2000).nullish(),
  idempotencyKey: z.string().uuid(),
}).strict().superRefine((value,ctx)=>{
  if(value.status==="confirmed"&&!value.destinationAccountId)ctx.addIssue({code:"custom",message:"Choose the account that received the money.",path:["destinationAccountId"]});
  if(value.dateKind==="exact"&&!value.expectedDate)ctx.addIssue({code:"custom",message:"Choose the date.",path:["expectedDate"]});
  if(value.dateKind==="range"&&(!value.rangeStart||!value.rangeEnd||value.rangeStart>value.rangeEnd))ctx.addIssue({code:"custom",message:"Choose a valid date range.",path:["rangeEnd"]});
});

export const receiveManualIncomingSchema = z.object({
  incomingId: z.string().uuid(),
  receivedPence: nonNegativePence.min(1),
  accountId: z.string().uuid(),
  receivedOn: isoDate,
  paymentReference: z.string().trim().max(120).nullish(),
  notes: z.string().trim().max(1000).nullish(),
  idempotencyKey: z.string().uuid(),
}).strict();
export const cancelManualIncomingSchema=z.object({incomingId:z.string().uuid(),reason:z.string().trim().min(1).max(500)}).strict();
export const editManualIncomingSchema=z.object({
  incomingId:z.string().uuid(), marketplace:z.enum(["vinted","ebay","other"]),
  sourceName:z.string().trim().min(1).max(120), description:z.string().trim().min(1).max(500),
  category:z.string().trim().min(1).max(100), paymentReference:z.string().trim().max(120).nullish(),
  amountPence:nonNegativePence.min(1), dateKind:z.enum(["exact","range","unknown"]),
  expectedDate:isoDate.nullish(), rangeStart:isoDate.nullish(), rangeEnd:isoDate.nullish(),
}).strict().superRefine((value,ctx)=>{
  if(value.dateKind==="exact"&&!value.expectedDate)ctx.addIssue({code:"custom",message:"Choose the date.",path:["expectedDate"]});
  if(value.dateKind==="range"&&(!value.rangeStart||!value.rangeEnd||value.rangeStart>value.rangeEnd))ctx.addIssue({code:"custom",message:"Choose a valid date range.",path:["rangeEnd"]});
});

const saleIds = z.array(z.string().uuid()).min(1).max(500);
export const bulkSaleExpectedDateSchema = z.discriminatedUnion("dateKind", [
  z.object({ salesOrderIds: saleIds, dateKind: z.literal("exact"), expectedDate: isoDate, rangeStart: z.null().optional(), rangeEnd: z.null().optional() }).strict(),
  z.object({ salesOrderIds: saleIds, dateKind: z.literal("range"), expectedDate: z.null().optional(), rangeStart: isoDate, rangeEnd: isoDate }).strict().refine(value => value.rangeStart <= value.rangeEnd, { message: "The date range end must not be before its start." }),
  z.object({ salesOrderIds: saleIds, dateKind: z.literal("unknown"), expectedDate: z.null().optional(), rangeStart: z.null().optional(), rangeEnd: z.null().optional() }).strict(),
]);

export const financeAccountInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  provider: z.string().trim().min(1).max(100),
  maskedDetails: z.string().trim().max(40).nullish(),
  openingBalancePence: pence,
}).strict();

export const financeCardInputSchema = z.object({
  name: z.string().trim().min(1).max(100), provider: z.string().trim().min(1).max(100), maskedDetails: z.string().trim().max(40).nullish(),
  openingBalancePence: pence, openingBusinessPence: pence, openingPersonalPence: pence,
  creditLimitPence: nonNegativePence, statementBalancePence: pence,
  statementDate: isoDate.nullish(), paymentDueDate: isoDate.nullish(), statementCycleDay: z.number().int().min(1).max(31).nullish(),
}).strict().refine(value => value.openingBusinessPence + value.openingPersonalPence === value.openingBalancePence, { message: "Business and personal portions must equal the opening balance." });

const paymentPart = z.object({ methodType:z.enum(["account","card"]), methodId:z.string().uuid(), amountPence:nonNegativePence.min(1), paymentOn:isoDate.nullish() }).strict();
const plannedPurchase = z.object({ purchasedFrom:z.string().trim().min(1).max(100), sellerName:z.string().trim().max(200).nullish(), sku:z.string().trim().max(100), itemDescription:z.string().trim().min(1).max(500), itemSize:z.string().trim().min(1).max(100), quantity:z.number().int().min(1).max(100), itemCondition:z.enum(conditions), category:z.enum(purchaseCategories), expectedArrivalDate:isoDate.nullish(), arrived:z.boolean().nullable().optional() }).strict();
const plannedExpense = z.object({ purchasedFrom:z.string().trim().min(1).max(100), itemDescription:z.string().trim().min(1).max(500), arrived:z.boolean().nullable().optional() }).strict();
export const plannedOutgoingInputSchema = z.object({
  kind:z.enum(["stock_purchase","expense","subscription","card_payment","other"]), description:z.string().trim().min(1).max(500), category:z.string().trim().max(100).nullish(), payee:z.string().trim().max(200).nullish(), totalPence:nonNegativePence.min(1),
  dateKind:z.enum(["exact","range","unknown"]), dueDate:isoDate.nullish(), rangeStart:isoDate.nullish(), rangeEnd:isoDate.nullish(), paymentReference:z.string().trim().max(120).nullish(), preferredMethodType:z.enum(["account","card"]).nullish(), preferredMethodId:z.string().uuid().nullish(), allocationId:z.string().uuid().nullish(), recurringMonthly:z.boolean(), notes:z.string().max(2000).nullish(), paymentParts:z.array(paymentPart).max(20), purchase:plannedPurchase.nullish(), expense:plannedExpense.nullish(),
}).strict().superRefine((v,ctx)=>{if(v.dateKind==="exact"&&!v.dueDate)ctx.addIssue({code:"custom",message:"Choose the planned payment date.",path:["dueDate"]});if(v.dateKind==="range"&&(!v.rangeStart||!v.rangeEnd||v.rangeStart>v.rangeEnd))ctx.addIssue({code:"custom",message:"Choose a valid date range.",path:["rangeEnd"]});if(Boolean(v.preferredMethodType)!==Boolean(v.preferredMethodId))ctx.addIssue({code:"custom",message:"Choose both parts of the preferred payment method.",path:["preferredMethodId"]});if(v.paymentParts.reduce((n,p)=>n+p.amountPence,0)>v.totalPence)ctx.addIssue({code:"custom",message:"Split payments cannot exceed the planned total.",path:["paymentParts"]});if(v.kind==="stock_purchase"&&!v.purchase)ctx.addIssue({code:"custom",message:"Enter the purchase details.",path:["purchase"]});if(v.kind==="expense"&&!v.expense)ctx.addIssue({code:"custom",message:"Enter the expense details.",path:["expense"]});});

export const completeOutgoingSchema = z.object({
  amountPence:nonNegativePence.min(1), paidOn:isoDate, finalise:z.boolean(), idempotencyKey:z.string().uuid(),
  paymentParts:z.array(paymentPart.extend({spendScope:z.enum(["business","personal"])}).strict()).min(1).max(20),
  actualPurchase:plannedPurchase.nullish(), actualExpense:plannedExpense.nullish(),
}).strict().superRefine((v,ctx)=>{if(v.paymentParts.reduce((n,p)=>n+p.amountPence,0)!==v.amountPence)ctx.addIssue({code:"custom",message:"Payment parts must equal the amount paid.",path:["paymentParts"]});});
export const cancelOutgoingSchema=z.object({outgoingId:z.string().uuid(),reason:z.string().trim().min(1).max(500)}).strict();

export const allocationInputSchema=z.object({name:z.string().trim().min(1).max(100),accountId:z.string().uuid(),startingBalancePence:nonNegativePence,targetPence:nonNegativePence.nullish(),deadline:isoDate.nullish(),reason:z.string().trim().max(500).nullish()}).strict();
export const allocationMovementSchema=z.object({type:z.enum(["add","release","move"]),allocationId:z.string().uuid(),otherAllocationId:z.string().uuid().nullish(),amountPence:nonNegativePence.min(1),reason:z.string().trim().min(1).max(500)}).strict().superRefine((v,ctx)=>{if(v.type==="move"&&!v.otherAllocationId)ctx.addIssue({code:"custom",message:"Choose the destination pot.",path:["otherAllocationId"]});if(v.otherAllocationId===v.allocationId)ctx.addIssue({code:"custom",message:"Choose a different destination pot.",path:["otherAllocationId"]});});
export const archiveAllocationSchema=z.object({allocationId:z.string().uuid(),reason:z.string().trim().min(1).max(500)}).strict();
export const accountTransferSchema=z.object({fromAccountId:z.string().uuid(),toAccountId:z.string().uuid(),amountPence:nonNegativePence.min(1),effectiveOn:isoDate,reference:z.string().trim().max(120).nullish(),reason:z.string().trim().min(1).max(500),idempotencyKey:z.string().uuid()}).strict().refine(v=>v.fromAccountId!==v.toAccountId,{message:"Choose two different accounts.",path:["toAccountId"]});
export const accountReconciliationSchema=z.object({accountId:z.string().uuid(),newBalancePence:pence,effectiveOn:isoDate,reason:z.string().trim().min(1).max(500),idempotencyKey:z.string().uuid()}).strict();
export const archiveAccountSchema=z.object({accountId:z.string().uuid(),reason:z.string().trim().min(1).max(500)}).strict();
export const cardUpdateSchema=z.object({cardId:z.string().uuid(),currentBalancePence:pence,businessBalancePence:pence,personalBalancePence:pence,creditLimitPence:nonNegativePence,statementBalancePence:pence,statementDate:isoDate.nullish(),paymentDueDate:isoDate.nullish(),reason:z.string().trim().min(1).max(500),idempotencyKey:z.string().uuid()}).strict().refine(v=>v.businessBalancePence+v.personalBalancePence===v.currentBalancePence,{message:"Business and personal portions must equal the card balance."});
export const cardPaymentSchema=z.object({cardId:z.string().uuid(),accountId:z.string().uuid(),amountPence:nonNegativePence.min(1),businessPence:nonNegativePence,personalPence:nonNegativePence,paidOn:isoDate,paymentType:z.enum(["partial","full_statement"]),idempotencyKey:z.string().uuid()}).strict().refine(v=>v.businessPence+v.personalPence===v.amountPence,{message:"Business and personal payment portions must equal the payment."});
export const archiveCardSchema=z.object({cardId:z.string().uuid(),reason:z.string().trim().min(1).max(500)}).strict();
