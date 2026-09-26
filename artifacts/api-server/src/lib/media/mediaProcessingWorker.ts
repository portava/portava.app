/**
 * mediaProcessingWorker — the production caller of MediaLifecycleService's
 * processing half. census-media §30 (MD338).
 *
 * ── WHAT WAS MISSING ─────────────────────────────────────────────────────────
 * `claimMediaProcessing`, `completeMediaProcessing`, `failMediaProcessing` and
 * `recoverStaleMediaProcessing` were built with leases, attempt rows and a
 * retry clock, and nothing outside a test called any of them. The one caller of
 * the lifecycle was the owner's `POST /media/:id/retry`, which wrote
 * `processing_status = 'queued'` — so a retried asset was parked in `queued`
 * for good, off every canonical read path (each serves `ready` only).
 *
 * ── WHAT ONE PASS DOES ───────────────────────────────────────────────────────
 *   0. Reads `media_processing_worker_enabled` (migration 3338, seeded FALSE)
 *      through the service's one reader. Off, absent or unreadable: the pass
 *      stops there — one flag read a minute, no other read, no write.
 *   1. Recovers stale leases (`recoverStaleMediaProcessing`): a `processing`
 *      row whose lease has lapsed becomes `failed`, scheduled for retry.
 *   2. Reads a bounded batch of CLAIMABLE work: `queued` (an owner's retry) and
 *      non-terminal `failed` (a failed or recovered attempt, due again),
 *      earliest retry first. `claimMediaProcessing` stays the authority on
 *      whether a row is due and unleased; the read only chooses candidates.
 *   3. Claims each one, re-runs the EXISTING pipeline over the STORED object
 *      (below), then completes it with the lease token — or fails it.
 *
 * NOT CLAIMED: a `processing` row with no lease. The upload route writes one
 * for a video whose container states no dimensions, and `recordEntityMedia`
 * writes one for every memory / hidden-gem / postcard file it records, staged
 * "until a dimension sweep fills it in". Completing those would publish them
 * as `ready` on the canonical read paths; that sweep is a separate decision and
 * this worker does not take it (census-media §30.6).
 *
 * ── WHAT "PROCESSING" MEANS HERE — THE EXISTING PIPELINE, RE-RUN ─────────────
 * The upload paths process bytes they are HOLDING (`routes/posts.ts`
 * `/media/upload`): `verifyUploadedBytes`, then for an image `processImage`
 * (auto-orient, cap, re-encode — which strips all EXIF — and measure), for a
 * video `stripVideoLocationMetadata` (fail-closed) and `probeVideoContainer`
 * (display size and duration). A queued asset's upload body is gone; what
 * exists is the stored object. So this worker downloads it and runs the same
 * functions over it:
 *
 *   • `verifyUploadedBytes(bytes, media_type)` — non-empty, recognisable,
 *     within its real kind's ceiling, and the kind the row says it is;
 *   • image: the stored still must carry no GPS IFD (`exifFactsFrom`, the
 *     `audit:storage-exif` parser, which never reads a coordinate), then
 *     `processImage` decodes it and measures it, exactly as at upload. The
 *     re-encoded buffer is DISCARDED: the worker never writes storage;
 *   • video: `stripVideoLocationMetadata` must find nothing to strip (a stored
 *     object that still carries location atoms is refused, not repaired), and
 *     `probeVideoContainer` must state a display size.
 *
 * THE LIMITS, STATED. The worker does not re-store, re-encode, thumbnail or
 * transcode anything: a stored object is either already what the pipeline
 * produced, or it is refused. It keeps the row's existing thumbnail and, when
 * the container is silent on it, its existing duration. A video whose container
 * states no display size cannot be completed here — there is no decoder in this
 * tier (lib/mediaProcessing.ts's header) — and fails terminally.
 *
 * ── FAILURE: RETRYABLE OR TERMINAL ───────────────────────────────────────────
 * A failure that another attempt could change — the object could not be read,
 * the asset row could not be re-read, something threw — is retryable on the
 * service's own clock (5 attempts, backoff from 30 s). A failure the stored
 * bytes decide — they do not verify, carry location, do not decode, state no
 * size — is TERMINAL at once (`maxAttempts = this attempt`): the object will
 * not change between attempts, so retrying it would only re-download it.
 *
 * ── GATING ───────────────────────────────────────────────────────────────────
 * The house pattern for a flag-gated interval worker (lib/eventLifecycle.ts,
 * server/trips/outboxWorker.ts): started unconditionally from src/index.ts, a
 * self-rescheduling timer so passes never overlap in one process, and the flag
 * read at the top of every pass. Across instances, the conditional claim makes
 * a duplicate worker harmless: only one lease token can land.
 */
