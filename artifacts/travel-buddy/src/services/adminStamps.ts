/**
 * Admin Stamp Catalog service — typed fetch wrappers for all admin stamp
 * catalog endpoints. Uses the same auth pattern as other mobile services.
 */
import { adminGet, adminPost, adminPatch, type AdminApiResult } from './adminApi.ts';

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
  /** Error message from the storage remove() call when orphan cleanup failed. */
  cleanup_error?: string | null;
  /** Storage paths that were uploaded but could not be deleted when cleanup failed. */
  cleanup_error_paths?: string[] | null;
  /**
   * Set when the entry has a live generation job (queued or processing),
   * regardless of catalog status — e.g. a stale "rejected" entry whose
   * regenerate already re-queued a job. Lets the list show a "regenerating"
   * badge so operators don't trigger a redundant regenerate.
   */
  queue_status?: 'queued' | 'processing';
}

/**
 * Must stay in sync with STYLE_VERSION in
 * artifacts/api-server/src/lib/stamps/artDirection.ts.
 * Bump here whenever the prompt template version is bumped there so the admin
 * review screen can flag stale candidates.
 */
export const CURRENT_STYLE_VERSION = "v1.0";

export interface ArtworkVersion {
  id: string;
  catalog_id: string;
  status: 'candidate' | 'approved' | 'rejected' | 'archived';
  public_url: string | null;
  generation_source: 'ai_generated' | 'admin_upload';
  provider: string | null;
  prompt_used: string | null;
  prompt_template_version: string | null;
  rejection_reason: string | null;
  created_at: string;
}

/**
 * A single entry in the catalog audit log as returned by the detail endpoint.
 * Typed to catch callers that pass missing or mis-shaped fields at compile time
 * rather than silently at runtime.
 */
export interface CatalogAuditEntry {
  id: string;
  action: string;
  notes: string | null;
  created_at: string;
}

/**
 * Shape of each row returned in the earnSample array of a catalog detail
 * response. Using this type instead of `any` catches mismatched field names
 * (e.g. wrong id / user_id / source_type / earned_at) at compile time rather
 * than silently at runtime.
 */
export interface CatalogEarnSampleRow {
  id: string;
  user_id: string | null;
  source_type: string;
  earned_at: string;
}

