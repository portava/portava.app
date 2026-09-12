/**
 * §11 Today — the client for GET /trips/:tripId/today. census-trips TR193
 * (§11.2's five questions, in order), TR317 (AT_RISK priority applied by a
 * surface), TR172 (§10.3 sensing published for the client to obey).
 *
 * WHAT THIS SURFACE IS ALLOWED TO SAY
 * ===================================
 * The projection answers five questions in a fixed order — where am I now,
 * what is next, who is around, what can I do, what changed — and names the
 * field that answers each. The card renders them in that order and nothing
 * else first: a Today that opens with an offer has stopped being Today.
 *
 * THE PRIORITY SWITCH IS THE SERVER'S
 * ===================================
 * `attention.mode` is derived by §17.2 from health; the client does not
 * decide it, it OBEYS it — when `suppression.discovery` is true the card
 * shows no opportunities and says why in the server's words.
 *
 * THE THIRD STATE, AS EVERYWHERE ELSE IN TRIPS
 * ===========================================
 * `off` and `unavailable` are different and neither is an answer. A Today
 * that could not be read is not a quiet day; the card says the read failed.
 * A projection that fails §19.1's envelope (schema, stale) is refused with
 * Appendix B's reason and rendered as unavailable, never as the day.
 */
import { isConfigured, apiBase, bearerToken } from '../shared/auth.ts';
import { acceptProjection, type TripProjectionEnvelope } from '../../../services/tripProjectionEnvelope.ts';

export type OperationalPhase = 'FREE_TIME' | 'ACTIVE_PLAN' | 'TRANSIT' | 'LEAVE_BY_WINDOW' | 'DISRUPTED' | 'AT_RISK' | 'REST';
export type PriorityMode = 'NORMAL' | 'AT_RISK_MODE' | 'SAFETY_EVENT';
export type HealthLevel = 'HEALTHY' | 'ATTENTION' | 'AT_RISK' | 'CRITICAL';

export interface TodayCurrentPlan { id: string; title: string | null; category: string | null; status: string | null; startsAt: string | null; endsAt: string | null; locationName: string | null }
export interface TodayNextCommitment { id: string; type: string; arriveBy: string; startsAt: string | null; placeId: string | null; mustLeaveBy: string | null; windowId: string | null }
export interface TodayFreeWindow { id: string; beginsAt: string; endsAt: string; durationMinutes: number; certified: boolean; confidence: string }
export interface TodayCrewSummary { total: number; accepted: number; invited: number; featureEnabled: boolean; liveSharing: number | null; safeReturnActive: number | null; withLocation: number | null; detail: string | null }
export interface TodayUnresolvedAction { kind: string; subjectIds: string[]; detail: string; severity: 'critical' | 'normal' }
export interface TodayAttention {
  mode: PriorityMode | string;
  priority: string[];
  suppression: { commercial: boolean; discovery: boolean; reason: string | null; detail: string | null };
}
export interface TodaySensing { level: string; intervalSeconds: number; reasons: string[]; reading: string }
export type TodayLayer<T> = { status: 'ok'; items: T[] } | { status: 'unread'; reason: string } | { status: 'no_source'; reason: string };

export interface TripToday extends TripProjectionEnvelope {
  tripId: string;
  decisionId: string;
  stageReading: string;
  nowState: { phase: OperationalPhase | string | null; reason: string; primaryFocus: string | null };
  health: HealthLevel | string;
  healthReasons: { code: string; level: string; subjectIds: string[]; detail: string }[];
  currentPlan: TodayCurrentPlan | null;
  nextCommitment: TodayNextCommitment | null;
  freeWindows: TodayFreeWindow[];
  crewSummary: TodayCrewSummary;
  opportunities: TodayLayer<{ id: string; title?: string; label?: string }>;
  unresolvedActions: TodayUnresolvedAction[];
  attention: TodayAttention;
  sensing: TodaySensing;
  /** §11.2's five questions, in order, each naming the field that answers it. */
  answers: { now: string; next: string; who: string; canDo: string; changed: string };
}

export type TodayRead =
  | { state: 'ok'; today: TripToday; lagSeconds: number }
  /** Not configured here, or the feature is off. Nothing was read. */
  | { state: 'off' }
  /** The read FAILED, or §19.1 refused the projection. Never a quiet day. */
  | { state: 'unavailable'; detail: string; reason?: string };

const PHASES = new Set(['FREE_TIME', 'ACTIVE_PLAN', 'TRANSIT', 'LEAVE_BY_WINDOW', 'DISRUPTED', 'AT_RISK', 'REST']);

function looksLikeToday(b: unknown): b is TripToday {
  const t = b as Partial<TripToday> | null;
  return !!t && typeof t === 'object' && typeof t.tripId === 'string' && !!t.nowState && typeof t.nowState === 'object'
    && !!t.answers && typeof t.answers === 'object' && Array.isArray(t.freeWindows) && Array.isArray(t.unresolvedActions)
    && !!t.attention && typeof t.attention === 'object' && !!t.attention.suppression && !!t.sensing && typeof t.sensing.intervalSeconds === 'number'
    && !!t.crewSummary && typeof t.crewSummary === 'object';
}

