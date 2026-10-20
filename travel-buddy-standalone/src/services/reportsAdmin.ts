/**
 * Admin Reports — API service layer.
 * Thin wrappers over GET /api/admin/reports.
 * Requires an authenticated admin user.
 */
import { supabase } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';
import { z } from 'zod';
import { captureMessagingOwnerRequest, messagingOwnerToken, type MessagingOwnerRequest } from './messagingOwnerRequest.ts';

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

/**
 * lib/moderationReportSnapshots.ts loadCapturedReportContent on the server (lead
 * ruling Q-L23 / D-38a): the content as it was when the report was filed, for
 * moderators only. `unavailable` is a failed read, `not_deployed` means the
 * capture table does not exist on that database — neither is "nothing captured".
 */
export type ModerationCapturedContent =
  | { state: 'captured'; capture: { capture_state: ModerationSubjectSnapshot['state']; snapshot: Record<string, unknown>; captured_at: string } }
  | { state: 'none' }
  | { state: 'unavailable' }
  | { state: 'not_deployed' };

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
  /** Absent on a server without the capture build. */
  captured_content?: ModerationCapturedContent;
}

export interface ModerationReportsResult {
  reports: ModerationReport[];
  total: number;
  page: number;
  /** Subject types whose snapshot read FAILED on this page — the page is not complete. */
  snapshotsUnavailableFor?: string[];
  /** The captures could not be read on this page. */
  capturedContentUnavailable?: boolean;
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

const removalId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).transform(value => value.toLowerCase());
const removalToken = z.string().regex(/^[0-9a-f]{64}$/);
const removalContextSchema = z.object({
  contractVersion: z.literal(1), reviewId: removalId, reportId: removalId, reportStatus: z.enum(['open', 'reviewing']),
  reviewToken: removalToken, reportToken: removalToken,
  review: z.object({ rating: z.number().int().min(1).max(5), body: z.string().nullable(), state: z.enum(['published', 'hidden']),
    entityType: z.enum(['trip', 'rent_buddy_booking', 'place']), entityId: removalId }),
});
const removalIntentSchema = z.object({
  operationId: removalId, reviewId: removalId, reportId: removalId, reviewToken: removalToken, reportToken: removalToken,
  reason: z.string().trim().refine(value => Array.from(value).length > 0 && Array.from(value).length <= 1000),
}).strict();
const removalReceiptSchema = z.object({
  ok: z.literal(true), contractVersion: z.literal(1), operationId: removalId, reviewId: removalId, reportId: removalId,
  auditId: removalId, stateAtCommit: z.literal('removed'), replayed: z.boolean(),
  committedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/).refine(value => Number.isFinite(Date.parse(value))),
});

export type ReportedReviewRemovalContext = z.infer<typeof removalContextSchema>;
export type ReportedReviewRemovalIntent = Readonly<z.infer<typeof removalIntentSchema>>;
export function newReportedReviewOperationId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (crypto?.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const random = Math.floor(Math.random() * 16);
    return (character === 'x' ? random : (random & 3) | 8).toString(16);
  });
}

export interface ReportedReviewRequest {
  readonly owner: MessagingOwnerRequest;
  readonly reviewId: string;
  readonly reportId: string;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
}

export class ReportedReviewRemovalError extends Error {
  constructor(readonly status: number) {
    super(status === 409 ? 'The review or report changed. Reload its context before confirming a new removal.'
      : status === 400 ? 'A reason of 1–1000 characters and a valid confirmation are required.'
      : status === 401 || status === 403 ? 'The current account cannot remove this review.'
      : status === 404 ? 'This review or report is no longer available.'
      : 'Audited removal is unavailable. A sent request may have committed; retry the same operation to recover its result.');
    this.name = 'ReportedReviewRemovalError';
  }
}

function assertRemovalCurrent(request: ReportedReviewRequest): void {
  if (request.signal.aborted || !request.isCurrent() || !request.owner.isCurrent()) throw new ReportedReviewRemovalError(401);
}

async function removalFetch(request: ReportedReviewRequest, suffix: string, init: RequestInit = {}): Promise<unknown> {
  assertRemovalCurrent(request);
  const tokenOwner = captureMessagingOwnerRequest();
  if (!tokenOwner || tokenOwner.ownerId !== request.owner.ownerId || tokenOwner.sessionId !== request.owner.sessionId) {
    tokenOwner?.invalidate();
    throw new ReportedReviewRemovalError(503);
  }
  const controller = new AbortController();
  let abort!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => {
      controller.abort();
      reject(new ReportedReviewRemovalError(503));
    };
  });
  const assertActive = () => {
    assertRemovalCurrent(request);
    if (controller.signal.aborted) throw new ReportedReviewRemovalError(503);
  };
  request.signal.addEventListener('abort', abort);
  const timer = setTimeout(abort, 7000);
  try {
    const token = await Promise.race([messagingOwnerToken(tokenOwner), interrupted]);
    assertActive();
    if (!token) throw new ReportedReviewRemovalError(503);
    const response = await Promise.race([fetch(`${apiBase()}/api/reviews/${request.reviewId}/${suffix}`, {
      ...init, signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...((init.headers as Record<string, string>) ?? {}) },
    }), interrupted]);
    assertActive();
    if (!response.ok) throw new ReportedReviewRemovalError(response.status);
    const data: unknown = await Promise.race([response.json(), interrupted]);
    assertActive();
    return data;
  } catch (error) {
    if (error instanceof ReportedReviewRemovalError) throw error;
    throw new ReportedReviewRemovalError(503);
  } finally {
    tokenOwner.invalidate();
    clearTimeout(timer);
    request.signal.removeEventListener('abort', abort);
  }
}

export async function fetchReportedReviewRemovalContext(request: ReportedReviewRequest): Promise<ReportedReviewRemovalContext> {
  if (!removalId.safeParse(request.reviewId).success || !removalId.safeParse(request.reportId).success) throw new ReportedReviewRemovalError(400);
  const result = removalContextSchema.safeParse(await removalFetch(request, `reported-removal-context?report_id=${request.reportId}`));
  if (!result.success || result.data.reviewId !== request.reviewId || result.data.reportId !== request.reportId) throw new ReportedReviewRemovalError(503);
  return result.data;
}

export async function removeReportedReview(request: ReportedReviewRequest, intent: ReportedReviewRemovalIntent) {
  const input = removalIntentSchema.safeParse(intent);
  if (!input.success || input.data.reviewId !== request.reviewId || input.data.reportId !== request.reportId) throw new ReportedReviewRemovalError(400);
  const result = removalReceiptSchema.safeParse(await removalFetch(request, 'reported-removal', {
    method: 'POST', headers: { 'Idempotency-Key': input.data.operationId },
    body: JSON.stringify({ report_id: input.data.reportId, reason: input.data.reason,
      expected_review_token: input.data.reviewToken, expected_report_token: input.data.reportToken }),
  }));
  if (!result.success || result.data.reviewId !== intent.reviewId || result.data.reportId !== intent.reportId || result.data.operationId !== intent.operationId) {
    throw new ReportedReviewRemovalError(503);
  }
  return result.data;
}
