/**
 * TM-live (WP-11) — the place screen's live decision surfaces.
 *
 *   COMP-F15  GET  /api/compass/decision?subjectId=…          GO NOW · GO SOON · WAIT · STAY · SWITCH · SKIP · RETURN
 *   SEN-F08   GET  /api/v1/experiences/:id/live-state         what is true here now (§19 read model)
 *             GET  /api/v1/experiences/:id/typical-patterns   what it is usually like (§12 patterns)
 *             GET  /api/v1/neighborhoods/:id/pulse            a k-anonymous neighbourhood aggregate
 *   SEN-F07   GET  /api/intel/opportunities?subjectIds=…      is there an opportunity here for me now
 *             GET  /api/intel/experience-sessions/open        my open session, if any
 *             POST /api/intel/experience-sessions/from-opportunity   "I'm going" (re-derived server-side)
 *             POST /api/intel/experience-sessions/:id/close   how it was
 *
 * THE DECISION IS THE SERVER'S. The client never computes one: it shows the
 * decision, the server's own sentence, and the §5.1 grounding beside it. When
 * the server could not read live intelligence it answers WAIT with
 * `live_intelligence_unavailable` and `liveIntelligenceReadable: false`; the
 * card says that in words rather than showing a bare WAIT as if it were advice.
 *
 * A FAILED READ IS NEVER A QUIET PLACE. The live-state model marks a failed
 * live read (`live_read_failed`, TM-live SEN-F08); `unknown` without it is "no
 * current reading", which is still not "quiet". An opportunity refused
 * `live_intelligence_unavailable` is "can't check", not "nothing here".
 */
import { liveRequest, type LiveCall } from './liveApi.ts';

type Failure = Exclude<LiveCall<unknown>, { kind: 'ok' }>;
export type Read<T> = { state: 'ok'; value: T } | { state: 'off' } | { state: 'failed'; call: Failure };

function fail<T>(call: Failure): Read<T> {
  return call.kind === 'off' ? { state: 'off' } : { state: 'failed', call };
}
function unreadable<T>(status: number, what: string): Read<T> {
  return { state: 'failed', call: { kind: 'unavailable', status, detail: `unreadable ${what}` } };
}

// ── COMP-F15 ─────────────────────────────────────────────────────────────────

export const COMPASS_DECISIONS = ['GO_NOW', 'GO_SOON', 'WAIT', 'STAY', 'SWITCH', 'SKIP', 'RETURN'] as const;
export interface Truth { truthClass: string; confidence: string; freshness: string; coverage: string }
export interface CompassDecisionView {
  decision: (typeof COMPASS_DECISIONS)[number];
  reasons: string[];
  summary: string;
  grounding: Truth | null;
  interception: { reachable: boolean | null; etaMinutes: number | null; marginMinutes: number | null };
  confirmation: { required: boolean; reason: string } | null;
  liveIntelligenceReadable: boolean;
  generatedAt: string;
}

export async function fetchCompassDecision(placeId: string, pos?: { lat: number; lng: number } | null, currentSubjectId?: string | null): Promise<Read<CompassDecisionView>> {
  const qs = new URLSearchParams({ subjectId: placeId });
  if (currentSubjectId) qs.set('currentSubjectId', currentSubjectId);
  if (pos) { qs.set('lat', String(pos.lat)); qs.set('lng', String(pos.lng)); }
  const call = await liveRequest<any>('GET', `/api/compass/decision?${qs.toString()}`);
  if (call.kind !== 'ok') return fail(call);
  const b = call.body;
  if (!(COMPASS_DECISIONS as readonly string[]).includes(b.decision) || !Array.isArray(b.reasons) || typeof b.liveIntelligenceReadable !== 'boolean') {
    return unreadable(call.status, 'decision');
  }
  return {
    state: 'ok',
    value: {
      decision: b.decision, reasons: b.reasons, summary: String(b.summary ?? ''), grounding: b.grounding ?? null,
      interception: { reachable: b.interception?.reachable ?? null, etaMinutes: b.interception?.etaMinutes ?? null, marginMinutes: b.interception?.marginMinutes ?? null },
      confirmation: b.confirmation ?? null, liveIntelligenceReadable: b.liveIntelligenceReadable, generatedAt: String(b.generatedAt ?? ''),
    },
  };
}

export const DECISION_WORDS: Record<string, string> = {
  GO_NOW: 'Go now', GO_SOON: 'Go soon', WAIT: 'Wait', STAY: 'Stay', SWITCH: 'Switch', SKIP: 'Skip', RETURN: 'Return',
};