export async function fetchTripToday(tripId: string, opts: { now?: number } = {}): Promise<TodayRead> {
  if (!isConfigured() || !apiBase()) return { state: 'off' };
  const token = await bearerToken();
  if (!token) return { state: 'off' };
  try {
    const res = await fetch(`${apiBase()}/api/trips/${tripId}/today`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string; reason?: string; message?: string } | null;
      if (res.status === 404 && (body?.error === 'feature_disabled' || body?.reason === 'FEATURE_DISABLED')) return { state: 'off' };
      return { state: 'unavailable', detail: body?.message ?? `HTTP ${res.status}`, reason: body?.reason };
    }
    const body: unknown = await res.json().catch(() => null);
    const accepted = acceptProjection(body, { now: opts.now });
    if (!accepted.accepted) return { state: 'unavailable', detail: accepted.message, reason: accepted.reason };
    if (!looksLikeToday(body)) return { state: 'unavailable', detail: 'unreadable response' };
    return { state: 'ok', today: body, lagSeconds: accepted.lagSeconds };
  } catch (e: any) {
    return { state: 'unavailable', detail: String(e?.message ?? 'network error') };
  }
}

/* ── pure readings, pinned by tests ─────────────────────────────────────── */

export const PHASE_LABEL: Record<string, string> = {
  FREE_TIME: 'Free time', ACTIVE_PLAN: 'On a plan', TRANSIT: 'In transit', LEAVE_BY_WINDOW: 'Time to leave soon',
  DISRUPTED: 'Disrupted', AT_RISK: 'At risk', REST: 'Resting',
};

function hhmm(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** The headline: the phase in words, or the honest "not in progress" the projection gives. */
export function todayHeadline(t: TripToday): string {
  const phase = t.nowState.phase;
  if (!phase) return 'Not in progress today';
  return (PHASES.has(phase) ? PHASE_LABEL[phase] : phase) ?? phase;
}

export interface TodayAnswer { key: 'now' | 'next' | 'who' | 'canDo' | 'changed'; question: string; answer: string }

/**
 * §11.2's five questions, in the spec's order, each answered from the field
 * the projection names. An answer that would have to guess says so instead.
 */
export function todayAnswers(t: TripToday): TodayAnswer[] {
  const now = t.currentPlan
    ? `${todayHeadline(t)} — ${t.currentPlan.title ?? 'a plan'}${t.currentPlan.locationName ? ` at ${t.currentPlan.locationName}` : ''}`
    : `${todayHeadline(t)}. ${t.nowState.reason}`;
  let next: string;
  if (t.nextCommitment) {
    const leave = hhmm(t.nextCommitment.mustLeaveBy); const arrive = hhmm(t.nextCommitment.arriveBy);
    next = `${t.nextCommitment.type}${arrive ? `, arrive by ${arrive}` : ''}${leave ? ` — leave by ${leave}` : ' — leave-by unknown'}`;
  } else next = 'Nothing scheduled next';
  const c = t.crewSummary;
  const who = !c.featureEnabled
    ? `${c.accepted} of ${c.total} on the crew; where they are is not shared here`
    : `${c.accepted} on the crew, ${c.liveSharing ?? 0} sharing live${(c.safeReturnActive ?? 0) > 0 ? `, ${c.safeReturnActive} on Safe Return` : ''}`;
  const w = t.freeWindows[0];
  let canDo: string;
  if (t.attention.suppression.discovery) canDo = t.attention.suppression.detail ?? 'Discovery is paused while the trip needs attention';
  else if (w) canDo = `${w.durationMinutes} min free until ${hhmm(w.endsAt) ?? 'later'}${w.certified ? '' : ' (not certified)'}${t.opportunities.status === 'ok' && t.opportunities.items.length > 0 ? ` — ${t.opportunities.items.length} thing(s) you could do` : ''}`;
  else canDo = 'No free window right now';
  const changes = [
    t.health !== 'HEALTHY' ? `${t.health}: ${t.healthReasons.map((r) => r.detail).join('; ') || 'see reasons'}` : null,
    t.unresolvedActions.length > 0 ? `${t.unresolvedActions.length} thing(s) need a decision` : null,
  ].filter((x): x is string => !!x);
  const changed = changes.length > 0 ? changes.join(' · ') : 'Nothing has changed';
  return [
    { key: 'now', question: 'Where am I now?', answer: now },
    { key: 'next', question: "What's next?", answer: next },
    { key: 'who', question: 'Who is around?', answer: who },
    { key: 'canDo', question: 'What can I do?', answer: canDo },
    { key: 'changed', question: 'What changed?', answer: changed },
  ];
}

/** The banner when the §17.2 switch is not NORMAL: the server's priority list and what it suppresses. */
export function attentionBanner(t: TripToday): { title: string; detail: string } | null {
  if (t.attention.mode === 'NORMAL') return null;
  const title = t.attention.mode === 'SAFETY_EVENT' ? 'Safety first' : 'This trip needs attention';
  const detail = `${t.attention.priority.join(' → ')}${t.attention.suppression.detail ? `. ${t.attention.suppression.detail}` : ''}`;
  return { title, detail };
}

/** §10.3: how often this client should sample location, in the server's words. */
export function sensingLine(t: TripToday): string {
  const s = t.sensing;
  const every = s.intervalSeconds >= 120 ? `${Math.round(s.intervalSeconds / 60)} min` : `${s.intervalSeconds} s`;
  return `Checking location every ${every} (${s.level})${s.reasons.length > 0 ? ` — ${s.reasons.join(', ')}` : ''}`;
}
