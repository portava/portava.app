/**
 * GET /api/discovery
 *
 * Destination-scoped place discovery backed by Nominatim + Overpass (OSM).
 * No auth required — returns only public place data.
 *
 * Query params:
 *   destination  string  (required) city / area name e.g. "Paris"
 *   category     string  for_you | places | food | nightlife | activities |
 *                        events | beaches | transport   (default: for_you)
 *   radiusKm     number  search radius 1–100 km  (default: 10)
 *   page         number  1-based page (default: 1); PAGE_SIZE=20
 *
 * Response: { places: DiscoveryPlace[], destination: string, total: number }
 *
 * Caches results per (destination, category, radiusKm) for 2 hours.
 * Graceful degradation: any network/parse error returns an empty list.
 */

import { Router } from "express";
import { provenanceStamp } from "../lib/placeProvenance.js";
import { z } from "zod";
import { getServiceClient } from "../lib/supabase";
import { osmNeighborhood } from "../lib/osmPlaceShape";
import { sendError, requireUser } from "../lib/http";
import { nameVisibilitySet } from "../lib/publicIdentity";
import { buildDiscoveryContext } from "../services/location/DiscoveryLocationContext";
import { loadPreferences } from "../services/location/LocationPermissionService";
import { toCanonicalCategory } from "../lib/placeCategories";
import type { DiscoveryContext, DiscoveryContextMode } from "../services/location/DiscoveryLocationContext";
import { calculateUserAge } from "../lib/ageEligibility";
import { discoveryPlaceToCompassItem } from "../compass/CompassDiscoveryAdapter";
import { getCompassProfile } from "../compass/CompassProfileService";
import { buildCompassContext, defaultSignals } from "../compass/CompassContextEngine";
import { rankItemsForDiscovery } from "../compass/CompassFeedBuilder";
import { fetchUserTimezone, localHourFor, nowUtcInstant } from "../lib/localTime";
import { isEnabled } from "../compass/flags";
import type { RankCandidate, ScoredCandidate } from "../lib/portavaRank";
import { logImpression } from "../lib/rankLog";
import { logDiscoveryServe, DiscoveryServePoint } from "../lib/discoveryServeLog.js";
import { resolveDiscoveryEngineMode } from "../lib/discoveryEngineMode.js";
// The PDE ranking pipeline (D5=B, ranking half). portavaRank, the
// DiscoveryRankingService re-rank and the assembly analytics all moved behind
// this module; the route no longer imports them directly, which is what keeps
// "one ranking pipeline in the tree" checkable rather than aspirational.
import { loadPdeViewer, rankForViewer } from "../lib/discoveryPde.js";
import { logDiscoveryShadowServe } from "../lib/discoveryShadow.js";
import { isInDiscoveryCohort } from "../lib/discoveryCohort.js";
import {
  readPlacesFromDb,
  writePlacesToDb,
  readGeocodeFromDb,
  writeGeocodeToDb,
  invalidateDiscoveryCacheForOsmId,
} from "../lib/discoveryPersistentCache";
import {
  fetchEventPostsForDiscovery,
  type DiscoveryEventPost,
} from "../lib/eventPostsDiscovery";

const router = Router();

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const OVERPASS_URL  = "https://overpass-api.de/api/interpreter";
const FETCH_TIMEOUT_MS = 25_000;
const CACHE_TTL_MS     = 2 * 60 * 60 * 1_000; // 2 hours
const MAX_FETCH        = 60;
const PAGE_SIZE        = 20;

// ── Types ─────────────────────────────────────────────────────────────────────

/** Shape used internally and returned in all API responses. */
export interface DiscoveryPlace {
  id: string;
  /**
   * Bare public.places uuid when this row came from the canonical table — the id
   * the client needs to open the full place page (/place/<uuid>) with the living
   * surface and Quick Signal capture. Absent for discovery_places/OSM rows.
   */
  canonicalPlaceId?: string | null;
  name: string;
  category: string;
  type: string | null;
  description: string | null;
  distanceKm: number | null;
  /** OSM venue latitude — public data, safe to expose */
  lat: number | null;
  /** OSM venue longitude — public data, safe to expose */
  lng: number | null;
  tags: string[];
  address: string | null;
  /** Neighbourhood label. From OSM `addr:neighbourhood` / `addr:suburb` for OSM
   *  places; the client renders it ahead of `address` on the card. */
  neighborhood?: string | null;
  /**
   * Wikidata entity id (`Q…`) when OSM carries one. Tier 1 CARRIES this; it does
   * not consume it. It is the join key a later Tier 2 step would use to reach
   * free licensed structured data, and it is worthless if discarded here.
   */
  wikidataId?: string | null;
  /**
   * Raw OSM `image` tag, validated as an absolute http(s) URL and nothing more.
   *
   * DELIBERATELY NOT PROMOTED to `headerImageUrl` in Tier 1 step 1. The client's
   * `useFsqPhoto` returns early when a header image is already present, so
   * promoting this value here would silently REPLACE the working FSQ → Google →
   * artwork chain with an unvalidated third-party URL — and a dead URL renders
   * as "this place has no photo", which is indistinguishable from never having
   * resolved one. Precedence and invalidation are ruled to be settled together
   * in the photo-persistence step; this field is what lets that step consider
   * OSM at all.
   */
  osmImageUrl?: string | null;
  website: string | null;
  phone: string | null;
  openingHours: string | null;
  rating: number | null;
  isOpenNow: boolean | null;
  /** Number of times this place has been saved; populated for DB-backed places. */
  savedCount?: number;
  /** Data-source attribution text. Set for FSQ-sourced places; absent for OSM
   *  places so the client falls back to the OSM copyright footer. */
  attribution?: string | null;
  /** Primary cover image URL (from discovery_places.image_url). Null = no image. */
  headerImageUrl?: string | null;
  /**
   * How the header image was sourced. Drives the resolver priority ladder and
   * the "AI-generated representation" disclosure label in the UI.
   *   'ai_generated'  — image was produced by the AI visuals pipeline
   *   'provider'      — FSQ / OSM / other third-party photo
   *   'user_upload'   — uploaded directly by the place owner or a traveler
   *   'official'      — official venue photography
   *   'portava_media' — Portava curated media library
   */
  headerImageSource?: string | null;
  /** Nine-value accuracy source classification (from the accuracy pipeline). */
  imageSourceType?: string | null;
  /** Accuracy assessment state: 'verified_real' | 'illustrative_only' | 'unverified' | etc. */
  accuracyStatus?: string | null;
  /** When true the UI must render a disclaimer alongside this image. */
  disclaimerRequired?: boolean | null;
  /** Disclaimer copy to display when disclaimerRequired is true. */
  disclaimerText?: string | null;
}

/** Public shape returned in all API responses. */
export type PublicDiscoveryPlace = DiscoveryPlace;

function toPublic(p: DiscoveryPlace): PublicDiscoveryPlace {
  return p;
}

// ── Accuracy-pipeline helpers ─────────────────────────────────────────────────
// Derives disclaimer presence/text from `image_accuracy_status` so every route
// that returns a DiscoveryPlace emits the same client-facing accuracy fields.

function placeMustShowDisclaimer(accuracyStatus: string | null | undefined): boolean {
  return accuracyStatus === 'illustrative_only' || accuracyStatus === 'rejected';
}

function placeDisclaimerText(accuracyStatus: string | null | undefined): string | null {
  if (accuracyStatus === 'illustrative_only') {
    return 'Illustrative image — this does not show the actual location.';
  }
  if (accuracyStatus === 'rejected') {
    return 'This image may not show the actual location.';
  }
  return null;
}

interface CacheEntry {
  places: DiscoveryPlace[];
  cachedAt: number;
}

// ── In-memory cache ───────────────────────────────────────────────────────────

const cache = new Map<string, CacheEntry>();

// ── Compass candidate cache ───────────────────────────────────────────────────
// Per-user, per-city short-lived cache for the Compass scored candidate list.
// Skips the full scoring pipeline (profile fetch + Compass context build +
// rankItemsForDiscovery) on repeated For You requests within the TTL window
// — e.g. the user swipes away to another tab and back within a few minutes.
// 10-minute TTL matches the Compass feed TTL used elsewhere.
const COMPASS_CANDIDATE_CACHE_TTL_MS = 10 * 60 * 1_000;
const _compassCandidateCache = new Map<string, { places: DiscoveryPlace[]; at: number }>();

function compassCandidateCacheKey(userId: string, destination: string, radiusKm: number, sortBy: string | null): string {
  return `${userId}:${destination.toLowerCase().trim()}:r${radiusKm}:s${sortBy ?? "default"}`;
}

function cacheKey(dest: string, cat: string, radius: number) {
  return `${dest.toLowerCase().trim()}:${cat}:${radius}`;
}

function isFresh(e: CacheEntry) {
  return Date.now() - e.cachedAt < CACHE_TTL_MS;
}

// ── Geocode deduplication cache ────────────────────────────────────────────────
// Caches Nominatim results for 24 h and deduplicates concurrent in-flight
// requests so that N parallel category-count calls for the same city only call
// Nominatim once — preserving the 1 req/s fair-use policy.
const GEOCODE_CACHE_TTL = 24 * 60 * 60 * 1_000;
const _geocodeMemory  = new Map<string, { r: { lat: number; lng: number; display: string } | null; at: number }>();
const _geocodePending = new Map<string, Promise<{ lat: number; lng: number; display: string } | null>>();

/**
 * Patch the savedCount for a single OSM place across all live cache entries.
 *
 * Called by the wishlist router immediately after `trackOsmPlaceSave` /
 * `trackOsmPlaceUnsave` increments or decrements `saved_count` in the DB, so
 * the popular sort reflects the change on the next request instead of serving
 * a stale count for up to the 2-hour TTL.
 *
 * The cache key encodes destination + category + radius, none of which are
 * available in the wishlist path, so we scan all entries and patch every place
 * whose `id` (the OSM element string, e.g. "node/12345678") matches.
 * In practice at most one entry per category bucket will match.
 */
