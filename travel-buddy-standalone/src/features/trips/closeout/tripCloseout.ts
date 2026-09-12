/**
 * §20.2 / §20.3 — the client for GET /trips/:tripId/closeout and
 * POST /trips/:tripId/closeout/answers. census-trips TR390 (the smallest
 * question set, asked on a screen), TR385 (the answer recorded), TR428.
 *
 * The questions are the server's, in the spec's own words ("Did you make it
 * to Hoi An?"), and the two answers are the two `trip_outcomes` types they
 * map to. An answer is RECORD_OUTCOME through the kernel; without the kernel
 * the server refuses by name (503 TRIP_KERNEL_UNAVAILABLE) and the card says
 * that the answer could not be recorded — never that it was.
 */
import { isConfigured, apiBase, bearerToken } from '../shared/auth.ts';

export type CloseoutAnswer = 'completed' | 'skipped';
export interface CloseoutQuestion { planId: string; question: string; answers: readonly CloseoutAnswer[] }
export interface CloseoutStep { step: string; status: 'actionable' | 'not_applicable' | 'deferred' | 'performed' | 'failed'; detail: string; ids?: string[] }
export interface TripCloseout {
  tripId: string;
  tripStatus: string | null;
  performedAt: string;
  steps: CloseoutStep[];
  questions: CloseoutQuestion[];
  unread: string[];
}

export type CloseoutRead =
  | { state: 'ok'; closeout: TripCloseout }
  | { state: 'off' }
  | { state: 'unavailable'; detail: string; reason?: string };

function looksLikeCloseout(b: unknown): b is TripCloseout {
  const c = b as Partial<TripCloseout> | null;
  return !!c && typeof c === 'object' && typeof c.tripId === 'string' && Array.isArray(c.steps) && Array.isArray(c.questions)
    && c.questions.every((q) => q && typeof q.planId === 'string' && typeof q.question === 'string' && Array.isArray(q.answers));
}

export async function fetchTripCloseout(tripId: string): Promise<CloseoutRead> {
  if (!isConfigured() || !apiBase()) return { state: 'off' };
  const token = await bearerToken();
  if (!token) return { state: 'off' };
  try {
    const res = await fetch(`${apiBase()}/api/trips/${tripId}/closeout`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string; reason?: string; message?: string } | null;
      if (res.status === 404 && (body?.error === 'feature_disabled' || body?.reason === 'FEATURE_DISABLED')) return { state: 'off' };
      return { state: 'unavailable', detail: body?.message ?? `HTTP ${res.status}`, reason: body?.reason };
    }
    const body: unknown = await res.json().catch(() => null);
    if (!looksLikeCloseout(body)) return { state: 'unavailable', detail: 'unreadable response' };
    return { state: 'ok', closeout: body };
  } catch (e: any) {
    return { state: 'unavailable', detail: String(e?.message ?? 'network error') };
  }
}

export type AnswerResult =
  | { state: 'recorded'; planId: string; answer: CloseoutAnswer; duplicate: boolean }
  /** The server refused by name. `TRIP_KERNEL_UNAVAILABLE` means answers are not recorded on this deployment. */
  | { state: 'refused'; reason: string; detail: string }
  | { state: 'unavailable'; detail: string };

export async function answerCloseoutQuestion(tripId: string, planId: string, answer: CloseoutAnswer, opts: { idempotencyKey?: string } = {}): Promise<AnswerResult> {
  if (!isConfigured() || !apiBase()) return { state: 'unavailable', detail: 'not configured' };
  const token = await bearerToken();
  if (!token) return { state: 'unavailable', detail: 'not signed in' };
  try {
    const res = await fetch(`${apiBase()}/api/trips/${tripId}/closeout/answers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId, answer, ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}) }),
    });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; reason?: string; detail?: string; message?: string; kernel?: { duplicate?: boolean } } | null;
    if (!res.ok) return { state: 'refused', reason: body?.reason ?? `HTTP_${res.status}`, detail: body?.detail ?? body?.message ?? `HTTP ${res.status}` };
    return { state: 'recorded', planId, answer, duplicate: body?.kernel?.duplicate === true };
  } catch (e: any) {
    return { state: 'unavailable', detail: String(e?.message ?? 'network error') };
  }
}

/* ── pure readings ──────────────────────────────────────────────────────── */

/** What the closeout card says about the steps: performed / deferred / failed counts in one line. */
export function closeoutSummary(c: TripCloseout): string {
  const n = (s: CloseoutStep['status']) => c.steps.filter((x) => x.status === s).length;
  const parts: string[] = [];
  if (n('performed') > 0) parts.push(`${n('performed')} step(s) performed`);
  if (n('actionable') > 0) parts.push(`${n('actionable')} step(s) would act on completion`);
  if (n('deferred') > 0) parts.push(`${n('deferred')} deferred here`);
  if (n('failed') > 0) parts.push(`${n('failed')} failed`);
  if (c.unread.length > 0) parts.push(`${c.unread.length} input(s) not read`);
  return parts.length > 0 ? parts.join(' · ') : 'Nothing to do at closeout';
}

/** The answer words for the two outcomes, in the spec's register. */
export const ANSWER_LABEL: Record<CloseoutAnswer, string> = { completed: 'Yes, made it', skipped: "No, skipped it" };
