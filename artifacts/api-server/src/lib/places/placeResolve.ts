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
import { normalizeLocationName } from "../canonicalLocations.js";
import { isFlagEnabled } from "../featureFlags.js";

// ── Category families (the don't-merge-across-family guard) ───────────────────
export type PlaceCategory =
  | "accommodation" | "food" | "nightlife" | "culture" | "shopping" | "attraction" | "other";

const CATEGORY_ALIASES: Record<string, PlaceCategory> = {
  hotel: "accommodation", hostel: "accommodation", resort: "accommodation", lodging: "accommodation",
  accommodation: "accommodation", guesthouse: "accommodation", motel: "accommodation",
  restaurant: "food", cafe: "food", food: "food", bakery: "food", diner: "food",
  bar: "nightlife", club: "nightlife", nightlife: "nightlife", lounge: "nightlife", pub: "nightlife",
  museum: "culture", gallery: "culture", culture: "culture", theatre: "culture", theater: "culture",
  mall: "shopping", shop: "shopping", store: "shopping", shopping: "shopping", market: "shopping",
  attraction: "attraction", landmark: "attraction", park: "attraction", viewpoint: "attraction",
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

/**
 * Should `candidate` be considered the SAME real-world place as `existing`?
 * Requires: close proximity AND name-equivalence AND same category family.
 * Any missing coordinate → not mergeable (can't verify proximity → keep apart).
 */
export function isSamePlace(candidate: PlaceLike, existing: PlaceLike): boolean {
  if (candidate.latitude == null || candidate.longitude == null ||
      existing.latitude == null || existing.longitude == null) return false;
  const dist = haversineKm(candidate.latitude, candidate.longitude, existing.latitude, existing.longitude);
  if (dist > MERGE_DISTANCE_KM) return false;                         // two chain branches stay apart
  if (categoryFamily(candidate.primary_category) !== categoryFamily(existing.primary_category)) return false; // hotel≠its bar
  return nameSimilarity(candidate.name, existing.name) >= MERGE_NAME_SIM;
}

// ── Canonical display envelope ────────────────────────────────────────────────
export interface CanonicalPlace {
  id: string;
  name: string;
  category: PlaceCategory;
  coordinates: { lat: number; lng: number } | null;
  address: string | null;
  city: string | null;
  neighborhood: string | null;
  countryCode: string | null;
  status: string;
  detailRoute: string;
  attribution: string[];          // every provider's required attribution, deduped
  sources: string[];              // provider names contributing to this place
  fieldFreshness: Record<string, string>;
}

export function toCanonicalPlace(place: any, refs: any[]): CanonicalPlace {
  const attribution = Array.from(new Set(
    (refs ?? []).map((r) => r.attribution).filter((a): a is string => typeof a === "string" && a.trim() !== ""),
  ));
  const sources = Array.from(new Set((refs ?? []).map((r) => r.provider).filter(Boolean)));
  return {
    id: place.id,
    name: place.name,
    category: categoryFamily(place.primary_category),
    coordinates: place.latitude != null && place.longitude != null
      ? { lat: place.latitude, lng: place.longitude } : null,
    address: place.address ?? null,
    city: place.city ?? null,
    neighborhood: place.neighborhood ?? null,
    countryCode: place.country_code ?? null,
    status: place.status ?? "active",
    detailRoute: `/place/${place.id}`,
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
  //    apply the strict isSamePlace guard in JS.
  let matchId: string | null = null;
  if (rec.latitude != null && rec.longitude != null) {
    const d = (MERGE_DISTANCE_KM * 2) / 111.32;
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