export function patchOsmSavedCount(osmId: string, newCount: number): void {
  for (const entry of cache.values()) {
    for (const place of entry.places) {
      if (place.id === osmId) {
        place.savedCount = newCount;
        break;
      }
    }
  }
  // Evict L2 (Postgres discovery_cache) rows that contain this OSM place so
  // that stale enriched counts are not served after the L1 TTL expires.
  // Fire-and-forget — a cache miss is always preferable to a stale count.
  void invalidateDiscoveryCacheForOsmId(osmId);
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function geocode(location: string): Promise<{ lat: number; lng: number; display: string } | null> {
  const url = `${NOMINATIM_URL}?q=${encodeURIComponent(location)}&format=json&limit=1`;
  const res = await fetchWithTimeout(url, {
    headers: { "User-Agent": "TravelBuddy/1.0 (travel-buddy-app; discovery)" },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
  const r = data?.[0];
  if (!r) return null;
  return { lat: parseFloat(r.lat), lng: parseFloat(r.lon), display: r.display_name };
}

/**
 * Geocode with a 24-hour two-level cache (L1: in-process Map, L2: Postgres)
 * and in-flight deduplication.
 *
 * When N category-count requests arrive in parallel for the same city this
 * ensures only ONE Nominatim call is made — the rest await the same promise.
 * L2 (Postgres) allows a fresh instance to skip Nominatim on cold start for
 * any city that has been queried within the last 24 hours.
 */
function geocodeCached(location: string): Promise<{ lat: number; lng: number; display: string } | null> {
  const key = location.toLowerCase().trim();

  // L1: in-process memory (zero network round-trip)
  const mem = _geocodeMemory.get(key);
  if (mem && Date.now() - mem.at < GEOCODE_CACHE_TTL) return Promise.resolve(mem.r);

  // Dedup: return the same promise to every concurrent caller.
  const existing = _geocodePending.get(key);
  if (existing) return existing;

  const p = (async () => {
    // L2: Postgres geocode cache (survives restarts; strict TTL enforced in DB)
    const dbResult = await readGeocodeFromDb(key);
    if (dbResult) {
      _geocodeMemory.set(key, { r: dbResult, at: Date.now() });
      return dbResult;
    }
    // Miss: call Nominatim and persist to both levels.
    const r = await geocode(location);
    _geocodeMemory.set(key, { r, at: Date.now() });
    if (r) void writeGeocodeToDb(key, r);
    return r;
  })().finally(() => {
    _geocodePending.delete(key);
  });

  _geocodePending.set(key, p);
  return p;
}

// ── Category → Overpass filter ────────────────────────────────────────────────

/**
 * Exported for the Tier 1 coverage report, so the measurement queries EXACTLY
 * what production queries. A coverage number taken over a different filter is a
 * number about a different population, and would be worse than none.
 */
export function overpassFilter(cat: string, radius: number, lat: number, lng: number): string {
  const r = radius;
  const c = `${lat},${lng}`;

  switch (cat) {
    case "places":
      return `(
  node["tourism"~"^(attraction|museum|viewpoint|gallery|castle|ruins|artwork|monument|historic)$"](around:${r},${c});
  way["tourism"~"^(attraction|museum|viewpoint|gallery|castle|ruins|artwork|monument|historic)$"](around:${r},${c});
  node["historic"~"^(castle|monument|memorial|ruins|building|church|fort|palace)$"](around:${r},${c});
  way["historic"~"^(castle|monument|memorial|ruins|building|church|fort|palace)$"](around:${r},${c});
);`;

    case "food":
      return `(
  node["amenity"~"^(restaurant|cafe|fast_food|bistro|food_court|bakery|ice_cream)$"](around:${r},${c});
  way["amenity"~"^(restaurant|cafe|fast_food|bistro|food_court|bakery|ice_cream)$"](around:${r},${c});
);`;

    case "nightlife":
      return `(
  node["amenity"~"^(bar|pub|nightclub|casino|biergarten|cocktail_bar)$"](around:${r},${c});
  way["amenity"~"^(bar|pub|nightclub|casino|biergarten|cocktail_bar)$"](around:${r},${c});
);`;

    case "activities":
      return `(
  node["leisure"~"^(park|sports_centre|fitness_centre|swimming_pool|golf_course|marina|water_park|miniature_golf|bowling_alley|stadium)$"](around:${r},${c});
  way["leisure"~"^(park|sports_centre|fitness_centre|swimming_pool|golf_course|marina|water_park|miniature_golf|bowling_alley|stadium)$"](around:${r},${c});
  node["tourism"~"^(theme_park|zoo|aquarium)$"](around:${r},${c});
  way["tourism"~"^(theme_park|zoo|aquarium)$"](around:${r},${c});
);`;

    case "events":
      return `(
  node["amenity"~"^(marketplace|community_centre|events_venue|theatre|cinema|arts_centre)$"](around:${r},${c});
  way["amenity"~"^(marketplace|community_centre|events_venue|theatre|cinema|arts_centre)$"](around:${r},${c});
  node["tourism"="gallery"](around:${r},${c});
  way["tourism"="gallery"](around:${r},${c});
);`;

    case "beaches":
      return `(
  node["natural"="beach"](around:${r},${c});
  way["natural"="beach"](around:${r},${c});
  relation["natural"="beach"](around:${r},${c});
  node["leisure"="beach_resort"](around:${r},${c});
  way["leisure"="beach_resort"](around:${r},${c});
);`;

    case "transport":
      return `(
  node["amenity"~"^(bus_station|ferry_terminal|taxi|car_rental|bicycle_rental)$"](around:${r},${c});
  node["railway"~"^(station|halt|tram_stop|subway_entrance)$"](around:${r},${c});
  node["aeroway"~"^(aerodrome|terminal)$"](around:${r},${c});
  way["aeroway"~"^(aerodrome|terminal)$"](around:${r},${c});
);`;

    case "for_you":
    default:
      return `(
  node["tourism"~"^(attraction|museum|viewpoint|gallery)$"](around:${r},${c});
  way["tourism"~"^(attraction|museum|viewpoint|gallery)$"](around:${r},${c});
  node["amenity"~"^(restaurant|cafe)$"](around:${r},${c});
  node["natural"="beach"](around:${r},${c});
  way["natural"="beach"](around:${r},${c});
  node["leisure"~"^(park|sports_centre)$"](around:${r},${c});
  way["leisure"~"^(park|sports_centre)$"](around:${r},${c});
);`;
  }
}

// ── Haversine ─────────────────────────────────────────────────────────────────

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Tag extraction ────────────────────────────────────────────────────────────

function friendlyType(tags: Record<string, string>): string | null {
  if (tags.tourism)  return tags.tourism.replace(/_/g, " ");
  if (tags.amenity)  return tags.amenity.replace(/_/g, " ");
  if (tags.leisure)  return tags.leisure.replace(/_/g, " ");
  if (tags.natural)  return tags.natural.replace(/_/g, " ");
  if (tags.historic) return tags.historic.replace(/_/g, " ");
  if (tags.railway)  return "rail station";
  if (tags.aeroway)  return "airport";
  return null;
}

function extractTags(tags: Record<string, string>): string[] {
  const out: string[] = [];
  if (tags.cuisine)    out.push(tags.cuisine.split(/[;,]/)[0]!.trim().replace(/_/g, " "));
  if (tags.tourism)    out.push(tags.tourism.replace(/_/g, " "));
  if (tags.amenity)    out.push(tags.amenity.replace(/_/g, " "));
  if (tags.leisure)    out.push(tags.leisure.replace(/_/g, " "));
  if (tags.natural)    out.push(tags.natural);
  if (tags.historic)   out.push(tags.historic.replace(/_/g, " "));
  if (tags.sport)      out.push(tags.sport.split(";")[0]!.trim());
  return [...new Set(out)].filter(Boolean).slice(0, 3);
}

// ── Tier 1 OSM attribute mapping ──────────────────────────────────────────────
//
// Overpass returns the FULL tag set and this route historically kept seven tags
// and dropped the rest on the floor. These helpers stop discarding the six the
// owner's Tier 1 ruling names: outdoor_seating, wheelchair, internet_access,
// addr:neighbourhood, wikidata and image.
//
// ONE INVARIANT GOVERNS ALL OF THEM, and it is the workstream's own:
// ABSENCE OF EVIDENCE MUST NOT BECOME EVIDENCE OF ABSENCE. An untagged place is
// not a place without wifi — OSM tagging is sparse and voluntary. So every
// helper below renders something only for an AFFIRMATIVE tag value, and emits
// nothing at all when the tag is missing, empty, or negative. No card ever says
// "no outdoor seating" on the strength of a tag nobody wrote.

/** OSM boolean-ish values that affirm a feature. `no`/`none` never affirm. */
function osmAffirms(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "yes" || v === "designated" || v === "only";
}

/**
 * Human-readable attribute chips for the card's existing tag row.
 *
 * Deliberately limited to the SIX TAGS THE RULING NAMES. Overpass carries far
 * more that the enumeration costed as Tier 1 (takeaway, delivery, payment:*,
 * kids_area…), and they remain free to add — but widening the set is a decision
 * the ruling did not make, so this does not make it either.
 */
function extractAttributeTags(tags: Record<string, string>): string[] {
  const out: string[] = [];

  if (osmAffirms(tags["outdoor_seating"])) out.push("outdoor seating");

  // `wheelchair` is three-valued and the middle value is real information:
  // `limited` means *partially* accessible, and flattening it to "accessible"
  // would overstate it to exactly the users who cannot afford the overstatement.
  const wheelchair = tags["wheelchair"]?.trim().toLowerCase();
  if (wheelchair === "yes" || wheelchair === "designated") out.push("wheelchair accessible");
  else if (wheelchair === "limited") out.push("partial wheelchair access");

  // `internet_access` names the TECHNOLOGY, not a yes/no: wlan/wifi mean wifi,
  // `terminal` means a machine on site, and `no` means no.
  const net = tags["internet_access"]?.trim().toLowerCase();
  if (net === "wlan" || net === "wifi" || net === "yes") out.push("wifi");
  else if (net === "terminal") out.push("internet terminal");

  return out;
}

/** Wikidata entity ids are `Q` followed by digits. Anything else is not one. */
function extractWikidataId(tags: Record<string, string>): string | null {
  const raw = tags["wikidata"]?.trim();
  return raw && /^Q[1-9]\d*$/.test(raw) ? raw : null;
}

/**
 * The OSM `image` tag, kept only when it is an absolute http(s) URL.
 *
 * This tag is NOT reliably a photo. A large share of real values are Wikimedia
 * Commons *page* URLs (`.../wiki/File:X.jpg`) which render as a broken image,
 * and others are `File:X.jpg` bare filenames with no host at all. Resolving
 * those is a Wikimedia call, which is Tier 2. Tier 1 carries the raw value and
 * makes no claim that it is displayable.
 */
function extractOsmImageUrl(tags: Record<string, string>): string | null {
  const raw = tags["image"]?.trim();
  if (!raw) return null;
  return /^https?:\/\/\S+$/i.test(raw) ? raw : null;
}

function parseRating(tags: Record<string, string>): number | null {
  const raw = tags["stars"] ?? tags["rating"] ?? null;
  if (!raw) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

/** Best-effort open-now check from an OSM opening_hours string. */
function determineOpenNow(hours: string | null, lng: number | null): boolean | null {
  if (!hours) return null;
  // Evaluate open/closed in the VENUE's local time, not the server's. OSM has no
  // timezone tag, so approximate the venue's UTC offset from its longitude (15°
  // per hour). This is coarse — it ignores DST and political tz boundaries — but
  // far better than the previous server-local computation, which was wrong by the
  // whole server→venue offset (e.g. a Da Nang venue read against a UTC server was
  // off by 7 hours). With no longitude we cannot place the venue in time, so
  // return null (unknown) rather than assert a wrong open/closed.
  if (lng == null) return null;
  const offsetMs = Math.round(lng / 15) * 3_600_000;
  const venueNow = new Date(Date.now() + offsetMs); // read via getUTC* for venue-local
  const dayAbbr = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"][venueNow.getUTCDay()];
  if (dayAbbr && !hours.includes(dayAbbr)) return false;
  const match = hours.match(/(\d{2}):(\d{2})-(\d{2}):(\d{2})/);
  if (!match) return null; // present but unparseable — unknown
  const hh    = venueNow.getUTCHours() * 100 + venueNow.getUTCMinutes();
  const open  = parseInt(match[1]!) * 100 + parseInt(match[2]!);
  const close = parseInt(match[3]!) * 100 + parseInt(match[4]!);
  return hh >= open && hh <= close;
}

function buildAddress(tags: Record<string, string>): string | null {
  const parts: string[] = [];
  if (tags["addr:housenumber"] && tags["addr:street"]) {
    parts.push(`${tags["addr:housenumber"]} ${tags["addr:street"]}`);
  } else if (tags["addr:street"]) {
    parts.push(tags["addr:street"]);
  }
  if (tags["addr:city"]) parts.push(tags["addr:city"]);
  return parts.length ? parts.join(", ") : null;
}

// ── Overpass query ────────────────────────────────────────────────────────────

export type OsmElement = {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

async function queryOverpass(
  lat: number,
  lng: number,
  radiusM: number,
  category: string,
): Promise<DiscoveryPlace[]> {
  const filter = overpassFilter(category, radiusM, lat, lng);
  const query  = `[out:json][timeout:20];\n${filter}\nout body center qt ${MAX_FETCH};`;

  // GET avoids Content-Type 406 issues with undici (Node built-in fetch).
  const url = `${OVERPASS_URL}?data=${encodeURIComponent(query)}`;
  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      headers: { "User-Agent": "TravelBuddy/1.0 (travel-buddy-app; discovery)" },
    });
  } catch {
    return [];
  }

  if (!res.ok) return [];

  const data = (await res.json()) as { elements: OsmElement[] };
  if (!data?.elements?.length) return [];

  return data.elements
    .filter((el) => el.tags?.name && el.tags.name.trim())
    .map((el) => mapOsmElementToPlace(el, category, lat, lng))
    .sort((a, b) => (a.distanceKm ?? 999) - (b.distanceKm ?? 999))
    .slice(0, MAX_FETCH);
}

/** Category chips first, then attribute chips, capped so the card's tag row
 *  cannot be flooded. Category identity is what the chip row was for, so it
 *  keeps its places; attributes fill what is left. */
const MAX_CATEGORY_CHIPS  = 3;
const MAX_TOTAL_CHIPS     = 6;

/**
 * OSM element → `DiscoveryPlace`.
 *
 * Exported for test on purpose. This is the ONLY OSM→place mapping in the
 * route, it is the function Tier 1 modifies, and until now it was reachable
 * only through a live Overpass HTTP call — which means it had no unit coverage
 * at all and every claim about "what an OSM place carries" was read by eye.
 */
export function mapOsmElementToPlace(
  el: OsmElement,
  category: string,
  originLat: number,
  originLng: number,
): DiscoveryPlace {
  const elLat = el.lat ?? el.center?.lat ?? null;
  const elLng = el.lon ?? el.center?.lon ?? null;
  const tags  = el.tags ?? {};

  const chips = [
    ...extractTags(tags).slice(0, MAX_CATEGORY_CHIPS),
    ...extractAttributeTags(tags),
  ];

  return {
    id:          `${el.type}/${el.id}`,
    name:        tags.name!,
    category,
    type:        friendlyType(tags),
    description: tags.description ?? tags["note"] ?? null,
    distanceKm:  elLat != null && elLng != null
      ? Math.round(haversineKm(originLat, originLng, elLat, elLng) * 10) / 10
      : null,
    lat:         elLat,
    lng:         elLng,
    tags:         [...new Set(chips)].slice(0, MAX_TOTAL_CHIPS),
    address:      buildAddress(tags),
    neighborhood: osmNeighborhood(tags),
    wikidataId:   extractWikidataId(tags),
    osmImageUrl:  extractOsmImageUrl(tags),
    website:      tags.website ?? tags.url ?? null,
    phone:        tags.phone ?? tags["contact:phone"] ?? null,
    openingHours: tags.opening_hours ?? null,
    rating:       parseRating(tags),
    isOpenNow:    determineOpenNow(tags.opening_hours ?? null, elLng),
  };
}

// ── Category mapper (DB → Discovery tab) ──────────────────────────────────────
//
// Wraps the authoritative placeCategories.ts module.
// Prefer primary_category from the DB; fall back to the canonical mapper
// only for rows that pre-date migration 0083 (no primary_category yet).

/** Internal dedup keys (e.g. "osm:node/4089438971" from seed-discovery-places.ts)
 * are never valid display text — filter them the same way isInternalTag does
 * in the mobile client's PlaceDetailSheet. */
function isInternalTag(tag: string | null | undefined): boolean {
  return typeof tag === "string" && /^osm[:/]/i.test(tag);
}

/** Title-cases a snake_case/camelCase category into a display label
 * (e.g. "hidden_gem" → "Hidden Gem"). Used as the Traveler Pick chip
 * fallback when the stored `tag` is an internal dedup key, not real text. */
function humanizeCategory(category: string | null | undefined): string {
  if (!category) return "Place";
  const s = category
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
  return s || "Place";
}

function mapDbCategory(rawCategory: string, rawPlaceType?: string): string {
  return toCanonicalCategory(rawCategory, rawPlaceType);
}

// ── DB places query ────────────────────────────────────────────────────────────
//
// Queries discovery_places by city name (case-insensitive). Results are merged
// with OSM results and deduplicated by normalised place name so that traveler-
// submitted places surface even when Overpass returns nothing for a destination.

/**
 * Source values that identify seeded demo/QA fixture rows in `discovery_places`.
 * Exported so tests can assert against the canonical set without duplicating it.
 *
 * NULL source is intentionally absent — it indicates a legacy community submission
 * that pre-dates the source column and must remain visible in Discovery.
 *
 * Good sources (pass through): 'curated', 'traveler', 'osm', 'fsq*', null/undefined.
 * Excluded sources: anything in this set.
 */
export const DEMO_DISCOVERY_SOURCES = new Set(["seed_script", "demo", "qa_fixture"]);

/** Test-only: override the DB query so tests can inject seeded rows without a live DB. */
let _testDbOverride: ((dest: string, cat: string, lat: number | null, lng: number | null) => Promise<DiscoveryPlace[]>) | null = null;
export function _setTestDbPlacesOverride(fn: typeof _testDbOverride): void {
  _testDbOverride = fn;
}

/**
 * Test hook: inject a fake cache entry so unit tests can verify that
 * `patchOsmSavedCount` updates the right place without requiring a real
 * Overpass round-trip.  Objects are stored by reference so in-place
 * mutations by `patchOsmSavedCount` are observable on the original objects.
 */
export function _injectTestCacheEntry(key: string, places: DiscoveryPlace[]): void {
  cache.set(key, { places, cachedAt: Date.now() });
}

/** Test hook: remove a cache entry previously injected by _injectTestCacheEntry. */
export function _clearTestCacheEntry(key: string): void {
  cache.delete(key);
}

/** Test hook: expose enrichOsmSavedCounts for unit testing without going through the route. */
export const _testEnrichOsmSavedCounts = enrichOsmSavedCounts;

/**
 * Evict all L1 in-memory cache entries that contain an OSM place with the
 * given osmId (stored directly as place.id, e.g. "node/12345678").  Called
 * after a vote or review write so the next feed request re-enriches vote
 * counts from the live DB rather than serving the stale cached values for
 * up to the 2-hour TTL.
 *
 * Analogous to patchOsmSavedCount but used for vote/review enrichment where
 * a simple in-place patch is not safe (counts require a DB re-fetch).
 */
export function evictOsmPlaceFromL1Cache(osmId: string): void {
  for (const [key, entry] of cache) {
    if (entry.places.some((p) => p.id === osmId)) {
      cache.delete(key);
    }
  }
}

/**
 * Evict all L1 in-memory cache entries that contain a DB place with the given
 * entityId (stored as id "db/<entityId>").  Called by admin moderation actions
 * (approve/reject/downgrade/replace/report-resolve) so that a request served
 * within the L1 TTL after the action gets fresh data rather than a stale image.
 *
 * Mirrors the L2 invalidation in discoveryPersistentCache.ts.
 */
export function evictCacheEntriesForEntity(entityId: string): void {
  const targetId = `db/${entityId}`;
  for (const [key, entry] of cache) {
    if (entry.places.some((p) => p.id === targetId)) {
      cache.delete(key);
    }
  }
}

async function queryDbPlaces(
  destination: string,
  category: string,
  centerLat: number | null,
  centerLng: number | null,
): Promise<DiscoveryPlace[]> {
  if (_testDbOverride) return _testDbOverride(destination, category, centerLat, centerLng);

  const sc = getServiceClient();
  if (!sc) return [];

  // Normalise: "Miami, FL" → "Miami"; strip trailing country/state qualifiers
  const cityBase = sanitizeCityFilter(destination.split(",")[0]?.trim() ?? destination);

  try {
    const { data, error } = await sc
      .from("discovery_places")
      .select("id, city, name, place_type, category, primary_category, secondary_categories, neighborhood, blurb, image_url, header_image_source, image_source_type, image_accuracy_status, rating, saved_count, lat, lng, tag, verified, created_at, source")
      .or(`city.ilike.${cityBase},city.ilike.${cityBase}%`)
      .eq("status", "active")
      // Exclude seeded demo/QA fixtures — they never carry real OSM enrichment
      // (outdoor_seating, wheelchair, wikidata, image tags etc.) and would mislead
      // any reviewer checking whether Tier 1 Place Intelligence is working.
      // Known demo-source values: 'seed_script' (seed-demo-profile.ts, seed-demo-social.ts)
      // and 'demo' (any future demo-data pipeline).  Curated ('curated'), OSM-saved
      // ('osm'), FSQ ('fsq*'), and traveler-submitted ('traveler') rows are unaffected.
      //
      // NULL-safe: use OR so rows with no source value are included (legacy community
      // submissions pre-date the source column and must not be accidentally excluded).
      // SQL NOT IN silently drops NULLs, so we must name the NULL case explicitly.
      .or("source.is.null,source.not.in.(seed_script,demo,qa_fixture)")
      .order("saved_count", { ascending: false })
      // Fetch WIDER than the final cap: the category filter runs in TS below
      // (it needs primary_category + secondary_categories + mapDbCategory), so a
      // pre-filter limit of 60 could drop a tab's matches for cities near that
      // size. Cap to 60 AFTER filtering (discovery_places is small, so 200 is cheap).
      .limit(200);

    if (error || !data) return [];

    const dbPlaces = (data as any[])
      .filter((row: any) => {
        // In-memory safety net alongside the DB predicate: exclude demo/QA fixture
        // rows even if the DB filter was not applied (e.g. a test override, a schema
        // change, or a future query refactor).  null source passes — it is a legitimate
        // legacy row, not a demo row.
        if (DEMO_DISCOVERY_SOURCES.has(row.source as string)) return false;
        if (category === "for_you") return true;
        // Prefer primary_category (post-migration 0083); fall back to the
        // canonical mapper so pre-migration rows still filter correctly.
        const effectiveCategory: string = (row.primary_category as string | null)
          ?? mapDbCategory((row.category ?? "") as string, (row.place_type ?? "") as string);
        if (effectiveCategory === category) return true;
        // Also include places where the requested category appears in secondary_categories,
        // so multi-category venues (e.g. a beach bar: primary=beaches, secondary=[food])
        // show up in all applicable tabs.
        const secondary: string[] = Array.isArray(row.secondary_categories)
          ? (row.secondary_categories as string[])
          : [];
        return secondary.includes(category);
      })
      .slice(0, 60) // cap AFTER the category filter (see the widened .limit above)
      .map((row: any): DiscoveryPlace => {
        const lat = row.lat != null ? parseFloat(String(row.lat)) : null;
        const lng = row.lng != null ? parseFloat(String(row.lng)) : null;
        const effectiveCategory: string = (row.primary_category as string | null)
          ?? mapDbCategory((row.category ?? "") as string, (row.place_type ?? "") as string);
        return {
          id: `db/${row.id as string}`,
          name: row.name as string,
          // Use canonical category so the frontend always gets a valid tab value
          category: effectiveCategory,
          type: (row.place_type ?? null) as string | null,
          description: (row.blurb ?? null) as string | null,
          distanceKm:
            centerLat != null && centerLng != null && lat != null && lng != null
              ? Math.round(haversineKm(centerLat, centerLng, lat, lng) * 10) / 10
              : null,
          lat,
          lng,
          tags: [row.category, row.tag].filter(Boolean) as string[],
          address: (row.neighborhood ?? null) as string | null,
          website: null,
          phone: null,
          openingHours: null,
          rating: row.rating != null ? parseFloat(String(row.rating)) : null,
          isOpenNow: null,
          savedCount: (row.saved_count as number) ?? 0,
          headerImageUrl: (row.image_url ?? null) as string | null,
          headerImageSource: (row.header_image_source ?? null) as string | null,
          imageSourceType: (row.image_source_type ?? null) as string | null,
          accuracyStatus: (row.image_accuracy_status ?? null) as string | null,
          disclaimerRequired: placeMustShowDisclaimer(row.image_accuracy_status as string | null),
          disclaimerText: placeDisclaimerText(row.image_accuracy_status as string | null),
          attribution: (row.source as string | null)?.startsWith("fsq")
            ? "Place data © Foursquare (CC BY 4.0)"
            : null,
        };
      });

    // Enrich DB places with vote counts and review aggregates (best-effort, cached alongside places)
    const rawIds = dbPlaces.map((p) => p.id.slice(3)); // strip 'db/' prefix
    const agg = await batchFetchVoteAndRatingAggregates(sc, rawIds, "place");
    if (agg.size === 0) return dbPlaces;
    return dbPlaces.map((p) => {
      const a = agg.get(p.id.slice(3));
      return a ? { ...p, worthItCount: a.worthItCount, avgRating: a.avgRating, reviewCount: a.reviewCount } : p;
    });
  } catch {
    return [];
  }
}

/**
 * Canonical-places query — the fix for "No places found" in every non-demo city.
 *
 * The Discover feed's two sources were discovery_places (184 rows across 8 demo
 * cities) and live Overpass. public.places — the canonical table the FSQ backfill
 * populates (Da Nang alone: ~2.6k active rows) — was never read, so any city
 * outside the demo eight depended 100% on Overpass, and when the deployment's
 * egress IP is rate-limited by overpass-api.de the feed silently served
 * `{places: [], total: 0}`. This surfaces the canonical rows as a third source.
 *
 * Rows map through toCanonicalCategory (total — unknown values land in 'places'),
 * carry the same `db/<id>` prefix as discovery_places rows (the detail sheet is
 * self-contained, so no client change is required), and dedup by normalised name
 * happens in the caller so richer discovery_places/OSM rows win on collision.
 */
/**
 * The coarse primary_category vocabulary public.places actually uses. The
 * discovery tabs are finer, so we map a requested tab to the SET of place-vocab
 * values that toCanonicalCategory sends to it — computed, not hardcoded, so it
 * can never drift from the mapper. Empty set => no canonical rows for that tab.
 */
const PLACE_PRIMARY_VOCAB = ["food", "nightlife", "accommodation", "shopping", "culture", "other"] as const;
function primaryCategoriesFor(discoveryCategory: string): string[] {
  return PLACE_PRIMARY_VOCAB.filter((pc) => toCanonicalCategory(pc, null) === discoveryCategory);
}

/**
 * Strip the PostgREST .or() structural metacharacters from a user-supplied city
 * before interpolation. Parens/commas/asterisks could otherwise terminate the
 * or() group and inject filter conditions. Normal city names never contain them
 * (commas are already stripped by the split on ','). Fixes a filter-injection
 * surface shared with queryDbPlaces.
 */
function sanitizeCityFilter(city: string): string {
  return city.replace(/[(),*]/g, "").trim();
}

async function queryCanonicalPlaces(
  destination: string,
  category: string,
  centerLat: number | null,
  centerLng: number | null,
): Promise<DiscoveryPlace[]> {
  const sc = getServiceClient();
  if (!sc) return [];

  const cityBase = sanitizeCityFilter(destination.split(",")[0]?.trim() ?? destination);
  if (!cityBase) return [];

  // Push the category filter into SQL so the LIMIT applies to the RIGHT category.
  // A 400-row UNORDERED pre-filter still starved rare categories in large cities
  // (e.g. ~150 culture rows among 12k could be absent from an arbitrary 400).
  const wantPrimary = category === "for_you" ? null : primaryCategoriesFor(category);
  if (wantPrimary && wantPrimary.length === 0) return []; // no place-vocab maps to this tab

  try {
    let q = sc
      .from("places")
      .select("id, name, city, primary_category, latitude, longitude, neighborhood, address, image_source_type, image_accuracy_status")
      .or(`city.ilike.${cityBase},city.ilike.${cityBase}%`)
      .eq("status", "active")
      .is("merged_into_place_id", null);
    if (wantPrimary) q = q.in("primary_category", wantPrimary);
    // Deterministic order so pagination/results are stable across requests.
    const { data, error } = await q.order("normalized_name", { ascending: true }).limit(400);

    if (error || !data) return [];

    return (data as any[])
      .filter((row: any) => {
        if (category === "for_you") return true;
        return toCanonicalCategory(row.primary_category as string, null) === category;
      })
      .slice(0, 60)
      .map((row: any): DiscoveryPlace => {
        const lat = row.latitude != null ? parseFloat(String(row.latitude)) : null;
        const lng = row.longitude != null ? parseFloat(String(row.longitude)) : null;
        return {
          id: `db/${row.id as string}`,
          canonicalPlaceId: row.id as string,
          name: row.name as string,
          category: toCanonicalCategory(row.primary_category as string, null),
          type: (row.primary_category ?? null) as string | null,
          description: null,
          distanceKm:
            centerLat != null && centerLng != null && lat != null && lng != null
              ? Math.round(haversineKm(centerLat, centerLng, lat, lng) * 10) / 10
              : null,
          lat,
          lng,
          tags: [row.primary_category].filter(Boolean) as string[],
          address: (row.neighborhood ?? row.address ?? null) as string | null,
          website: null,
          phone: null,
          openingHours: null,
          rating: null,
          isOpenNow: null,
          savedCount: 0,
          headerImageUrl: null,
          headerImageSource: null,
          imageSourceType: (row.image_source_type ?? null) as string | null,
          accuracyStatus: (row.image_accuracy_status ?? null) as string | null,
          disclaimerRequired: placeMustShowDisclaimer(row.image_accuracy_status as string | null),
          disclaimerText: placeDisclaimerText(row.image_accuracy_status as string | null),
          attribution: null,
        };
      });
  } catch {
    return [];
  }
}

/**
 * The DB place set for the discovery feed: curated discovery_places PLUS
 * canonical public.places, deduped by normalised name (curated wins — it carries
 * images/ratings/save counts the canonical table lacks). Used by BOTH the
 * cache-miss path and the warm-cache serve path — previously only the miss path
 * merged canonical rows, so every cache HIT silently dropped them and a warm
 * Da Nang feed fell back to OSM-only.
 */
async function loadCuratedAndCanonicalPlaces(
  destination: string,
  category: string,
  centerLat: number | null,
  centerLng: number | null,
): Promise<DiscoveryPlace[]> {
  const [curated, canonical] = await Promise.all([
    queryDbPlaces(destination, category, centerLat, centerLng),
    queryCanonicalPlaces(destination, category, centerLat, centerLng),
  ]);
  const curatedNames = new Set(curated.map((p) => p.name.toLowerCase().trim()));
  return [
    ...curated,
    ...canonical.filter((p) => !curatedNames.has(p.name.toLowerCase().trim())),
  ];
}

// ── OSM saved-count enrichment ────────────────────────────────────────────────
//
// OSM places returned by Overpass have no saved_count because they live only
// in the in-memory cache, not in discovery_places.  When a user saves an OSM
// place via POST /api/wishlist the wishlist handler upserts a row in
// discovery_places (source="osm", osm_id=<type>/<id>).  This function does a
// single batch lookup to attach those real save counts to the Overpass results
// before they are stored in the cache.  Failures are swallowed — a missing
// savedCount just means the popular sort falls back to rating as the tie-breaker.

async function enrichOsmSavedCounts(places: DiscoveryPlace[]): Promise<DiscoveryPlace[]> {
  if (places.length === 0) return places;
  const sc = getServiceClient();
  if (!sc) return places;

  try {
    const osmIds = places.map((p) => p.id);
    // Fetch id (UUID) alongside saved_count so we can look up vote aggregates.
    // Drop the saved_count > 0 filter — a place with 0 saves may still have votes.
    const { data } = await sc
      .from("discovery_places")
      .select("id, osm_id, saved_count")
      .in("osm_id", osmIds);

    if (!data || data.length === 0) return places;

    const rows = data as Array<{ id: string; osm_id: string; saved_count: number }>;

    const countMap = new Map(rows.map((r) => [r.osm_id, r.saved_count]));
    // Map osm_id → discovery_places UUID so we can query place_votes / reviews
    const uuidMap = new Map(rows.map((r) => [r.osm_id, r.id]));

    // Batch-fetch vote + review aggregates keyed by the DB UUID
    const uuids = rows.map((r) => r.id);
    const agg = await batchFetchVoteAndRatingAggregates(sc, uuids, "place");

    return places.map((p) => {
      const count = countMap.get(p.id);
      const uuid = uuidMap.get(p.id);
      const voteAgg = uuid ? agg.get(uuid) : undefined;
      return {
        ...p,
        ...(count != null ? { savedCount: count } : {}),
        ...(voteAgg
          ? { worthItCount: voteAgg.worthItCount, avgRating: voteAgg.avgRating, reviewCount: voteAgg.reviewCount }
          : {}),
      };
    });
  } catch {
    return places;
  }
}

// ── Vote + review aggregate batch enrichment ──────────────────────────────────
//
// Batch-fetches worth-it vote counts and published-review aggregates for a
// list of entity IDs.  entityType is 'place' for community/DB discovery places
// and 'gem' for hidden gems.  Both lookups run in parallel; any failure is
// swallowed so tiles degrade gracefully (no counts rather than an error).

type VoteRatingAgg = { worthItCount: number; avgRating: number | null; reviewCount: number };

async function batchFetchVoteAndRatingAggregates(
  sc: ReturnType<typeof getServiceClient>,
  entityIds: string[],
  entityType: "place" | "gem",
): Promise<Map<string, VoteRatingAgg>> {
  const result = new Map<string, VoteRatingAgg>();
  if (!sc || entityIds.length === 0) return result;

  try {
    const [votesRes, reviewsRes] = await Promise.all([
      sc
        .from("place_votes")
        .select("entity_id, vote")
        .eq("entity_type", entityType)
        .in("entity_id", entityIds),
      sc
        .from("reviews")
        .select("entity_id, rating")
        .eq("entity_type", "place")
        .in("entity_id", entityIds)
        .eq("state", "published"),
    ]);

    for (const row of (votesRes.data ?? []) as any[]) {
      const id = row.entity_id as string;
      if (!result.has(id)) result.set(id, { worthItCount: 0, avgRating: null, reviewCount: 0 });
      if (row.vote === "worth_it") result.get(id)!.worthItCount++;
    }

    const reviewsByEntity = new Map<string, number[]>();
    for (const row of (reviewsRes.data ?? []) as any[]) {
      const id = row.entity_id as string;
      if (!reviewsByEntity.has(id)) reviewsByEntity.set(id, []);
      if (row.rating != null) reviewsByEntity.get(id)!.push(parseFloat(String(row.rating)));
    }
    for (const [id, ratings] of reviewsByEntity) {
      if (!result.has(id)) result.set(id, { worthItCount: 0, avgRating: null, reviewCount: 0 });
      const entry = result.get(id)!;
      entry.reviewCount = ratings.length;
      if (ratings.length > 0) {
        entry.avgRating =
          Math.round((ratings.reduce((s, r) => s + r, 0) / ratings.length) * 10) / 10;
      }
    }
  } catch { /* non-fatal */ }

  return result;
}

// ── Merge + deduplicate ────────────────────────────────────────────────────────
//
// OSM places take precedence. DB places whose normalised name already appears
// in the OSM result are dropped to avoid showing the same venue twice.

/**
 * Dedup key: normalised name PLUS a coarse (~1km) location bucket. Keying on
 * name alone collapsed distinct BRANCHES of a chain (e.g. two "Highlands Coffee"
 * a few km apart) into one. Including a rounded lat/lng keeps branches while a
 * same-name place at the SAME spot (an OSM/DB duplicate of one venue) still
 * dedups. Places with no coordinates fall back to name-only.
 */
function dedupKey(p: DiscoveryPlace): string {
  const name = p.name.toLowerCase().trim();
  if (p.lat == null || p.lng == null) return name;
  return `${name}@${p.lat.toFixed(2)},${p.lng.toFixed(2)}`;
}

function mergeAndDedup(osmPlaces: DiscoveryPlace[], dbPlaces: DiscoveryPlace[]): DiscoveryPlace[] {
  const seen = new Set(osmPlaces.map(dedupKey));
  const uniqueDb = dbPlaces.filter((p) => !seen.has(dedupKey(p)));
  // DB places are interleaved near the top — they are curated so should rank well
  const merged: DiscoveryPlace[] = [];
  let dbIdx = 0;
  for (let i = 0; i < osmPlaces.length; i++) {
    merged.push(osmPlaces[i]!);
    // Interleave one DB place every 4 OSM places so traveler picks surface early
    if ((i + 1) % 4 === 0 && dbIdx < uniqueDb.length) {
      merged.push(uniqueDb[dbIdx++]!);
    }
  }
  // Append any remaining DB places after OSM results
  while (dbIdx < uniqueDb.length) {
    merged.push(uniqueDb[dbIdx++]!);
  }
  return merged;
}

// ── Composite ranking ─────────────────────────────────────────────────────────
//
// When a DiscoveryContext is present (authenticated caller), re-sort places
// using a weighted composite score so that:
//   - Verified/trusted places (from GeoZoneService) are boosted
//   - Distance weight is dialled per mode (near_me → high, in_city → low)
//   - Trip/vibe context elevates relevant categories
//   - Safety-score weight lifts well-tagged places for safe_nearby mode
//
// PRIVACY: no exact coords are used in scoring. Distance is expressed in km
// from the OSM element centre (already computed by queryOverpass).

const MAX_DISTANCE_KM = 20; // distance normalisation ceiling

function scoreWithContext(places: DiscoveryPlace[], ctx: DiscoveryContext): DiscoveryPlace[] {
  const w = ctx.weights;
  const verifiedSet = new Set(ctx.verifiedPlaceIds);

  function score(p: DiscoveryPlace): number {
    let s = 0;

    // Distance factor (inverted — closer = higher score)
    if (w.distance > 0 && p.distanceKm != null) {
      const distFactor = Math.max(0, 1 - p.distanceKm / MAX_DISTANCE_KM);
      s += w.distance * distFactor;
    }

    // Verified places boost — from GeoZoneService (curated, trust-reviewed)
    if (w.verifiedPlaces > 0 && verifiedSet.has(p.id)) {
      s += w.verifiedPlaces;
    }

    // Rating signal — boosts well-reviewed places slightly (consistent across modes)
    if (p.rating != null && p.rating > 0) {
      s += 0.15 * (p.rating / 5);
    }

    // City match — all results are already in the city, constant contribution
    s += w.cityMatch * 0.4;

    // Trip match boost — adds lift when going_soon context is active
    if (w.tripMatch > 0) {
      s += w.tripMatch * 0.3;
    }

    // Safety signal — prefer places with structured opening hours (proxy for legitimacy)
    if (w.safetyScore > 0 && p.openingHours) {
      s += w.safetyScore * 0.2;
    }

    // Vibe match — currently a constant lift per mode (trip / vibe data not local)
    if (w.vibeMatch > 0) {
      s += w.vibeMatch * 0.2;
    }

    return s;
  }

  return [...places].sort((a, b) => score(b) - score(a));
}

// ── Route ─────────────────────────────────────────────────────────────────────

const VALID_CATEGORIES = ["for_you", "places", "food", "nightlife", "activities", "events", "beaches", "transport"];
const VALID_CONTEXT_MODES = ["near_me", "in_city", "going_soon", "around_crew", "safe_nearby"];

// OSM venue types considered adult-only (require 18+). Used to filter results
// for callers whose effective age resolves to under 18.
const ADULT_OSM_VENUE_TYPES = new Set([
  "nightclub", "casino", "stripclub", "adult_gaming_centre",
  "brothel", "swingerclub", "bar", "pub",
]);

/**
 * Context mode labels returned to the client. Never includes exact coords.
 */
function contextModeLabel(mode: string, city: string | null): string {
  switch (mode) {
    case "near_me":      return "Near me";
    case "in_city":      return city ? `In ${city}` : "In this city";
    case "going_soon":   return city ? `Going to ${city}` : "Going soon";
    case "around_crew":  return "Around my crew";
    case "safe_nearby":  return "Safe nearby";
    default:             return city ? `In ${city}` : "Discovery";
  }
}

router.get("/discovery", async (req, res) => {
  const t0 = Date.now(); // ← Step-1 instrumentation; used in timings throughout handler.
  const destinationParam = (req.query.destination as string | undefined)?.trim() || undefined;
  const latParam  = req.query.lat  ? parseFloat(req.query.lat  as string) : null;
  const lngParam  = req.query.lng  ? parseFloat(req.query.lng  as string) : null;
  const clientCoords =
    latParam != null && !isNaN(latParam) && lngParam != null && !isNaN(lngParam)
      ? { lat: latParam, lng: lngParam }
      : null;

  // User's actual GPS position — used ONLY to recompute distanceKm for nearest sort.
  // Never used as the Overpass query centre or for geocoding; that always uses the
  // destination coordinates so cache keys and result sets stay destination-scoped.
  const userLatParam = req.query.userLat ? parseFloat(req.query.userLat as string) : null;
  const userLngParam = req.query.userLng ? parseFloat(req.query.userLng as string) : null;
  const userCoords =
    userLatParam != null && !isNaN(userLatParam) && userLngParam != null && !isNaN(userLngParam)
      ? { lat: userLatParam, lng: userLngParam }
      : null;

  // Optional auth — enrich with DiscoveryLocationContext when present.
  // When authenticated + no destination param, we use discoveryCtx.targetCity as
  // the effective destination so context-driven modes (near_me/going_soon) work
  // without requiring the client to geocode first.
  let discoveryCtx: DiscoveryContext | null = null;
  let callerUserId: string | null = null;

  const authHeader = req.headers.authorization;
  const _authSc = getServiceClient();
  if (authHeader?.startsWith("Bearer ") && _authSc) {
    try {
      const token = authHeader.slice(7).trim();
      const sc = _authSc;
      const { data: authData } = await sc.auth.getUser(token);
      if (authData?.user) {
        callerUserId = authData.user.id;
        const rawMode = (req.query.context as string | undefined) ?? "";
        const mode: DiscoveryContextMode = VALID_CONTEXT_MODES.includes(rawMode)
          ? (rawMode as DiscoveryContextMode)
          : "in_city";

        const [prefs, locState] = await Promise.all([
          loadPreferences(sc, authData.user.id),
          sc.from("user_location_state")
            .select("city, country, lat, lng")
            .eq("user_id", authData.user.id)
            .maybeSingle(),
        ]);

        const currentCity    = (locState.data as any)?.city ?? null;
        const currentCountry = (locState.data as any)?.country ?? null;

        discoveryCtx = await buildDiscoveryContext({
          db: sc, userId: authData.user.id, prefs, mode,
          currentCity, currentCountry,
        });
      }
    } catch { /* degrade — non-fatal */ }
  }

  // Resolve effective destination: explicit query param takes priority; fall back
  // to DiscoveryContext.targetCity so context-driven modes work without client geocoding.
  const destination = destinationParam ?? discoveryCtx?.targetCity ?? undefined;
  if (!destination) {
    res.status(400).json({ error: "invalid_payload", message: "destination is required" });
    return;
  }

  // Context mode: near_me | in_city | going_soon | around_crew | safe_nearby
  const contextMode = VALID_CONTEXT_MODES.includes(req.query.context as string)
    ? (req.query.context as string)
    : null;

  // Adjust radius based on context mode (DiscoveryContext overrides when available)
  const defaultRadius = discoveryCtx?.radiusKm ?? (
    contextMode === "near_me" ? 5
    : contextMode === "safe_nearby" ? 3
    : contextMode === "going_soon" ? 15
    : 10
  );

  const category  = VALID_CATEGORIES.includes(req.query.category as string)
    ? (req.query.category as string)
    : "for_you";
  const radiusKm  = Math.max(1, Math.min(100, parseFloat(req.query.radiusKm as string) || defaultRadius));
  const page      = Math.max(1, parseInt(req.query.page as string) || 1);
  const radiusM   = Math.round(radiusKm * 1000);
  const openNow   = req.query.openNow === "1";
  const minRating = req.query.minRating ? parseFloat(req.query.minRating as string) : null;
  const sortBy    = req.query.sortBy === "rating" ? "rating"
    : req.query.sortBy === "popular" ? "popular"
    : req.query.sortBy === "nearest" ? "nearest"
    : null;

  // ── Age filter params ──────────────────────────────────────────────────────
  const VALID_AGE_FILTERS = ["any", "open_to_me", "18_plus", "21_plus", "under_30", "30_plus", "custom"] as const;
  type AgeFilterType = typeof VALID_AGE_FILTERS[number];
  const rawAgeFilter = req.query.ageFilter as string | undefined;
  const ageFilter: AgeFilterType = VALID_AGE_FILTERS.includes(rawAgeFilter as any)
    ? (rawAgeFilter as AgeFilterType)
    : "any";
  const customMinAge = req.query.customMinAge ? parseInt(req.query.customMinAge as string) : null;
  const customMaxAge = req.query.customMaxAge ? parseInt(req.query.customMaxAge as string) : null;

  // Resolve caller age when ageFilter = open_to_me
  let callerAge: number | null = null;
  let callerDobMissing = false;
  if (ageFilter === "open_to_me" && callerUserId) {
    const sc = getServiceClient();
    if (sc) {
      const { data: profileRow } = await sc
        .from("profiles")
        .select("date_of_birth")
        .eq("id", callerUserId)
        .maybeSingle();
      const dob = (profileRow as any)?.date_of_birth ?? null;
      callerAge = calculateUserAge(dob);
      if (callerAge === null) callerDobMissing = true;
    }
  }

  /** Derive effective min/max age from the chosen filter preset */
  function ageFilterBounds(): { min: number | null; max: number | null } | null {
    switch (ageFilter) {
      case "any":        return null;
      case "18_plus":    return { min: 18, max: null };
      case "21_plus":    return { min: 21, max: null };
      case "under_30":   return { min: null, max: 29 };
      case "30_plus":    return { min: 30, max: null };
      case "custom":     return { min: customMinAge, max: customMaxAge };
      case "open_to_me": return callerAge !== null ? { min: callerAge, max: callerAge } : null;
      default:           return null;
    }
  }

  const key    = cacheKey(destination, category, radiusKm);
  const cached = cache.get(key);

  // ── DISCOVERY_ENGINE_MODE dispatch ─────────────────────────────────────────
  //
  // THIS IS THE BRANCH POINT, AND ITS POSITION IS THE WHOLE DESIGN.
  //
  // It sits above the Cache A check at :1113 — which returns before the Compass
  // block at :1211 — because Cache A and Cache B are in SERIES, not parallel.
  // Cache A's key is user-independent, and on a cold fetch the raw pre-ranking
  // list is written to it (:1204) while the ranked output goes only to the
  // requesting user's Cache B entry (:1263). The consequence is that for a given
  // (destination, category, radius) the ranker runs at most once per 2 h and its
  // output reaches exactly one user.
  //
  // A mode resolved BELOW :1113 could therefore only ever claim the small
  // minority of requests that miss the cache — which is precisely the failure
  // the owner directive names: comparing rankers on traffic that reaches neither.
  //
  // Stage 1 resolves the mode and records it. It does not branch on it: every
  // mode reaches the legacy path below by FALLING THROUGH this code, never by a
  // copy of it (mechanic M2). The shadow and pde branches land HERE, at this
  // point, in later stages. Nothing below this line changes in legacy mode, and
  // Stage 1's exit criterion is exactly that: byte-identical responses and an
  // unchanged serve-point distribution.
  const engineMode = await resolveDiscoveryEngineMode(getServiceClient());
  /** Apply openNow / minRating / age filters to a set of places */
  function applyFilters(raw: DiscoveryPlace[]): DiscoveryPlace[] {
    let list = raw;
    if (openNow) {
      list = list.filter((p) => {
        if (p.isOpenNow === null) return true; // no data → optimistic include
        return p.isOpenNow === true;
      });
    }
    if (minRating !== null && Number.isFinite(minRating)) {
      list = list.filter((p) => {
        if (p.rating === null) return true; // no rating data → include
        return p.rating >= minRating!;
      });
    }
    // Age-based category filter: OSM venues don't store explicit age limits, so
    // we proxy by known adult-only venue types. Filter them out only when the
    // effective caller age resolves to < 18 (e.g. open_to_me for a minor, or
    // custom range capped below 18).
    const ageBounds = ageFilterBounds();
    if (ageBounds !== null) {
      const effectiveMin = ageBounds.min ?? (ageBounds.max !== null && ageBounds.max < 18 ? ageBounds.max : null);
      if (effectiveMin !== null && effectiveMin < 18) {
        list = list.filter((p) => !ADULT_OSM_VENUE_TYPES.has((p.category ?? "").toLowerCase()));
      }
    }
    if (sortBy === "rating") {
      list = [...list].sort((a, b) => {
        const ra = a.rating ?? -1;
        const rb = b.rating ?? -1;
        return rb - ra;
      });
    }
    if (sortBy === "popular") {
      list = [...list].sort((a, b) => {
        const savedDiff = (b.savedCount ?? 0) - (a.savedCount ?? 0);
        if (savedDiff !== 0) return savedDiff;
        // For OSM places (and any place where savedCount is equal), use rating
        // as a secondary popularity proxy so higher-rated venues surface first.
        return (b.rating ?? 0) - (a.rating ?? 0);
      });
    }
    if (sortBy === "nearest") {
      list = [...list].sort((a, b) => (a.distanceKm ?? 99999) - (b.distanceKm ?? 99999));
    }
    return list;
  }

  const cityLabel = destination.split(",")[0]?.trim() ?? null;
  // discoveryCtx.label (from DiscoveryLocationContext) takes precedence over generic label
  const ctxLabel  = discoveryCtx?.label ?? (contextMode ? contextModeLabel(contextMode, cityLabel) : null);

  const ageFilterMeta = {
    ageFilter,
    callerDobMissing: ageFilter === "open_to_me" ? callerDobMissing : false,
    bounds: ageFilterBounds(),
  };

  // ── Cache lookup helper ────────────────────────────────────────────────────
  // Shared by L1 (in-memory) and L2 (Postgres) hit paths.  OSM places are
  // served from cache; community DB places are always re-queried (they change
  // more often and are not part of the OSM cache key).
  async function serveCachedPlaces(osmPlaces: DiscoveryPlace[], cacheLevel: string): Promise<void> {
    const distRef = userCoords ?? clientCoords;
    // destination! — narrowed by the guard above; TypeScript can't see it through the closure.
    const dbPlaces = await loadCuratedAndCanonicalPlaces(destination!, category, distRef?.lat ?? null, distRef?.lng ?? null);
    const osmWithDist = sortBy === "nearest" && distRef
      ? osmPlaces.map((p) =>
          p.lat != null && p.lng != null
            ? { ...p, distanceKm: Math.round(haversineKm(distRef.lat, distRef.lng, p.lat, p.lng) * 10) / 10 }
            : p,
        )
      : osmPlaces;
    const merged   = mergeAndDedup(osmWithDist, dbPlaces);
    const filtered = applyFilters(merged);
    const slice    = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(toPublic);
    const totalMs  = Date.now() - t0;
    req.log.info({ cacheLevel, destination, category, totalMs }, "discovery: cache hit");
    res.json({
      places: slice, total: filtered.length, destination, context: ctxLabel, cached: true, ageFilterMeta,
      sourceSummary: { seededDbCount: dbPlaces.length, osmCount: osmPlaces.length, userCreatedCount: 0 },
      meta: { cacheLevel, timings: { totalMs } },
    });
    // Stage 0 instrumentation — serve points 1/2/3. Fire-and-forget, after the
    // response. These three paths ran no ranker; before this they wrote nothing
    // at all, which is why the 'discovery' surface had no rows.
    if (callerUserId) {
      const servePoint =
        cacheLevel === "L1"       ? DiscoveryServePoint.CACHE_A_L1 :
        cacheLevel === "L2_fresh" ? DiscoveryServePoint.CACHE_A_L2_FRESH :
                                    DiscoveryServePoint.CACHE_A_L2_STALE;
      void logDiscoveryServe(getServiceClient(), {
        userId: callerUserId, servePoint, items: slice,
        context: {
          destination: destination!, category, cacheLevel,
          engineMode: engineMode.mode, modeReason: engineMode.reason,
        },
      });

      // ── Stage 2 shadow — observe only, after the response has left ─────────
      //
      // THIS IS THE POINT THE WHOLE PACKET IS ABOUT. The user has already been
      // served, from cache, WITHOUT ANY RANKER HAVING RUN. PDE now ranks the
      // same candidates for this same viewer, and both pages are recorded.
      //
      // A divergence row from here says something no other measurement in this
      // system can say: not "two rankers disagree" but "one user's cold fetch
      // is still deciding what a different user sees, two hours later".
      //
      // Three properties, each load-bearing:
      //   - it runs after res.json(), so it cannot affect what was served;
      //   - `served: false` hands PDE a client that cannot write, so nothing
      //     downstream — DiscoveryRankingService included — can put a row in
      //     rank_events for a page nobody saw;
      //   - it is gated on mode === "shadow", so in legacy mode (today) not one
      //     line of it executes.
      // D6 cohort gate. `shadow` alone is not enough: the mode says WHAT, the
      // cohort says WHO, and without the second the first means everybody.
      // Operator ruling 2026-08-15 — shadow must not be enabled for any traffic
      // until this gate exists. Fail-closed: an absent or unreadable cohort
      // includes nobody, so a misconfiguration costs zero shadow runs rather
      // than shadowing the entire surface.
      const shadowCohort = engineMode.mode === "shadow"
        ? isInDiscoveryCohort(engineMode.cohort, callerUserId)
        : null;
      if (shadowCohort?.included) {
        void (async () => {
          try {
            const shadowSc  = getServiceClient();
            const shadowT0  = Date.now();
            const pdeViewer = await loadPdeViewer(
              shadowSc, callerUserId, destination!.split(",")[0]?.trim().toLowerCase() ?? null,
            );
            const outcome = await rankForViewer(merged, pdeViewer, { sc: shadowSc, served: false });
            // Same filters, same page window. Comparing a ranked full list
            // against a filtered page would report divergence that filtering
            // caused and ranking did not.
            const pdeFiltered = applyFilters(outcome.ranked);
            const pdeSlice    = pdeFiltered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
            await logDiscoveryShadowServe(shadowSc, {
              userId: callerUserId,
              destination: destination!, category, radiusKm, page, pageSize: PAGE_SIZE, sortBy,
              servePoint, cacheLevel,
              legacyIds:   slice.map((p) => p.id),
              legacyTotal: filtered.length,
              legacyMs:    totalMs,
              pdeIds:      pdeSlice.map((p) => p.id),
              pdeTotal:    pdeFiltered.length,
              pdeMs:       Date.now() - shadowT0,
              pdeStages:   outcome.stages as unknown as Record<string, unknown>,
              pdeSuppressedWrites: outcome.stages.suppressedWrites,
              engineMode:  engineMode.mode,
              modeReason:  engineMode.reason,
              cohortReason: shadowCohort.reason,
              cohortBucket: shadowCohort.bucket ?? null,
            });
          } catch (err) {
            req.log.warn({ err }, "discovery: shadow observation failed — the response was unaffected");
          }
        })();
      }
    }
  }

  // ── L1: in-process memory (fastest — zero network) ─────────────────────────
  if (cached && isFresh(cached)) {
    await serveCachedPlaces(cached.places, "L1");
    return;
  }

  // ── L2: Postgres (survives restarts; stale-while-revalidate) ───────────────
  //
  // Fresh L2 entry → serve immediately (only DB places query, not Overpass).
  // Stale L2 entry → respond immediately with last-known data while a background
  //   goroutine re-fetches from Nominatim + Overpass and updates both caches.
  //   This eliminates cold-start blocking after a deploy or autoscale event.
  const dbCacheEntry = await readPlacesFromDb(key);
  if (dbCacheEntry) {
    // Populate L1 so the next in-process request skips the DB round-trip.
    cache.set(key, { places: dbCacheEntry.entry.places as DiscoveryPlace[], cachedAt: dbCacheEntry.entry.cachedAt });

    if (!dbCacheEntry.isStale) {
      await serveCachedPlaces(dbCacheEntry.entry.places as DiscoveryPlace[], "L2_fresh");
      return;
    }

    // Stale: kick off background OSM revalidation, then serve stale data.
    // The background job does NOT block the response — only queryDbPlaces does.
    void (async () => {
      try {
        // Always geocode by destination name (not clientCoords) so the background
        // refresh stores a stable city coordinate with a display name in L2.
        const freshCoords = await geocodeCached(destination!);
        if (!freshCoords) return;
        const freshOsm = await queryOverpass(freshCoords.lat, freshCoords.lng, radiusM, category);
        const enriched  = freshOsm.length > 0 ? await enrichOsmSavedCounts(freshOsm) : freshOsm;
        if (enriched.length > 0) {
          cache.set(key, { places: enriched, cachedAt: Date.now() });
          void writePlacesToDb(key, destination!, category, radiusKm, enriched, freshCoords);
        }
      } catch { /* non-fatal background revalidation */ }
    })();

    await serveCachedPlaces(dbCacheEntry.entry.places as DiscoveryPlace[], "L2_stale");
    return;
  }

  // ── Cache miss: full pipeline (Nominatim → Overpass → DB) ──────────────────
  try {
    const geocodeT0 = Date.now();
    const coords = clientCoords ?? await geocodeCached(destination);
    const geocodeMs = clientCoords ? 0 : Date.now() - geocodeT0;
    if (!coords) {
      res.json({ places: [], total: 0, destination, context: ctxLabel, cached: false, ageFilterMeta,
        sourceSummary: { seededDbCount: 0, osmCount: 0, userCreatedCount: 0 } });
      return;
    }

    // Query OSM and DB in parallel for speed.
    // DB distance computation uses userCoords when available so that nearest
    // sort measures from the user's actual position. OSM always queries from
    // the destination centre — this is what gets cached and must not use user coords.
    const distRef = userCoords ?? coords;
    const osmT0 = Date.now();
    const [osmPlaces, dbPlaces] = await Promise.all([
      queryOverpass(coords.lat, coords.lng, radiusM, category),
      loadCuratedAndCanonicalPlaces(destination, category, distRef.lat, distRef.lng),
    ]);
    const osmMs = Date.now() - osmT0;

    // Enrich OSM places with real save counts from discovery_places before
    // merging and caching.  A single batch SELECT by osm_id attaches savedCount
    // to any place saved by at least one user so the popular sort can order OSM
    // results by real traveler demand instead of relying solely on the OSM rating
    // field.  Enrichment runs before the cache write so subsequent cache-hit
    // requests get the counts without an extra round trip (counts are at most
    // 2 hours stale, which is acceptable for a popularity signal).
    const enrichedOsm = osmPlaces.length > 0
      ? await enrichOsmSavedCounts(osmPlaces)
      : osmPlaces;

    // When sortBy=nearest, recompute OSM place distances from the user's position
    // (OSM query ran from destination centre; cached entry will too on next request).
    const osmForMerge = sortBy === "nearest" && userCoords
      ? enrichedOsm.map((p) =>
          p.lat != null && p.lng != null
            ? { ...p, distanceKm: Math.round(haversineKm(userCoords.lat, userCoords.lng, p.lat, p.lng) * 10) / 10 }
            : p,
        )
      : enrichedOsm;

    const places = mergeAndDedup(osmForMerge, dbPlaces);

    // Only cache when we have results — avoids locking out a destination for
    // 2 hours if Overpass timed out or returned nothing transiently.
    if (enrichedOsm.length > 0) {
      cache.set(key, { places: enrichedOsm, cachedAt: Date.now() });
      // L2 write (fire-and-forget) — persists across restarts for warm cold starts.
      void writePlacesToDb(key, destination!, category, radiusKm, enrichedOsm, coords);
    }

    // COMPASS_V1_RULE_BASED_ENABLED: for for_you tab, use Compass pipeline scoring
    // instead of the rule-based scoreWithContext to rank OSM places.
    if (category === "for_you" && callerUserId) {
      const compassSc = getServiceClient();
      if (compassSc) {
        try {
          const compassFlagOn = await isEnabled(compassSc, "COMPASS_V1_RULE_BASED_ENABLED");
          if (compassFlagOn) {
            // ── Candidate cache hit — skip expensive scoring pipeline ──────
            // Skip cache entirely for nearest sort — results depend on user
            // position which changes continuously, so a TTL-keyed entry would
            // return stale ordering with incorrect distances.
            const cCacheKey = compassCandidateCacheKey(callerUserId, destination, radiusKm, sortBy);
            const skipCache = sortBy === "nearest";
            const cCacheHit = skipCache ? undefined : _compassCandidateCache.get(cCacheKey);
            if (cCacheHit && Date.now() - cCacheHit.at < COMPASS_CANDIDATE_CACHE_TTL_MS) {
              const cFiltered = applyFilters(cCacheHit.places);
              const cSlice = cFiltered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(toPublic);
              req.log.info({ destination, cacheLevel: "compass_candidate_hit" }, "discovery: compass candidate cache hit");
              res.json({ places: cSlice, total: cFiltered.length, destination, context: ctxLabel, cached: true, ageFilterMeta,
                sourceSummary: { seededDbCount: dbPlaces.length, osmCount: osmPlaces.length, userCreatedCount: 0 } });
              // Stage 0 — serve point 4. Replays a stored Compass order; no
              // ranker ran in this request, so rankedInRequest is false.
              void logDiscoveryServe(compassSc, {
                userId: callerUserId, servePoint: DiscoveryServePoint.CACHE_B_HIT, items: cSlice,
                context: {
                  destination, category, cacheLevel: "compass_candidate_hit",
                  engineMode: engineMode.mode, modeReason: engineMode.reason,
                },
              });
              return;
            }

            const compassProfile = await getCompassProfile(compassSc, callerUserId);
            const localHour = localHourFor(nowUtcInstant(), null, await fetchUserTimezone(compassSc, callerUserId));
            const compassContext = buildCompassContext(compassProfile, defaultSignals(compassProfile, localHour));
            const compassItems   = places.map(discoveryPlaceToCompassItem);

            // Use the full feed-intelligence stack (pipeline + active-user
            // reward boosts + fair exposure) to rank ALL candidate items.
            // rankItemsForDiscovery returns a flat sorted list with no page-
            // size limit so discovery applies its own pagination below.
            const scored = await rankItemsForDiscovery(
              compassItems, compassProfile, compassContext, compassSc,
            );

            // Build lookup so we can restore all original DiscoveryPlace fields
            const placeById = new Map(places.map((p) => [p.id, p]));
            const compassRanked: DiscoveryPlace[] = scored.map((r) => {
              const originalId = r.item.id.replace(/^discovery:/, "");
              return placeById.get(originalId) ?? {
                id: originalId, name: String(r.item.contentBody ?? ""),
                category: (r.item.interestTags ?? [])[0] ?? "places",
                type: null, description: null, distanceKm: null,
                lat: null, lng: null, tags: [], address: null,
                website: null, phone: null, openingHours: null,
                rating: null, isOpenNow: null,
              };
            });
            // Store scored candidates in cache before paginating so subsequent
            // requests within the TTL skip the full scoring pipeline.
            // Skip storage for nearest sort — position-dependent results must not be cached.
            if (!skipCache) {
              _compassCandidateCache.set(cCacheKey, { places: compassRanked, at: Date.now() });
            }
            // Compass is authoritative: blocked/rejected items are excluded.
            // Only pipeline-passed items appear when the flag is enabled.
            const merged = compassRanked;
            const cFiltered  = applyFilters(merged);
            const cSlice     = cFiltered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(toPublic);
            res.json({ places: cSlice, total: cFiltered.length, destination, context: ctxLabel, cached: false, ageFilterMeta,
              sourceSummary: { seededDbCount: dbPlaces.length, osmCount: osmPlaces.length, userCreatedCount: 0 } });
            // Stage 0 — serve point 5. The Compass ranker DID run here, but
            // this path has never written a rank_events row: it returns before
            // the logImpression call on the cold path below.
            void logDiscoveryServe(compassSc, {
              userId: callerUserId, servePoint: DiscoveryServePoint.COMPASS_FRESH_RANK, items: cSlice,
              context: {
                destination, category, cacheLevel: "compass_fresh_rank",
                engineMode: engineMode.mode, modeReason: engineMode.reason,
              },
            });
            return;
          }
        } catch { /* fall through to normal rule-based path */ }
      }
    }

    // ── Authenticated path: PDE ranking (ruling D5=B, ranking half) ──────────
    // The portavaRank + DiscoveryRankingService pipeline that used to live
    // inline here now lives in lib/discoveryPde.ts and is called from here. It
    // was MOVED, not copied (mechanic M2): there must be exactly one ranking
    // pipeline in the tree, or the shadow comparison this engine exists to feed
    // would be measuring drift between two implementations rather than the
    // reach of one.
    //
    // Nothing about this request changes. Same ranker, same inputs, same order,
    // same rank_events writes — served is true because this IS the serve path
    // and its result is what the user receives.
    //
    // What D5=B adds is not visible from this call site: the same function can
    // now be called over candidates that came from Cache A, on requests that
    // today end inside serveCachedPlaces having never reached a ranker at all.
    // Hoisted so it is accessible after the if/else block for per-page impression logging.
    let scoredByPlaceId = new Map<string, ScoredCandidate<RankCandidate>>();
    let ranked: DiscoveryPlace[];
    if (callerUserId) {
      const rankSc   = getServiceClient();
      const rankCity = destination.split(",")[0]?.trim().toLowerCase() ?? null;
      const pdeViewer = await loadPdeViewer(rankSc, callerUserId, rankCity);
      const outcome   = await rankForViewer(places, pdeViewer, { sc: rankSc, served: true });
      ranked          = outcome.ranked;
      scoredByPlaceId = outcome.scoredById;
    } else {
      // Unauthenticated: keep existing distance/saved-count ordering
      ranked = discoveryCtx ? scoreWithContext(places, discoveryCtx) : places;
    }

    const filtered = applyFilters(ranked);
    const slice = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(toPublic);
    // Log impressions for exactly the items that were served — after filter + page slice.
    if (callerUserId && scoredByPlaceId.size > 0) {
      const servedScored = slice
        .map((p) => scoredByPlaceId.get(p.id))
        .filter((s): s is ScoredCandidate<RankCandidate> => s !== undefined);
      // Stage 0 — serve point 6. This is the ONLY serve point that already
      // wrote a rank_events row; it keeps doing so through logImpression (which
      // carries the real ranking features) and gains only the serve-point
      // marker. It deliberately does NOT also call logDiscoveryServe — that
      // would write a second impression row for every served item.
      void logImpression(servedScored, callerUserId, "discovery", undefined, {
        servePoint:      DiscoveryServePoint.COLD_FETCH_LEGACY_RANK,
        route:           "GET /discovery",
        rankedInRequest: true,
        destination,
        category,
        cacheLevel:      "miss",
        engineMode:      engineMode.mode,
        modeReason:      engineMode.reason,
      });
    }
    const totalMs = Date.now() - t0;
    req.log.info(
      { destination, category, geocodeMs, osmMs, totalMs, cacheLevel: "miss",
        osmCount: osmPlaces.length, dbCount: dbPlaces.length },
      "discovery: cold fetch",
    );
    res.json({ places: slice, total: filtered.length, destination, context: ctxLabel, cached: false, ageFilterMeta,
      sourceSummary: { seededDbCount: dbPlaces.length, osmCount: osmPlaces.length, userCreatedCount: 0 },
      meta: { cacheLevel: "miss", timings: { geocodeMs, osmMs, totalMs } },
    });
  } catch (err) {
    req.log.error({ err }, "discovery route failed");
    res.json({ places: [], total: 0, destination, context: ctxLabel ?? null, cached: false, ageFilterMeta: null,
      sourceSummary: { seededDbCount: 0, osmCount: 0, userCreatedCount: 0 },
      meta: { cacheLevel: "error", timings: { totalMs: Date.now() - t0 } },
    });
  }
});

// ── Unified discovery feed ─────────────────────────────────────────────────────
//
// GET /api/discovery/feed
//
// A single, cursor-paginated endpoint that merges OSM + discovery_places DB
// results and returns the unified envelope expected by the Discovery screen.
//
// Query params:
//   city / destination  string  City name (synonyms)
//   lat / lng           number  Skip geocoding when both provided
//   category            string  Single category (default: for_you)
//   categories          string  Comma-separated multi-category e.g. "food,beaches"
//   radiusKm            number  1–100 (default: 10)
//   limit               number  1–50 (default: 20)
//   cursor              string  Opaque pagination cursor (base64url-encoded offset)
//   includeEvents       0|1     Include events section (default: 1)
//   includePlaces       0|1     Include places section (default: 1)
//
// Response:
//   { places, events, posts, memories, sections, nextCursor, total,
//     destination, context, sourceSummary: { seededDbCount, osmCount, userCreatedCount } }

function encodeOffset(n: number): string {
  return Buffer.from(String(n)).toString("base64url");
}

function decodeOffset(cursor: string): number {
  try { return Math.max(0, parseInt(Buffer.from(cursor, "base64url").toString("utf8"), 10)); }
  catch { return 0; }
}

/**
 * GET /api/discovery/counts
 *
 * Returns result counts for all countable Discovery categories in a single HTTP
 * round-trip.  The server geocodes the destination once (using the dedup cache)
 * and fans out to all categories in parallel — using the per-category in-memory
 * cache wherever possible.
 *
 * Replaces the 7 parallel /api/discovery requests that the client used to fire
 * to populate category-tab badges.
 *
 * Query params:
 *   destination  string  (required)
 *   radiusKm     number  1–100 (default: 10)
 *   lat / lng    number  optional — skip Nominatim when already resolved
 */
const COUNTABLE_CATS = ["places", "food", "nightlife", "activities", "events", "beaches", "transport"] as const;

router.get("/discovery/counts", async (req, res) => {
  const destination = ((req.query.destination as string | undefined) ?? "").trim();
  if (!destination) {
    sendError(res, "invalid_payload", "destination is required");
    return;
  }

  const radiusKm     = Math.max(1, Math.min(100, parseFloat(req.query.radiusKm as string) || 10));
  const latParam     = req.query.lat  ? parseFloat(req.query.lat  as string) : null;
  const lngParam     = req.query.lng  ? parseFloat(req.query.lng  as string) : null;
  const clientCoords =
    latParam != null && !isNaN(latParam) && lngParam != null && !isNaN(lngParam)
      ? { lat: latParam, lng: lngParam }
      : null;

  // Resolve coords — one geocode call with full dedup, or skip if supplied.
  const coords = clientCoords ?? await geocodeCached(destination);
  if (!coords) {
    res.json({ counts: {}, destination, cached: false });
    return;
  }

  const radiusM = Math.round(radiusKm * 1_000);

  try {
    const results = await Promise.allSettled(
      COUNTABLE_CATS.map(async (cat) => {
        const k   = cacheKey(destination, cat, radiusKm);
        const hit = cache.get(k);
        if (hit && isFresh(hit)) {
          // Cache warm — zero network calls needed.
          return { cat, total: hit.places.length };
        }
        // Cache cold — fetch Overpass + DB, then populate cache for subsequent requests.
        const [osmPlaces, dbPlaces] = await Promise.all([
          queryOverpass(coords.lat, coords.lng, radiusM, cat),
          queryDbPlaces(destination, cat, coords.lat, coords.lng),
        ]);
        const enriched = osmPlaces.length > 0 ? await enrichOsmSavedCounts(osmPlaces) : osmPlaces;
        if (enriched.length > 0) cache.set(k, { places: enriched, cachedAt: Date.now() });
        return { cat, total: mergeAndDedup(enriched, dbPlaces).length };
      }),
    );

    const counts: Partial<Record<string, number>> = {};
    for (const r of results) {
      if (r.status === "fulfilled") counts[r.value.cat] = r.value.total;
    }

    res.set("Cache-Control", "public, max-age=300"); // 5-minute browser/CDN cache
    res.json({ counts, destination, cached: true });
  } catch (err) {
    req.log.error({ err }, "discovery/counts failed");
    res.json({ counts: {}, destination, cached: false });
  }
});

router.get("/discovery/feed", async (req, res) => {
  // ── Params ─────────────────────────────────────────────────────────────────
  const cityParam    = ((req.query.city ?? req.query.destination) as string | undefined)?.trim() || undefined;
  const latParam     = req.query.lat ? parseFloat(req.query.lat as string) : null;
  const lngParam     = req.query.lng ? parseFloat(req.query.lng as string) : null;
  const clientCoords =
    latParam != null && !isNaN(latParam) && lngParam != null && !isNaN(lngParam)
      ? { lat: latParam, lng: lngParam }
      : null;

  if (!cityParam && !clientCoords) {
    sendError(res, "invalid_payload", "city or lat+lng is required");
    return;
  }

  const rawCats = (req.query.categories as string | undefined)
    ?.split(",").map((s) => s.trim()).filter((s) => VALID_CATEGORIES.includes(s)) ?? [];
  const singleCat = VALID_CATEGORIES.includes(req.query.category as string)
    ? (req.query.category as string)
    : "for_you";
  const effectiveCats = rawCats.length > 0 ? rawCats : [singleCat];

  const radiusKm     = Math.max(1, Math.min(100, parseFloat(req.query.radiusKm as string) || 10));
  const limit        = Math.max(1, Math.min(50, parseInt(req.query.limit as string) || 20));
  const offset       = req.query.cursor ? decodeOffset(req.query.cursor as string) : 0;
  const includePlaces = req.query.includePlaces !== "0";
  const radiusM      = Math.round(radiusKm * 1000);

  // ── Resolve effective destination ──────────────────────────────────────────
  let destination = cityParam;
  let coords = clientCoords;

  if (!coords) {
    const geo = await geocodeCached(destination!);
    if (!geo) {
      res.json({
        places: [], events: [], posts: [], memories: [], sections: [],
        nextCursor: null, total: 0, destination: destination ?? null, context: null,
        sourceSummary: { seededDbCount: 0, osmCount: 0, userCreatedCount: 0 },
      });
      return;
    }
    coords = { lat: geo.lat, lng: geo.lng };
    if (!destination) destination = geo.display.split(",")[0]?.trim();
  }

  // ── Viewer identity for event-post pipeline ───────────────────────────────
  // Auth header is optional on the feed; block-checking requires a viewer id.
  // When unauthenticated, pass null → fetchEventPostsForDiscovery returns [].
  let viewerId: string | null = null;
  let blockedIds = new Set<string>();
  try {
    const sc = getServiceClient();
    if (sc) {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith("Bearer ")) {
        const token = authHeader.slice(7);
        const { data: userData } = await sc.auth.getUser(token);
        if (userData?.user?.id) {
          viewerId = userData.user.id;
          // Load both directions of the block relationship
          const [{ data: out }, { data: inn }] = await Promise.all([
            sc.from("blocks").select("blocked_id").eq("blocker_id", viewerId),
            sc.from("blocks").select("blocker_id").eq("blocked_id",  viewerId),
          ]);
          for (const r of (out as any[] ?? [])) blockedIds.add(r.blocked_id as string);
          for (const r of (inn as any[] ?? [])) blockedIds.add(r.blocker_id as string);
        }
      }
    }
  } catch { /* fail-open: unresolved viewer still gets places */ }

  // ── Fetch places across all requested categories ───────────────────────────
  try {
    // TODO: denormalize is_event_post flag at write time to avoid per-request join
    const [categoryResults, eventPosts] = await Promise.all([
      Promise.all(
        effectiveCats.map(async (cat) => {
          const [rawOsmPlaces, dbPlaces] = includePlaces
            ? await Promise.all([
                queryOverpass(coords!.lat, coords!.lng, radiusM, cat),
                queryDbPlaces(destination ?? "", cat, coords!.lat, coords!.lng),
              ])
            : [[], [] as DiscoveryPlace[]];
          const osmPlaces = await enrichOsmSavedCounts(rawOsmPlaces);
          return { osmPlaces, dbPlaces, merged: mergeAndDedup(osmPlaces, dbPlaces) };
        }),
      ),
      // Event-post pipeline — only runs when we have a viewer identity for block-checking;
      // returns [] when viewerId is null (unauthenticated request).
      viewerId
        ? fetchEventPostsForDiscovery({
            db:          getServiceClient()!,
            lat:         coords!.lat,
            lng:         coords!.lng,
            city:        destination ?? null,
            radiusKm,
            viewerId,
            blockedIds,
            seenPostIds: new Set<string>(),
          }).catch((_err) => {
            req.log.warn({ _err }, "discovery/feed: event-post fetch failed (non-fatal)");
            return [] as DiscoveryEventPost[];
          })
        : Promise.resolve([] as DiscoveryEventPost[]),
    ]);

    // Flatten, dedup across categories by id
    const seen = new Set<string>();
    const allPlaces: DiscoveryPlace[] = [];
    let totalOsm = 0;
    let totalDb  = 0;
    for (const { osmPlaces, dbPlaces, merged } of categoryResults) {
      totalOsm += osmPlaces.length;
      totalDb  += dbPlaces.length;
      for (const p of merged) {
        if (!seen.has(p.id)) { seen.add(p.id); allPlaces.push(p); }
      }
    }

    const total     = allPlaces.length;
    const slice     = allPlaces.slice(offset, offset + limit).map(toPublic);
    const nextOff   = offset + limit;
    const nextCursor = nextOff < total ? encodeOffset(nextOff) : null;

    res.json({
      places: slice,
      events:   [],
      posts:    eventPosts,
      memories: [],
      sections: [],
      nextCursor,
      total,
      destination: destination ?? null,
      context: null,
      sourceSummary: {
        seededDbCount:    totalDb,
        osmCount:         totalOsm,
        userCreatedCount: eventPosts.length,
      },
    });
    // Stage 0b — serve point 7. This route ranks nothing and caches nothing;
    // it is instrumented because the baseline must describe everything users
    // receive (D4=C), not only what the flag governs (D4=A). Both the places
    // page and the event posts are served, so both are logged.
    if (viewerId) {
      void logDiscoveryServe(getServiceClient(), {
        userId: viewerId,
        servePoint: DiscoveryServePoint.FEED,
        route: "GET /discovery/feed",
        items: [
          ...slice.map((p) => ({ id: p.id })),
          ...eventPosts.map((p: DiscoveryEventPost) => ({ id: String((p as any).id), kind: "post" as const })),
        ],
        context: { destination: destination ?? "", categories: effectiveCats.join(","), offset },
      });
    }
  } catch (err) {
    req.log.error({ err }, "discovery/feed failed");
    res.json({
      places: [], events: [], posts: [], memories: [], sections: [],
      nextCursor: null, total: 0, destination: destination ?? null, context: null,
      sourceSummary: { seededDbCount: 0, osmCount: 0, userCreatedCount: 0 },
    });
  }
});

// ── Community discovery route ──────────────────────────────────────────────────
//
// GET /api/discovery/community?city=Cebu[&type=hidden_gem|traveler_pick|all][&limit=20]
//
// Queries the `discovery_places` table and joins `profiles` to resolve
// submitted_by → { id, name, avatarUrl } so HighlightRing can fire on real UUIDs.
// No auth required — all community places are publicly readable.

export interface CommunityDiscoveryItem {
  id: string;
  city: string;
  name: string;
  placeType: "hidden_gem" | "traveler_pick";
  category: string;
  neighborhood: string | null;
  blurb: string | null;
  imageUrl: string | null;
  submittedBy: { id: string; name: string; avatarUrl: string | null } | null;
  savedCount: number;
  tag: string | null;
  note: string | null;
  rating: number | null;
  source: string;
  status: string;
  verified: boolean;
  createdAt: string;
  lat: number | null;
  lng: number | null;
  /** Community "Worth It" vote count — populated by the listing API. */
  worthItCount?: number | null;
  /** Average community review rating — populated by the listing API. */
  avgRating?: number | null;
  /** Number of community reviews — populated by the listing API. */
  reviewCount?: number | null;
}

const VALID_PLACE_TYPES = new Set(["hidden_gem", "traveler_pick", "all"]);

router.get("/discovery/community", async (req, res) => {
  const city = (req.query.city as string | undefined)?.trim();
  if (!city) {
    sendError(res, "invalid_payload", "city is required");
    return;
  }

  if (!getServiceClient()) {
    res.json({ items: [], city, total: 0 });
    return;
  }

  // Accept place_type (canonical) or type (backward-compatible alias)
  const rawType  = (req.query.place_type ?? req.query.type) as string | undefined;
  const typeFilter = VALID_PLACE_TYPES.has(rawType ?? "") ? rawType! : "all";
  const limit    = Math.max(1, Math.min(100, parseInt(req.query.limit as string) || 20));
  const sortBy   = (req.query.sortBy as string | undefined) === "rating" ? "rating"
    : (req.query.sortBy as string | undefined) === "popular" ? "popular"
    : null;

  // Age filter params for community discovery
  const VALID_AGE_FILTERS_COMM = ["any", "open_to_me", "18_plus", "21_plus", "under_30", "30_plus", "custom"] as const;
  const rawAgeFilter = req.query.ageFilter as string | undefined;
  const ageFilterComm = VALID_AGE_FILTERS_COMM.includes(rawAgeFilter as any)
    ? (rawAgeFilter as typeof VALID_AGE_FILTERS_COMM[number])
    : "any";
  const customMinAge = req.query.customMinAge ? parseInt(req.query.customMinAge as string) : null;
  const customMaxAge = req.query.customMaxAge ? parseInt(req.query.customMaxAge as string) : null;

  // Optional auth — needed only for open_to_me to resolve caller DOB
  let commCallerAge: number | null = null;
  let commCallerDobMissing = false;
  if (ageFilterComm === "open_to_me") {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const sc = getServiceClient();
      if (sc) {
        try {
          const token = authHeader.slice(7).trim();
          const { data: authData } = await sc.auth.getUser(token);
          if (authData?.user) {
            const { data: profileRow } = await sc
              .from("profiles")
              .select("date_of_birth")
              .eq("id", authData.user.id)
              .maybeSingle();
            const dob = (profileRow as any)?.date_of_birth ?? null;
            commCallerAge = calculateUserAge(dob);
          }
        } catch { /* degrade gracefully */ }
      }
    }
    if (commCallerAge === null) commCallerDobMissing = true;
  }

  function communityAgeBounds(): { min: number | null; max: number | null } | null {
    switch (ageFilterComm) {
      case "any":        return null;
      case "18_plus":    return { min: 18, max: null };
      case "21_plus":    return { min: 21, max: null };
      case "under_30":   return { min: null, max: 29 };
      case "30_plus":    return { min: 30, max: null };
      case "custom":     return (customMinAge !== null || customMaxAge !== null)
                           ? { min: customMinAge, max: customMaxAge }
                           : null;
      case "open_to_me": return commCallerAge !== null
                           ? { min: commCallerAge, max: commCallerAge }
                           : null;
      default:           return null;
    }
  }

  try {
    const sc = getServiceClient()!;

    let query = sc
      .from("discovery_places")
      .select(`
        id,
        city,
        name,
        place_type,
        category,
        neighborhood,
        blurb,
        image_url,
        submitted_by,
        saved_count,
        tag,
        note,
        rating,
        source,
        status,
        verified,
        created_at,
        lat,
        lng,
        profiles:submitted_by!left ( id, name, avatar_url, username )
      `)
      .ilike("city", city.trim())
      .eq("status", "active")
      .order(sortBy === "rating" ? "rating" : sortBy === "popular" ? "saved_count" : "created_at", { ascending: false, nullsFirst: false });

    // Secondary tiebreaker: when primary scores are tied or all NULL (e.g. a city
    // with no saves yet on popular sort), fall back to newest-first so the ordering
    // is deterministic and never silently reverts to arbitrary DB natural order.
    if (sortBy === "popular" || sortBy === "rating") {
      query = query.order("created_at", { ascending: false });
    }

    query = query.limit(limit);

    if (typeFilter !== "all") {
      query = query.eq("place_type", typeFilter);
    }

    // Age filtering: show only places accessible to the effective caller age.
    // Interpretation: a place is accessible to someone of age X when
    //   min_age IS NULL OR min_age <= X  (place doesn't require more than X years)
    //   max_age IS NULL OR max_age >= X  (place doesn't cap at below X years)
    const ageBoundsComm = communityAgeBounds();
    if (ageBoundsComm) {
      if (ageBoundsComm.min !== null) {
        query = query.or(`min_age.is.null,min_age.lte.${ageBoundsComm.min}`);
      }
      if (ageBoundsComm.max !== null) {
        query = query.or(`max_age.is.null,max_age.gte.${ageBoundsComm.max}`);
      }
    }

    const { data, error } = await query;

    if (error) {
      req.log.error({ err: error }, "discovery/community query failed");
      res.json({ items: [], city, total: 0 });
      return;
    }

    // Universal display-name rule: submitter names show @handle unless opted in.
    const allowedSubmitterNames = await nameVisibilitySet(
      getServiceClient(),
      (data ?? []).map((r: any) => r.submitted_by).filter(Boolean),
    );

    const items: CommunityDiscoveryItem[] = (data ?? []).map((row: any) => {
      const profile = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
      return {
        id:           row.id,
        city:         row.city,
        name:         row.name,
        placeType:    (row.place_type ?? "hidden_gem") as "hidden_gem" | "traveler_pick",
        category:     row.category ?? "hidden_gem",
        neighborhood: row.neighborhood ?? null,
        blurb:        row.blurb ?? null,
        imageUrl:     row.image_url ?? null,
        submittedBy:  profile
          ? {
              id:        profile.id as string,
              name:      (allowedSubmitterNames.has(profile.id as string)
                ? (profile.name ?? "Traveler")
                : (profile.username ? `@${profile.username}` : "Traveler")) as string,
              avatarUrl: (profile.avatar_url ?? null) as string | null,
              handle:    (profile.username ?? null) as string | null,
            }
          : null,
        savedCount: (row.saved_count as number) ?? 0,
        // `tag` doubles as an internal OSM dedup key on seeded rows
        // (e.g. "osm:node/4089438971" — see scripts/seed-discovery-places.ts)
        // and must never reach the client as a display label. Fall back to a
        // humanized category so seeded Traveler Picks still show a real chip.
        tag:       isInternalTag(row.tag) ? humanizeCategory(row.category) : (row.tag ?? null),
        note:      row.note ?? null,
        rating:    row.rating != null ? parseFloat(row.rating) : null,
        source:    row.source ?? "traveler",
        status:    row.status ?? "provisional",
        verified:  Boolean(row.verified),
        createdAt: row.created_at as string,
        lat:       row.lat != null ? parseFloat(row.lat) : null,
        lng:       row.lng != null ? parseFloat(row.lng) : null,
      };
    });

    // Batch-fetch saved state and vote/review aggregates in parallel (both non-fatal)
    const placeIds = items.map((i) => i.id);
    const savedPlaceIds = new Set<string>();
    const [, voteAgg] = await Promise.all([
      (async () => {
        try {
          const authHeaderComm = req.headers.authorization;
          const commSc = getServiceClient();
          if (authHeaderComm?.startsWith("Bearer ") && commSc && placeIds.length > 0) {
            const { data: authDataComm } = await commSc.auth.getUser(authHeaderComm.slice(7).trim());
            if (authDataComm?.user) {
              const { data: userCols } = await commSc
                .from("collections")
                .select("id")
                .eq("owner_id", authDataComm.user.id);
              const colIds = ((userCols ?? []) as any[]).map((c) => c.id as string);
              if (colIds.length > 0) {
                const { data: savedItems } = await commSc
                  .from("collection_items")
                  .select("entity_id")
                  .eq("entity_type", "place")
                  .in("collection_id", colIds)
                  .in("entity_id", placeIds);
                for (const s of (savedItems ?? []) as any[]) savedPlaceIds.add((s as any).entity_id as string);
              }
            }
          }
        } catch { /* non-fatal */ }
      })(),
      batchFetchVoteAndRatingAggregates(getServiceClient(), placeIds, "place"),
    ]);

    res.json({
      items: items.map((i) => {
        const a = voteAgg.get(i.id);
        return {
          ...i,
          isSaved: savedPlaceIds.has(i.id),
          ...(a ? { worthItCount: a.worthItCount, avgRating: a.avgRating, reviewCount: a.reviewCount } : {}),
        };
      }),
      city,
      total: items.length,
      ageFilterMeta: {
        ageFilter:         ageFilterComm,
        callerDobMissing:  ageFilterComm === "open_to_me" ? commCallerDobMissing : false,
        bounds:            communityAgeBounds(),
      },
    });
  } catch (err) {
    req.log.error({ err }, "discovery/community route failed");
    res.json({ items: [], city, total: 0 });
  }
});

