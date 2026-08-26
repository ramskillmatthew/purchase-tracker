import { z } from "zod";

// Sanity ceiling on the raw (pre-dedup) array only — guards against an
// abusive payload of e.g. tens of thousands of blank/duplicate lines before
// any parsing work happens. The real per-request limit that matters to
// users (MAX_BULK_ARRIVAL_SKUS, applied to the deduplicated list) is
// enforced in the route after parseSkuLines runs.
const MAX_RAW_SKU_LINES = 5000;

export const bulkArrivalsRequestSchema = z.object({
  action: z.enum(["preview", "update"]),
  skus: z.array(z.string().max(200)).min(1, "Enter at least one SKU.").max(MAX_RAW_SKU_LINES),
}).strict();
