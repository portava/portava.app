/**
 * Admin Media service — typed fetch wrappers for the admin media review
 * and moderation endpoints.
 */
import { adminGet, adminPost, type AdminApiResult } from './adminApi.ts';

export type { AdminApiResult };

// ── Types ──────────────────────────────────────────────────────────────────────

export interface MediaPaginatedResponse<T> {
  items: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    hasMore: boolean;
  };
}

export interface MediaProcessingFailure {
  id: string;
  post_id: string;
  media_type: string;
  processing_status: string;
  moderation_status: string | null;
  public_url: string | null;
  thumbnail_url: string | null;
  storage_path: string | null;
  storage_bucket: string | null;
  created_at: string;
  updated_at: string | null;
  post: {
    author_id: string;
    has_video: boolean;
    visibility: string;
  } | null;
}

export interface MediaReport {
  id: string;
  /** Unified reports table: target_type = 'post' for media reports */
  target_type: string;
  target_id: string;
  reporter_id: string | null;
  reason_code: string;
  reason_detail: string | null;
  moderation_notes: string | null;
  severity: string;
  status: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
  primaryMedia: {
    media_type: string;
    public_url: string | null;
    thumbnail_url: string | null;
  } | null;
}

export interface WrongPlaceReport {
  id: string;
  /** Unified reports table: target_type = 'hidden_gem' for wrong-place reports */
  target_type: string;
  target_id: string;
  reporter_id: string | null;
  reason_code: string;
  reason_detail: string | null;
  moderation_notes: string | null;
  severity: string;
  status: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GemPendingItem {
  id: string;
  name: string;
  category: string;
  city: string;
  submitted_by: string | null;
  status: string;
  description: string | null;
  vibe_tags: string[] | null;
  image_url: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface AiProvenanceItem {
  id: string;
  post_id?: string;
  entity_type?: string;
  entity_id?: string;
  media_type?: string;
  image_source_type?: string;
  accuracy_status?: string;
  public_url?: string | null;
  source_url?: string | null;
  thumbnail_url?: string | null;
  generated_with_ai?: boolean;
  disclaimer_required?: boolean;
  moderation_status?: string | null;
  created_at: string;
}

// ── API helpers ───────────────────────────────────────────────────────────────

export function getMediaProcessingFailures(
  opts: { page?: number; limit?: number } = {},
): Promise<AdminApiResult<MediaPaginatedResponse<MediaProcessingFailure>>> {
  const params = new URLSearchParams();
  if (opts.page)  params.set('page',  String(opts.page));
  if (opts.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return adminGet(`/api/admin/media/processing-failures${qs ? `?${qs}` : ''}`);
}

export function getMediaReported(
  opts: { page?: number; limit?: number; status?: string } = {},
): Promise<AdminApiResult<MediaPaginatedResponse<MediaReport>>> {
  const params = new URLSearchParams();
  if (opts.page)   params.set('page',   String(opts.page));
  if (opts.limit)  params.set('limit',  String(opts.limit));
  if (opts.status) params.set('status', opts.status);
  const qs = params.toString();
  return adminGet(`/api/admin/media/reported${qs ? `?${qs}` : ''}`);
}

export function getMediaWrongPlace(
  opts: { page?: number; limit?: number; status?: string } = {},
): Promise<AdminApiResult<MediaPaginatedResponse<WrongPlaceReport>>> {
  const params = new URLSearchParams();
  if (opts.page)   params.set('page',   String(opts.page));
  if (opts.limit)  params.set('limit',  String(opts.limit));
  if (opts.status) params.set('status', opts.status);
  const qs = params.toString();
  return adminGet(`/api/admin/media/wrong-place${qs ? `?${qs}` : ''}`);
}

export function getMediaGemsPending(
  opts: { page?: number; limit?: number } = {},
): Promise<AdminApiResult<MediaPaginatedResponse<GemPendingItem>>> {
  const params = new URLSearchParams();
  if (opts.page)  params.set('page',  String(opts.page));
  if (opts.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return adminGet(`/api/admin/media/gems-pending${qs ? `?${qs}` : ''}`);
}

export function getMediaAiProvenance(
  opts: { page?: number; limit?: number } = {},
): Promise<AdminApiResult<MediaPaginatedResponse<AiProvenanceItem>>> {
  const params = new URLSearchParams();
  if (opts.page)  params.set('page',  String(opts.page));
  if (opts.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return adminGet(`/api/admin/media/ai-provenance${qs ? `?${qs}` : ''}`);
}

export function moderateMediaItem(
  id: string,
  action: 'approve' | 'reject' | 'flag',
  opts: {
    target?: 'post' | 'post_media' | 'hidden_gem' | 'report';
    reason?: string;
  } = {},
): Promise<AdminApiResult<{ ok: boolean; id: string; action: string; target: string }>> {
  return adminPost(`/api/admin/media/${id}/moderate`, {
    action,
    ...(opts.target ? { target: opts.target } : {}),
    ...(opts.reason ? { reason: opts.reason } : {}),
  });
}
