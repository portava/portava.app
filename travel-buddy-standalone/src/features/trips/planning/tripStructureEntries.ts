/**
 * §5.1 and §8 on the client — adding a stage, a leg, a commitment or a goal to a trip.
 *
 * WHY THIS EXISTS (census-trips TR78, TR79, TR81, TR84)
 * ====================================================
 * `trip_stages`, `trip_legs`, `trip_commitments` and `trip_goals` each have a
 * writer (2764's ADD_STAGE, 2765's ADD_LEG / ADD_COMMITMENT, 2766 + 2783's
 * ADD_GOAL), issued by POST /trips/:tripId/commands whatever
 * `trip_kernel_enabled` says, and a reader (GET /trips/:tripId/structure and
 * GET /trips/:tripId/decisions). Nothing in the product issued the writers, so
 * every real trip's stages, legs, commitments and goals stayed empty. The lead's
 * ruling on the Trips census: a TABLE row is correct only when a product surface
 * populates it. These four functions are that population, behind
 * TripStructureComposer.
 *
 * THE ONLY WRITE PATH IS THE KERNEL
 * =================================
 * As for decision tasks (tripDecisionEntries.ts): one command through the one
 * endpoint, run in `trip_kernel_execute`, which checks crew membership, the
 * vocabularies (the migrations' CHECKs), that a leg's two stages and a
 * commitment's stage belong to THIS trip, and that a stage's sequence is free.
 * Nothing here writes a table. The commands themselves are built in
 * tripStructurePayloads.ts, which the api-server's real-chain suite runs.
 *
 * A STAGE'S ANCHOR
 * ================
 * 2760 requires exactly one of `place_id` / `city_id` (`trip_stages_one_anchor`)
 * and the kernel casts it to uuid. The composer anchors a stage to a CITY: the
 * universal location registry's canonical id for the city the traveller picked
 * (POST /api/locations/resolve). An unresolved pick has no such id and is
 * refused here rather than sent, because a stage with an invented anchor is a
 * stage nobody can locate. `place_id` is not written: it is read against
 * `public.places` (the map's stage layer), which the city picker does not return.
 *
 * ONE KEY PER INTENT
 * ==================
 * Each tap mints a fresh key (`structureEntryKey`); the composer keeps the key
 * AND the input it sent, so a retry after an unreachable kernel re-sends THAT
 * command and can never add the row twice.
 */
import { intentKey } from '../shared/tripApi.ts';
import type { TripCommandRequest, TripCommandResult } from '../../../services/tripCommands.ts';
import {
  legCommand, goalCommand,
  type StructureCommand, type StageInput, type LegInput, type CommitmentInput, type GoalInput,
} from './tripStructurePayloads.ts'; import { boundedStageCommand, detailedCommitmentCommand, type DetailedCommand, type StageBounds, type CommitmentDetails } from './tripStructureDetails.ts'; // census-trips TR13/TR15/TR122-TR127: boundaries and §7.1 fields

export {
  STAGE_TYPES, LEG_TYPES, COMMITMENT_TYPES, COMMITMENT_FLEXIBILITIES, GOAL_TYPES, GOAL_PRIORITIES, GOAL_SCOPES,
  isUuid, nextStageSequence, stageCommand, legCommand, commitmentCommand, goalCommand,
  type StageType, type LegType, type CommitmentType, type CommitmentFlexibility, type GoalType, type GoalPriority, type GoalScope,
} from './tripStructurePayloads.ts';

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

export type StructureEntryResult =
  | { state: 'recorded'; duplicate: boolean; id: string | null }
  | { state: 'refused'; reason: string; detail: string }
  | { state: 'unavailable'; detail: string };

const REFUSAL_TEXT: Record<string, string> = {
  TRIP_AUTH_NOT_CREW: 'only the trip crew can add to this trip',
  TRIP_COMMAND_MALFORMED: "the trip didn't accept that entry",
  TRIP_STAGE_SEQUENCE_TAKEN: 'another stage was added at that position first',
  TRIP_STAGE_NOT_FOUND: 'that stage is no longer on this trip',
  LOCAL_INVALID: 'pick one of the offered options',
  LOCAL_SAME_STAGE: 'a leg needs two different stages',
  LOCAL_NO_ANCHOR: "that city couldn't be matched to a known city",
  LOCAL_NO_TIMEZONE: 'no time zone is known for that city', LOCAL_BAD_TIME: 'a time could not be read', LOCAL_ENDS_BEFORE_START: 'the stage would end before it starts', LOCAL_ARRIVAL_AFTER_START: 'the arrival time is after it starts', LOCAL_BAD_DURATION: 'minutes must be a whole number', LOCAL_BAD_CONFIDENCE: 'pick one of the offered confidences',
};

function resultId(result: unknown): string | null {
  if (result && typeof result === 'object' && 'id' in result) {
    const id = (result as { id?: unknown }).id;
    return typeof id === 'string' ? id : null;
  }
  return null;
}

function toResult(r: TripCommandResult): StructureEntryResult {
  if (r.ok) return { state: 'recorded', duplicate: r.duplicate, id: resultId(r.result) };
  if (r.kind === 'unavailable') return { state: 'unavailable', detail: r.detail };
  return { state: 'refused', reason: r.reason, detail: REFUSAL_TEXT[r.reason] ?? r.detail ?? r.reason };
}

async function send(tripId: string, cmd: StructureCommand | DetailedCommand, idempotencyKey: string): Promise<StructureEntryResult> {
  if (!cmd.ok) return { state: 'refused', reason: cmd.reason, detail: REFUSAL_TEXT[cmd.reason]! };
  return toResult(await issue(tripId, { type: cmd.type, payload: cmd.payload, idempotencyKey }));
}

/** A fresh key for one tap. Keep it to retry that tap; mint a new one for the next. */
export function structureEntryKey(kind: 'stage' | 'leg' | 'commitment' | 'goal'): string {
  return intentKey(`structure-entry:${kind}`);
}

/** ADD_STAGE { stage_type, city_id, timezone, sequence, starts_at?, ends_at? } (tripStructureDetails.ts adds the boundaries). */
export async function addStage(tripId: string, input: StageInput & StageBounds, idempotencyKey: string): Promise<StructureEntryResult> {
  return send(tripId, boundedStageCommand(input), idempotencyKey);
}

/** ADD_LEG { leg_type, from_stage_id, to_stage_id }. */
export async function addLeg(tripId: string, input: LegInput, idempotencyKey: string): Promise<StructureEntryResult> {
  return send(tripId, legCommand(input), idempotencyKey);
}

/** ADD_COMMITMENT { type, flexibility, stage_id?, and §7.1's starts_at, required_arrival_at, lateness_tolerance, prep_duration, confidence when given }. */
export async function addCommitment(tripId: string, input: CommitmentInput & CommitmentDetails, idempotencyKey: string): Promise<StructureEntryResult> {
  return send(tripId, detailedCommitmentCommand(input), idempotencyKey);
}

/** ADD_GOAL { type, priority, scope }. */
export async function addGoal(tripId: string, input: GoalInput, idempotencyKey: string): Promise<StructureEntryResult> {
  return send(tripId, goalCommand(input), idempotencyKey);
}

/**
 * The trip's time zone from whatever the trip read carried, or null. The trip
 * read is typed without it (TripDetail), and an unknown shape must not become a
 * guessed zone.
 */
export function tripTimezoneOf(trip: unknown): string | null {
  if (!trip || typeof trip !== 'object' || !('timezone' in trip)) return null;
  const tz = (trip as { timezone?: unknown }).timezone;
  return typeof tz === 'string' && tz.trim() ? tz.trim() : null;
}
