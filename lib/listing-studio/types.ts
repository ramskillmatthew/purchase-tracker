// Domain types for Listing Studio Stage 1. Pure types/enums only — no
// logic here (merge/validation/readiness logic lives in sibling files so
// each concern stays independently testable).

export const listingDraftStatuses = ["uploading", "grouping", "analysing", "needs_review", "ready", "failed", "archived"] as const;
export type ListingDraftStatus = typeof listingDraftStatuses[number];

// Matches app/globals.css-style {value,label}[] convention already used for
// arrivalFilters (lib/purchases.ts) and taskCategories — the UI can render
// these directly without a separate lookup table.
export const listingDraftStatusLabels: Record<ListingDraftStatus, string> = {
  uploading: "Uploading",
  grouping: "Grouping",
  analysing: "Analysing",
  needs_review: "Needs review",
  ready: "Ready",
  failed: "Failed",
  archived: "Archived",
};

// The controlled photo-role vocabulary from Stage 1 spec §6. "sku_label"
// covers both SKU and style-code labels (the spec lists them as one role:
// "SKU or style-code label"), so this stays exactly 10 values, not 11.
export const imageRoles = ["main", "side", "rear", "sole", "label", "size_label", "sku_label", "damage", "detail", "unknown"] as const;
export type ImageRole = typeof imageRoles[number];

export const imageRoleLabels: Record<ImageRole, string> = {
  main: "Main photo",
  side: "Side",
  rear: "Rear",
  sole: "Sole",
  label: "Label",
  size_label: "Size label",
  sku_label: "SKU / style-code label",
  damage: "Damage or defect",
  detail: "Detail",
  unknown: "Unknown",
};

export const confidenceLevels = ["high", "medium", "low", "unconfirmed", "conflict"] as const;
export type ConfidenceLevel = typeof confidenceLevels[number];

// Which pipeline stage (or the user) last produced a field's value — distinct
// from `sourceImageId` (which photo backs it up). "generated" covers Pass 5
// content (title/description/price/keywords) that isn't itself a label or
// visual observation but a downstream synthesis of both.
export const fieldSources = ["label", "visual", "generated", "user"] as const;
export type FieldSource = typeof fieldSources[number];

/**
 * The single structural unit every important extracted/generated field is
 * stored as (Stage 1 spec §8). `userConfirmed` is the field the rest of this
 * module is built around: once true, lib/listing-studio/field-value.ts's
 * mergeFieldValue() refuses to let a later AI pass silently overwrite it.
 */
export type FieldValue<T> = {
  value: T | null;
  confidence: ConfidenceLevel;
  source: FieldSource;
  sourceImageId: string | null;
  aiGenerated: boolean;
  userConfirmed: boolean;
  conflict: boolean;
};

// The "important fields" enumerated in Stage 1 spec §8. Colours/materials
// are plural because label/visual analysis may see more than one (spec:
// "Colours may contain multiple values" / "Materials may contain multiple
// values") — modelled as string arrays rather than a single delimited string
// so no ad-hoc parsing is ever needed to read them back.
export const listingFieldNames = ["brand", "model", "silhouette", "sku", "styleCode", "sizeUk", "sizeEu", "sizeUs", "category", "condition", "colours", "materials"] as const;
export type ListingFieldName = typeof listingFieldNames[number];

export type ListingFieldValueTypeMap = {
  brand: string; model: string; silhouette: string; sku: string; styleCode: string;
  sizeUk: string; sizeEu: string; sizeUs: string; category: string; condition: string;
  colours: string[]; materials: string[];
};

// Every important field's tracked value, keyed by name — this is the shape
// persisted in listing_drafts.field_data_json. Partial because a freshly
// uploaded/grouped draft has no fields analysed yet.
export type ListingFieldData = { [K in ListingFieldName]?: FieldValue<ListingFieldValueTypeMap[K]> };

export type ListingWarning = { code: string; message: string; field: ListingFieldName | null };
export type ListingConflict = { code: string; message: string; field: ListingFieldName | null; values: string[] };

export type ListingDraft = {
  id: string;
  ownerId: string;
  sku: string | null;
  styleCode: string | null;
  title: string | null;
  description: string | null;
  brand: string | null;
  model: string | null;
  silhouette: string | null;
  category: string | null;
  subcategory: string | null;
  condition: string | null;
  sizeLabel: string | null;
  suggestedPricePence: number | null;
  confirmedPricePence: number | null;
  status: ListingDraftStatus;
  overallConfidence: ConfidenceLevel | null;
  fieldData: ListingFieldData;
  warnings: ListingWarning[];
  conflicts: ListingConflict[];
  createdAt: string;
  updatedAt: string;
};

export type ListingDraftImage = {
  id: string;
  draftId: string;
  ownerId: string;
  storagePath: string;
  originalFilename: string;
  mimeType: string;
  fileSize: number;
  width: number | null;
  height: number | null;
  sortOrder: number;
  detectedRole: ImageRole | null;
  confirmedRole: ImageRole | null;
  createdAt: string;
};

export const listingAnalysisStages = ["image_quality", "label_extraction", "visual_identification", "consistency_check", "generation"] as const;
export type ListingAnalysisStage = typeof listingAnalysisStages[number];

export const listingAnalysisRunStatuses = ["running", "success", "failed"] as const;
export type ListingAnalysisRunStatus = typeof listingAnalysisRunStatuses[number];

export type ListingAnalysisRun = {
  id: string;
  draftId: string;
  ownerId: string;
  stage: ListingAnalysisStage;
  status: ListingAnalysisRunStatus;
  model: string | null;
  promptVersion: string;
  // Versioned independently of promptVersion (lib/listing-studio/schema-versions.ts)
  // so prompt wording and the expected AI response shape can each evolve on
  // their own schedule.
  schemaVersion: string;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
};

export type ListingStatusHistoryEntry = {
  id: string;
  draftId: string;
  ownerId: string;
  previousStatus: ListingDraftStatus | null;
  newStatus: ListingDraftStatus;
  reason: string | null;
  createdAt: string;
};
