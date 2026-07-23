/**
 * A stable identity for one physical item within one source email —
 * distinct from `order_reference` (the retailer's own order number, which
 * is deliberately left untouched, with no artificial suffix, since several
 * physical items in the same order legitimately share the same reference).
 *
 * Deterministic and pure: parsing the same email again always assigns the
 * same `itemIndex`/`unitIndex` to the same physical item (the parsers are
 * pure functions over the email's own content), so the same key is
 * produced on every re-scan — this is what lets the candidate upsert and
 * the purchases uniqueness constraint both key off a single stable column
 * instead of a fragile multi-column composite.
 */
export function sourceItemKey(messageId: string, itemIndex: number, unitIndex: number): string {
  return `${messageId}::${itemIndex}::${unitIndex}`;
}
