/**
 * Layover disruption — §15.2 "Disruption mode", the CLIENT half
 * (census-layover L148, L149, L231).
 *
 *   POST /api/airport/sessions/:id/disruption
 *   (artifacts/api-server/src/routes/airport.ts, behind `airport_mode_enabled`)
 *
 * The server half was finished before this file existed: the route reads the
 * prior state from the decision ledger (`layover_events`), runs
 * `nextDisruptionState`, re-certifies the whole window through
 * `recomputeForDisruption` when the departure moved, and records the
 * transition. Nothing on the client called it, so no traveller could reach any
 * of that. This is the call.
 *
 * Its own file rather than `services/layover.ts`, which another lane owns and
 * whose lines the census cites. Only TYPES are imported from there.
 *
 * ── THE CLIENT COMPUTES NO TRANSITION ────────────────────────────────────────
 * The answer is forwarded, not interpreted. The state is whatever the server
 * says, including a state this build has no label for (it is shown as its own
 * code rather than dropped or mapped onto a neighbour). The delay total, the
 * recomputed window, the deltas and the recovery posture are all the server's;
 * nothing here subtracts two instants or decides a state from a number.
 *
 * ── THE INPUT SOURCE IS THE TRAVELLER ────────────────────────────────────────
 * There is no flight feed on this tree. The route says so on the wire
 * (`source: "traveller"`) and this client carries the field through so the
 * card can say who the report came from.
 *
 * ── WHAT IS REMEMBERED ON THIS PHONE, AND WHY ────────────────────────────────
 * The SERVER remembers the state: the ledger is read on every report and comes
 * back as `previousState`. No GET route publishes that ledger state, so after a
 * reload the screen would otherwise have nothing to show until the next
 * report. The last answer the server said it RECORDED is therefore kept here,
 * per session, and shown captioned as the last report saved on this phone. An
 * answer the server applied but did not record is NOT kept: it is not what the
 * server remembers, and keeping it would show a state the next report will
 * not start from.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { freshToken } from './apiToken.ts';
import type { LayoverCertification, SafeReturnPosture } from './layover.ts';

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

function disruptionUrl(sessionId: string): string {
  return `${apiBase()}/api/airport/sessions/${encodeURIComponent(sessionId)}/disruption`;
}

async function authedFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const token = await freshToken();
  return fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
}

// ── The request ──────────────────────────────────────────────────────────────

/** The five reports the route accepts (`disruptionSchema.kind`). */
export type DisruptionKind = 'delay' | 'cancellation' | 'rebooking_offered' | 'rebooking_confirmed' | 'on_time';

/**
 * What the traveller reports. A delay is EITHER the total minutes against the
 * original schedule OR the new departure as an airport-local wall time
 * (`YYYY-MM-DD HH:MM`); only the second moves the schedule, and so only the
 * second makes the server recompute the window.
 */
export type DisruptionReport =
  | { kind: 'delay'; delayMinutes: number }
  | { kind: 'delay'; newDepartureLocal: string }
  | { kind: 'cancellation' }
  | { kind: 'rebooking_offered' }
  | { kind: 'rebooking_confirmed' }
  | { kind: 'on_time' };

// ── The answer ───────────────────────────────────────────────────────────────

/** §15.2's seven states, for labelling only. The wire is read as a string. */
export const KNOWN_DISRUPTION_STATES = [
  'CONNECTION', 'DELAYED', 'SEVERE_DELAY', 'OVERNIGHT', 'CANCELLED', 'REBOOKING', 'RECOVERY',
] as const;

/** One side of the recompute, exactly as the route publishes it. */
export interface DisruptionWindowSide {
  usableMinutes: number;
  returnState: string;
  hardReturnTime: string;
  /** Airport-local, `after` only. */
  hardReturnLocal: string | null;
}

/** §15.2 "Recompute; do not simply append delay minutes" — the server's own figures. */
export interface DisruptionRecompute {
  scheduleDeltaMinutes: number;
  usableMinutesDelta: number;
  /** TRUE when the window did NOT move by the same minutes as the schedule. */
  recomputedNotAppended: boolean;
  returnStateChanged: boolean;
  before: DisruptionWindowSide;
  after: DisruptionWindowSide;
}

/** One kind of recovery help and whether it exists. `reason` is the server's code. */
export interface RecoveryHelp {
  available: boolean;
  reason: string | null;
}

/** §15 L145 — what recovery help exists, said as it is (`recoveryPosture`). */
export interface DisruptionRecovery {
  recoveryNeeded: boolean;
  rebooking: RecoveryHelp;
  airlineContact: RecoveryHelp;
  airportHelp: RecoveryHelp;
}

