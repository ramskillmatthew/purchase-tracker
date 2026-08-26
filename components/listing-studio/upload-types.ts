// Shared client-only UI state for one in-flight (or just-finished) upload —
// distinct from lib/listing-studio/types.ts's ListingDraftImage, which is
// the persisted server record. `clientId` exists so the UI can track a
// card before the server has even assigned a real imageId.
//
// State machine (large-batch upload fix): a photo moves
// waiting -> registering -> uploading -> confirming -> uploaded, or into
// failed/rejected at any point along the way.
//  - "waiting": queued, not yet included in a registration request.
//  - "registering": part of a chunk whose POST /api/listing-studio/uploads
//    request is currently in flight.
//  - "uploading": registered (has an imageId); its bytes are currently
//    being PUT to Storage (see `progress`).
//  - "confirming": the PUT succeeded; POST .../confirm is verifying the
//    Storage object server-side.
//  - "uploaded" / "failed": terminal — an attempt was made and it
//    succeeded/failed.
//  - "rejected": terminal, but NO attempt was ever made — the file was
//    excluded before registration by the chunk planner itself (currently
//    only for a single file over MAX_INDIVIDUAL_FILE_SIZE_BYTES), so
//    retrying it would fail identically every time; the UI never offers a
//    Retry action for this state.
export type UploadItemState = "waiting" | "registering" | "uploading" | "confirming" | "uploaded" | "failed" | "rejected";

export type UploadItem = {
  clientId: string;
  file: File;
  imageId: string | null;
  draftId: string | null;
  previewUrl: string | null;
  previewAvailable: boolean;
  state: UploadItemState;
  progress: number;
  errorMessage: string | null;
};

export const UPLOAD_ACTIVE_STATES: ReadonlySet<UploadItemState> = new Set(["waiting", "registering", "uploading", "confirming"]);
