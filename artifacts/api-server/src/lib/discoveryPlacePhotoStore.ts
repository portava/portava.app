/**
 * discoveryPlacePhotoStore — persistence for the CANONICAL RESOLVED PHOTO.
 *
 * Discovery resolves a place photo through Foursquare → Google Places (New) →
 * category artwork, per card, at request time. That chain works, and it is
 * already approved product behaviour. What it does not do is REMEMBER: nothing
 * is stored, so every viewer of every card re-pays two external providers for
 * the field a user sees first.
 *
 * This module is the memory. It adds no behaviour — the same chain resolves the
 * same photo — it only stops the work being repeated.
 *
 * ── THREE PROPERTIES THIS MODULE MUST HAVE, AND WHY ──────────────────────────
 *
 * 1. **It never breaks a live request.** Every function swallows its own
 *    errors and degrades to "no stored photo", which is exactly today's
 *    behaviour. This matters more than usual here: the table is introduced by a
 *    migration that is STAGED for the operator rather than applied by an agent,
 *    so until it is applied every call in here fails — and must be invisible.
 *
 * 2. **It never stores a credential.** Google's photo media URL embeds the API
 *    key. Persisting the rendered URL would put a secret in a table and produce
 *    a dead link on the next key rotation, so Google rows store the photo
 *    RESOURCE NAME and the URL is minted per read against the current key.
 *
 * 3. **It expires.** See `REFRESH AND INVALIDATION` below. A stored photo that
 *    nothing can invalidate is a stale field with no owner, and its failure
 *    mode is this workstream's own invariant in a new costume: a dead image
 *    renders as "this place has no photo", which is indistinguishable from
 *    never having resolved one.
 *
 * ── REFRESH AND INVALIDATION — defined explicitly, as ruled ──────────────────
 *
 * The owner's ruling makes this an exit criterion rather than a follow-up, so
 * it is stated here in full and enforced in code below.
 *
 * | Trigger | What happens |
 * |---|---|
 * | **Age** — row older than `PHOTO_TTL_MS` (30 days) | `expires_at` has passed, the row reads as ABSENT, the live chain runs and the result is written back. Bounds how long a photo resolved during a provider outage can stand. |
 * | **Provider key rotation** | Cannot produce a dead row at all: Google rows store a ref, not a key-bearing URL, and the URL is minted per read. |
 * | **Unusable row** | A row that cannot produce a URL is stamped `invalid_at` and read as absent. Stamped rather than deleted so it stays observable. |
 * | **Explicit eviction** | `evictStoredPlacePhoto(placeKey)` deletes a row. Called by the admin place-image path, so an operator changing an image is never overruled by a cached one. |
 * | **Whole-store reset** | The table can be truncated at any time with no data loss beyond a re-resolve. Nothing else depends on it. |
 *
 * **What is deliberately NOT an invalidation trigger:** a client-side broken
 * image. The card cannot currently report that a URL 404s, and inventing a
 * reporting channel for it is new product surface, not this. The 30-day
 * horizon is the backstop for that case, and it is named here so the gap is
 * recorded rather than discovered later.
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────
 *
 * Explicit non-goals, each of which needs a NEW owner ruling before anyone
 * starts: crawling photos, bulk enrichment, multiple candidates per place,
 * quality scoring, cross-provider deduplication, pre-populating cities. This
 * module writes ONE row for ONE place at the moment that place's photo was
 * resolved for a real viewer, and does nothing on its own initiative.
 */

import { getServiceClient } from "./supabase.js";
import { logger } from "./logger.js";

/** How long a resolved photo stands before the chain is re-run. */
export const PHOTO_TTL_MS = 30 * 24 * 60 * 60 * 1_000; // 30 days

export type PlacePhotoSource = "foursquare" | "google";

export interface StoredPlacePhoto {
  source: PlacePhotoSource;
  /** Directly renderable URL (Foursquare), or null when the row stores a ref. */
  photoUrl: string | null;
  /** Provider-native id needing a per-read mint (Google), or null. */
  photoRef: string | null;
}

