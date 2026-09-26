/**
 * postcardMediaTransport — the two things the postcard upload transport was
 * missing for VIDEO (Media spec §37): a poster frame, and an upload that can be
 * resumed.
 *
 * THE TRANSPORT THIS EXTENDS
 * ==========================
 * Every Media post is a postcard: `POST /postcards` makes the shell,
 * `upload-url` reserves ONE `post_media` slot and a signed Storage URL at
 * `<uid>/<postId>/<mediaId>.<ext>`, the client PUTs the whole file there, and
 * `/complete` verifies, scrubs and marks the row ready. That shape stays. This
 * module adds, around the SAME reserved slot:
 *
 *   1. A POSTER (§37 "Thumbnail generation"). No video postcard has ever had a
 *      `thumbnail_url` — PostcardsTab.tsx says so in its own comment — because
 *      the server has no decoder and the composer never sent one. The frame is
 *      extracted ON DEVICE (expo-video-thumbnails, already shipped) and uploaded
 *      here; the server re-encodes it (EXIF gone, capped), and stores it at a
 *      path DERIVED FROM THE SLOT: `<storage_path>.poster.jpg`. The client never
 *      names the path. `/complete` admits exactly that derived path and nothing
 *      else, and lib/mediaAccess authorizes a poster by authorizing the video it
 *      was cut from — a frame of a video is shown to exactly the video's audience.
 *
 *   2. RESUMABLE PARTS (§37 "Upload resume / retry"). A 100 MB video was one
 *      PUT: a dropped connection at 95 % started again from 0 %, and nothing
 *      survived the app being killed. Now the slot can be filled in fixed
 *      RESUMABLE_CHUNK_BYTES parts, each PUT straight to Storage against its own
 *      signed URL (the API server never proxies the bytes — the reason transport
 *      B exists at all), under `<storage_path>.parts/NNNNN`. The RESUME TOKEN is
 *      the slot itself: asking for the session again LISTS what Storage already
 *      holds and mints URLs only for what is missing, so an interrupted upload —
 *      or one resumed after a relaunch, or after the URLs expired — continues
 *      from the last part that landed. `assemble` then concatenates the parts
 *      into the slot's own object, and the unchanged `/complete` takes over.
 *
 * WHAT IS VERIFIED, AND WHERE
 * ===========================
 * A signed upload URL lets a client write ANY bytes to its path — the same
 * property transport B already has for the whole file. So nothing about a part
 * is trusted until `assemble`: every part must be present, every part must be
 * EXACTLY its expected size, the total must equal the size declared when the
 * slot was reserved (which `validateDeclaredUpload` already capped), and the
 * assembled bytes must sniff as the slot's declared kind. Only then is the
 * slot's object written — and `/complete` still runs its full verification and
 * location scrub over it afterwards. A malformed session is refused, never
 * "repaired".
 */

import { MEDIA_SIZE_LIMITS, verifyUploadedBytes, type MediaKind } from "./mediaPipeline.js";
import type { SniffResult } from "./mediaProcessing.js";
import { posterPathFor } from "./mediaPosterPath.js";

export { POSTER_SUFFIX, posterPathFor, derivedPosterBase, admissiblePosterPath } from "./mediaPosterPath.js";

/** Part size. 4 MiB: small enough that a dropped mobile connection costs little, few enough parts for 100 MB (25). */
export const RESUMABLE_CHUNK_BYTES = 4 * 1024 * 1024;
/** Upper bound on parts for the largest admissible upload. */
export const MAX_RESUMABLE_PARTS = Math.ceil(MEDIA_SIZE_LIMITS.video / RESUMABLE_CHUNK_BYTES);

/** Longest edge of a stored poster. A frame is a poster, not a still to zoom into. */
export const POSTER_MAX_DIM = 1280;
/** A device-extracted JPEG frame is ~100-500 KB; anything past this is not a poster. */
export const POSTER_MAX_BYTES = 5 * 1024 * 1024;

const PARTS_FOLDER_SUFFIX = ".parts";

// ── Path policy (pure) ────────────────────────────────────────────────────────

export function partsFolderFor(storagePath: string): string {
  return `${storagePath}${PARTS_FOLDER_SUFFIX}`;
}

export function partName(index: number): string {
  return String(index).padStart(5, "0");
}

export function partPathFor(storagePath: string, index: number): string {
  return `${partsFolderFor(storagePath)}/${partName(index)}`;
}

