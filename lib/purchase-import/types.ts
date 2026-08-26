import { z } from "zod";

/**
 * The shared, order-shaped output of every extraction source (deterministic
 * Vinted parser, deterministic general-retailer parser, and the Claude
 * fallback in ai-extract.ts) — one order, potentially several distinct line
 * items, each with its own quantity. lib/purchase-import/allocate.ts then
 * expands `items` into one candidate row per physical unit and allocates
 * `totalPaidPence` across them. Kept as a single strict schema so every
 * extraction source is held to exactly the same shape and the sync route
 * never needs to special-case which source produced a given order.
 */
export const parsedOrderItemSchema = z.object({
  description: z.string().trim().min(1).max(200),
  size: z.string().trim().max(100).nullable(),
  condition: z.string().trim().max(100).nullable(),
  quantity: z.number().int().min(1).max(100),
  // CONTRACT: the TOTAL price for this whole line — i.e. unit price ×
  // quantity, all units combined — never a single unit's price. Two units
  // at £20 each is linePricePence 4000, not 2000. This is what makes it
  // usable directly as allocate.ts's inter-item proportional weight without
  // any further multiplication by quantity; getting this wrong for a
  // multi-item order where some item also has quantity > 1 would silently
  // under- or over-weight that item's true share of the order total. Before
  // shared delivery/fees are folded in. null when the source couldn't
  // reliably isolate this line's total.
  linePricePence: z.number().int().nonnegative().nullable(),
}).strict();

export const parsedOrderSchema = z.object({
  messageId: z.string().min(1),
  emailDate: z.string().datetime(),
  sender: z.string().min(1),
  subject: z.string().min(1),
  orderReference: z.string().nullable(),
  sellerName: z.string().nullable(),
  purchasedFrom: z.string().trim().min(1).max(100),
  candidateType: z.enum(["vinted", "general"]),
  purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  dispatchStatus: z.string().nullable(),
  deliveryStatus: z.string().nullable(),
  cancellationRefundStatus: z.string().nullable(),
  items: z.array(parsedOrderItemSchema).min(1).max(30),
  // The complete landed cost — every unavoidable item/delivery/fee charge,
  // discounts already applied. The single source of truth allocate.ts
  // splits across the expanded rows; never re-derived by summing item
  // lines (a line-level total can be incomplete where the complete total
  // is known confidently, e.g. a Vinted "Paid" line).
  totalPaidPence: z.number().int().nonnegative().nullable(),
  parserConfidence: z.number().min(0).max(1),
  fingerprint: z.string().length(64),
  sanitizedExcerpt: z.string().max(500),
  uncertaintyReasons: z.array(z.string()).max(20),
}).strict();

export type ParsedOrderItem = z.infer<typeof parsedOrderItemSchema>;
export type ParsedOrder = z.infer<typeof parsedOrderSchema>;
