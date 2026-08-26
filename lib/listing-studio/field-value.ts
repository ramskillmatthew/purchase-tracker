import type { FieldValue, ListingFieldData, ListingFieldName } from "./types";

/**
 * The single rule this whole module exists to enforce: once a field is
 * userConfirmed, no later AI pass may silently replace it — the user must
 * explicitly opt back in via `forceReplace` (e.g. an explicit "Replace SKU
 * manually" / "Regenerate — replace confirmed values too" action). Without
 * `forceReplace`, a confirmed field is returned completely untouched, byte
 * for byte, regardless of what the incoming value says.
 */
export function mergeFieldValue<T>(existing: FieldValue<T> | undefined, incoming: FieldValue<T>, options?: { forceReplace?: boolean }): FieldValue<T> {
  if (existing?.userConfirmed && !options?.forceReplace) return existing;
  return incoming;
}

/**
 * Merges a full AI-pass result into the draft's existing field_data_json,
 * one field at a time via mergeFieldValue — so a single pass can update
 * some fields while leaving confirmed neighbours untouched. `forceReplaceFields`
 * lists the specific fields the user explicitly asked to regenerate over
 * their own confirmation (never applies app-wide by accident).
 */
export function mergeFieldData(existing: ListingFieldData, incoming: Partial<ListingFieldData>, options?: { forceReplaceFields?: ListingFieldName[] }): ListingFieldData {
  // Widened to a uniform record while writing — TypeScript can't prove a
  // value read under a generic key K writes back under that exact same K
  // in a mapped type, even though incoming[key] and existing[key] always
  // share the same K by construction of ListingFieldData at runtime.
  const result = { ...existing } as Record<ListingFieldName, FieldValue<unknown> | undefined>;
  const incomingRecord = incoming as Record<ListingFieldName, FieldValue<unknown> | undefined>;
  for (const key of Object.keys(incoming) as ListingFieldName[]) {
    const incomingValue = incomingRecord[key];
    if (!incomingValue) continue;
    const forceReplace = options?.forceReplaceFields?.includes(key) ?? false;
    result[key] = mergeFieldValue(result[key], incomingValue, { forceReplace });
  }
  return result as ListingFieldData;
}

/**
 * A user explicitly confirming a field's value — always wins from this
 * point on (source becomes "user", any prior conflict flag is cleared since
 * the human has now settled it).
 */
export function confirmField<T>(field: FieldValue<T> | undefined, value: T): FieldValue<T> {
  return {
    value,
    confidence: "high",
    source: "user",
    sourceImageId: field?.sourceImageId ?? null,
    aiGenerated: false,
    userConfirmed: true,
    conflict: false,
  };
}

/**
 * "Mark field as incorrect" — the inverse of confirmField. Clears the
 * confirmed flag (so a later regeneration is allowed to replace it again)
 * without inventing a new value; the field keeps whatever value it had so
 * the reviewer still sees what was wrong, just no longer trusted.
 */
export function markFieldIncorrect<T>(field: FieldValue<T>): FieldValue<T> {
  return { ...field, userConfirmed: false, confidence: "unconfirmed" };
}

/**
 * "Confirmed, or confident enough to treat as settled without a human
 * having explicitly confirmed it" — the gate lib/listing-studio/readiness.ts
 * uses for fields where a low-confidence AI guess must never be silently
 * treated as good enough for a Ready draft.
 */
export function isFieldConfirmedOrConfident<T>(field: FieldValue<T> | undefined): boolean {
  if (!field || field.value === null) return false;
  return field.userConfirmed || field.confidence === "high";
}