export function partCountFor(totalBytes: number, chunk: number = RESUMABLE_CHUNK_BYTES): number {
  if (!Number.isInteger(totalBytes) || totalBytes <= 0 || chunk <= 0) return 0;
  return Math.ceil(totalBytes / chunk);
}

/** The exact byte length part `index` must have, or null when the index is out of range. */
export function partSizeFor(index: number, totalBytes: number, chunk: number = RESUMABLE_CHUNK_BYTES): number | null {
  const count = partCountFor(totalBytes, chunk);
  if (!Number.isInteger(index) || index < 0 || index >= count) return null;
  if (index < count - 1) return chunk;
  return totalBytes - chunk * (count - 1);
}

export interface ListedPart {
  name: string;
  size: number | null;
}

export interface SessionSummary {
  totalBytes: number;
  chunkBytes: number;
  partCount: number;
  /** Parts present at exactly their expected size. */
  received: number[];
  /** Parts absent, or present at the WRONG size (a wrong-sized part is re-sent, not trusted). */
  missing: number[];
  /** Objects in the parts folder that are not a part of this session at all. */
  foreign: string[];
  receivedBytes: number;
  complete: boolean;
}

/** Fold a Storage listing of the parts folder into what is present and what is not. */
export function summarizeParts(
  listed: readonly ListedPart[],
  totalBytes: number,
  chunk: number = RESUMABLE_CHUNK_BYTES,
): SessionSummary {
  const partCount = partCountFor(totalBytes, chunk);
  const sizeByIndex = new Map<number, number | null>();
  const foreign: string[] = [];
  for (const item of listed) {
    const m = /^(\d{5})$/.exec(item.name);
    const index = m ? Number(m[1]) : NaN;
    if (!m || index >= partCount) {
      foreign.push(item.name);
      continue;
    }
    sizeByIndex.set(index, item.size);
  }
  const received: number[] = [];
  const missing: number[] = [];
  let receivedBytes = 0;
  for (let i = 0; i < partCount; i++) {
    const expected = partSizeFor(i, totalBytes, chunk)!;
    const got = sizeByIndex.get(i);
    if (got === expected) {
      received.push(i);
      receivedBytes += expected;
    } else {
      missing.push(i);
    }
  }
  return {
    totalBytes,
    chunkBytes: chunk,
    partCount,
    received,
    missing,
    foreign,
    receivedBytes,
    complete: partCount > 0 && missing.length === 0,
  };
}

// ── Storage effects ───────────────────────────────────────────────────────────

/** The narrow slice of a Supabase Storage bucket client this module uses. */
export interface StorageBucketLike {
  list(
    path: string,
    options?: { limit?: number; offset?: number; sortBy?: { column: string; order: string } },
  ): Promise<{ data: Array<{ name: string; metadata?: { size?: number } | null }> | null; error: { message: string } | null }>;
  createSignedUploadUrl(
    path: string,
    options?: { upsert?: boolean },
  ): Promise<{ data: { signedUrl: string; path?: string; token?: string } | null; error: { message: string } | null }>;
  download(path: string): Promise<{ data: { arrayBuffer(): Promise<ArrayBuffer> } | null; error: { message: string } | null }>;
  upload(
    path: string,
    body: Buffer,
    options?: { contentType?: string; upsert?: boolean },
  ): Promise<{ data: unknown; error: { message: string } | null }>;
  remove(paths: string[]): Promise<{ data: unknown; error: { message: string } | null }>;
}

export type TransportFailure =
  | { kind: "infra"; message: string }
  | { kind: "incomplete"; message: string; summary: SessionSummary }
  | { kind: "content"; message: string };

/** List the parts folder of a slot. An unreadable listing is an infra failure, never "no parts". */
export async function listParts(
  bucket: StorageBucketLike,
  storagePath: string,
): Promise<{ ok: true; parts: ListedPart[] } | { ok: false; failure: TransportFailure }> {
  let res: Awaited<ReturnType<StorageBucketLike["list"]>>;
  try {
    res = await bucket.list(partsFolderFor(storagePath), {
      limit: MAX_RESUMABLE_PARTS + 50,
      sortBy: { column: "name", order: "asc" },
    });
  } catch (err) {
    return { ok: false, failure: { kind: "infra", message: err instanceof Error ? err.message : "parts listing threw" } };
  }
  if (res.error || !Array.isArray(res.data)) {
    return { ok: false, failure: { kind: "infra", message: res.error?.message ?? "parts listing failed" } };
  }
  return {
    ok: true,
    parts: res.data.map((o) => ({
      name: o.name,
      size: typeof o.metadata?.size === "number" ? o.metadata.size : null,
    })),
  };
}