/**
 * POST /api/discovery/community  — submit a new community place (hidden gem or traveler pick).
 * Requires auth. Inserts via service role client to bypass RLS (P-256 JWT key rotation).
 */
router.post("/discovery/community", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const sc = getServiceClient();
  if (!sc) {
    res.status(503).json({ ok: false, reason: "server_not_configured" });
    return;
  }

  const {
    city,
    name,
    place_type,
    category,
    neighborhood,
    blurb,
    tag,
    note,
    rating,
    lat,
    lng,
    photos,
  } = req.body as Record<string, unknown>;

  if (!city || typeof city !== "string" || city.trim().length === 0) {
    sendError(res, "invalid_payload", "city is required");
    return;
  }
  if (!name || typeof name !== "string" || name.trim().length === 0) {
    sendError(res, "invalid_payload", "name is required");
    return;
  }
  const VALID_PLACE_TYPES_POST = new Set(["hidden_gem", "traveler_pick"]);
  if (!place_type || !VALID_PLACE_TYPES_POST.has(place_type as string)) {
    sendError(res, "invalid_payload", "place_type must be hidden_gem or traveler_pick");
    return;
  }

  const ratingNum = rating != null ? parseFloat(String(rating)) : null;
  if (ratingNum !== null && (isNaN(ratingNum) || ratingNum < 0 || ratingNum > 5)) {
    sendError(res, "invalid_payload", "rating must be between 0 and 5");
    return;
  }

  const latNum = lat != null ? parseFloat(String(lat)) : null;
  const lngNum = lng != null ? parseFloat(String(lng)) : null;
  if (latNum !== null && (isNaN(latNum) || latNum < -90 || latNum > 90)) {
    sendError(res, "invalid_payload", "lat must be between -90 and 90");
    return;
  }
  if (lngNum !== null && (isNaN(lngNum) || lngNum < -180 || lngNum > 180)) {
    sendError(res, "invalid_payload", "lng must be between -180 and 180");
    return;
  }

  const cityTrim = (city as string).trim();
  const nameTrim = (name as string).trim();

  // ── Duplicate check ──────────────────────────────────────────────────────────
  // Reject if an active place with the same city + name already exists (case-insensitive).
  const { data: existingPlace, error: dupeCheckErr } = await sc
    .from("discovery_places")
    .select("id")
    .ilike("city", cityTrim)
    .ilike("name", nameTrim)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();

  if (dupeCheckErr) {
    sendError(res, "db_error", dupeCheckErr.message);
    return;
  }

  if (existingPlace) {
    res.status(409).json({
      ok: false,
      error: "duplicate_place",
      message: "A place with that name already exists in this city",
    });
    return;
  }

  // Auto-geocode the place name + city when the caller didn't supply coordinates.
  // A 4-second timeout prevents this from blocking the response when Nominatim is slow.
  // If geocoding fails or times out, we insert with null coords — the place still appears
  // in the list view; it just won't be pinned on the map.
  let finalLat = latNum;
  let finalLng = lngNum;
  let geocoded = false;
  if (finalLat === null || finalLng === null) {
    try {
      const neighborhoodStr = typeof neighborhood === "string" && neighborhood.trim()
        ? `${neighborhood.trim()}, `
        : "";
      const geoQuery = `${(name as string).trim()}, ${neighborhoodStr}${(city as string).trim()}`;
      const geoResult = await Promise.race([
        geocode(geoQuery),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 4_000)),
      ]);
      if (geoResult) {
        finalLat = geoResult.lat;
        finalLng = geoResult.lng;
        geocoded = true;
      }
    } catch {
      /* non-fatal — insert without coordinates */
    }
  }

  try {
    // Validate and sanitise the optional photos array (max 3 CDN URL strings).
    const photosArr: string[] | null = Array.isArray(photos)
      ? (photos as unknown[])
          .filter((p): p is string => typeof p === "string" && p.length > 0)
          .slice(0, 3)
      : null;

    const { data, error } = await sc
      .from("discovery_places")
      .insert({
        city:         cityTrim,
        name:         nameTrim,
        place_type:   place_type as string,
        category:     typeof category === "string" ? category.trim() : null,
        neighborhood: typeof neighborhood === "string" ? neighborhood.trim() || null : null,
        blurb:        typeof blurb === "string" ? blurb.trim() || null : null,
        tag:          typeof tag === "string" ? tag.trim() || null : null,
        note:         typeof note === "string" ? note.trim() || null : null,
        rating:       ratingNum,
        lat:          finalLat,
        lng:          finalLng,
        submitted_by: auth.user.id,
        source:       "traveler",

        // Written as an explicit key rather than `...(await provenanceStamp(…))`.
        // The spread made this payload statically unresolvable, so
        // check:write-path-columns could not verify ANY column here against the
        // live schema — the site was a blind spot, and the check fails on new
        // blind spots by design. provenanceStamp can only ever contribute
        // source_id ({ source_id } or {}), and source_id is nullable with no
        // default, so writing NULL is equivalent to omitting the key.
        source_id:  (await provenanceStamp(sc, "traveler")).source_id ?? null,
        status:       "active",
        verified:     false,
        photos:       photosArr && photosArr.length > 0 ? photosArr : null,
      })
      .select("id, name, city, place_type, status, created_at")
      .single();

    if (error) {
      req.log.error({ err: error }, "discovery/community POST insert failed");
      res.status(500).json({ ok: false, reason: "insert_failed" });
      return;
    }

    res.status(201).json({ ok: true, place: data, geocoded });
  } catch (err) {
    req.log.error({ err }, "discovery/community POST unexpected error");
    res.status(500).json({ ok: false, reason: "unexpected_error" });
  }
});

