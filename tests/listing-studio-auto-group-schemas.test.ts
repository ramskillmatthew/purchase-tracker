import { describe, expect, it } from "vitest";
import {
  autoGroupToolInputSchema, describeAutoGroupFailure, reconcileAutoGroupSession,
  truncateOverlongBoundaryReasons, BOUNDARY_REASON_MAX_LENGTH, WARNING_TEXT_MAX_LENGTH,
  AUTO_GROUP_TOOL, AUTO_GROUP_SYSTEM_PROMPT, type AutoGroupToolInput, type RawBoundaryProposal,
} from "@/lib/listing-studio/auto-group-schemas";
import { autoGroupAnalyzeRequestSchema, applyAutoGroupProposalRequestSchema, applyAutoGroupSessionRequestSchema } from "@/lib/validation/listing-studio-uploads";
import { MAX_AUTO_GROUP_BATCH_SIZE, MAX_AUTO_GROUP_SESSION_SIZE } from "@/lib/listing-studio/upload-limits";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function boundaryGroup(overrides: Partial<RawBoundaryProposal> = {}): RawBoundaryProposal {
  return {
    proposedGroupId: "group-1", startSequenceIndex: 1, endSequenceIndex: 2,
    orderedImageIds: [uuid(1), uuid(2)], confidence: "high",
    boundaryReason: "Same white sneaker visible in every photo, including the sole and label shots.",
    continuesFromPreviousChunk: false, warnings: [],
    ...overrides,
  };
}

describe("autoGroupToolInputSchema — ordered boundary-detection schema validation (v3)", () => {
  it("accepts a well-formed contiguous-range tool input", () => {
    const input: AutoGroupToolInput = { groups: [boundaryGroup()], ungroupedImageIds: [uuid(3)] };
    expect(autoGroupToolInputSchema.safeParse(input).success).toBe(true);
  });

  it("rejects an extra, unexpected field on the top level and on a group (.strict())", () => {
    expect(autoGroupToolInputSchema.safeParse({ groups: [boundaryGroup()], ungroupedImageIds: [], madeUp: 1 }).success).toBe(false);
    expect(autoGroupToolInputSchema.safeParse({ groups: [{ ...boundaryGroup(), madeUp: 1 }], ungroupedImageIds: [] }).success).toBe(false);
  });

  it("rejects a confidence value outside the closed high/medium/low set", () => {
    const input = { groups: [boundaryGroup({ confidence: "certain" as unknown as "high" })], ungroupedImageIds: [] };
    expect(autoGroupToolInputSchema.safeParse(input).success).toBe(false);
  });

  it("rejects a malformed (non-uuid) image id in orderedImageIds", () => {
    const input = { groups: [boundaryGroup({ orderedImageIds: ["not-a-real-id"] })], ungroupedImageIds: [] };
    expect(autoGroupToolInputSchema.safeParse(input).success).toBe(false);
  });

  it("rejects a group missing continuesFromPreviousChunk — every field is required, no silent omission", () => {
    const { continuesFromPreviousChunk: _omit, ...withoutFlag } = boundaryGroup();
    expect(autoGroupToolInputSchema.safeParse({ groups: [withoutFlag], ungroupedImageIds: [] }).success).toBe(false);
  });

  it("rejects a group missing startSequenceIndex/endSequenceIndex", () => {
    const { startSequenceIndex: _s, ...withoutStart } = boundaryGroup();
    expect(autoGroupToolInputSchema.safeParse({ groups: [withoutStart], ungroupedImageIds: [] }).success).toBe(false);
  });

  it("rejects a non-integer or non-positive sequence index", () => {
    expect(autoGroupToolInputSchema.safeParse({ groups: [boundaryGroup({ startSequenceIndex: 1.5 })], ungroupedImageIds: [] }).success).toBe(false);
    expect(autoGroupToolInputSchema.safeParse({ groups: [boundaryGroup({ startSequenceIndex: 0 })], ungroupedImageIds: [] }).success).toBe(false);
  });

  it("accepts an empty groups array (every photo left ungrouped)", () => {
    const input: AutoGroupToolInput = { groups: [], ungroupedImageIds: [uuid(1), uuid(2)] };
    expect(autoGroupToolInputSchema.safeParse(input).success).toBe(true);
  });
});

describe("AUTO_GROUP_TOOL — forced tool-use schema (v3 boundary shape)", () => {
  it("requires every boundary field, including the new sequence/continuation fields", () => {
    expect(AUTO_GROUP_TOOL.input_schema.required).toEqual(["groups", "ungroupedImageIds"]);
    const groupSchema = (AUTO_GROUP_TOOL.input_schema.properties as Record<string, { items: { required: string[] } }>).groups.items;
    expect(groupSchema.required).toEqual([
      "proposedGroupId", "startSequenceIndex", "endSequenceIndex", "orderedImageIds", "confidence", "boundaryReason", "continuesFromPreviousChunk", "warnings",
    ]);
  });

  it("rejects any field the model might invent beyond the schema (additionalProperties: false), at both levels", () => {
    expect(AUTO_GROUP_TOOL.input_schema.additionalProperties).toBe(false);
    const groupSchema = (AUTO_GROUP_TOOL.input_schema.properties as Record<string, { items: { additionalProperties: boolean } }>).groups.items;
    expect(groupSchema.additionalProperties).toBe(false);
  });

  it("has a stable name matching what lib/listing-studio/auto-group-ai.ts forces via tool_choice", () => {
    expect(AUTO_GROUP_TOOL.name).toBe("propose_product_groups");
  });
});