import { logger } from "../logger.js";
import { getServiceClient } from "../supabase.js";
import { verifyUploadedBytes } from "../mediaPipeline.js";
import { processImage } from "../mediaProcessing.js";
import { stripVideoLocationMetadata, probeVideoContainer } from "../videoMetadata.js";
import { exifFactsFrom } from "../exifFacts.js";
import {
  claimMediaProcessing,
  completeMediaProcessing,
  failMediaProcessing,
  recoverStaleMediaProcessing,
  isMediaProcessingWorkerEnabled,
  type ProcessingClaim,
} from "../../services/media/MediaLifecycleService.js";

/** After the server is up; queued work is durable, nothing is lost by waiting. */
export const MEDIA_PROCESSING_STARTUP_DELAY_MS = 3 * 60 * 1000;
/** Between passes, measured from the END of the previous pass. */
export const MEDIA_PROCESSING_INTERVAL_MS = 60 * 1000;
/** Assets claimed per pass. A video can be 100 MB, and each one is held in memory once. */
export const MEDIA_PROCESSING_BATCH_LIMIT = 10;

/**
 * The longest edge `processImage` is asked to keep when it is MEASURING a
 * stored still rather than preparing one for storage. The upload caps at 4096
 * (`MAX_IMAGE_DIM`), so a stored pipeline output is never resampled by this
 * either way; the higher bound means a stored object larger than that is
 * measured as it IS, not as a capped copy of it. 16384 is also the bound
 * lib/videoProbe.ts treats as "larger than any real frame".
 */
const MEASURE_MAX_DIM = 16384;

export interface MediaProcessingPassResult {
  skipped: boolean;
  reason: "disabled" | "no_client" | "error" | null;
  recovered: number;
  scanned: number;
  /** Candidates whose retry clock had not come round; skipped without a claim. */
  notDue: number;
  claimed: number;
  completed: number;
  /** Failures recorded, retryable or terminal. */
  failed: number;
  /** Of `failed`, those recorded as terminal. */
  terminal: number;
  /** Candidates the claim refused: not due, leased, terminal, or a lost race. */
  contended: number;
  /** A claimed asset whose completion or failure no longer matched its lease. */
  lost: number;
  lastError: string | null;
}

const EMPTY: MediaProcessingPassResult = {
  skipped: true, reason: null, recovered: 0, scanned: 0, notDue: 0, claimed: 0, completed: 0,
  failed: 0, terminal: 0, contended: 0, lost: 0, lastError: null,
};

/** The asset fields processing reads, re-read AFTER the claim under its lease. */
export interface ClaimedAssetRow {
  id: string;
  storage_bucket: string;
  storage_path: string;
  media_type: string;
  duration_ms: number | null;
  thumbnail_path: string | null;
  thumbnail_url: string | null;
}

export type StoredAssetOutcome =
  | { ok: true; width: number; height: number; durationMs: number | null }
  | { ok: false; permanent: boolean; message: string };

/**
 * Re-run the upload pipeline over an asset's STORED object. Never throws, never
 * writes: it answers what the lifecycle transition should be.
 */
