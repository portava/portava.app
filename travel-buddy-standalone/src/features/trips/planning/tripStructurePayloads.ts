/**
 * The four §5.1 / §8 commands the trip screen's structure composer sends —
 * ADD_STAGE, ADD_LEG, ADD_COMMITMENT, ADD_GOAL — built and checked in ONE
 * place, with no imports at all.
 *
 * Pure on purpose: the api-server's real-chain suite
 * (artifacts/api-server/src/test/db/tripProductStructureLive.db.test.ts) runs
 * THESE builders' output through `trip_kernel_execute`, so what it proves is
 * the product's own command, not a payload re-typed by hand. A module that
 * reached the app's network or React Native layers could not be loaded there.
 *
 * Every vocabulary is the migration's CHECK, in the migration's order
 * (tripStructureEntries.test.ts reads the SQL to hold that). A value the
 * database would refuse is refused here first, by a LOCAL_ reason, and nothing
 * is sent.
 */

/** 2760 `trip_stages_type_known`, in that order. */
export const STAGE_TYPES = ['city', 'transit', 'lodging', 'excursion', 'layover'] as const;
export type StageType = (typeof STAGE_TYPES)[number];

/** 2761 `trip_legs_type_known`. */
export const LEG_TYPES = ['flight', 'train', 'bus', 'ferry', 'car', 'walk', 'other'] as const;
export type LegType = (typeof LEG_TYPES)[number];

/** 2761 `trip_commitments_type_known`. */
export const COMMITMENT_TYPES = ['lodging', 'transport', 'event', 'booking', 'meeting', 'other'] as const;
export type CommitmentType = (typeof COMMITMENT_TYPES)[number];

/** 2761 `trip_commitments_flexibility_known`; the kernel's default is `flexible`. */
export const COMMITMENT_FLEXIBILITIES = ['fixed', 'shiftable', 'flexible'] as const;
export type CommitmentFlexibility = (typeof COMMITMENT_FLEXIBILITIES)[number];

/** 2762 `trip_goals_type_known`. NOT §8.1's vocabulary (census-trips TR138). */
export const GOAL_TYPES = ['rest', 'budget', 'experience', 'social', 'logistics', 'safety', 'other'] as const;
export type GoalType = (typeof GOAL_TYPES)[number];

/** 2762 `trip_goals_priority_known`. */
export const GOAL_PRIORITIES = ['low', 'normal', 'high'] as const;
export type GoalPriority = (typeof GOAL_PRIORITIES)[number];

/** 2783 `trip_goals_scope_known`: a personal goal is its owner's alone (RLS + kernel). */
export const GOAL_SCOPES = ['shared', 'personal'] as const;
export type GoalScope = (typeof GOAL_SCOPES)[number];

export type LocalReason = 'LOCAL_INVALID' | 'LOCAL_SAME_STAGE' | 'LOCAL_NO_ANCHOR' | 'LOCAL_NO_TIMEZONE';

export type StructureCommand =
  | { ok: true; type: 'ADD_STAGE' | 'ADD_LEG' | 'ADD_COMMITMENT' | 'ADD_GOAL'; payload: Record<string, unknown> }
  | { ok: false; reason: LocalReason };