describe("describeAutoGroupFailure", () => {
  it("returns a fixed, safe sentence for every failure category — never a raw error or model output", () => {
    for (const status of ["not_configured", "request_failed", "no_tool_call", "invalid_output"] as const) {
      expect(typeof describeAutoGroupFailure(status)).toBe("string");
      expect(describeAutoGroupFailure(status).length).toBeGreaterThan(0);
    }
  });
});

describe("AUTO_GROUP_SYSTEM_PROMPT — REGRESSION (v3): ordered boundary detection replacing free clustering", () => {
  // A real 24-photo/3-pair live test still over-split two of three
  // products under v2's free-clustering prompt (the model's own reasoning
  // admitted a fragment might be the same item as another group). v3
  // reframes the task entirely around the real photography workflow:
  // detecting boundaries in an ordered sequence, not clustering an
  // unordered set. These assertions pin the exact instructions that fix
  // that, so a future prompt edit can't silently drop any of them.

  it("states the exact sequence prior verbatim, in the exact wording requested", () => {
    expect(AUTO_GROUP_SYSTEM_PROMPT).toContain("ADJACENT PHOTOS ARE PRESUMED TO SHOW THE SAME PHYSICAL PRODUCT UNLESS THERE IS POSITIVE VISUAL EVIDENCE OF A PRODUCT CHANGE");
  });

  it("frames the task as ordered boundary detection, not free clustering", () => {
    expect(AUTO_GROUP_SYSTEM_PROMPT).toMatch(/NOT to freely cluster photos by similarity/i);
    expect(AUTO_GROUP_SYSTEM_PROMPT).toMatch(/photography order/i);
    expect(AUTO_GROUP_SYSTEM_PROMPT).toMatch(/contiguous sequence ranges/i);
  });

  it("lists every required non-boundary example: full-to-close-up, pair-to-one-shoe, outer-to-inner, upper-to-sole, product-to-label, wide-to-zoom", () => {
    expect(AUTO_GROUP_SYSTEM_PROMPT).toContain("full product to close-up");
    expect(AUTO_GROUP_SYSTEM_PROMPT).toContain("pair to one shoe");
    expect(AUTO_GROUP_SYSTEM_PROMPT).toContain("outer side to inner side");
    expect(AUTO_GROUP_SYSTEM_PROMPT).toContain("upper to sole");
    expect(AUTO_GROUP_SYSTEM_PROMPT).toContain("product view to size label");
    expect(AUTO_GROUP_SYSTEM_PROMPT).toContain("wide shot to zoomed detail");
  });

  it("lists every required positive boundary-evidence example", () => {
    for (const cue of ["different shoe model or silhouette", "different colourway or pattern", "different sole construction", "different branding arrangement", "clearly different item type", "new repeated set of full-product views"]) {
      expect(AUTO_GROUP_SYSTEM_PROMPT.toLowerCase()).toContain(cue.toLowerCase());
    }
  });

  it("lists every required non-boundary-evidence example a second time, in the dedicated 'NOT boundary evidence' list", () => {
    const notEvidenceSection = AUTO_GROUP_SYSTEM_PROMPT.slice(AUTO_GROUP_SYSTEM_PROMPT.indexOf("NOT boundary evidence"));
    expect(notEvidenceSection).toMatch(/logo/i);
    expect(notEvidenceSection).toMatch(/pair.*one shoe/i);
    expect(notEvidenceSection).toMatch(/rotated/i);
    expect(notEvidenceSection).toMatch(/camera distance/i);
    expect(notEvidenceSection).toMatch(/sole, inside label, or size tag/i);
    expect(notEvidenceSection).toMatch(/lighting\/background\/crop/i);
  });

  it("includes the exact worked regression example (photos 1-8 one product, photo 9 only a boundary with positive evidence)", () => {
    expect(AUTO_GROUP_SYSTEM_PROMPT).toContain("photos 1-3 are full and angled views of one shoe pair");
    expect(AUTO_GROUP_SYSTEM_PROMPT).toContain("photos 4-5 are top-down and inside views of the same pair");
    expect(AUTO_GROUP_SYSTEM_PROMPT).toContain("photos 6-7 are sole and size-label details of the same pair");
    expect(AUTO_GROUP_SYSTEM_PROMPT).toContain("photo 8 is another detail view of the same pair");
    expect(AUTO_GROUP_SYSTEM_PROMPT).toMatch(/Photos 1-8 must be reported as ONE product group/);
    expect(AUTO_GROUP_SYSTEM_PROMPT).toMatch(/Photo 9 only starts a new group if it visibly shows a different physical product/);
  });

  it("warns that a batch may contain several similar products, so similarity alone is never enough (the reverse failure mode)", () => {
    expect(AUTO_GROUP_SYSTEM_PROMPT).toMatch(/similarity alone is never enough/i);
  });

  it("explains the cross-chunk continuation mechanism: context photos, and the continuesFromPreviousChunk field", () => {
    expect(AUTO_GROUP_SYSTEM_PROMPT).toMatch(/context from a previous batch/i);
    expect(AUTO_GROUP_SYSTEM_PROMPT).toContain("continuesFromPreviousChunk");
    expect(AUTO_GROUP_SYSTEM_PROMPT).toMatch(/only meaningful for the very first group/i);
  });

  it("requires boundaryReason to name the strongest identifying cues, with the same good/bad examples as before", () => {
    expect(AUTO_GROUP_SYSTEM_PROMPT).toContain("Same leopard-print upper, identical black sole pattern and matching size label; close-ups and full-pair views show the same item.");
    expect(AUTO_GROUP_SYSTEM_PROMPT).toContain("These images look similar.");
    expect(AUTO_GROUP_SYSTEM_PROMPT).toMatch(/is not acceptable/i);
  });

  it("still preserves the confidence-level semantics (high/medium/low) unchanged by the rewrite", () => {
    expect(AUTO_GROUP_SYSTEM_PROMPT).toMatch(/"high" confidence only when you are genuinely certain/i);
    expect(AUTO_GROUP_SYSTEM_PROMPT).toMatch(/"medium" when a range plausibly is one product/i);
    expect(AUTO_GROUP_SYSTEM_PROMPT).toMatch(/"low" for a weak or speculative boundary decision/i);
  });

  it("still forces exactly one tool call", () => {
    expect(AUTO_GROUP_SYSTEM_PROMPT).toMatch(/must call the propose_product_groups tool exactly once/i);
  });
});