export interface CatalogDetail {
  entry: CatalogEntry;
  versions: ArtworkVersion[];
  queue: GenerationQueueJob | null;
  audit: CatalogAuditEntry[];
  earnSample: CatalogEarnSampleRow[];
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

/**
 * Partial version shape returned by PATCH /admin/stamps/catalog/:id/activate-version.
 * The endpoint selects only `id, public_url` on the approved version row (both
 * on the update path and the idempotent already-approved path), so callers
 * must not expect the full ArtworkVersion here.
 */
export type ActivatedVersion = Pick<ArtworkVersion, 'id' | 'public_url'>;

/**
 * Response of PATCH /admin/stamps/catalog/:id/activate-version: the updated
 * catalog row (full select) plus the partial approved version row.
 */
export interface ActivateVersionResponse {
  entry: CatalogEntry;
  version: ActivatedVersion;
}

export async function activateStampVersion(catalogId: string, versionId: string, notes?: string): Promise<ApiResult<ActivateVersionResponse>> {
  return adminPatch(`/api/admin/stamps/catalog/${catalogId}/activate-version`, { versionId, notes });
}

// ── Reject catalog entry ───────────────────────────────────────────────────────

/**
 * Response of PATCH /admin/stamps/catalog/:id/reject: the rejected catalog row
 * (full select; same shape on the idempotent already-rejected path).
 */
export interface RejectCatalogResponse {
  entry: CatalogEntry;
}

export async function rejectCatalogEntry(catalogId: string, reason: string): Promise<ApiResult<RejectCatalogResponse>> {
  return adminPatch(`/api/admin/stamps/catalog/${catalogId}/reject`, { reason });
}

// ── Regenerate ─────────────────────────────────────────────────────────────────

/**
 * Response of POST /admin/stamps/catalog/:id/regenerate. The endpoint returns
 * only `{ ok: true }` on success — no entry or job payload — so callers must
 * refetch if they need the updated catalog/queue state.
 */
export interface RegenerateCatalogResponse {
  ok: true;
}

export async function regenerateCatalogEntry(catalogId: string): Promise<ApiResult<RegenerateCatalogResponse>> {
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
  /** Error message from the storage remove() call when orphan cleanup failed. */
  cleanup_error: string | null;
  /** Storage paths that were uploaded but could not be deleted when cleanup failed.
   *  Ops can manually remove these from the stamp-artwork bucket. */
  cleanup_error_paths: string[] | null;
  triggered_by_action: string | null;
  created_at: string;
  updated_at: string;
  universal_stamp_catalog?: {
    display_name: string;
    stamp_type: string;
    country_code: string;
  } | null;
}

/**
 * Partial job shape returned by POST /admin/stamps/queue/:jobId/requeue.
 * The endpoint selects only `id, catalog_id, status, attempts` on the updated
 * row, so callers must not expect the full GenerationQueueJob here.
 */
export type RequeuedJob = Pick<GenerationQueueJob, 'id' | 'catalog_id' | 'status' | 'attempts'>;

/**
 * Partial job shape returned by POST /admin/stamps/queue/:jobId/clear-cleanup-error.
 * The endpoint selects only `id, catalog_id, status, cleanup_error,
 * cleanup_error_paths` (both cleared fields come back null on success).
 */
export type CleanupClearedJob = Pick<
  GenerationQueueJob,
  'id' | 'catalog_id' | 'status' | 'cleanup_error' | 'cleanup_error_paths'
>;

export async function requeueFailedJob(jobId: string): Promise<ApiResult<{ job: RequeuedJob }>> {
  return adminPost(`/api/admin/stamps/queue/${jobId}/requeue`, {});
}

export async function clearCleanupError(jobId: string): Promise<ApiResult<{ job: CleanupClearedJob }>> {
  return adminPost(`/api/admin/stamps/queue/${jobId}/clear-cleanup-error`, {});
}

// ── Upload replacement ─────────────────────────────────────────────────────────

/**
 * Response of POST /admin/stamps/catalog/:id/upload: the newly inserted
 * candidate artwork version row (full select).
 */
export interface UploadStampArtworkResponse {
  version: ArtworkVersion;
}

export async function uploadStampArtwork(catalogId: string, opts: {
  imageBase64: string;
  mimeType: string;
  fileName?: string;
}): Promise<ApiResult<UploadStampArtworkResponse>> {
  return adminPost(`/api/admin/stamps/catalog/${catalogId}/upload`, opts);
}

// ── Merge ──────────────────────────────────────────────────────────────────────

/**
 * Response of POST /admin/stamps/catalog/:id/merge-into/:targetId. Returns
 * only `{ ok, mergedIntoId }` (same shape on the idempotent already-archived
 * path) — no updated rows, so callers must refetch for post-merge state.
 */
export interface MergeCatalogResponse {
  ok: true;
  mergedIntoId: string;
}

export async function mergeCatalogEntry(sourceId: string, targetId: string): Promise<ApiResult<MergeCatalogResponse>> {
  return adminPost(`/api/admin/stamps/catalog/${sourceId}/merge-into/${targetId}`, {});
}

// ── Earners ───────────────────────────────────────────────────────────────────

/**
 * A single row returned by the catalog earners endpoint. The `profiles` join
 * provides display info; it may be null when the user record has been deleted.
 */
export interface CatalogEarnerRow {
  id: string;
  user_id: string | null;
  earned_at: string;
  source_type: string;
  profiles: {
    username: string | null;
    display_name: string | null;
  } | null;
}

/**
 * Shape returned by GET /admin/stamps/catalog/:id/earners.
 * Using this type instead of `any` catches mismatched field names
 * (e.g. wrong earner row fields or missing pagination keys) at compile time
 * rather than silently at runtime.
 */
export interface CatalogEarnersResponse {
  earners: CatalogEarnerRow[];
  total: number;
  page: number;
}

export async function getCatalogEarners(catalogId: string, page = 1): Promise<ApiResult<CatalogEarnersResponse>> {
  return adminGet(`/api/admin/stamps/catalog/${catalogId}/earners?page=${page}`);
}

// ── Duplicates ─────────────────────────────────────────────────────────────────

/**
 * A single catalog row as returned inside a duplicate pair. Fields mirror the
 * select in GET /admin/stamps/duplicates.
 */
export interface StampDuplicateRow {
  id: string;
  canonical_location_key: string;
  stamp_type: string;
  display_name: string;
  country_code: string;
  lat: number | null;
  lng: number | null;
  earn_count: number;
  status: string;
}

export interface StampDuplicatePair {
  a: StampDuplicateRow;
  b: StampDuplicateRow;
  reason: 'coordinate_proximity' | 'name_similarity';
}

/**
 * Shape returned by GET /admin/stamps/duplicates.
 * Using this type instead of `any` catches mismatched field names at compile
 * time rather than silently at runtime.
 */
export interface StampDuplicatesResponse {
  duplicates: StampDuplicatePair[];
}

export async function getStampDuplicates(): Promise<ApiResult<StampDuplicatesResponse>> {
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

// ── Reconciler run history ─────────────────────────────────────────────────────

/**
 * A single reconciler run as returned by GET /admin/stamps/reconcile/runs.
 * Counts are parsed server-side from the run-summary log row; `fatalError`
 * is non-null when the run aborted. `parseError` is set when the stored
 * summary JSON could not be parsed (counts default to 0 in that case).
 */
export interface ReconcilerRun {
  id: string | null;
  runId: string | null;
  ranAt: string | null;
  resolved: number;
  flagged: number;
  skipped: number;
  enqueued: number;
  combos: number;
  fatalError: string | null;
  ok: boolean;
  parseError?: boolean;
}

export async function getReconcilerRuns(limit = 20): Promise<ApiResult<{ runs: ReconcilerRun[]; total: number }>> {
  return adminGet(`/api/admin/stamps/reconcile/runs?limit=${limit}`);
}

/**
 * Response of POST /admin/stamps/reconcile. The endpoint runs the catalog
 * reconciliation synchronously and returns the run's counts on success.
 */
export interface TriggerReconcileResponse {
  ok: true;
  stats: {
    resolved: number;
    flagged: number;
    skipped: number;
    enqueued: number;
  };
}

export async function triggerReconcilerRun(): Promise<ApiResult<TriggerReconcileResponse>> {
  return adminPost('/api/admin/stamps/reconcile', {});
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