/**
 * POST /api/discovery/community/:placeId/save  — save a community discovery place.
 * Increments saved_count on discovery_places and upserts a row in
 * discovery_place_saves so the user's saved set persists across sessions.
 * Requires migrations 0029_discovery_places.sql and 0062_discovery_place_saves.sql.
 * Gracefully returns ok:false if either table does not exist yet.
 */
router.post("/discovery/community/:placeId/save", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const { placeId } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(placeId)) {
    sendError(res, "invalid_payload", "Invalid place id");
    return;
  }
  const sc = getServiceClient();
  if (!sc) { res.json({ ok: false, reason: "server_not_configured" }); return; }
  try {
    const { data: place, error: fetchErr } = await sc
      .from("discovery_places")
      .select("id, saved_count")
      .eq("id", placeId)
      .maybeSingle();
    if (fetchErr) { res.json({ ok: false, reason: "unavailable" }); return; }
    if (!place) { sendError(res, "not_found", "Place not found"); return; }
    const { error: updateErr } = await sc
      .from("discovery_places")
      .update({ saved_count: ((place as any).saved_count ?? 0) + 1 })
      .eq("id", placeId);
    if (updateErr) { res.json({ ok: false, reason: "unavailable" }); return; }
    // Record the per-user save so saved-ids endpoint can return it later.
    const { error: upsertErr } = await sc
      .from("discovery_place_saves")
      .upsert({ user_id: user.id, place_id: placeId }, { onConflict: "user_id,place_id" });
    if (upsertErr) { res.json({ ok: false, reason: "unavailable" }); return; }
    res.json({ ok: true, placeId });
  } catch {
    res.json({ ok: false, reason: "unavailable" });
  }
});

