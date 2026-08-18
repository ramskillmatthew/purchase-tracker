import type { ItemDescriptionGroup } from "@/lib/types";

/**
 * Groups a flat list of per-unit description SNAPSHOTS (one entry per
 * sale_items row — see lib/types.ts's SaleItem.item_description_snapshot)
 * into "description × quantity" groups, preserving first-seen order.
 * Snapshots are immutable at sale time, so this never reflects a later edit
 * to the source purchase's description.
 */
export function groupItemDescriptions(descriptions: string[]): ItemDescriptionGroup[] {
  const groups: ItemDescriptionGroup[] = [];
  const indexByDescription = new Map<string, number>();
  for (const description of descriptions) {
    const existingIndex = indexByDescription.get(description);
    if (existingIndex !== undefined) groups[existingIndex] = { ...groups[existingIndex], quantity: groups[existingIndex].quantity + 1 };
    else {
      indexByDescription.set(description, groups.length);
      groups.push({ description, quantity: 1 });
    }
  }
  return groups;
}

export type ItemGroupSummary = { lines: string[]; overflowCount: number };

/**
 * The Sales history "Item Description" cell rule:
 *  - one group: a single line ("description", or "description × N" when
 *    N > 1).
 *  - a few groups (<= maxStacked): each group gets its own stacked line —
 *    still compact, still informative.
 *  - many groups (> maxStacked): only the first group's line, plus
 *    `overflowCount` (the caller renders "+ N more products").
 * Never mutates or truncates the underlying groups — the full list is
 * always available for the row's own detail page.
 */
export function summariseItemGroups(groups: ItemDescriptionGroup[], maxStacked = 3): ItemGroupSummary {
  const formatGroup = (group: ItemDescriptionGroup) => (group.quantity > 1 ? `${group.description} × ${group.quantity}` : group.description);
  if (groups.length === 0) return { lines: [], overflowCount: 0 };
  if (groups.length <= maxStacked) return { lines: groups.map(formatGroup), overflowCount: 0 };
  return { lines: [formatGroup(groups[0])], overflowCount: groups.length - 1 };
}

/** Flat, lowercased search haystack across every group's description — used by Sales history's search box alongside platform/status. */
export function itemGroupsSearchText(groups: ItemDescriptionGroup[]): string {
  return groups.map(group => group.description).join(" ").toLowerCase();
}
