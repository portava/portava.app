/**
 * TM-live (WP-11) TRIP-F21 — free time, "I'm bored", opportunities, replan,
 * simulate and impact preview on the client. census-trips TR133, TR186,
 * TR195, TR196, TR197, TR209.
 *
 *   GET  /trips/:id/freedom-windows              §7.3 windows + §7.2 conflicts (a projection)
 *   GET  /trips/:id/opportunities                §13 portfolio per open window (a projection)
 *   GET  /trips/:id/bored                        §11.3 the window containing now + its candidates
 *   POST /trips/:id/opportunities/:expId/accept  §13.3 accepted → ADD_PLAN through the kernel
 *   GET  /trips/:id/pulse                        §16 Trip Pulse (a projection)
 *   POST /trips/:id/replan                       §11.3 "Replan today" → a candidate diff; proposals only when asked
 *   POST /trips/:id/simulate                     §12.1 judge one change; writes nothing
 *   POST /trips/:id/proposals/preview            §9.4 impact of one change; writes nothing
 *
 * WHAT THE CLIENT MAY SAY. Windows, candidates and the diff are the server's;
 * the card renders them and the server's own `reading` sentences. A
 * projection refused by §19.1 (schema, stale) is `failed`, never a free day.
 * `bored` answering "no free window now" is an answer; the request failing is
 * not. Replan NEVER mutates the plan: it returns a diff, and only "Send as
 * proposals" writes (CREATE_PROPOSAL, under the kernel flag — the server says
 * when it skipped them).
 */
import { liveRequest, type LiveCall } from '../../live/liveApi.ts';
import { acceptProjection } from '../../../services/tripProjectionEnvelope.ts';

type Failure = Exclude<LiveCall<unknown>, { kind: 'ok' }>;
export type TripRead<T> = { state: 'ok'; value: T } | { state: 'off' } | { state: 'failed'; call: Failure };
export type TripWrite<T> = { ok: true; value: T } | { ok: false; kind: 'refused' | 'unavailable' | 'off'; reason: string; detail: string };

function read<T>(call: LiveCall<any>, check: (b: any) => boolean, what: string, projection: boolean, map: (b: any) => T): TripRead<T> {
  if (call.kind === 'off') return { state: 'off' };
  if (call.kind !== 'ok') return { state: 'failed', call };
  if (projection) {
    const a = acceptProjection(call.body);
    if (!a.accepted) return { state: 'failed', call: { kind: 'unavailable', status: call.status, detail: `${a.reason}: ${a.message}` } };
  }
  if (!check(call.body)) return { state: 'failed', call: { kind: 'unavailable', status: call.status, detail: `unreadable ${what}` } };
  return { state: 'ok', value: map(call.body) };
}
function writeFailure(call: Failure): Extract<TripWrite<never>, { ok: false }> {
  if (call.kind === 'off') return { ok: false, kind: 'off', reason: call.reason, detail: call.detail ?? '' };
  if (call.kind === 'refused') return { ok: false, kind: 'refused', reason: call.body?.error === 'not_executable' ? 'not_executable' : call.body?.reason ?? call.reason ?? call.error, detail: call.body?.detail ?? call.detail ?? '' };
  return { ok: false, kind: 'unavailable', reason: /TRIP_KERNEL_UNAVAILABLE/.test(call.detail) ? 'TRIP_KERNEL_UNAVAILABLE' : 'unavailable', detail: call.detail };
}

// ── windows, opportunities, bored ────────────────────────────────────────────

export interface FreedomWindowView { id: string; beginsAt: string; endsAt: string; durationMinutes: number; certified: boolean; confidence: string; requiredDestination: { commitmentId: string; arriveBy: string } | null }
export interface FreedomView { windows: FreedomWindowView[]; conflicts: { kind: string }[]; reading: string }

export async function fetchFreedomWindows(tripId: string): Promise<TripRead<FreedomView>> {
  const call = await liveRequest<any>('GET', `/api/trips/${tripId}/freedom-windows`);
  return read(call, (b) => Array.isArray(b.windows) && Array.isArray(b.conflicts), 'freedom windows', true,
    (b) => ({ windows: b.windows, conflicts: b.conflicts, reading: String(b.reading ?? '') }));
}

