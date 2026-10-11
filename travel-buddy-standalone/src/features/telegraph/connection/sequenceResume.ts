/**
 * Telegraph §17.2 — "Reconnect resumes from last acknowledged conversation
 * sequence" (census-telegraph T233), the client half.
 *
 * The server (GET /api/threads/:id/messages, migration 3654, flags seeded OFF)
 * answers `?afterSequence=N` with the messages after N, oldest first, plus
 * `resume: { nextSequence, hasMore }`. This module is the pure loop around it:
 *
 *   - the CURSOR is the highest `sequence` this device holds. Messages carry a
 *     sequence only when the server has the capability ON (a page fetched with
 *     `withSequence=1`); with it OFF nothing carries one, the cursor is null, and
 *     the caller uses its ordinary poll — exactly the pre-3654 behaviour.
 *   - it pages until `hasMore` is false or the page budget is spent. A spent
 *     budget is NOT a completed resume: `complete: false` tells the caller to
 *     fall back to a full poll, because a partial catch-up that reported success
 *     would leave a hole nobody looks for.
 *   - an answer WITHOUT a `resume` block means the server ignored the cursor
 *     (capability off, or an older server): `fallback: 'unsupported'`.
 *   - 429 is backpressure, not failure: `fallback: 'backpressure'` with the
 *     server's Retry-After, so the caller does not hammer a shedding server.
 *
 * Optimistic sends are retried with the SAME clientId (useMessaging's
 * retrySend); services/messaging.ts sends it as `idempotencyKey`, so a retry of
 * a send that actually landed answers with the original message (T231).
 */

export interface SequencedMessage {
  id: string;
  sequence?: number | null;
}

export interface ResumePage<M extends SequencedMessage> {
  ok: boolean;
  status?: number;
  retryAfterSeconds?: number | null;
  messages?: M[];
  resume?: { nextSequence: number; hasMore: boolean } | null;
}

export type ResumeOutcome<M extends SequencedMessage> =
  | { kind: 'resumed'; messages: M[]; cursor: number; complete: true }
  | { kind: 'fallback'; reason: 'no_cursor' | 'unsupported' | 'failed' | 'budget_spent'; messages: M[]; cursor: number | null }
  | { kind: 'fallback'; reason: 'backpressure'; retryAfterSeconds: number; messages: M[]; cursor: number | null };

export const RESUME_MAX_PAGES = 10;

/** The highest sequence held, or null when nothing carries one (capability off). */
export function cursorOf(messages: ReadonlyArray<SequencedMessage>): number | null {
  let best: number | null = null;
  for (const m of messages) {
    const s = m.sequence;
    if (typeof s === 'number' && Number.isSafeInteger(s) && s >= 0 && (best === null || s > best)) best = s;
  }
  return best;
}

export async function resumeFromCursor<M extends SequencedMessage>(
  cursor: number | null,
  fetchPage: (afterSequence: number) => Promise<ResumePage<M>>,
  maxPages: number = RESUME_MAX_PAGES,
): Promise<ResumeOutcome<M>> {
  if (cursor === null) return { kind: 'fallback', reason: 'no_cursor', messages: [], cursor: null };
  const collected: M[] = [];
  let at = cursor;
  for (let page = 0; page < maxPages; page++) {
    const r = await fetchPage(at);
    if (!r.ok) {
      if (r.status === 429) {
        return { kind: 'fallback', reason: 'backpressure', retryAfterSeconds: Math.max(1, r.retryAfterSeconds ?? 5), messages: collected, cursor: at };
      }
      return { kind: 'fallback', reason: 'failed', messages: collected, cursor: at };
    }
    if (!r.resume) return { kind: 'fallback', reason: 'unsupported', messages: collected, cursor: at };
    collected.push(...(r.messages ?? []));
    // A server cursor that does not advance while claiming more would loop forever.
    if (r.resume.hasMore && r.resume.nextSequence <= at) return { kind: 'fallback', reason: 'failed', messages: collected, cursor: at };
    at = Math.max(at, r.resume.nextSequence);
    if (!r.resume.hasMore) return { kind: 'resumed', messages: collected, cursor: at, complete: true };
  }
  return { kind: 'fallback', reason: 'budget_spent', messages: collected, cursor: at };
}

/**
 * Merge resumed messages into what the screen holds: new ids are appended in
 * sequence order; an id already held (an optimistic copy confirmed meanwhile,
 * or a boundary row) is replaced by the server copy, never duplicated.
 */
export function mergeResumed<M extends SequencedMessage>(held: ReadonlyArray<M>, resumed: ReadonlyArray<M>): M[] {
  if (resumed.length === 0) return held as M[];
  const incoming = new Map(resumed.map((m) => [m.id, m]));
  const out = held.map((m) => incoming.get(m.id) ?? m);
  const heldIds = new Set(held.map((m) => m.id));
  const fresh = resumed
    .filter((m) => !heldIds.has(m.id))
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  return [...out, ...fresh];
}
