// Shared "items per page" contract for the Purchases and Expenses tables —
// kept intentionally tiny (constants + pure helpers) rather than a generic
// table/pagination framework, since both pages already paginate an
// already-loaded, owner-scoped array client-side and just need to agree on
// the same allowed sizes and validation.

export const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];
export const DEFAULT_PAGE_SIZE: PageSize = 25;

export function isValidPageSize(value: unknown): value is PageSize {
  return typeof value === "number" && (PAGE_SIZE_OPTIONS as readonly number[]).includes(value);
}

// Pure so it can be unit-tested directly and reused by both pages' localStorage
// restore logic without the validation rule ever drifting between them. Any
// missing, malformed, or unsupported stored value safely falls back to the
// default rather than producing an invalid page size.
export function parseStoredPageSize(raw: string | null): PageSize {
  if (raw === null) return DEFAULT_PAGE_SIZE;
  const parsed = Number(raw);
  return isValidPageSize(parsed) ? parsed : DEFAULT_PAGE_SIZE;
}

export function totalPagesFor(recordCount: number, pageSize: PageSize): number {
  return Math.max(1, Math.ceil(recordCount / pageSize));
}
