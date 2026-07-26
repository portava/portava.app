/**
 * Admin Place Images service — typed fetch wrappers for all admin
 * place-image review and moderation endpoints.
 */
import { adminGet, adminPost, type AdminApiResult } from './adminApi.ts';

export type { AdminApiResult };

// ── Types ──────────────────────────────────────────────────────────────────────

export interface PlaceImageQueueItem {
  id: string;
  entity_type: string;
  entity_id: string;
  canonical_place_id: string | null;
  source_image_url: string | null;
  source_url: string | null;
  image_source_type: string | null;
  accuracy_status: string;
  reference_asset_ids: string[] | null;
  reference_image_count: number | null;
  generation_method: string | null;
  generated_with_ai: boolean;
  disclaimer_required: boolean;
  verified_by: string | null;
  verified_at: string | null;
  created_at: string;
  reportCount: number;
  needsReview: boolean;
}

export interface PlaceImageDetail {
  visual: PlaceImageQueueItem & {
    source_provider: string | null;
    source_license: string | null;
    source_attribution: string | null;
    provider_place_id: string | null;
    verification_status: string | null;
    disclaimer_text: string | null;
  };
  place: {
    id: string;
    name: string;
    primary_category: string;
    city: string | null;
    country_code: string | null;
    latitude: number | null;
    longitude: number | null;
  } | null;
  userReports: PlaceImageReport[];
  needsReview: boolean;
}

export interface PlaceImageReport {
  id: string;
  place_id: string;
  image_url: string;
  reported_by: string | null;
  report_reason: string;
  status: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  reporterHandle: string | null;
  priorReviewActions: {
    visualId: string;
    accuracyStatus: string;
    verifiedBy: string | null;
    verifiedAt: string | null;
  } | null;
}

export interface PlaceImageQueueResponse {
  items: PlaceImageQueueItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    hasMore: boolean;
  };
}

export interface PlaceImageReportsResponse {
  items: PlaceImageReport[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    hasMore: boolean;
  };
}

// ── API helpers ───────────────────────────────────────────────────────────────

export interface QueueFilters {
  page?: number;
  limit?: number;
  accuracy_status?: string;
  image_source_type?: string;
  has_reports?: boolean;
}

export function getPlaceImageQueue(
  filters: QueueFilters = {},
): Promise<AdminApiResult<PlaceImageQueueResponse>> {
  const params = new URLSearchParams();
  if (filters.page)              params.set('page',  String(filters.page));
  if (filters.limit)             params.set('limit', String(filters.limit));
  if (filters.accuracy_status)   params.set('accuracy_status',   filters.accuracy_status);
  if (filters.image_source_type) params.set('image_source_type', filters.image_source_type);
  if (filters.has_reports !== undefined) params.set('has_reports', String(filters.has_reports));
  const qs = params.toString();
  return adminGet<PlaceImageQueueResponse>(`/api/admin/place-images/queue${qs ? `?${qs}` : ''}`);
}

export function getPlaceImageDetail(
  visualId: string,
): Promise<AdminApiResult<PlaceImageDetail>> {
  return adminGet<PlaceImageDetail>(`/api/admin/place-images/${visualId}`);
}

export function approvePlaceImage(
  visualId: string,
): Promise<AdminApiResult<{ ok: boolean; visualId: string; accuracyStatus: string }>> {
  return adminPost(`/api/admin/place-images/${visualId}/approve`);
}

export function rejectPlaceImage(
  visualId: string,
  reason: string,
): Promise<AdminApiResult<{ ok: boolean; visualId: string }>> {
  return adminPost(`/api/admin/place-images/${visualId}/reject`, { reason });
}

export function downgradePlaceImage(
  visualId: string,
): Promise<AdminApiResult<{ ok: boolean; visualId: string }>> {
  return adminPost(`/api/admin/place-images/${visualId}/downgrade`);
}

export function replacePlaceImage(
  visualId: string,
  imageUrl: string,
  imageSourceType: string,
): Promise<AdminApiResult<{ ok: boolean; archivedVisualId: string; newVisualId: string | null }>> {
  return adminPost(`/api/admin/place-images/${visualId}/replace`, { imageUrl, imageSourceType });
}

export function getPlaceImageReports(
  opts: { page?: number; limit?: number; status?: string } = {},
): Promise<AdminApiResult<PlaceImageReportsResponse>> {
  const params = new URLSearchParams();
  if (opts.page)   params.set('page',   String(opts.page));
  if (opts.limit)  params.set('limit',  String(opts.limit));
  if (opts.status) params.set('status', opts.status);
  const qs = params.toString();
  return adminGet<PlaceImageReportsResponse>(`/api/admin/place-images/reports${qs ? `?${qs}` : ''}`);
}

export function resolvePlaceImageReport(
  reportId: string,
  action: 'image_replaced' | 'image_rejected' | 'no_action',
  adminNotes?: string,
): Promise<AdminApiResult<{ ok: boolean; reportId: string; action: string }>> {
  return adminPost(`/api/admin/place-images/reports/${reportId}/resolve`, {
    action,
    ...(adminNotes ? { adminNotes } : {}),
  });
}