export interface DisruptionAnswer {
  /** Who the report came from. `"traveller"` on this tree: there is no flight feed. */
  source: string;
  /** The state the server's ledger held before this report. */
  previousState: string;
  /** `"ledger"` when a recorded transition was found, `"default"` when none ever was. */
  previousStateSource: string;
  /** The state the server moved the session to. */
  state: string;
  /** The event as the server read it — `delayMinutes` is the server's total. */
  event: { kind: string; delayMinutes: number | null };
  baselineDepartureTime: string | null;
  /** FALSE when the transition happened and the ledger write did not. */
  stateRecorded: boolean;
  /** `null` for a report that moved no schedule. */
  recompute: DisruptionRecompute | null;
  /** `null` when the server stated no posture (an older server). */
  recovery: DisruptionRecovery | null;
  safeReturn: SafeReturnPosture | null;
  certification: LayoverCertification | null;
}

export type DisruptionFailure = 'refused' | 'disabled' | 'gone' | 'unavailable' | 'unreachable' | 'malformed';

export type DisruptionReportOutcome =
  | { ok: true; answer: DisruptionAnswer }
  /** The route answered 500 WITH its payload: applied, not recorded. */
  | { ok: false; reason: 'not_recorded'; message: string; retryable: true; answer: DisruptionAnswer }
  | { ok: false; reason: DisruptionFailure; message: string; retryable: boolean };

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function windowSide(v: unknown): DisruptionWindowSide | null {
  if (!isRecord(v)) return null;
  const usableMinutes = finite(v.usableMinutes);
  const returnState = str(v.returnState);
  const hardReturnTime = str(v.hardReturnTime);
  if (usableMinutes === null || !returnState || !hardReturnTime) return null;
  return { usableMinutes, returnState, hardReturnTime, hardReturnLocal: str(v.hardReturnLocal) };
}

function recomputeOf(v: unknown): DisruptionRecompute | null {
  if (!isRecord(v)) return null;
  const before = windowSide(v.before);
  const after = windowSide(v.after);
  const scheduleDeltaMinutes = finite(v.scheduleDeltaMinutes);
  const usableMinutesDelta = finite(v.usableMinutesDelta);
  if (!before || !after || scheduleDeltaMinutes === null || usableMinutesDelta === null) return null;
  return {
    scheduleDeltaMinutes,
    usableMinutesDelta,
    recomputedNotAppended: v.recomputedNotAppended === true,
    returnStateChanged: v.returnStateChanged === true,
    before,
    after,
  };
}

function helpOf(v: unknown): RecoveryHelp {
  // Only a literal `true` is help. Anything else is the absence it says it is.
  if (!isRecord(v)) return { available: false, reason: null };
  return { available: v.available === true, reason: str(v.reason) };
}

function recoveryOf(v: unknown): DisruptionRecovery | null {
  if (!isRecord(v)) return null;
  return {
    recoveryNeeded: v.recoveryNeeded === true,
    rebooking: helpOf(v.rebooking),
    airlineContact: helpOf(v.airlineContact),
    airportHelp: helpOf(v.airportHelp),
  };
}

/**
 * The route's body, read defensively. `null` when the one thing the card exists
 * to show — the state the server moved the session to — is missing: an answer
 * without a state is not rendered as any state.
 */
export function parseDisruptionAnswer(json: unknown): DisruptionAnswer | null {
  if (!isRecord(json) || !isRecord(json.disruption)) return null;
  const d = json.disruption;
  const state = str(d.state);
  const previousState = str(d.previousState);
  if (!state || !previousState) return null;
  const event = isRecord(d.event) ? d.event : {};
  return {
    source: str(d.source) ?? 'unknown',
    previousState,
    previousStateSource: str(d.previousStateSource) ?? 'unknown',
    state,
    event: { kind: str(event.kind) ?? 'unknown', delayMinutes: finite(event.delayMinutes) },
    baselineDepartureTime: str(d.baselineDepartureTime),
    stateRecorded: d.stateRecorded === true,
    recompute: recomputeOf(json.recompute),
    recovery: recoveryOf(json.recovery),
    safeReturn: isRecord(json.safeReturn) ? (json.safeReturn as unknown as SafeReturnPosture) : null,
    certification: isRecord(json.certification) ? (json.certification as unknown as LayoverCertification) : null,
  };
}

const UNREACHABLE_MESSAGE = 'Could not reach Portava. Nothing was reported — try again when you have signal.';

