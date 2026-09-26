/**
 * layoverReasonCodes — census-layover Appendix A (L278–L292), the CLIENT half.
 *
 * ── WHAT WAS MISSING ─────────────────────────────────────────────────────────
 * The server settled this vocabulary passes ago: fifteen codes declared once in
 * `services/airport/LayoverSafetyEngine.ts#LAYOVER_REASON_CODES`, emitted on
 * `advice.reasonCodes` and carried through `GET /overview` and
 * `GET /:id/safety`. This client TYPED the field —
 * `services/layover.ts:142#reasonCodes: string[]` — and rendered nothing from
 * it. `CanILeaveCard` drew `advice.reasons`, the free-text English sentences,
 * and the machine-readable half stopped at the wire.
 *
 * That is the census's own recurring defect shape in a new place: the server
 * publishes an answer, no client surface has anywhere to put it, and the row
 * reads as though the answer did not exist. Appendix A's rows are about codes a
 * traveller can be SHOWN. A code nothing renders is not shown.
 *
 * ── WHAT THIS MODULE DECIDES, AND WHAT IT REFUSES TO ─────────────────────────
 * It decides ENGLISH. Nothing here judges, orders by severity, filters by
 * verdict, or infers a code the server did not send:
 *
 *   ORDER IS THE SERVER'S. The codes arrive in emission order and are rendered
 *   in emission order. Re-sorting them by a severity this file invented would
 *   be a second opinion about the same answer, on the client, which is exactly
 *   what L115 forbids of the map and for the same reason.
 *
 *   AN UNKNOWN CODE IS RENDERED AS ITSELF. A server newer than this build may
 *   emit a code that is not below. Dropping it would be silence about a stated
 *   risk; giving it a guessed sentence would be words the server never said.
 *   It is carried through with `known: false`, the raw token as its title and
 *   `detail: null`, and the surface prints exactly that.
 *
 *   NOTHING HERE CERTIFIES A FIT. Every code qualifies an answer; none of them
 *   says something is safe. `__tests__/layoverReasonCodes.test.ts` holds that
 *   as a property over the whole table rather than as a review habit.
 *
 * ── WHICH OF THESE A PRODUCTION TRAVELLER CAN ACTUALLY SEE ───────────────────
 * Four, and the count is the server's own (`LayoverSafetyEngine.ts:85-88`):
 * `ENTRY_NOT_CONFIRMED` on every session, `INSUFFICIENT_USABLE_TIME` on a "no"
 * verdict, `RETURN_THRESHOLD_REACHED` at RETURN_NOW / CONNECTION_AT_RISK and
 * `AIRPORT_MATURITY_LIMITED` at an uncurated airport — which is all 3,206 of
 * them. Six more are emitted only when a fact is supplied that nothing on the
 * tree produces (`SECURITY_WAIT_HIGH`, `TRAFFIC_DEGRADED`, `DATA_STALE`,
 * `SOURCE_CONFLICT`, and the two flight-change codes), and five are declared
 * and never emitted. This module renders all fifteen so that a server that
 * starts emitting one needs no client change — it does NOT claim they are live,
 * and the census rows for the unemitted ones do not move because of this file.
 */

/**
 * The whole vocabulary, transcribed from the server's own declaration.
 *
 * TRANSCRIBED AND NOT IMPORTED, for the reason `LayoverReminderDisposition`
 * gives in `services/layover.ts`: this package does not depend on the
 * api-server sources, and a wire vocabulary that drifts should fail loudly at
 * the surface that reads it rather than silently typecheck against a stale
 * copy. The paired assertion in the suite is what makes the transcription
 * checkable.
 */
export const LAYOVER_REASON_CODES = [
  'ENTRY_NOT_CONFIRMED',
  'BAGGAGE_STATUS_CRITICAL_UNKNOWN',
  'INSUFFICIENT_USABLE_TIME',
  'SECURITY_WAIT_HIGH',
  'RETURN_ROUTE_UNRELIABLE',
  'AIRPORT_CHANGE_REQUIRED',
  'SELF_TRANSFER_FRICTION',
  'DATA_STALE',
  'SOURCE_CONFLICT',
  'TRAFFIC_DEGRADED',
  'FLIGHT_MOVED_EARLIER',
  'FLIGHT_DELAY_CREATED_OPPORTUNITY',
  'RETURN_THRESHOLD_REACHED',
  'RECOMMENDATION_EXPIRED',
  'AIRPORT_MATURITY_LIMITED',
] as const;

export type LayoverReasonCode = (typeof LAYOVER_REASON_CODES)[number];

/**
 * How a surface should COLOUR a code. Not a severity ranking and never used to
 * reorder: two codes with the same tone are still rendered in the order the
 * server sent them.
 *
 *   blocking     this is why the answer is restrictive
 *   caution      this makes the answer worse than it looks
 *   unknown      this is something nobody measured; it is not a reassurance
 *   opportunity  the window got BIGGER, the one direction that is good news
 */
export type LayoverReasonTone = 'blocking' | 'caution' | 'unknown' | 'opportunity';

