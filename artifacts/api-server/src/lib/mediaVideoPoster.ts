/**
 * mediaVideoPoster — §37 "Thumbnail generation" and "Duration metadata" for a
 * video that arrives through the GENERAL upload route (`POST /media/upload`,
 * routes/posts.ts), which stores it at `post-media/<uid>/<ms>.<ext>` and records
 * its canonical `media_assets` row.
 *
 * The postcard slot path has its own poster route (routes/postcardMediaTransport
 * .ts) because it has a slot to hang the poster on. This path has no slot: the
 * upload returns a storage path and the canonical row is written beside it. So
 * the poster is attached to THAT path, and the rules that make it safe are the
 * rules below, all of them decided here and none of them by the client:
 *
 *   • The video must be the caller's own, in the exact layout /media/upload
 *     writes (`<uid>/<ms>.mp4|mov|webm`). A postcard slot, a story or memory
 *     path, another user's folder, a traversal — all refused.
 *   • The video must have been uploaded within POSTER_ATTACH_WINDOW_MS. A poster
 *     is the second half of an upload, not a way to re-dress an old video after
 *     the people who can see it have seen it.
 *   • The poster is written ONCE (no upsert). A second poster for the same video
 *     is refused, so a published video's frame cannot be swapped afterwards.
 *   • The poster is stored at `<path>.poster.jpg` — the same derived path
 *     lib/mediaAccess authorizes as its video (lib/mediaPosterPath.ts).
 *
 * The canonical row is then told about it: `media_assets.thumbnail_path` /
 * `thumbnail_url` for this owner's row at this storage path. That column
 * existed for video with no writer (census-media MD275). The /media/upload
 * route writes the row fire-and-forget, so a poster that arrives first finds no
 * row yet; the update is retried a bounded number of times and then reported as
 * `no_asset` — never as success.
 *
 * `recordMeasuredDuration` is the other half of the canonical row: the probed
 * container duration (lib/videoProbe.ts) into `media_assets.duration_ms`, which
 * likewise had no writer on this path.
 */
import type { VideoProbe } from "./videoProbe.js";
import { posterPathFor } from "./mediaPosterPath.js";

export const POSTER_BUCKET = "post-media";

/** A poster may be attached only this soon after the video was uploaded. */
export const POSTER_ATTACH_WINDOW_MS = 60 * 60 * 1000;

/** Clock skew tolerated for a timestamp slightly in the future. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

/** Exactly the layout routes/posts.ts `/media/upload` writes for a video. */
const GENERAL_VIDEO_PATH = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([0-9]{10,16})\.(mp4|mov|webm)$/i;

export type OwnVideoPath =
  | { ok: true; path: string; folder: string; file: string; uploadedAtMs: number; posterPath: string }
  | { ok: false; code: "invalid_payload" | "forbidden" | "conflict"; message: string };

/**
 * Is `raw` a general-upload video path the caller may attach a poster to now?
 * Pure; every refusal names its reason.
 */
export function parseOwnVideoPath(userId: string, raw: unknown, nowMs: number): OwnVideoPath {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 200) {
    return { ok: false, code: "invalid_payload", message: "A video path is required." };
  }
  const m = GENERAL_VIDEO_PATH.exec(raw);
  if (!m) {
    return { ok: false, code: "invalid_payload", message: "That is not a video uploaded through this app." };
  }
  if (m[1]!.toLowerCase() !== userId.toLowerCase()) {
    return { ok: false, code: "forbidden", message: "Not your video." };
  }
  const uploadedAtMs = Number(m[2]);
  if (!Number.isSafeInteger(uploadedAtMs) || uploadedAtMs > nowMs + FUTURE_SKEW_MS) {
    return { ok: false, code: "invalid_payload", message: "That is not a video uploaded through this app." };
  }
  if (nowMs - uploadedAtMs > POSTER_ATTACH_WINDOW_MS) {
    return { ok: false, code: "conflict", message: "A poster can only be added right after the video is uploaded." };
  }
  const slash = raw.indexOf("/");
  return {
    ok: true,
    path: raw,
    folder: raw.slice(0, slash),
    file: raw.slice(slash + 1),
    uploadedAtMs,
    posterPath: posterPathFor(raw),
  };
}

