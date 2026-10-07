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

// ── The moderation_reports queue (what the in-app Report button writes) ─────
//
// The screen above reads the LEGACY `reports` table (GET /api/admin/reports).
// The in-app report flow (src/services/moderation.ts) writes `moderation_reports`,
// which only GET /api/admin/moderation/reports lists and only
// POST /api/admin/moderation/reports/:id/review acts on. Until these two
// functions, no client read that queue at all (census-trust TV-4a; verifier
// finding 10, 2026-10-06).

export type ModerationReportStatus = 'open' | 'reviewing' | 'actioned' | 'dismissed';
export type ModerationReviewDecision = 'reviewing' | 'actioned' | 'dismissed';

/** lib/moderationReportSnapshots.ts on the server: a failed read is never "missing content". */
export type ModerationSubjectSnapshot =
  | { state: 'ok'; [k: string]: unknown }
  | { state: 'not_found' }
  | { state: 'unavailable' }
  | { state: 'unsupported' };

export interface ModerationReport {
  id: string;
  reporter_id: string | null;
  subject_type: string;
  subject_id: string;
  subject_user_id: string | null;
  category: string;
  details: string | null;
  status: ModerationReportStatus;
  created_at: string;
  resolved_at: string | null;
  subject_snapshot: ModerationSubjectSnapshot;
}

export interface ModerationReportsResult {
  reports: ModerationReport[];
  total: number;
  page: number;
  /** Subject types whose snapshot read FAILED on this page — the page is not complete. */
  snapshotsUnavailableFor?: string[];
}

/** GET /api/admin/moderation/reports */
export async function fetchModerationReports(opts: {
  page?: number;
  limit?: number;
  status?: ModerationReportStatus | 'all';
  category?: string;
} = {}): Promise<ModerationReportsResult> {
  const { page = 1, limit = 30, status = 'open', category = 'all' } = opts;
  const params = new URLSearchParams({ page: String(page), limit: String(limit), status, category });
  const res = await authedFetch(`${apiBase()}/api/admin/moderation/reports?${params}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any)?.message ?? `Failed to load the moderation queue: ${res.status}`);
  }
  return res.json() as Promise<ModerationReportsResult>;
}

/** Why a review was not applied, as the server says it. */
export class ModerationReviewError extends Error {
  constructor(
    message: string,
    /** 409: someone else moved it first, or the move is not allowed from its status. 503: try again. */
    readonly status: number,
  ) {
    super(message);
    this.name = 'ModerationReviewError';
  }
}

/** POST /api/admin/moderation/reports/:id/review — the server writes the audit row; the note never reaches the reporter. */
export async function reviewModerationReport(
  id: string,
  decision: ModerationReviewDecision,
  note?: string | null,
): Promise<{ report: { id: string; status: ModerationReportStatus } }> {
  const res = await authedFetch(`${apiBase()}/api/admin/moderation/reports/${id}/review`, {
    method: 'POST',
    body: JSON.stringify(note && note.trim() ? { decision, note: note.trim() } : { decision }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ModerationReviewError((body as any)?.message ?? `Review failed: ${res.status}`, res.status);
  }
  return res.json();
}
