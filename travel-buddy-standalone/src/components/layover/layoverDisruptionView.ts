/**
 * Which disruption state the layover screen shows, and from whose memory
 * (census-layover L148, round 2).
 *
 * ── THE SERVER REMEMBERS, AND NOW IT SAYS SO ON EVERY READ ──────────────────
 * `GET /api/airport/sessions/:id/overview` carries a `disruption` member read
 * from the same ledger `POST /:id/disruption` writes (`layover_events`, through
 * `readDisruptionState`). So a reload shows the SERVER's memory of the flight,
 * including a report made from another device — not this phone's copy of the
 * last answer it happened to see.
 *
 * Three answers, three different facts:
 *   known, source `ledger`   a report is recorded; this is its state.
 *   known, source `default`  nothing has ever been reported for this layover.
 *   unknown                  the server could not read its ledger. NOT "no
 *                            disruption": the screen says it does not know.
 *
 * ── THE PHONE'S COPY IS A FALLBACK, NAMED AS ONE ────────────────────────────
 * `services/layoverDisruption.ts` keeps the server's last RECORDED answer on
 * the device. It is shown only when the server's member is unknown (or an older
 * server sent none), and the card captions it as this phone's copy. When the
 * server says what it remembers, the phone's copy is not shown at all — not
 * even when it disagrees, because the server's ledger is what the next report
 * starts from.
 *
 * ── A PRESS IN THIS MOUNT ───────────────────────────────────────────────────
 * The answer to a report the traveller just made IS the server's answer, and
 * carries what the overview member does not (the previous state, the recompute).
 * It stays on screen until the overview shows a LEDGER ROW RECORDED AFTER the
 * one it showed when the press was made, in a DIFFERENT state: a later report,
 * typically from another device. A re-read that merely catches up with the
 * press (same state) keeps the richer answer; an overview read that was already
 * in flight when the press was made (same or older row) cannot overwrite it.
 *
 * Pure, so the rule is pinned without a renderer.
 */
import type { DisruptionAnswer, DisruptionRecovery, RecoveryHelp } from '../../services/layoverDisruption.ts';

/** The overview member as this client reads it. `null` from the parser = the server sent none. */
export type OverviewDisruption =
  | {
      status: 'known';
      /** The state the server's ledger holds. A string: an unknown code is shown as itself. */
      state: string;
      /** `ledger` = a recorded report; `default` = nothing was ever reported. */
      source: 'ledger' | 'default';
      /** Who made the recorded report (`traveller` on this tree), or null when nothing was. */
      reportedBy: string | null;
      /** When the server recorded it (the ledger row's own time), or null. */
      recordedAt: string | null;
      /** The server's recovery posture for that state (`recoveryPosture`). */
      recovery: DisruptionRecovery | null;
    }
  | {
      status: 'unknown';
      /** The server's reason code (`ledger_unreadable`), or `malformed` for a member this build cannot read. */
      reason: string;
      /** The server's sentence, when it sent one. */
      message: string | null;
    };

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function helpOf(v: unknown): RecoveryHelp {
  // Only a literal `true` is help — the same rule `services/layoverDisruption.ts` applies to a report's answer.
  if (!isRecord(v)) return { available: false, reason: null };
  return { available: v.available === true, reason: str(v.reason) };
}

function recoveryOf(v: unknown): DisruptionRecovery | null {
  if (!isRecord(v)) return null;
  return {
    recoveryNeeded: v.recoveryNeeded === true,
    rebooking: helpOf(v.rebooking),
    airlineContact: helpOf(v.airlineContact),
    airportHelp: helpOf(v.airportHelp),
  };
}

const MALFORMED: OverviewDisruption = { status: 'unknown', reason: 'malformed', message: null };

/**
 * The overview's `disruption` member, read defensively.
 *
 * `null` ONLY when the member is absent (a server that predates it). Anything
 * present that this build cannot read is `unknown` — the server said something
 * about the flight, and "we could not read it" is the truthful rendering of
 * that, never "nothing reported".
 */
export function overviewDisruptionOf(v: unknown): OverviewDisruption | null {
  if (v === undefined || v === null) return null;
  if (!isRecord(v)) return MALFORMED;
  if (v.status === 'unknown') {
    return { status: 'unknown', reason: str(v.reason) ?? 'unknown', message: str(v.message) };
  }
  if (v.status !== 'known') return MALFORMED;
  const state = str(v.state);
  if (!state || (v.source !== 'ledger' && v.source !== 'default')) return MALFORMED;
  return {
    status: 'known',
    state,
    source: v.source,
    reportedBy: str(v.reportedBy),
    recordedAt: str(v.recordedAt),
    recovery: recoveryOf(v.recovery),
  };
}

/** The ledger row's time the overview showed, or null when it showed none. */
export function ledgerRecordedAt(member: OverviewDisruption | null): string | null {
  return member && member.status === 'known' && member.source === 'ledger' ? member.recordedAt : null;
}

export type KnownLedgerDisruption = Extract<OverviewDisruption, { status: 'known' }>;

export type DisruptionView =
  /** The answer to a report made in this mount — the server's own reply. */
  | { from: 'press'; answer: DisruptionAnswer; serverUnknown: boolean }
  /** The server's memory, from the overview. */
  | { from: 'server'; member: KnownLedgerDisruption; serverUnknown: false }
  /** This phone's copy — ONLY because the server's memory is unknown or was not sent. */
  | { from: 'phone'; answer: DisruptionAnswer; serverUnknown: boolean }
  /** Nothing to show: the server says nothing was reported, or nobody knows anything. */
  | { from: 'none'; serverUnknown: boolean };

/** `a` strictly later than `b`; a row is later than no row; an unreadable instant is never later. */
function recordedLater(a: string | null, b: string | null): boolean {
  if (!a) return false;
  const am = Date.parse(a);
  if (!Number.isFinite(am)) return false;
  if (!b) return true;
  const bm = Date.parse(b);
  return !Number.isFinite(bm) || am > bm;
}

/**
 * Decide what the card shows.
 *
 * @param server       the overview member (`overviewDisruptionOf`), or null when absent
 * @param held         the answer the card holds: a press's answer, or this phone's copy
 * @param heldFrom     which of the two `held` is (`null` when nothing is held)
 * @param heldAgainst  for a press: the ledger row time the overview showed when the press was made
 */
export function chooseDisruptionView(
  server: OverviewDisruption | null,
  held: DisruptionAnswer | null,
  heldFrom: 'press' | 'phone' | null,
  heldAgainst: string | null,
): DisruptionView {
  const serverUnknown = server?.status === 'unknown';
  const ledger = server && server.status === 'known' && server.source === 'ledger' ? server : null;

  if (held && heldFrom === 'press') {
    if (ledger && recordedLater(ledger.recordedAt, heldAgainst) && ledger.state !== held.state) {
      return { from: 'server', member: ledger, serverUnknown: false };
    }
    return { from: 'press', answer: held, serverUnknown };
  }
  if (server && server.status === 'known') {
    return ledger ? { from: 'server', member: ledger, serverUnknown: false } : { from: 'none', serverUnknown: false };
  }
  if (held && heldFrom === 'phone') return { from: 'phone', answer: held, serverUnknown };
  return { from: 'none', serverUnknown };
}

/** The sentence for a server that could not read its own memory. Never "nothing reported". */
export function serverUnknownSentence(member: OverviewDisruption | null): string {
  const said = member && member.status === 'unknown' ? member.message : null;
  return said ?? 'Portava could not read this flight\'s disruption history just now, so it cannot say whether a delay or cancellation was reported.';
}
