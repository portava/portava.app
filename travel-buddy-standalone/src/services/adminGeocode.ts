/**
 * Admin Geocode Cache service — typed fetch wrappers for the admin geocode-cache
 * endpoints. Uses the same auth pattern as other admin services.
 */
import { adminGet, adminDelete, adminPut, type AdminApiResult } from './adminApi.ts';

type ApiResult<T> = AdminApiResult<T>;

// ── Types ──────────────────────────────────────────────────────────────────────

export interface GeocodeCacheRow {
  city_key: string;
  country: string;
  country_code: string;
  resolved_at: string | null;
  updated_at: string;
}

export interface DeleteGeocodeCacheResult {
  deleted: true;
  city_key: string;
  /** Present when repair_catalog was NOT requested. Number of catalog entries
   *  still carrying the XX country code for this city. */
  xx_entries_pending?: number;
  /** Present when repair_catalog=true was sent. */
  repair?: {
    updated: number;
    errors: number;
    skipped: number;
  };
}

export interface PutGeocodeCacheResult {
  updated: true;
  city_key: string;
  country_code: string;
  country: string;
  /** Present when repair_catalog was NOT sent. Number of catalog entries
   *  still carrying the XX country code for this city. */
  xx_entries_pending?: number;
  /** Present when repair_catalog=true was sent. */
  repair?: {
    updated: number;
    errors: number;
    skipped: number;
  };
}

// ── API calls ──────────────────────────────────────────────────────────────────

/** List/search geocode cache rows. Pass q to filter by city_key substring. */
export async function getGeocodeCacheRows(q?: string): Promise<ApiResult<{ rows: GeocodeCacheRow[] }>> {
  const qs = q ? `?q=${encodeURIComponent(q)}` : '';
  return adminGet(`/api/admin/geocode-cache${qs}`);
}

/**
 * Delete a geocode cache row.
 *
 * When repairCatalog is false (default) the response includes xx_entries_pending
 * so the caller can warn the admin. Pass repairCatalog=true to immediately
 * re-resolve and re-key XX catalog entries for this city.
 */
export async function deleteGeocodeCacheRow(
  cityKey: string,
  repairCatalog = false,
): Promise<ApiResult<DeleteGeocodeCacheResult>> {
  const qs = repairCatalog ? '?repair_catalog=true' : '';
  return adminDelete(`/api/admin/geocode-cache/${encodeURIComponent(cityKey)}${qs}`);
}

/**
 * Overwrite a geocode cache row with corrected country data.
 *
 * When repairCatalog is false (default) the response includes xx_entries_pending
 * so the caller can warn the admin. Pass repairCatalog=true to immediately
 * re-key XX catalog entries for this city.
 */
export async function putGeocodeCacheRow(
  cityKey: string,
  fields: { country_code: string; country: string; repair_catalog?: boolean },
): Promise<ApiResult<PutGeocodeCacheResult>> {
  return adminPut(`/api/admin/geocode-cache/${encodeURIComponent(cityKey)}`, fields);
}
