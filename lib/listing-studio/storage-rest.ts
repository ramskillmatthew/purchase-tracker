import "server-only";

/**
 * Raw REST calls to Supabase Storage — deliberately not @supabase/supabase-js.
 * Mirrors lib/supabase.ts's supabaseRequest convention (same env vars, same
 * apikey/Authorization header logic) so this feature stays consistent with
 * how every other server route in this app talks to Supabase, rather than
 * introducing a second client library solely for Storage.
 *
 * The exact contract below was verified live against a real Supabase
 * project during Milestone 2 (a throwaway bucket was created, exercised,
 * and deleted — no project schema/data was touched):
 *   1. POST /object/upload/sign/{bucket}/{path} (service role) -> { url, token }
 *      where `url` is relative ("/object/upload/sign/{bucket}/{path}?token=...").
 *   2. The browser PUTs directly to that resolved URL using ONLY the public
 *      anon key — confirmed the service-role key is never needed for this
 *      step. A second PUT to the same path with x-upsert:false was
 *      correctly rejected (409 KeyAlreadyExists), giving free collision
 *      protection against overwriting an existing object.
 *   3. DELETE /object/{bucket} with a JSON { prefixes: [...] } body (not a
 *      path segment) is the correct shape for removing an object.
 */

function config() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase environment variables are not configured.");
  return { url, key };
}

function storageHeaders(extra?: Record<string, string>) {
  const { key } = config();
  const headers: Record<string, string> = { apikey: key, "Content-Type": "application/json", ...extra };
  if (!key.startsWith("sb_secret_")) headers.Authorization = `Bearer ${key}`;
  return headers;
}

/** Thrown when the listing-drafts bucket itself doesn't exist yet — surfaced
 * as a clear setup message rather than a generic/opaque failure. */
export class StorageBucketMissingError extends Error {
  name = "StorageBucketMissingError";
}

function looksLikeMissingBucket(body: string): boolean {
  return /bucket.*not.*found|nosuchbucket/i.test(body);
}

/**
 * `upsert` defaults to false — a brand-new image gets a brand-new path, so
 * an existing object at that path is unexpected and the upload should fail
 * loudly rather than silently overwrite something (Stage 1 spec: "Do not
 * overwrite existing files"). A retry of a previously-failed upload passes
 * `upsert: true` since it's a legitimate re-attempt at the exact same
 * image's own path, not a collision with someone else's file.
 */
export async function createSignedUploadUrl(bucket: string, path: string, options?: { upsert?: boolean }): Promise<{ uploadUrl: string; token: string }> {
  const { url } = config();
  const response = await fetch(`${url}/storage/v1/object/upload/sign/${bucket}/${path}`, {
    method: "POST",
    headers: storageHeaders(options?.upsert ? { "x-upsert": "true" } : undefined),
    body: JSON.stringify({}),
  });
  const bodyText = await response.text();
  if (!response.ok) {
    if (looksLikeMissingBucket(bodyText)) {
      throw new StorageBucketMissingError(
        `Storage bucket "${bucket}" was not found. Run supabase-listing-studio.sql in the Supabase SQL editor (or create the bucket manually — see that file's comments) before uploading.`,
      );
    }
    throw new Error(`Could not create a signed upload URL (${response.status}): ${bodyText}`);
  }
  const data = JSON.parse(bodyText) as { url: string; token: string };
  const uploadUrl = data.url.startsWith("http") ? data.url : `${url}/storage/v1${data.url}`;
  return { uploadUrl, token: data.token };
}

export type StorageObjectMetadata = { size: number; mimeType: string };

/**
 * Confirms an object exists and returns its real, server-observed size and
 * MIME type — used by the upload-confirmation route to independently
 * verify what actually landed in Storage rather than trusting the client's
 * claimed values. Returns null if no matching object is found (never
 * thrown — "object missing" is an expected, handled outcome, not an error).
 */