describe("truncateOverlongBoundaryReasons — the reasoning-length safety net (unchanged behaviour, renamed field)", () => {
  it("leaves boundaryReason untouched when it's already within the limit", () => {
    const input = { groups: [boundaryGroup()], ungroupedImageIds: [] };
    expect(truncateOverlongBoundaryReasons(input)).toEqual(input);
  });

  it("truncates boundaryReason over the limit to exactly BOUNDARY_REASON_MAX_LENGTH characters, with a trailing ellipsis", () => {
    const tooLong = "d".repeat(BOUNDARY_REASON_MAX_LENGTH + 500);
    const input = { groups: [boundaryGroup({ boundaryReason: tooLong })], ungroupedImageIds: [] };
    const truncated = truncateOverlongBoundaryReasons(input) as AutoGroupToolInput;
    expect(truncated.groups[0].boundaryReason.length).toBe(BOUNDARY_REASON_MAX_LENGTH);
    expect(truncated.groups[0].boundaryReason.endsWith("…")).toBe(true);
  });

  it("the truncated result then passes schema validation, where the original over-length input would have failed", () => {
    const tooLong = "e".repeat(BOUNDARY_REASON_MAX_LENGTH + 500);
    const input = { groups: [boundaryGroup({ boundaryReason: tooLong })], ungroupedImageIds: [] };
    expect(autoGroupToolInputSchema.safeParse(input).success).toBe(false);
    expect(autoGroupToolInputSchema.safeParse(truncateOverlongBoundaryReasons(input)).success).toBe(true);
  });

  it("is tolerant of a completely malformed input shape — returns it untouched rather than throwing", () => {
    expect(truncateOverlongBoundaryReasons(null)).toBeNull();
    expect(truncateOverlongBoundaryReasons({ groups: "not an array" })).toEqual({ groups: "not an array" });
  });

  // REGRESSION: a real 38-photo mixed-order live run failed schema
  // validation with `code: too_big, maximum: 300` — NOT on boundaryReason
  // (already generously capped at 1500 by the fix above), but on
  // `warnings[]`, which still had the old, brittle 300-character cap. Same
  // class of bug as the original reasoning-length regression; same fix.
  describe("REGRESSION: warnings[] entries are sanitised the same way boundaryReason is", () => {
    it("leaves a warning untouched when it's already within WARNING_TEXT_MAX_LENGTH", () => {
      const input = { groups: [boundaryGroup({ warnings: ["one photo is blurry"] })], ungroupedImageIds: [] };
      expect(truncateOverlongBoundaryReasons(input)).toEqual(input);
    });

    it("truncates a warning over WARNING_TEXT_MAX_LENGTH to exactly that length, with a trailing ellipsis", () => {
      const tooLong = "w".repeat(WARNING_TEXT_MAX_LENGTH + 200);
      const input = { groups: [boundaryGroup({ warnings: [tooLong] })], ungroupedImageIds: [] };
      const truncated = truncateOverlongBoundaryReasons(input) as AutoGroupToolInput;
      expect(truncated.groups[0].warnings[0].length).toBe(WARNING_TEXT_MAX_LENGTH);
      expect(truncated.groups[0].warnings[0].endsWith("…")).toBe(true);
    });

    it("a warning over the OLD 300-character limit (the exact reported live failure) now passes schema validation after sanitisation", () => {
      const overOldLimit = "x".repeat(320);
      const input = { groups: [boundaryGroup({ warnings: [overOldLimit] })], ungroupedImageIds: [] };
      expect(autoGroupToolInputSchema.safeParse(input).success).toBe(true); // 320 < WARNING_TEXT_MAX_LENGTH (500) already
      expect(WARNING_TEXT_MAX_LENGTH).toBeGreaterThan(300); // the cap itself was raised, not just papered over by truncation
    });

    it("truncates only the specific over-length warning within a group's warnings array, leaving shorter sibling warnings untouched", () => {
      const tooLong = "y".repeat(WARNING_TEXT_MAX_LENGTH + 50);
      const input = { groups: [boundaryGroup({ warnings: ["short note", tooLong, "another short note"] })], ungroupedImageIds: [] };
      const truncated = truncateOverlongBoundaryReasons(input) as AutoGroupToolInput;
      expect(truncated.groups[0].warnings[0]).toBe("short note");
      expect(truncated.groups[0].warnings[1].length).toBe(WARNING_TEXT_MAX_LENGTH);
      expect(truncated.groups[0].warnings[2]).toBe("another short note");
    });

    it("sanitises boundaryReason and warnings independently — an over-length warning alongside a perfectly fine boundaryReason doesn't touch the boundaryReason, and vice versa", () => {
      const input = {
        groups: [boundaryGroup({ boundaryReason: "A perfectly normal, short reason.", warnings: ["z".repeat(WARNING_TEXT_MAX_LENGTH + 10)] })],
        ungroupedImageIds: [],
      };
      const truncated = truncateOverlongBoundaryReasons(input) as AutoGroupToolInput;
      expect(truncated.groups[0].boundaryReason).toBe("A perfectly normal, short reason.");
      expect(truncated.groups[0].warnings[0].length).toBe(WARNING_TEXT_MAX_LENGTH);
    });
  });

  it("REGRESSION: multiple groups in the same response are sanitised independently — one group's over-length text never affects another group's fields", () => {
    const input = {
      groups: [
        boundaryGroup({ proposedGroupId: "group-1", boundaryReason: "b".repeat(BOUNDARY_REASON_MAX_LENGTH + 100), warnings: [] }),
        boundaryGroup({ proposedGroupId: "group-2", boundaryReason: "A short, perfectly valid reason.", warnings: ["c".repeat(WARNING_TEXT_MAX_LENGTH + 100)] }),
        boundaryGroup({ proposedGroupId: "group-3", boundaryReason: "Another short, valid reason.", warnings: ["already fine"] }),
      ],
      ungroupedImageIds: [],
    };
    const truncated = truncateOverlongBoundaryReasons(input) as AutoGroupToolInput;
    expect(truncated.groups[0].boundaryReason.length).toBe(BOUNDARY_REASON_MAX_LENGTH);
    expect(truncated.groups[1].boundaryReason).toBe("A short, perfectly valid reason.");
    expect(truncated.groups[1].warnings[0].length).toBe(WARNING_TEXT_MAX_LENGTH);
    expect(truncated.groups[2].boundaryReason).toBe("Another short, valid reason.");
    expect(truncated.groups[2].warnings).toEqual(["already fine"]);
  });

  it("REGRESSION: sanitisation never mutates image ids, sequence indexes, confidence, or continuesFromPreviousChunk — only boundaryReason/warnings text can ever change", () => {
    const input = {
      groups: [boundaryGroup({
        proposedGroupId: "group-1", startSequenceIndex: 7, endSequenceIndex: 9,
        orderedImageIds: [uuid(7), uuid(8), uuid(9)], confidence: "medium",
        boundaryReason: "b".repeat(BOUNDARY_REASON_MAX_LENGTH + 100),
        continuesFromPreviousChunk: true, warnings: ["w".repeat(WARNING_TEXT_MAX_LENGTH + 100)],
      })],
      ungroupedImageIds: [uuid(10)],
    };
    const truncated = truncateOverlongBoundaryReasons(input) as AutoGroupToolInput;
    expect(truncated.groups[0].proposedGroupId).toBe("group-1");
    expect(truncated.groups[0].startSequenceIndex).toBe(7);
    expect(truncated.groups[0].endSequenceIndex).toBe(9);
    expect(truncated.groups[0].orderedImageIds).toEqual([uuid(7), uuid(8), uuid(9)]);
    expect(truncated.groups[0].confidence).toBe("medium");
    expect(truncated.groups[0].continuesFromPreviousChunk).toBe(true);
    expect(truncated.ungroupedImageIds).toEqual([uuid(10)]);
  });
});

