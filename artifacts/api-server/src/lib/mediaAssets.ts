/**
 * mediaAssets — the canonical media layer (spec §9) + the display-media
 * priority resolver (spec §4).
 *
 * media_assets is the single source of truth for an uploaded file's metadata,
 * processing state, and provenance; media_attachments links one asset to any
 * entity without duplicating metadata. Writes here are DUAL-WRITE, flag-gated
 * (`media_canonical_enabled`) and fail-soft: legacy bare-URL columns keep
 * working untouched; when the flag is off (or an insert fails) callers proceed
 * exactly as before. The idempotent backfill script
 * (scripts/backfill-media-assets.ts) links pre-existing media.
 *
 * THE FLAG IS NOT OFF. MEASURED 2026-09-07 (do not infer this from 0191's seed):
 *
 *   travel-buddy  ajrurzioarfkagpuxfnb  (production)  media_canonical_enabled = TRUE
 *   portava-ci    hwokxgbmezheskbzskfr  (CI)          NO ROW AT ALL -> false
 *
 * 0191 seeds it FALSE and 2250's postcondition asserts it is FALSE, so every
 * comment in this tree that calls the canonical layer "dark" is reading the
 * migration, not the database. In production it is lit — and has been writing
 * nothing anyway since 2026-08-16, because the payload names three columns that
 * database does not have — captured_at, provenance, intelligence_eligibility;
 * see CANONICAL_ASSET_COLUMNS_ADDED_BY_2250, which lists all four that
 * migration 2250 adds (location_visibility is never sent by this writer).
 *
 * The dead writer is not only an empty table. `routes/sharedMoments.ts:230`
 * GATES a contribution on `media_assets` having a row the caller owns
 * ("You can only contribute your own media"), so with the writer dead that
 * request path cannot succeed for any media uploaded since 2026-08-16.
 *
 * Consequence for anyone editing this file: a change here is NOT dark in
 * production. Gate it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isFlagEnabled } from "./featureFlags.js";
import { logger } from "./logger.js";
import { appStorageUrlInfo } from "./mediaUrl.js";
import { exifFactsFrom } from "./exifFacts.js";
import {
  initProvenance,
  appendEdit,
  normalizeProvenance,
  computeIntelligenceEligibility,
  type AppendEditOptions,
} from "./media/mediaEvidenceEligibility.js";

// ── Capture time (§6 / Wall §16 "two clocks") ────────────────────────────────

/**
 * `media_assets.captured_at` existed, `RecordAssetInput.capturedAt` existed, the
 * provenance + evidence-eligibility computation read it, and the Wall's §16
 * `experienceAt` producer (`loadCapturedAtByEntity`) joined to it — but NO
 * production caller ever supplied a non-null value. Both `recordMediaAsset`
 * call sites omitted the field, so the column had no writer, `experienceAt`
 * could never differ from `publishedAt`, and every consumer took the
 * `?? publishedAt` fallback forever.
 *
 * This is that writer. The upload route already holds the raw bytes and already
 * parses their EXIF — `lib/exifFacts` is the presence-and-count parser behind
 * `audit:storage-exif`, and it reads DateTimeOriginal/DateTime while
 * deliberately never being able to produce a coordinate. Capture time is read
 * from the RAW buffer, before `processImage` strips the metadata.
 *
 * PLAUSIBILITY IS ENFORCED, NOT ASSUMED. A camera with a dead clock, a
 * hand-edited tag, or a container we mis-parse can all yield a date decades out.
 * A `captured_at` that is wrong is worse than one that is absent: it feeds
 * evidence eligibility and would put a Wall object on the wrong day. So a value
 * outside [EARLIEST_PLAUSIBLE_CAPTURE, now + CAPTURE_CLOCK_SKEW_MS] is discarded
 * and the column stays null — the honest "unknown".
 */
export const EARLIEST_PLAUSIBLE_CAPTURE_ISO = "1990-01-01T00:00:00.000Z";

/**
 * How far ahead of the server clock a capture time may sit before it is
 * rejected. Device clocks drift and EXIF carries no timezone, so a photo taken
 * "now" in a UTC+14 timezone legitimately reads up to 14 h in the future once
 * exifFacts stamps the naive local time with a `Z`. 24 h covers that plus
 * ordinary skew without admitting a wrong-decade date.
 */
