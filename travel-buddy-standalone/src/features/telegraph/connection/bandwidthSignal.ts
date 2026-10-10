/**
 * Telegraph §17.4 — a MEASURED bandwidth signal for the degradation ladder.
 *
 * §17.4: "Low bandwidth → deprioritize typing, reactions, media preview and AI
 *         before text or safety coordination."
 *
 * census-telegraph T239: "The LADDER exists … W and not C for the half the row
 * also names: there is still no bandwidth SIGNAL. The ladder is driven by a
 * person's explicit setting, not by a measured connection, so nothing degrades
 * automatically when the network gets bad."
 *
 * TWO MEASUREMENTS, BOTH ALREADY TAKEN BY THE TRANSPORT
 * ====================================================
 *   1. How long the API took to ANSWER — the messaging transport times every
 *      GET it makes (`services/messaging.ts` apiGet) and hands the duration to
 *      the connection monitor. A median over the last few answers above
 *      `SLOW_REQUEST_MS` is a connection that is up but thin: hotel wifi,
 *      roaming data at a border.
 *   2. Whether the API answered at all — §30A.15's connection state. A
 *      connection that is dropping requests (POOR_CONNECTION), reconnecting,
 *      or not reaching Portava (OFFLINE) has no bandwidth to spend on previews.
 *
 * Nothing here reads a device API, and nothing claims to know the link speed:
 * this is what the app OBSERVED its own requests doing, which is the only
 * bandwidth figure it has. Few samples are not a measurement — under
 * `MIN_SAMPLES` the latency half says nothing rather than guessing.
 *
 * Pure, so the rule is testable without the monitor or React.
 */
import type { ConnectionState } from './connectionState.ts';

export type BandwidthSignal = 'normal' | 'constrained';
export type BandwidthCause = 'slow_responses' | 'unreliable_connection' | null;

/** A median answer slower than this is a constrained connection. */
export const SLOW_REQUEST_MS = 2500;
/** How many recent answers the median is taken over. */
export const LATENCY_WINDOW = 5;
/** Fewer answers than this are not a measurement. */
export const MIN_SAMPLES = 3;

export interface BandwidthView {
  signal: BandwidthSignal;
  cause: BandwidthCause;
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function deriveBandwidthSignal(i: {
  connection: ConnectionState;
  durationsMs: readonly number[];
}): BandwidthView {
  if (i.connection === 'POOR_CONNECTION' || i.connection === 'RECONNECTING' || i.connection === 'OFFLINE') {
    return { signal: 'constrained', cause: 'unreliable_connection' };
  }
  const recent = i.durationsMs.filter((d) => Number.isFinite(d) && d >= 0).slice(-LATENCY_WINDOW);
  if (recent.length >= MIN_SAMPLES && median(recent) > SLOW_REQUEST_MS) {
    return { signal: 'constrained', cause: 'slow_responses' };
  }
  return { signal: 'normal', cause: null };
}

// ── §17.4 / census-telegraph T239: a slow server is not a slow connection ────
//
// A request's duration is network + server, and §17.4 is about BANDWIDTH. The API stamps every
// answer with `Server-Timing: app;dur=<ms>` (artifacts/api-server/src/middlewares/
// telegraphObservability.ts stampServerTiming), so the transport hands the monitor the NETWORK
// share: the total minus what the server says it spent. An answer without the header (an older
// server, a proxy that strips it) is counted whole, exactly as before — never as zero.

/** The server's own share of one answer, from its `Server-Timing` header; null when it says nothing usable. */
export function serverDurationMs(serverTiming: string | null | undefined): number | null {
  if (typeof serverTiming !== 'string' || serverTiming.length === 0) return null;
  for (const entry of serverTiming.split(',')) {
    const [name, ...params] = entry.split(';');
    if ((name ?? '').trim() !== 'app') continue;
    for (const param of params) {
      const m = /^\s*dur\s*=\s*"?(\d+(?:\.\d+)?)"?\s*$/.exec(param);
      if (m) return Number(m[1]);
    }
  }
  return null;
}

/** The NETWORK share of an answered request: the total less the server's own time, never below zero. */
export function networkDurationMs(totalMs: number, serverTiming: string | null | undefined): number {
  const server = serverDurationMs(serverTiming);
  if (server === null || !Number.isFinite(server)) return totalMs;
  return Math.max(0, totalMs - server);
}
