/**
 * Moderation service — V-3
 *
 * Wraps POST /api/moderation/report and GET /api/moderation/reports/mine.
 * The old /api/reports endpoint (reports.ts) is left untouched.
 */
import { isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function freshToken(): Promise<string | null> {
  return freshApiToken();
}

// ── Enum types ────────────────────────────────────────────────────────────────

export type ModerationSubjectType =
  | 'user'
  | 'post'
  | 'comment'
  | 'message'
  | 'event'
  | 'review'
  | 'buddy_listing';

export type ModerationCategory =
  | 'impersonation'
  | 'harassment'
  | 'scam_fraud'
  | 'inappropriate_content'
  | 'safety_concern'
  | 'underage'
  | 'spam'
  | 'other';

export const MODERATION_CATEGORY_LABELS: Record<ModerationCategory, string> = {
  impersonation:         'Impersonation',
  harassment:            'Harassment or bullying',
  scam_fraud:            'Scam or fraud',
  inappropriate_content: 'Inappropriate content',
  safety_concern:        'Safety concern',
  underage:              'Underage person',
  spam:                  'Spam',
  other:                 'Something else',
};

export const MODERATION_SUBJECT_LABELS: Record<ModerationSubjectType, string> = {
  user:          'User',
  post:          'Post',
  comment:       'Comment',
  message:       'Message',
  event:         'Event',
  review:        'Review',
  buddy_listing: 'Buddy listing',
};

// ── Payload / result types ────────────────────────────────────────────────────

export interface SubmitModerationReportPayload {
  subjectType: ModerationSubjectType;
  subjectId:   string;
  category:    ModerationCategory;
  details?:    string;
  threadId?:   string;
}

export interface ModerationReportResult {
  ok:        boolean;
  reportId?: string;
  message?:  string;
  error?:    string;
}

export interface ModerationReport {
  id:           string;
  subject_type: ModerationSubjectType;
  category:     ModerationCategory;
  status:       'open' | 'reviewing' | 'actioned' | 'dismissed';
  created_at:   string;
}

export interface GetMyReportsResult {
  ok:       boolean;
  reports:  ModerationReport[];
  error?:   string;
}

// ── Service functions ─────────────────────────────────────────────────────────

export async function submitModerationReport(
  payload: SubmitModerationReportPayload,
): Promise<ModerationReportResult> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'Not configured' };
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };

  try {
    const res = await fetch(`${apiBase()}/api/moderation/report`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: (json as any).message ?? `HTTP ${res.status}` };
    }
    return { ok: true, reportId: (json as any).reportId, message: (json as any).message };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Network error' };
  }
}

export async function getMyModerationReports(
  limit = 50,
): Promise<GetMyReportsResult> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, reports: [], error: 'Not configured' };
  const token = await freshToken();
  if (!token) return { ok: false, reports: [], error: 'Not authenticated' };

  try {
    const res = await fetch(`${apiBase()}/api/moderation/reports/mine?limit=${limit}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reports: [], error: (json as any).message ?? `HTTP ${res.status}` };
    return { ok: true, reports: (json as any).reports ?? [] };
  } catch (e: any) {
    return { ok: false, reports: [], error: e?.message ?? 'Network error' };
  }
}
