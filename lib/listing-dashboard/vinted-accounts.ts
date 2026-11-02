import { normaliseVintedProfileUrl, type SavedVintedAccount, type VintedAccountSlot } from "./vinted-public-profile";

export const VINTED_ACCOUNTS_METADATA_KEY = "listing_dashboard_vinted_accounts";

export function savedVintedAccounts(metadata: Record<string, unknown> | null | undefined): SavedVintedAccount[] {
  const raw = metadata?.[VINTED_ACCOUNTS_METADATA_KEY];
  if (!Array.isArray(raw)) return [];
  const accounts: SavedVintedAccount[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const value = raw[index];
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const legacyNumber = Number(record.number);
    const slotValue = Number(record.slot);
    const slot = (slotValue === 1 || slotValue === 2 || slotValue === 3)
      ? slotValue as VintedAccountSlot
      : (legacyNumber === 1 || legacyNumber === 2 || legacyNumber === 3)
        ? legacyNumber as VintedAccountSlot
        : (index < 3 ? (index + 1) as VintedAccountSlot : null);
    const number = Number.isInteger(legacyNumber) && legacyNumber >= 1 && legacyNumber <= 9999 ? legacyNumber : slot;
    const profileUrl = record.profileUrl;
    if (!slot || !number || typeof profileUrl !== "string") continue;
    try { accounts.push(normaliseVintedProfileUrl(profileUrl, slot, number)); }
    catch { /* Ignore obsolete or malformed metadata rather than breaking the dashboard. */ }
  }
  return accounts.sort((left, right) => left.slot - right.slot);
}

export function parseVintedAccountInputs(values: Array<{ slot: VintedAccountSlot; number: number; profileUrl: string }>): SavedVintedAccount[] {
  const seenProfiles = new Set<string>();
  const seenNumbers = new Set<number>();
  const accounts: SavedVintedAccount[] = [];
  for (const value of values) {
    if (!value.profileUrl.trim()) continue;
    const account = normaliseVintedProfileUrl(value.profileUrl, value.slot, value.number);
    if (seenProfiles.has(account.profileId)) throw new Error("The same Vinted profile cannot be saved in more than one account slot.");
    if (seenNumbers.has(account.number)) throw new Error(`Vinted account #${account.number} is used more than once.`);
    seenProfiles.add(account.profileId);
    seenNumbers.add(account.number);
    accounts.push(account);
  }
  return accounts.sort((left, right) => left.slot - right.slot);
}
