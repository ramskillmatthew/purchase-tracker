// Matches only an exact, unmodified automatic name ("Product 3"), never a
// renamed group that happens to start with the word ("Product 3 (spare)"),
// so a manual rename permanently retires that slot from the sequence.
const AUTOMATIC_GROUP_NAME_PATTERN = /^Product (\d+)$/;

/**
 * The single source of truth for naming a newly auto-created product group.
 * Always (highest existing automatic "Product N" number) + 1 — never the
 * count of groups, so a deleted group's number is never reused. Every
 * automatic group-creation call site (the "+ New product" button, "Move/
 * Split → New group", and any future AI auto-grouping or import feature)
 * must go through this function rather than reimplementing the numbering.
 */
export function getNextAutomaticGroupName(groups: { title: string | null }[]): string {
  let highest = 0;
  for (const group of groups) {
    const match = group.title?.match(AUTOMATIC_GROUP_NAME_PATTERN);
    if (!match) continue;
    const n = Number(match[1]);
    if (n > highest) highest = n;
  }
  return `Product ${highest + 1}`;
}
