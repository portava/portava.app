/**
 * Client for the §7 candidate inbox (census-highlights-memories H18/H19/H23/H24):
 *
 *   GET  /api/me/memory-candidates
 *   POST /api/me/memory-candidates/detect          { tripId }
 *   POST /api/me/memory-candidates/:id/confirm     { title? }  (Idempotency-Key)
 *   POST /api/me/memory-candidates/:id/reject
 *
 * and, census H180 (migration 3806), photos that belong to a Memory the owner
 * already has — listed under `convergence` by the same GET:
 *
 *   POST /api/me/memory-convergence/:memoryId/keep     { assetIds, confirmAudience }
 *   POST /api/me/memory-convergence/:memoryId/dismiss  { assetIds }
 *
 * Three answers a read can have, kept apart: the candidates; `not_deployed`
 * (the server's storage is not there yet — 404 feature_disabled — and the inbox
 * shows nothing, because there is nothing to offer); and an error, which is
 * said with Try again. A failed read is never "no suggestions". The same three
 * hold for `convergence` on its own.
 */
import { freshToken } from '../../../services/apiToken.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

export interface MemoryCandidate {
  id: string;
  startedAt: string;
  endedAt: string | null;
  city: string | null;
  country: string | null;
  captureCount: number;
  previewUrls: string[];
  /** `interrupted`: kept, but the save did not finish — Keep completes it. */
  state?: 'candidate' | 'interrupted';
}

export interface ConvergencePhoto {
  assetId: string;
  previewUrl: string;
  capturedAt: string | null;
  /** `interrupted`: the owner added it and the save did not finish — Add finishes it. */
  state: 'proposed' | 'interrupted';
}

/** Photos from the same time as one of the owner's Memories, not in it yet (H180). */
export interface ConvergenceGroup {
  memoryId: string;
  title: string | null;
  startsAt: string | null;
  endsAt: string | null;
  /** The Memory's CURRENT audience. A Keep echoes it back; a mismatch is refused. */
  visibility: string;
  /** Who will see a kept photo: only the owner (`only_me`), or the Memory's own audience (`memory`). */
  attachAudience: 'only_me' | 'memory';
  basis: 'confirmed_episode' | 'memory_window';
  photos: ConvergencePhoto[];
}

export type ConvergenceInbox =
  | { state: 'ready'; groups: ConvergenceGroup[] }
  | { state: 'not_deployed' }
  | { state: 'unavailable' };

export interface DetectReport {
  capturesRead: number;
  capturesWithoutTime: number;
  capturesAlreadyInMemories: number;
  candidates: Array<{ episodeId: string; created: boolean; suppressedBy: string | null }>;
  /** H180: captures that belong to a Memory the owner already has (absent from an older server). */
  convergence?: { state: 'ready' | 'not_deployed'; capturesMatched: number; proposalsAdded: number; memories: number };
}

export type CandidatesFailure = {
  ok: false;
  kind: 'not_deployed' | 'not_found' | 'conflict' | 'unavailable' | 'network_unreachable';
  message: string;
  /** The server's reason code for a refusal, when it gave one (e.g. `audience_unconfirmed`). */
  reason?: string;
  /** With `audience_unconfirmed`: the Memory's audience NOW, to show the owner before asking again. */
  currentAudience?: string;
};

