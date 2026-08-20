/**
 * placeResolve — the canonical external-place layer (media audit Phase 6, spec §27–§32).
 *
 * Places, hotels, restaurants, venues etc. arrive from several providers (FSQ,
 * OSM, Google, user submissions) with no cross-resolution, so one real hotel can
 * exist as an FSQ row + an OSM result + a user gem with no link. This resolves
 * every external record to ONE canonical `places` row + an
 * `external_place_references` link, deduplicating carefully.
 *
 * Dedup is DELIBERATELY conservative (spec §29 "Do not merge distinct nearby
 * entities"): merge only when a candidate is very close AND name-equivalent AND
 * in the same category family — so a hotel and its rooftop bar, a mall and a
 * restaurant inside it, or two branches of a chain stay separate.
 *
 * Flag-gated by `external_places_enabled`: when off, resolve is a no-op (null)
 * and nothing writes — the wave is fully dormant until switched on.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { provenanceStamp } from "../placeProvenance.js";
import { normalizeLocationName } from "../canonicalLocations.js";
import { isFlagEnabled } from "../featureFlags.js";

// ── Category families (the don't-merge-across-family guard) ───────────────────
export type PlaceCategory =
  | "accommodation" | "food" | "nightlife" | "culture" | "shopping" | "attraction"
  | "waterfall" | "mountain" | "beach" | "viewpoint" | "park" | "cave" | "lake" | "river" | "trail" | "island"
  | "other";

const CATEGORY_ALIASES: Record<string, PlaceCategory> = {
  hotel: "accommodation", hostel: "accommodation", resort: "accommodation", lodging: "accommodation",
  accommodation: "accommodation", guesthouse: "accommodation", motel: "accommodation",
  restaurant: "food", cafe: "food", food: "food", bakery: "food", diner: "food",
  bar: "nightlife", club: "nightlife", nightlife: "nightlife", lounge: "nightlife", pub: "nightlife",
  museum: "culture", gallery: "culture", culture: "culture", theatre: "culture", theater: "culture",
  mall: "shopping", shop: "shopping", store: "shopping", shopping: "shopping", market: "shopping",
  attraction: "attraction", landmark: "attraction",
  // Natural landmark sub-families (stored verbatim; never collapsed to "attraction")
  waterfall: "waterfall", falls: "waterfall", waterfalls: "waterfall",
  mountain: "mountain", mount: "mountain", peak: "mountain", hill: "mountain", summit: "mountain",
  beach: "beach", beaches: "beach", shore: "beach",
  viewpoint: "viewpoint", lookout: "viewpoint", overlook: "viewpoint",
  park: "park", "national park": "park", reserve: "park",
  cave: "cave", cavern: "cave", grotto: "cave",
  lake: "lake", lagoon: "lake", pond: "lake",
  river: "river", stream: "river", creek: "river",
  trail: "trail", hiking: "trail",
  island: "island", isle: "island",
};

export function categoryFamily(raw: string | null | undefined): PlaceCategory {
  const k = (raw ?? "").toLowerCase().trim();
  if (!k) return "other";
  if (CATEGORY_ALIASES[k]) return CATEGORY_ALIASES[k];
  for (const [needle, fam] of Object.entries(CATEGORY_ALIASES)) {
    if (k.includes(needle)) return fam;
  }
  return "other";
}

// ── Landmark category families ────────────────────────────────────────────────

/**
 * The set of PlaceCategory values that represent natural landmarks.
 * These trigger the relaxed merge heuristics (300 m radius, Jaccard ≥ 0.6
 * on normalised token sets) in `isSamePlace`.
 */
export const LANDMARK_CATEGORY_FAMILIES = new Set<PlaceCategory>([
  "waterfall", "mountain", "beach", "viewpoint", "park",
  "cave", "lake", "river", "trail", "island",
]);

/** Returns true when `raw` resolves to a natural-landmark category family. */
export function isLandmark(raw: string | null | undefined): boolean {
  return LANDMARK_CATEGORY_FAMILIES.has(categoryFamily(raw));
}

// ── Landmark name normalisation ───────────────────────────────────────────────

