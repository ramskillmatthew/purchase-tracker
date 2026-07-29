import { isAcceptedImageMimeType } from "./upload-limits";

// Pure, DOM-free logic for validating/deduplicating a file selection —
// takes plain {name, size, type} so it's testable without a real browser
// File object.
export type SelectableFile = { name: string; size: number; type: string };

const ACCEPTED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"];

export function hasAcceptedExtension(filename: string): boolean {
  const lower = filename.trim().toLowerCase();
  return ACCEPTED_EXTENSIONS.some(extension => lower.endsWith(extension));
}

/**
 * Some browsers/OSes report no MIME type (or a generic
 * "application/octet-stream") for HEIC/HEIF specifically — falling back to
 * the extension in that case means a real iPhone photo is never rejected
 * just because the browser didn't recognise it (Stage 1 spec: "Do not
 * silently reject unsupported files").
 */
export function isAcceptedFile(file: SelectableFile): boolean {
  if (file.type && isAcceptedImageMimeType(file.type)) return true;
  if (!file.type || file.type === "application/octet-stream") return hasAcceptedExtension(file.name);
  return false;
}

export function fileIdentityKey(file: SelectableFile): string {
  return `${file.name.trim().toLowerCase()}:${file.size}`;
}

/**
 * Splits a newly selected batch into files genuinely new to this session
 * and ones that match a filename+size already present (Milestone 2 spec
 * §14: "Same image selected twice", "Duplicate filenames"). Identity is
 * name+size, not file content — cheap, no hashing, and correct for the
 * overwhelmingly common case of a user re-selecting the same file(s).
 */
export function partitionDuplicateFiles<T extends SelectableFile>(existingKeys: ReadonlySet<string>, files: T[]): { unique: T[]; duplicates: T[] } {
  const unique: T[] = [];
  const duplicates: T[] = [];
  const seen = new Set(existingKeys);
  for (const file of files) {
    const key = fileIdentityKey(file);
    if (seen.has(key)) { duplicates.push(file); continue; }
    seen.add(key);
    unique.push(file);
  }
  return { unique, duplicates };
}
