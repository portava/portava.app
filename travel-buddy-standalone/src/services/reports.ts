import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';
import { serviceFailure, thrownFailure } from './serviceFailure.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function freshToken(): Promise<string | null> {
  return freshApiToken();
}

export type ReportReason =
  | 'harassment'
  | 'spam'
  | 'hate_speech'
  | 'violence'
  | 'impersonation'
  | 'nudity'
  | 'misinformation'
  | 'inappropriate_content'
  | 'fake_account'
  | 'other';

export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  harassment: 'Harassment or bullying',
  spam: 'Spam',
  hate_speech: 'Hate speech',
  violence: 'Violence',
  impersonation: 'Impersonation',
  nudity: 'Nudity',
  misinformation: 'Misinformation',
  inappropriate_content: 'Inappropriate content',
  fake_account: 'Fake or scam account',
  other: 'Something else',
};

export interface SubmitReportPayload {
  targetUserId: string;
  reason: ReportReason;
  details?: string;
}

interface SubmitReportBody {
  target_type: 'user';
  target_id: string;
  reason_code: string;
  reason_detail?: string;
}

export interface ReportResult {
  ok: boolean;
  data?: { reportId: string };
  error?: string;
}

/** Alias: generic "reason code" for content-level reports */
export type ReasonCode = ReportReason;

export interface ReportContentPayload {
  target_type: string;
  target_id:   string;
  reason_code: ReasonCode;
  reason_detail?: string;
}

/** Report a piece of content (message, post, etc.) to the moderation team */
export async function reportContent(payload: ReportContentPayload): Promise<ReportResult> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'Not configured' };
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/reports`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: (body as any).message ?? 'Failed to submit report' };
    }
    const body = await res.json();
    return { ok: true, data: { reportId: body.reportId } };
  } catch (e: any) {
    return { ok: false, error: thrownFailure('reports', e) };
  }
}

export async function submitReport(payload: SubmitReportPayload): Promise<ReportResult> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'Not configured' };
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };

  const REASON_MAP: Record<ReportReason, string> = {
    harassment:           'harassment',
    spam:                 'spam',
    hate_speech:          'hate_speech',
    violence:             'violence',
    impersonation:        'impersonation',
    nudity:               'nudity',
    misinformation:       'misinformation',
    inappropriate_content: 'other',
    fake_account:         'other',
    other:                'other',
  };

  const body: SubmitReportBody = {
    target_type:   'user',
    target_id:     payload.targetUserId,
    reason_code:   REASON_MAP[payload.reason] ?? 'other',
    reason_detail: payload.details,
  };

  try {
    const res = await fetch(`${apiBase()}/api/reports`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      return { ok: false, error: (errBody as any).message ?? 'Failed to submit report' };
    }
    const respBody = await res.json();
    return { ok: true, data: { reportId: respBody.reportId } };
  } catch (e: any) {
    return { ok: false, error: thrownFailure('reports', e) };
  }
}
