import { z } from "zod";
// Type-only — erased at compile time, matching lib/purchase-import/ai-schema.ts's
// convention exactly: this keeps the schema/reconciliation logic in this
// file pure and directly testable with no Anthropic runtime import (and no
// server-only restriction), while still type-checking AUTO_GROUP_TOOL
// against the SDK's own Tool shape.
import type Anthropic from "@anthropic-ai/sdk";

/**
 * Automatic AI product grouping (Milestone 3, v3 — ordered boundary
 * detection). A real 24-photo/3-pair live test (v2's free-clustering
 * design) over-split two of the three pairs: the model's own reasoning for
 * one fragment admitted it might be the same item as another group. That
 * proves free-form visual clustering — "which of these N photos look like
 * they belong together" — is the wrong primary task for this workflow.
 *
 * The actual workflow: photos are uploaded in photography order — every
 * angle and detail shot of one physical product, consecutively, then the
 * next product. So the right task is BOUNDARY DETECTION over an ordered
 * sequence ("does photo N continue the current product, or start a new
 * one?"), not independent clustering of an unordered set. This file's
 * schema, tool, and reconciliation logic are built around that: every
 * proposal is a contiguous sequence range (startSequenceIndex..endSequenceIndex),
 * never an arbitrary list of ids — a group can no longer "pick" photos 3, 7,
 * and 19 the way free clustering could.
 */

const uuidSchema = z.string().uuid();
const proposedGroupIdSchema = z.string().trim().min(1).max(60);

// REGRESSION (v2, kept unchanged in v3): a real run was rejected outright
// because one group's reasoning text was 400+ characters, one-shotting an
// otherwise entirely valid response. Reasoning (now `boundaryReason`) is
// informational only and must never be able to invalidate a genuine
// boundary decision — the cap is generous, and truncateOverlongBoundaryReasons
// below still truncates anything longer before validation ever runs.
export const BOUNDARY_REASON_MAX_LENGTH = 1500;
const boundaryReasonSchema = z.string().trim().min(1).max(BOUNDARY_REASON_MAX_LENGTH);

// REGRESSION: a real 38-photo mixed-order run failed schema validation
// (code: too_big, maximum: 300) because two of the model's `warnings[]`
// entries — the *other* informational text field, easy to overlook since
// the earlier reasoning/boundaryReason fix only touched boundaryReason —
// exceeded the old 300-character cap. Same class of bug, same fix: a
// generous cap plus truncation before validation ever runs, so a genuinely
// valid boundary decision can never be thrown away over verbose (but
// harmless) warning text.
export const WARNING_TEXT_MAX_LENGTH = 500;
const warningTextSchema = z.string().trim().min(1).max(WARNING_TEXT_MAX_LENGTH);

// Deliberately a distinct, narrower 3-value set from lib/listing-studio/types.ts's
// ConfidenceLevel ("unconfirmed"/"conflict" describe a *field's* value state
// after cross-referencing multiple sources — they don't mean anything for a
// fresh boundary proposal, which is either confidently one product, plausibly
// one product, or not confidently a single product at all).
export const groupProposalConfidences = ["high", "medium", "low"] as const;
export type GroupProposalConfidence = typeof groupProposalConfidences[number];
const groupProposalConfidenceSchema = z.enum(groupProposalConfidences);

// A generous but real ceiling — matches MAX_AUTO_GROUP_BATCH_SIZE (the most
// photos one chunk, and therefore one contiguous range within one chunk,
// could ever legitimately contain).
const MAX_RANGE_LENGTH = 100;

const rawBoundaryProposalSchema = z.object({
  proposedGroupId: proposedGroupIdSchema,
  startSequenceIndex: z.number().int().positive(),
  endSequenceIndex: z.number().int().positive(),
  orderedImageIds: z.array(uuidSchema).min(1).max(MAX_RANGE_LENGTH),
  confidence: groupProposalConfidenceSchema,
  boundaryReason: boundaryReasonSchema,
  // True only when this is the FIRST group in this chunk's response AND its
  // photos continue the same physical product as the last group from the
  // previous chunk (shown as read-only context — see auto-group-ai.ts).
  // Meaningless (and ignored during reconciliation) anywhere else.
  continuesFromPreviousChunk: z.boolean(),
  warnings: z.array(warningTextSchema).max(10),
}).strict();
export type RawBoundaryProposal = z.infer<typeof rawBoundaryProposalSchema>;