/**
 * Descriptor tokens stripped before landmark Jaccard comparison.
 * Includes type nouns (so "Kawasan Falls" and "Kawasan Waterfalls" share the
 * core token "kawasan"), positional modifiers ("Upper", "Main"), ordinals,
 * and a small geographic-qualifier blocklist.
 *
 * ── CHECKLIST: adding a new token ────────────────────────────────────────────
 * Before adding any token here, verify ALL four conditions:
 *
 *   1. GENERIC, NOT DISTINCTIVE — The token must be a generic qualifier that
 *      commonly appears alongside many different landmark names, never the
 *      sole distinctive identifier of a specific landmark.
 *      ✓ Safe:   "cebu" (appears with Kawasan, Tumalog, Moalboal, …)
 *      ✗ Unsafe: "kawasan" (IS the landmark — stripping it leaves nothing)
 *      ✗ Unsafe: "apo" (Mount Apo — stripping it makes "Mount Apo"
 *                       un-mergeable with itself via the normal path)
 *
 *   2. ZERO-TOKEN FALLBACK CHECK — When the token is the ONLY remaining token
 *      in an important landmark name (e.g., "Apo" in "Mount Apo"), stripping
 *      it reduces that name to [].  The zero-token fallback (below, ~line 213)
 *      saves identical-name pairs: both sides must reduce to [] AND their
 *      normalizeLocationName() results must be equal.  Verify this will hold
 *      for every affected landmark before adding the token.
 *
 *   3. ASYMMETRIC REDUCTION — If one provider spells the name "Mount Apo" and
 *      another "Apo Volcano", stripping "apo" from the first leaves [] while
 *      the second retains ["volcano"].  Asymmetric zero-token cases are
 *      intentionally NOT merged (you can't confirm identity without a shared
 *      core token).  Run the invariant tests to confirm no known pair breaks.
 *
 *   4. RUN THE INVARIANT TESTS — After adding a token, run the test suite and
 *      verify the "LANDMARK_DESCRIPTOR_TOKENS blocklist addition invariants"
 *      describe block still passes in full.  Those cases are the regression
 *      guard; a new token that breaks any of them must not be added.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */
const LANDMARK_DESCRIPTOR_TOKENS = new Set([
  // Type nouns
  "falls", "waterfall", "waterfalls",
  "beach", "beaches",
  "mountain", "mount", "mt", "peak", "summit", "ridge",
  "viewpoint", "lookout", "overlook",
  "park", "national", "reserve",
  "cave", "caves", "cavern",
  "lake", "river", "stream", "creek",
  "trail", "path", "track",
  "island", "isle",
  // Positional / ordinal modifiers
  "main", "upper", "lower",
  "north", "south", "east", "west",
  "central", "big", "little", "great", "grand", "new", "old",
  // Ordinal numbers
  "1st", "2nd", "3rd", "4th", "5th", "i", "ii", "iii", "iv", "v",
  // Geographic qualifiers (blocklist — extend as needed)
  "cebu",
  // Country names
  "philippines", "indonesia", "malaysia", "thailand", "vietnam",
  "cambodia", "myanmar", "singapore", "japan", "korea",
  // Major Philippine islands / regions / provinces
  "palawan", "boracay", "bohol", "batangas",
  "leyte", "samar", "negros", "panay",
  "mindanao", "luzon", "visayas",
  "davao", "ilocos", "bataan", "pampanga",
  "laguna", "iloilo", "bacolod", "cagayan",
  // Indonesian / SE-Asian regions commonly embedded in landmark names
  "bali", "lombok", "java", "sumatra",
]);

/** Strip Unicode combining diacritical marks. */
function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Normalise a landmark name for fuzzy dedup comparison.
 * Lowercases, strips diacritics, tokenises, then removes descriptor tokens
 * (type nouns, positional modifiers, geographic qualifiers) leaving the
 * distinctive core tokens that uniquely identify the landmark.
 *
 * "Kawasan Main Falls"   → ["kawasan"]
 * "Kawasan Waterfalls"   → ["kawasan"]
 * "White Beach Boracay"  → ["white"]  (if "boracay" is added to blocklist)
 */
export function normalizeLandmarkName(name: string): string[] {
  const lower = stripDiacritics(name.toLowerCase());
  const tokens = lower.split(/[\s\-–—,./()[\]]+/).filter((t) => t.length > 0);
  return tokens.filter((t) => !LANDMARK_DESCRIPTOR_TOKENS.has(t));
}

