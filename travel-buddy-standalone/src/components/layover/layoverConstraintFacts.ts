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
 * The lifecycle BADGE is no longer worded here. It lived in a `STATE_COPY`
 * table keyed on `layoverState` alone, which is how a green "You can go out"
 * came to sit under an amber verdict; it is `describeLandsideBadge` in
 * `layoverVerdictFacts.ts` now, a function of the verdict both cards share.
 *
 * THE ONE RULE IT MIRRORS is `conservativeCheckedBags`, and only for a server
 * that predates `baggageMode`: that server reads `checkedBags` alone, so the
 * start sheet sends the cautious boolean beside the mode. It is pinned to the
 * server's `baggageChargesBags` table in the test.
 */
import type {
  BaggageMode,
  ConstraintQuestion,
  DeclarableConstraintField,
  LandsideClosure,
  LayoverConstraintPatch,
  LayoverConstraintsAnswer,
  LayoverCreationConstraints,
  PlanFit,
} from '../../services/layover.ts';
import { describeCautions } from './layoverVerdictFacts.ts';

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

/**
 * Yes / No / Not sure, for the two connection facts. `null` is "not stated".
 *
 * "Not sure" is a real declaration and is SENT as `null` — it withdraws an
 * earlier answer. It is NOT "no": the server treats an unstated airport change
 * as an unknown that closes landside and asks the traveller to confirm, and an
 * unstated ticketing answer as the cautious case. (It used to read both as
 * "no", and this chip was how a traveller said so.)
 */
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
  constraints_unreadable: 'We could not read your bag and connection details just now. Try again shortly before deciding to leave.',
  airport_change_unknown: 'We need to know whether your next flight leaves from this airport or a different one.',
  recheck_unknown: 'We need to know whether your flights are on one ticket or booked separately.',
};

/** One sentence per closure, in the server's order. An untaught closure is shown as its own code. */
export function describeClosures(closedBy: readonly string[]): Array<{ code: string; sentence: string }> {
  return closedBy.map((code) => ({
    code,
    sentence: (CLOSURE_COPY as Record<string, string | undefined>)[code] ?? code,
  }));
}

/**
 * The patch that answers the server's one question with one of its options.
 *
 * The card used to send `{ baggageMode: option }` for every question, because
 * bags were the only thing ever asked about. The field is the QUESTION's.
 * Returns null for a question or a value this build cannot express as a
 * declaration — the card then sends nothing rather than a guess.
 */
export function questionPatch(question: ConstraintQuestion, value: unknown): LayoverConstraintPatch | null {
  if (question.field === 'baggageMode') {
    return typeof value === 'string' && (BAGGAGE_MODE_ORDER as string[]).includes(value)
      ? { baggageMode: value as BaggageMode }
      : null;
  }
  if (typeof value !== 'boolean') return null;
  if (question.field === 'airportChangeRequired') return { airportChangeRequired: value };
  if (question.field === 'recheckRequired') return { recheckRequired: value };
  return null;
}

/** Why the traveller is being asked: the sentence under the question, per field. */
const QUESTION_WHY: Record<DeclarableConstraintField, string> = {
  baggageMode:
    'Your answer decides whether you have time to leave the airport, so we are holding back anything outside it until you tell us.',
  airportChangeRequired:
    'If your next flight leaves from a different airport, getting there comes first — so we are holding back anything outside this one until you confirm.',
  recheckRequired:
    'On separate tickets you check in again, which takes time — so we are holding back anything outside the airport until you tell us.',
};

export function questionWhy(field: string): string {
  return (QUESTION_WHY as Record<string, string | undefined>)[field] ?? QUESTION_WHY.baggageMode;
}

/**
 * What the dashboard says when the answers given AT THE START were not kept.
 *
 * `POST /airport/sessions` reports what it did with them and the client used
 * to throw that away, so a traveller who chose "Not sure" on the start sheet
 * landed on a dashboard that showed no sign their answer had not been stored.
 * Null when everything sent was kept (or nothing was reported).
 */
export function creationNote(constraints: LayoverCreationConstraints | null | undefined): string | null {
  if (!constraints) return null;
  if (constraints.stored === 'not_stored') {
    return 'Your bag details were not saved when you started this layover. Set them here — until you do, we count the time to collect and re-check a bag.';
  }
  return unsavedNote(constraints.unsaved);
}

/** The route-param value the start sheet hands the dashboard, or null when there is nothing to say. */
export function creationNoteParam(constraints: LayoverCreationConstraints | null | undefined): 'not_stored' | 'unsaved' | null {
  if (!constraints) return null;
  if (constraints.stored === 'not_stored') return 'not_stored';
  return constraints.unsaved.length > 0 ? 'unsaved' : null;
}

