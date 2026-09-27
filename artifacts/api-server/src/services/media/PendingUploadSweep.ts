/**
 * PendingUploadSweep — the one implementation of "an upload whose completion
 * never ran does not keep its unstripped original".
 *
 * census-discovery DV-77, §56. `docs/specs/discovery-architecture-v1/
 * discovery-v1-12-implementation-plan.md` Phase 0.4, verbatim: *"Redesign
 * durable ingest so no raw unstripped original can persist merely because a
 * completion handler never runs."*
 *
 * ── THE ONE PATH WHERE THAT CAN HAPPEN ──────────────────────────────────────
 * Every other upload path on this tree strips at ingest: `POST /media/upload`
 * holds the bytes and re-encodes (images) or scrubs (video) BEFORE the first
 * storage write, and refuses what it cannot strip — HEIC included. The postcard
 * transport cannot: its whole point is that the client PUTs straight to a
 * signed Storage URL and the API server never proxies the bytes. So between
 *
 *   t1  the PUT lands  (raw bytes, EXIF/GPS intact, at `<uid>/<post>/<media>.<ext>`,
 *       or in `<that>.parts/NNNNN` for a resumable upload)
 *   t2  `POST /postcards/:id/media/:mediaId/complete` downloads, strips and
 *       re-uploads in place, then marks the row `ready`
 *
 * an unstripped original sits in `post-media`, and t2 happens only if the
 * client comes back. A crash, a kill, a lost network, a backgrounded app or a
 * composer the traveller abandoned all leave it there, and so does a /complete
 * that REFUSED the bytes (it leaves the row `pending`). `post_media` rows are
 * the only record of where those bytes are: `pending` is exactly "not yet
 * stripped", and the three `processing_status` values admit nothing else.
 *
 * ── WHAT THIS IS ─────────────────────────────────────────────────────────────
 * The sweep `POST /api/postcards/sweep-orphans` has run since 2026-08-11
 * (`7aa65b61b`), MOVED here unchanged in its rules so the scheduler that was
 * never written (`lib/media/pendingUploadSweepScheduler.ts`) and that manual
 * trigger run one implementation:
 *
 *   1. `pending` rows older than the cutoff, OLDEST FIRST, a bounded batch;
 *   2. remove the object, its feed variant, its resumable parts and its poster
 *      BEFORE the row — a failed removal KEEPS the row, so the next pass can
 *      find the bytes again; deleting the row first would strand them for good;
 *   3. then delete the row.
 *
 * and three things it did not do:
 *
 *   • ORDER. The read had no order, so under a backlog larger than one batch
 *     the same rows could be re-read while the oldest raw original waited.
 *   • A ROW WITH NO RECORDED PATH. `upload-url` inserts the row with
 *     `storage_path = ''` and backfills it in a second statement whose error
 *     was never read (supabase-js RESOLVES on failure), yet minted the signed
 *     URL anyway. The old sweep then saw `''`, removed nothing and deleted the
 *     row — the one pointer to bytes it had just stranded. The path is fully
 *     determined (`<user_id>/<post_id>/<id>.<ext>`, `ext` from the declared MIME
 *     through the SAME table `upload-url` used), so it is derived; a row whose
 *     path cannot be derived is KEPT and counted, never deleted blind.
 *     (`upload-url` now also refuses to mint a URL for a slot whose path did not
 *     record — see routes/postcards.ts.)
 *   • A ROW THAT COMPLETED MEANWHILE. Re-read as still `pending` immediately
 *     before its bytes are removed. This narrows, and does not close, the race
 *     with a /complete that finishes between that re-read and the removal; the
 *     original sweep had the whole batch as its window.
 *
 * ── WHAT IT DOES NOT DECIDE ─────────────────────────────────────────────────
 * The cutoff and the batch are the values the route shipped with. Neither is a
 * ratified product number; see `PENDING_UPLOAD_ORPHAN_CUTOFF_MS`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { ALLOWED_MEDIA_MIME } from "../../lib/mediaPipeline.js";
import { removeTransportArtifacts } from "../../lib/postcardMediaTransport.js";
import { logger as rootLogger } from "../../lib/logger.js";

const moduleLogger = rootLogger.child({ service: "PendingUploadSweep" });

/** The bucket the postcard transport writes. `post_media.storage_bucket` overrides it per row. */
export const PENDING_UPLOAD_BUCKET = "post-media";

/**
 * How old a `pending` row must be before it is an orphan. ONE HOUR — the value
 * `routes/postcards.ts` shipped as `ORPHAN_CUTOFF_MS` ("long enough for any
 * real upload to complete"). UNRATIFIED: nobody has measured how long a
 * resumable 100 MB video takes on a slow link, and a slot older than this is
 * swept even if its owner is still uploading. That is the owner question §56
 * states; this file does not re-decide it.
 */
export const PENDING_UPLOAD_ORPHAN_CUTOFF_MS = 60 * 60 * 1000;

/** Rows per pass — the route's "cap at 200 per sweep to bound latency". UNRATIFIED, as shipped. */
export const PENDING_UPLOAD_SWEEP_BATCH = 200;

interface LogLike {
  warn?: (obj: unknown, msg?: string) => void;
  error?: (obj: unknown, msg?: string) => void;
}

