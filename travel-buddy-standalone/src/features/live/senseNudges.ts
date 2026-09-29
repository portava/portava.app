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
 * it SUPPRESSED (and why). It does not report which of its signal reads failed,
 * so "0 delivered" is exactly that — nothing was sent on this check — and the
 * panel never says "nothing to nudge you about".
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
}

export type SenseRead<T> =
  | { state: 'ok'; value: T }
  | { state: 'off'; call: Exclude<LiveCall<unknown>, { kind: 'ok' }> | null }
  | { state: 'unavailable'; call: Exclude<LiveCall<unknown>, { kind: 'ok' }> };

function compassOff(body: any): boolean {
  return body?.compassEnabled === false;
}

export async function runSenseCheck(): Promise<SenseRead<SenseCheck>> {
  const call = await liveRequest<any>('POST', '/api/compass/sense/check', {});
  if (call.kind !== 'ok') return call.kind === 'off' ? { state: 'off', call } : { state: 'unavailable', call };
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
};

/** One line for a check, saying only what the server reported. */
export function checkSummary(c: SenseCheck): string {
  if (c.presenceLevel === 'passive') return 'Sense is on Passive, so nothing was evaluated and nothing was sent.';
  const sent = c.delivered.length;
  const held = c.suppressed.length;
  const head = sent === 0 ? 'No nudge was delivered on this check' : `${sent} nudge${sent === 1 ? '' : 's'} delivered`;
  return `${head}${held > 0 ? `; ${held} held back` : ''}.`;
}