export const CAPTURE_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * Extract a plausible capture instant from an uploaded image's raw bytes.
 * Returns an ISO string, or null when there is no EXIF, the container is one
 * exifFacts does not scan, or the value fails the plausibility window.
 *
 * Never throws: a capture time is an enrichment, and an upload must never fail
 * because its metadata was odd.
 */
export function capturedAtFromImageBytes(
  buf: Buffer,
  now: Date = new Date(),
): string | null {
  try {
    const facts = exifFactsFrom(buf);
    const raw = facts?.captureTs;
    if (!raw) return null;
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms)) return null;
    if (ms < Date.parse(EARLIEST_PLAUSIBLE_CAPTURE_ISO)) return null;
    if (ms > now.getTime() + CAPTURE_CLOCK_SKEW_MS) return null;
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

// ── Canonical asset writes (dual-write, fail-soft) ────────────────────────────

export interface RecordAssetInput {
  ownerUserId: string;
  storageBucket: string;
  storagePath: string;
  publicUrl: string;
  mediaType: "image" | "video";
  mimeType: string;
  sizeBytes: number;
  width?: number | null;
  height?: number | null;
  thumbnailPath?: string | null;
  thumbnailUrl?: string | null;
  /** provenance: 'user' | 'official' | 'provider' | 'community' | ... */
  sourceType?: string;
  processingStatus?: string;
  /** §6 capturedAt (may precede uploadedAt); feeds provenance + eligibility. */
  capturedAt?: string | null;
  /** True when the asset carries a trustworthy location binding (§10). */
  hasLocation?: boolean;
}

// ── Schema skew: the §6 columns that are NOT everywhere ──────────────────────

/**
 * The `media_assets` columns added by migration **2250**
 * (`2250_media_asset_canonical_model.sql`), and by nothing before it.
 *
 * WHY THIS LIST EXISTS — MEASURED, NOT ASSUMED
 * ============================================
 * Read on 2026-09-07 from `information_schema.columns` in BOTH databases:
 *
 *   portava-ci   hwokxgbmezheskbzskfr   27 columns — 2250 APPLIED
 *   travel-buddy ajrurzioarfkagpuxfnb   23 columns — 2250 NOT APPLIED
 *     (`supabase_migrations.schema_migrations` has 2260, 2261, 2270-2272 and
 *      no 2250; the four columns below are simply absent.)
 *
 * `recordMediaAsset` sends `captured_at`, `provenance` and
 * `intelligence_eligibility` in EVERY upsert. PostgREST rejects the WHOLE
 * statement when one column is unknown (PGRST204, "Could not find the '…'
 * column of 'media_assets' in the schema cache"), the `if (error) return null`
 * below swallowed it, and every caller does `void recordMediaAsset(...)`.
 *
 * So the canonical write has been a SILENT TOTAL LOSS in production — not
 * because the flag is off (it is ON there: `feature_flags.media_canonical_enabled
 * = true`), but because the payload names columns the target database lacks.
 * The row counts show exactly that shape: 8 assets written 2026-07-25 →
 * 2026-08-16, then nothing.
 *
 * THE WRITE IS NOT THE ONLY CASUALTY. Four other code paths name those same
 * columns and are therefore also broken wherever 2250 is missing, three of them
 * silently:
 *
 *   • `services/intel/PresenceVerifier.checkReceipt` selects `provenance,
 *     captured_at` and THROWS on the error — the only one that is loud;
 *   • `lib/media/mediaEvidenceLink` selects `provenance, captured_at` and
 *     returns false on error, so §35 evidence can never be confirmed;
 *   • `services/wall/WallCandidateLoaders` joins `media_assets(captured_at)`
 *     for the §16 experienceAt clock;
 *   • `scripts/backfill-media-assets.ts` writes `moderation_status='active'`,
 *     a value the pre-2250 CHECK rejects outright.
 *
 * The real repair is to apply 2250. This constant exists so that a database
 * that has NOT had it applied yet degrades to a recorded row instead of to
 * nothing — and so that the failure is never silent again.
 */