/** The storage calls this module needs — satisfied by `sc.storage.from(bucket)`. */
export interface PosterBucketLike {
  list(
    folder: string,
    opts?: { limit?: number; search?: string },
  ): Promise<{ data: Array<{ name: string }> | null; error: unknown }>;
  upload(
    path: string,
    body: Buffer,
    opts: { contentType: string; upsert: boolean },
  ): Promise<{ error: unknown }>;
}

/** Does the video object exist? A list ERROR is reported as such, never as "absent". */
export async function videoObjectExists(
  bucket: PosterBucketLike,
  video: { folder: string; file: string },
): Promise<"present" | "absent" | "error"> {
  try {
    const { data, error } = await bucket.list(video.folder, { limit: 10, search: video.file });
    if (error) return "error";
    return (data ?? []).some((o) => o?.name === video.file) ? "present" : "absent";
  } catch {
    return "error";
  }
}

/** A storage error that means "an object is already at this path". */
export function isAlreadyExists(error: unknown): boolean {
  const e = error as { statusCode?: unknown; status?: unknown; message?: unknown; error?: unknown } | null;
  if (!e) return false;
  if (String(e.statusCode ?? e.status ?? "") === "409") return true;
  const text = `${String(e.message ?? "")} ${String(e.error ?? "")}`.toLowerCase();
  return text.includes("already exists") || text.includes("duplicate");
}

export type AssetPosterOutcome = "updated" | "no_asset" | "error";

export interface AssetUpdateDeps {
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
  delayMs?: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Write the poster onto the owner's canonical `media_assets` row for this
 * video. Scoped by bucket, path AND owner, so no other user's row can be
 * touched even if two rows ever shared a path. Retries only the "row not there
 * yet" case; a write ERROR is returned at once.
 */
export async function recordPosterOnAsset(
  sc: any,
  input: { userId: string; storagePath: string; posterPath: string },
  deps: AssetUpdateDeps = {},
): Promise<AssetPosterOutcome> {
  const attempts = Math.max(1, deps.attempts ?? 3);
  const delayMs = deps.delayMs ?? 400;
  const sleep = deps.sleep ?? realSleep;
  for (let i = 0; i < attempts; i++) {
    try {
      const { data, error } = await sc
        .from("media_assets")
        .update({
          thumbnail_path: input.posterPath,
          thumbnail_url: `${POSTER_BUCKET}/${input.posterPath}`,
          updated_at: new Date().toISOString(),
        })
        .eq("storage_bucket", POSTER_BUCKET)
        .eq("storage_path", input.storagePath)
        .eq("owner_user_id", input.userId)
        .select("id");
      if (error) return "error";
      if (Array.isArray(data) && data.length > 0) return "updated";
    } catch {
      return "error";
    }
    if (i < attempts - 1) await sleep(delayMs);
  }
  return "no_asset";
}

/**
 * The probed duration into `media_assets.duration_ms` for the row the upload
 * route just wrote. Writes nothing when the container stated no duration — a
 * missing duration stays null, it is never filled with the client's figure.
 * Fail-soft: the upload has already succeeded.
 */
export async function recordMeasuredDuration(
  sc: any,
  assetId: string | null,
  probe: VideoProbe | null,
): Promise<boolean> {
  if (!assetId || !probe || probe.durationMs === null || !(probe.durationMs > 0)) return false;
  try {
    const { error } = await sc
      .from("media_assets")
      .update({ duration_ms: Math.round(probe.durationMs) })
      .eq("id", assetId);
    return !error;
  } catch {
    return false;
  }
}