/**
 * Namespaced place identity.
 *
 * OSM ids are normalised to the `osm:<type>/<id>` form that
 * `discovery_places.tag` ALREADY uses, so this table and that one agree on what
 * a place is rather than inventing a second convention.
 *
 * Returns null for anything unrecognised — an unkeyable place simply does not
 * participate, which is today's behaviour.
 */
export function normalisePlaceKey(raw: string | null | undefined): string | null {
  const v = raw?.trim();
  if (!v || v.length > 128) return null;

  if (/^(node|way|relation)\/\d+$/.test(v)) return `osm:${v}`;
  if (/^osm:(node|way|relation)\/\d+$/.test(v)) return v;

  // DB-backed places arrive as `db/<uuid>` — the id form `discovery.ts` builds
  // and `evictCacheEntriesForEntity` already matches on. Read out of that code
  // rather than guessed: a bare uuid is NOT what the client sends.
  const db = /^db\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(v);
  if (db) return `db:${db[1]!.toLowerCase()}`;

  return null;
}

/**
 * Mint the renderable URL for a stored row.
 *
 * Google rows carry a photo resource name; the media URL is built here against
 * the CURRENT key so a rotation can never strand a stored row. Returns null
 * when the row cannot produce a URL, which the caller treats as invalid.
 */
export function mintPhotoUrl(stored: StoredPlacePhoto): string | null {
  if (stored.source === "foursquare") return stored.photoUrl ?? null;

  if (stored.photoUrl) return stored.photoUrl;
  if (!stored.photoRef) return null;

  // The key check is kept even though the URL below no longer embeds the key:
  // it preserves the "degrade honestly" contract — with no key the proxy could
  // only 503, so callers are better served falling through to category artwork.
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return null;

  return photoProxyUrl(stored.photoRef);
}

/**
 * The URL a CLIENT should fetch for a Google photo reference.
 *
 * Deliberately NOT Google's own media URL. That one carries
 * GOOGLE_MAPS_API_KEY as a query parameter, so returning it to a client
 * publishes the key — and GET /api/places/photo, which returned it, has no auth
 * guard, meaning anyone on the internet could read the key out of the response
 * and spend against the project's Google billing. This points at the
 * api-server byte proxy (GET /api/places/photo/media), which resolves the key
 * server-side and streams the image back.
 *
 * Absolute where possible: the mobile client renders this straight into an
 * image source and cannot resolve a relative path. Falls back to a relative
 * path when API_BASE_URL is unset, which still works for same-origin web
 * callers — the same `process.env.API_BASE_URL ?? ""` convention routes/
 * mediaFeed.ts already uses.
 */
export function photoProxyUrl(photoRef: string, width = 800): string {
  const base = (process.env.API_BASE_URL ?? "").replace(/\/+$/, "");
  return `${base}/api/places/photo/media?ref=${encodeURIComponent(photoRef)}&w=${width}`;
}

/**
 * Read the stored photo for a place, or null.
 *
 * Rows that have expired or been marked invalid are reported as ABSENT rather
 * than returned — expiry is enforced on read, not only by a sweep, so a store
 * that is never swept still cannot serve a stale photo.
 */
export async function readStoredPlacePhoto(
  placeKey: string,
): Promise<StoredPlacePhoto | null> {
  try {
    const sc = getServiceClient();
    if (!sc) return null;

    const { data, error } = await sc
      .from("discovery_place_photos")
      .select("source, photo_url, photo_ref, expires_at, invalid_at")
      .eq("place_key", placeKey)
      .maybeSingle();

    if (error || !data) return null;
    if (data.invalid_at) return null;

    const expiresAt = data.expires_at ? Date.parse(String(data.expires_at)) : 0;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;

    const source = data.source as PlacePhotoSource;
    if (source !== "foursquare" && source !== "google") return null;

    const stored: StoredPlacePhoto = {
      source,
      photoUrl: (data.photo_url ?? null) as string | null,
      photoRef: (data.photo_ref ?? null) as string | null,
    };

    // A row that cannot produce a URL is worse than no row: it would answer a
    // read with nothing while suppressing the live lookup. Mark and skip.
    if (!mintPhotoUrl(stored)) {
      void markStoredPlacePhotoInvalid(placeKey);
      return null;
    }

    return stored;
  } catch {
    return null;
  }
}

