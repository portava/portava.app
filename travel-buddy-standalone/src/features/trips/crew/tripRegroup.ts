/**
 * TM-live (WP-11) TRIP-F19 — §10.4 meeting checkpoints and §11.3 "Return /
 * regroup" on the client. census-trips TR170, TR177, TR198.
 *
 *   POST /trips/:tripId/meeting-point                               §14.3 where should we meet (reads only)
 *   POST /trips/:tripId/regroup                                     agree a meeting checkpoint (kernel)
 *   GET  /trips/:tripId/meeting-checkpoints?status=open             the crew's open checkpoints + arrivals
 *   POST /trips/:tripId/meeting-checkpoints/:id/arrival             my own arrival state (kernel)
 *   POST /trips/:tripId/meeting-checkpoints/:id/close               creator or host: met | cancelled (kernel)
 *
 * EVERY WRITE IS THE KERNEL'S. With `trip_kernel_enabled` off the server
 * refuses by name (503 TRIP_KERNEL_UNAVAILABLE) and that is shown as "not
 * written", never as done. A refusal keeps its reason (not a participant, not
 * the host, invalid transition) so the card can say which it was.
 *
 * IDEMPOTENCY. The caller supplies a key per user action and REUSES it when the
 * same action is retried after a failure, so a retry is one command, not two
 * (the kernel's receipt returns `duplicate: true`). See `actionKey`.
 */
import { liveRequest, type LiveCall } from '../../live/liveApi.ts';

type Failure = Exclude<LiveCall<unknown>, { kind: 'ok' }>;

export const ARRIVAL_STATES = ['pending', 'en_route', 'arrived', 'late', 'no_show'] as const;
export type ArrivalState = (typeof ARRIVAL_STATES)[number];

export interface CheckpointParticipant { userId: string; arrivalState: ArrivalState | string; arrivedAt: string | null }
export interface MeetingCheckpoint {
  id: string; label: string; lat: number; lng: number; meetAt: string | null; purpose: string; status: string;
  createdBy: string; participants: CheckpointParticipant[]; pendingCount: number; arrivedCount: number;
}
export interface MeetingOption { candidateId: string; name: string; groupBurdenMinutes: number; longestJourneyMinutes: number; explanation: string[] }
export interface MeetingPoint { recommended: MeetingOption | null; alternatives: MeetingOption[]; unplaced: { userId: string; reason: string }[]; explanation: string[] }

export type RegroupRead<T> = { state: 'ok'; value: T } | { state: 'off' } | { state: 'failed'; call: Failure };
export type RegroupWrite<T> =
  | { ok: true; value: T }
  | { ok: false; kind: 'refused' | 'unavailable' | 'off'; reason: string; detail: string; meetingPoint?: MeetingPoint | null };

function writeFailure(call: Failure): Extract<RegroupWrite<never>, { ok: false }> {
  if (call.kind === 'off') return { ok: false, kind: 'off', reason: call.reason, detail: call.detail ?? '' };
  if (call.kind === 'refused') return { ok: false, kind: 'refused', reason: call.reason ?? call.error, detail: call.detail ?? '', meetingPoint: call.body?.meetingPoint ?? null };
  return { ok: false, kind: 'unavailable', reason: /TRIP_KERNEL_UNAVAILABLE/.test(call.detail) ? 'TRIP_KERNEL_UNAVAILABLE' : 'unavailable', detail: call.detail };
}

export async function fetchCheckpoints(tripId: string): Promise<RegroupRead<MeetingCheckpoint[]>> {
  const call = await liveRequest<any>('GET', `/api/trips/${tripId}/meeting-checkpoints?status=open`);
  if (call.kind === 'off') return { state: 'off' };
  if (call.kind !== 'ok') return { state: 'failed', call };
  if (!Array.isArray(call.body.checkpoints)) return { state: 'failed', call: { kind: 'unavailable', status: call.status, detail: 'unreadable checkpoints' } };
  return { state: 'ok', value: call.body.checkpoints };
}

