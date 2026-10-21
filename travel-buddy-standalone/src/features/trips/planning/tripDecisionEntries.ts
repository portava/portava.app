/**
 * §8 on the client — adding a decision task or a risk to a trip.
 *
 * WHY THIS EXISTS (census-trips TR85, TR86, TR21, TR22)
 * =====================================================
 * `trip_decision_tasks` and `trip_risks` had a writer (2766's ADD_DECISION_TASK /
 * ADD_RISK, issued by POST /trips/:tripId/commands whatever `trip_kernel_enabled`
 * says) and a reader (GET /trips/:tripId/decisions, drawn by TripDecisionsCard),
 * and nothing in the product could issue the writer. The lead's ruling on the
 * Trips census: a TABLE row is correct only when the product can populate it.
 * These two functions are that population, behind TripDecisionComposer.
 *
 * THE ONLY WRITE PATH IS THE KERNEL
 * =================================
 * As for ballots (tripBallots.ts): a command through the one endpoint, run in
 * `trip_kernel_execute`, which checks crew membership, the vocabularies (2762's
 * CHECKs) and — for a task — that an assignee is crew. Nothing here writes a
 * table. The vocabularies below are 2762's, so a value the database would refuse
 * is refused here first, with the reason in words.
 *
 * ONE KEY PER INTENT
 * ==================
 * Each tap mints a fresh key (`entryKey`); the composer keeps it to retry THAT
 * tap when the kernel could not be reached, so a retry cannot add the task twice
 * and a second, deliberate task is not answered with the first one's receipt.
 */
import { intentKey } from '../shared/tripApi.ts';
import type { TripCommandRequest, TripCommandResult } from '../../../services/tripCommands.ts';

/** 2762 `trip_decision_tasks_type_known`, in that order. */
export const DECISION_TASK_TYPES = ['booking', 'transport', 'lodging', 'document', 'payment', 'logistics', 'other'] as const;
export type DecisionTaskType = (typeof DECISION_TASK_TYPES)[number];

/** 2762 `trip_risks_likelihood_known` and `trip_risks_impact_known`. */
export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** Free text is bounded on the client so a paste cannot become a kernel refusal. */
export const ENTRY_TEXT_MAX = 200;

type Issuer = (tripId: string, cmd: TripCommandRequest) => Promise<TripCommandResult>;
let _testIssuer: Issuer | null = null;
/** Test seam: replace the kernel command client; null restores. */
export function _setTestIssuer(fn: Issuer | null): void { _testIssuer = fn; }

async function issue(tripId: string, cmd: TripCommandRequest): Promise<TripCommandResult> {
  if (_testIssuer) return _testIssuer(tripId, cmd);
  // Lazy: tripCommands.ts reaches lib/supabase.ts, which node:test cannot load.
  const { issueTripCommand } = await import('../../../services/tripCommands.ts');
  return issueTripCommand(tripId, cmd);
}

export type EntryResult =
  | { state: 'recorded'; duplicate: boolean }
  | { state: 'refused'; reason: string; detail: string }
  | { state: 'unavailable'; detail: string };

const REFUSAL_TEXT: Record<string, string> = {
  TRIP_AUTH_NOT_CREW: 'only the trip crew can add to this trip',
  TRIP_COMMAND_MALFORMED: "the trip didn't accept that entry",
  TRIP_ASSIGNEE_NOT_CREW: 'that person is not on this trip',
  LOCAL_INVALID: 'pick one of the offered options',
};

function toResult(r: TripCommandResult): EntryResult {
  if (r.ok) return { state: 'recorded', duplicate: r.duplicate };
  if (r.kind === 'unavailable') return { state: 'unavailable', detail: r.detail };
  return { state: 'refused', reason: r.reason, detail: REFUSAL_TEXT[r.reason] ?? r.detail ?? r.reason };
}

const refusedLocally = (): EntryResult => ({ state: 'refused', reason: 'LOCAL_INVALID', detail: REFUSAL_TEXT.LOCAL_INVALID! });

function boundedText(value: string | undefined): string | null {
  const text = (value ?? '').trim().slice(0, ENTRY_TEXT_MAX);
  return text.length > 0 ? text : null;
}

/** A fresh key for one tap. Keep it to retry that tap; mint a new one for the next. */
export function entryKey(kind: 'task' | 'risk'): string {
  return intentKey(`decision-entry:${kind}`);
}

/** ADD_DECISION_TASK { type, consequence? } — status defaults to pending in the kernel. */
export async function addDecisionTask(
  tripId: string,
  input: { type: string; consequence?: string },
  idempotencyKey: string,
): Promise<EntryResult> {
  if (!(DECISION_TASK_TYPES as readonly string[]).includes(input.type)) return refusedLocally();
  const consequence = boundedText(input.consequence);
  return toResult(await issue(tripId, {
    type: 'ADD_DECISION_TASK',
    payload: { type: input.type, ...(consequence ? { consequence } : {}) },
    idempotencyKey,
  }));
}

/** ADD_RISK { likelihood, impact, trigger_json? } — status defaults to open in the kernel. */
export async function addRisk(
  tripId: string,
  input: { likelihood: string; impact: string; note?: string },
  idempotencyKey: string,
): Promise<EntryResult> {
  if (!(RISK_LEVELS as readonly string[]).includes(input.likelihood)
    || !(RISK_LEVELS as readonly string[]).includes(input.impact)) return refusedLocally();
  const note = boundedText(input.note);
  return toResult(await issue(tripId, {
    type: 'ADD_RISK',
    payload: { likelihood: input.likelihood, impact: input.impact, ...(note ? { trigger_json: { description: note } } : {}) },
    idempotencyKey,
  }));
}
