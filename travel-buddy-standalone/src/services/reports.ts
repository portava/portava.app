import { supabase, isSupabaseConfigured } from '../lib/supabase';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function freshToken(): Promise<string | null> {
  const { data: refreshed } = await supabase.auth.refreshSession();
  const session = refreshed?.session ?? (await supabase.auth.getSession()).data.session;
  return session?.access_token ?? null;
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

export interface ReportResult {
  ok: boolean;
  data?: { reportId: string };
  error?: string;
}

export async function submitReport(payload: SubmitReportPayload): Promise<ReportResult> {
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
    return { ok: false, error: e.message };
  }
}
