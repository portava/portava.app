/**
 * FSQ Places read service — Compass data.
 *
 * Reads the per-city-ingested fsq_places layer. Flag-gated by
 * fsq_places_enabled; fail-soft to [] so callers keep working when the layer
 * is off or empty. FSQ attribution is REQUIRED wherever these places are shown.
 */

import type { FsqPlaceCategory } from "./categoryMap.js";

export const FSQ_FLAG = "fsq_places_enabled";
export const FSQ_ATTRIBUTION = "Powered by Foursquare";

export interface FsqPlace {
  fsqId: string;
  name: string;
  latitude: number;
  longitude: number;
  category: FsqPlaceCategory;
  label: string | null;
  address: string | null;
  locality: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  confidence: string;
  datasetDate: string | null;
  // Contact
  phone: string | null;
  website: string | null;
  // Ratings & pricing
  rating: number | null;
  reviewCount: number | null;
  /** Numeric FSQ price tier (1=cheap … 4=expensive). */
  fsqPrice: number | null;
  // Media
  photoUrl: string | null;
  galleryImages: string[];
  // Hours
  isOpenNow: boolean | null;
  // Amenities
  amenities: string[];
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function toStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim() !== "");
}

/**
 * Pick the first photo URL from an FSQ photos array (each item may have
 * prefix + suffix). Returns null when no usable photo is found.
 */
function firstPhotoUrl(photos: unknown): string | null {
  if (!Array.isArray(photos) || photos.length === 0) return null;
  const p = photos[0];
  if (!p || typeof p !== "object") return null;
  const { prefix, suffix } = p as Record<string, unknown>;
  if (typeof prefix === "string" && typeof suffix === "string") {
    return `${prefix}original${suffix}`;
  }
  if (typeof (p as any).url === "string") return (p as any).url;
  return null;
}

/**
 * Collect all photo URLs (up to `limit`) from an FSQ photos array.
 */
function allPhotoUrls(photos: unknown, limit = 6): string[] {
  if (!Array.isArray(photos)) return [];
  const urls: string[] = [];
  for (const p of photos) {
    if (urls.length >= limit) break;
    if (!p || typeof p !== "object") continue;
    const { prefix, suffix } = p as Record<string, unknown>;
    if (typeof prefix === "string" && typeof suffix === "string") {
      urls.push(`${prefix}original${suffix}`);
    } else if (typeof (p as any).url === "string") {
      urls.push((p as any).url);
    }
  }
  return urls;
}

function rowToPlace(r: any): FsqPlace {
  const allPhotos = allPhotoUrls(r.photos);
  const photoUrl = firstPhotoUrl(r.photos) ?? toStr(r.photo_url);

  return {
    fsqId: r.fsq_id,
    name: r.name,
    latitude: r.latitude,
    longitude: r.longitude,
    category: r.category,
    label: r.fsq_primary_label ?? null,
    address: r.address ?? null,
    locality: r.locality ?? null,
    region: r.region ?? null,
    postalCode: r.postcode ?? null,
    country: r.country ?? null,
    confidence: r.confidence ?? "provider",
    datasetDate: r.dataset_date ? String(r.dataset_date) : null,
    // Contact
    phone: toStr(r.tel ?? r.phone),
    website: toStr(r.website),
    // Ratings & pricing
    rating: toNum(r.rating),
    reviewCount: toNum(r.stats?.total_ratings ?? r.review_count),
    fsqPrice: toNum(r.price),
    // Media
    photoUrl,
    galleryImages: allPhotos.slice(1), // first is photoUrl; rest go to gallery
    // Hours
    isOpenNow: typeof r.hours?.open_now === "boolean" ? r.hours.open_now : null,
    // Amenities
    amenities: toStringArray(r.features?.amenities ?? r.amenities),
  };
}

export async function fsqEnabled(sc: any): Promise<boolean> {
  try {
    const { data, error } = await sc
      .from("feature_flags").select("enabled").eq("flag", FSQ_FLAG).maybeSingle();
    if (error) return false;
    return (data as any)?.enabled === true;
  } catch {
    return false;
  }
}

export interface FsqQuery {
  cityKey: string;
  category?: FsqPlaceCategory;
  limit?: number;
}

/**
 * Places for a city, optionally filtered by category. Fail-soft []; returns
 * attribution + dataset date alongside. Caller must render attribution.
 */
export async function getCityPlaces(
  sc: any,
  q: FsqQuery,
): Promise<{ places: FsqPlace[]; attribution: string; datasetDate: string | null }> {
  const empty = { places: [] as FsqPlace[], attribution: FSQ_ATTRIBUTION, datasetDate: null as string | null };
  if (!sc || !q.cityKey) return empty;
  try {
    let query = sc
      .from("fsq_places")
      .select([
        "fsq_id", "name", "latitude", "longitude", "category", "fsq_primary_label",
        "address", "locality", "region", "postcode", "country",
        "confidence", "dataset_date",
        // Extended fields (present when available from the enriched dataset)
        "tel", "website", "rating", "price", "stats", "photos", "hours",
        "features", "amenities", "photo_url",
      ].join(", "))
      .eq("city_key", q.cityKey)
      .limit(Math.min(Math.max(q.limit ?? 200, 1), 1000));
    if (q.category) query = query.eq("category", q.category);
    const { data, error } = await query;
    if (error || !Array.isArray(data)) return empty;
    const places = (data as any[]).map(rowToPlace);
    return { places, attribution: FSQ_ATTRIBUTION, datasetDate: places[0]?.datasetDate ?? null };
  } catch {
    return empty;
  }
}

/** Per-category counts for a city (density signal for neighborhood scoring). */
export async function getCityCategoryCounts(sc: any, cityKey: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (!sc || !cityKey) return out;
  try {
    const { data, error } = await sc
      .from("fsq_places").select("category").eq("city_key", cityKey);
    if (error || !Array.isArray(data)) return out;
    for (const r of data as any[]) out[r.category] = (out[r.category] ?? 0) + 1;
  } catch {
    // fail-soft
  }
  return out;
}