export interface TripExperience { id: string; windowId: string; name: string; verdict: string; arriveAt: string | null; leaveBy: string | null; stayMinutes: number | null; explanation: string[] }
export interface PortfolioView { windowId: string; executable: TripExperience[]; uncertain: TripExperience[]; notExecutable: number }
export interface OpportunitiesView { windows: PortfolioView[]; attentionMode: string; suppressed: boolean; reading: string }

export async function fetchTripOpportunities(tripId: string): Promise<TripRead<OpportunitiesView>> {
  const call = await liveRequest<any>('GET', `/api/trips/${tripId}/opportunities`);
  return read(call, (b) => Array.isArray(b.windows), 'opportunities', true, (b) => {
    const mode = String(b.attention?.mode ?? 'NORMAL');
    return {
      windows: b.windows.map((w: any) => ({ windowId: w.windowId, executable: w.executable ?? [], uncertain: w.uncertain ?? [], notExecutable: Array.isArray(w.notExecutable) ? w.notExecutable.length : Number(w.notExecutable ?? 0) })),
      attentionMode: mode, suppressed: mode !== 'NORMAL', reading: String(b.reading ?? ''),
    };
  });
}

export interface BoredView {
  window: { id: string; beginsAt: string; endsAt: string; minutesLeft: number } | null;
  nextWindow: { id: string; beginsAt: string; endsAt: string } | null;
  candidates: { windowId: string; executable: TripExperience[]; uncertain: TripExperience[]; notExecutable: number; suppressed: boolean } | null;
  readings: { window: string; candidates: string; touched: string };
}

export async function fetchBored(tripId: string): Promise<TripRead<BoredView>> {
  const call = await liveRequest<any>('GET', `/api/trips/${tripId}/bored`);
  return read(call, (b) => 'window' in b && 'candidates' in b && b.readings && typeof b.readings.window === 'string', 'bored answer', false,
    (b) => ({ window: b.window, nextWindow: b.nextWindow ?? null, candidates: b.candidates, readings: b.readings }));
}

export async function acceptOpportunity(tripId: string, experienceId: string): Promise<TripWrite<{ duplicate: boolean }>> {
  const call = await liveRequest<any>('POST', `/api/trips/${tripId}/opportunities/${encodeURIComponent(experienceId)}/accept`, {});
  if (call.kind !== 'ok') return writeFailure(call);
  if (call.body.ok !== true) return { ok: false, kind: 'unavailable', reason: 'unavailable', detail: 'the server did not confirm the plan item' };
  return { ok: true, value: { duplicate: call.body.duplicate === true } };
}

// ── pulse ────────────────────────────────────────────────────────────────────

export interface TripPulseView { signals: number; dropped: number; unreadSources: string[]; reading: string; attentionMode: string }

export async function fetchTripPulse(tripId: string): Promise<TripRead<TripPulseView>> {
  const call = await liveRequest<any>('GET', `/api/trips/${tripId}/pulse`);
  return read(call, (b) => Array.isArray(b.signals) && Array.isArray(b.sources), 'trip pulse', true, (b) => ({
    signals: b.signals.length, dropped: Array.isArray(b.dropped) ? b.dropped.length : 0,
    unreadSources: b.sources.filter((x: any) => x?.status === 'unread').map((x: any) => String(x.name)),
    reading: String(b.reading ?? ''), attentionMode: String(b.attention?.mode ?? 'NORMAL'),
  }));
}

// ── replan, simulate, preview ────────────────────────────────────────────────

export interface ReplanEntry {
  op: 'keep' | 'move' | 'cancel' | 'add' | string; planId: string | null; title: string | null;
  from: { startsAt: string | null; endsAt: string | null } | null; to: { startsAt: string | null; endsAt: string | null } | null;
  reason: string; detail: string; sharedMutation: boolean; experienceId: string | null;
}
export interface ReplanView {
  day: string; entries: ReplanEntry[]; proposals: number; requiresUserConfirmation: boolean; summary: string;
  unread: string[]; created: { proposalId: string | null; duplicate: boolean; reason: string | null }[]; skipped: string | null;
}