export async function processStoredMediaAsset(sc: any, asset: ClaimedAssetRow): Promise<StoredAssetOutcome> {
  const kind = asset.media_type === "image" || asset.media_type === "video" ? asset.media_type : null;
  if (!kind) return { ok: false, permanent: true, message: `Unknown media_type "${String(asset.media_type)}"` };

  let bytes: Buffer;
  try {
    const { data, error } = await sc.storage.from(asset.storage_bucket).download(asset.storage_path);
    if (error || !data) return { ok: false, permanent: false, message: "The stored object could not be read" };
    bytes = Buffer.from(await data.arrayBuffer());
  } catch {
    return { ok: false, permanent: false, message: "The stored object could not be read" };
  }

  // The upload's own verifier: the bytes decide, and they must be the kind the row says.
  const verified = verifyUploadedBytes(bytes, kind);
  if (!verified.ok) return { ok: false, permanent: true, message: verified.failure.message };
  const sniffed = verified.value;

  if (sniffed.kind === "image") {
    // processImage strips every EXIF block on the way INTO storage, so a stored
    // still that carries a GPS IFD did not come out of the pipeline. It is
    // refused rather than published; this worker never rewrites storage.
    if (exifFactsFrom(bytes)?.hasGpsIfd) {
      return { ok: false, permanent: true, message: "The stored image still carries GPS metadata" };
    }
    try {
      const img = await processImage(bytes, sniffed, MEASURE_MAX_DIM);
      return { ok: true, width: img.width, height: img.height, durationMs: null };
    } catch {
      return { ok: false, permanent: true, message: "Corrupt or undecodable image file" };
    }
  }

  // VIDEO. Probe first: the scrub below edits the buffer in place.
  const probe = probeVideoContainer(bytes);
  const scrub = stripVideoLocationMetadata(bytes, sniffed);
  if (!scrub.ok) return { ok: false, permanent: true, message: scrub.failure.message };
  if (scrub.stripped.length > 0) {
    return { ok: false, permanent: true, message: "The stored video still carries location metadata" };
  }
  if (!probe || !probe.width || !probe.height) {
    return {
      ok: false,
      permanent: true,
      message: "The video container states no display size, and this tier has no decoder to measure one",
    };
  }
  return { ok: true, width: probe.width, height: probe.height, durationMs: probe.durationMs };
}

async function readClaimedAsset(db: any, claim: ProcessingClaim): Promise<ClaimedAssetRow | null> {
  const { data, error } = await db
    .from("media_assets")
    .select("id, storage_bucket, storage_path, media_type, duration_ms, thumbnail_path, thumbnail_url")
    .eq("id", claim.assetId)
    .eq("processing_lease_token", claim.leaseToken)
    .maybeSingle();
  if (error || !data) return null;
  return data as ClaimedAssetRow;
}

/**
 * One pass. `client`: undefined means the service client; explicit null means
 * none (the house pattern — lib/eventLifecycle.ts). `now` is the clock the
 * recovery and the claim share, so a test is not a race against the wall.
 */
