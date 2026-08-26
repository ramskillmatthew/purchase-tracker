import { z } from "zod";

export const MAX_BULK_PURCHASE_UPDATES = 500;

export const bulkPurchaseUpdateSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(MAX_BULK_PURCHASE_UPDATES)
    .transform(ids => [...new Set(ids)]),
  stockStatus: z.enum(["in_stock", "no_longer_in_stock"]).optional(),
  arrived: z.boolean().optional(),
}).strict().refine(value => value.stockStatus !== undefined || value.arrived !== undefined, {
  message: "Choose at least one purchase field to update.",
});

export type BulkPurchaseUpdateInput = z.infer<typeof bulkPurchaseUpdateSchema>;
