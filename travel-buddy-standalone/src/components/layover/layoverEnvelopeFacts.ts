/**
 * Layover envelope facts — what the map may CALL the envelope, and whether it
 * may draw it at all.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 * The envelope is cut from the usable window, and the usable window is the same
 * number whether or not the traveller may leave the airport. `LayoverMapCard`
 * drew whatever it was handed under the words "SAFE ENVELOPE" — so a traveller
 * with a refused border and eight usable hours saw a ring labelled SAFE beside
 * a verdict of "No — stay airside" (PR #624's verification, item 3).
 *
 * The server now publishes the landside gate beside the envelope
 * (`safeEnvelopeGate`) and withholds the envelope when the gate is closed. This
 * file is the one place the client decides what to do with that:
 *
 *   open              drawn, and called what the spec calls it.
 *   caution           drawn, WITHOUT the word "safe". The clock still has a
 *                     reach and the verdict card above says so in amber ("Time
 *                     is fine — entry unconfirmed"); this says the same thing
 *                     in the same register. It is the clock's reach, not a
 *                     clearance.
 *   closed            NOT drawn, even if a server sent one.
 *   (not reported)    a server that predates the gate. Treated exactly as a
 *                     caution: an envelope whose gate nobody stated is not one
 *                     this build will call safe.
 *
 * ── NO IMPORTS THAT RUN ──────────────────────────────────────────────────────
 * Pure, so `pnpm test` (node:test) exercises it without react-native.
 */
import { describeCautions } from './layoverVerdictFacts.ts';

/** The server's `safeEnvelopeGate`, as much of it as this reads. Every member optional: an older server sends none. */
export interface EnvelopeGate {
  status?: string;
  cautions?: readonly string[];
  withheld?: string | null;
}

/**
 *   clear     the ONE case the envelope is called safe.
 *   caution   drawn, relabelled.
 *   withheld  the gate is closed; nothing is drawn.
 *   absent    there is no envelope and the gate did not close it (no airport coordinate).
 */
export type EnvelopeTone = 'clear' | 'caution' | 'withheld' | 'absent';

export interface EnvelopeDescription {
  tone: EnvelopeTone;
  /** May the rings be drawn? */
  draw: boolean;
  /** The label over the diagram. Null when nothing is drawn. */
  label: string | null;
  /** Said under the label when the envelope is NOT a clearance. Null when it is. */
  note: string | null;
  /** Why it is not a clearance, one sentence each. */
  reasons: Array<{ code: string; sentence: string }>;
  /** What is said INSTEAD of the diagram. Null when the diagram is drawn. */
  withheldText: string | null;
}

export const ENVELOPE_LABEL_CLEAR = 'SAFE ENVELOPE';
export const ENVELOPE_LABEL_CAUTION = 'TIME ENVELOPE — NOT A CLEARANCE';
const NOT_A_CLEARANCE = 'This is how far the clock reaches. It is not a yes to leaving the airport.';
const GATE_NOT_REPORTED: { code: string; sentence: string } = {
  code: 'gate_not_reported',
  sentence: 'we could not confirm whether leaving the airport is cleared — check the answer at the top of this page',
};
const WITHHELD_CLOSED = 'Leaving the airport is not on for this layover, so no reach is drawn on this map.';
const ABSENT = 'No safe envelope has been certified for this layover, so nothing on this map is marked reachable or blocked.';

/**
 * What the map does with the envelope it was handed.
 *
 * `hasEnvelope` is whether geometry arrived at all. The gate decides the rest,
 * and it is read DEFENSIVELY: a closed gate wins over an envelope that arrived
 * anyway, and only the literal status `open` earns the word "safe".
 */
export function describeEnvelope(hasEnvelope: boolean, gate: EnvelopeGate | null | undefined): EnvelopeDescription {
  const status = gate?.status;
  if (status === 'closed' || gate?.withheld === 'landside_closed') {
    return { tone: 'withheld', draw: false, label: null, note: null, reasons: [], withheldText: WITHHELD_CLOSED };
  }
  if (!hasEnvelope) {
    return { tone: 'absent', draw: false, label: null, note: null, reasons: [], withheldText: ABSENT };
  }
  if (status === 'open') {
    return { tone: 'clear', draw: true, label: ENVELOPE_LABEL_CLEAR, note: null, reasons: [], withheldText: null };
  }
  // `caution`, a status this build was never taught, or no gate at all.
  const reasons = status === 'caution' ? describeCautions(gate?.cautions) : [GATE_NOT_REPORTED];
  return { tone: 'caution', draw: true, label: ENVELOPE_LABEL_CAUTION, note: NOT_A_CLEARANCE, reasons, withheldText: null };
}

/** What a stop's band row says when the gate is closed and the stop is outside the airport. */
export const STOP_NOT_ON_OFFER = 'Leaving the airport is not on for this layover, so this stop is not on offer.';

// ── the crew card ────────────────────────────────────────────────────────────

/**
 * Said on EVERY crew surface — the crew card, and the roster of crews on offer.
 *
 * The server certifies a crew's deadline and nothing about its border: it never
 * reads a crewmate's passport (a privacy control, kept). So "Everyone must be
 * back by 14:10" must never read as "everyone may go" — and this is what stops
 * it. Not conditional on anything, because no payload can lift it.
 *
 * It does NOT say a crew is a trip into the city. A crew may meet in the
 * terminal, and joining one is not leaving the airport; the sentence is about
 * the moment somebody does.
 */
export const CREW_EACH_CHECKS_OWN =
  'This is a deadline, not a clearance. Before leaving the airport, each of you must check your own entry and your own layover — everyone checks their own answer.';

/**
 * What a member is told about THEIR OWN landside gate, on a crew they are in.
 *
 * Their own record only. A closed gate does not stop them being in the crew —
 * a crew can meet inside the airport — so this says what is not open to them
 * and nothing about the group. Null when the gate is open, and when the server
 * did not say (an older server): nothing is claimed about a gate nobody stated.
 */
export function crewOwnGateNote(yourLandside: string | null | undefined): string | null {
  if (yourLandside === 'closed') {
    return 'Your own layover does not allow leaving the airport right now. You can still meet this crew inside the airport; anything in the city is not open to you. See the answer at the top of this page.';
  }
  if (yourLandside === 'caution') {
    return 'Whether you can leave the airport is not confirmed. Anything this crew does in the city is not a yes for you until it is — see the answer at the top of this page.';
  }
  return null;
}

/** The two answers to "where is that meeting point?", in the order the composer offers them. */
export const MEETING_POINT_PLACE_OPTIONS: Array<{ insideAirport: boolean; label: string }> = [
  { insideAirport: true, label: 'Inside the airport' },
  { insideAirport: false, label: 'In the city' },
];

/** Asked when a meeting point was typed and not placed. The server cannot classify free text; the creator says. */
export const MEETING_POINT_PLACE_NEEDED = 'Say whether that meeting point is inside the airport or in the city.';
