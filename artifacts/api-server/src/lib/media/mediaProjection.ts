/**
 * mediaProjection — the safe, coarse projection of a media-bearing row into the
 * Media v2 World-first shape (spec §6/§42).
 *
 * This is the MUTATION-PROOF heart of the no-precise-location guarantee: every
 * projector here WHITELISTS fields. A raw `posts` row carries `location_lat` /
 * `location_lng`; those columns are never read into a projection. The only
 * location a projection carries is coarse — the opaque canonical `placeId` and
 * human labels (venue / neighborhood / city / country). See
 * lib/media/mediaLocationSafety.ts for the executable proof.
 *
 * These projectors are PURE and take already-fetched rows, so they can be unit
 * tested with no DB and no network (mediaWorldProjection.test.ts).
 */

import { isFreshEnoughForLabel } from "./mediaFreshness.js";
import type { MediaPlaceDisclosure } from "../mediaLocationVisibility.js";

/**
 * The columns a projection route may SELECT from `posts`.
 *
 * Two deliberate boundaries:
 *   • EXCLUDES `location_lat` / `location_lng` — the projection layer has no
 *     business reading precise coordinates (mediaFeed.ts selects them for
 *     internal ranking; the World shell does not).
 *   • Restricted to the columns proven present in the LIVE schema — this mirrors
 *     mediaFeed.ts FEED_POST_COLUMNS (the prod-serving path). Columns that
 *     mediaFeed intentionally omits because they are not live yet
 *     (`geo_restriction`, `age_restriction_*`, `publish_at`, `expires_at`) are
 *     NOT selected: a missing column fails the WHOLE query (PGRST100) and would
 *     silently empty every projection. The eligibility gate treats those fields
 *     as absent (fail-open on the geo/age gate exactly as mediaFeed does), and
 *     the delayed-publish gate is covered by `post_status`.
 */
export const MEDIA_PROJECTION_POST_COLUMNS =
  "id, author_id, trip_id, content, media_urls, visibility, status, post_status, " +
  "created_at, category, " +
  // `location_privacy_mode` is the OWNER's own coarseness choice. It is a coarse
  // enum, NOT a coordinate — reading it is what lets the projection HONOUR the
  // owner instead of overriding them (see applyLocationDisclosure below).
  "location_privacy_mode, " +
  "location_name, location_city, location_country, canonical_place_id";

/** post_media child columns safe for projection. No coordinate columns exist here. */
export const MEDIA_PROJECTION_POST_MEDIA_COLUMNS =
  "id, media_type, public_url, thumbnail_url, duration_seconds, width, height, sort_order, " +
  "processing_status, moderation_status";

/** Profile columns safe for a secondary contributor credit. */
export const MEDIA_PROJECTION_PROFILE_COLUMNS =
  "id, username, full_name, name, display_name, avatar_url, verified, is_official, account_status";

export interface MediaContributor {
  id: string;
  username: string | null;
  name: string | null;
  avatarUrl: string | null;
  verified: boolean;
  isOfficial: boolean;
}

/**
 * One projected media object. COARSE LOCATION ONLY — placeId + labels, never a
 * coordinate. `capturedAt` is the observed/created time; freshness is derived,
 * never a live claim (live state comes only from the gated liveClaimRead path).
 */
export interface MediaProjection {
  id: string;
  mediaType: "image" | "video";
  url: string;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  capturedAt: string;
  /** Opaque canonical place id — safe to expose; the client resolves geometry via the Map gateway. */
  placeId: string | null;
  /** Coarse human labels — no coordinates. */
  placeLabel: string | null;
  neighborhood: string | null;
  city: string | null;
  country: string | null;
  category: string | null;
  /** Freshness class from age. NEVER 'live' — that word is reserved for gated live claims. */
  freshness: "fresh" | "recent" | "historical";
  /** Contributor credit — visible but secondary in world-first lenses (§46). */
  contributor: MediaContributor | null;
}

/** A raw candidate row as fetched from `posts` (may carry precise columns we ignore). */
export interface MediaCandidateRow {
  id: string;
  author_id?: string | null;
  created_at?: string | null;
  category?: string | null;
  location_name?: string | null;
  location_city?: string | null;
  location_country?: string | null;
  canonical_place_id?: string | null;
  /** The owner's coarseness choice (`post_location_privacy_mode`). Coarse enum. */
  location_privacy_mode?: string | null;
  post_status?: string | null;
  post_media?: any[] | null;
  media_urls?: string[] | null;
  profiles?: any;
  /**
   * These MAY be present on the row (posts has them). They are typed here ONLY
   * to make the whitelisting explicit: the projector must never copy them.
   */
  location_lat?: number | null;
  location_lng?: number | null;
  [key: string]: unknown;
}

