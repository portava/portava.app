/**
 * Layover verdict facts — ONE table behind the two cards that answer "can I
 * leave the airport?".
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 * `CanILeaveCard` drew the verdict from a table inside its own .tsx, and
 * `LayoverConstraintsCard`, mounted directly beneath it, drew a lifecycle badge
 * from a second table keyed on a different field. Nothing held the two
 * together, and they came apart on the dashboard: an amber "Time is fine —
 * entry unconfirmed" above a green "You can go out", for a traveller whose
 * border nobody had checked (PR #588's verification, blocker 1).
 *
 * Both cards now read THIS table. The badge is a function of the verdict, so a
 * green badge beneath a non-green verdict is not a state this file can produce:
 * `describeLandsideBadge` returns tone `open` on exactly one path, and that
 * path requires the verdict to be `yes`.
 *
 * ── IT TRUSTS THE VERDICT OVER THE STATE, ON PURPOSE ─────────────────────────
 * A server that predates the fix still sends `layoverState:
 * "LANDSIDE_AVAILABLE"` beside `verdict: "entry_unverified"`. A client that
 * believed the state would redraw the defect against an old server, so an
 * affirmative state is honoured only when the verdict and the gate agree.
 *
 * ── NO IMPORTS ───────────────────────────────────────────────────────────────
 * Not one, not even a type. `artifacts/api-server/src/test/
 * layoverGateFailClosed.test.ts` imports this file to derive both cards from
 * the server's real payload, for every verdict value; an import here would
 * drag the app's module graph into the API's test program.
 */

/** The server's `LeaveAdvice["verdict"]` union, restated because this file imports nothing. */
export type LeaveVerdict = 'yes' | 'tight' | 'no' | 'entry_unverified' | 'stay_airside';

/**
 *   affirm   the ONE green. Only `yes`.
 *   caution  the clock or the border is short of a yes. Amber.
 *   refuse   leaving is not on. Signal.
 *   staying  the traveller's own choice. Neutral.
 */
export type VerdictTone = 'affirm' | 'caution' | 'refuse' | 'staying';

export interface VerdictCopy {
  /** The pill on `CanILeaveCard`. */
  label: string;
  /** The short form the constraints card's badge uses for a cautionary verdict. */
  badge: string;
  tone: VerdictTone;
}

export const VERDICT_COPY: Record<LeaveVerdict, VerdictCopy> = {
  yes:              { label: 'Yes — you have time',              badge: 'You can go out',     tone: 'affirm' },
  tight:            { label: 'Tight — stay close',               badge: 'Tight — stay close', tone: 'caution' },
  no:               { label: 'No — stay airside',                badge: 'Airport only',       tone: 'refuse' },
  // Not a time verdict. The clock allows the trip; what we could not confirm is
  // that this passport may enter this country. Cautionary rather than a
  // refusal, because it is an unknown and not a no.
  entry_unverified: { label: 'Time is fine — entry unconfirmed', badge: 'Entry unconfirmed',  tone: 'caution' },
  stay_airside:     { label: 'Staying in — good call',           badge: 'Airport only',       tone: 'staying' },
};

/**
 * What a verdict this build has never been taught is drawn as. Cautionary, and
 * it says so: an unknown verdict is the one thing that must never be green.
 */
export const UNKNOWN_VERDICT_COPY: VerdictCopy & { tone: 'caution' } = {
  label: 'We could not confirm this — check before you leave',
  badge: 'Not confirmed',
  tone: 'caution',
};