export const CANONICAL_ASSET_COLUMNS_ADDED_BY_2250 = [
  "captured_at",
  "location_visibility",
  "provenance",
  "intelligence_eligibility",
] as const;

/**
 * True when a Supabase/PostgREST error means "this database does not have that
 * column", as opposed to any other failure.
 *
 * Two shapes, because two layers can raise it:
 *   • PostgREST schema cache — code `PGRST204`, message
 *     `Could not find the 'captured_at' column of 'media_assets' in the schema cache`
 *   • PostgreSQL itself — SQLSTATE `42703`, message
 *     `column "captured_at" of relation "media_assets" does not exist`
 *
 * PURE. Never throws on a malformed error object.
 */
export function isMissingColumnError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = String((error as any).code ?? "");
  if (code === "PGRST204" || code === "42703") return true;
  const msg = String((error as any).message ?? "").toLowerCase();
  return (
    msg.includes("in the schema cache") ||
    (msg.includes("column") && msg.includes("does not exist"))
  );
}

/** What a canonical asset write actually did. */
export type CanonicalWriteOutcome =
  /** The full §6 payload was accepted. */
  | "written"
  /** Accepted only after dropping the columns this database lacks. */
  | "written_degraded"
  /** `media_canonical_enabled` is off — no DB contact beyond the flag read. */
  | "skipped_flag_off"
  /** The write did not land. `errorCode` says why. */
  | "failed";

export interface RecordAssetResult {
  /** The media_assets id, or null when nothing was written. */
  assetId: string | null;
  outcome: CanonicalWriteOutcome;
  /**
   * §6 columns dropped to make the write land. Non-empty ONLY for
   * `written_degraded`; those fields are NOT recorded on the row and a later
   * pass (after 2250 is applied) must fill them in.
   */
  droppedColumns: string[];
  /** The error code that ended a failed attempt, when the driver supplied one. */
  errorCode: string | null;
}

/**
 * Insert a media_assets row. Returns the asset id, or null when the flag is
 * off / insert fails (callers continue on the legacy path). Idempotent on
 * (storage_bucket, storage_path).
 *
 * Thin wrapper over `recordMediaAssetDetailed` — the signature and the
 * fire-and-forget contract of the two call sites (`routes/posts.ts:256` and
 * `recordEntityMedia` below) are unchanged.
 */
export async function recordMediaAsset(
  sc: SupabaseClient,
  input: RecordAssetInput,
): Promise<string | null> {
  return (await recordMediaAssetDetailed(sc, input)).assetId;
}

/**
 * recordMediaAssetDetailed — the canonical §6 asset write, with its outcome
 * made legible.
 *
 * TWO THINGS CHANGE HERE, AND ONLY TWO:
 *
 * 1. THE FAILURE IS NO LONGER SILENT. When the flag is ON and the upsert is
 *    rejected, that is logged at warn. No data changes; nothing a user sees
 *    changes. This is the whole reason a three-week production outage of the
 *    canonical layer was invisible.
 *
 * 2. A MISSING-COLUMN REJECTION CAN DEGRADE INSTEAD OF VANISHING — but ONLY
 *    when `media_canonical_schema_fallback_enabled` is deliberately turned on.
 *    That flag is seeded FALSE by migration 2336 (applied to portava-ci
 *    2026-09-07; NOT applied to production, where the row is simply absent and
 *    `isFlagEnabled` returns false for a missing row either way). So the branch
 *    is unreachable in both databases as they stand. WITHOUT the flag,
 *    behaviour is byte-identical to before: return null, write nothing.
 *
 * WHY THE DEGRADED WRITE IS GATED AT ALL. `media_canonical_enabled` is TRUE in
 * production, so an ungated repair here would start writing media_assets rows
 * in production the moment it deployed — and `media_assets` IS on user-facing
 * read paths. Three of them, none of which a `from("media_assets")` grep finds
 * in full:
 *
 *   • `services/wall/WallCandidateLoaders.loadQuickMediaItems` — the §18
 *     Stories / Quick Media row, selecting assets from the last 24 h;
 *   • `services/media/MediaProjectionService` line ~746 —
 *     `countOwned(sc, "media_assets", "owner_user_id", viewerId)`, the §30
 *     My World "Uploads" bucket count. That one reaches `.from(table)` through
 *     a VARIABLE, exactly the blind spot `src/scripts/checkWriterlessReads.ts`
 *     warns about;
 *   • `lib/mediaAccess.ts:238` — owner attribution before the bytes are served,
 *     i.e. an authorization input, not a display one.
 *
 * Repairing the writer without a switch would move all three as a side effect
 * of a bug fix. It gets its own switch.
 *
 * The retry drops ALL of CANONICAL_ASSET_COLUMNS_ADDED_BY_2250, not just the
 * one PostgREST named: PostgREST reports the first unknown column only, so
 * removing them one at a time would cost one round trip per column and leave
 * the same total loss in between.
 */
