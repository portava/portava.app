/**
 * rankEvents — client-side helper for recording user outcomes against
 * impression rows in rank_events (tap, save, join, rsvp, attended).
 *
 * Pass the sessionId returned by /api/pulse or /api/events so the server can
 * narrow the impression lookup to the correct feed load.
 */
import { freshToken as freshApiToken } from './apiToken.ts';

const apiBase = () => (process.env.EXPO_PUBLIC_API_BASE_URL ?? '').replace(/\/$/, '');

type OutcomeValue = 'tap' | 'save' | 'join' | 'rsvp' | 'attended';
/**
 * Kept in lockstep with the `Surface` union in ../hooks/useRankOutcome.ts and
 * with SURFACE_VALUES in the API's src/routes/rankEvents.ts (that zod enum 400s
 * anything else). 'live_pulse' is the Live Pulse rail; it is a separate key
 * space from the ranked 'pulse' feed on purpose — see the note on `Surface` in
 * useRankOutcome.ts.
 */
type SurfaceValue = 'pulse' | 'discovery' | 'events' | 'live_pulse';

/**
 * Fire-and-forget: post an outcome row to /api/rank-events/outcome.
 *
 * Errors are swallowed — a logging failure must never interrupt the user.
 *
 * @param itemId    ID of the item the user interacted with.
 * @param surface   Feed surface that served the item — must be the surface the
 *                  impression row was WRITTEN with, not the screen the user is
 *                  looking at now. The Live Pulse rail serves under
 *                  "live_pulse"; the ranked Pulse feed serves under "pulse".
 * @param outcome   Interaction type.
 * @param sessionId Session UUID returned by the originating feed response.
 */
export async function recordOutcome(
  itemId: string,
  surface: SurfaceValue,
  outcome: OutcomeValue,
  sessionId?: string,
): Promise<void> {
  try {
    const base = apiBase();
    if (!base) return;

    let token: string | null = null;
    try { token = await freshApiToken(); } catch { /* swallow */ }
    if (!token) return;

    const body: Record<string, string> = { item_id: itemId, surface, outcome };
    if (sessionId) body.session_id = sessionId;

    await fetch(`${base}/api/rank-events/outcome`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    // Silent — outcome logging is non-fatal
  }
}
