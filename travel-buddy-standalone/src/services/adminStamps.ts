/**
 * Admin Stamp Catalog service — typed fetch wrappers for all admin stamp
 * catalog endpoints. Uses the same auth pattern as other mobile services.
 */
import { supabase } from '../lib/supabase';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function freshToken(): Promise<string | null> {
  try {
    const { data: refreshed } = await supabase.auth.refreshSession();
    const s = refreshed?.session ?? (await supabase.auth.getSession()).data.session;
    return s?.access_token ?? null;
  } catch { return null; }
}

type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function adminGet<T>(path: string): Promise<ApiResult<T>> {
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      return { ok: false, error: (b as any)?.message ?? `HTTP ${res.status}` };
    }
    return { ok: true, data: await res.json() as T };
  } catch (e: any) { return { ok: false, error: e?.message ?? 'Network error' }; }
}

async function adminPost<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      return { ok: false, error: (b as any)?.message ?? `HTTP ${res.status}` };
    }
    return { ok: true, data: await res.json() as T };
  } catch (e: any) { return { ok: false, error: e?.message ?? 'Network error' }; }
}

async function adminPatch<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      return { ok: false, error: (b as any)?.message ?? `HTTP ${res.status}` };
    }
    return { ok: true, data: await res.json() as T };
  } catch (e: any) { return { ok: false, error: e?.message ?? 'Network error' }; }
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CatalogEntry {
  id: string;
  canonical_location_key: string;
  stamp_type: string;
  display_name: string;
  country: string;
  country_code: string;
  region: string | null;
  city: string | null;
  neighborhood: string | null;
  status: 'pending_artwork' | 'approved' | 'rejected' | 'archived';
  active_version_id: string | null;
  earn_count: number;
  created_at: string;
  updated_at: string;
}

export interface ArtworkVersion {
  id: string;
  catalog_id: string;
  status: 'candidate' | 'approved' | 'rejected' | 'archived';
  public_url: string | null;
  generation_source: 'ai_generated' | 'admin_upload';
  provider: string | null;
  prompt_used: string | null;
  rejection_reason: string | null;
  created_at: string;
}

export interface CatalogDetail {
  entry: CatalogEntry;
  versions: ArtworkVersion[];
  queue: any | null;
  audit: any[];
  earnSample: any[];
}

// ── Catalog list ───────────────────────────────────────────────────────────────

export async function getAdminStampCatalog(opts: {
  page?: number;
  limit?: number;
  status?: string;
  stampType?: string;
  countryCode?: string;
  search?: string;
}): Promise<ApiResult<{ entries: CatalogEntry[]; total: number; page: number; statusCounts: Record<string, number> }>> {
  const params = new URLSearchParams();
  if (opts.page)        params.set('page',         String(opts.page));
  if (opts.limit)       params.set('limit',        String(opts.limit));
  if (opts.status)      params.set('status',       opts.status);
  if (opts.stampType)   params.set('stamp_type',   opts.stampType);
  if (opts.countryCode) params.set('country_code', opts.countryCode);
  if (opts.search)      params.set('search',       opts.search);
  const qs = params.toString();
  return adminGet(`/api/admin/stamps/catalog${qs ? `?${qs}` : ''}`);
}

// ── Catalog detail ─────────────────────────────────────────────────────────────

export async function getAdminCatalogEntry(id: string): Promise<ApiResult<CatalogDetail>> {
  return adminGet(`/api/admin/stamps/catalog/${id}`);
}

// ── Queue ──────────────────────────────────────────────────────────────────────

export async function getAdminStampQueue(opts: {
  page?: number;
  limit?: number;
  status?: string;
}): Promise<ApiResult<{ jobs: GenerationQueueJob[]; total: number; page: number }>> {
  const params = new URLSearchParams();
  if (opts.page)   params.set('page',   String(opts.page));
  if (opts.limit)  params.set('limit',  String(opts.limit));
  if (opts.status) params.set('status', opts.status);
  const qs = params.toString();
  return adminGet(`/api/admin/stamps/queue${qs ? `?${qs}` : ''}`);
}

// ── Activate version ───────────────────────────────────────────────────────────

export async function activateStampVersion(catalogId: string, versionId: string, notes?: string): Promise<ApiResult<any>> {
  return adminPatch(`/api/admin/stamps/catalog/${catalogId}/activate-version`, { versionId, notes });
}

// ── Reject catalog entry ───────────────────────────────────────────────────────

export async function rejectCatalogEntry(catalogId: string, reason: string): Promise<ApiResult<any>> {
  return adminPatch(`/api/admin/stamps/catalog/${catalogId}/reject`, { reason });
}

// ── Regenerate ─────────────────────────────────────────────────────────────────

export async function regenerateCatalogEntry(catalogId: string): Promise<ApiResult<any>> {
  return adminPost(`/api/admin/stamps/catalog/${catalogId}/regenerate`, {});
}

// ── Generation queue ───────────────────────────────────────────────────────────

export interface GenerationQueueJob {
  id: string;
  catalog_id: string;
  status: string;
  priority: number;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  triggered_by_action: string | null;
  created_at: string;
  updated_at: string;
  universal_stamp_catalog?: {
    display_name: string;
    stamp_type: string;
    country_code: string;
  } | null;
}

export async function requeueFailedJob(jobId: string): Promise<ApiResult<{ job: any }>> {
  return adminPost(`/api/admin/stamps/queue/${jobId}/requeue`, {});
}

// ── Upload replacement ─────────────────────────────────────────────────────────

export async function uploadStampArtwork(catalogId: string, opts: {
  imageBase64: string;
  mimeType: string;
  fileName?: string;
}): Promise<ApiResult<any>> {
  return adminPost(`/api/admin/stamps/catalog/${catalogId}/upload`, opts);
}

// ── Merge ──────────────────────────────────────────────────────────────────────

export async function mergeCatalogEntry(sourceId: string, targetId: string): Promise<ApiResult<any>> {
  return adminPost(`/api/admin/stamps/catalog/${sourceId}/merge-into/${targetId}`, {});
}

// ── Earners ───────────────────────────────────────────────────────────────────

export async function getCatalogEarners(catalogId: string, page = 1): Promise<ApiResult<any>> {
  return adminGet(`/api/admin/stamps/catalog/${catalogId}/earners?page=${page}`);
}

// ── Duplicates ─────────────────────────────────────────────────────────────────

export async function getStampDuplicates(): Promise<ApiResult<any>> {
  return adminGet('/api/admin/stamps/duplicates');
}

// ── Public catalog batch fetch ─────────────────────────────────────────────────

export async function batchFetchCatalogEntries(catalogIds: string[]): Promise<ApiResult<{
  entries: Array<{
    id: string;
    canonicalLocationKey: string;
    stampType: string;
    displayName: string;
    country: string;
    countryCode: string;
    status: string;
    activeArtworkUrl: string | null;
    earnCount: number;
  }>
}>> {
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/stamps/catalog/batch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ catalogIds }),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      return { ok: false, error: (b as any)?.message ?? `HTTP ${res.status}` };
    }
    return { ok: true, data: await res.json() };
  } catch (e: any) { return { ok: false, error: e?.message ?? 'Network error' }; }
}
