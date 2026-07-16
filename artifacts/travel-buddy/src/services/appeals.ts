import { supabase } from '../lib/supabase';
import { freshToken as freshApiToken } from './apiToken.ts';

export type AppealTargetType =
  | 'post'
  | 'memory'
  | 'highlight'
  | 'account_warning'
  | 'trust_score_event'
  | 'no_show'
  | 'event_membership'
  | 'trip_membership'
  | 'review';

export type AppealState = 'submitted' | 'under_review' | 'approved' | 'denied';

export interface Appeal {
  id: string;
  targetType: AppealTargetType;
  targetId: string;
  reason: string;
  evidenceUrl: string | null;
  state: AppealState;
  resolutionNote: string | null;
  createdAt: string;
  updatedAt: string;
}

async function freshToken(): Promise<string | null> {
  return freshApiToken();
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await freshToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

const apiBase = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
const api = (path: string) => `${apiBase}/api/${path}`;

export async function submitAppeal(params: {
  targetType: AppealTargetType;
  targetId: string;
  reason: string;
  evidenceUrl?: string;
}): Promise<Appeal> {
  const res = await fetch(api('appeals'), {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({
      targetType:  params.targetType,
      targetId:    params.targetId,
      reason:      params.reason,
      evidenceUrl: params.evidenceUrl,
    }),
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw Object.assign(
      new Error((json as any).message ?? 'Failed to submit appeal'),
      { code: (json as any).error },
    );
  }
  return res.json();
}

export async function getMyAppeals(
  page = 1,
  limit = 20,
): Promise<{ appeals: Appeal[]; page: number; limit: number }> {
  const res = await fetch(api(`appeals/me?page=${page}&limit=${limit}`), {
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error('Failed to load appeals');
  return res.json();
}
