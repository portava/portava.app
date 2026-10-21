/**
 * Changing a stage the trip already has — its boundaries and its lifecycle —
 * through the kernel (census-trips TR13, TR65).
 *
 * Before this file the product could ADD a stage (TripStructureComposer) and
 * never change one: no client issued UPDATE_STAGE, START_STAGE or
 * COMPLETE_STAGE, so every stage the product made stayed `planned`, undated,
 * and `trip.stage_started` (§4.2) never happened. All three go through
 * POST /trips/:tripId/commands, which issues them whatever
 * `trip_kernel_enabled` says (they have no legacy writer), and the result is
 * read back from GET /trips/:tripId/structure, which no flag gates.
 *
 * The commands are built in tripStagePayloads.ts (pure). Nothing here writes a
 * table. Each tap mints a key (`stageControlKey`); the control keeps the key
 * AND the command, so a retry after an unreachable kernel re-sends THAT
 * command and cannot apply it twice.
 */
import { intentKey } from '../shared/tripApi.ts';
import type { TripCommandRequest, TripCommandResult } from '../../../services/tripCommands.ts';
import { stageBoundsCommand, stageTransitionCommand, type Bounds, type StageArrow, type StageCommand } from './tripStagePayloads.ts';

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

export type StageChangeResult =
  | { state: 'recorded'; duplicate: boolean }
  | { state: 'refused'; reason: string; detail: string }
  | { state: 'unavailable'; detail: string };

const REFUSAL_TEXT: Record<string, string> = {
  TRIP_AUTH_NOT_CREW: 'only the trip crew can change a stage',
  TRIP_STAGE_NOT_FOUND: 'that stage is no longer on this trip',
  TRIP_STAGE_INVALID_TRANSITION: 'the stage has moved on since this screen read it',
  TRIP_COMMAND_MALFORMED: "the trip didn't accept that change",
  LOCAL_INVALID: 'that stage could not be identified',
  LOCAL_NO_CHANGE: 'nothing was changed',
  LOCAL_NOT_PLANNED: 'only a planned stage can be started',
  LOCAL_NOT_ACTIVE: 'only a stage in progress can be completed',
  LOCAL_BAD_TIME: 'a time could not be read',
  LOCAL_ENDS_BEFORE_START: 'the stage would end before it starts',
};

function toResult(r: TripCommandResult): StageChangeResult {
  if (r.ok) return { state: 'recorded', duplicate: r.duplicate };
  if (r.kind === 'unavailable') return { state: 'unavailable', detail: r.detail };
  return { state: 'refused', reason: r.reason, detail: REFUSAL_TEXT[r.reason] ?? r.detail ?? r.reason };
}

async function send(tripId: string, cmd: StageCommand, idempotencyKey: string): Promise<StageChangeResult> {
  if (!cmd.ok) return { state: 'refused', reason: cmd.reason, detail: REFUSAL_TEXT[cmd.reason] ?? cmd.reason };
  return toResult(await issue(tripId, { type: cmd.type, payload: cmd.payload, idempotencyKey }));
}

/** A fresh key for one tap. Keep it to retry that tap; mint a new one for the next. */
export function stageControlKey(stageId: string, kind: 'dates' | StageArrow): string {
  return intentKey(`stage-control:${stageId}:${kind}`);
}

/** UPDATE_STAGE with the boundaries that changed. */
export async function setStageBounds(tripId: string, stageId: string, current: Bounds, next: Bounds, idempotencyKey: string): Promise<StageChangeResult> {
  return send(tripId, stageBoundsCommand(stageId, current, next), idempotencyKey);
}

/** START_STAGE or COMPLETE_STAGE. */
export async function moveStage(tripId: string, stageId: string, currentState: string, arrow: StageArrow, idempotencyKey: string): Promise<StageChangeResult> {
  return send(tripId, stageTransitionCommand(stageId, currentState, arrow), idempotencyKey);
}