/** Mint a signed upload URL (upsert, so a re-sent part replaces a partial one) for each missing part. */
export async function mintPartUploadUrls(
  bucket: StorageBucketLike,
  storagePath: string,
  indexes: readonly number[],
): Promise<{ ok: true; urls: Array<{ index: number; uploadUrl: string }> } | { ok: false; failure: TransportFailure }> {
  const urls: Array<{ index: number; uploadUrl: string }> = [];
  for (const index of indexes) {
    const res = await bucket.createSignedUploadUrl(partPathFor(storagePath, index), { upsert: true });
    const signedUrl = res.data?.signedUrl;
    if (res.error || !signedUrl) {
      return { ok: false, failure: { kind: "infra", message: res.error?.message ?? "could not sign part upload" } };
    }
    urls.push({ index, uploadUrl: signedUrl });
  }
  return { ok: true, urls };
}

/**
 * Concatenate a complete session's parts into ONE buffer and prove it is the
 * slot's declared kind. Refuses — never repairs — a session that is short, has
 * a wrong-sized part, or whose bytes are not the declared kind.
 */
export async function assembleParts(
  bucket: StorageBucketLike,
  storagePath: string,
  totalBytes: number,
  declaredKind: MediaKind,
  chunk: number = RESUMABLE_CHUNK_BYTES,
): Promise<{ ok: true; buffer: Buffer; sniffed: SniffResult } | { ok: false; failure: TransportFailure }> {
  const listed = await listParts(bucket, storagePath);
  if (!listed.ok) return listed;
  const summary = summarizeParts(listed.parts, totalBytes, chunk);
  if (!summary.complete) {
    return {
      ok: false,
      failure: {
        kind: "incomplete",
        message: `${summary.missing.length} of ${summary.partCount} part(s) are missing or the wrong size`,
        summary,
      },
    };
  }
  const buffers: Buffer[] = [];
  for (let i = 0; i < summary.partCount; i++) {
    const dl = await bucket.download(partPathFor(storagePath, i));
    if (dl.error || !dl.data) {
      return { ok: false, failure: { kind: "infra", message: dl.error?.message ?? `part ${i} download failed` } };
    }
    const part = Buffer.from(await dl.data.arrayBuffer());
    // The listing said the right size; the bytes must agree. A part replaced
    // between the listing and this read is caught here rather than trusted.
    if (part.length !== partSizeFor(i, totalBytes, chunk)) {
      return {
        ok: false,
        failure: { kind: "incomplete", message: `part ${i} changed size during assembly`, summary },
      };
    }
    buffers.push(part);
  }
  const buffer = Buffer.concat(buffers, totalBytes);
  if (buffer.length !== totalBytes) {
    return { ok: false, failure: { kind: "content", message: "assembled size does not match the declared size" } };
  }
  const verified = verifyUploadedBytes(buffer, declaredKind);
  if (!verified.ok) return { ok: false, failure: { kind: "content", message: verified.failure.message } };
  return { ok: true, buffer, sniffed: verified.value };
}

/**
 * Remove everything this transport may have written beside a slot: its poster
 * and its parts. Used when the slot is deleted or swept, so neither outlives
 * the media it belongs to. `remove` tolerates absent keys.
 */
export async function removeTransportArtifacts(
  bucket: StorageBucketLike,
  storagePath: string,
): Promise<{ error: { message: string } | null }> {
  if (!storagePath) return { error: null };
  const listed = await listParts(bucket, storagePath);
  const partPaths = listed.ok
    ? listed.parts.map((p) => `${partsFolderFor(storagePath)}/${p.name}`)
    : // An unreadable listing still removes every path a session could have made.
      Array.from({ length: MAX_RESUMABLE_PARTS }, (_, i) => partPathFor(storagePath, i));
  try {
    const res = await bucket.remove([posterPathFor(storagePath), ...partPaths]);
    return { error: res?.error ?? null };
  } catch (err) {
    return { error: { message: err instanceof Error ? err.message : "artifact removal threw" } };
  }
}