export async function getStorageObjectMetadata(bucket: string, path: string): Promise<StorageObjectMetadata | null> {
  const { url } = config();
  const lastSlash = path.lastIndexOf("/");
  const prefix = lastSlash === -1 ? "" : path.slice(0, lastSlash);
  const name = lastSlash === -1 ? path : path.slice(lastSlash + 1);

  const response = await fetch(`${url}/storage/v1/object/list/${bucket}`, {
    method: "POST",
    headers: storageHeaders(),
    body: JSON.stringify({ prefix, search: name, limit: 1 }),
  });
  const bodyText = await response.text();
  if (!response.ok) {
    if (looksLikeMissingBucket(bodyText)) {
      throw new StorageBucketMissingError(`Storage bucket "${bucket}" was not found. Run supabase-listing-studio.sql before confirming uploads.`);
    }
    throw new Error(`Could not check the uploaded Storage object (${response.status}): ${bodyText}`);
  }

  const entries = JSON.parse(bodyText) as Array<{ name: string; metadata?: { size?: number; mimetype?: string } }>;
  const match = entries.find(entry => entry.name === name);
  if (!match?.metadata) return null;
  return { size: match.metadata.size ?? 0, mimeType: match.metadata.mimetype ?? "application/octet-stream" };
}

/**
 * Signed read URL for displaying a private photo — verified live to need
 * NO auth headers at all when fetched (the embedded token is sufficient),
 * so this can go straight into an <img src>. Used by the
 * /api/listing-studio/images/[imageId]/view route, which redirects to the
 * resolved URL rather than proxying the image bytes itself.
 */
export async function createSignedDownloadUrl(bucket: string, path: string, expiresInSeconds: number): Promise<string> {
  const { url } = config();
  const response = await fetch(`${url}/storage/v1/object/sign/${bucket}/${path}`, {
    method: "POST",
    headers: storageHeaders(),
    body: JSON.stringify({ expiresIn: expiresInSeconds }),
  });
  const bodyText = await response.text();
  if (!response.ok) {
    if (looksLikeMissingBucket(bodyText)) {
      throw new StorageBucketMissingError(`Storage bucket "${bucket}" was not found. Run supabase-listing-studio.sql before viewing uploaded photos.`);
    }
    throw new Error(`Could not create a signed view URL (${response.status}): ${bodyText}`);
  }
  const data = JSON.parse(bodyText) as { signedURL: string };
  return data.signedURL.startsWith("http") ? data.signedURL : `${url}/storage/v1${data.signedURL}`;
}

export async function deleteStorageObject(bucket: string, path: string): Promise<void> {
  const { url } = config();
  const response = await fetch(`${url}/storage/v1/object/${bucket}`, {
    method: "DELETE",
    headers: storageHeaders(),
    body: JSON.stringify({ prefixes: [path] }),
  });
  if (!response.ok) throw new Error(`Could not delete the Storage object (${response.status}): ${await response.text()}`);
}

// A defensive cap on how many prefixes go in one DELETE request body — not
// a documented hard Supabase Storage limit, just a sane ceiling well under
// any observed real one, so a full workspace clear (potentially hundreds of
// photos) batches into a handful of requests instead of either one giant
// request or one request per photo.
export const STORAGE_DELETE_BATCH_SIZE = 100;

/**
 * Deletes many objects from one bucket, batched (the same DELETE
 * {prefixes: [...]} endpoint deleteStorageObject uses above, just with
 * more than one path per call). Throws on the first failing batch rather
 * than swallowing it — callers that need "delete everything, or report
 * exactly what happened and change nothing else" (see
 * app/api/listing-studio/workspace/route.ts's DELETE handler) rely on this
 * to stop before touching anything else once a batch fails.
 */
export async function deleteStorageObjects(bucket: string, paths: string[]): Promise<void> {
  const { url } = config();
  for (let i = 0; i < paths.length; i += STORAGE_DELETE_BATCH_SIZE) {
    const batch = paths.slice(i, i + STORAGE_DELETE_BATCH_SIZE);
    if (!batch.length) continue;
    const response = await fetch(`${url}/storage/v1/object/${bucket}`, {
      method: "DELETE",
      headers: storageHeaders(),
      body: JSON.stringify({ prefixes: batch }),
    });
    if (!response.ok) throw new Error(`Could not delete ${batch.length} Storage object(s) (${response.status}): ${await response.text()}`);
  }
}
