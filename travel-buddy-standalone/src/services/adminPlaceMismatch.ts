/**
 * Admin service — place mismatch reports.
 *
 * Wraps the two admin endpoints:
 *   GET  /api/admin/place-mismatch-reports?status=pending|resolved&limit=50&before=<uuid>
 *   POST /api/admin/place-mismatch-reports/:id/resolve  { action: 'accept' | 'reject' }
 */
import { adminGet, adminPost } from './adminApi.ts';

export interface PlaceMismatchReport {
  id: string;
  post_id: string;
  reporter_id: string;
  reported_place_id: string | null;
  reason: string | null;
  status: 'pending' | 'resolved';
  resolved_action: 'accept' | 'reject' | null;
  resolved_at: string | null;
  created_at: string;
  /** Snippet of the post body, joined server-side from posts.content */
  post_content: string | null;
  /** Human-readable place name, joined server-side from places.name */
  place_name: string | null;
}

export interface ListPlaceMismatchReportsParams {
  status?: 'pending' | 'resolved';
  limit?: number;
  before?: string;
}

export interface ListPlaceMismatchReportsResponse {
  reports: PlaceMismatchReport[];
  total: number;
  status: string;
}

export async function listPlaceMismatchReports(
  params: ListPlaceMismatchReportsParams = {},
): Promise<ListPlaceMismatchReportsResponse> {
  const { status = 'pending', limit = 50, before } = params;
  const qs = new URLSearchParams({ status, limit: String(limit) });
  if (before) qs.set('before', before);

  const res = await adminGet<ListPlaceMismatchReportsResponse>(
    `/api/admin/place-mismatch-reports?${qs}`,
  );
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

export async function resolvePlaceMismatchReport(
  reportId: string,
  action: 'accept' | 'reject',
): Promise<void> {
  const res = await adminPost<{ ok: boolean }>(
    `/api/admin/place-mismatch-reports/${reportId}/resolve`,
    { action },
  );
  if (!res.ok) throw new Error(res.error);
}
