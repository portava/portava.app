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
import { removeTransportArtifacts, partsFolderFor, MAX_RESUMABLE_PARTS } from "../../lib/postcardMediaTransport.js";
import { logger as rootLogger } from "../../lib/logger.js";

const moduleLogger = rootLogger.child({ service: "PendingUploadSweep" });

/** The bucket the postcard transport writes. `post_media.storage_bucket` overrides it per row. */
export const PENDING_UPLOAD_BUCKET = "post-media";

/**
 * THE RULE (census-discovery §81, D-W10S2-6; replaces the route's one hour): a pending slot is abandoned only
 * when no upload can still land in it under an authority the server issued. Measured from its LATEST ACTIVITY —
 * reservation, a resumable session renewing it (`renewPendingSlot`, stamped before part URLs are minted), or its
 * newest part's write — it is swept once that is older than a signed upload URL's lifetime (storage-js: "They
 * are valid for 2 hours") plus the time a PUT authorized at that URL's last valid instant can still be in
 * flight: the largest single object the transport admits (100 MiB video) at 0.5 Mbit/s is ~28 min, so 30 min.
 */
export const SIGNED_UPLOAD_URL_TTL_MS = 2 * 60 * 60 * 1000; export const PENDING_UPLOAD_PUT_GRACE_MS = 30 * 60 * 1000; export const PENDING_UPLOAD_ORPHAN_CUTOFF_MS = SIGNED_UPLOAD_URL_TTL_MS + PENDING_UPLOAD_PUT_GRACE_MS;

/** Rows per pass — the route's "cap at 200 per sweep to bound latency". Kept by D-W10S2-6: it bounds a pass's latency, not what is deleted. */
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
      completedMeanwhile: number; /** Rows skipped because their owner is still sending (a renewal or a part newer than the cutoff) — §81. */ stillSending: number;
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
  mime_type: string | null; created_at?: string | null; updated_at?: string | null;
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
  const cutoff = new Date((opts.nowMs ?? Date.now()) - (opts.cutoffMs ?? PENDING_UPLOAD_ORPHAN_CUTOFF_MS)).toISOString(); const cutoffAt = Date.parse(cutoff);

  let rows: PendingRow[];
  try {
    const { data, error } = await sc
      .from("post_media")
      .select("id, user_id, post_id, storage_path, storage_bucket, mime_type, created_at, updated_at")
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
  let completedMeanwhile = 0; let stillSending = 0;

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
        .select("id, updated_at")
        .eq("id", row.id)
        .eq("processing_status", "pending")
        .maybeSingle();
      if (stillErr) {
        log.warn?.({ err: stillErr, mediaId: row.id }, "pending-upload sweep: re-read failed — row kept for retry");
        errors++;
        continue;
      }
      if (!still) { completedMeanwhile++; continue; }

      const bucket = sc.storage.from(row.storage_bucket || PENDING_UPLOAD_BUCKET); const activity = await latestSlotActivityMs(bucket, path, [row.created_at, row.updated_at, (still as { updated_at?: string | null }).updated_at]); if (activity === "unreadable") { log.warn?.({ mediaId: row.id }, "pending-upload sweep: parts listing unreadable — row kept"); errors++; continue; } if (activity >= cutoffAt) { stillSending++; continue; } // §81: an owner still sending is never swept
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

  return { ok: true, swept, errors, examined: rows.length, completedMeanwhile, stillSending, more: rows.length >= limit };
}

// ── census-discovery §81 (DV-77; register D-W10S2-6) — latest activity ──────

/** A listing entry, as Supabase Storage returns one (timestamps are ISO strings). */
interface ListedObject { name?: string; updated_at?: string | null; created_at?: string | null }

/**
 * The latest instant anything happened to a slot: the row's reservation and
 * renewal times, and the newest write in its resumable parts folder. An
 * unreadable listing is "unreadable" — never "no parts" — and the caller keeps
 * the row: a deletion must not run on a guess about whether its owner is still
 * sending.
 */
export async function latestSlotActivityMs(
  bucket: { list: (folder: string, opts?: Record<string, unknown>) => Promise<{ data: ListedObject[] | null; error: { message?: string } | null }> },
  storagePath: string,
  rowInstants: ReadonlyArray<string | null | undefined>,
): Promise<number | "unreadable"> {
  let latest = Number.NEGATIVE_INFINITY;
  for (const t of rowInstants) {
    const ms = typeof t === "string" ? Date.parse(t) : NaN;
    if (Number.isFinite(ms) && ms > latest) latest = ms;
  }
  let listed: Awaited<ReturnType<typeof bucket.list>>;
  try {
    listed = await bucket.list(partsFolderFor(storagePath), { limit: MAX_RESUMABLE_PARTS + 50 });
  } catch {
    return "unreadable";
  }
  if (listed.error || !Array.isArray(listed.data)) return "unreadable";
  for (const o of listed.data) {
    const ms = Date.parse(String(o.updated_at ?? o.created_at ?? ""));
    if (Number.isFinite(ms) && ms > latest) latest = ms;
  }
  return latest;
}

/**
 * Stamp a pending slot as renewed, BEFORE a resumable session mints part URLs
 * for it, so the sweep measures from the moment a live upload authority was
 * last issued. Only a still-`pending` row is touched. A failed stamp is
 * reported, and the session refuses rather than mint URLs the sweep cannot see.
 */
export async function renewPendingSlot(
  sc: SupabaseClient,
  mediaId: string,
  nowMs: number = Date.now(),
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { error } = await sc
    .from("post_media")
    .update({ updated_at: new Date(nowMs).toISOString() })
    .eq("id", mediaId)
    .eq("processing_status", "pending");
  if (error) return { ok: false, message: String(error.message ?? "post_media renewal failed") };
  return { ok: true };
}
