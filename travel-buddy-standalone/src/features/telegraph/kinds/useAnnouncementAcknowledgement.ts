/**
 * Telegraph §19 — "Acknowledgment for important operational changes is
 * distinct from passive Seen" (census T261), on the client.
 *
 * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
 * `AnnouncementPayload.requiresAcknowledgement` and a "Got it" button existed
 * before any of this: `TypedMessageRenderer` drew the button and called an
 * `onAcknowledge` prop that NO MOUNT PASSED. Pressing it did nothing, in the
 * app, on every announcement. This hook is the missing half — and the
 * renderer now refuses to draw the button when no handler is supplied, so the
 * same hole cannot reopen silently.
 *
 * ── WHY ONE FETCH PER THREAD, NOT PER MESSAGE ───────────────────────────────
 * Every announcement bubble in a thread would otherwise call
 * `GET /threads/:id/announcements` on mount. The in-flight promise is shared
 * per thread and cached for `TTL_MS`, so a thread with eight announcements
 * makes one request. The cache is invalidated on every successful write, so a
 * press is reflected without waiting for the TTL.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
 * It does not subscribe. Somebody else's acknowledgement lands here on the
 * next fetch, not live: the SSE stream carries `message.created` for the
 * acknowledgement message, but this surface does not consume it. That is a
 * refresh delay, not a wrong answer, and it is stated rather than hidden.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  acknowledgeAnnouncement,
  fetchAnnouncements,
  type AnnouncementsResponse,
  type CoordinationResult,
} from '../coordination/coordinationApi.ts';

const TTL_MS = 20_000;

interface Entry {
  at: number;
  promise: Promise<CoordinationResult<AnnouncementsResponse>>;
}

const cache = new Map<string, Entry>();

/** Exported for the test: a hook that caches must be resettable. */
export function _resetAnnouncementCache(): void {
  cache.clear();
}

function load(threadId: string): Promise<CoordinationResult<AnnouncementsResponse>> {
  const hit = cache.get(threadId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;
  const promise = fetchAnnouncements(threadId);
  cache.set(threadId, { at: Date.now(), promise });
  return promise;
}

export interface AnnouncementAcknowledgement {
  /** True once THIS viewer's acknowledgement is on the server. */
  acknowledged: boolean;
  /** Null while unknown — never 0, which would read as "nobody has". */
  acknowledgedCount: number | null;
  acknowledge: () => Promise<void>;
  error: string | null;
}

/**
 * @param enabled false for every message that is not an announcement asking to
 *   be acknowledged. A hook cannot be called conditionally, so the CONDITION
 *   moves inside it and no request is made when it is false.
 */
export function useAnnouncementAcknowledgement(opts: {
  threadId: string | null | undefined;
  messageId: string;
  viewerId: string | null | undefined;
  enabled: boolean;
}): AnnouncementAcknowledgement {
  const { threadId, messageId, viewerId, enabled } = opts;
  const [acknowledged, setAcknowledged] = useState(false);
  const [acknowledgedCount, setCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!enabled || !threadId) return;
    const r = await load(threadId);
    if (!alive.current || !r.ok) return;
    const row = r.data.announcements.find((a) => a.messageId === messageId);
    if (!row) return;
    setCount(row.acknowledgedBy.length);
    setAcknowledged(viewerId ? row.acknowledgedBy.some((a) => a.userId === viewerId) : false);
  }, [enabled, threadId, messageId, viewerId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const acknowledge = useCallback(async () => {
    if (!threadId) {
      setError('unconfigured');
      return;
    }
    const r = await acknowledgeAnnouncement(threadId, messageId);
    if (!alive.current) return;
    if (!r.ok) {
      setError(r.message ?? r.error);
      return;
    }
    setError(null);
    setAcknowledged(true);
    cache.delete(threadId);
    void refresh();
  }, [threadId, messageId, refresh]);

  return { acknowledged, acknowledgedCount, acknowledge, error };
}
