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
import type { MediaPlaceDisclosure } from "../mediaLocationVisibility.js"; import { buildProvenanceLayer, withholdLocation, type MediaProvenanceLayer } from "./mediaProvenanceLayer.js"; import { resolveMediaTemporalState, type MediaTemporalState } from "./mediaTemporalState.js"; import { toMediaAsset, toCanonicalModerationStatus } from "./mediaAssetContract.js"; import { evaluateEvidenceEligibility, normalizeProvenance, normalizeSourceType } from "./mediaEvidenceEligibility.js";

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
  "id, author_id, trip_id, content, media_urls, visibility, status, post_status, published_at, " + // published_at: census-media MD79, the released place window — read for the choke point, never projected
  "created_at, category, " +
  // `location_privacy_mode` is the OWNER's own coarseness choice. It is a coarse
  // enum, NOT a coordinate — reading it is what lets the projection HONOUR the
  // owner instead of overriding them (see applyLocationDisclosure below).
  "location_privacy_mode, " +
  "location_name, location_city, location_country, canonical_place_id, location_source, location_verified, geotag_verified";

/** post_media child columns safe for projection. No coordinate columns exist here. */
export const MEDIA_PROJECTION_POST_MEDIA_COLUMNS =
  "id, media_type, public_url, thumbnail_url, feed_url, duration_seconds, width, height, sort_order, " + // feed_url: migration 0208 (census-wall §16)
  "processing_status, moderation_status";

/**
 * `media_assets` columns safe for projection — the CANONICAL store (spec §6).
 *
 * Same whitelisting discipline as the two constants above, and it costs nothing
 * to hold: `media_assets` has no coordinate column at all (checked against
 * information_schema in both databases, 2026-09-07), so the "never read a
 * precise location" guarantee is structural here rather than editorial.
 *
 * `captured_at` is the one field the canonical store has that neither legacy
 * store does — the §6 / Wall §16 "two clocks" value. Everything projected from
 * `post_media` or `media_urls` has to fall back to the post's `created_at`,
 * which is the publish clock, not the capture clock.
 *
 * NOT SELECTABLE AS AN EMBED FROM `posts`. `media_attachments.entity_id` is a
 * bare uuid with NO foreign key to `posts` (it is polymorphic over
 * `entity_type`), so PostgREST cannot resolve `posts -> media_attachments`.
 * Reading the canonical store needs a SECOND query keyed by entity_id — see
 * lib/media/mediaCanonicalRead.ts. Anyone planning the cutover should know that
 * up front: it is not a one-constant edit to the existing SELECT.
 */
export const MEDIA_PROJECTION_MEDIA_ASSET_COLUMNS =
  "id, media_type, public_url, thumbnail_url, width, height, duration_ms, captured_at, owner_user_id, uploader_user_id, storage_bucket, storage_path, thumbnail_path, mime_type, size_bytes, created_at, " +
  "processing_status, moderation_status, source_type, visibility, location_visibility, provenance, intelligence_eligibility, version";

/**
 * Profile columns safe for a secondary contributor credit.
 *
 * `is_private` is read but never projected: it is a GATE input, consumed by
 * `loadEligibleCandidates` (lib/privacyFilter.excludePrivateAuthorPosts) so a
 * private account's post is dropped before it is ever shaped. Selecting it here
 * is what lets that guard run without a second round trip — the same trick the
 * Watch feed uses (`{ profilesKey: "profiles" }`). It is deliberately absent
 * from `MediaContributor`, so it cannot reach a client.
 */
export const MEDIA_PROJECTION_PROFILE_COLUMNS =
  "id, username, full_name, name, display_name, avatar_url, verified, is_official, account_status, is_private";

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
export interface MediaProjection extends MediaProjectionLayers {
  id: string;
  mediaType: "image" | "video";
  url: string;
  thumbnailUrl: string | null; /** Image only, and only when a post_media row stores one: the ≤1500 px feed variant (post_media.feed_url, 0208). Absent otherwise; media_assets and media_urls have none. */ feedUrl?: string | null;
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
  contributor: MediaContributor | null; /** §12 perspective group the contributor named (census-media §36). Present ONLY when the viewer may be told the place. */ vantage?: string;
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
  /**
   * Canonical `media_assets` rows for this entity, attached by the gated loader
   * `lib/media/mediaCanonicalRead.attachCanonicalMedia`. ABSENT on every row
   * fetched today: no SELECT in this tree produces it and it is not a column on
   * `posts`. When present it WINS over `post_media` (see firstReadyMedia).
   */
  canonical_media?: any[] | null;
  profiles?: any;
  /**
   * These MAY be present on the row (posts has them). They are typed here ONLY
   * to make the whitelisting explicit: the projector must never copy them.
   */
  location_lat?: number | null;
  location_lng?: number | null;
  [key: string]: unknown;
}

interface ResolvedMedia {
  id: string;
  mediaType: "image" | "video";
  url: string;
  thumbnailUrl: string | null; feedUrl?: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  /** §6 capture clock. Only the canonical store can supply this. */
  capturedAt: string | null;
  /** Which of the three stores this came from. Diagnostic; never projected. */
  source: "media_assets" | "post_media" | "media_urls"; /** The raw served row (canonical asset or post_media), for the §8 layers only. */ row?: any;
}