/**
 * One chunk's whole tool input. `groups` and `ungroupedImageIds` are
 * independent lists the model fills in separately — reconcileAutoGroupSession
 * below is the actual enforcement point for contiguity, non-overlap, and
 * "every photo accounted for exactly once".
 */
export const autoGroupToolInputSchema = z.object({
  groups: z.array(rawBoundaryProposalSchema).max(60),
  ungroupedImageIds: z.array(uuidSchema).max(200),
}).strict();
export type AutoGroupToolInput = z.infer<typeof autoGroupToolInputSchema>;

function truncateText(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

/**
 * Called on each chunk's raw tool input BEFORE autoGroupToolInputSchema ever
 * sees it — see BOUNDARY_REASON_MAX_LENGTH's/WARNING_TEXT_MAX_LENGTH's own
 * comments for why. Truncates both of this response's free-text fields —
 * each group's boundaryReason, and every entry in its warnings[] — never
 * anything structural (image ids, sequence indexes, confidence,
 * continuesFromPreviousChunk are all left completely untouched). Tolerant
 * of anything that doesn't look like a well-formed groups array; every
 * other shape (invalid image ids, bad confidence values, malformed
 * structure) is still rejected exactly as before by the real schema — this
 * only ever relaxes the two free-text-length failure modes.
 */
export function truncateOverlongBoundaryReasons(rawInput: unknown): unknown {
  if (typeof rawInput !== "object" || rawInput === null || !("groups" in rawInput) || !Array.isArray((rawInput as { groups: unknown }).groups)) {
    return rawInput;
  }
  const input = rawInput as { groups: unknown[] };
  const groups = input.groups.map(group => {
    if (typeof group !== "object" || group === null) return group;
    const patch: Record<string, unknown> = {};

    const boundaryReason = (group as { boundaryReason?: unknown }).boundaryReason;
    if (typeof boundaryReason === "string" && boundaryReason.length > BOUNDARY_REASON_MAX_LENGTH) {
      patch.boundaryReason = truncateText(boundaryReason, BOUNDARY_REASON_MAX_LENGTH);
    }

    const warnings = (group as { warnings?: unknown }).warnings;
    if (Array.isArray(warnings)) {
      let anyWarningTooLong = false;
      const sanitizedWarnings = warnings.map(warning => {
        if (typeof warning !== "string" || warning.length <= WARNING_TEXT_MAX_LENGTH) return warning;
        anyWarningTooLong = true;
        return truncateText(warning, WARNING_TEXT_MAX_LENGTH);
      });
      if (anyWarningTooLong) patch.warnings = sanitizedWarnings;
    }

    return Object.keys(patch).length ? { ...group, ...patch } : group;
  });
  return { ...input, groups };
}

// REGRESSION (v3): replaces v2's free-clustering prompt entirely. Built
// around the actual photography workflow (one product's every angle/detail
// shot consecutively, then the next product) rather than asking the model
// to cluster an unordered photo set from scratch.
export const AUTO_GROUP_SYSTEM_PROMPT =
  "You detect physical-product boundaries in an ORDERED sequence of product photos for a resale listing tool, using the propose_product_groups tool. You will be shown every currently-unsorted photo in its exact upload order, each labelled with its sequence number and exact photo ID — e.g. \"Photo #7 — ID: <uuid>\". Copy sequence numbers and photo IDs exactly, character for character; never invent, modify, or guess either. "
  + "Your task is NOT to freely cluster photos by similarity. Photos are normally uploaded in photography order: the photographer captures every angle and detail of one physical product consecutively, then moves on to the next product. So your real job is to examine the sequence in order and decide, photo by photo, whether it CONTINUES the current physical product or BEGINS a new one — the same way you'd read a list, not the way you'd sort a pile. Report your decisions as contiguous sequence ranges (a startSequenceIndex and endSequenceIndex per group, with the exact ordered photo IDs in that range) — never an arbitrary, non-contiguous selection of photos. "
  + "ADJACENT PHOTOS ARE PRESUMED TO SHOW THE SAME PHYSICAL PRODUCT UNLESS THERE IS POSITIVE VISUAL EVIDENCE OF A PRODUCT CHANGE. This is a strong prior, not an absolute rule — you must still split adjacent photos when the product clearly changes. Do not create a boundary merely because the view changes from: full product to close-up; pair to one shoe; outer side to inner side; upper to sole; product view to size label; or wide shot to zoomed detail. None of these are evidence of a different physical product by themselves — a sudden VIEW change is normal within one product's own photo set; a sudden PRODUCT change is what you're actually looking for. "
  + "Positive evidence that a new boundary belongs at a given photo includes: a different shoe model or silhouette; a different colourway or pattern; different sole construction; a different branding arrangement; a clearly different item type; or a new repeated set of full-product views beginning (the photographer starting their standard shot sequence over again for the next item). Things that are NOT boundary evidence on their own: one side has a visible logo and the other does not; one photo shows the pair and another shows one shoe; the shoe has been rotated; the camera distance changes; the photo shows the sole, inside label, or size tag; or lighting/background/crop changes slightly. "
  + "Worked example: photos 1-3 are full and angled views of one shoe pair; photos 4-5 are top-down and inside views of the same pair; photos 6-7 are sole and size-label details of the same pair; photo 8 is another detail view of the same pair. Photos 1-8 must be reported as ONE product group. Photo 9 only starts a new group if it visibly shows a different physical product — not merely because it's yet another kind of shot. "
  + "A batch may contain several similar-looking products (e.g. more than one pair of a similar shoe model), so similarity alone is never enough to treat two genuinely different products as one — when you do see positive evidence of a change, compare the exact identifying details (colour, pattern, sole, wear marks, size label) to confirm it, not just a general impression. "
  + "Sometimes you will also be shown a few photos marked \"(context from a previous batch — already assigned, do not include in any group below)\" before your own new photos begin — these are the tail end of the previous batch's own sequence, shown only so you can judge continuity; never include their sequence numbers or ids in any group you report. If your own first new photo continues the same physical product as that context, set continuesFromPreviousChunk to true on the group containing it; otherwise set it to false. This field is only meaningful for the very first group in your response — always set it to false on every other group. "
  + "Every photo you were newly shown (not the previous-batch context photos) must end up in exactly one place: inside exactly one group's orderedImageIds, or in ungroupedImageIds — never both, never neither, and never in more than one group. Use \"high\" confidence only when you are genuinely certain a range is one product — this will be applied automatically with no human review, so do not use \"high\" for a guess. Use \"medium\" when a range plausibly is one product but you are not fully certain — this will be shown to a human for confirmation before anything changes. Use \"low\" for a weak or speculative boundary decision — this will never be applied, so only use it if you still want to note the possibility in your reasoning; a low-confidence group's photos are otherwise treated exactly like ungrouped photos. If you are not reasonably confident a photo belongs with its neighbours, put it in ungroupedImageIds instead of forcing it into a low-confidence group of one. A group may legitimately contain only one photo if that product genuinely has no other photos. "
  + "Each group's boundaryReason must briefly name the strongest identifying details that connect its photos — for example \"Same leopard-print upper, identical black sole pattern and matching size label; close-ups and full-pair views show the same item.\" A boundaryReason that merely states the photos look similar, with no specific identifying detail (for example \"These images look similar.\"), is not acceptable. Note anything uncertain in that group's warnings (e.g. \"one photo is blurry\", \"lighting differs from the others\"). "
  + "You must call the propose_product_groups tool exactly once — never respond with plain text.";

export const AUTO_GROUP_TOOL: Anthropic.Tool = {
  name: "propose_product_groups",
  description: "Report contiguous sequence ranges, each one physical product, by detecting boundaries in the ordered photo sequence you were shown. Call this exactly once, accounting for every newly-shown photo.",
  input_schema: {
    type: "object",
    properties: {
      groups: {
        type: "array",
        description: "Each entry is one contiguous sequence range showing one physical product.",
        items: {
          type: "object",
          properties: {
            proposedGroupId: { type: "string", description: "A short label for this group, for your own reference (e.g. 'group-1'). Not shown to the end user verbatim." },
            startSequenceIndex: { type: "integer", description: "The sequence number of the first photo in this product's range." },
            endSequenceIndex: { type: "integer", description: "The sequence number of the last photo in this product's range." },
            orderedImageIds: { type: "array", items: { type: "string" }, minItems: 1, description: "The exact photo IDs (copied character-for-character), in sequence order, for every photo from startSequenceIndex to endSequenceIndex inclusive." },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
            boundaryReason: { type: "string", description: "A brief, concrete explanation of the strongest identity cues connecting these photos as one product." },
            continuesFromPreviousChunk: { type: "boolean", description: "True only for the first group in this response, if it continues the previous batch's final (context) product. False on every other group." },
            warnings: { type: "array", items: { type: "string" }, description: "Anything uncertain about this specific group, e.g. a blurry or ambiguous photo." },
          },
          required: ["proposedGroupId", "startSequenceIndex", "endSequenceIndex", "orderedImageIds", "confidence", "boundaryReason", "continuesFromPreviousChunk", "warnings"],
          additionalProperties: false,
        },
      },
      ungroupedImageIds: {
        type: "array",
        items: { type: "string" },
        description: "Photo IDs (from this batch's own new photos only) you are not confidently able to place in any product range.",
      },
    },
    required: ["groups", "ungroupedImageIds"],
    additionalProperties: false,
  },
} as const;

/** Every way the auto-grouping AI call can end — mirrors AiExtractionOutcome's
 * closed-set convention exactly, so a failure is always a safe, fixed,
 * pre-written category, never a raw provider error surfaced to the UI. */
export type AutoGroupAiOutcome =
  | { status: "success"; data: AutoGroupToolInput }
  | { status: "not_configured" }
  | { status: "request_failed" }
  | { status: "no_tool_call" }
  | { status: "invalid_output" };

export function describeAutoGroupFailure(status: Exclude<AutoGroupAiOutcome["status"], "success">): string {
  switch (status) {
    case "not_configured": return "Automatic grouping is not available right now.";
    case "request_failed": return "Automatic grouping failed. Please try again.";
    case "no_tool_call": return "Automatic grouping did not return a structured result. Please try again.";
    case "invalid_output": return "Automatic grouping returned an unexpected result. Please try again.";
  }
}

export type ReconciledGroupProposal = {
  proposedGroupId: string;
  imageIds: string[];
  startSequenceIndex: number;
  endSequenceIndex: number;
  confidence: GroupProposalConfidence;
  boundaryReason: string;
  warnings: string[];
};

export type ReconciledAutoGroupResult = {
  /** High-confidence contiguous ranges — safe to create and move into automatically. */
  applyAutomatically: ReconciledGroupProposal[];
  /** Medium-confidence contiguous ranges — held for the user to confirm before anything changes. */
  needsReview: ReconciledGroupProposal[];
  /** Every image left in Unsorted: explicit low-confidence ranges, explicit
   * ungroupedImageIds, and anything invalid or never mentioned. */
  leftInUnsortedImageIds: string[];
  /** Human-readable notes about anything the model got wrong, for the audit
   * trail (listing_analysis_runs.response_json) — never surfaced verbatim
   * to the end user as an error, just recorded. */
  validationWarnings: string[];
};

const CONFIDENCE_RANK: Record<GroupProposalConfidence, number> = { low: 0, medium: 1, high: 2 };
function weakerConfidence(a: GroupProposalConfidence, b: GroupProposalConfidence): GroupProposalConfidence {
  return CONFIDENCE_RANK[a] <= CONFIDENCE_RANK[b] ? a : b;
}

type ValidatedRangeGroup = {
  chunkIndex: number;
  proposedGroupId: string;
  start: number;
  end: number;
  imageIds: string[];
  confidence: GroupProposalConfidence;
  boundaryReason: string;
  warnings: string[];
  continuesFromPreviousChunk: boolean;
};

/**
 * One "Auto-group products" run's whole eligible Unsorted set, analysed as
 * one or more chunks (see MAX_AUTO_GROUP_BATCH_SIZE /
 * MAX_AUTO_GROUP_SESSION_SIZE) — this is the real enforcement point for
 * every safety rule in this milestone's spec, run once against ALL chunks'
 * results together, only after every chunk has been analysed (never
 * applying one chunk before the rest are reconciled — see
 * app/api/listing-studio/groups/auto-group/apply-session/route.ts).
 *
 * `chunkResults` must be in the same order the chunks were analysed in —
 * `allEligibleImages` must be the exact same ordered id list every chunk
 * was sliced from (1-based sequence index = position + 1 in this array),
 * re-verified fresh (ownership, still-in-Unsorted, still-uploaded) by the
 * caller immediately before this runs.
 *
 * Validation performed here, per the spec:
 * - a range whose length doesn't match orderedImageIds.length is discarded
 *   ("non-contiguous ranges" / malformed structure)
 * - a range containing an internal duplicate id is discarded
 * - a range whose orderedImageIds don't exactly match the real photos at
 *   those sequence positions is discarded ("ranges whose image IDs do not
 *   match the supplied sequence indexes" / "unknown image IDs" — an id
 *   outside the eligible set can never match, so this is also how cross-owner
 *   and no-longer-in-Unsorted images are rejected, by construction of
 *   `allEligibleImages`)
 * - a range overlapping an already-accepted range is discarded entirely
 *   ("overlapping ranges") — never partially accepted
 * - cross-chunk continuation is honoured ONLY for a chunk's own first group,
 *   and only when it is truly sequence-adjacent to the previous chunk's own
 *   last group — never a general "trust this flag" merge between arbitrary
 *   proposals, which would reintroduce the exact free-merge risk this
 *   redesign exists to avoid
 * - every eligible photo ends in exactly one of: a high-confidence applied
 *   group, a medium-confidence review group, or leftInUnsortedImageIds —
 *   never lost, never duplicated ("missing images")
 */
export function reconcileAutoGroupSession(chunkResults: AutoGroupToolInput[], allEligibleImages: { id: string }[]): ReconciledAutoGroupResult {
  const imageBySequenceIndex = new Map<number, string>();
  allEligibleImages.forEach((image, index) => imageBySequenceIndex.set(index + 1, image.id));
  const totalCount = allEligibleImages.length;
  const validationWarnings: string[] = [];

  // Step 1: per-group structural validation, independent of other chunks.
  const validated: ValidatedRangeGroup[] = [];
  chunkResults.forEach((chunk, chunkIndex) => {
    for (const group of chunk.groups) {
      const { startSequenceIndex: start, endSequenceIndex: end, orderedImageIds } = group;
      if (start < 1 || end > totalCount || start > end) {
        validationWarnings.push(`Proposal "${group.proposedGroupId}" had an invalid sequence range (${start}-${end}) — discarded.`);
        continue;
      }
      if (orderedImageIds.length !== end - start + 1) {
        validationWarnings.push(`Proposal "${group.proposedGroupId}" claimed range ${start}-${end} but listed ${orderedImageIds.length} photo id(s) — discarded (non-contiguous).`);
        continue;
      }
      if (new Set(orderedImageIds).size !== orderedImageIds.length) {
        validationWarnings.push(`Proposal "${group.proposedGroupId}" listed a duplicate photo id within its own range — discarded.`);
        continue;
      }
      let matches = true;
      for (let i = 0; i < orderedImageIds.length; i++) {
        if (imageBySequenceIndex.get(start + i) !== orderedImageIds[i]) { matches = false; break; }
      }
      if (!matches) {
        validationWarnings.push(`Proposal "${group.proposedGroupId}" (range ${start}-${end}) listed photo ids that don't match the real photos at those sequence positions — discarded.`);
        continue;
      }
      validated.push({
        chunkIndex, proposedGroupId: group.proposedGroupId, start, end, imageIds: [...orderedImageIds],
        confidence: group.confidence, boundaryReason: group.boundaryReason, warnings: group.warnings,
        continuesFromPreviousChunk: group.continuesFromPreviousChunk,
      });
    }
  });

  // Step 2: cross-chunk continuation — only a chunk's own first group (by
  // start position) may merge into the immediately preceding chunk's own
  // last group, and only when truly sequence-adjacent.
  const byChunk = new Map<number, ValidatedRangeGroup[]>();
  for (const group of validated) {
    const list = byChunk.get(group.chunkIndex);
    if (list) list.push(group); else byChunk.set(group.chunkIndex, [group]);
  }
  for (const list of byChunk.values()) list.sort((a, b) => a.start - b.start);
  const chunkIndexesInOrder = [...byChunk.keys()].sort((a, b) => a - b);

  const merged: ValidatedRangeGroup[] = [];
  let pending: ValidatedRangeGroup | null = null;
  for (const chunkIndex of chunkIndexesInOrder) {
    const groupsInChunk = byChunk.get(chunkIndex)!;
    groupsInChunk.forEach((group, positionInChunk) => {
      const isFirstInChunk = positionInChunk === 0;
      const isLastInChunk = positionInChunk === groupsInChunk.length - 1;
      if (isFirstInChunk && pending && group.continuesFromPreviousChunk && group.start === pending.end + 1) {
        pending.end = group.end;
        pending.imageIds = pending.imageIds.concat(group.imageIds);
        pending.confidence = weakerConfidence(pending.confidence, group.confidence);
        pending.boundaryReason = truncateText(`${pending.boundaryReason} (continues into next batch: ${group.boundaryReason})`, BOUNDARY_REASON_MAX_LENGTH);
        pending.warnings = pending.warnings.concat(group.warnings);
        if (!isLastInChunk) { merged.push(pending); pending = null; }
        return;
      }
      if (pending) { merged.push(pending); pending = null; }
      if (isLastInChunk) pending = group; else merged.push(group);
    });
  }
  if (pending) merged.push(pending);

  // Step 3: reject overlaps (a range overlapping an already-accepted range
  // is discarded entirely, never partially accepted), then route by
  // confidence. Sorted by start so an earlier range always wins over a
  // later, overlapping one — deterministic, not order-of-arrival-dependent.
  merged.sort((a, b) => a.start - b.start);
  const claimedSequenceIndexes = new Set<number>();
  const claimedImageIds = new Set<string>();
  const applyAutomatically: ReconciledGroupProposal[] = [];
  const needsReview: ReconciledGroupProposal[] = [];
  const leftInUnsortedImageIds: string[] = [];

  for (const group of merged) {
    let overlaps = false;
    for (let seq = group.start; seq <= group.end; seq++) {
      if (claimedSequenceIndexes.has(seq)) { overlaps = true; break; }
    }
    if (overlaps) {
      validationWarnings.push(`Proposal "${group.proposedGroupId}" (range ${group.start}-${group.end}) overlaps a photo already used by an earlier proposal — discarded.`);
      continue;
    }
    for (let seq = group.start; seq <= group.end; seq++) claimedSequenceIndexes.add(seq);
    for (const id of group.imageIds) claimedImageIds.add(id);

    const reconciled: ReconciledGroupProposal = {
      proposedGroupId: group.proposedGroupId, imageIds: group.imageIds, startSequenceIndex: group.start, endSequenceIndex: group.end,
      confidence: group.confidence, boundaryReason: group.boundaryReason, warnings: group.warnings,
    };
    if (group.confidence === "high") applyAutomatically.push(reconciled);
    else if (group.confidence === "medium") needsReview.push(reconciled);
    else leftInUnsortedImageIds.push(...group.imageIds); // low confidence: never applied, never even shown for review
  }

  // Step 4: explicit ungroupedImageIds from every chunk.
  for (const chunk of chunkResults) {
    for (const imageId of chunk.ungroupedImageIds) {
      if (claimedImageIds.has(imageId)) continue; // already accounted for
      if (!allEligibleImages.some(image => image.id === imageId)) continue; // not a real eligible photo — ignored, never fabricated
      claimedImageIds.add(imageId);
      leftInUnsortedImageIds.push(imageId);
    }
  }

  // Step 5: anything never mentioned anywhere at all — an omission must
  // never mean "lost"; it stays in Unsorted.
  for (const image of allEligibleImages) {
    if (!claimedImageIds.has(image.id)) leftInUnsortedImageIds.push(image.id);
  }

  return { applyAutomatically, needsReview, leftInUnsortedImageIds, validationWarnings };
}