export async function recordMediaAssetDetailed(
  sc: SupabaseClient,
  input: RecordAssetInput,
): Promise<RecordAssetResult> {
  const NONE: RecordAssetResult = {
    assetId: null,
    outcome: "skipped_flag_off",
    droppedColumns: [],
    errorCode: null,
  };
  try {
    if (!(await isFlagEnabled(sc, "media_canonical_enabled"))) return NONE;

    // §35/§10: record provenance (source + empty edit lineage) and compute the
    // evidence-eligibility verdict at write time. Fresh uploads have no edits,
    // so eligibility is driven purely by source + capture. This is a PURE
    // computation; it runs only on the flag-on write path.
    const provenance = initProvenance({
      sourceType: input.sourceType ?? "user",
      capturedAt: input.capturedAt ?? null,
      hasLocation: input.hasLocation ?? false,
    });
    const intelligenceEligibility = computeIntelligenceEligibility({
      sourceType: provenance.sourceType,
      capturedAt: provenance.capturedAt,
      editHistory: provenance.editHistory,
      hasLocation: provenance.hasLocation,
    });

    const row: Record<string, unknown> = {
      owner_user_id: input.ownerUserId,
      uploader_user_id: input.ownerUserId,
      storage_bucket: input.storageBucket,
      storage_path: input.storagePath,
      public_url: input.publicUrl,
      media_type: input.mediaType,
      mime_type: input.mimeType,
      size_bytes: input.sizeBytes,
      width: input.width ?? null,
      height: input.height ?? null,
      thumbnail_path: input.thumbnailPath ?? null,
      thumbnail_url: input.thumbnailUrl ?? null,
      source_type: input.sourceType ?? "user",
      captured_at: input.capturedAt ?? null,
      provenance,
      intelligence_eligibility: intelligenceEligibility,
      // Default to 'processing' (not 'ready') when dimensions are absent —
      // a video upload has null width/height at upload time, and the DB
      // constraint (2089) rejects ready rows with null dimensions. Callers
      // that have already resolved dimensions can pass processingStatus
      // explicitly to override.
      processing_status:
        input.processingStatus ??
        (input.width != null && input.height != null ? "ready" : "processing"),
    };

    const first = await upsertAssetRow(sc, row);
    if (!first.error) {
      return { assetId: first.id, outcome: "written", droppedColumns: [], errorCode: null };
    }

    const errorCode = String((first.error as any)?.code ?? "") || null;
    const missingColumn = isMissingColumnError(first.error);

    // (1) Never silent again.
    logger.warn(
      {
        err: first.error,
        bucket: input.storageBucket,
        path: input.storagePath,
        missingColumn,
      },
      "media_assets upsert rejected — canonical asset NOT recorded",
    );

    if (!missingColumn) {
      return { assetId: null, outcome: "failed", droppedColumns: [], errorCode };
    }
    // (2) Degraded write — deliberately switched on, or not at all.
    if (!(await isFlagEnabled(sc, "media_canonical_schema_fallback_enabled"))) {
      return { assetId: null, outcome: "failed", droppedColumns: [], errorCode };
    }

    const dropped: string[] = [];
    for (const col of CANONICAL_ASSET_COLUMNS_ADDED_BY_2250) {
      if (col in row) {
        delete row[col];
        dropped.push(col);
      }
    }
    const second = await upsertAssetRow(sc, row);
    if (second.error) {
      logger.warn(
        { err: second.error, bucket: input.storageBucket, path: input.storagePath },
        "media_assets degraded upsert also rejected — canonical asset NOT recorded",
      );
      return {
        assetId: null,
        outcome: "failed",
        droppedColumns: [],
        errorCode: String((second.error as any)?.code ?? "") || null,
      };
    }
    logger.warn(
      { bucket: input.storageBucket, path: input.storagePath, dropped },
      "media_assets recorded WITHOUT its §6 columns — apply migration 2250 to this database",
    );
    return {
      assetId: second.id,
      outcome: "written_degraded",
      droppedColumns: dropped,
      errorCode: null,
    };
  } catch (err) {
    logger.warn({ err }, "media_assets upsert threw — canonical asset NOT recorded");
    return { assetId: null, outcome: "failed", droppedColumns: [], errorCode: null };
  }
}