export type PendingUploadSweepResult =
  | {
      ok: true;
      /** Rows whose bytes AND row are gone. */
      swept: number;
      /** Rows kept for a later pass: a removal or a delete failed, or no path could be derived. */
      errors: number;
      /** Rows the pass read. */
      examined: number;
      /** Rows skipped because they were no longer `pending` when re-read. */
      completedMeanwhile: number;
      /** TRUE when the batch was full: more orphans may be waiting. */
      more: boolean;
    }
  /** `post_media` could not be read. NOT zero work: nothing is known. */
  | { ok: false; reason: "post_media_unreadable"; message: string };

interface PendingRow {
  id: string;
  user_id: string | null;
  post_id: string | null;
  storage_path: string | null;
  storage_bucket: string | null;
  mime_type: string | null;
}

/**
 * Where a slot's bytes are. The recorded path when there is one; otherwise the
 * path `upload-url` minted, which is fully determined by the row. `null` when
 * it cannot be determined — the caller keeps such a row.
 */
export function pendingSlotPath(row: PendingRow): string | null {
  if (typeof row.storage_path === "string" && row.storage_path.length > 0) return row.storage_path;
  const ext = row.mime_type ? ALLOWED_MEDIA_MIME[row.mime_type]?.ext : undefined;
  if (!row.user_id || !row.post_id || !row.id || !ext) return null;
  return `${row.user_id}/${row.post_id}/${row.id}.${ext}`;
}

/**
 * One pass. Never throws: every failure is either counted (and the row kept)
 * or, for the one read the pass cannot proceed without, returned.
 */
export async function sweepAbandonedPendingUploads(
  sc: SupabaseClient,
  opts: { nowMs?: number; cutoffMs?: number; limit?: number; log?: LogLike } = {},
): Promise<PendingUploadSweepResult> {
  const log = opts.log ?? moduleLogger;
  const limit = opts.limit ?? PENDING_UPLOAD_SWEEP_BATCH;
  const cutoff = new Date((opts.nowMs ?? Date.now()) - (opts.cutoffMs ?? PENDING_UPLOAD_ORPHAN_CUTOFF_MS)).toISOString();

  let rows: PendingRow[];
  try {
    const { data, error } = await sc
      .from("post_media")
      .select("id, user_id, post_id, storage_path, storage_bucket, mime_type")
      .eq("processing_status", "pending")
      .lt("created_at", cutoff)
      .order("created_at", { ascending: true })
      .limit(limit);
    if (error) {
      log.error?.({ err: error }, "pending-upload sweep: post_media unreadable — nothing swept, nothing claimed");
      return { ok: false, reason: "post_media_unreadable", message: String(error.message ?? "post_media unreadable") };
    }
    rows = (data ?? []) as PendingRow[];
  } catch (err) {
    log.error?.({ err }, "pending-upload sweep: post_media read threw");
    return { ok: false, reason: "post_media_unreadable", message: err instanceof Error ? err.message : "post_media read threw" };
  }

  let swept = 0;
  let errors = 0;
  let completedMeanwhile = 0;

  for (const row of rows) {
    try {
      const path = pendingSlotPath(row);
      if (!path) {
        // Neither recorded nor derivable. Deleting the row would delete the
        // only thing an operator could use to find the bytes; keep it.
        log.warn?.({ mediaId: row.id, mimeType: row.mime_type }, "pending-upload sweep: slot path not derivable — row kept");
        errors++;
        continue;
      }

      // Still an orphan? A /complete that finished since the batch was read
      // has stripped the bytes in place; removing them now would leave a
      // `ready` row pointing at nothing.
      const { data: still, error: stillErr } = await sc
        .from("post_media")
        .select("id")
        .eq("id", row.id)
        .eq("processing_status", "pending")
        .maybeSingle();
      if (stillErr) {
        log.warn?.({ err: stillErr, mediaId: row.id }, "pending-upload sweep: re-read failed — row kept for retry");
        errors++;
        continue;
      }
      if (!still) { completedMeanwhile++; continue; }

      const bucket = sc.storage.from(row.storage_bucket || PENDING_UPLOAD_BUCKET);
      // `remove` REPORTS failure in `{ error }`; a missing object is not one.
      const { error: rmErr } = await bucket.remove([path, `${path}.feed.jpg`]);
      if (rmErr) {
        log.warn?.({ err: rmErr, mediaId: row.id, storagePath: path }, "pending-upload sweep: storage removal failed — row kept for retry");
        errors++;
        continue;
      }
      // An abandoned resumable upload leaves its parts (and possibly a poster)
      // beside the slot. Same rule: a failure keeps the row.
      const { error: artErr } = await removeTransportArtifacts(bucket as any, path);
      if (artErr) {
        log.warn?.({ err: artErr, mediaId: row.id, storagePath: path }, "pending-upload sweep: transport artifact removal failed — row kept for retry");
        errors++;
        continue;
      }

      const { error: delErr } = await sc.from("post_media").delete().eq("id", row.id);
      if (delErr) {
        log.warn?.({ err: delErr, mediaId: row.id }, "pending-upload sweep: row delete failed — the bytes are gone, the row is retried");
        errors++;
      } else {
        swept++;
      }
    } catch (err) {
      log.warn?.({ err, mediaId: row.id }, "pending-upload sweep: unexpected error — row kept");
      errors++;
    }
  }

  return { ok: true, swept, errors, examined: rows.length, completedMeanwhile, more: rows.length >= limit };
}
