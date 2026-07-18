/**
 * useRankOutcome — fire-and-forget outcome reporting for the Portava learning loop.
 *
 * Sends tap/save/join/rsvp outcomes to POST /api/rank-events/outcome so that
 * the rank_events table accumulates the full impression → outcome funnel needed
 * to fit v2 weights (spec §7).
 *
 * Design constraints:
 * - All calls are fire-and-forget: errors are swallowed, UI is never blocked.
 * - Duplicate outcomes for the same item in the same session are deduplicated
 *   client-side so a double-tap doesn't create two rows.
 * - Can be called from outside a React component via `fireRankOutcome`.
 */

import { useCallback, useRef } from 'react';
import { supabase } from '../services/supabase';

type Surface = 'pulse' | 'discovery' | 'events';
type Outcome = 'tap' | 'save' | 'join' | 'rsvp' | 'attended';

const API_BASE = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

/**
 * Module-level fire-and-forget helper.  Can be called without a React context.
 * Does nothing (silently) when the API base URL is unset or the user is signed out.
 */
export function fireRankOutcome(
  itemId: string,
  surface: Surface,
  outcome: Outcome,
  sessionId?: string | null,
): void {
  const base = API_BASE();
  if (!base) return;
  (async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) return;
      const body: Record<string, string> = { item_id: itemId, surface, outcome };
      if (sessionId) body.session_id = sessionId;
      fetch(`${base}/api/rank-events/outcome`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(body),
      }).catch(() => {});
    } catch {
      // silent — outcome logging must never surface errors to the user
    }
  })();
}

/**
 * React hook version.  Provides stable `reportTap`, `reportSave`, `reportJoin`,
 * and `reportRsvp` callbacks that deduplicate within the component lifetime.
 *
 * @param surface  Which feed surface these outcomes belong to.
 * @param sessionId  Optional session UUID returned by the feed endpoint (from
 *   the `session_id` field added in spec §7).  Narrows outcome matching when the
 *   same item appeared in multiple feed loads.
 */
export function useRankOutcome({
  surface,
  sessionId,
}: {
  surface: Surface;
  sessionId?: string | null;
}) {
  // Per-mount dedup set: once an outcome fires for (itemId, outcome) we skip retries.
  const sent = useRef(new Set<string>());

  const report = useCallback(
    (itemId: string, outcome: Outcome) => {
      const key = `${itemId}:${outcome}`;
      if (sent.current.has(key)) return;
      sent.current.add(key);
      fireRankOutcome(itemId, surface, outcome, sessionId);
    },
    [surface, sessionId],
  );

  const reportTap  = useCallback((itemId: string) => report(itemId, 'tap'),  [report]);
  const reportSave = useCallback((itemId: string) => report(itemId, 'save'), [report]);
  const reportJoin = useCallback((itemId: string) => report(itemId, 'join'), [report]);
  const reportRsvp = useCallback((itemId: string) => report(itemId, 'rsvp'), [report]);

  return { reportTap, reportSave, reportJoin, reportRsvp };
}
