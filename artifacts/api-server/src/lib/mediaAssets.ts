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
        duration_seconds: input.durationSeconds ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", assetId);
    return !error;
  } catch {
    return false;
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
