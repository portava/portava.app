/**
 * mediaAssetContract — the §6 `MediaAsset` contract, as ONE typed shape the
 * canonical read produces from a `media_assets` row.
 *
 *   interface MediaAsset {
 *     id; ownerUserId; uploaderUserId; mediaType; storageBucket; storagePath;
 *     thumbnailPath?; mimeType; width?; height?; durationMs?; sizeBytes;
 *     capturedAt?; uploadedAt; sourceType; processingStatus; moderationStatus;
 *     visibility; locationVisibility; provenance; intelligenceEligibility;
 *     version;
 *   }
 *
 * PURE. No DB, no clock. The row it maps is read by
 * `lib/media/mediaCanonicalRead.attachCanonicalMedia` (the gated canonical read)
 * with `MEDIA_PROJECTION_MEDIA_ASSET_COLUMNS`; this module is what turns that row
 * into the spec's contract instead of an untyped bag of columns.
 *
 * TWO VOCABULARIES ARE RECONCILED HERE, AND ONLY HERE, FOR READING:
 *
 *   §36 MediaModerationStatus  processing | active | limited | rejected |
 *                              removed | owner_deleted
 *   legacy (0191)              pending | approved | flagged | rejected
 *
 * `media_assets.moderation_status` admits both (migration 2250/2470's superset
 * CHECK). The mapping is the one 2250's header documents — pending→processing,
 * approved→active, flagged→limited — and it is applied on READ, so a legacy row
 * is presented in the §36 vocabulary without being rewritten. An unknown value
 * maps to null, never to a guess.
 *
 * `visibility` is §33 MediaVisibility plus the storage default `inherit`
 * ("whatever the object this asset hangs off says"). An unknown value maps to
 * `private` — the fail-closed reading, the same one telegraph/shareables takes.
 */
import {
  normalizeProvenance,
  normalizeSourceType,
  type IntelligenceEligibility,
  type MediaProvenance,
  type MediaSourceType,
} from "./mediaEvidenceEligibility.js";
import {
  LOCATION_VISIBILITY_TIERS,
  type LocationVisibilityTier,
} from "../mediaLocationVisibility.js";

/** §36 MediaModerationStatus. */
export const MEDIA_MODERATION_STATUSES = [
  "processing",
  "active",
  "limited",
  "rejected",
  "removed",
  "owner_deleted",
] as const;
export type MediaModerationStatus = (typeof MEDIA_MODERATION_STATUSES)[number];

/** The legacy 0191 values and the §36 value each one means (2250's mapping). */
export const LEGACY_MODERATION_TO_CANONICAL: Readonly<Record<string, MediaModerationStatus>> = {
  pending: "processing",
  approved: "active",
  flagged: "limited",
  rejected: "rejected",
};

/** Present any stored moderation value in the §36 vocabulary; unknown ⇒ null. */
export function toCanonicalModerationStatus(v: unknown): MediaModerationStatus | null {
  const s = String(v ?? "").trim();
  if ((MEDIA_MODERATION_STATUSES as readonly string[]).includes(s)) return s as MediaModerationStatus;
  return LEGACY_MODERATION_TO_CANONICAL[s] ?? null;
}

/** §33 MediaVisibility — six audiences. */
export const MEDIA_VISIBILITIES = [
  "public",
  "followers",
  "following",
  "trip_crew",
  "shared_moment",
  "private",
] as const;
export type MediaVisibility = (typeof MEDIA_VISIBILITIES)[number];

/** What `media_assets.visibility` / `media_attachments.visibility_override` may hold. */
export type StoredMediaVisibility = MediaVisibility | "inherit";

export const STORED_MEDIA_VISIBILITIES: readonly StoredMediaVisibility[] = ["inherit", ...MEDIA_VISIBILITIES];

/** A stored visibility, or `private` when the value is not one this module models. */
export function toStoredMediaVisibility(v: unknown): StoredMediaVisibility {
  const s = String(v ?? "").trim();
  return (STORED_MEDIA_VISIBILITIES as readonly string[]).includes(s) ? (s as StoredMediaVisibility) : "private";
}

/** 0191's processing_status CHECK, verbatim. */
export const MEDIA_PROCESSING_STATUSES = [
  "local", "queued", "uploading", "uploaded", "scanning", "processing",
  "moderating", "ready", "failed", "rejected", "removed", "expired",
] as const;
export type MediaProcessingStatus = (typeof MEDIA_PROCESSING_STATUSES)[number];

