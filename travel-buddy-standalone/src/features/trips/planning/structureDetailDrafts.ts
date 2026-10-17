/**
 * What the structure composer's typed fields mean, before anything is sent:
 * a stage's two boundaries and a commitment's §7.1 fields, read from what the
 * person typed in the zone the composer showed them (census-trips TR13, TR15,
 * TR78, TR122–TR125, TR127).
 *
 * A draft is READY only when every field is either empty or fully readable,
 * and the fields agree with each other the way the migration's CHECKs require.
 * When it is not ready, `problem` says why in words the composer shows as they
 * are — the submit stays disabled, so a person never meets a refusal for
 * something the screen could have told them.
 *
 * Pure: no React, no network.
 */
import { readTypedTime, typedTimeProblem, type TypedTime, type TypedTimeReading, EMPTY_TYPED_TIME } from '../shared/tripLocalTime.ts';
import { stageBoundsPayload, commitmentDetailsPayload, type StageBounds, type CommitmentFields } from './tripStructureDetails.ts';

export interface StageBoundsValue { starts: TypedTime; ends: TypedTime }
export const EMPTY_STAGE_BOUNDS: StageBoundsValue = { starts: EMPTY_TYPED_TIME, ends: EMPTY_TYPED_TIME };

export interface CommitmentDetailsValue {
  starts: TypedTime;
  arriveBy: TypedTime;
  /** Whole minutes as typed; '' is "not stated". */
  lateness: string;
  prep: string;
  /** One of CONFIDENCE_STEPS, or null for "not stated". */
  confidence: number | null;
}
export const EMPTY_COMMITMENT_DETAILS: CommitmentDetailsValue = { starts: EMPTY_TYPED_TIME, arriveBy: EMPTY_TYPED_TIME, lateness: '', prep: '', confidence: null };

/**
 * `where` says who shows the problem: 'field' — one typed time, which its own
 * ZonedTimeField already says; 'group' — two fields that disagree, or a
 * minutes field, which the group says.
 */
export type Draft<T> = { ready: true; value: T; problem: null; where: null } | { ready: false; value: null; problem: string; where: 'field' | 'group' };

const iso = (r: TypedTimeReading): string | null => (r.kind === 'ok' ? r.iso : null);
const notReady = <T>(problem: string, where: 'field' | 'group'): Draft<T> => ({ ready: false, value: null, problem, where });

/** A stage's boundaries as the ADD_STAGE will carry them. */
export function stageBoundsDraft(v: StageBoundsValue, zone: string | null): Draft<StageBounds> {
  const s = readTypedTime(v.starts, zone); const e = readTypedTime(v.ends, zone);
  const problem = typedTimeProblem(s, zone) ?? typedTimeProblem(e, zone);
  if (problem) return notReady(problem, 'field');
  const bounds: StageBounds = { ...(iso(s) ? { startsAt: iso(s) } : {}), ...(iso(e) ? { endsAt: iso(e) } : {}) };
  const checked = stageBoundsPayload(bounds);
  if (!checked.ok) return notReady('The stage would end before it starts.', 'group');
  return { ready: true, value: bounds, problem: null, where: null };
}

/** Whole minutes as typed, or 'bad'. '' is not stated. */
function minutes(text: string): number | null | 'bad' {
  const t = text.trim();
  if (!t) return null;
  return /^\d{1,5}$/.test(t) ? Number(t) : 'bad';
}

/** A commitment's start (CommitmentInput's `startsAt`) and §7.1 details as the ADD_COMMITMENT will carry them. */
export function commitmentDetailsDraft(v: CommitmentDetailsValue, zone: string | null): Draft<CommitmentFields> {
  const s = readTypedTime(v.starts, zone); const a = readTypedTime(v.arriveBy, zone);
  const problem = typedTimeProblem(s, zone) ?? typedTimeProblem(a, zone);
  if (problem) return notReady(problem, 'field');
  const lateness = minutes(v.lateness); const prep = minutes(v.prep);
  if (lateness === 'bad' || prep === 'bad') return notReady('Enter minutes as a whole number, for example 15.', 'group');
  const details: CommitmentFields = {
    ...(iso(s) ? { startsAt: iso(s) } : {}),
    ...(iso(a) ? { requiredArrivalAt: iso(a) } : {}),
    ...(lateness !== null ? { latenessMinutes: lateness } : {}),
    ...(prep !== null ? { prepMinutes: prep } : {}),
    ...(v.confidence !== null ? { confidence: v.confidence } : {}),
  };
  const checked = commitmentDetailsPayload(details);
  if (!checked.ok) {
    return notReady(checked.reason === 'LOCAL_ARRIVAL_AFTER_START' ? 'The arrival time is after it starts — you need to be there by the start or earlier.' : "One of these can't be saved as typed.", 'group');
  }
  return { ready: true, value: details, problem: null, where: null };
}

/**
 * The zone a commitment's times are typed in: its stage's, else the trip's,
 * else this phone's — and the phone's only once the person has chosen it.
 * `stages` is the structure read's stage list (each carries its 2760 zone).
 */
export function commitmentZone(
  stages: ReadonlyArray<{ id: string; timezone?: string | null }>,
  stageId: string | null,
  tripTimezone: string | null | undefined,
  chosenPhoneZone: string | null,
): { zone: string | null; from: 'stage' | 'trip' | 'device' | null } {
  const clean = (z: string | null | undefined) => (typeof z === 'string' && z.trim() ? z.trim() : null);
  const stageZone = stageId ? clean(stages.find((st) => st.id === stageId)?.timezone) : null;
  if (stageZone) return { zone: stageZone, from: 'stage' };
  const tripZone = clean(tripTimezone);
  if (tripZone) return { zone: tripZone, from: 'trip' };
  const phone = clean(chosenPhoneZone);
  return phone ? { zone: phone, from: 'device' } : { zone: null, from: null };
}