/** The server's reason codes (lib/compassDecision DecisionReason), in words. Unknown codes are shown as-is. */
export const DECISION_REASON_WORDS: Record<string, string> = {
  safety_outranks_opportunity: 'A safety reading outranks any opportunity here',
  already_here: "You're already here",
  live_intelligence_unavailable: "Live intelligence couldn't be read, so Compass can't judge right now",
  no_live_evidence: 'No current live evidence for this place',
  evidence_not_observational: "What's available isn't an observation",
  building_not_yet_live: "It's building, but not yet live",
  walk_in_refused: 'Walk-ins are being refused',
  queue_exceeds_tolerance: 'The queue is longer than you said you would wait',
  intent_conflict: "It doesn't match what you're in the mood for",
  window_may_decay_before_arrival: 'The reading may change before you arrive',
  interception_unknown: "Your arrival time isn't known",
  left_earlier_now_favourable: 'You left earlier and it now looks better',
  switching_cost_not_exceeded: "Where you are isn't clearly worse",
  better_by_more_than_switching_cost: 'Clearly better than where you are',
  current_value_unknown: "Nothing says where you are is worse",
  live_reachable_compatible: 'Live, reachable and a fit',
};

/** The line shown when the decision could not look at live intelligence — never a bare WAIT. */
export function decisionCaveat(d: CompassDecisionView): string | null {
  if (!d.liveIntelligenceReadable || d.reasons.includes('live_intelligence_unavailable')) {
    return "Compass couldn't read live intelligence for this place, so it says Wait rather than guess. This isn't a reading of the place.";
  }
  return null;
}

// ── SEN-F08 ──────────────────────────────────────────────────────────────────

export interface LiveClaimView { claimType: string; value: unknown; state?: string; truth?: Truth; validUntil?: string | null }
export interface LiveStateView { state: 'live' | 'emerging' | 'typical' | 'unknown' | string; claims: LiveClaimView[]; truth: Truth | null; validUntil: string | null; liveReadFailed: boolean }

export async function fetchLiveState(placeId: string): Promise<Read<LiveStateView>> {
  const call = await liveRequest<any>('GET', `/api/v1/experiences/${encodeURIComponent(placeId)}/live-state`);
  if (call.kind !== 'ok') return fail(call);
  const b = call.body;
  if (typeof b.state !== 'string' || !Array.isArray(b.claims)) return unreadable(call.status, 'live state');
  return { state: 'ok', value: { state: b.state, claims: b.claims, truth: b.truth ?? null, validUntil: b.valid_until ?? null, liveReadFailed: b.live_read_failed === true } };
}

export interface TypicalPattern { claim_family: string; pattern_kind: string; time_band: string; dow: number; value: unknown; band: string | null }

export async function fetchTypicalPatterns(placeId: string): Promise<Read<TypicalPattern[]>> {
  const call = await liveRequest<any>('GET', `/api/v1/experiences/${encodeURIComponent(placeId)}/typical-patterns`);
  if (call.kind !== 'ok') return fail(call);
  if (!Array.isArray(call.body.patterns)) return unreadable(call.status, 'patterns');
  return { state: 'ok', value: call.body.patterns };
}

export interface PulseView { exposable: boolean; reason: string; subjectCount: number; levels: Record<string, number> }

