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
  country: string | null;
  confidence: string;
  datasetDate: string | null;
}

function rowToPlace(r: any): FsqPlace {
  return {
    fsqId: r.fsq_id,
    name: r.name,
    latitude: r.latitude,
    longitude: r.longitude,
    category: r.category,
    label: r.fsq_primary_label ?? null,
    address: r.address ?? null,
    locality: r.locality ?? null,
    country: r.country ?? null,
    confidence: r.confidence ?? "provider",
    datasetDate: r.dataset_date ? String(r.dataset_date) : null,
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
      .select("fsq_id, name, latitude, longitude, category, fsq_primary_label, address, locality, country, confidence, dataset_date")
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
