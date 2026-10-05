/**
 * Layover §4 / §5 / §12.1 facts — the wording behind the constraints card and
 * the baggage question on the start sheet.
 *
 * ── WHY THIS FILE HAS NO IMPORTS THAT RUN ────────────────────────────────────
 * Everything here is pure and type-only-imported, so the node:test runner
 * (`pnpm test`, scripts/run-node-tests.mjs) exercises it without dragging
 * react-native through esbuild — the arrangement `layoverReturnFacts.ts` set.
 *
 * ── THIS FILE DECIDES NOTHING ────────────────────────────────────────────────
 * Whether landside is open, whether an unknown matters and which question to
 * ask are all the SERVER's (`services/airport/LayoverConstraints.ts`); they
 * arrive as `landsideGate`, `question` and `layoverState`. What lives here is
 * presentation: a sentence per closure, a label per mode. A closure or a state
 * this build has never been taught survives as itself rather than as a blank.
 *
 * THE ONE RULE IT MIRRORS is `conservativeCheckedBags`, and only for a server
 * that predates `baggageMode`: that server reads `checkedBags` alone, so the
 * start sheet sends the cautious boolean beside the mode. It is pinned to the
 * server's `baggageChargesBags` table in the test.
 */
import type {
  BaggageMode,
  DeclarableConstraintField,
  LandsideClosure,
  LayoverConstraintsAnswer,
} from '../../services/layover.ts';

export const BAGGAGE_MODE_ORDER: BaggageMode[] = ['CARRY_ON_ONLY', 'CHECKED_THROUGH', 'COLLECT_RECHECK', 'UNKNOWN'];

export const BAGGAGE_MODE_COPY: Record<BaggageMode, { label: string; blurb: string }> = {
  CARRY_ON_ONLY: { label: 'Carry-on only', blurb: 'Nothing to collect and nothing to drop off.' },
  CHECKED_THROUGH: { label: 'Checked through', blurb: 'The airline moves your bag to the next flight.' },
  COLLECT_RECHECK: { label: 'I collect and re-check', blurb: 'You claim your bag here and drop it again before you fly.' },
  UNKNOWN: { label: 'Not sure', blurb: 'We count the time to collect and re-check it until you know.' },
};

/**
 * The boolean an OLDER server reads. UNKNOWN is charged, never waved through —
 * the same table as the server's `baggageChargesBags`.
 */
export function conservativeCheckedBags(mode: BaggageMode): boolean {
  return mode === 'COLLECT_RECHECK' || mode === 'UNKNOWN';
}

/** Yes / No / Not sure, for the two connection facts. `null` is "not stated". */
export const TRI_STATE_OPTIONS: Array<{ value: boolean | null; label: string }> = [
  { value: false, label: 'No' },
  { value: true, label: 'Yes' },
  { value: null, label: 'Not sure' },
];

export const CONNECTION_FIELD_COPY: Record<Exclude<DeclarableConstraintField, 'baggageMode'>, { title: string; blurb: string }> = {
  recheckRequired: {
    title: 'Separate tickets?',
    blurb: 'If your flights are booked separately you check in again, and a missed connection is yours to fix.',
  },
  airportChangeRequired: {
    title: 'Different airport for the next flight?',
    blurb: 'If you fly out of another airport, getting there comes before anything else.',
  },
};

const CLOSURE_COPY: Record<LandsideClosure, string> = {
  traveller_staying_airside: 'You chose to stay at the airport.',
  insufficient_time: 'There is not enough time to leave and get back.',
  entry_refused: 'Your passport needs something you cannot get during a layover to enter this country.',
  entry_unconfirmed: 'We could not confirm that your passport lets you into this country.',
  baggage_unknown: 'We need to know what happens to your checked bag.',
  airport_change: 'Your next flight leaves from a different airport.',
};

/** One sentence per closure, in the server's order. An untaught closure is shown as its own code. */
export function describeClosures(closedBy: readonly string[]): Array<{ code: string; sentence: string }> {
  return closedBy.map((code) => ({
    code,
    sentence: (CLOSURE_COPY as Record<string, string | undefined>)[code] ?? code,
  }));
}

const STATE_COPY: Record<string, { label: string; tone: 'ask' | 'closed' | 'open' | 'return' | 'done' }> = {
  NEEDS_INFO: { label: 'One answer needed', tone: 'ask' },
  AIRPORT_ONLY: { label: 'Airport only', tone: 'closed' },
  LANDSIDE_AVAILABLE: { label: 'You can go out', tone: 'open' },
  PLAN_SELECTED: { label: 'Plan set', tone: 'open' },
  RETURN_SOON: { label: 'Head back soon', tone: 'return' },
  RETURN_NOW: { label: 'Head back now', tone: 'return' },
  RETURNING: { label: 'Returning to the airport', tone: 'return' },
  COMPLETED: { label: 'Completed', tone: 'done' },
  CANCELLED: { label: 'Ended', tone: 'done' },
  EXPIRED: { label: 'Ended', tone: 'done' },
};

/**
 * The lifecycle state as a badge, or null when the server withheld it. A state
 * this build does not know is rendered as its own token — never dropped, and
 * never guessed into one of the known ones.
 */
export function describeLayoverState(
  state: string | null,
): { label: string; tone: 'ask' | 'closed' | 'open' | 'return' | 'done' | 'unknown' } | null {
  if (!state) return null;
  return STATE_COPY[state] ?? { label: state, tone: 'unknown' };
}

/**
 * What the card says about the bags when NO four-way answer is stored — the
 * server kept (or only ever had) a boolean. Said as what is being COUNTED, not
 * as a mode the traveller never chose.
 */
export function legacyBaggageLine(baggageCharged: boolean): string {
  return baggageCharged
    ? 'Time to collect and re-check a bag is being counted.'
    : 'No bag time is being counted.';
}

/**
 * The storage posture, said plainly, or null when there is nothing to say.
 * `session_booleans_only` is not an error and is not hidden: the traveller's
 * "not sure" is being kept as "bags to collect", and they should know that is
 * why it reads back that way.
 */
export function storageNote(answer: Pick<LayoverConstraintsAnswer, 'storage'>): string | null {
  return answer.storage === 'session_booleans_only'
    ? 'For now we can only keep whether a bag needs collecting. "Not sure" is kept as the cautious answer.'
    : null;
}

const FIELD_NAME: Record<DeclarableConstraintField, string> = {
  baggageMode: 'your bag details',
  recheckRequired: 'whether you check in again',
  airportChangeRequired: 'whether you change airports',
};

/** After a save: what could NOT be kept, as a sentence, or null when everything was. */
export function unsavedNote(unsaved: readonly DeclarableConstraintField[]): string | null {
  if (unsaved.length === 0) return null;
  const names = unsaved.map((f) => FIELD_NAME[f] ?? f);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `We could not keep ${list} yet.`;
}

/** The mode a control should show as selected: the declared one, or none. */
export function selectedBaggageMode(answer: Pick<LayoverConstraintsAnswer, 'constraints'>): BaggageMode | null {
  return answer.constraints?.baggageMode ?? null;
}
