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
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isFlagEnabled } from "./featureFlags.js";
import { appStorageUrlInfo } from "./mediaUrl.js";
import {
  initProvenance,
  appendEdit,
  normalizeProvenance,
  computeIntelligenceEligibility,
  type AppendEditOptions,
} from "./media/mediaEvidenceEligibility.js";

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

/**
 * Insert a media_assets row. Returns the asset id, or null when the flag is
 * off / insert fails (callers continue on the legacy path). Idempotent on
 * (storage_bucket, storage_path).
 */
export async function recordMediaAsset(
  sc: SupabaseClient,
  input: RecordAssetInput,
): Promise<string | null> {
  try {
    if (!(await isFlagEnabled(sc, "media_canonical_enabled"))) return null;

    // §35/§10: record provenance (source + empty edit lineage) and compute the
    // evidence-eligibility verdict at write time. Fresh uploads have no edits,
    // so eligibility is driven purely by source + capture. This is a PURE
    // computation; it runs only on the flag-on write path (dark today).
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

    const { data, error } = await sc
      .from("media_assets")
      .upsert(
        {
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
        },
        { onConflict: "storage_bucket,storage_path" },
      )
      .select("id")
      .single();
    if (error) return null;
    return (data as any)?.id ?? null;
  } catch {
    return null;
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