/** The sentence for a route-param value. An unknown value says nothing rather than something wrong. */
export function creationNoteForParam(param: string | null | undefined): string | null {
  if (param === 'not_stored') return creationNote({ stored: 'not_stored', reason: 'unknown', message: '', retryable: true });
  if (param === 'unsaved') return 'Some of what you told us when you started could not be kept yet. Check your bag and connection details here.';
  return null;
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

export type PlanFitTone = 'fits' | 'unconfirmed' | 'unknown' | 'over' | 'blocked';

const PLAN_BLOCKED_TEXT = 'This plan leaves the airport, and we are not suggesting that for this layover.';
/** A landside plan whose gate the server did not state — an older server, or a payload that lost the field. */
const PLAN_GATE_NOT_REPORTED: { code: string; sentence: string } = {
  code: 'gate_not_reported',
  sentence: 'we could not confirm whether leaving the airport is cleared — check the answer at the top of this page',
};

/**
 * The plan's fit meter, as words — FIVE answers, and only one of them green.
 *
 * The meter read `usableMinutes` and nothing else, and the usable window is the
 * same number whether or not the traveller may leave the airport. So a plan
 * through the city read "fits with room", in green, under a verdict of "No —
 * stay airside" for a refused border. The server now folds the landside gate
 * into `fit` and says why in `landside`; this renders both.
 *
 *   fits         every leg stated, inside the window, and the gate is open.
 *   unconfirmed  it fits the clock and the gate is not open — said in amber,
 *                with the server's cautions.
 *   blocked      the plan leaves the airport and the gate is closed — said
 *                with the server's closures.
 *   over         the lower bound overflows. Arithmetic, and certain.
 *   unknown      a leg nobody stated — and ANY value this build has not been
 *                taught, which is never rendered as a fit.
 *
 * ── `fit: "fits"` IS NOT BELIEVED ON ITS OWN ─────────────────────────────────
 * A server that predates the gate sends `fit: "fits"` from the clock alone, with
 * no `landside` and no `hasLandsideStop` — and the hosted app runs such a build
 * while clients update independently. Trusting the word drew "fits with room"
 * in green under a refused border (PR #624's verification, item 1). So green
 * needs one of two things the payload must actually say:
 *
 *   - the plan never leaves the airport (no stop outside it, by the server's
 *     flag AND by the stops this screen holds — either saying "landside" wins);
 *   - or `landside.status === "open"`.
 *
 * A landside plan whose gate was not reported is `unconfirmed`. A landside plan
 * whose gate is reported closed is `blocked`, whatever `fit` says.
 *
 * `stops` are the stops the caller renders; `fmt` is its duration formatter,
 * passed in so this file keeps no runtime import of the theme.
 */
export function describePlanFit(
  planFit: PlanFit,
  stops: ReadonlyArray<{ insideAirport?: boolean | null }>,
  fmt: (minutes: number) => string,
): { tone: PlanFitTone; text: string; reasons: Array<{ code: string; sentence: string }> } {
  const stopCount = stops.length;
  const planned = `Planned ${fmt(planFit.totalPlannedMin)} of ${fmt(planFit.usableMinutes)} usable`;
  switch (planFit.fit) {
    case 'fits': {
      const leavesAirport = planFit.hasLandsideStop === true || stops.some((s) => s.insideAirport !== true);
      const status = planFit.landside?.status;
      if (!leavesAirport || status === 'open') {
        return { tone: 'fits', text: `${planned} — fits with room`, reasons: [] };
      }
      if (status === 'closed') {
        return { tone: 'blocked', text: PLAN_BLOCKED_TEXT, reasons: describeClosures(planFit.landside?.closedBy ?? []) };
      }
      return {
        tone: 'unconfirmed',
        text: `${planned} — it fits the clock, but that is not a yes yet`,
        reasons: status === 'caution' ? describeCautions(planFit.landside?.cautions ?? []) : [PLAN_GATE_NOT_REPORTED],
      };
    }
    case 'over':
      return {
        tone: 'over',
        text: `Over by ${fmt(planFit.overflowMin)} — trim ${stopCount > 1 ? 'a stop' : 'this stop'} or shorten it`,
        reasons: [],
      };
    case 'blocked':
      return {
        tone: 'blocked',
        text: PLAN_BLOCKED_TEXT,
        reasons: describeClosures(planFit.landside?.closedBy ?? []),
      };
    case 'unconfirmed':
      return {
        tone: 'unconfirmed',
        text: `${planned} — it fits the clock, but that is not a yes yet`,
        reasons: describeCautions(planFit.landside?.cautions ?? []),
      };
    default:
      return {
        tone: 'unknown',
        text: `At least ${fmt(planFit.neededMin)} of ${fmt(planFit.usableMinutes)} usable — ${
          planFit.unstatedTravelStops > 0
            ? `${planFit.unstatedTravelStops === 1 ? 'one stop has' : `${planFit.unstatedTravelStops} stops have`} no travel time yet, so this is not a fit we can promise`
            : 'part of this plan has no time on it yet, so this is not a fit we can promise'
        }`,
        reasons: [],
      };
  }
}
