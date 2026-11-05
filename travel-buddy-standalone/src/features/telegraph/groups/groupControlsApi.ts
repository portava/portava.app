/**
 * Telegraph §30A.12 — large-group controls, client side (census T417).
 *
 *   GET    /api/threads/:id/controls                         -> { controls, isHost, mutedUntil }
 *   PUT    /api/threads/:id/controls                         { slowModeSeconds?, postingPolicy?, mediaPolicy?, linkPolicy? }
 *   POST   /api/threads/:id/moderation/:userId/mute          { minutes? }  (none = until lifted)
 *   DELETE /api/threads/:id/moderation/:userId/mute
 *   POST   /api/threads/:id/moderation/:userId/remove        (a `group` only: a trip's or circle's roster is its own)
 *
 * The server enforces every control at every send door and decides who is a host; this module only
 * asks and tells. The screen shows what the server READ BACK, never what was asked for.
 */
import { isSupabaseConfigured } from '../../../lib/supabase.ts';
import { freshToken } from '../../../services/apiToken.ts';

export const GROUP_CONTROLS_FLAG = 'telegraph_group_controls_enabled';
/** The conversation kinds that have host controls (domain/telegraph/policies/groupControlsPolicy.ts). */
export const GROUP_CONTROLLED_THREAD_TYPES: readonly string[] = ['group', 'trip', 'circle'];
export const SLOW_MODE_CHOICES: readonly number[] = [0, 30, 60, 300, 900, 3600];
export const MUTE_CHOICES_MINUTES: readonly (number | null)[] = [60, 24 * 60, null];

export type AudiencePolicy = 'everyone' | 'hosts_only';

export interface GroupControls {
  slowModeSeconds: number;
  postingPolicy: AudiencePolicy;
  mediaPolicy: AudiencePolicy;
  linkPolicy: AudiencePolicy;
}

export interface GroupControlsState {
  controls: GroupControls;
  isHost: boolean;
  /** The caller's OWN mute: an ISO time, 'indefinite', or null. */
  mutedUntil: string | null;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string; message: string };

const NOT_CHANGED = 'Nothing was changed. Please try again.';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function call(path: string, init?: RequestInit): Promise<ApiResult<any>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'unconfigured', message: NOT_CHANGED };
  const token = await freshToken();
  if (!token) return { ok: false, error: 'unauthenticated', message: NOT_CHANGED };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      ...init,
      headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${token}` },
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) {
      return { ok: false, error: String(body?.error ?? res.status), message: typeof body?.message === 'string' && body.message ? body.message : NOT_CHANGED };
    }
    return { ok: true, data: body };
  } catch {
    return { ok: false, error: 'network', message: NOT_CHANGED };
  }
}

const isPolicy = (v: unknown): v is AudiencePolicy => v === 'everyone' || v === 'hosts_only';

/** The wire's controls, or null when the answer is not controls at all (never guessed into defaults). */
export function parseControls(v: unknown): GroupControls | null {
  const c = v as Record<string, unknown> | null;
  if (!c || typeof c !== 'object') return null;
  const s = Number(c.slowModeSeconds);
  if (!Number.isFinite(s) || s < 0) return null;
  if (!isPolicy(c.postingPolicy) || !isPolicy(c.mediaPolicy) || !isPolicy(c.linkPolicy)) return null;
  return { slowModeSeconds: Math.floor(s), postingPolicy: c.postingPolicy, mediaPolicy: c.mediaPolicy, linkPolicy: c.linkPolicy };
}

export async function fetchGroupControls(threadId: string): Promise<ApiResult<GroupControlsState>> {
  const r = await call(`/api/threads/${threadId}/controls`);
  if (!r.ok) return r;
  const controls = parseControls(r.data?.controls);
  if (!controls) return { ok: false, error: 'malformed_response', message: 'We could not read this conversation\'s settings.' };
  return { ok: true, data: { controls, isHost: r.data?.isHost === true, mutedUntil: typeof r.data?.mutedUntil === 'string' ? r.data.mutedUntil : null } };
}

export async function setGroupControls(threadId: string, patch: Partial<GroupControls>): Promise<ApiResult<GroupControls>> {
  const r = await call(`/api/threads/${threadId}/controls`, { method: 'PUT', body: JSON.stringify(patch) });
  if (!r.ok) return r;
  const controls = parseControls(r.data?.controls);
  return controls ? { ok: true, data: controls } : { ok: false, error: 'malformed_response', message: NOT_CHANGED };
}

export async function muteMember(threadId: string, userId: string, minutes: number | null): Promise<ApiResult<{ mutedUntil: string }>> {
  const r = await call(`/api/threads/${threadId}/moderation/${userId}/mute`, { method: 'POST', body: JSON.stringify(minutes ? { minutes } : {}) });
  return r.ok ? { ok: true, data: { mutedUntil: String(r.data?.mutedUntil ?? 'indefinite') } } : r;
}

export async function unmuteMember(threadId: string, userId: string): Promise<ApiResult<{ mutedUntil: null }>> {
  const r = await call(`/api/threads/${threadId}/moderation/${userId}/mute`, { method: 'DELETE' });
  return r.ok ? { ok: true, data: { mutedUntil: null } } : r;
}

export async function removeMember(threadId: string, userId: string): Promise<ApiResult<{ removedAt: string }>> {
  const r = await call(`/api/threads/${threadId}/moderation/${userId}/remove`, { method: 'POST' });
  return r.ok ? { ok: true, data: { removedAt: String(r.data?.removedAt ?? '') } } : r;
}

export function slowModeLabel(seconds: number): string {
  if (seconds <= 0) return 'Off';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
}

export function muteLabel(minutes: number | null): string {
  if (minutes === null) return 'Until I lift it';
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / (24 * 60))} day`;
}
