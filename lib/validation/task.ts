import { z } from "zod";

export const taskCategories = ["General", "Stock", "Orders", "Listings", "Returns", "Finance", "Admin"] as const;
export const taskPriorities = ["Low", "Medium", "High"] as const;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// Client-editable fields only — completed/completed_at are a separate
// transition (see taskCompletionSchema) so a normal title/notes/category
// edit can never accidentally touch completion state, and completing a
// task can never smuggle in an edited title.
export const taskInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(2000).nullable().optional(),
  category: z.enum(taskCategories).default("General"),
  priority: z.enum(taskPriorities).default("Medium"),
  due_date: date.nullable().optional(),
}).strict();

// completed_at is deliberately not accepted here — the API route always
// derives it itself (now() when completing, null when un-completing),
// never trusting a client-supplied timestamp.
export const taskCompletionSchema = z.object({ completed: z.boolean() }).strict();
