/**
 * FSQ row transform — Compass data (Foursquare OS Places).
 *
 * Normalizes a raw FSQ Places record (as read from the parquet by the
 * ingestion script) into a Portava `fsq_places` DB row. Pure + defensive so it
 * is unit-testable and tolerant of the FSQ schema's optional columns.
 *
 * HONESTY: every row is labeled source='fsq_os_places', confidence='provider',
 * carries the dataset date, and FSQ attribution is required by the license
 * (surfaced by the read layer).
 */

import { mapFsqCategory, primaryLabel, type FsqPlaceCategory } from "./categoryMap.js";

export const FSQ_SOURCE = "fsq_os_places";

/** Raw FSQ record fields the pipeline uses (all optional / defensively read). */
export interface FsqRawPlace {
  fsq_place_id?: string | null;
  name?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  address?: string | null;
  locality?: string | null;
  region?: string | null;
  postcode?: string | null;
  country?: string | null;
  fsq_category_ids?: string[] | null;
  fsq_category_labels?: string[] | null;
  date_closed?: string | null;
}

export interface FsqDbRow {
  fsq_id: string;
  name: string;
  latitude: number;
  longitude: number;
  category: FsqPlaceCategory;
  fsq_primary_label: string | null;
  fsq_category_ids: string[];
  fsq_category_labels: string[];
  address: string | null;
  locality: string | null;
  region: string | null;
  postcode: string | null;
  country: string | null;
  city_key: string;
  source: string;
  confidence: string;
  dataset_date: string;
}

function num(v: unknown): number | null {
  // Guard null/undefined/"" — Number(null) and Number("") are 0, not NaN, which
  // would let a missing coordinate slip through as 0,0 (off the coast of Africa).
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
function arr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Transform a raw FSQ place into a DB row. Returns null when the record is
 * unusable (no id / no name / no coordinates / permanently closed) — closed and
 * malformed venues are dropped, never guessed.
 */
export function fsqRowToDbRow(
  raw: FsqRawPlace,
  ctx: { cityKey: string; datasetDate: string },
): FsqDbRow | null {
  const fsqId = str(raw.fsq_place_id);
  const name = str(raw.name);
  const lat = num(raw.latitude);
  const lng = num(raw.longitude);
  if (!fsqId || !name || lat === null || lng === null) return null;
  if (str(raw.date_closed)) return null; // permanently closed
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  const labels = arr(raw.fsq_category_labels);
  return {
    fsq_id: fsqId,
    name,
    latitude: lat,
    longitude: lng,
    category: mapFsqCategory(labels),
    fsq_primary_label: primaryLabel(labels),
    fsq_category_ids: arr(raw.fsq_category_ids),
    fsq_category_labels: labels,
    address: str(raw.address),
    locality: str(raw.locality),
    region: str(raw.region),
    postcode: str(raw.postcode),
    country: str(raw.country),
    city_key: ctx.cityKey,
    source: FSQ_SOURCE,
    confidence: "provider",
    dataset_date: ctx.datasetDate,
  };
}