/**
 * A media row is servable only if it is finished processing and has not been
 * moderated away. Applied IDENTICALLY to `post_media` and to `media_assets`, so
 * preferring the canonical store can never relax the gate.
 *
 * `media_assets.moderation_status` carries BOTH vocabularies at once — the
 * legacy `pending|approved|flagged|rejected` and the §36
 * `processing|active|limited|rejected|removed|owner_deleted` that migration 2250
 * added as a superset. Neither set is a subset of the other, so this is a
 * DENY-LIST of the states that must never reach a social surface, which is the
 * same posture `lib/mediaEligibility` and the Wall's quick-media loader take. A
 * value nobody has enumerated yet is therefore servable — matching the existing
 * post_media branch exactly, rather than quietly making the canonical store
 * stricter and losing media at cutover.
 *
 * SHARING THIS PREDICATE WITH THE post_media BRANCH IS PROVABLY INERT, not
 * merely believed to be. That branch previously denied exactly `rejected` and
 * `flagged`; this set adds `limited`, `removed` and `owner_deleted`. Those three
 * cannot occur on a post_media row — `post_media_moderation_status_check` is
 *
 *     CHECK (moderation_status = ANY (ARRAY['pending','approved','flagged','rejected']))
 *
 * in BOTH databases (read from pg_constraint 2026-09-07: travel-buddy
 * ajrurzioarfkagpuxfnb and portava-ci hwokxgbmezheskbzskfr, identical
 * definitions). The database forbids the three added values, so the added denials
 * are unreachable and the post_media verdict is unchanged for every row that can
 * exist. If that CHECK is ever widened, re-derive this — do not assume it holds.
 */
const UNSERVABLE_MODERATION_STATES: ReadonlySet<string> = new Set([
  "rejected",
  "flagged",
  "limited",
  "removed",
  "owner_deleted",
]);

function servableMediaRow(m: any): boolean {
  return Boolean(
    m &&
      m.processing_status === "ready" &&
      !UNSERVABLE_MODERATION_STATES.has(String(m.moderation_status ?? "")) &&
      typeof m.public_url === "string" &&
      m.public_url.trim().length > 0,
  );
}

/**
 * The canonical branch (spec §6): the first servable `media_assets` row this
 * entity carries, ordered by its attachment position.
 *
 * Returns null when the row carries no canonical data — which is EVERY row
 * today — so the caller falls through to `post_media` and then `media_urls`
 * exactly as before. That fall-through is the point: the canonical store covers
 * a fraction of live media (measured 2026-09-07 in production: 8 media_assets,
 * 6 post_media, and only ONE storage path present in both), so a read path that
 * preferred `media_assets` WITHOUT falling back would delete most media from
 * every surface it serves. Preference, never replacement.
 */
function firstCanonicalMedia(row: MediaCandidateRow): ResolvedMedia | null {
  const raw = Array.isArray(row.canonical_media) ? row.canonical_media : [];
  const ready = raw
    .filter(servableMediaRow)
    .sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0));
  const m = ready[0];
  if (!m) return null;
  return {
    id: String(m.id),
    mediaType: m.media_type === "video" ? "video" : "image",
    url: String(m.public_url).trim(),
    thumbnailUrl: typeof m.thumbnail_url === "string" ? m.thumbnail_url : null,
    width: typeof m.width === "number" ? m.width : null,
    height: typeof m.height === "number" ? m.height : null,
    // media_assets models duration as duration_ms (INTEGER, migration 0191);
    // post_media models it as duration_seconds. The projection speaks seconds.
    durationSeconds: typeof m.duration_ms === "number" ? m.duration_ms / 1000 : null,
    capturedAt: typeof m.captured_at === "string" ? m.captured_at : null,
    source: "media_assets", row: m,
  };
}

