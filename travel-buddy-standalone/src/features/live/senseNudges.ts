/**
 * TM-live (WP-11) COMP-F11 — Compass Sense: run a check, read the nudges.
 *
 *   POST /api/compass/sense/check   the server evaluates the caller's own
 *                                   signals and delivers what passes every gate
 *                                   (presence → permission → quiet hours →
 *                                   dedupe → daily cap)
 *   GET  /api/compass/sense/nudges  the nudges delivered in the last 7 days
 *
 * Both answer `{ compassEnabled: false, fallback: true }` with Compass off,
 * which is `off` here, never an empty list. A failed nudge read is a 503 on the
 * server (TM-live COMP-F11) and `unavailable` here — never "no nudges".
 *
 * WHAT A CHECK RESULT MAY CLAIM. The server reports what it DELIVERED and what
 * it SUPPRESSED (and why), and — since census-compass §30/§32 — which checks it
 * could NOT run: a 200 adds `partial: true, failedSources: [...]`, and a check
 * that could read nothing (or could not read the presence setting) is a 503
 * `degraded_unavailable` carrying the same `failedSources`. So "0 delivered" is
 * exactly that — nothing was sent on this check — the checks that could not run
 * are named next to it, and the panel never says "nothing to nudge you about".
 */
import { liveRequest, type LiveCall } from './liveApi.ts';

export interface SenseNudge {
  id: string;
  type: string;
  category: string;
  title: string;
  body: string;
  actionUrl: string | null;
  createdAt: string;
}

export interface SenseCheck {
  presenceLevel: 'passive' | 'aware' | 'active' | string;
  evaluated: number;
  delivered: { type: string; category: string; title: string; body: string; actionUrl: string | null }[];
  suppressed: { type: string; reason: string }[];
  /** The checks the server could not run on this pass (empty on a complete check). */
  failedSources: string[];
}

export type SenseRead<T> =
  | { state: 'ok'; value: T }
  | { state: 'off'; call: Exclude<LiveCall<unknown>, { kind: 'ok' }> | null }
  | { state: 'unavailable'; call: Exclude<LiveCall<unknown>, { kind: 'ok' }>; failedSources?: string[] };

function compassOff(body: any): boolean {
  return body?.compassEnabled === false;
}

export async function runSenseCheck(): Promise<SenseRead<SenseCheck>> {
  const call = await liveRequest<any>('POST', '/api/compass/sense/check', {});
  if (call.kind !== 'ok') {
    if (call.kind === 'off') return { state: 'off', call };
    const named = call.kind === 'unavailable' ? namedSources(call.body?.failedSources) : [];
    return named.length > 0 ? { state: 'unavailable', call, failedSources: named } : { state: 'unavailable', call };
  }
  if (compassOff(call.body)) return { state: 'off', call: null };
  const b = call.body;
  if (typeof b.evaluated !== 'number' || !Array.isArray(b.delivered) || !Array.isArray(b.suppressed)) {
    return { state: 'unavailable', call: { kind: 'unavailable', status: call.status, detail: 'unreadable check result' } };
  }
  return {
    state: 'ok',
    value: {
      presenceLevel: String(b.presenceLevel ?? ''),
      evaluated: b.evaluated,
      delivered: b.delivered.map((d: any) => ({ type: String(d.type), category: String(d.category), title: String(d.title), body: String(d.body), actionUrl: typeof d.actionUrl === 'string' ? d.actionUrl : null })),
      suppressed: b.suppressed.map((x: any) => ({ type: String(x.type), reason: String(x.reason) })),
      failedSources: namedSources(b.failedSources).length > 0 ? namedSources(b.failedSources) : b.partial === true ? ['unknown'] : [],
    },
  };
}

export async function fetchSenseNudges(): Promise<SenseRead<SenseNudge[]>> {
  const call = await liveRequest<any>('GET', '/api/compass/sense/nudges');
  if (call.kind !== 'ok') return call.kind === 'off' ? { state: 'off', call } : { state: 'unavailable', call };
  if (compassOff(call.body)) return { state: 'off', call: null };
  if (!Array.isArray(call.body.nudges)) {
    return { state: 'unavailable', call: { kind: 'unavailable', status: call.status, detail: 'unreadable nudge list' } };
  }
  return { state: 'ok', value: call.body.nudges as SenseNudge[] };
}

/** Why a candidate was held back, in words. The codes are CompassSenseEngine's SuppressedNudge reasons. */
export const SUPPRESSION_WORDS: Record<string, string> = {
  presence_passive: 'Sense is on Passive',
  presence_aware_category: 'Aware only sends time-critical nudges',
  category_disabled: 'you turned this category off',
  quiet_hours: 'quiet hours',
  duplicate: 'already sent today',
  daily_cap: 'daily limit reached',
  daily_cap_unread: "today's nudge count couldn't be read, so nothing was sent",
  permission_unread: "your Sense settings couldn't be read, so nothing was sent",
};

/** One line for a check, saying only what the server reported. */
export function checkSummary(c: SenseCheck): string {
  if (c.presenceLevel === 'passive') return 'Sense is on Passive, so nothing was evaluated and nothing was sent.';
  const sent = c.delivered.length;
  const held = c.suppressed.length;
  const head = sent === 0 ? 'No nudge was delivered on this check' : `${sent} nudge${sent === 1 ? '' : 's'} delivered`;
  return `${head}${held > 0 ? `; ${held} held back` : ''}.`;
}

/** A `failedSources` value as a list of names; anything else is no names. */
function namedSources(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

/**
 * What each check the server may name is, in words. The keys are
 * CompassSenseEngine's SenseSource values: the five signal evaluators, the
 * presence `settings`, and the `nudge_log` the daily cap is counted from.
 */
export const SENSE_SOURCE_WORDS: Record<string, string> = {
  saved_event_starting: 'saved events starting soon',
  leave_earlier: 'route timing (leave earlier)',
  weather_change: "weather for today's plans",
  circle_plan_change: 'circle meetup changes',
  free_time_block: 'free time in your day',
  settings: 'your Sense settings',
  nudge_log: "today's nudge count",
  unknown: 'some of its checks',
};

/** The named checks, in words, comma-separated. */
export function sourceNames(sources: readonly string[]): string {
  return sources.map((x) => SENSE_SOURCE_WORDS[x] ?? x.replace(/_/g, ' ')).join(', ');
}

/** The line beside a partial check's result. Only called when something could not run. */
export function partialLine(c: SenseCheck): string {
  return `Some checks couldn't run: ${sourceNames(c.failedSources)}. Nothing from them is included above — this is not everything.`;
}

/**
 * Was this check CLEAN — every source read? A partial or failed check is not,
 * so whoever throttles checks must not treat it as one. `off` (not signed in,
 * not configured, Compass off) asked nothing, so there is nothing to retry.
 */
export function senseCheckIsClean(r: SenseRead<SenseCheck>): boolean {
  return r.state === 'off' || (r.state === 'ok' && r.value.failedSources.length === 0);
}
