/**
 * Admin AI Visuals service — typed fetch wrappers for all admin visual
 * generation endpoints. Uses the same auth pattern as other admin services.
 */
import { adminGet, adminPost, adminPut, adminDelete, type AdminApiResult } from './adminApi.ts';

export type { AdminApiResult };

// ── Types ──────────────────────────────────────────────────────────────────────

export interface VisualStats {
  generationsToday: number;
  generationsWeek: number;
  byType: Record<string, number>;
  byStatus: {
    success: number;
    failed: number;
    blocked: number;
    reused: number;
    queued: number;
    generating: number;
  };
  avgAttemptsPerSuccess: number;
  estimatedCostThisMonth: number;
  billableCount: number;
  costPerImage: number;
  providerStatus: 'healthy' | 'degraded' | 'disabled';
  providerEnabled: boolean;
  eventHeadersEnabled: boolean;
  placeHeadersEnabled: boolean;
  queueDepth: number;
  avgGenerationDurationMs: number | null;
  topStyles: { style: string; count: number }[];
  regenerationRate: number;
}

export interface AdminVisual {
  id: string;
  entityType: string;
  entity_type: string;
  entityId: string;
  entity_id: string;
  purpose: string;
  provider: string;
  model: string | null;
  promptVersion: string;
  prompt_version: string;
  promptHash: string;
  prompt_hash: string;
  inputSnapshot: Record<string, unknown> | null;
  input_snapshot: Record<string, unknown> | null;
  finalPrompt: string | null;
  final_prompt: string | null;
  negativePrompt: string | null;
  style: string;
  aspectRatio: string;
  status: string;
  sourceImageUrl: string | null;
  source_image_url: string | null;
  thumbnailPath: string | null;
  thumbnail_path: string | null;
  cardPath: string | null;
  card_path: string | null;
  heroPath: string | null;
  hero_path: string | null;
  sharePath: string | null;
  share_path: string | null;
  moderationStatus: string | null;
  moderation_status: string | null;
  moderationDetails: Record<string, unknown> | null;
  moderation_details: Record<string, unknown> | null;
  failureCode: string | null;
  failure_code: string | null;
  failureMessage: string | null;
  failure_message: string | null;
  attemptCount: number;
  attempt_count: number;
  generationCostEstimate: number | null;
  generation_cost_estimate: number | null;
  generatedAt: string | null;
  generated_at: string | null;
  verifiedAt: string | null;
  accepted_at: string | null;
  replacedAt: string | null;
  replaced_at: string | null;
  createdAt: string;
  created_at: string;
  updatedAt: string;
  updated_at: string;
  ownerUserId: string | null;
  owner_user_id: string | null;
  // Enriched fields
  placeName?: string | null;
  placeCategory?: string | null;
  derivativeUrls?: {
    hero: string | null;
    card: string | null;
    thumbnail: string | null;
    share: string | null;
  };
}

// ── API calls ──────────────────────────────────────────────────────────────────

export function getVisualStats(): Promise<AdminApiResult<{ [K in keyof VisualStats]: VisualStats[K] }>> {
  return adminGet<VisualStats>('/api/admin/visuals/stats');
}

export interface PendingReviewParams {
  page?: number;
  limit?: number;
}

export function getPendingReview(params?: PendingReviewParams): Promise<AdminApiResult<{ visuals: AdminVisual[]; total: number; page: number }>> {
  const qs = new URLSearchParams();
  if (params?.page)  qs.set('page',  String(params.page));
  if (params?.limit) qs.set('limit', String(params.limit));
  const q = qs.toString();
  return adminGet<{ visuals: AdminVisual[]; total: number; page: number }>(
    `/api/admin/visuals/pending-review${q ? `?${q}` : ''}`,
  );
}

export interface HistoryParams {
  page?: number;
  limit?: number;
  entityType?: string;
  entityId?: string;
  status?: string;
  startDate?: string;
  endDate?: string;
}

export function getVisualHistory(params?: HistoryParams): Promise<AdminApiResult<{ visuals: AdminVisual[]; total: number; page: number }>> {
  const qs = new URLSearchParams();
  if (params?.page)       qs.set('page',        String(params.page));
  if (params?.limit)      qs.set('limit',        String(params.limit));
  if (params?.entityType) qs.set('entity_type',  params.entityType);
  if (params?.entityId)   qs.set('entity_id',    params.entityId);
  if (params?.status)     qs.set('status',        params.status);
  if (params?.startDate)  qs.set('start_date',   params.startDate);
  if (params?.endDate)    qs.set('end_date',      params.endDate);
  const q = qs.toString();
  return adminGet<{ visuals: AdminVisual[]; total: number; page: number }>(
    `/api/admin/visuals/history${q ? `?${q}` : ''}`,
  );
}

export function verifyVisual(id: string): Promise<AdminApiResult<{ visual: Pick<AdminVisual, 'id' | 'status' | 'verifiedAt' | 'accepted_at'> }>> {
  return adminPost<{ visual: Pick<AdminVisual, 'id' | 'status' | 'verifiedAt' | 'accepted_at'> }>(
    `/api/admin/visuals/${id}/verify`,
  );
}

export function disableVisual(id: string): Promise<AdminApiResult<{ visual: Pick<AdminVisual, 'id' | 'status' | 'moderationStatus' | 'moderation_status'> }>> {
  return adminPost<{ visual: Pick<AdminVisual, 'id' | 'status' | 'moderationStatus' | 'moderation_status'> }>(
    `/api/admin/visuals/${id}/disable`,
  );
}

export function regenerateVisual(id: string): Promise<AdminApiResult<{ visualId: string; status: string }>> {
  return adminPost<{ visualId: string; status: string }>(
    `/api/admin/visuals/${id}/regenerate`,
  );
}

export function blockVisualEntity(id: string): Promise<AdminApiResult<{ ok: boolean; entityType: string; entityId: string; blocked: boolean }>> {
  return adminPost<{ ok: boolean; entityType: string; entityId: string; blocked: boolean }>(
    `/api/admin/visuals/${id}/block-entity`,
  );
}

export function deleteVisual(id: string): Promise<AdminApiResult<void>> {
  return adminDelete<void>(`/api/admin/visuals/${id}`);
}

export function toggleVisualFlag(flag: string, enabled: boolean): Promise<AdminApiResult<{ flag: { flag: string; enabled: boolean; updated_at: string } }>> {
  return adminPut<{ flag: { flag: string; enabled: boolean; updated_at: string } }>(
    `/api/admin/feature-flags/${encodeURIComponent(flag)}`,
    { enabled },
  );
}
