import { z } from "zod";

export const conditions = ["Brand new", "Brand new without tags", "Labelled as very good condition", "Good condition from photos", "Decent condition from photos"] as const;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const purchaseInputSchema = z.object({
  order_date: date, purchased_from: z.string().trim().min(1).max(100), seller_name: z.string().trim().max(200).nullable().optional(),
  sku: z.string().trim().max(100), item_description: z.string().trim().min(1).max(500), item_size: z.string().trim().min(1).max(100),
  quantity: z.coerce.number().int().min(1).max(100), item_condition: z.enum(conditions), price_purchased: z.coerce.number().nonnegative().max(99999999), arrived: z.boolean().nullable().optional(),
}).strict();
export const expenseInputSchema = z.object({ purchase_date: date, purchased_from: z.string().trim().min(1).max(100), arrived: z.boolean().nullable().optional(), item_description: z.string().trim().min(1).max(500), cost: z.coerce.number().nonnegative().max(99999999) }).strict();
