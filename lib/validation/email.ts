import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const emailSearchSchema = z.object({
  terms: z.array(z.string().trim().min(1).max(120)).max(8).default([]),
  exactPhrase: z.string().trim().min(1).max(200).optional(),
  sender: z.string().trim().min(1).max(200).optional(), recipient: z.string().trim().min(1).max(200).optional(),
  subject: z.string().trim().min(1).max(200).optional(), startDate: isoDate.optional(), endDate: isoDate.optional(),
  folder: z.string().trim().min(1).max(250).optional(), readStatus: z.enum(["read", "unread", "any"]).default("any"),
  hasAttachments: z.boolean().optional(), attachmentFilename: z.string().trim().min(1).max(200).optional(),
  maxResults: z.coerce.number().int().min(1).max(25).default(10), cursor: z.string().max(1000).optional(),
}).strict().refine(value => !value.startDate || !value.endDate || value.startDate <= value.endDate, { message: "Start date must not be after end date." });

export const assistantRequestSchema = z.object({ message: z.string().trim().min(1).max(2000) }).strict();
export const getEmailSchema = z.object({ id: z.string().min(20).max(3000) }).strict();
export const dateRangeSchema = z.object({ startDate: isoDate, endDate: isoDate }).strict().refine(v => v.startDate <= v.endDate, { message: "Invalid date range." });
export type EmailSearch = z.infer<typeof emailSearchSchema>;