export interface StageInput { stageType: string; cityId: string | null; timezone: string | null; sequence: number }
export interface LegInput { legType: string; fromStageId: string; toStageId: string }
export interface CommitmentInput { type: string; flexibility: string; stageId: string | null; /** census G160: an instant WITH its offset; omitted → no `starts_at`. */ startsAt?: string | null }
export interface GoalInput { type: string; priority: string; scope: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

const isOneOf = (list: readonly string[], value: string): boolean => list.includes(value);

/**
 * The next free position on the stage spine: one past the highest the trip
 * has. 2760 makes `sequence` positive and unique per trip; a collision with a
 * stage someone else just added is refused by the kernel
 * (TRIP_STAGE_SEQUENCE_TAKEN), never overwritten.
 */
export function nextStageSequence(stages: ReadonlyArray<{ sequence: number }>): number {
  let max = 0;
  for (const s of stages) if (Number.isInteger(s.sequence) && s.sequence > max) max = s.sequence;
  return max + 1;
}

/**
 * ADD_STAGE { stage_type, city_id, timezone, sequence } — state defaults to
 * `planned` in the kernel. The anchor is a CITY: 2760's
 * `trip_stages_one_anchor` needs exactly one of place_id / city_id, and the
 * kernel casts it to uuid, so a pick with no canonical id is refused here.
 */
export function stageCommand(input: StageInput): StructureCommand {
  if (!isOneOf(STAGE_TYPES, input.stageType) || !Number.isInteger(input.sequence) || input.sequence < 1) {
    return { ok: false, reason: 'LOCAL_INVALID' };
  }
  if (!isUuid(input.cityId)) return { ok: false, reason: 'LOCAL_NO_ANCHOR' };
  const timezone = (input.timezone ?? '').trim();
  if (!timezone) return { ok: false, reason: 'LOCAL_NO_TIMEZONE' };
  return { ok: true, type: 'ADD_STAGE', payload: { stage_type: input.stageType, city_id: input.cityId, timezone, sequence: input.sequence } };
}

/** ADD_LEG { leg_type, from_stage_id, to_stage_id } — both must be this trip's stages (the kernel checks). */
export function legCommand(input: LegInput): StructureCommand {
  if (!isOneOf(LEG_TYPES, input.legType) || !isUuid(input.fromStageId) || !isUuid(input.toStageId)) {
    return { ok: false, reason: 'LOCAL_INVALID' };
  }
  if (input.fromStageId === input.toStageId) return { ok: false, reason: 'LOCAL_SAME_STAGE' };
  return { ok: true, type: 'ADD_LEG', payload: { leg_type: input.legType, from_stage_id: input.fromStageId, to_stage_id: input.toStageId } };
}

/** ADD_COMMITMENT { type, flexibility, stage_id?, starts_at? } — a stage is optional (2761: nullable), and so is the time (G160). */
export function commitmentCommand(input: CommitmentInput): StructureCommand {
  if (!isOneOf(COMMITMENT_TYPES, input.type) || !isOneOf(COMMITMENT_FLEXIBILITIES, input.flexibility)) {
    return { ok: false, reason: 'LOCAL_INVALID' };
  }
  if ((input.stageId !== null && !isUuid(input.stageId)) || (input.startsAt != null && !isInstant(input.startsAt))) return { ok: false, reason: 'LOCAL_INVALID' };
  return {
    ok: true, type: 'ADD_COMMITMENT',
    payload: { type: input.type, flexibility: input.flexibility, ...(input.stageId ? { stage_id: input.stageId } : {}), ...(input.startsAt ? { starts_at: input.startsAt } : {}) },
  };
}

/** ADD_GOAL { type, priority, scope } — status defaults to open; a personal goal's owner is the actor (2783). */
export function goalCommand(input: GoalInput): StructureCommand {
  if (!isOneOf(GOAL_TYPES, input.type) || !isOneOf(GOAL_PRIORITIES, input.priority) || !isOneOf(GOAL_SCOPES, input.scope)) {
    return { ok: false, reason: 'LOCAL_INVALID' };
  }
  return { ok: true, type: 'ADD_GOAL', payload: { type: input.type, priority: input.priority, scope: input.scope } };
}

/**
 * census G160: an instant WITH an explicit offset (`2026-10-23T19:00:00+07:00`
 * or `…Z`). A zone-less wall time is refused: the kernel casts `starts_at` to
 * timestamptz (2765), and Postgres would read a bare wall time in the
 * DATABASE's zone — the wrong instant, stored without complaint.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;
export function isInstant(value: unknown): value is string {
  return typeof value === 'string' && ISO_INSTANT.test(value) && Number.isFinite(Date.parse(value));
}