async function send<T extends object>(method: 'GET' | 'POST', path: string, pick: (b: Record<string, unknown>) => T | null, opts?: { body?: unknown; headers?: Record<string, string> }): Promise<({ ok: true } & T) | CandidatesFailure> {
  try {
    const token = await freshToken();
    const res = await fetch(`${apiBase()}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(opts?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(opts?.headers ?? {}),
      },
      ...(opts?.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const message = typeof json?.message === 'string' && json.message ? json.message : 'Something went wrong. Please try again.';
    if (!res.ok) {
      const extra = {
        ...(typeof json?.reason === 'string' ? { reason: json.reason } : {}),
        ...(typeof json?.currentAudience === 'string' ? { currentAudience: json.currentAudience } : {}),
      };
      if (json?.error === 'feature_disabled') return { ok: false, kind: 'not_deployed', message, ...extra };
      if (res.status === 404) return { ok: false, kind: 'not_found', message, ...extra };
      if (res.status === 409) return { ok: false, kind: 'conflict', message, ...extra };
      return { ok: false, kind: 'unavailable', message, ...extra };
    }
    const picked = json && typeof json === 'object' ? pick(json) : null;
    if (!picked) return { ok: false, kind: 'unavailable', message: 'The server answered in a shape this app does not understand.' };
    return { ok: true, ...picked };
  } catch (e) {
    const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
    const offline = m.includes('network request failed') || m.includes('failed to fetch') || m.includes('networkerror') || m.includes('load failed');
    return { ok: false, kind: offline ? 'network_unreachable' : 'unavailable', message: offline ? 'You appear to be offline.' : 'Something went wrong. Please try again.' };
  }
}

/**
 * The `convergence` part of the inbox. A server without it (older than H180)
 * has nothing to offer: `not_deployed`. A shape this app does not understand is
 * `unavailable` — never an empty list that looks like "nothing to review".
 */
export function parseConvergence(raw: unknown): ConvergenceInbox {
  if (raw === undefined) return { state: 'not_deployed' };
  if (!raw || typeof raw !== 'object') return { state: 'unavailable' };
  const r = raw as { state?: unknown; groups?: unknown };
  if (r.state === 'not_deployed') return { state: 'not_deployed' };
  if (r.state !== 'ready' || !Array.isArray(r.groups)) return { state: 'unavailable' };
  const groups: ConvergenceGroup[] = [];
  for (const g of r.groups as Array<Record<string, unknown>>) {
    if (!g || typeof g.memoryId !== 'string' || typeof g.visibility !== 'string' || !Array.isArray(g.photos)) return { state: 'unavailable' };
    if (g.attachAudience !== 'only_me' && g.attachAudience !== 'memory') return { state: 'unavailable' };
    const photos = (g.photos as Array<Record<string, unknown>>).filter((p) => p && typeof p.assetId === 'string' && typeof p.previewUrl === 'string')
      .map((p) => ({ assetId: p.assetId as string, previewUrl: p.previewUrl as string, capturedAt: typeof p.capturedAt === 'string' ? p.capturedAt : null, state: p.state === 'interrupted' ? 'interrupted' as const : 'proposed' as const }));
    if (photos.length === 0) continue;
    groups.push({
      memoryId: g.memoryId, title: typeof g.title === 'string' ? g.title : null,
      startsAt: typeof g.startsAt === 'string' ? g.startsAt : null, endsAt: typeof g.endsAt === 'string' ? g.endsAt : null,
      visibility: g.visibility, attachAudience: g.attachAudience, basis: g.basis === 'confirmed_episode' ? 'confirmed_episode' : 'memory_window', photos,
    });
  }
  return { state: 'ready', groups };
}

export function listMemoryCandidates() {
  return send('GET', '/api/me/memory-candidates', (b) => (Array.isArray(b.candidates) ? { candidates: b.candidates as MemoryCandidate[], convergence: parseConvergence(b.convergence) } : null));
}

export function detectMemoryCandidates(tripId: string) {
  return send('POST', '/api/me/memory-candidates/detect', (b) => (b.report && typeof b.report === 'object' ? { report: b.report as DetectReport } : null), { body: { tripId } });
}

/** The stable §19 key for keeping one candidate. */
export function candidateOperationId(candidateId: string): string {
  return `memory-candidate:${candidateId}`;
}

export function confirmMemoryCandidate(id: string, title: string | null, operationId?: string) {
  return send('POST', `/api/me/memory-candidates/${encodeURIComponent(id)}/confirm`,
    (b) => (typeof b.memoryId === 'string' ? { memoryId: b.memoryId } : null),
    // ONE key per candidate, not per tap: a second tap, a retry after a lost
    // response and a second device all carry the same key, so the server's
    // §19 receipt (kernel on) and its derived Memory id (kernel off) see one
    // command. The server keys the Memory on the candidate anyway; this makes
    // the client say the same thing.
    { body: title ? { title } : {}, headers: { 'Idempotency-Key': operationId || candidateOperationId(id) } });
}

export function rejectMemoryCandidate(id: string) {
  return send('POST', `/api/me/memory-candidates/${encodeURIComponent(id)}/reject`, (b) => (b.state === 'rejected' ? { state: 'rejected' as const } : null), { body: {} });
}

export interface KeptConvergencePhoto { assetId: string; itemId: string; itemAudience: 'only_me' | 'memory' | 'unchanged' }

/**
 * Add the photos the owner was SHOWN to one of their Memories. `confirmAudience`
 * is the Memory's audience as the owner saw it on screen: the server refuses
 * (409 `audience_unconfirmed`, with the audience it has now) when it no longer
 * matches. The server keys each photo on (Memory, photo), so a second tap or a
 * retry is the same photo, once.
 */
export function keepConvergence(memoryId: string, assetIds: string[], confirmAudience: string) {
  return send('POST', `/api/me/memory-convergence/${encodeURIComponent(memoryId)}/keep`,
    (b) => (Array.isArray(b.kept) ? { kept: b.kept as KeptConvergencePhoto[], skipped: Array.isArray(b.skipped) ? (b.skipped as Array<{ assetId: string; reason: string }>) : [] } : null),
    { body: { assetIds, confirmAudience } });
}

/** These photos do not belong to that Memory: never proposed for it again. */
export function dismissConvergence(memoryId: string, assetIds: string[]) {
  return send('POST', `/api/me/memory-convergence/${encodeURIComponent(memoryId)}/dismiss`,
    (b) => (Array.isArray(b.dismissed) ? { dismissed: b.dismissed as string[] } : null),
    { body: { assetIds } });
}