/** An OWN key of a copy table. `table[key]` alone would find `constructor` and `toString` on the prototype. */
function own<T>(table: Record<string, T>, key: unknown): T | undefined {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

function isLeaveVerdict(v: unknown): v is LeaveVerdict {
  return own(VERDICT_COPY, v) !== undefined;
}

/** The verdict as `CanILeaveCard` draws it. Never `affirm` for anything but `yes`. */
export function describeVerdict(verdict: unknown): VerdictCopy {
  return isLeaveVerdict(verdict) ? VERDICT_COPY[verdict] : UNKNOWN_VERDICT_COPY;
}

export type LandsideBadgeTone = 'ask' | 'closed' | 'open' | 'caution' | 'return' | 'done' | 'unknown';

export interface LandsideBadge {
  label: string;
  tone: LandsideBadgeTone;
}

/** States that are about WHERE the traveller is in the journey, not about whether they may leave. */
const JOURNEY_STATE_COPY: Record<string, LandsideBadge> = {
  RETURN_SOON: { label: 'Head back soon', tone: 'return' },
  RETURN_NOW:  { label: 'Head back now', tone: 'return' },
  RETURNING:   { label: 'Returning to the airport', tone: 'return' },
  COMPLETED:   { label: 'Completed', tone: 'done' },
  CANCELLED:   { label: 'Ended', tone: 'done' },
  EXPIRED:     { label: 'Ended', tone: 'done' },
};

/** The lifecycle states this build knows. Anything else is rendered as its own token. */
const KNOWN_STATES = new Set([
  ...Object.keys(JOURNEY_STATE_COPY), 'NEEDS_INFO', 'AIRPORT_ONLY', 'LANDSIDE_AVAILABLE', 'PLAN_SELECTED',
]);

/** The gate, as much of it as this badge reads. Every member optional: an older server sends fewer. */
export interface LandsideBadgeGate {
  open?: boolean;
  status?: string;
  closedBy?: readonly string[];
  cautions?: readonly string[];
  needsInfo?: string | null;
}

/**
 * The badge on the constraints card, or null when there is nothing to say.
 *
 * ORDER MATTERS, and each rung is narrower than the one below it:
 *   1. where the traveller is in the journey (returning, ended) — the server's.
 *   2. a question is open.
 *   3. the gate is closed, by anything.
 *   4. the verdict is cautionary — the verdict's own words.
 *   5. AFFIRMATIVE: only `yes`, with an open gate, on an affirmative state.
 *   6. a state this build does not know, shown as itself.
 */
export function describeLandsideBadge(input: {
  layoverState: string | null;
  verdict: unknown;
  gate: LandsideBadgeGate | null | undefined;
}): LandsideBadge | null {
  const { layoverState } = input;
  const gate = input.gate ?? {};
  const verdict = describeVerdict(input.verdict);
  const closedBy = gate.closedBy ?? [];

  const journey = own(JOURNEY_STATE_COPY, layoverState);
  if (journey) return journey;
  if (layoverState === 'NEEDS_INFO' || (gate.needsInfo !== undefined && gate.needsInfo !== null)) {
    return { label: 'One answer needed', tone: 'ask' };
  }
  if (
    closedBy.length > 0 || gate.status === 'closed' || layoverState === 'AIRPORT_ONLY' ||
    verdict.tone === 'refuse' || verdict.tone === 'staying'
  ) {
    return { label: 'Airport only', tone: 'closed' };
  }
  if (verdict.tone === 'caution') return { label: verdict.badge, tone: 'caution' };

  // From here the verdict is `yes`. It is affirmed only when the gate agrees —
  // `open === true`, and not contradicted by a status or a caution — AND the
  // server named an affirmative state. Anything short of that is not drawn
  // green: it is cautioned, or left unsaid.
  const gateAgrees =
    gate.open === true &&
    (gate.status === undefined || gate.status === 'open') &&
    (gate.cautions ?? []).length === 0;
  if (!gateAgrees) return { label: UNKNOWN_VERDICT_COPY.badge, tone: 'caution' };
  if (layoverState === 'PLAN_SELECTED') return { label: 'Plan set', tone: 'open' };
  if (layoverState === 'LANDSIDE_AVAILABLE') return { label: VERDICT_COPY.yes.badge, tone: 'open' };
  // A state this build predates survives as its own token, never guessed into
  // a known one. A WITHHELD state (null — the plan could not be read) is left
  // unsaid: the verdict card above already says yes, and this badge has
  // nothing certified to add.
  if (layoverState && !KNOWN_STATES.has(layoverState)) return { label: layoverState, tone: 'unknown' };
  return null;
}

/** Why a plan that leaves the airport is not a plain "fits". One sentence per caution. */
const CAUTION_COPY: Record<string, string> = {
  entry_unconfirmed: 'we could not confirm that your passport lets you into this country',
  tight_window: 'your window is tight — any delay could make you miss your flight',
};

/** The server's cautions as sentences, in its order. An untaught caution is shown as its own code. */
export function describeCautions(cautions: readonly string[] | null | undefined): Array<{ code: string; sentence: string }> {
  return (cautions ?? []).map((code) => ({ code, sentence: own(CAUTION_COPY, code) ?? code }));
}