/** One upsert attempt. Never throws; returns the id or the driver's error. */
async function upsertAssetRow(
  sc: SupabaseClient,
  row: Record<string, unknown>,
): Promise<{ id: string | null; error: unknown }> {
  try {
    const { data, error } = await sc
      .from("media_assets")
      .upsert(row, { onConflict: "storage_bucket,storage_path" })
      .select("id")
      .single();
    if (error) return { id: null, error };
    return { id: ((data as any)?.id ?? null) as string | null, error: null };
  } catch (error) {
    return { id: null, error };
  }
}

// ── Post-transcode status transition ─────────────────────────────────────────

export interface CompleteTranscodeInput {
  /** Required: server-measured pixel dimensions from the transcoder output. */
  width: number;
  height: number;
  thumbnailPath?: string | null;
  thumbnailUrl?: string | null;
  /** Transcoder-reported duration in seconds; stored as duration_ms (×1000). */
  durationSeconds?: number | null;
}

/**
 * Transition a media_assets row from 'processing' → 'ready' after a video
 * transcode (or any async processing step) completes.
 *
 * Width and height are REQUIRED — the DB constraint added in migration 2089
 * rejects ready rows with null dimensions.  We enforce that here so the caller
 * gets a clear Error rather than a cryptic DB constraint violation.
 *
 * Fail-soft: returns false on a Supabase error so the caller can log and
 * schedule a retry rather than crashing.  The row stays in 'processing' and
 * can be re-attempted by the worker or an admin sweep.
 *
 * @throws {Error} when width or height is not supplied (programming mistake —
 *   the caller MUST measure dimensions before calling this function).
 */