/**
 * GET /api/discovery/community/saved-ids
 * Returns the list of community place IDs saved by the current user.
 * Used by the mobile app to pre-populate the filled-bookmark state across sessions.
 * Returns { ids: string[] } — empty array on any error (fail-open).
 * Requires migration 0062_discovery_place_saves.sql.
 */
router.get("/discovery/community/saved-ids", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const sc = getServiceClient();
  if (!sc) { res.json({ ids: [] }); return; }
  try {
    const { data, error } = await sc
      .from("discovery_place_saves")
      .select("place_id")
      .eq("user_id", user.id);
    if (error) { res.json({ ids: [] }); return; }
    res.json({ ids: (data ?? []).map((r: { place_id: string }) => r.place_id) });
  } catch {
    res.json({ ids: [] });
  }
});

// ── Place reports ──────────────────────────────────────────────────────────────

const PLACE_REPORT_REASONS = [
  "spam", "offensive", "inaccurate", "unsafe", "duplicate", "other",
] as const;

const placeReportSchema = z.object({
  reason: z.enum(PLACE_REPORT_REASONS),
  notes:  z.string().max(500).optional(),
});

/**
 * POST /api/discovery/community/:placeId/report
 * Submit a moderation report for a community discovery place.
 * One report per (place, reporter) pair — subsequent calls from the same user
 * update the existing row (upsert).
 */