describe("MAX_AUTO_GROUP_SESSION_SIZE / MAX_AUTO_GROUP_BATCH_SIZE — a whole normal listing session in one click", () => {
  it("targets roughly 30 products' worth of photos per click, chunked into several safely-bounded per-request calls", () => {
    expect(MAX_AUTO_GROUP_SESSION_SIZE).toBe(250);
    expect(MAX_AUTO_GROUP_BATCH_SIZE).toBe(40);
    expect(Math.ceil(MAX_AUTO_GROUP_SESSION_SIZE / MAX_AUTO_GROUP_BATCH_SIZE)).toBe(7);
  });
});

describe("autoGroupAnalyzeRequestSchema — one chunk's worth of ids, plus optional overlap context and a sequence start", () => {
  it("accepts a well-formed chunk request, with and without overlap context", () => {
    expect(autoGroupAnalyzeRequestSchema.safeParse({ imageIds: [uuid(1), uuid(2)], chunkStartSequenceIndex: 1 }).success).toBe(true);
    expect(autoGroupAnalyzeRequestSchema.safeParse({ imageIds: [uuid(1)], overlapImageIds: [uuid(99)], chunkStartSequenceIndex: 41 }).success).toBe(true);
  });

  it("rejects a missing chunkStartSequenceIndex, an empty imageIds array, or a chunk larger than MAX_AUTO_GROUP_BATCH_SIZE", () => {
    expect(autoGroupAnalyzeRequestSchema.safeParse({ imageIds: [uuid(1)] }).success).toBe(false);
    expect(autoGroupAnalyzeRequestSchema.safeParse({ imageIds: [], chunkStartSequenceIndex: 1 }).success).toBe(false);
    const tooMany = Array.from({ length: MAX_AUTO_GROUP_BATCH_SIZE + 1 }, (_, i) => uuid(i));
    expect(autoGroupAnalyzeRequestSchema.safeParse({ imageIds: tooMany, chunkStartSequenceIndex: 1 }).success).toBe(false);
  });
});

