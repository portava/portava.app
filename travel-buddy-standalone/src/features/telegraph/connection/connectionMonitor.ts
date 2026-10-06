/**
 * The store behind §30A.15's connection state: request outcomes recorded by
 * the messaging transport (`services/messaging.ts`), plus the realtime
 * service's status, folded through `deriveConnectionState`.
 *
 * Module-level on purpose: the inbox, the thread screen and the trip chat all
 * share one transport and one realtime connection, so they must agree on one
 * answer rather than each guessing from its own last poll.
 */
import { useEffect, useState } from 'react';

import { telegraphRealtime, type RealtimeStatus } from '../../../services/telegraphRealtimeService.ts';
import {
  deriveConnectionState,
  OUTCOME_WINDOW,
  type ConnectionView,
  type RequestOutcome,
} from './connectionState.ts';
import { deriveBandwidthSignal, LATENCY_WINDOW, type BandwidthView } from './bandwidthSignal.ts';

let outcomes: RequestOutcome[] = [];
let realtime: RealtimeStatus = 'idle';
let everOpen = false;
let view: ConnectionView = { state: 'ONLINE', cause: null };
const listeners = new Set<(v: ConnectionView) => void>();
// §17.4's bandwidth signal: how long recent ANSWERED requests took.
let durations: number[] = [];
let bandwidth: BandwidthView = { signal: 'normal', cause: null };
const bandwidthListeners = new Set<(b: BandwidthView) => void>();

function recomputeBandwidth() {
  const next = deriveBandwidthSignal({ connection: view.state, durationsMs: durations });
  if (next.signal === bandwidth.signal && next.cause === bandwidth.cause) return;
  bandwidth = next;
  for (const l of [...bandwidthListeners]) {
    try { l(bandwidth); } catch { /* isolate a listener */ }
  }
}

function recompute() {
  const next = deriveConnectionState({ realtime, everOpen, outcomes, previous: view.state });
  if (next.state === view.state && next.cause === view.cause) return;
  view = next;
  for (const l of [...listeners]) {
    try { l(view); } catch { /* isolate a listener */ }
  }
}

/**
 * Record how one request to the API ended. Called by the messaging transport.
 * `durationMs`, when the transport timed the request, feeds §17.4's bandwidth
 * signal; only ANSWERED requests are timed — a failure has no useful duration.
 */
export function noteTelegraphRequest(outcome: RequestOutcome, durationMs?: number): void {
  outcomes = [...outcomes, outcome].slice(-OUTCOME_WINDOW);
  if (outcome === 'ok' && typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0) {
    durations = [...durations, durationMs].slice(-LATENCY_WINDOW);
  }
  recompute();
  recomputeBandwidth();
}

/** The realtime service's status, as the store last saw it. */
export function noteRealtimeStatus(status: RealtimeStatus): void {
  realtime = status;
  if (status === 'open') everOpen = true;
  recompute();
  recomputeBandwidth();
}

/** §17.4's measured bandwidth signal, as the monitor last derived it. */
export function currentBandwidth(): BandwidthView {
  return bandwidth;
}

export function subscribeBandwidth(l: (b: BandwidthView) => void): () => void {
  bandwidthListeners.add(l);
  return () => { bandwidthListeners.delete(l); };
}

/** The measured bandwidth signal, for a hook. */
export function useBandwidthSignal(): BandwidthView {
  const [b, setB] = useState<BandwidthView>(currentBandwidth());
  useEffect(() => {
    const unsub = subscribeBandwidth(setB);
    setB(currentBandwidth());
    return unsub;
  }, []);
  return b;
}

export function currentConnection(): ConnectionView {
  return view;
}

export function subscribeConnection(l: (v: ConnectionView) => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** Test seam: forget everything. Not called by production code. */
export function _resetConnectionMonitor(): void {
  outcomes = [];
  realtime = 'idle';
  everOpen = false;
  view = { state: 'ONLINE', cause: null };
  listeners.clear();
  durations = [];
  bandwidth = { signal: 'normal', cause: null };
  bandwidthListeners.clear();
}

/**
 * The connection state, for a screen. Subscribes to the realtime service's
 * status while mounted, so the banner follows the stream without each screen
 * wiring it.
 */
export function useTelegraphConnection(): ConnectionView {
  const [v, setV] = useState<ConnectionView>(currentConnection());
  useEffect(() => {
    const unsubConn = subscribeConnection(setV);
    const unsubRealtime = telegraphRealtime.onStatus((s) => noteRealtimeStatus(s));
    setV(currentConnection());
    return () => { unsubConn(); unsubRealtime(); };
  }, []);
  return v;
}
