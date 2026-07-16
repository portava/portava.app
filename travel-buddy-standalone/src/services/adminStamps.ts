/**
 * Admin Stamp Catalog service — typed fetch wrappers for all admin stamp
 * catalog endpoints. Uses the same auth pattern as other mobile services.
 */
import { adminGet, adminPost, adminPatch, type AdminApiResult } from './adminApi';

type ApiResult<T> = AdminApiResult<T>;

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

/**
 * Shape returned by the catalog list endpoint. Extends the base CatalogEntry
 * with the `review_required` status (set by the generation worker) and the
 * optional `last_error` field that records the most recent failure reason.
 * Using this type instead of `any` catches unexpected last_error shapes at
 * compile time rather than silently at runtime.
 */
export interface CatalogListEntry extends Omit<CatalogEntry, 'status'> {
  status: CatalogEntry['status'] | 'review_required';
  last_error?: string | null;
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
}): Promise<ApiResult<{ entries: CatalogListEntry[]; total: number; page: number; statusCounts: Record<string, number> }>> {
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

// ── Worker health ──────────────────────────────────────────────────────────────

export interface WorkerHealthWarning {
  key: 'stuck_jobs' | 'backlog_growing';
  message: string;
  details: Record<string, unknown>;
}

export interface StampWorkerHealth {
  worker_enabled: boolean;
  worker_running: boolean;
  worker_id: string;
  last_success_at: string | null;
  queue_depth: Record<string, number>;
  stuck_jobs: Array<{
    id: string;
    catalog_id: string;
    locked_by: string | null;
    locked_until: string | null;
    updated_at: string | null;
  }>;
}

export async function getStampWorkerHealth(): Promise<ApiResult<{
  health: StampWorkerHealth;
  warnings: WorkerHealthWarning[];
}>> {
  return adminGet('/api/admin/stamps/worker-health');
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
  return adminPost('/api/stamps/catalog/batch', { catalogIds });
}