describe("applyAutoGroupSessionRequestSchema — the full-session apply request", () => {
  it("accepts a well-formed session (ids in order, one or more chunk results)", () => {
    const chunkResult: AutoGroupToolInput = { groups: [boundaryGroup()], ungroupedImageIds: [] };
    expect(applyAutoGroupSessionRequestSchema.safeParse({ imageIds: [uuid(1), uuid(2)], chunkResults: [chunkResult] }).success).toBe(true);
  });

  it("rejects an empty chunkResults array or an empty imageIds array", () => {
    expect(applyAutoGroupSessionRequestSchema.safeParse({ imageIds: [uuid(1)], chunkResults: [] }).success).toBe(false);
    expect(applyAutoGroupSessionRequestSchema.safeParse({ imageIds: [], chunkResults: [{ groups: [], ungroupedImageIds: [] }] }).success).toBe(false);
  });

  it("re-validates each chunk result against the same strict boundary schema — a malformed chunk result is rejected here too", () => {
    const malformed = { groups: [{ ...boundaryGroup(), confidence: "certain" }], ungroupedImageIds: [] };
    expect(applyAutoGroupSessionRequestSchema.safeParse({ imageIds: [uuid(1)], chunkResults: [malformed] }).success).toBe(false);
  });
});

describe("applyAutoGroupProposalRequestSchema — unchanged by the v3 redesign (a proposal's imageIds are already a resolved, contiguous list by the time this is called)", () => {
  it("accepts a well-formed set of image ids", () => {
    expect(applyAutoGroupProposalRequestSchema.safeParse({ imageIds: [uuid(1), uuid(2)] }).success).toBe(true);
  });
});

// ============================================================================
// reconcileAutoGroupSession — meaningful tests of the actual reconciliation
// and validation machinery, not just "does it accept an already-correct
// answer" (see the file's own instructions on this point).
// ============================================================================

describe("reconcileAutoGroupSession — structural validation (the real enforcement point)", () => {
  const eligible = Array.from({ length: 10 }, (_, i) => ({ id: uuid(i + 1) }));

  it("REGRESSION: rejects a non-contiguous range — orderedImageIds length must exactly match endSequenceIndex - startSequenceIndex + 1", () => {
    const raw: AutoGroupToolInput = { groups: [boundaryGroup({ startSequenceIndex: 1, endSequenceIndex: 3, orderedImageIds: [uuid(1), uuid(2)] })], ungroupedImageIds: [] };
    const result = reconcileAutoGroupSession([raw], eligible);
    expect(result.applyAutomatically).toHaveLength(0);
    expect(result.validationWarnings.some(w => w.includes("non-contiguous"))).toBe(true);
    // both images fall back to Unsorted — never silently dropped
    expect(result.leftInUnsortedImageIds).toEqual(expect.arrayContaining(eligible.map(i => i.id)));
  });

  it("REGRESSION: rejects a range whose orderedImageIds don't match the real photos at those sequence positions", () => {
    const raw: AutoGroupToolInput = { groups: [boundaryGroup({ startSequenceIndex: 1, endSequenceIndex: 2, orderedImageIds: [uuid(1), uuid(5)] /* wrong — position 2 is uuid(2) */ })], ungroupedImageIds: [] };
    const result = reconcileAutoGroupSession([raw], eligible);
    expect(result.applyAutomatically).toHaveLength(0);
    expect(result.validationWarnings.some(w => w.includes("don't match the real photos"))).toBe(true);
  });

  it("this is also how an unknown, hallucinated image id is rejected — it can never match a real sequence position", () => {
    const raw: AutoGroupToolInput = { groups: [boundaryGroup({ startSequenceIndex: 1, endSequenceIndex: 2, orderedImageIds: [uuid(1), uuid(999)] })], ungroupedImageIds: [] };
    const result = reconcileAutoGroupSession([raw], eligible);
    expect(result.applyAutomatically).toHaveLength(0);
    const allAccepted = [...result.applyAutomatically, ...result.needsReview].flatMap(g => g.imageIds);
    expect(allAccepted).not.toContain(uuid(999));
  });

  it("this is also how a cross-owner or no-longer-in-Unsorted image is rejected — by construction, it's simply not in the eligible set the caller derived from a fresh, owner+Unsorted-scoped query", () => {
    // Simulates a stray id belonging to another owner or already moved
    // elsewhere: it was never part of `eligible`, so any range naming it
    // fails the same match check as any other unknown id.
    const strayId = uuid(500);
    const raw: AutoGroupToolInput = { groups: [boundaryGroup({ startSequenceIndex: 1, endSequenceIndex: 2, orderedImageIds: [uuid(1), strayId] })], ungroupedImageIds: [] };
    const result = reconcileAutoGroupSession([raw], eligible);
    expect(result.applyAutomatically).toHaveLength(0);
  });

  it("rejects a range containing an internal duplicate id even if the length happens to match", () => {
    const raw: AutoGroupToolInput = { groups: [boundaryGroup({ startSequenceIndex: 1, endSequenceIndex: 2, orderedImageIds: [uuid(1), uuid(1)] })], ungroupedImageIds: [] };
    const result = reconcileAutoGroupSession([raw], eligible);
    expect(result.applyAutomatically).toHaveLength(0);
    expect(result.validationWarnings.some(w => w.includes("duplicate"))).toBe(true);
  });

  it("REGRESSION: rejects overlapping ranges entirely — the later, overlapping proposal is discarded whole, never partially accepted", () => {
    const raw: AutoGroupToolInput = {
      groups: [
        boundaryGroup({ proposedGroupId: "g1", startSequenceIndex: 1, endSequenceIndex: 4, orderedImageIds: [uuid(1), uuid(2), uuid(3), uuid(4)] }),
        boundaryGroup({ proposedGroupId: "g2", startSequenceIndex: 3, endSequenceIndex: 6, orderedImageIds: [uuid(3), uuid(4), uuid(5), uuid(6)] }), // overlaps 3-4
      ],
      ungroupedImageIds: [],
    };
    const result = reconcileAutoGroupSession([raw], eligible);
    expect(result.applyAutomatically).toHaveLength(1);
    expect(result.applyAutomatically[0].proposedGroupId).toBe("g1");
    expect(result.validationWarnings.some(w => w.includes("overlaps"))).toBe(true);
    // g2's non-overlapping tail (5, 6) is NOT silently rescued into its own
    // group — the whole overlapping proposal is discarded, exactly as the
    // spec requires ("Validation must reject: overlapping ranges").
    expect(result.leftInUnsortedImageIds).toEqual(expect.arrayContaining([uuid(5), uuid(6)]));
  });

  it("every eligible image ends in exactly one place: an applied group, a review group, or leftInUnsortedImageIds — never lost, never duplicated", () => {
    const raw: AutoGroupToolInput = {
      groups: [
        boundaryGroup({ proposedGroupId: "g1", startSequenceIndex: 1, endSequenceIndex: 3, orderedImageIds: [uuid(1), uuid(2), uuid(3)], confidence: "high" }),
        boundaryGroup({ proposedGroupId: "g2", startSequenceIndex: 4, endSequenceIndex: 5, orderedImageIds: [uuid(4), uuid(5)], confidence: "medium" }),
        boundaryGroup({ proposedGroupId: "g3", startSequenceIndex: 6, endSequenceIndex: 6, orderedImageIds: [uuid(6)], confidence: "low" }),
      ],
      ungroupedImageIds: [uuid(7)],
      // uuid(8), uuid(9), uuid(10) never mentioned at all
    };
    const result = reconcileAutoGroupSession([raw], eligible);
    const accounted = new Set([
      ...result.applyAutomatically.flatMap(g => g.imageIds),
      ...result.needsReview.flatMap(g => g.imageIds),
      ...result.leftInUnsortedImageIds,
    ]);
    for (const image of eligible) expect(accounted.has(image.id)).toBe(true);
    expect(accounted.size).toBe(eligible.length);
  });

  it("low confidence never creates a group at all, not even for review — its photos go straight to leftInUnsortedImageIds", () => {
    const raw: AutoGroupToolInput = { groups: [boundaryGroup({ confidence: "low" })], ungroupedImageIds: [] };
    const result = reconcileAutoGroupSession([raw], eligible);
    expect(result.applyAutomatically).toHaveLength(0);
    expect(result.needsReview).toHaveLength(0);
    expect(result.leftInUnsortedImageIds).toEqual(expect.arrayContaining([uuid(1), uuid(2)]));
  });
});