export interface RenderedReasonCode {
  /** The server's token, verbatim. */
  code: string;
  /** FALSE for a code this build has never heard of. */
  known: boolean;
  /** Traveller-facing. For an unknown code this is the token itself. */
  title: string;
  /** Traveller-facing. `null` for an unknown code — never a guess. */
  detail: string | null;
  tone: LayoverReasonTone;
}

interface Entry {
  title: string;
  detail: string;
  tone: LayoverReasonTone;
}

const TABLE: Record<LayoverReasonCode, Entry> = {
  ENTRY_NOT_CONFIRMED: {
    title: 'Entry permission not confirmed',
    tone: 'unknown',
    detail:
      'Nothing here has checked whether your passport, visa or transit permit lets you leave this airport. That one is yours to confirm before you go.',
  },
  BAGGAGE_STATUS_CRITICAL_UNKNOWN: {
    title: 'Bag routing not known',
    tone: 'unknown',
    detail:
      'Whether your checked bags go through to your final stop is not known here, and it changes what you have to do before you board again.',
  },
  INSUFFICIENT_USABLE_TIME: {
    title: 'Not enough usable time',
    tone: 'blocking',
    detail:
      'Once the required buffers come off this layover, too little is left to get out and be back at the gate in time.',
  },
  SECURITY_WAIT_HIGH: {
    title: 'Security queue running long',
    tone: 'caution',
    detail:
      'Getting back through security is taking longer than usual here, so more of your window goes on the return than the plan assumes.',
  },
  RETURN_ROUTE_UNRELIABLE: {
    title: 'The way back has little slack',
    tone: 'blocking',
    detail:
      'The journey back to the airport has no real margin — one delay on it would put your connection at risk.',
  },
  AIRPORT_CHANGE_REQUIRED: {
    title: 'You have to change airports',
    tone: 'blocking',
    detail:
      'Your next flight leaves from a different airport, so the journey between the two is part of this window, not extra to it.',
  },
  SELF_TRANSFER_FRICTION: {
    title: 'Self-transfer connection',
    tone: 'caution',
    detail:
      'These flights are not on one ticket. Re-checking in, and anything that goes wrong in between, falls to you rather than the airline.',
  },
  DATA_STALE: {
    title: 'Some of this is past its freshness',
    tone: 'unknown',
    detail:
      'At least one figure behind this answer is older than it is meant to be relied on for. It was not quietly refreshed to look current.',
  },
  SOURCE_CONFLICT: {
    title: 'Sources disagree',
    tone: 'unknown',
    detail:
      'Two sources gave different answers about this airport. Neither was silently preferred, so treat the numbers as less settled than usual.',
  },
  TRAFFIC_DEGRADED: {
    title: 'Ground transport is degraded',
    tone: 'caution',
    detail:
      'Traffic or transit conditions behind the travel estimate are worse than the figure it was built from.',
  },
  FLIGHT_MOVED_EARLIER: {
    title: 'Your flight moved earlier',
    tone: 'caution',
    detail:
      'The boarding cutoff came forward, so this was measured again against a shorter window than the one you planned in.',
  },
  FLIGHT_DELAY_CREATED_OPPORTUNITY: {
    title: 'A delay widened your window',
    tone: 'opportunity',
    detail:
      'Your flight moved later, so there is more usable time now than when this plan was made.',
  },
  RETURN_THRESHOLD_REACHED: {
    title: 'Time to head back',
    tone: 'blocking',
    detail:
      'You have reached the point where the certified return deadline governs what happens next, whatever else is still open.',
  },
  RECOMMENDATION_EXPIRED: {
    title: 'This suggestion has expired',
    tone: 'caution',
    detail:
      'It was measured against a window that has since moved, so it no longer carries a certified answer.',
  },
  AIRPORT_MATURITY_LIMITED: {
    title: 'Limited data for this airport',
    tone: 'unknown',
    detail:
      'Nobody has curated this airport’s timings, so these minutes come from generic defaults rather than from anything specific to here.',
  },
};

const KNOWN = new Set<string>(LAYOVER_REASON_CODES);

/**
 * One code, rendered. An unrecognised token is carried through rather than
 * dropped; see the header for why that is the only honest option.
 */
export function describeReasonCode(code: string): RenderedReasonCode {
  if (KNOWN.has(code)) {
    const entry = TABLE[code as LayoverReasonCode];
    return { code, known: true, title: entry.title, detail: entry.detail, tone: entry.tone };
  }
  return { code, known: false, title: code, detail: null, tone: 'unknown' };
}

/**
 * The list a surface renders, in the server's order.
 *
 * Absence answers `[]`, which a caller renders as nothing rather than as a
 * cleared list. The only tokens dropped are ones that carry no information at
 * all — a non-string, or a blank — because there is nothing to put on screen
 * for them and a blank bullet reads as a fact that failed to load.
 */
export function describeReasonCodes(
  codes: readonly string[] | null | undefined,
): RenderedReasonCode[] {
  if (!codes || !Array.isArray(codes)) return [];
  const seen = new Set<string>();
  const out: RenderedReasonCode[] = [];
  for (const raw of codes) {
    if (typeof raw !== 'string') continue;
    const code = raw.trim();
    if (!code) continue;
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(describeReasonCode(code));
  }
  return out;
}
