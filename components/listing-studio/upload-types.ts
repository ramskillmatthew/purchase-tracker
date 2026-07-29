// Shared client-only UI state for one in-flight (or just-finished) upload —
// distinct from lib/listing-studio/types.ts's ListingDraftImage, which is
// the persisted server record. `clientId` exists so the UI can track a
// card before the server has even assigned a real imageId.
export type UploadItem = {
  clientId: string;
  file: File;
  imageId: string | null;
  draftId: string | null;
  previewUrl: string | null;
  previewAvailable: boolean;
  state: "pending" | "uploading" | "uploaded" | "failed";
  progress: number;
  errorMessage: string | null;
};
