import { supabase, isSupabaseConfigured } from '../lib/supabase';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function freshToken(): Promise<string | null> {
  const { data: refreshed } = await supabase.auth.refreshSession();
  const session = refreshed?.session ?? (await supabase.auth.getSession()).data.session;
  return session?.access_token ?? null;
}

export interface ReportResult {
  ok: boolean;
  reportId?: string;
  error?: string;
}

export type ReasonCode =
  | 'harassment'
  | 'spam'
  | 'hate_speech'
  | 'violence'
  | 'impersonation'
  | 'nudity'
  | 'misinformation'
  | 'other';

export type TargetType =
  | 'user'
  | 'message'
  | 'thread'
  | 'trip'
  | 'post'
  | 'place'
  | 'event';

export interface ReportParams {
  target_type: TargetType;
  target_id: string;
  reason_code: ReasonCode;
  reason_detail?: string;
  context_type?: string;
  context_id?: string;
}

export async function reportContent(params: ReportParams): Promise<ReportResult> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'Not configured' };
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/reports`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: (body as any).message ?? 'Failed to submit report' };
    }
    const body = await res.json();
    return { ok: true, reportId: body.reportId };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}
