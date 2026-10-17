/**
 * "Remember this together" — the client of §5's shared-experience anchor and
 * participant consent (server: routes/memorySharedExperiences.ts, migration
 * 3997, census-highlights-memories H53).
 *
 * Every function answers `{ ok: true, ... }` or `{ ok: false, kind, message }`.
 * `feature_disabled` is its own kind: the storage is not deployed (or the owner
 * has not switched it on), and the screen shows nothing rather than an error.
 * A read that FAILED is never returned as "no shared experience" (§28.11).
 */
import { freshToken } from './apiToken.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

export type SharedErrorKind =
  | 'feature_disabled' | 'not_found' | 'forbidden' | 'conflict' | 'invalid_payload'
  | 'unauthenticated' | 'degraded_unavailable' | 'network_unreachable';

export type SharedResult<T> = ({ ok: true } & T) | { ok: false; kind: SharedErrorKind; message: string };

export interface SharedPerson { userId: string; name: string | null; handle: string | null; avatarUrl: string | null }
export interface SharedMember extends SharedPerson { role: 'host' | 'participant'; memoryId: string | null }
export interface SharedExperienceView {
  experienceId: string | null;
  viewerRole: 'host' | 'participant';
  hostMemoryId: string;
  members: SharedMember[];
  pending: SharedPerson[];
  invitable: SharedPerson[];
}
export interface SharedInvitation {
  invitationId: string;
  host: SharedPerson;
  memoryTitle: string | null;
  memoryId: string | null;
  invitedAt: string | null;
}

const KNOWN: readonly SharedErrorKind[] = [
  'feature_disabled', 'not_found', 'forbidden', 'conflict', 'invalid_payload', 'unauthenticated', 'degraded_unavailable',
];

const FALLBACK: Record<SharedErrorKind, string> = {
  feature_disabled: 'Remembering together is not available yet.',
  not_found: 'That shared memory or invitation is not available.',
  forbidden: 'That person cannot be invited to remember this together.',
  conflict: 'That Memory cannot be linked. Choose one of your own Memories that is not already shared.',
  invalid_payload: 'That request was not valid.',
  unauthenticated: 'Please sign in again.',
  degraded_unavailable: 'Shared memories could not be loaded right now. Please try again.',
  network_unreachable: 'You appear to be offline. Check your connection and try again.',
};

function kindOf(status: number, body: unknown): SharedErrorKind {
  const code = (body as { error?: unknown } | null)?.error;
  if (typeof code === 'string' && (KNOWN as readonly string[]).includes(code)) return code as SharedErrorKind;
  if (status === 404) return 'not_found';
  if (status === 403) return 'forbidden';
  if (status === 409) return 'conflict';
  if (status === 401) return 'unauthenticated';
  if (status === 400) return 'invalid_payload';
  return 'degraded_unavailable';
}

async function call<T>(method: string, path: string, body?: unknown): Promise<SharedResult<{ body: T }>> {
  const base = apiBase();
  if (!base) return { ok: false, kind: 'degraded_unavailable', message: FALLBACK.degraded_unavailable };
  const token = await freshToken();
  if (!token) return { ok: false, kind: 'unauthenticated', message: FALLBACK.unauthenticated };
  let res: Response;
  try {
    res = await fetch(`${base}/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    return { ok: false, kind: 'network_unreachable', message: FALLBACK.network_unreachable };
  }
  let parsed: unknown = null;
  try { parsed = await res.json(); } catch { parsed = null; }
  if (!res.ok) {
    const kind = kindOf(res.status, parsed);
    const msg = (parsed as { message?: unknown } | null)?.message;
    return { ok: false, kind, message: typeof msg === 'string' && msg.length > 0 && kind !== 'feature_disabled' ? msg : FALLBACK[kind] };
  }
  return { ok: true, body: parsed as T };
}

const enc = encodeURIComponent;

/** The shared experience this Memory is in, as I may see it — or null when I am in none. */
export async function getSharedExperience(memoryId: string): Promise<SharedResult<{ sharedExperience: SharedExperienceView | null }>> {
  const r = await call<{ sharedExperience?: SharedExperienceView | null }>('GET', `/memories/${enc(memoryId)}/shared-experience`);
  if (!r.ok) return r;
  if (!r.body || !('sharedExperience' in r.body)) return { ok: false, kind: 'degraded_unavailable', message: FALLBACK.degraded_unavailable };
  return { ok: true, sharedExperience: r.body.sharedExperience ?? null };
}

export async function inviteToRememberTogether(memoryId: string, userId: string): Promise<SharedResult<{ outcome: string }>> {
  const r = await call<{ outcome?: string }>('POST', `/memories/${enc(memoryId)}/shared-experience/invitations`, { userId });
  return r.ok ? { ok: true, outcome: String(r.body?.outcome ?? 'invited') } : r;
}

export async function withdrawInvitation(memoryId: string, userId: string): Promise<SharedResult<{ withdrawn: boolean }>> {
  const r = await call<{ withdrawn?: boolean }>('DELETE', `/memories/${enc(memoryId)}/shared-experience/invitations/${enc(userId)}`);
  return r.ok ? { ok: true, withdrawn: r.body?.withdrawn === true } : r;
}

export async function endSharedExperience(memoryId: string): Promise<SharedResult<{ ended: boolean }>> {
  const r = await call<{ ended?: boolean }>('DELETE', `/memories/${enc(memoryId)}/shared-experience`);
  return r.ok ? { ok: true, ended: r.body?.ended === true } : r;
}

export async function leaveSharedExperience(experienceId: string): Promise<SharedResult<{ left: boolean }>> {
  const r = await call<{ left?: boolean }>('POST', `/shared-experiences/${enc(experienceId)}/leave`, {});
  return r.ok ? { ok: true, left: r.body?.left === true } : r;
}

export async function listSharedInvitations(): Promise<SharedResult<{ invitations: SharedInvitation[] }>> {
  const r = await call<{ invitations?: SharedInvitation[] }>('GET', '/me/shared-experience-invitations');
  if (!r.ok) return r;
  if (!Array.isArray(r.body?.invitations)) return { ok: false, kind: 'degraded_unavailable', message: FALLBACK.degraded_unavailable };
  return { ok: true, invitations: r.body.invitations };
}

/** Consent. `memoryId` is one of MY Memories to link, or null to join without linking one. */
export async function acceptSharedInvitation(invitationId: string, memoryId: string | null): Promise<SharedResult<{ experienceId: string | null }>> {
  const r = await call<{ experienceId?: string | null }>('POST', `/shared-experience-invitations/${enc(invitationId)}/accept`, memoryId ? { memoryId } : {});
  return r.ok ? { ok: true, experienceId: r.body?.experienceId ?? null } : r;
}

export async function declineSharedInvitation(invitationId: string): Promise<SharedResult<{ declined: true }>> {
  const r = await call<unknown>('POST', `/shared-experience-invitations/${enc(invitationId)}/decline`, {});
  return r.ok ? { ok: true, declined: true } : r;
}

/** A person's display name, never empty. */
export function personLabel(p: SharedPerson): string {
  return p.name?.trim() || (p.handle ? `@${p.handle}` : 'Someone');
}
