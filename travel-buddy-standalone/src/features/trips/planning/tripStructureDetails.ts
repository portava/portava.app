/**
 * The times and §7.1 fields the structure composer adds on top of the four
 * commands in tripStructurePayloads.ts — a stage's boundaries (2760
 * `starts_at` / `ends_at`) and a commitment's start, required arrival,
 * lateness tolerance, prep duration and confidence (2761). census-trips TR13,
 * TR15, TR78, TR122–TR125, TR127.
 *
 * WHY A SECOND MODULE AND NOT MORE FIELDS ON THE FIRST
 * ====================================================
 * tripStructurePayloads.ts is shared with another surface (the itinerary paste
 * review) and with the api-server's real-chain suite. These builders WRAP its
 * stageCommand / commitmentCommand: the base command is built and checked there,
 * unchanged, and only the extra keys are checked and added here. A base command
 * that refuses is returned as it is.
 *
 * EVERY CHECK IS THE MIGRATION'S
 * ==============================
 *   2760 trip_stages_interval_ordered          ends_at >= starts_at
 *   2761 trip_commitments_arrival_before_start required_arrival_at <= starts_at
 *   2761 trip_commitments_durations_nonnegative lateness_tolerance, prep_duration >= 0
 *   2761 trip_commitments_confidence_range     0 <= confidence <= 1, numeric(3,2)
 * A value the database would refuse is refused here first, by a LOCAL_ reason,
 * and nothing is sent. A confidence with a third decimal is refused rather than
 * rounded by numeric(3,2) into a number the person did not choose.
 *
 * Every time is an instant WITH its offset, checked by tripStructurePayloads'
 * `isInstant` — the same check the base command makes.
 *
 * ONE `starts_at` PATH. A commitment's start is CommitmentInput's own `startsAt`
 * (census G160), written by commitmentCommand. The details here only CHECK it
 * against the required arrival; they never write it a second time.
 *
 * Pure: imports only pure modules, so the api-server's real-chain suite can run
 * these builders' output through `trip_kernel_execute`.
 */
import {
  stageCommand, commitmentCommand, isInstant,
  type StageInput, type CommitmentInput, type StructureCommand,
} from './tripStructurePayloads.ts';

/** Milliseconds since the epoch for an instant WITH its offset (tripStructurePayloads' `isInstant`); null for anything else. */
export function instantMs(value: unknown): number | null {
  return isInstant(value) ? Date.parse(value) : null;
}

export type DetailReason =
  | 'LOCAL_BAD_TIME'
  | 'LOCAL_ENDS_BEFORE_START'
  | 'LOCAL_ARRIVAL_AFTER_START'
  | 'LOCAL_BAD_DURATION'
  | 'LOCAL_BAD_CONFIDENCE';

export type DetailedCommand = StructureCommand | { ok: false; reason: DetailReason };

/** A stage's boundaries. Omitted or null: not sent (the column stays NULL — "no dates yet"). */
export interface StageBounds { startsAt?: string | null; endsAt?: string | null }

/** The confidences offered: a person states one of these, or none. */
export const CONFIDENCE_STEPS = [0.25, 0.5, 0.75, 1] as const;

/**
 * A commitment's §7.1 fields beyond type, flexibility, stage and start (the
 * start is CommitmentInput's `startsAt`). Each is optional, as each column is.
 * Durations are whole minutes and travel as Postgres interval text
 * (`20 minutes`).
 */
export interface CommitmentDetails {
  requiredArrivalAt?: string | null;
  latenessMinutes?: number | null;
  prepMinutes?: number | null;
  confidence?: number | null;
}

type Checked = { ok: true; payload: Record<string, unknown> } | { ok: false; reason: DetailReason };

const given = <T>(v: T | null | undefined): v is T => v !== null && v !== undefined;

