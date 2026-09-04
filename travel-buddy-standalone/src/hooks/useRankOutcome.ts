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
import { freshToken } from '../services/apiToken.ts';

/**
 * Feed surfaces that write rank_events rows we can report outcomes against.
 *
 * Must stay a subset of SURFACE_VALUES in the API's src/routes/rankEvents.ts —
 * that zod enum 400s anything it does not recognise, so a value added here
 * before the server accepts it silently loses every outcome.
 *
 * 'live_pulse' is the Live Pulse rail (GET /api/pulse/live). It is deliberately
 * NOT 'pulse': Live Pulse items are assembled by urgency rather than ranked, but
 * are keyed by the same canonical entity ids as the ranked /pulse feed. Sharing
 * a surface put both in one key space, and the outcome lookup — most recent
 * (user_id, item_id, surface, outcome='impression') wins — let a Live Pulse
 * serve row steal outcomes belonging to genuine ranked impressions. A separate
 * surface is a separate key space, so the collision cannot happen at all.
 */
type Surface = 'pulse' | 'discovery' | 'events' | 'live_pulse';
type Outcome = 'tap' | 'save' | 'join' | 'rsvp' | 'attended';

/**
 * The surface an impression was WRITTEN under — the value a component must be
 * handed by whoever served the item, never the screen the user is looking at.
 * Exported so shared components (PlaceCard, PlaceDetailSheet) can take it as a
 * prop and stay silent when they are rendered somewhere that served nothing.
 */
export type RankSurface = Surface;

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
      const token = await freshToken();
      if (!token) return;
      const body: Record<string, string> = { item_id: itemId, surface, outcome };
      if (sessionId) body.session_id = sessionId;
      fetch(`${base}/api/rank-events/outcome`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
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
 * @param surface  Which feed surface these outcomes belong to.  `null` /
 *   `undefined` means "this instance was not reached from a served impression"
 *   (e.g. PlaceDetailSheet on the Layover card) — every report is then a no-op,
 *   so a shared component can call the hook unconditionally and let its owner
 *   decide whether there is anything to attribute.
 * @param sessionId  Optional session UUID returned by the feed endpoint (from
 *   the `session_id` field added in spec §7).  Narrows outcome matching when the
 *   same item appeared in multiple feed loads.
 */
export function useRankOutcome({
  surface,
  sessionId,
}: {
  surface: Surface | null | undefined;
  sessionId?: string | null;
}) {
  // Per-mount dedup set: once an outcome fires for (itemId, outcome) we skip retries.
  const sent = useRef(new Set<string>());

  const report = useCallback(
    (itemId: string, outcome: Outcome) => {
      if (!surface) return; // no served context → nothing to attribute the outcome to
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