// ── Name similarity (token-set) ───────────────────────────────────────────────
function tokenSet(name: string): Set<string> {
  return new Set(normalizeLocationName(name).split(" ").filter((t) => t.length > 1));
}

/** Jaccard overlap of significant tokens; 1 = identical normalized name. */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeLocationName(a), nb = normalizeLocationName(b);
  if (na && na === nb) return 1;
  const sa = tokenSet(a), sb = tokenSet(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Dedup decision (pure) ─────────────────────────────────────────────────────
export interface PlaceLike {
  name: string;
  latitude: number | null;
  longitude: number | null;
  primary_category?: string | null;
}

/** Max distance (km) at which two same-name same-family venues are "the same". */
export const MERGE_DISTANCE_KM = 0.075; // ~75 m — same building/address
const MERGE_NAME_SIM = 0.8;

/** Relaxed distance for natural landmarks (larger footprint, variant names). */
export const LANDMARK_MERGE_DISTANCE_KM = 0.300; // ~300 m
const LANDMARK_MERGE_NAME_SIM = 0.6;

/**
 * Should `candidate` be considered the SAME real-world place as `existing`?
 *
 * Standard branch — built venues (hotels, restaurants, bars, …):
 *   • Distance ≤ 75 m (same building/address)
 *   • Same category family (hotel ≠ its rooftop bar)
 *   • Jaccard token overlap ≥ 0.8
 *
 * Landmark branch — natural landmarks (waterfalls, mountains, beaches, …):
 *   • Both candidates resolve to a landmark category family
 *   • Same landmark sub-family (waterfall ≠ mountain even at same coords)
 *   • Distance ≤ 300 m (wider footprint; name variants common)
 *   • Jaccard overlap ≥ 0.6 on *normalised* token sets (descriptor-stripped)
 *
 * Any missing coordinate → not mergeable (can't verify proximity → keep apart).
 */
export function isSamePlace(candidate: PlaceLike, existing: PlaceLike): boolean {
  if (candidate.latitude == null || candidate.longitude == null ||
      existing.latitude == null || existing.longitude == null) return false;

  const dist = haversineKm(candidate.latitude, candidate.longitude, existing.latitude, existing.longitude);

  // ── Landmark branch ───────────────────────────────────────────────────────
  const candFam = categoryFamily(candidate.primary_category);
  const exisFam = categoryFamily(existing.primary_category);
  if (LANDMARK_CATEGORY_FAMILIES.has(candFam) && LANDMARK_CATEGORY_FAMILIES.has(exisFam)) {
    if (candFam !== exisFam) return false;                             // waterfall ≠ mountain
    if (dist > LANDMARK_MERGE_DISTANCE_KM) return false;
    const normA = normalizeLandmarkName(candidate.name);
    const normB = normalizeLandmarkName(existing.name);
    // Zero-token fallback: when descriptor-stripping reduces BOTH names to []
    // (e.g. "Boracay Beach" → [] after adding "boracay" to the qualifier
    // blocklist), fall back to normalised full-name equality so legitimately
    // identical-name landmarks within range are still merged.
    // If only one side is empty we cannot reliably confirm identity → no merge.
    if (normA.length === 0 && normB.length === 0) {
      const na = normalizeLocationName(candidate.name);
      const nb = normalizeLocationName(existing.name);
      return na.length > 0 && na === nb;
    }
    if (normA.length === 0 || normB.length === 0) return false;
    const setA = new Set(normA);
    const setB = new Set(normB);
    let inter = 0;
    for (const t of setA) if (setB.has(t)) inter++;
    const jaccard = inter / (setA.size + setB.size - inter);
    return jaccard >= LANDMARK_MERGE_NAME_SIM;
  }

  // ── Standard branch ───────────────────────────────────────────────────────
  if (dist > MERGE_DISTANCE_KM) return false;                         // two chain branches stay apart
  if (candFam !== exisFam) return false;                              // hotel ≠ its bar
  return nameSimilarity(candidate.name, existing.name) >= MERGE_NAME_SIM;
}

// ── Opening hours sub-type ────────────────────────────────────────────────────

/**
 * One day's open/close window. dayOfWeek: 0=Sunday…6=Saturday.
 * open/close are local-time "HH:MM" strings (24-hour).
 */
export interface NormalizedOpeningHoursEntry {
  dayOfWeek: number;
  open: string;
  close: string;
}
export type NormalizedOpeningHours = NormalizedOpeningHoursEntry[];

// ── Price level ───────────────────────────────────────────────────────────────

export type PriceLevel =
  | "free"
  | "inexpensive"
  | "moderate"
  | "expensive"
  | "very_expensive";

// ── Canonical display envelope ────────────────────────────────────────────────
export interface CanonicalPlace {
  // Required
  id: string;
  name: string;
  category: PlaceCategory;

  // Location
  coordinates: { lat: number; lng: number } | null;
  address: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  formattedAddress: string | null;
  postalCode: string | null;
  region: string | null;
  city: string | null;
  neighborhood: string | null;
  countryCode: string | null;

  // Status & routing
  status: string;
  detailRoute: string;

  // Description
  description: string | null;

  // Images
  headerImageUrl: string | null;
  galleryImages: string[];

  // Contact
  phone: string | null;
  internationalPhone: string | null;
  website: string | null;
  bookingUrl: string | null;

  // Ratings & reviews
  rating: number | null;
  reviewCount: number | null;

  // Pricing
  priceLevel: PriceLevel | null;

  // Hours
  openingHours: NormalizedOpeningHours | null;
  isOpenNow: boolean | null;

  // Amenities
  amenities: string[];

  // Provenance
  attribution: string[];          // every provider's required attribution, deduped
  sources: string[];              // provider names contributing to this place
  fieldFreshness: Record<string, string>;
}

// ── Image reference shape (used by resolveCanonicalPlaceImage) ────────────────

export interface PlaceImageRef {
  provider?: string | null;
  image_url?: string | null;
  photo_url?: string | null;
  verified?: boolean | null;
  approved?: boolean | null;
}

/**
 * Resolve the best available header image for a place following the
 * 5-tier priority chain:
 *
 *   1. Verified Portava image_url (provider='portava', verified=true)
 *   2. Any provider photo_url (non-user provider)
 *   3. Approved user-contributed photo_url (provider='user', approved=true)
 *   4. → null  (category-based fallback is a client-side concern)
 *
 * Never invents or generates images; only selects from existing URLs in refs.
 */
export function resolveCanonicalPlaceImage(
  _place: PlaceLike,
  refs: PlaceImageRef[],
): string | null {
  if (!Array.isArray(refs) || refs.length === 0) return null;

  // Tier 1: verified Portava image
  for (const r of refs) {
    if (r.provider === "portava" && r.verified === true && r.image_url) {
      return r.image_url;
    }
  }

  // Tier 2: any provider photo (exclude user-contributed)
  for (const r of refs) {
    if (r.provider !== "user" && r.photo_url) {
      return r.photo_url;
    }
  }

  // Tier 3: approved user-contributed image
  for (const r of refs) {
    if (r.provider === "user" && r.approved === true && r.photo_url) {
      return r.photo_url;
    }
  }

  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Map a numeric FSQ price tier (1–4) to a PriceLevel string. */
function fsqPriceToLevel(price: unknown): PriceLevel | null {
  switch (Number(price)) {
    case 1: return "inexpensive";
    case 2: return "moderate";
    case 3: return "expensive";
    case 4: return "very_expensive";
    default: return null;
  }
}

/** Safely coerce to array of strings; returns [] for anything else. */
function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim() !== "");
}