describe("reconcileAutoGroupSession — cross-chunk continuation (a genuinely new mechanism, tested directly)", () => {
  const eligible = Array.from({ length: 20 }, (_, i) => ({ id: uuid(i + 1) }));

  it("REGRESSION: stitches a product spanning a chunk boundary into ONE group when the model correctly marks continuesFromPreviousChunk on the first group of the next chunk", () => {
    const chunk1: AutoGroupToolInput = {
      groups: [boundaryGroup({ proposedGroupId: "chunk1-last", startSequenceIndex: 6, endSequenceIndex: 8, orderedImageIds: [uuid(6), uuid(7), uuid(8)], confidence: "high" })],
      ungroupedImageIds: [uuid(1), uuid(2), uuid(3), uuid(4), uuid(5)],
    };
    const chunk2: AutoGroupToolInput = {
      groups: [boundaryGroup({ proposedGroupId: "chunk2-first", startSequenceIndex: 9, endSequenceIndex: 12, orderedImageIds: [uuid(9), uuid(10), uuid(11), uuid(12)], confidence: "high", continuesFromPreviousChunk: true })],
      ungroupedImageIds: Array.from({ length: 8 }, (_, i) => uuid(i + 13)),
    };
    const result = reconcileAutoGroupSession([chunk1, chunk2], eligible);
    expect(result.applyAutomatically).toHaveLength(1);
    expect(result.applyAutomatically[0].startSequenceIndex).toBe(6);
    expect(result.applyAutomatically[0].endSequenceIndex).toBe(12);
    expect(result.applyAutomatically[0].imageIds).toEqual([uuid(6), uuid(7), uuid(8), uuid(9), uuid(10), uuid(11), uuid(12)]);
  });

  it("does NOT stitch when continuesFromPreviousChunk is false — a genuine new product immediately after a chunk boundary stays its own group", () => {
    const chunk1: AutoGroupToolInput = {
      groups: [boundaryGroup({ proposedGroupId: "chunk1-last", startSequenceIndex: 6, endSequenceIndex: 8, orderedImageIds: [uuid(6), uuid(7), uuid(8)], confidence: "high" })],
      ungroupedImageIds: Array.from({ length: 5 }, (_, i) => uuid(i + 1)),
    };
    const chunk2: AutoGroupToolInput = {
      groups: [boundaryGroup({ proposedGroupId: "chunk2-first", startSequenceIndex: 9, endSequenceIndex: 12, orderedImageIds: [uuid(9), uuid(10), uuid(11), uuid(12)], confidence: "high", continuesFromPreviousChunk: false })],
      ungroupedImageIds: Array.from({ length: 8 }, (_, i) => uuid(i + 13)),
    };
    const result = reconcileAutoGroupSession([chunk1, chunk2], eligible);
    expect(result.applyAutomatically).toHaveLength(2);
    expect(result.applyAutomatically.map(g => `${g.startSequenceIndex}-${g.endSequenceIndex}`).sort()).toEqual(["6-8", "9-12"]);
  });

  it("REGRESSION: ignores continuesFromPreviousChunk when the group is NOT truly sequence-adjacent to the previous chunk's last group (a gap of ungrouped photos in between) — merging here would be wrong", () => {
    const chunk1: AutoGroupToolInput = {
      groups: [boundaryGroup({ proposedGroupId: "chunk1-last", startSequenceIndex: 6, endSequenceIndex: 7, orderedImageIds: [uuid(6), uuid(7)], confidence: "high" })],
      ungroupedImageIds: [uuid(1), uuid(2), uuid(3), uuid(4), uuid(5), uuid(8)], // photo 8 is ungrouped — a real gap
    };
    const chunk2: AutoGroupToolInput = {
      groups: [boundaryGroup({ proposedGroupId: "chunk2-first", startSequenceIndex: 9, endSequenceIndex: 10, orderedImageIds: [uuid(9), uuid(10)], confidence: "high", continuesFromPreviousChunk: true })],
      ungroupedImageIds: Array.from({ length: 10 }, (_, i) => uuid(i + 11)),
    };
    const result = reconcileAutoGroupSession([chunk1, chunk2], eligible);
    expect(result.applyAutomatically).toHaveLength(2); // NOT merged — 6-7 stays separate from 9-10
  });

  it("REGRESSION: never honours continuesFromPreviousChunk on a group that isn't the first in its own chunk — this is not a general 'trust the flag' merge mechanism", () => {
    const chunk1: AutoGroupToolInput = {
      groups: [boundaryGroup({ proposedGroupId: "chunk1-last", startSequenceIndex: 4, endSequenceIndex: 5, orderedImageIds: [uuid(4), uuid(5)], confidence: "high" })],
      ungroupedImageIds: [uuid(1), uuid(2), uuid(3)],
    };
    const chunk2: AutoGroupToolInput = {
      groups: [
        boundaryGroup({ proposedGroupId: "chunk2-first", startSequenceIndex: 6, endSequenceIndex: 6, orderedImageIds: [uuid(6)], confidence: "high", continuesFromPreviousChunk: false }),
        // Not the first group in this chunk — even though it's sequence-adjacent to chunk1's last group, the flag is meaningless here and must be ignored.
        boundaryGroup({ proposedGroupId: "chunk2-second", startSequenceIndex: 7, endSequenceIndex: 7, orderedImageIds: [uuid(7)], confidence: "high", continuesFromPreviousChunk: true }),
      ],
      ungroupedImageIds: Array.from({ length: 13 }, (_, i) => uuid(i + 8)),
    };
    const result = reconcileAutoGroupSession([chunk1, chunk2], eligible);
    expect(result.applyAutomatically).toHaveLength(3); // 4-5, 6-6, 7-7 all stay separate
  });

  it("weakens confidence on merge to the more conservative of the two halves (medium wins over high)", () => {
    const chunk1: AutoGroupToolInput = {
      groups: [boundaryGroup({ proposedGroupId: "chunk1-last", startSequenceIndex: 6, endSequenceIndex: 7, orderedImageIds: [uuid(6), uuid(7)], confidence: "high" })],
      ungroupedImageIds: [uuid(1), uuid(2), uuid(3), uuid(4), uuid(5)],
    };
    const chunk2: AutoGroupToolInput = {
      groups: [boundaryGroup({ proposedGroupId: "chunk2-first", startSequenceIndex: 8, endSequenceIndex: 9, orderedImageIds: [uuid(8), uuid(9)], confidence: "medium", continuesFromPreviousChunk: true })],
      ungroupedImageIds: Array.from({ length: 11 }, (_, i) => uuid(i + 10)),
    };
    const result = reconcileAutoGroupSession([chunk1, chunk2], eligible);
    expect(result.needsReview).toHaveLength(1); // merged result is medium -> review, not auto-applied
    expect(result.applyAutomatically).toHaveLength(0);
    expect(result.needsReview[0].imageIds).toEqual([uuid(6), uuid(7), uuid(8), uuid(9)]);
  });

  it("a chain of continuation across THREE chunks stitches into one single group", () => {
    const chunk1: AutoGroupToolInput = {
      groups: [boundaryGroup({ proposedGroupId: "c1", startSequenceIndex: 1, endSequenceIndex: 2, orderedImageIds: [uuid(1), uuid(2)], confidence: "high" })],
      ungroupedImageIds: [],
    };
    const chunk2: AutoGroupToolInput = {
      groups: [boundaryGroup({ proposedGroupId: "c2", startSequenceIndex: 3, endSequenceIndex: 4, orderedImageIds: [uuid(3), uuid(4)], confidence: "high", continuesFromPreviousChunk: true })],
      ungroupedImageIds: [],
    };
    const chunk3: AutoGroupToolInput = {
      groups: [boundaryGroup({ proposedGroupId: "c3", startSequenceIndex: 5, endSequenceIndex: 6, orderedImageIds: [uuid(5), uuid(6)], confidence: "high", continuesFromPreviousChunk: true })],
      ungroupedImageIds: Array.from({ length: 14 }, (_, i) => uuid(i + 7)),
    };
    const result = reconcileAutoGroupSession([chunk1, chunk2, chunk3], eligible);
    expect(result.applyAutomatically).toHaveLength(1);
    expect(result.applyAutomatically[0].imageIds).toEqual([uuid(1), uuid(2), uuid(3), uuid(4), uuid(5), uuid(6)]);
  });
});

