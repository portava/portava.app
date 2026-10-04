/**
 * census-discovery §119 (DV-83 round 22, lane W11-X2; the round-21 verifier's B31): what the NOW map's bottom Live
 * Pulse card keeps from a GET /pulse/live answer.
 *
 * The map screen kept only `res.items` and, on a failed read, the previous camera's items; `failedSources` was never
 * read, so over a section the server could not read (`safe_return_sessions` is the one the card's ladder puts first)
 * the card headlined the next item as the most important nearby change and said nothing. A whole answer keeps its
 * items and names nothing; an answer naming sections keeps its items and the names, for the card to say; a failed read
 * keeps NO items and names `live_pulse` (the whole read).
 */
import type { LivePulseItem } from '../../../services/livePulse.ts';

export type LivePulseAnswer =
  | { ok: true; items: LivePulseItem[]; sessionId: string | null; failedSources: string[] }
  | { ok: false; error: string };

/** The whole GET /pulse/live read failed. */
export const LIVE_PULSE_UNREAD = 'live_pulse';

export function pulseCardAnswer(res: LivePulseAnswer | null | undefined): { items: LivePulseItem[]; unread: string[] } {
  if (!res || !res.ok) return { items: [], unread: [LIVE_PULSE_UNREAD] };
  return { items: res.items ?? [], unread: Array.isArray(res.failedSources) ? res.failedSources : [] };
}

/** What the card says about what it could not read, or null when it read everything. */
export function pulseUnreadText(unread: readonly string[] | null | undefined): string | null {
  if (!unread || unread.length === 0) return null;
  if (unread.includes(LIVE_PULSE_UNREAD)) return "Couldn't load live updates here";
  if (unread.includes('safe_return_sessions')) return "Couldn't check your Safe Return sessions";
  return "Some live updates couldn't be loaded";
}