export async function previewMeetingPoint(tripId: string): Promise<RegroupWrite<MeetingPoint>> {
  const call = await liveRequest<any>('POST', `/api/trips/${tripId}/meeting-point`, {});
  if (call.kind !== 'ok') return writeFailure(call);
  const mp = call.body.meetingPoint;
  if (!mp || !Array.isArray(mp.alternatives)) return { ok: false, kind: 'unavailable', reason: 'unavailable', detail: 'unreadable meeting point' };
  return { ok: true, value: { recommended: mp.recommended ?? null, alternatives: mp.alternatives, unplaced: mp.unplaced ?? [], explanation: mp.explanation ?? [] } };
}

export async function callRegroup(tripId: string, opts: { candidateId?: string | null; idempotencyKey: string }): Promise<RegroupWrite<{ checkpointId: string | null; duplicate: boolean }>> {
  const body: Record<string, unknown> = { idempotencyKey: opts.idempotencyKey };
  if (opts.candidateId) body.candidateId = opts.candidateId;
  const call = await liveRequest<any>('POST', `/api/trips/${tripId}/regroup`, body);
  if (call.kind !== 'ok') return writeFailure(call);
  if (call.body.ok !== true) return { ok: false, kind: 'unavailable', reason: 'unavailable', detail: 'the server did not confirm the regroup' };
  return { ok: true, value: { checkpointId: typeof call.body.checkpoint?.id === 'string' ? call.body.checkpoint.id : null, duplicate: call.body.kernel?.duplicate === true } };
}

export async function setArrival(tripId: string, checkpointId: string, arrivalState: ArrivalState, idempotencyKey: string): Promise<RegroupWrite<{ duplicate: boolean }>> {
  const call = await liveRequest<any>('POST', `/api/trips/${tripId}/meeting-checkpoints/${checkpointId}/arrival`, { arrivalState, idempotencyKey });
  if (call.kind !== 'ok') return writeFailure(call);
  if (call.body.ok !== true) return { ok: false, kind: 'unavailable', reason: 'unavailable', detail: 'the server did not confirm the arrival' };
  return { ok: true, value: { duplicate: call.body.kernel?.duplicate === true } };
}

export async function closeCheckpoint(tripId: string, checkpointId: string, outcome: 'met' | 'cancelled', idempotencyKey: string): Promise<RegroupWrite<{ duplicate: boolean }>> {
  const call = await liveRequest<any>('POST', `/api/trips/${tripId}/meeting-checkpoints/${checkpointId}/close`, { outcome, idempotencyKey });
  if (call.kind !== 'ok') return writeFailure(call);
  if (call.body.ok !== true) return { ok: false, kind: 'unavailable', reason: 'unavailable', detail: 'the server did not confirm the close' };
  return { ok: true, value: { duplicate: call.body.kernel?.duplicate === true } };
}

/** The server's refusal reasons for these routes, in words. */
export const REGROUP_REFUSAL_WORDS: Record<string, string> = {
  TRIP_KERNEL_UNAVAILABLE: "Not written: regroups are recorded only through the trip kernel, which isn't on in this build.",
  TRIP_MEETING_NOT_PARTICIPANT: "You're not one of the people this checkpoint is for.",
  TRIP_AUTH_NOT_HOST: 'Only the person who called it, or the trip host, can close it.',
  TRIP_AUTH_NOT_CREW: 'Only accepted crew can do that.',
  TRIP_MEETING_INVALID_TRANSITION: 'That checkpoint has already moved on — refresh to see where it is.',
  TRIP_MEETING_NO_CANDIDATE: 'No meeting point could be worked out for the crew right now.',
  TRIP_MEETING_NOT_FOUND: 'That checkpoint no longer exists.',
  TRIP_VERSION_CONFLICT: 'The trip changed under you — refresh and try again.',
  feature_disabled: "Regroups aren't switched on in this build.",
};

export function refusalLine(f: Extract<RegroupWrite<never>, { ok: false }>): string {
  return REGROUP_REFUSAL_WORDS[f.reason] ?? (f.kind === 'unavailable' ? `Couldn't reach Portava — nothing was written${f.detail ? ` (${f.detail})` : ''}.` : `Refused (${f.reason}${f.detail ? `: ${f.detail}` : ''}).`);
}

export const ARRIVAL_WORDS: Record<string, string> = { pending: 'not yet', en_route: 'on the way', arrived: 'arrived', late: 'running late', no_show: "didn't come" };

/** A fresh key for one user action; the card reuses it on a retry of the same action. */
export function actionKey(action: string): string {
  return `${action}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
}