export async function runMediaProcessingPass(
  opts: {
    client?: any;
    now?: Date;
    limit?: number;
    processAsset?: (sc: any, asset: ClaimedAssetRow) => Promise<StoredAssetOutcome>;
  } = {},
): Promise<MediaProcessingPassResult> {
  const db = "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  if (!db) return { ...EMPTY, reason: "no_client" };
  // Fail-closed: absent row, unreadable table and a thrown client all read as off.
  if (!(await isMediaProcessingWorkerEnabled(db))) return { ...EMPTY, reason: "disabled" };

  const now = opts.now ?? new Date();
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? MEDIA_PROCESSING_BATCH_LIMIT), 1), 100);
  const processAsset = opts.processAsset ?? processStoredMediaAsset;
  const out: MediaProcessingPassResult = { ...EMPTY, skipped: false };

  try {
    out.recovered = await recoverStaleMediaProcessing(db, { now, limit });

    const { data, error } = await db
      .from("media_assets")
      .select("id, processing_next_retry_at")
      .in("processing_status", ["queued", "failed"])
      .eq("processing_terminal", false)
      .order("processing_next_retry_at", { ascending: true, nullsFirst: true })
      .limit(limit);
    if (error) {
      // supabase-js RESOLVES on a database error; unchecked, it would read as
      // "no work" and the pass would report a clean no-op.
      logger.warn({ err: error }, "media processing pass: claimable-work read failed");
      return { ...out, reason: "error", lastError: String(error.message ?? error) };
    }

    const rows = Array.isArray(data) ? (data as Array<{ id: string; processing_next_retry_at: string | null }>) : [];
    out.scanned = rows.length;

    for (const row of rows) {
      // Not due yet: skipped without a claim read. The claim re-checks this
      // itself, so this only saves a round trip; it never admits a row.
      if (row.processing_next_retry_at && Date.parse(row.processing_next_retry_at) > now.getTime()) {
        out.notDue += 1;
        continue;
      }
      const claim = await claimMediaProcessing(db, row.id, { now });
      if (!claim) { out.contended += 1; continue; }
      out.claimed += 1;

      let outcome: StoredAssetOutcome;
      const asset = await readClaimedAsset(db, claim);
      if (!asset) {
        outcome = { ok: false, permanent: false, message: "The claimed asset could not be re-read" };
      } else {
        try {
          outcome = await processAsset(db, asset);
        } catch (err) {
          outcome = { ok: false, permanent: false, message: err instanceof Error ? err.message : String(err) };
        }
      }

      if (outcome.ok && asset) {
        let done = false;
        try {
          done = await completeMediaProcessing(db, claim, {
            width: outcome.width,
            height: outcome.height,
            durationMs: outcome.durationMs ?? asset.duration_ms ?? null,
            // Completion writes both thumbnail columns; pass the row's own through
            // so completing an asset never erases the thumbnail it already has.
            thumbnailPath: asset.thumbnail_path ?? null,
            thumbnailUrl: asset.thumbnail_url ?? null,
          });
        } catch (err) {
          // completeMediaProcessing throws only on non-positive dimensions.
          outcome = { ok: false, permanent: true, message: err instanceof Error ? err.message : String(err) };
        }
        if (outcome.ok) {
          if (done) out.completed += 1;
          else out.lost += 1;
          continue;
        }
      }

      if (!outcome.ok) {
        const failure = await failMediaProcessing(
          db,
          claim,
          outcome.message,
          outcome.permanent ? { now, maxAttempts: claim.attemptNumber } : { now },
        );
        if (failure.ok) {
          out.failed += 1;
          if (failure.terminal) out.terminal += 1;
        } else {
          out.lost += 1;
        }
        out.lastError = outcome.message;
      }
    }
  } catch (err) {
    logger.warn({ err }, "media processing pass threw");
    return { ...out, reason: "error", lastError: err instanceof Error ? err.message : String(err) };
  }

  if (out.failed > 0 || out.lost > 0) {
    logger.warn({ ...out }, "media processing pass: some assets did not complete");
  } else if (out.recovered > 0 || out.completed > 0) {
    logger.info({ ...out }, "media processing pass complete");
  }
  return out;
}

let _timer: ReturnType<typeof setTimeout> | null = null;
/** Bumped by every stop, so a pass that was running when it came never re-arms a stopped (or restarted) loop. */
let _generation = 0;

/**
 * Started from src/index.ts. `runPass` exists for the wiring test only — the
 * entry point calls this with no argument, so production always runs the real
 * pass against the service client.
 */
export function startMediaProcessingWorker(
  deps: { runPass?: () => Promise<unknown> } = {},
): void {
  if (_timer !== null) return;
  const generation = _generation;
  const runPass = deps.runPass ?? (() => runMediaProcessingPass());
  logger.info(
    { startupDelayMs: MEDIA_PROCESSING_STARTUP_DELAY_MS, intervalMs: MEDIA_PROCESSING_INTERVAL_MS, flag: "media_processing_worker_enabled" },
    "MediaProcessingWorker scheduled (no-op until the flag is enabled)",
  );
  _timer = setTimeout(function tick() {
    void Promise.resolve()
      .then(runPass)
      .catch((err) => logger.warn({ err }, "media processing pass failed"))
      .finally(() => {
        if (generation === _generation) _timer = setTimeout(tick, MEDIA_PROCESSING_INTERVAL_MS);
      });
  }, MEDIA_PROCESSING_STARTUP_DELAY_MS);
}

export function stopMediaProcessingWorker(): void {
  _generation += 1;
  if (_timer !== null) { clearTimeout(_timer); _timer = null; }
}

/** Test hook: is a timer currently scheduled? */
export function _mediaProcessingWorkerArmed(): boolean {
  return _timer !== null;
}