export async function fetchNeighborhoodPulse(neighborhood: string): Promise<Read<PulseView>> {
  const call = await liveRequest<any>('GET', `/api/v1/neighborhoods/${encodeURIComponent(neighborhood)}/pulse`);
  if (call.kind !== 'ok') return fail(call);
  const p = call.body.pulse;
  if (!p || typeof p.exposable !== 'boolean') return unreadable(call.status, 'pulse');
  return { state: 'ok', value: { exposable: p.exposable, reason: String(p.reason ?? ''), subjectCount: Number(p.subjectCount ?? 0), levels: p.levels ?? {} } };
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** A scalar out of a claim/pattern value ({ level: 'busy' } → 'busy'). */
export function scalarOf(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (value && typeof value === 'object') {
    for (const k of ['level', 'state', 'trajectory', 'minMinutes', 'value']) {
      const v = (value as Record<string, unknown>)[k];
      if (typeof v === 'string' || typeof v === 'number') return String(v);
    }
  }
  return null;
}
/** "Tue 18:00 — usually busy" lines, nearest to now first, at most `max`. */
export function typicalLines(patterns: TypicalPattern[], now: Date = new Date(), max = 4): string[] {
  const nowKey = now.getUTCDay() * 24 + now.getUTCHours();
  const hourOf = (band: string) => { const m = /(\d{1,2})/.exec(band); return m ? Number(m[1]) : 0; };
  return patterns
    .map((p) => ({ p, key: p.dow * 24 + hourOf(p.time_band), v: scalarOf(p.value) }))
    .filter((x) => x.v !== null)
    .sort((a, b) => ((a.key - nowKey + 168) % 168) - ((b.key - nowKey + 168) % 168))
    .slice(0, max)
    .map(({ p, v }) => `${DOW[p.dow] ?? '?'} ${String(hourOf(p.time_band)).padStart(2, '0')}:00 — ${p.claim_family.replace(/\./g, ' ')} usually ${v}${p.band ? ` (${p.band} confidence)` : ''}`);
}

// ── SEN-F07 ──────────────────────────────────────────────────────────────────

export interface PlaceOpportunity { kind: string; decision: string | null; reachable: boolean | null; validUntil: string | null }
export type OpportunityAnswer =
  | { found: true; opportunity: PlaceOpportunity }
  | { found: false; reason: 'live_intelligence_unavailable' | 'no_opportunity' | 'safety_suppressed' | 'not_in_world_context' | string };

export async function fetchPlaceOpportunity(placeId: string): Promise<Read<OpportunityAnswer>> {
  const call = await liveRequest<any>('GET', `/api/intel/opportunities?${new URLSearchParams({ subjectIds: placeId, surface: 'compass' }).toString()}`);
  if (call.kind !== 'ok') return fail(call);
  const b = call.body;
  if (!Array.isArray(b.opportunities) || !Array.isArray(b.refusals)) return unreadable(call.status, 'opportunities');
  const o = b.opportunities.find((x: any) => x?.subjectId === placeId);
  if (o) return { state: 'ok', value: { found: true, opportunity: { kind: String(o.kind), decision: o.decision ?? null, reachable: o.reachable ?? null, validUntil: o.window?.expiresAt ?? null } } };
  const r = b.refusals.find((x: any) => x?.subjectId === placeId);
  return { state: 'ok', value: { found: false, reason: r?.reason ?? (b.liveIntelligenceReadable === false ? 'live_intelligence_unavailable' : 'no_opportunity') } };
}

export const OPPORTUNITY_WORDS: Record<string, string> = {
  go_now: 'Worth going now', switch_now: 'Worth switching to now', return_window: 'Worth going back to', opening_window: 'Opening up soon',
};
export const OPPORTUNITY_REFUSAL_WORDS: Record<string, string> = {
  live_intelligence_unavailable: "Can't check for a live opportunity here right now — live intelligence couldn't be read.",
  no_opportunity: 'No live opportunity here right now.',
  safety_suppressed: 'Not offered here right now, for safety reasons.',
  not_in_world_context: "This place isn't one Compass can read live.",
};

export interface SessionView { sessionId: string; subjectId: string; kind: string; openedAt: string; expiresAt: string }
function toSession(e: any): SessionView | null {
  if (!e || typeof e.session_id !== 'string') return null;
  return { sessionId: e.session_id, subjectId: String(e.subject_id), kind: String(e.opportunity_kind ?? ''), openedAt: String(e.opened_at ?? ''), expiresAt: String(e.expires_at ?? '') };
}

/** The viewer's open session. A read the server REFUSED (`refusal`) is a failure, never "no session". */
export async function fetchOpenSession(): Promise<Read<SessionView | null>> {
  const call = await liveRequest<any>('GET', '/api/intel/experience-sessions/open');
  if (call.kind !== 'ok') return fail(call);
  if (call.body.refusal) return { state: 'failed', call: { kind: 'unavailable', status: call.status, detail: `your open session could not be read (${call.body.refusal})` } };
  return { state: 'ok', value: toSession(call.body.session) };
}

export type SessionWrite<T> = { ok: true; value: T } | { ok: false; refusal: string; detail: string };

function writeFailure(call: Failure): { ok: false; refusal: string; detail: string } {
  if (call.kind === 'refused') return { ok: false, refusal: call.body?.reason ?? call.body?.refusal ?? call.error, detail: call.detail ?? '' };
  if (call.kind === 'off') return { ok: false, refusal: call.reason, detail: '' };
  return { ok: false, refusal: 'unavailable', detail: call.detail };
}

export async function startSessionFromOpportunity(placeId: string): Promise<SessionWrite<SessionView>> {
  const call = await liveRequest<any>('POST', '/api/intel/experience-sessions/from-opportunity', { subjectId: placeId, surface: 'place' });
  if (call.kind !== 'ok') return writeFailure(call);
  const s = toSession(call.body.session);
  return s ? { ok: true, value: s } : { ok: false, refusal: 'unavailable', detail: 'unreadable session' };
}

export const SESSION_OUTCOMES = [
  { key: 'better', label: 'Better than expected' },
  { key: 'same', label: 'As expected' },
  { key: 'worse', label: 'Worse' },
  { key: 'could_not_enter', label: "Couldn't get in" },
  { key: 'did_not_go', label: "Didn't go" },
] as const;

export async function closeSession(sessionId: string, outcome: string): Promise<SessionWrite<{ calibrated: boolean }>> {
  const call = await liveRequest<any>('POST', `/api/intel/experience-sessions/${encodeURIComponent(sessionId)}/close`, { outcome, surface: 'place' });
  if (call.kind !== 'ok') return writeFailure(call);
  if (call.body.state !== 'closed') return { ok: false, refusal: 'unavailable', detail: 'the server did not confirm the close' };
  return { ok: true, value: { calibrated: call.body.calibrated === true } };
}

export const SESSION_REFUSAL_WORDS: Record<string, string> = {
  already_open: 'You already have an open session — report how that one went first.',
  subject_not_actionable: 'Compass has no live opportunity here to act on.',
  live_intelligence_unavailable: "Live intelligence couldn't be read, so no session was opened.",
  no_opportunity: 'No live opportunity here right now, so no session was opened.',
  safety_suppressed: 'Not offered here right now, for safety reasons.',
  expired: 'That session has already ended — outcomes are only taken during it.',
  already_closed: 'That session is already closed.',
  feature_disabled: "Sessions aren't switched on in this build.",
  unavailable: "Couldn't reach Portava — nothing was changed.",
};