/** Safely coerce to string or null. */
function toStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** Safely coerce to finite number or null. */
function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Validate and coerce an opening hours value from provider/DB data.
 * Accepts an array of { dayOfWeek, open, close } objects.
 * Returns null when the value is absent or malformed.
 */
function toOpeningHours(v: unknown): NormalizedOpeningHours | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const result: NormalizedOpeningHours = [];
  for (const entry of v) {
    if (!entry || typeof entry !== "object") return null;
    const e = entry as Record<string, unknown>;
    const dayOfWeek = toNum(e.dayOfWeek);
    const open = toStr(e.open);
    const close = toStr(e.close);
    if (dayOfWeek === null || open === null || close === null) return null;
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) return null;
    result.push({ dayOfWeek, open, close });
  }
  return result.length > 0 ? result : null;
}

// ── Normalizer ────────────────────────────────────────────────────────────────

export function toCanonicalPlace(place: any, refs: any[]): CanonicalPlace {
  const attribution = Array.from(new Set(
    (refs ?? []).map((r) => r.attribution).filter((a): a is string => typeof a === "string" && a.trim() !== ""),
  ));
  const sources = Array.from(new Set((refs ?? []).map((r) => r.provider).filter(Boolean)));

  // Resolve best image via priority chain
  const headerImageUrl = resolveCanonicalPlaceImage(place, refs ?? []);

  // Gallery: collect all provider photo_urls not already used as header
  const galleryImages: string[] = [];
  for (const r of refs ?? []) {
    if (r.photo_url && r.photo_url !== headerImageUrl) {
      galleryImages.push(r.photo_url);
    }
  }
  // Also include any gallery_images stored directly on the place record
  for (const url of toStringArray(place.gallery_images)) {
    if (!galleryImages.includes(url)) galleryImages.push(url);
  }

  // Price: prefer explicit price_level string; fall back to fsq numeric tier
  let priceLevel: PriceLevel | null = null;
  const rawPriceLevel = toStr(place.price_level);
  const validPriceLevels: ReadonlySet<string> = new Set([
    "free", "inexpensive", "moderate", "expensive", "very_expensive",
  ]);
  if (rawPriceLevel && validPriceLevels.has(rawPriceLevel)) {
    priceLevel = rawPriceLevel as PriceLevel;
  } else {
    priceLevel = fsqPriceToLevel(place.price ?? place.fsq_price);
  }

  // isOpenNow: explicit boolean only — never inferred from hours
  const isOpenNow: boolean | null =
    typeof place.is_open_now === "boolean" ? place.is_open_now : null;

  return {
    id: place.id,
    name: place.name,
    category: categoryFamily(place.primary_category),

    description: toStr(place.description),

    coordinates: place.latitude != null && place.longitude != null
      ? { lat: place.latitude, lng: place.longitude } : null,
    address: place.address ?? null,
    addressLine1: toStr(place.address_line1),
    addressLine2: toStr(place.address_line2),
    formattedAddress: toStr(place.formatted_address),
    postalCode: toStr(place.postal_code ?? place.postcode),
    region: toStr(place.region),
    city: place.city ?? null,
    neighborhood: place.neighborhood ?? null,
    countryCode: place.country_code ?? null,

    status: place.status ?? "active",
    detailRoute: `/place/${place.id}`,

    headerImageUrl,
    galleryImages,

    phone: toStr(place.phone ?? place.tel),
    internationalPhone: toStr(place.international_phone),
    website: toStr(place.website),
    bookingUrl: toStr(place.booking_url),

    rating: toNum(place.provider_rating ?? place.rating),
    reviewCount: toNum(place.review_count),

    priceLevel,
    openingHours: toOpeningHours(place.opening_hours),
    isOpenNow,

    amenities: toStringArray(place.amenities),

    attribution,
    sources,
    fieldFreshness: place.field_freshness ?? {},
  };
}