function firstReadyMedia(row: MediaCandidateRow): ResolvedMedia | null {
  // Canonical first (§6) — null on every row that carries no canonical data.
  const canonical = firstCanonicalMedia(row);
  if (canonical) return canonical;

  const rawMedia = Array.isArray(row.post_media) ? row.post_media : [];
  const ready = rawMedia
    .filter(servableMediaRow)
    .sort((a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

  if (ready.length > 0) {
    const m = ready[0];
    return {
      id: String(m.id),
      mediaType: m.media_type === "video" ? "video" : "image",
      url: String(m.public_url).trim(),
      thumbnailUrl: typeof m.thumbnail_url === "string" ? m.thumbnail_url : null, feedUrl: postMediaFeedVariant(m),
      width: typeof m.width === "number" ? m.width : null,
      height: typeof m.height === "number" ? m.height : null,
      durationSeconds: typeof m.duration_seconds === "number" ? m.duration_seconds : null,
      capturedAt: null,
      source: "post_media", row: m,
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
      capturedAt: null,
      source: "media_urls",
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

  // §6 / Wall §16 "two clocks": the canonical store's `captured_at` is the
  // CAPTURE time; `posts.created_at` is the PUBLISH time. Prefer the former
  // when the canonical branch supplied one — that is the whole reason the
  // canonical store is worth preferring, beyond having one row per file.
  const capturedAt =
    media.capturedAt ??
    (typeof row.created_at === "string" ? row.created_at : new Date(nowMs).toISOString());

  return {
    id: row.id,
    mediaType: media.mediaType,
    url: media.url,
    thumbnailUrl: media.thumbnailUrl, ...(media.feedUrl ? { feedUrl: media.feedUrl } : {}),
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
    contributor: projectContributor(row), ...projectionLayers(row, media, nowMs),
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
    country: d.country, provenance: d.visibility === "hidden" && p.provenance ? withholdLocation(p.provenance) : p.provenance,
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

// ── §8 Provenance + §11 Temporal layers (census-media §20) ───────────────────

/**
 * The two layers every served media object carries on top of the coarse
 * projection. Declared as a separate interface (MediaProjection extends it) so
 * the §8/§11 contract has one named home.
 */
export interface MediaProjectionLayers {
  /** §8 Provenance layer — lib/media/mediaProvenanceLayer. */
  provenance: MediaProvenanceLayer;
  /** §11 MediaTemporalState — lib/media/mediaTemporalState. */
  temporal: MediaTemporalState;
}

/**
 * The provenance source for a canonical row. The strict §6 contract when the
 * row carries its identity columns (toMediaAsset); otherwise the provenance
 * columns alone, read the same way, so a canonical row is never presented as
 * if it came from a legacy store.
 */
function canonicalProvenanceSource(m: any) {
  const asset = toMediaAsset(m);
  if (asset) return asset;
  const cap = typeof m?.captured_at === "string" ? m.captured_at : undefined;
  return {
    sourceType: normalizeSourceType(m?.source_type),
    provenance: normalizeProvenance(m?.provenance),
    moderationStatus: toCanonicalModerationStatus(m?.moderation_status),
    ...(cap ? { capturedAt: cap } : {}),
  };
}

/**
 * Build the §8 and §11 layers for one projected row. PURE; reads only what the
 * row and its resolved media already carry.
 *
 * The §10 eligibility behind the temporal state is RE-COMPUTED here from the
 * canonical row's provenance, at the caller's clock, rather than trusted from
 * the stored `intelligence_eligibility` — the same re-verification the evidence
 * read side performs, so a later generative edit cannot leave a stale lifetime
 * on a served object. A legacy item has no provenance, hence no eligibility and
 * no intelligence lifetime.
 */
function projectionLayers(row: MediaCandidateRow, media: ResolvedMedia, nowMs: number): MediaProjectionLayers {
  const contributor = projectContributor(row);
  const canonical = media.source === "media_assets" ? canonicalProvenanceSource(media.row) : null;
  const provenance = buildProvenanceLayer({
    asset: canonical,
    legacyModeration: media.source === "post_media" ? media.row?.moderation_status : undefined,
    post: row as { location_source?: unknown; location_verified?: unknown; geotag_verified?: unknown },
    contributor: contributor ? { verified: contributor.verified, isOfficial: contributor.isOfficial } : null,
  });
  // §10 locationConfidence is a property of the (asset, post) PAIR — the same
  // file tagged by a verified GPS fix in one post and a typed venue in another
  // is not equally well located — so the post's basis is folded in here, at
  // read, and never written back onto the asset.
  const eligibility = canonical
    ? evaluateEvidenceEligibility({
        source_type: canonical.sourceType,
        provenance: canonical.provenance
          ? { ...canonical.provenance, locationBasis: canonical.provenance.locationBasis ?? provenance.locationBasis ?? undefined }
          : null,
        captured_at: canonical.capturedAt ?? null,
        now: nowMs,
      })
    : null;
  return { provenance, temporal: resolveMediaTemporalState({ eligibility }) };
}

/**
 * The layers for an OWNER-ONLY placeholder item (My World "processing" bucket:
 * an upload still in flight, with no ready media to project). No media row was
 * served, so the provenance is the post's alone and there is no lifetime yet.
 */
export function placeholderProjectionLayers(row: MediaCandidateRow): MediaProjectionLayers {
  return {
    provenance: buildProvenanceLayer({
      asset: null,
      post: row as { location_source?: unknown; location_verified?: unknown; geotag_verified?: unknown },
      contributor: null,
    }),
    temporal: {},
  };
}

/**
 * The stored feed variant of one `post_media` IMAGE row (longest edge <= FEED_DIM
 * = 1500, migration 0208), or null when none is stored. Existence is reported by
 * the row, never inferred from the path. A video has no feed variant; its still
 * is the poster in `thumbnail_url`. Carried to MediaProjection.feedUrl only when
 * present, so a projection without one is byte-identical to before.
 */
function postMediaFeedVariant(m: any): string | null {
  if (!m || m.media_type === "video") return null;
  return typeof m.feed_url === "string" && m.feed_url.trim().length > 0 ? m.feed_url.trim() : null;
}