/** The boundary keys an ADD_STAGE or UPDATE_STAGE carries, checked. */
export function stageBoundsPayload(b: StageBounds): Checked {
  if ((given(b.startsAt) && !isInstant(b.startsAt)) || (given(b.endsAt) && !isInstant(b.endsAt))) {
    return { ok: false, reason: 'LOCAL_BAD_TIME' };
  }
  const s = instantMs(b.startsAt); const e = instantMs(b.endsAt);
  if (s !== null && e !== null && e < s) return { ok: false, reason: 'LOCAL_ENDS_BEFORE_START' };
  return {
    ok: true,
    payload: { ...(given(b.startsAt) ? { starts_at: b.startsAt } : {}), ...(given(b.endsAt) ? { ends_at: b.endsAt } : {}) },
  };
}

/** ADD_STAGE as tripStructurePayloads builds it, plus `starts_at` / `ends_at` when given. */
export function boundedStageCommand(input: StageInput & StageBounds): DetailedCommand {
  const base = stageCommand(input);
  if (!base.ok) return base;
  const bounds = stageBoundsPayload(input);
  if (!bounds.ok) return bounds;
  return { ...base, payload: { ...base.payload, ...bounds.payload } };
}

function minutesInterval(n: number | null | undefined): string | null | 'bad' {
  if (!given(n)) return null;
  return Number.isInteger(n) && n >= 0 ? `${n} minutes` : 'bad';
}

/** Everything the composer's commitment form adds to type / flexibility / stage: the start and the §7.1 details. */
export type CommitmentFields = Pick<CommitmentInput, 'startsAt'> & CommitmentDetails;

/**
 * The §7.1 keys an ADD_COMMITMENT carries beyond type / flexibility / stage /
 * start, checked. `startsAt` is read only to judge the required arrival
 * against it; `starts_at` is commitmentCommand's to write.
 */
export function commitmentDetailsPayload(d: CommitmentFields): Checked {
  if ((given(d.startsAt) && !isInstant(d.startsAt)) || (given(d.requiredArrivalAt) && !isInstant(d.requiredArrivalAt))) {
    return { ok: false, reason: 'LOCAL_BAD_TIME' };
  }
  const start = instantMs(d.startsAt); const arrive = instantMs(d.requiredArrivalAt);
  if (start !== null && arrive !== null && arrive > start) return { ok: false, reason: 'LOCAL_ARRIVAL_AFTER_START' };
  const lateness = minutesInterval(d.latenessMinutes);
  const prep = minutesInterval(d.prepMinutes);
  if (lateness === 'bad' || prep === 'bad') return { ok: false, reason: 'LOCAL_BAD_DURATION' };
  if (given(d.confidence)) {
    const c = d.confidence;
    if (typeof c !== 'number' || !Number.isFinite(c) || c < 0 || c > 1 || Math.round(c * 100) / 100 !== c) {
      return { ok: false, reason: 'LOCAL_BAD_CONFIDENCE' };
    }
  }
  return {
    ok: true,
    payload: {
      ...(given(d.requiredArrivalAt) ? { required_arrival_at: d.requiredArrivalAt } : {}),
      ...(lateness !== null ? { lateness_tolerance: lateness } : {}),
      ...(prep !== null ? { prep_duration: prep } : {}),
      ...(given(d.confidence) ? { confidence: d.confidence } : {}),
    },
  };
}

/** ADD_COMMITMENT as tripStructurePayloads builds it (type, flexibility, stage, start), plus the §7.1 details given. */
export function detailedCommitmentCommand(input: CommitmentInput & CommitmentDetails): DetailedCommand {
  const base = commitmentCommand(input);
  if (!base.ok) return base;
  const details = commitmentDetailsPayload(input);
  if (!details.ok) return details;
  return { ...base, payload: { ...base.payload, ...details.payload } };
}

/**
 * A served interval (`00:20:00`, `1 day 02:00:00`) in whole minutes, or null
 * when it is absent or cannot be read. Null is never shown as zero.
 */
export function intervalMinutes(text: string | null | undefined): number | null {
  const m = /^(?:(\d+) days? )?(\d+):(\d{2}):(\d{2})$/.exec(typeof text === 'string' ? text.trim() : '');
  if (!m || m[4] !== '00') return null;
  return Number(m[1] ?? 0) * 1440 + Number(m[2]) * 60 + Number(m[3]);
}