router.post("/discovery/community/:placeId/report", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { placeId } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(placeId)) {
    sendError(res, "invalid_payload", "Invalid place id");
    return;
  }

  const parsed = placeReportSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  const sc = getServiceClient();
  if (!sc) { res.status(503).json({ ok: false, reason: "server_not_configured" }); return; }

  // Verify the place exists and is active
  const { data: place, error: placeErr } = await sc
    .from("discovery_places")
    .select("id")
    .eq("id", placeId)
    .maybeSingle();

  if (placeErr || !place) {
    sendError(res, "not_found", "Place not found");
    return;
  }

  const { error } = await sc
    .from("discovery_place_reports")
    .upsert(
      {
        place_id:    placeId,
        reporter_id: user.id,
        reason:      parsed.data.reason,
        notes:       parsed.data.notes ?? null,
        created_at:  new Date().toISOString(),
      },
      { onConflict: "place_id,reporter_id" },
    );

  if (error) {
    sendError(res, "db_error", error.message);
    return;
  }

  res.json({ ok: true });
});

// ── Wikidata enrichment ───────────────────────────────────────────────────────
//
// Proxies a single Wikidata entity fetch and caches the result so repeated
// opens of the same place sheet don't hammer the public API.
//
// TTL: 24 h (Wikidata structured data changes infrequently).