export async function completeVideoTranscode(
  sc: SupabaseClient,
  assetId: string,
  input: CompleteTranscodeInput,
): Promise<boolean> {
  // Hard guard — never write a ready+null-dimension row.  The DB constraint
  // would catch it anyway, but surfacing it here gives callers a clear stack
  // trace rather than an opaque PGRST204 from deep inside Supabase.
  if (input.width == null || input.height == null) {
    throw new Error(
      `completeVideoTranscode: width and height are required to mark asset ${assetId} as ready`,
    );
  }
  try {
    const { error } = await sc
      .from("media_assets")
      .update({
        processing_status: "ready",
        width: input.width,
        height: input.height,
        thumbnail_path: input.thumbnailPath ?? null,
        thumbnail_url: input.thumbnailUrl ?? null,
        // media_assets models duration as duration_ms (INTEGER, migration
        // 0191) — there is no duration_seconds column here. The transcoder
        // reports seconds (often fractional), so convert to whole ms.
        duration_ms:
          input.durationSeconds != null
            ? Math.round(input.durationSeconds * 1000)
            : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", assetId);
    return !error;
  } catch {
    return false;
  }
}

// ── §35 evidence contract re-export (canonical entry point) ──────────────────
// The media→intel evidence seam (later phase) calls isEvidenceEligible as the
// single gate. Re-exported here so the canonical media layer is its home; the
// pure classifier lives in ./media/mediaEvidenceEligibility.ts.
export {
  isEvidenceEligible,
  evaluateEvidenceEligibility,
  computeIntelligenceEligibility,
  classifyEdit,
  appendEdit,
  initProvenance,
  type IntelligenceEligibility,
  type MediaProvenance,
  type EditLineageEntry,
  type EditClass,
} from "./media/mediaEvidenceEligibility.js";

// ── §35 Evidence-safe edit lineage (write-side hook) ─────────────────────────

export interface RecordMediaEditResult {
  /** Whether the lineage/eligibility update was persisted. */
  recorded: boolean;
  /** The recomputed live-evidence verdict after this edit. */
  evidenceEligible: boolean;
}

/**
 * recordMediaEdit — append one §35 edit to an asset's provenance lineage and
 * recompute its §10 intelligence_eligibility.
 *
 * This is the write-side hook for a media edit flow. There is NO media
 * crop/edit endpoint today, so nothing calls this yet — it is built additively
 * so that ANY future edit (crop, brightness, generative fill, …) records its
 * lineage through one choke-point that keeps the evidence gate honest:
 *   - a crop/brightness/rotate edit keeps the asset evidence-eligible;
 *   - a generative alteration (or an unclassified edit) flips it to
 *     social-only, NOT live evidence — fail-closed.
 *
 * Lineage is APPENDED, never overwritten: the prior history is read and the new
 * entry is added to the end. GATED + fail-soft: returns null when the flag is
 * off (dark) or the asset can't be read; returns {recorded:false,...} when the
 * update itself errors (the eligibility was still computed).
 */
export async function recordMediaEdit(
  sc: SupabaseClient,
  assetId: string,
  op: string,
  opts: AppendEditOptions = {},
): Promise<RecordMediaEditResult | null> {
  try {
    if (!(await isFlagEnabled(sc, "media_canonical_enabled"))) return null;

    const { data, error } = await sc
      .from("media_assets")
      .select("source_type, provenance, captured_at")
      .eq("id", assetId)
      .maybeSingle();
    if (error || !data) return null;

    const row = data as {
      source_type?: string | null;
      provenance?: unknown;
      captured_at?: string | null;
    };
    const current =
      normalizeProvenance(row.provenance) ??
      initProvenance({ sourceType: row.source_type ?? "user", capturedAt: row.captured_at ?? null });

    // Append the edit (pure; prior lineage preserved) and recompute eligibility.
    const nextProvenance = appendEdit(current, op, opts);
    const eligibility = computeIntelligenceEligibility({
      sourceType: nextProvenance.sourceType,
      capturedAt: nextProvenance.capturedAt,
      editHistory: nextProvenance.editHistory,
      hasLocation: nextProvenance.hasLocation,
    });

    const { error: upErr } = await sc
      .from("media_assets")
      .update({
        provenance: nextProvenance,
        intelligence_eligibility: eligibility,
        updated_at: new Date().toISOString(),
      })
      .eq("id", assetId);
    if (upErr) return { recorded: false, evidenceEligible: eligibility.eligible };
    return { recorded: true, evidenceEligible: eligibility.eligible };
  } catch {
    return null;
  }
}

/** Attach an asset to an entity (idempotent). Fail-soft: returns false on error. */
export async function attachMediaAsset(
  sc: SupabaseClient,
  opts: {
    mediaAssetId: string;
    entityType: string;
    entityId: string;
    position?: number;
    isCover?: boolean;
  },
): Promise<boolean> {
  try {
    const { error } = await sc.from("media_attachments").upsert(
      {
        media_asset_id: opts.mediaAssetId,
        entity_type: opts.entityType,
        entity_id: opts.entityId,
        position: opts.position ?? 0,
        is_cover: opts.isCover ?? false,
      },
      { onConflict: "media_asset_id,entity_type,entity_id" },
    );
    return !error;
  } catch {
    return false;
  }
}

// ── Canonical attachment writes (spec §6.1) ──────────────────────────────────

/**
 * The §6.1 MediaAttachment entityType union: one asset can participate in many
 * product objects without duplicating the underlying file. This is the closed
 * set the canonical attachment layer accepts.
 */
export const ATTACHMENT_ENTITY_TYPES = [
  "post",
  "postcard",
  "memory",
  "trip",
  "place",
  "event",
  "hidden_gem",
  "shared_moment",
  "observation",
] as const;
export type AttachmentEntityType = (typeof ATTACHMENT_ENTITY_TYPES)[number];
const ATTACHMENT_ENTITY_TYPE_SET: ReadonlySet<string> = new Set(ATTACHMENT_ENTITY_TYPES);

export interface RecordAttachmentInput {
  mediaAssetId: string;
  /** Must be one of the §6.1 entityTypes; an unknown value is rejected. */
  entityType: AttachmentEntityType;
  entityId: string;
  position?: number;
  isCover?: boolean;
  visibilityOverride?: string | null;
}

/**
 * recordMediaAttachment — the canonical §6.1 attachment write path (the piece
 * that did not exist: media_attachments had ZERO writer before this).
 *
 * Links one media_assets row to one product entity. Returns the attachment id,
 * or null when:
 *   - the entityType is not a known §6.1 type (REJECTED — no row written), or
 *   - the flag `media_canonical_enabled` is off (dual-write stays dark), or
 *   - the upsert fails (fail-soft — callers proceed on the legacy path).
 *
 * Idempotent on (media_asset_id, entity_type, entity_id): re-running attaches
 * once. The entityType check runs BEFORE the flag read so an unknown type is
 * rejected without any DB contact.
 */
export async function recordMediaAttachment(
  sc: SupabaseClient,
  input: RecordAttachmentInput,
): Promise<string | null> {
  try {
    // Reject an unknown entityType up front — never write an untyped link.
    if (!ATTACHMENT_ENTITY_TYPE_SET.has(input.entityType)) return null;
    if (!(await isFlagEnabled(sc, "media_canonical_enabled"))) return null;

    const row: Record<string, unknown> = {
      media_asset_id: input.mediaAssetId,
      entity_type: input.entityType,
      entity_id: input.entityId,
      position: input.position ?? 0,
      is_cover: input.isCover ?? false,
    };
    if (input.visibilityOverride != null) row.visibility_override = input.visibilityOverride;

    const { data, error } = await sc
      .from("media_attachments")
      .upsert(row, { onConflict: "media_asset_id,entity_type,entity_id" })
      .select("id")
      .single();
    if (error) return null;
    return (data as any)?.id ?? null;
  } catch {
    return null;
  }
}

// ── Dual-write fan-out for per-object media creation (spec §6/§6.1) ───────────

export interface RecordEntityMediaInput {
  ownerUserId: string;
  /** A storage-backed URL (full public URL or bare `<bucket>/<path>`). */
  publicUrl: string;
  entityType: AttachmentEntityType;
  entityId: string;
  position?: number;
  isCover?: boolean;
  /** §6 sourceType; defaults to the legacy 'user' when omitted. */
  sourceType?: string;
}

/**
 * recordEntityMedia — the dual-write fan-out called where a per-object media
 * (postcard / memory / hidden_gem / shared_moment / …) is created. It ensures a
 * canonical media_assets row exists for `publicUrl` and links a
 * media_attachments row of the given entityType — the "one asset, many entity
 * types" model (§6.1) — mirroring how routes/posts.ts records the asset at
 * upload time.
 *
 * GATED + fail-soft: when `media_canonical_enabled` is off (the current dark
 * state) this returns {null,null} after a single flag read and performs NO
 * media_assets / media_attachments write, so the per-object path is unchanged.
 *
 * It does NOT clobber richer upload-time metadata: if an asset already exists
 * for (bucket, path) — the usual case, because the file was recorded by the
 * upload path — it reuses that row and only adds the attachment. It creates a
 * minimal asset only when none exists. URLs that are not our storage
 * (external / injected) are ignored, never guessed at.
 */
export async function recordEntityMedia(
  sc: SupabaseClient,
  input: RecordEntityMediaInput,
): Promise<{ assetId: string | null; attachmentId: string | null }> {
  const NONE = { assetId: null as string | null, attachmentId: null as string | null };
  try {
    if (!ATTACHMENT_ENTITY_TYPE_SET.has(input.entityType)) return NONE;
    // One flag read gates the whole fan-out: off ⇒ zero canonical writes.
    if (!(await isFlagEnabled(sc, "media_canonical_enabled"))) return NONE;

    const ref = appStorageUrlInfo(input.publicUrl);
    if (!ref) return NONE; // external / unresolvable URL — never fabricated

    let assetId: string | null = null;
    const { data: existing } = await sc
      .from("media_assets")
      .select("id")
      .eq("storage_bucket", ref.bucket)
      .eq("storage_path", ref.path)
      .maybeSingle();
    if ((existing as any)?.id) {
      assetId = (existing as any).id as string;
    } else {
      const mediaType: "image" | "video" = /\.(mp4|mov|m4v|webm)(\?|$)/i.test(input.publicUrl)
        ? "video"
        : "image";
      assetId = await recordMediaAsset(sc, {
        ownerUserId: input.ownerUserId,
        storageBucket: ref.bucket,
        storagePath: ref.path,
        publicUrl: input.publicUrl,
        mediaType,
        mimeType: mediaType === "video" ? "video/mp4" : "image/jpeg",
        // Size/dimensions are unknown at entity-creation time (the upload path
        // measured them); honest zero, staged 'processing' so it is not served
        // as ready until a dimension sweep fills it in.
        sizeBytes: 0,
        sourceType: input.sourceType,
        processingStatus: "processing",
      });
    }
    if (!assetId) return NONE;

    const attachmentId = await recordMediaAttachment(sc, {
      mediaAssetId: assetId,
      entityType: input.entityType,
      entityId: input.entityId,
      position: input.position,
      isCover: input.isCover,
    });
    return { assetId, attachmentId };
  } catch {
    return NONE;
  }
}

// ── Display-media priority resolver (pure, spec §4) ───────────────────────────

export type DisplayMediaSource =
  | "user"
  | "official"
  | "provider"
  | "community"
  | "related_content"
  | "map_preview"
  | "category_artwork"
  | "generated"
  | "designed_fallback";

/** Authentic-first priority order (spec §1.4). Lower index wins. */
export const SOURCE_PRIORITY: DisplayMediaSource[] = [
  "user",
  "official",
  "provider",
  "community",
  "related_content",
  "map_preview",
  "category_artwork",
  "generated",
  "designed_fallback",
];

export interface DisplayMediaCandidate {
  uri: string | null;
  source: DisplayMediaSource;
  thumbnailUri?: string | null;
  altText?: string | null;
  attribution?: string | null;
  isGenerated?: boolean;
}

export interface DisplayMediaResult {
  uri: string | null;
  thumbnailUri: string | null;
  source: DisplayMediaSource;
  altText: string;
  attribution: string | null;
  isGenerated: boolean;
  /** When source is designed_fallback: the category key the client renders. */
  fallbackCategory: string | null;
}

/**
 * Pick the best display media from candidates by authenticity priority.
 * NEVER returns null: with no usable candidate it returns a deterministic
 * designed-fallback descriptor (the client renders category artwork), so no
 * card can collapse to a blank header (spec §3.2). Generated media is always
 * labeled (isGenerated) so it can't be misrepresented as an authentic photo.
 */
export function resolveDisplayMedia(
  candidates: DisplayMediaCandidate[],
  opts: { entityTitle: string; fallbackCategory: string },
): DisplayMediaResult {
  const usable = (candidates ?? []).filter((c) => c && typeof c.uri === "string" && c.uri.trim() !== "");
  usable.sort((a, b) => SOURCE_PRIORITY.indexOf(a.source) - SOURCE_PRIORITY.indexOf(b.source));
  const best = usable[0];
  if (best) {
    return {
      uri: best.uri,
      thumbnailUri: best.thumbnailUri ?? null,
      source: best.source,
      altText: best.altText?.trim() || opts.entityTitle,
      attribution: best.attribution ?? null,
      isGenerated: best.isGenerated === true || best.source === "generated",
      fallbackCategory: null,
    };
  }
  return {
    uri: null,
    thumbnailUri: null,
    source: "designed_fallback",
    altText: opts.entityTitle,
    attribution: null,
    isGenerated: false,
    fallbackCategory: opts.fallbackCategory,
  };
}
