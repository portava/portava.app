/**
 * The three commands that change a stage the trip already has — its
 * boundaries (UPDATE_STAGE, 2764) and its lifecycle (START_STAGE /
 * COMPLETE_STAGE, 2779) — built and checked in one pure place.
 * census-trips TR13 (`TripStage`: a bounded stay with a state), TR65
 * (`trip.stage_started`), TR78.
 *
 * WHAT EACH COMMAND IS, AS THE KERNEL READS IT
 * ============================================
 *   UPDATE_STAGE   { stage_id, patch: { starts_at?, ends_at? } } — a key in the
 *                  patch is written (null clears it); a key absent is left alone.
 *                  So only a boundary that CHANGED is sent: re-sending the one
 *                  read earlier would overwrite a crewmate's edit with the value
 *                  this screen happened to load.
 *   START_STAGE    { stage_id }  planned -> active      (event trip.stage_started)
 *   COMPLETE_STAGE { stage_id }  active  -> completed   (event trip.stage_completed)
 * The kernel refuses any other arrow (TRIP_STAGE_INVALID_TRANSITION); a state
 * that cannot take the arrow is refused here first and nothing is sent. The
 * state check here is a courtesy, not the rule: the kernel re-reads the row
 * under a lock.
 *
 * `patch.state` is never sent. The lifecycle has its own two commands, with
 * their own events, and a state written through UPDATE_STAGE would skip both.
 *
 * Pure: imports only pure modules, so the api-server's real-chain suite can run
 * these builders' output through `trip_kernel_execute`.
 */
import { isUuid } from '../planning/tripStructurePayloads.ts';
import { stageBoundsPayload, instantMs, type DetailReason } from '../planning/tripStructureDetails.ts';

/** 2760 `trip_stages_state_known`, in that order. */
export const STAGE_STATES = ['planned', 'active', 'completed', 'cancelled'] as const;
export type StageState = (typeof STAGE_STATES)[number];

export type StageArrow = 'start' | 'complete';

export type StageReason = DetailReason | 'LOCAL_INVALID' | 'LOCAL_NO_CHANGE' | 'LOCAL_NOT_PLANNED' | 'LOCAL_NOT_ACTIVE';

export type StageCommand =
  | { ok: true; type: 'UPDATE_STAGE' | 'START_STAGE' | 'COMPLETE_STAGE'; payload: Record<string, unknown> }
  | { ok: false; reason: StageReason };

export interface Bounds { startsAt: string | null; endsAt: string | null }

/** Two served/typed instants name the same moment (or are both absent). */
function same(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const x = instantMs(a); const y = instantMs(b);
  return x !== null && y !== null ? x === y : a === b;
}

/**
 * UPDATE_STAGE carrying only the boundaries that differ from `current` (what
 * the screen read). The ordering CHECK is judged on the stage as it will be:
 * the new value where one is sent, the current one where not.
 */
export function stageBoundsCommand(stageId: string, current: Bounds, next: Bounds): StageCommand {
  if (!isUuid(stageId)) return { ok: false, reason: 'LOCAL_INVALID' };
  const patch: Record<string, string | null> = {};
  if (!same(current.startsAt, next.startsAt)) patch.starts_at = next.startsAt;
  if (!same(current.endsAt, next.endsAt)) patch.ends_at = next.endsAt;
  if (Object.keys(patch).length === 0) return { ok: false, reason: 'LOCAL_NO_CHANGE' };
  const merged = stageBoundsPayload({
    startsAt: 'starts_at' in patch ? patch.starts_at : current.startsAt,
    endsAt: 'ends_at' in patch ? patch.ends_at : current.endsAt,
  });
  if (!merged.ok) return merged;
  return { ok: true, type: 'UPDATE_STAGE', payload: { stage_id: stageId, patch } };
}

/** START_STAGE (planned only) or COMPLETE_STAGE (active only), { stage_id }. */
export function stageTransitionCommand(stageId: string, currentState: string, arrow: StageArrow): StageCommand {
  if (!isUuid(stageId)) return { ok: false, reason: 'LOCAL_INVALID' };
  if (arrow === 'start') {
    return currentState === 'planned'
      ? { ok: true, type: 'START_STAGE', payload: { stage_id: stageId } }
      : { ok: false, reason: 'LOCAL_NOT_PLANNED' };
  }
  return currentState === 'active'
    ? { ok: true, type: 'COMPLETE_STAGE', payload: { stage_id: stageId } }
    : { ok: false, reason: 'LOCAL_NOT_ACTIVE' };
}

/** The arrow a stage in `state` can take next, or null (completed and cancelled are terminal). */
export function nextArrow(state: string): StageArrow | null {
  return state === 'planned' ? 'start' : state === 'active' ? 'complete' : null;
}
