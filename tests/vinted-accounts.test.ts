import { describe, expect, it } from "vitest";
import { parseVintedAccountInputs, savedVintedAccounts, VINTED_ACCOUNTS_METADATA_KEY } from "@/lib/listing-dashboard/vinted-accounts";

describe("Vinted account numbering", () => {
  it("saves a custom account number separately from its colour slot", () => {
    expect(parseVintedAccountInputs([
      { slot: 1, number: 27, profileUrl: "https://www.vinted.co.uk/member/12345-first" },
      { slot: 2, number: 104, profileUrl: "https://www.vinted.co.uk/member/67890-second" },
      { slot: 3, number: 8, profileUrl: "" },
    ])).toEqual([
      { slot: 1, number: 27, profileUrl: "https://www.vinted.co.uk/member/12345-first", profileId: "12345", username: "first" },
      { slot: 2, number: 104, profileUrl: "https://www.vinted.co.uk/member/67890-second", profileId: "67890", username: "second" },
    ]);
  });

  it("keeps old account metadata working as slots 1, 2 and 3", () => {
    expect(savedVintedAccounts({
      [VINTED_ACCOUNTS_METADATA_KEY]: [{ number: 2, profileUrl: "https://www.vinted.co.uk/member/67890-second" }],
    })).toEqual([
      { slot: 2, number: 2, profileUrl: "https://www.vinted.co.uk/member/67890-second", profileId: "67890", username: "second" },
    ]);
  });

  it("rejects duplicate custom account numbers", () => {
    expect(() => parseVintedAccountInputs([
      { slot: 1, number: 27, profileUrl: "https://www.vinted.co.uk/member/12345-first" },
      { slot: 2, number: 27, profileUrl: "https://www.vinted.co.uk/member/67890-second" },
    ])).toThrow(/used more than once/i);
  });
});