/** §6 MediaAsset. */
export interface MediaAsset {
  id: string;
  ownerUserId: string;
  uploaderUserId: string;
  mediaType: "image" | "video";
  storageBucket: string;
  storagePath: string;
  thumbnailPath?: string;
  mimeType: string;
  width?: number;
  height?: number;
  durationMs?: number;
  sizeBytes: number;
  capturedAt?: string;
  uploadedAt: string;
  sourceType: MediaSourceType;
  processingStatus: MediaProcessingStatus | null;
  moderationStatus: MediaModerationStatus | null;
  visibility: StoredMediaVisibility;
  locationVisibility: LocationVisibilityTier;
  provenance: MediaProvenance | null;
  intelligenceEligibility: IntelligenceEligibility | null;
  version: number;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * The stored eligibility object, when it is shaped like one. Only the fields
 * §10 names are carried; anything else in the jsonb is dropped.
 */
function toEligibility(v: unknown): IntelligenceEligibility | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.eligible !== "boolean") return null;
  const fc = o.freshnessClass;
  const out: IntelligenceEligibility = {
    eligible: o.eligible,
    reasons: Array.isArray(o.reasons) ? o.reasons.filter((r): r is string => typeof r === "string") : [],
    freshnessClass: fc === "fresh" || fc === "recent" ? fc : fc === "live" ? "fresh" : "historical", // census-media MD71 (lead ruling D-26b): a photo is never labelled "live" — a stored "live" is served at the cap, "fresh"
    captureConfidence: num(o.captureConfidence) ?? 0,
    locationConfidence: num(o.locationConfidence) ?? 0,
    provenanceConfidence: num(o.provenanceConfidence) ?? 0,
  };
  const exp = str(o.expiresAt);
  if (exp && Number.isFinite(new Date(exp).getTime())) out.expiresAt = exp;
  return out;
}

/**
 * Map one `media_assets` row to the §6 contract, or null when the row lacks the
 * identity the contract cannot be written without (id, owner, storage key,
 * media type). Tolerates the columns a pre-2250 database lacks — `captured_at`,
 * `location_visibility`, `provenance`, `intelligence_eligibility` come back
 * absent/null/`hidden` rather than failing the map.
 */
export function toMediaAsset(row: unknown): MediaAsset | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const id = str(r.id);
  const owner = str(r.owner_user_id);
  const bucket = str(r.storage_bucket);
  const path = str(r.storage_path);
  const mediaType = r.media_type === "video" ? "video" : r.media_type === "image" ? "image" : null;
  if (!id || !owner || !bucket || !path || !mediaType) return null;

  const lv = String(r.location_visibility ?? "hidden");
  const processing = String(r.processing_status ?? "");
  const asset: MediaAsset = {
    id,
    ownerUserId: owner,
    uploaderUserId: str(r.uploader_user_id) ?? owner,
    mediaType,
    storageBucket: bucket,
    storagePath: path,
    mimeType: str(r.mime_type) ?? (mediaType === "video" ? "video/mp4" : "image/jpeg"),
    sizeBytes: num(r.size_bytes) ?? 0,
    uploadedAt: str(r.created_at) ?? new Date(0).toISOString(),
    sourceType: normalizeSourceType(r.source_type),
    processingStatus: (MEDIA_PROCESSING_STATUSES as readonly string[]).includes(processing)
      ? (processing as MediaProcessingStatus)
      : null,
    moderationStatus: toCanonicalModerationStatus(r.moderation_status),
    visibility: toStoredMediaVisibility(r.visibility ?? "inherit"),
    // Fail-closed to the most private tier, exactly as 2250's column DEFAULT.
    locationVisibility: (LOCATION_VISIBILITY_TIERS as readonly string[]).includes(lv)
      ? (lv as LocationVisibilityTier)
      : "hidden",
    provenance: normalizeProvenance(r.provenance),
    intelligenceEligibility: toEligibility(r.intelligence_eligibility),
    version: num(r.version) ?? 1,
  };
  const thumb = str(r.thumbnail_path);
  if (thumb) asset.thumbnailPath = thumb;
  const w = num(r.width);
  if (w !== undefined) asset.width = w;
  const h = num(r.height);
  if (h !== undefined) asset.height = h;
  const d = num(r.duration_ms);
  if (d !== undefined) asset.durationMs = d;
  const cap = str(r.captured_at);
  if (cap && Number.isFinite(new Date(cap).getTime())) asset.capturedAt = cap;
  return asset;
}
