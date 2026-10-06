/**
 * Telegraph §30A.6 — a member's notification policy for one thread, client side.
 *
 *   GET /api/threads/:id/notification-policy
 *   PUT /api/threads/:id/notification-policy   { level, muteForMinutes? }
 *
 * The server says which choices this deployment can store (`levelsAvailable`,
 * `temporaryMuteAvailable`) and the screen offers only those. The answer to a
 * PUT is what the server READ BACK, so the sheet shows what is stored, never
 * what was asked for. SAFETY notifications are never suppressed by any choice
 * here, and the sheet says so.
 */
import { isSupabaseConfigured } from '../../../lib/supabase.ts';
import { freshToken } from '../../../services/apiToken.ts';

export type ThreadNotificationLevel = 'ALL' | 'MENTIONS' | 'IMPORTANT' | 'MUTED';

export interface ThreadNotificationPolicy {
  threadId: string;
  level: ThreadNotificationLevel;
  mutedUntil: string | null;
  temporaryMuteActive: boolean;
  levelsAvailable: ThreadNotificationLevel[];
  temporaryMuteAvailable: boolean;
  temporaryMuteMinutes: number[];
  safetyAlwaysDelivers: boolean;
}

export type PolicyResult =
  | { ok: true; data: ThreadNotificationPolicy }
  | { ok: false; error: string; message?: string };

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function call(path: string, init?: RequestInit): Promise<PolicyResult> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'unconfigured' };
  const token = await freshToken();
  if (!token) return { ok: false, error: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${token}`,
      },
    });
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    if (!res.ok) {
      return { ok: false, error: String(body?.error ?? res.status), message: typeof body?.message === 'string' ? body.message : undefined };
    }
    return { ok: true, data: body as ThreadNotificationPolicy };
  } catch (e) {
    return { ok: false, error: 'network', message: e instanceof Error ? e.message : undefined };
  }
}

export function fetchThreadNotificationPolicy(threadId: string): Promise<PolicyResult> {
  return call(`/api/threads/${threadId}/notification-policy`);
}

export function setThreadNotificationPolicy(
  threadId: string,
  level: ThreadNotificationLevel,
  muteForMinutes: number | null = null,
): Promise<PolicyResult> {
  return call(`/api/threads/${threadId}/notification-policy`, {
    method: 'PUT',
    body: JSON.stringify(muteForMinutes === null ? { level } : { level, muteForMinutes }),
  });
}

/** Copy for each level — what the member will and will not be told. */
export const LEVEL_COPY: Record<ThreadNotificationLevel, { label: string; sub: string }> = {
  ALL: { label: 'All activity', sub: 'Mentions, plan changes, calls and messages.' },
  MENTIONS: { label: 'Mentions only', sub: 'Only when someone @mentions you.' },
  IMPORTANT: { label: 'Important only', sub: 'Mentions, plan changes, coordination and calls — not ordinary messages.' },
  MUTED: { label: 'Muted', sub: 'Nothing from this conversation.' },
};

export function muteDurationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const h = minutes / 60;
  return h === 1 ? '1 hour' : h === 24 ? '24 hours' : `${h} hours`;
}

/** The one line every state of the sheet carries. */
export const SAFETY_COPY = 'Safety alerts always reach you, whatever you choose here.';