// ============================================================================
// The exact live-test regression: 24 photos, 3 physical products, 8 photos
// each (full-pair, single-shoe, top-down, sole, and label/detail photos
// within each block) — matching the reported failure precisely.
// ============================================================================
describe("reconcileAutoGroupSession — the exact 24-photo live-test scenario (leopard sandals / New Balance / Hoka)", () => {
  const leopardIds = Array.from({ length: 8 }, (_, i) => uuid(i + 1)); // 1-8
  const newBalanceIds = Array.from({ length: 8 }, (_, i) => uuid(i + 9)); // 9-16
  const hokaIds = Array.from({ length: 8 }, (_, i) => uuid(i + 17)); // 17-24
  const all24Eligible = [...leopardIds, ...newBalanceIds, ...hokaIds].map(id => ({ id }));

  it("a CORRECT boundary response (one contiguous range per product, each mixing full-pair/single-shoe/top-down/sole/label photos) reconciles into exactly 3 groups of 8, all 24 photos accounted for, nothing left in Unsorted", () => {
    const raw: AutoGroupToolInput = {
      groups: [
        boundaryGroup({
          proposedGroupId: "leopard-sandals", startSequenceIndex: 1, endSequenceIndex: 8, orderedImageIds: leopardIds, confidence: "high",
          boundaryReason: "Same leopard-print sandal — full-pair, single-shoe, top-down, sole, and label photos all show identical print and sole pattern.",
        }),
        boundaryGroup({
          proposedGroupId: "new-balance", startSequenceIndex: 9, endSequenceIndex: 16, orderedImageIds: newBalanceIds, confidence: "high",
          boundaryReason: "Same white/black New Balance shoe across full, single, top-down, sole, and label photos — matching size label throughout.",
        }),
        boundaryGroup({
          proposedGroupId: "hoka", startSequenceIndex: 17, endSequenceIndex: 24, orderedImageIds: hokaIds, confidence: "high",
          boundaryReason: "Same black Hoka shoe across full, single, top-down, sole, and label photos — identical sole construction throughout.",
        }),
      ],
      ungroupedImageIds: [],
    };
    const result = reconcileAutoGroupSession([raw], all24Eligible);
    expect(result.applyAutomatically).toHaveLength(3);
    expect(result.needsReview).toHaveLength(0);
    expect(result.leftInUnsortedImageIds).toHaveLength(0);
    expect(result.applyAutomatically.map(g => g.imageIds).sort((a, b) => a.length - b.length)).toEqual([leopardIds, newBalanceIds, hokaIds].sort((a, b) => a.length - b.length));
    const allGroupedIds = result.applyAutomatically.flatMap(g => g.imageIds);
    expect(new Set(allGroupedIds).size).toBe(24);
  });

  it("REGRESSION (documents the actual reported failure — not fixed by code, must be fixed by the prompt): reproduces the exact reported over-split (New Balance 5+3, Hoka 6+2) and confirms reconciliation does NOT invent a same-chunk merge to paper over it", () => {
    const raw: AutoGroupToolInput = {
      groups: [
        boundaryGroup({ proposedGroupId: "leopard-sandals", startSequenceIndex: 1, endSequenceIndex: 8, orderedImageIds: leopardIds, confidence: "high" }),
        // New Balance over-split: high-confidence 5, medium-confidence 3 — exactly as reported.
        boundaryGroup({ proposedGroupId: "nb-fragment-a", startSequenceIndex: 9, endSequenceIndex: 13, orderedImageIds: newBalanceIds.slice(0, 5), confidence: "high" }),
        boundaryGroup({ proposedGroupId: "nb-fragment-b", startSequenceIndex: 14, endSequenceIndex: 16, orderedImageIds: newBalanceIds.slice(5), confidence: "medium" }),
        // Hoka over-split: 6 + 2 — exactly as reported.
        boundaryGroup({ proposedGroupId: "hoka-fragment-a", startSequenceIndex: 17, endSequenceIndex: 22, orderedImageIds: hokaIds.slice(0, 6), confidence: "high" }),
        boundaryGroup({ proposedGroupId: "hoka-fragment-b", startSequenceIndex: 23, endSequenceIndex: 24, orderedImageIds: hokaIds.slice(6), confidence: "high" }),
      ],
      ungroupedImageIds: [],
    };
    const result = reconcileAutoGroupSession([raw], all24Eligible);
    // No deterministic same-chunk merge exists (see this file's own
    // reconcileAutoGroupSession doc comment) — the fix for THIS failure is
    // AUTO_GROUP_SYSTEM_PROMPT actually reporting one contiguous range per
    // product in the first place, verified by the "CORRECT boundary
    // response" test above and the prompt-structure tests. This test just
    // pins that the pipeline doesn't pretend to fix bad model output.
    expect(result.applyAutomatically.length + result.needsReview.length).toBe(5); // leopard + nb-a + hoka-a + hoka-b applied; nb-b reviewed
    expect(result.applyAutomatically).toHaveLength(4);
    expect(result.needsReview).toHaveLength(1);
    expect(result.needsReview[0].imageIds).toEqual(newBalanceIds.slice(5));
  });
});
