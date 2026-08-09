/**
 * Admin Reports — API service layer.
 * Thin wrappers over GET /api/admin/reports.
 * Requires an authenticated admin user.
 */
import { supabase } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

async function freshToken(): Promise<string | null> {
  return freshApiToken();
}

async function authedFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const token = await freshToken();
  return fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...((opts.headers as Record<string, string>) ?? {}),
    },
  });
}

export interface ContentReport {
  id: string;
  reporter_id: string;
  target_type: string;
  target_id: string;
  reason_code: string;
  reason_detail: string | null;
  severity: string;
  status: string;
  created_at: string;
}

export interface AdminReportsResult {
  reports: ContentReport[];
  total: number;
}

const ALL_STATUSES = ['open', 'in_review', 'resolved', 'dismissed'] as const;

export async function fetchAdminReports(opts: {
  page?: number;
  limit?: number;
  status?: string;
} = {}): Promise<AdminReportsResult> {
  const { page = 1, limit = 50, status = 'open' } = opts;

  // The server (GET /api/admin/reports) paginates with page/limit and filters
  // by a single status, defaulting to 'open'. It has no 'all' value, so
  // emulate it client-side by fetching each status in parallel and merging.
  if (status === 'all') {
    const results = await Promise.all(
      ALL_STATUSES.map((s) => fetchAdminReports({ page, limit, status: s })),
    );
    const reports = results
      .flatMap((r) => r.reports)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return { reports, total: results.reduce((n, r) => n + r.total, 0) };
  }

  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
    status,
  });
  const res = await authedFetch(`${apiBase()}/api/admin/reports?${params}`);
  if (!res.ok) throw new Error(`Failed to load reports: ${res.status}`);
  return res.json() as Promise<AdminReportsResult>;
}

export interface ResolvedReport {
  id: string;
  status: string;
  reviewedAt?: string | null;
  reviewed_at?: string | null;
}

/** POST /api/admin/reports/:id/resolve */
export async function resolveReport(
  id: string,
  action: string,
  notes?: string | null,
): Promise<{ report: ResolvedReport; audit: unknown }> {
  const res = await authedFetch(`${apiBase()}/api/admin/reports/${id}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ action, notes: notes ?? null }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any)?.message ?? `Failed to resolve report: ${res.status}`);
  }
  return res.json();
}

/** POST /api/admin/reports/:id/dismiss */
export async function dismissReport(
  id: string,
  notes?: string | null,
): Promise<{ report: ResolvedReport; audit: unknown }> {
  const res = await authedFetch(`${apiBase()}/api/admin/reports/${id}/dismiss`, {
    method: 'POST',
    body: JSON.stringify({ notes: notes ?? null }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any)?.message ?? `Failed to dismiss report: ${res.status}`);
  }
  return res.json();
}