function failureFor(status: number, code: string | null): DisruptionFailure {
  if (code === 'feature_disabled') return 'disabled';
  if (code === 'not_found' || status === 404) return 'gone';
  if (code === 'invalid_payload' || status === 400) return 'refused';
  if (status >= 500 || code === 'degraded_unavailable') return 'unavailable';
  return 'refused';
}

/** The body sent for a report. Exported so the suite asserts the wire, not a guess. */
export function disruptionRequestBody(report: DisruptionReport): Record<string, unknown> {
  if (report.kind === 'delay') {
    return 'newDepartureLocal' in report
      ? { kind: 'delay', newDepartureLocal: report.newDepartureLocal }
      : { kind: 'delay', delayMinutes: report.delayMinutes };
  }
  return { kind: report.kind };
}

/**
 * Report a disruption. Always RESOLVES: a rejected `fetch` (no signal) is
 * `unreachable`, never a throw into a press handler.
 */
export async function reportLayoverDisruption(
  sessionId: string,
  report: DisruptionReport,
): Promise<DisruptionReportOutcome> {
  let res: Response;
  try {
    res = await authedFetch(disruptionUrl(sessionId), {
      method: 'POST',
      body: JSON.stringify(disruptionRequestBody(report)),
    });
  } catch {
    return { ok: false, reason: 'unreachable', message: UNREACHABLE_MESSAGE, retryable: true };
  }
  let json: unknown = null;
  try { json = await res.json(); } catch { json = null; }
  const body = isRecord(json) ? json : null;
  const message = str(body?.message);
  const answer = parseDisruptionAnswer(body);

  if (res.ok && body?.ok === true) {
    if (!answer) {
      return { ok: false, reason: 'malformed', message: 'Portava answered, but not with a state we can show. Nothing here has changed.', retryable: true };
    }
    return { ok: true, answer };
  }
  // The route's one failure that still carries the transition: it happened,
  // and the ledger write did not.
  if (answer && res.status >= 500) {
    return {
      ok: false,
      reason: 'not_recorded',
      message: message ?? 'We applied this change but could not record it.',
      retryable: true,
      answer,
    };
  }
  const reason = failureFor(res.status, str(body?.error));
  return {
    ok: false,
    reason,
    message: message ?? 'That report did not go through. Please try again.',
    retryable: body?.retryable === true || reason === 'unavailable',
  };
}

// ── Remembered on this phone ─────────────────────────────────────────────────

/** Bumped whenever the stored shape changes; a record of another version is discarded whole. */
export const REMEMBERED_DISRUPTION_VERSION = 1;

const MEMORY_KEY_PREFIX = 'layover.disruption.v1';

/** Per session, because a disruption belongs to one layover. Exported for the suite. */
export function rememberedDisruptionKey(sessionId: string): string {
  return `${MEMORY_KEY_PREFIX}:${sessionId}`;
}

export interface RememberedDisruption {
  sessionId: string;
  answer: DisruptionAnswer;
  /** DEVICE instant the answer arrived. A caption, never a freshness input. */
  reportedAt: string;
}

/**
 * Keep the server's last RECORDED answer. Returns whether anything was written;
 * an answer the server did not record is never kept (see the header), and a
 * storage layer that refuses is reported, not thrown.
 */
export async function rememberDisruption(sessionId: string, answer: DisruptionAnswer, reportedAt: string = new Date().toISOString()): Promise<boolean> {
  if (!answer.stateRecorded) return false;
  try {
    await AsyncStorage.setItem(
      rememberedDisruptionKey(sessionId),
      JSON.stringify({ v: REMEMBERED_DISRUPTION_VERSION, sessionId, reportedAt, answer }),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * The last recorded answer this phone saw for this session. `null` = nothing
 * is remembered here, and every failure (unparseable bytes, another version,
 * another session's record, a storage layer that throws) is that same `null`.
 */
export async function readRememberedDisruption(sessionId: string): Promise<RememberedDisruption | null> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(rememberedDisruptionKey(sessionId));
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!isRecord(parsed) || parsed.v !== REMEMBERED_DISRUPTION_VERSION || parsed.sessionId !== sessionId) return null;
  const reportedAt = str(parsed.reportedAt);
  const stored = isRecord(parsed.answer) ? parsed.answer : null;
  if (!reportedAt || !stored) return null;
  // Re-read through the same parser the wire goes through: a stored answer is
  // trusted no further than a fresh one.
  const answer = parseDisruptionAnswer({
    disruption: stored,
    recompute: stored.recompute,
    recovery: stored.recovery,
    safeReturn: stored.safeReturn,
    certification: stored.certification,
  });
  if (!answer || !answer.stateRecorded) return null;
  return { sessionId, answer, reportedAt };
}
