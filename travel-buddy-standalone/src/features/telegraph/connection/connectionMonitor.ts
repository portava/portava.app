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

let outcomes: RequestOutcome[] = [];
let realtime: RealtimeStatus = 'idle';
let everOpen = false;
let view: ConnectionView = { state: 'ONLINE', cause: null };
const listeners = new Set<(v: ConnectionView) => void>();

function recompute() {
  const next = deriveConnectionState({ realtime, everOpen, outcomes, previous: view.state });
  if (next.state === view.state && next.cause === view.cause) return;
  view = next;
  for (const l of [...listeners]) {
    try { l(view); } catch { /* isolate a listener */ }
  }
}

/** Record how one request to the API ended. Called by the messaging transport. */
export function noteTelegraphRequest(outcome: RequestOutcome): void {
  outcomes = [...outcomes, outcome].slice(-OUTCOME_WINDOW);
  recompute();
}

/** The realtime service's status, as the store last saw it. */
export function noteRealtimeStatus(status: RealtimeStatus): void {
  realtime = status;
  if (status === 'open') everOpen = true;
  recompute();
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