export async function replanToday(tripId: string, opts: { createProposals?: boolean } = {}): Promise<TripWrite<ReplanView>> {
  const call = await liveRequest<any>('POST', `/api/trips/${tripId}/replan`, opts.createProposals ? { createProposals: true } : {});
  if (call.kind !== 'ok') return writeFailure(call);
  const d = call.body.diff;
  if (!d || !Array.isArray(d.entries)) return { ok: false, kind: 'unavailable', reason: 'unavailable', detail: 'unreadable replan' };
  return {
    ok: true,
    value: {
      day: String(d.day ?? ''), entries: d.entries, proposals: Array.isArray(d.proposals) ? d.proposals.length : 0,
      requiresUserConfirmation: d.requiresUserConfirmation === true, summary: String(d.summary ?? ''),
      unread: Array.isArray(call.body.unread) ? call.body.unread.map(String) : [],
      created: call.body.proposals?.created ?? [], skipped: call.body.proposals?.skipped ?? null,
    },
  };
}

/** The §9.4 change a replan entry stands for; null for `keep`. */
export function changeOf(e: ReplanEntry): Record<string, unknown> | null {
  if (e.op === 'move' && e.planId) return { kind: 'move_plan', targetId: e.planId, startsAt: e.to?.startsAt ?? null, endsAt: e.to?.endsAt ?? null };
  if (e.op === 'cancel' && e.planId) return { kind: 'cancel_plan', targetId: e.planId };
  if (e.op === 'add') return { kind: 'add_plan', targetId: null, startsAt: e.to?.startsAt ?? null, endsAt: e.to?.endsAt ?? null, title: e.title };
  return null;
}

export interface SimulationView { feasibility: 'FEASIBLE' | 'INFEASIBLE' | 'UNKNOWN' | string; reasonCode: string | null; conflicts: number; explanation: string[]; impact: string }
export async function simulateChange(tripId: string, change: Record<string, unknown>): Promise<TripWrite<SimulationView>> {
  const call = await liveRequest<any>('POST', `/api/trips/${tripId}/simulate`, { change });
  if (call.kind !== 'ok') return writeFailure(call);
  const v = call.body.simulation;
  if (!v || typeof v.feasibility !== 'string') return { ok: false, kind: 'unavailable', reason: 'unavailable', detail: 'unreadable simulation' };
  return { ok: true, value: { feasibility: v.feasibility, reasonCode: v.reasonCode ?? null, conflicts: Array.isArray(v.conflicts) ? v.conflicts.length : 0, explanation: v.explanation ?? [], impact: String(v.impact?.summary ?? '') } };
}

export interface ImpactView { summary: string; changesConfirmedPlan: boolean; affectedParticipants: number; bookingsAtRisk: number; decisionRule: string }
export async function previewChange(tripId: string, change: Record<string, unknown>): Promise<TripWrite<ImpactView>> {
  const call = await liveRequest<any>('POST', `/api/trips/${tripId}/proposals/preview`, { change });
  if (call.kind !== 'ok') return writeFailure(call);
  const p = call.body.preview;
  if (!p || typeof p.summary !== 'string') return { ok: false, kind: 'unavailable', reason: 'unavailable', detail: 'unreadable preview' };
  return {
    ok: true,
    value: {
      summary: p.summary, changesConfirmedPlan: p.changesConfirmedPlan === true,
      affectedParticipants: Array.isArray(p.affectedParticipants) ? p.affectedParticipants.length : 0,
      bookingsAtRisk: Array.isArray(p.bookingSideEffects?.bookingsAtRisk) ? p.bookingSideEffects.bookingsAtRisk.length : 0,
      decisionRule: String(p.governance?.suggestedDecisionRule ?? 'host'),
    },
  };
}

export const FREE_TIME_REFUSAL_WORDS: Record<string, string> = {
  TRIP_KERNEL_UNAVAILABLE: "Not added: plan changes are written only through the trip kernel, which isn't on in this build.",
  not_executable: "That option can't be done in this window any more.",
  not_found: "That option isn't in the current list any more — refresh.",
  TRIP_AUTH_NOT_CREW: 'Only accepted crew can do that.',
  feature_disabled: "This isn't switched on in this build.",
};
export function writeLine(f: Extract<TripWrite<never>, { ok: false }>): string {
  return FREE_TIME_REFUSAL_WORDS[f.reason] ?? (f.kind === 'unavailable' ? `Couldn't reach Portava — nothing was changed${f.detail ? ` (${f.detail})` : ''}.` : `Refused (${f.reason}${f.detail ? `: ${f.detail}` : ''}).`);
}