function firstReadyMedia(row: MediaCandidateRow): {
  id: string;
  mediaType: "image" | "video";
  url: string;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
} | null {
  const rawMedia = Array.isArray(row.post_media) ? row.post_media : [];
  const ready = rawMedia
    .filter(
      (m: any) =>
        m &&
        m.processing_status === "ready" &&
        m.moderation_status !== "rejected" &&
        m.moderation_status !== "flagged" &&
        typeof m.public_url === "string" &&
        m.public_url.trim().length > 0,
    )
    .sort((a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

  if (ready.length > 0) {
    const m = ready[0];
    return {
      id: String(m.id),
      mediaType: m.media_type === "video" ? "video" : "image",
      url: String(m.public_url).trim(),
      thumbnailUrl: typeof m.thumbnail_url === "string" ? m.thumbnail_url : null,
      width: typeof m.width === "number" ? m.width : null,
      height: typeof m.height === "number" ? m.height : null,
      durationSeconds: typeof m.duration_seconds === "number" ? m.duration_seconds : null,
    };
  }

  // External-reference fallback (posts.media_urls holds external images only;
  // ruled 2026-08-12, see lib/postMediaResolve.ts). No dimensions/type known.
  const external = Array.isArray(row.media_urls) ? row.media_urls : [];
  const url = external.find((u) => typeof u === "string" && u.trim().length > 0);
  if (url) {
    return {
      id: row.id,
      mediaType: "image",
      url: url.trim(),
      thumbnailUrl: null,
      width: null,
      height: null,
      durationSeconds: null,
    };
  }
  return null;
}

function projectContributor(row: MediaCandidateRow): MediaContributor | null {
  const p = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
  if (!p) return null;
  return {
    id: String(p.id),
    username: typeof p.username === "string" ? p.username : null,
    // Handle-first is the platform rule; a projection stays conservative and
    // shows the handle. Presentation-name opt-in is applied by the social lens
    // callers, not here.
    name:
      typeof p.name === "string"
        ? p.name
        : typeof p.display_name === "string"
          ? p.display_name
          : typeof p.username === "string"
            ? p.username
            : null,
    avatarUrl: typeof p.avatar_url === "string" ? p.avatar_url : null,
    verified: p.verified === true,
    isOfficial: p.is_official === true,
  };
}

/**
 * Project one candidate row into a coarse MediaProjection, or null when it has
 * no renderable media. WHITELISTS every field — precise coordinate columns on
 * the input row are never read.
 *
 * @param nowMs single clock read from the caller (no split clock).
 */
export function toMediaProjection(row: MediaCandidateRow, nowMs: number): MediaProjection | null {
  const media = firstReadyMedia(row);
  if (!media) return null;

  const capturedAt = typeof row.created_at === "string" ? row.created_at : new Date(nowMs).toISOString();

  return {
    id: row.id,
    mediaType: media.mediaType,
    url: media.url,
    thumbnailUrl: media.thumbnailUrl,
    width: media.width,
    height: media.height,
    durationSeconds: media.durationSeconds,
    capturedAt,
    placeId: typeof row.canonical_place_id === "string" ? row.canonical_place_id : null,
    placeLabel: typeof row.location_name === "string" ? row.location_name : null,
    neighborhood: null,
    city: typeof row.location_city === "string" ? row.location_city : null,
    country: typeof row.location_country === "string" ? row.location_country : null,
    category: typeof row.category === "string" ? row.category : null,
    freshness: classifyFreshness(capturedAt, nowMs),
    contributor: projectContributor(row),
  };
}

/**
 * Freshness from age. Caps at 'fresh' — a media projection may NEVER be labeled
 * 'live'. Live/current state is a separate, gated concept (liveClaimRead).
 */
export function classifyFreshness(capturedAt: string, nowMs: number): "fresh" | "recent" | "historical" {
  const ageMs = nowMs - new Date(capturedAt).getTime();
  if (!Number.isFinite(ageMs)) return "historical";
  if (isFreshEnoughForLabel(ageMs)) return "fresh"; // < 1h
  if (ageMs < 24 * 60 * 60 * 1000) return "recent"; // < 24h
  return "historical";
}

// ── Location disclosure (the choke point applied to a shaped projection) ──────

/**
 * Apply a resolved `MediaPlaceDisclosure` to a projection.
 *
 * `toMediaProjection` copies the row's stored labels verbatim — which is correct
 * for a projector (it is the whitelist, not the policy) but is NOT servable on
 * its own: the stored `location_name` IS the venue, and `canonical_place_id`
 * resolves to that same venue through the Map gateway. Every non-owner-facing
 * caller must pass the projection through here with a disclosure resolved by
 * `lib/mediaLocationVisibility.resolveMediaPlaceDisclosure`, so the owner's
 * privacy mode and any hosting Hidden Gem's ceiling actually bind.
 *
 * PURE. In the unconstrained case (owner, no privacy mode, no restrictive gem)
 * the projection comes back materially unchanged.
 */
export function applyLocationDisclosure(
  p: MediaProjection,
  d: MediaPlaceDisclosure,
): MediaProjection {
  return {
    ...p,
    // Withheld below place-level: the id is a place-level identifier (see
    // MediaPlaceDisclosure.mayDisclosePlaceId).
    placeId: d.mayDisclosePlaceId ? p.placeId : null,
    placeLabel: d.name,
    neighborhood: d.neighborhood,
    city: d.city,
    country: d.country,
  };
}

/** Project a page of candidate rows, dropping the ones with no renderable media. */
export function projectMediaCandidates(rows: MediaCandidateRow[], nowMs: number): MediaProjection[] {
  const out: MediaProjection[] = [];
  for (const row of rows) {
    const p = toMediaProjection(row, nowMs);
    if (p) out.push(p);
  }
  return out;
}