// ── The resolver (DB-touching, flag-gated, fail-soft) ─────────────────────────
export interface ExternalPlaceRecord {
  provider: string;              // 'fsq' | 'osm' | 'google' | 'user' | ...
  providerPlaceId: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  primaryCategory?: string | null;
  address?: string | null;
  city?: string | null;
  neighborhood?: string | null;
  countryCode?: string | null;
  providerUrl?: string | null;
  attribution?: string | null;
  rawCategory?: string | null;
  canonicalLocationId?: string | null;
}

/**
 * Resolve one external record to a canonical place id, creating/linking as
 * needed. Returns { placeId, created } or null when the feature is off.
 */
export async function resolveExternalPlace(
  db: SupabaseClient,
  rec: ExternalPlaceRecord,
): Promise<{ placeId: string; created: boolean } | null> {
  if (!(await isFlagEnabled(db, "external_places_enabled"))) return null;
  const now = new Date().toISOString();

  // 1. Already linked by (provider, provider_place_id)?
  const { data: existingRef } = await db
    .from("external_place_references")
    .select("place_id")
    .eq("provider", rec.provider)
    .eq("provider_place_id", rec.providerPlaceId)
    .maybeSingle();
  if ((existingRef as any)?.place_id) {
    await db.from("external_place_references")
      .update({ last_fetched_at: now, last_verified_at: now })
      .eq("provider", rec.provider).eq("provider_place_id", rec.providerPlaceId);
    // Follow a merge so a linked-but-since-merged place resolves to its survivor.
    const { data: linked } = await db
      .from("places").select("merged_into_place_id").eq("id", (existingRef as any).place_id).maybeSingle();
    const survivor = (linked as any)?.merged_into_place_id ?? (existingRef as any).place_id;
    return { placeId: survivor, created: false };
  }

  // 2. Dedup against nearby places (bbox ~ 2× merge distance for safety), then
  //    apply the isSamePlace guard in JS.
  //    Use the landmark radius for landmark categories so the wider 300 m
  //    threshold has candidates to compare against.
  let matchId: string | null = null;
  if (rec.latitude != null && rec.longitude != null) {
    const bboxRadius = isLandmark(rec.primaryCategory) ? LANDMARK_MERGE_DISTANCE_KM : MERGE_DISTANCE_KM;
    const d = (bboxRadius * 2) / 111.32;
    const { data: near } = await db
      .from("places")
      .select("id, name, latitude, longitude, primary_category, merged_into_place_id")
      .gte("latitude", rec.latitude - d).lte("latitude", rec.latitude + d)
      .gte("longitude", rec.longitude - d).lte("longitude", rec.longitude + d)
      .is("merged_into_place_id", null)
      .limit(50);
    for (const p of (near as any[]) ?? []) {
      if (isSamePlace(
        { name: rec.name, latitude: rec.latitude, longitude: rec.longitude, primary_category: rec.primaryCategory },
        p,
      )) { matchId = p.id; break; }
    }
  }

  // 3. Create the canonical place if no match.
  let placeId = matchId;
  let created = false;
  if (!placeId) {
    const { data: place, error } = await db
      .from("places")
      .insert({
        name: rec.name,
        normalized_name: normalizeLocationName(rec.name),
        primary_category: categoryFamily(rec.primaryCategory),
        latitude: rec.latitude,
        longitude: rec.longitude,
        address: rec.address ?? null,
        city: rec.city ?? null,
        neighborhood: rec.neighborhood ?? null,
        country_code: rec.countryCode ?? null,
        canonical_location_id: rec.canonicalLocationId ?? null,
        status: "active",
        field_freshness: { name: now, coordinates: now, category: now },
      })
      .select("id")
      .single();
    if (error || !place) return null;
    placeId = (place as any).id;
    created = true;
  }

  // 4. Attach the provider reference (idempotent on the unique key).
  await db.from("external_place_references").upsert(
    {
      place_id: placeId,
      provider: rec.provider,
      ...(await provenanceStamp(db, rec.provider)),
      provider_place_id: rec.providerPlaceId,
      provider_url: rec.providerUrl ?? null,
      raw_category: rec.rawCategory ?? rec.primaryCategory ?? null,
      attribution: rec.attribution ?? null,
      last_fetched_at: now,
      last_verified_at: now,
      confidence: rec.provider === "user" ? "community" : "provider",
    },
    { onConflict: "provider,provider_place_id" },
  );

  return { placeId: placeId as string, created };
}

// ── Post-place thin wrapper ───────────────────────────────────────────────────

export interface PostPlaceInput {
  postId: string;
  locationName: string;
  latitude: number | null;
  longitude: number | null;
  city?: string | null;
  countryCode?: string | null;
}

/**
 * Thin wrapper over resolveExternalPlace for a user-created post.
 * Uses provider='user' and providerPlaceId=postId so each post's
 * location attempt is unique and idempotent.
 *
 * Fail-soft: returns null when the feature flag is off or resolution fails.
 */
export async function resolvePostPlace(
  db: SupabaseClient,
  input: PostPlaceInput,
): Promise<{ placeId: string; created: boolean } | null> {
  if (!input.locationName || input.latitude == null || input.longitude == null) {
    return null;
  }
  return resolveExternalPlace(db, {
    provider: "user",
    providerPlaceId: `post:${input.postId}`,
    name: input.locationName,
    latitude: input.latitude,
    longitude: input.longitude,
    city: input.city ?? null,
    countryCode: input.countryCode ?? null,
  });
}