/**
 * Write the winner of the resolution chain.
 *
 * Upsert, because re-resolving after expiry must replace the old answer rather
 * than accumulate answers — one canonical photo per place is the whole point,
 * and "multiple candidates per place" is a named non-goal.
 */
export async function writeStoredPlacePhoto(
  placeKey: string,
  photo: StoredPlacePhoto,
): Promise<void> {
  if (!photo.photoUrl && !photo.photoRef) return;

  try {
    const sc = getServiceClient();
    if (!sc) return;

    const now = Date.now();
    const { error } = await sc.from("discovery_place_photos").upsert(
      {
        place_key:   placeKey,
        source:      photo.source,
        photo_url:   photo.photoUrl,
        photo_ref:   photo.photoRef,
        resolved_at: new Date(now).toISOString(),
        expires_at:  new Date(now + PHOTO_TTL_MS).toISOString(),
        invalid_at:  null,
      },
      { onConflict: "place_key" },
    );

    if (error) {
      // Debug, not warn: until the staged migration is applied this fires on
      // every resolve, and a log line nobody can act on is noise that trains
      // people to ignore the channel.
      logger.debug({ err: error, placeKey }, "discovery place photo persist failed");
    }
  } catch (err) {
    logger.debug({ err, placeKey }, "discovery place photo persist threw");
  }
}

/**
 * Insert-if-absent variant for the operator BACKFILL (scripts/backfillPlacePhotos).
 *
 * Unlike writeStoredPlacePhoto — an upsert that UPDATES on conflict — this uses
 * ON CONFLICT DO NOTHING, so warming a cold place can never overwrite a row a live
 * viewer already resolved FSQ-first, even if the backfill's read happened a moment
 * before that write landed. Trade-off, stated so it is chosen not discovered: it
 * does NOT refresh an EXPIRED row (the live path does that on the next serve); the
 * backfill exists for cold coverage, not refresh.
 */
export async function writeStoredPlacePhotoIfAbsent(
  placeKey: string,
  photo: StoredPlacePhoto,
): Promise<void> {
  if (!photo.photoUrl && !photo.photoRef) return;

  try {
    const sc = getServiceClient();
    if (!sc) return;

    const now = Date.now();
    const { error } = await sc.from("discovery_place_photos").upsert(
      {
        place_key:   placeKey,
        source:      photo.source,
        photo_url:   photo.photoUrl,
        photo_ref:   photo.photoRef,
        resolved_at: new Date(now).toISOString(),
        expires_at:  new Date(now + PHOTO_TTL_MS).toISOString(),
        invalid_at:  null,
      },
      { onConflict: "place_key", ignoreDuplicates: true }, // ON CONFLICT DO NOTHING
    );
    if (error) logger.debug({ err: error, placeKey }, "discovery place photo insert-if-absent failed");
  } catch (err) {
    logger.debug({ err, placeKey }, "discovery place photo insert-if-absent threw");
  }
}

/** Stamp a row unusable. Kept rather than deleted so it stays observable. */
export async function markStoredPlacePhotoInvalid(placeKey: string): Promise<void> {
  try {
    const sc = getServiceClient();
    if (!sc) return;
    await sc
      .from("discovery_place_photos")
      .update({ invalid_at: new Date().toISOString() })
      .eq("place_key", placeKey);
  } catch {
    /* non-fatal by design */
  }
}

/**
 * Explicit eviction. An operator who changes a place image must not be
 * overruled by a photo this store resolved earlier.
 */
export async function evictStoredPlacePhoto(rawPlaceKey: string): Promise<void> {
  const placeKey = normalisePlaceKey(rawPlaceKey);
  if (!placeKey) return;

  try {
    const sc = getServiceClient();
    if (!sc) return;
    await sc.from("discovery_place_photos").delete().eq("place_key", placeKey);
  } catch (err) {
    logger.debug({ err, placeKey }, "discovery place photo eviction failed");
  }
}
