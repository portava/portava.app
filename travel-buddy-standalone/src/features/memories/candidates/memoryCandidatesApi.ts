/**
 * Client for the §7 candidate inbox (census-highlights-memories H18/H19/H23/H24):
 *
 *   GET  /api/me/memory-candidates
 *   POST /api/me/memory-candidates/detect          { tripId }
 *   POST /api/me/memory-candidates/:id/confirm     { title? }  (Idempotency-Key)
 *   POST /api/me/memory-candidates/:id/reject
 *
 * Three answers a read can have, kept apart: the candidates; `not_deployed`
 * (the server's storage is not there yet — 404 feature_disabled — and the inbox
 * shows nothing, because there is nothing to offer); and an error, which is
 * said with Try again. A failed read is never "no suggestions".
 */
import { freshToken } from '../../../services/apiToken.ts';
import { newMemoryOperationId } from '../../../services/memories.ts';

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
}

export interface DetectReport {
  capturesRead: number;
  capturesWithoutTime: number;
  capturesAlreadyInMemories: number;
  candidates: Array<{ episodeId: string; created: boolean; suppressedBy: string | null }>;
}

export type CandidatesFailure = { ok: false; kind: 'not_deployed' | 'not_found' | 'conflict' | 'unavailable' | 'network_unreachable'; message: string };

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
      if (json?.error === 'feature_disabled') return { ok: false, kind: 'not_deployed', message };
      if (res.status === 404) return { ok: false, kind: 'not_found', message };
      if (res.status === 409) return { ok: false, kind: 'conflict', message };
      return { ok: false, kind: 'unavailable', message };
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

export function listMemoryCandidates() {
  return send('GET', '/api/me/memory-candidates', (b) => (Array.isArray(b.candidates) ? { candidates: b.candidates as MemoryCandidate[] } : null));
}

export function detectMemoryCandidates(tripId: string) {
  return send('POST', '/api/me/memory-candidates/detect', (b) => (b.report && typeof b.report === 'object' ? { report: b.report as DetectReport } : null), { body: { tripId } });
}

export function confirmMemoryCandidate(id: string, title: string | null, operationId?: string) {
  return send('POST', `/api/me/memory-candidates/${encodeURIComponent(id)}/confirm`,
    (b) => (typeof b.memoryId === 'string' ? { memoryId: b.memoryId } : null),
    { body: title ? { title } : {}, headers: { 'Idempotency-Key': operationId || newMemoryOperationId('candidate') } });
}

export function rejectMemoryCandidate(id: string) {
  return send('POST', `/api/me/memory-candidates/${encodeURIComponent(id)}/reject`, (b) => (b.state === 'rejected' ? { state: 'rejected' as const } : null), { body: {} });
}