const WIKIDATA_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

interface WikidataCacheEntry {
  data: WikidataEnrichment;
  cachedAt: number;
}

const _wikidataCache = new Map<string, WikidataCacheEntry>();

export interface WikidataEnrichment {
  /** English short description from Wikidata (e.g. "palace in Versailles, France"). */
  description: string | null;
  /** Full URL of the English Wikipedia article, when the entity has an enwiki sitelink. */
  wikipediaUrl: string | null;
  /** Wikimedia Commons image URL via Special:FilePath, when the entity has a P18 claim. */
  commonsImageUrl: string | null;
}

/**
 * GET /api/discovery/wikidata/:wikidataId
 *
 * Returns structured enrichment for a single Wikidata entity (Qnnn).
 * No auth required — all data is public.
 *
 * Response: WikidataEnrichment
 */
router.get("/discovery/wikidata/:wikidataId", async (req, res) => {
  const { wikidataId } = req.params;

  // Validate: must be Q followed by one or more digits.
  if (!/^Q[1-9]\d*$/.test(wikidataId)) {
    sendError(res, "invalid_payload", "wikidataId must be a valid Wikidata entity id (Q…)");
    return;
  }

  // L1: in-process memory cache.
  const cached = _wikidataCache.get(wikidataId);
  if (cached && Date.now() - cached.cachedAt < WIKIDATA_CACHE_TTL_MS) {
    res.json(cached.data);
    return;
  }

  // Fetch from Wikidata API.
  // props=descriptions|sitelinks/urls|claims gives us exactly what we need.
  const url = new URL("https://www.wikidata.org/w/api.php");
  url.searchParams.set("action", "wbgetentities");
  url.searchParams.set("ids", wikidataId);
  url.searchParams.set("format", "json");
  url.searchParams.set("languages", "en");
  url.searchParams.set("props", "descriptions|sitelinks/urls|claims");

  let raw: Response;
  try {
    raw = await fetchWithTimeout(url.toString(), {
      headers: { "User-Agent": "TravelBuddy/1.0 (travel-buddy-app; discovery)" },
    });
  } catch {
    sendError(res, "upstream_error", "Wikidata fetch failed");
    return;
  }

  if (!raw.ok) {
    sendError(res, "upstream_error", `Wikidata returned ${raw.status}`);
    return;
  }

  let body: unknown;
  try {
    body = await raw.json();
  } catch {
    sendError(res, "upstream_error", "Wikidata response was not valid JSON");
    return;
  }

  const entities = (body as Record<string, unknown>)?.entities as Record<string, unknown> | undefined;
  const item = entities?.[wikidataId] as Record<string, unknown> | undefined;

  if (!item || (item as { missing?: string }).missing !== undefined) {
    // Entity doesn't exist on Wikidata — return empty enrichment and cache it.
    const empty: WikidataEnrichment = { description: null, wikipediaUrl: null, commonsImageUrl: null };
    _wikidataCache.set(wikidataId, { data: empty, cachedAt: Date.now() });
    res.json(empty);
    return;
  }

  // Extract English description.
  const descriptions = item.descriptions as Record<string, { value: string }> | undefined;
  const description: string | null = descriptions?.en?.value ?? null;

  // Extract English Wikipedia URL from sitelinks.
  const sitelinks = item.sitelinks as Record<string, { url?: string; title?: string }> | undefined;
  const enwiki = sitelinks?.enwiki;
  let wikipediaUrl: string | null = null;
  if (enwiki?.url) {
    wikipediaUrl = enwiki.url;
  } else if (enwiki?.title) {
    wikipediaUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(enwiki.title)}`;
  }

  // Extract Commons image from P18 claim (image property).
  let commonsImageUrl: string | null = null;
  const claims = item.claims as Record<string, unknown[]> | undefined;
  const p18 = claims?.P18;
  if (Array.isArray(p18) && p18.length > 0) {
    const snak = (p18[0] as Record<string, unknown>)?.mainsnak as Record<string, unknown> | undefined;
    const dv = snak?.datavalue as Record<string, unknown> | undefined;
    const filename = dv?.value as string | undefined;
    if (filename && typeof filename === "string" && filename.trim()) {
      commonsImageUrl = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(filename.trim())}`;
    }
  }

  const enrichment: WikidataEnrichment = { description, wikipediaUrl, commonsImageUrl };
  _wikidataCache.set(wikidataId, { data: enrichment, cachedAt: Date.now() });
  res.json(enrichment);
});

export default router;
