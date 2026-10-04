/**
 * Telegraph §30A.15 — "Truthful ONLINE / POOR_CONNECTION / OFFLINE /
 * RECONNECTING".
 *
 * WHAT WAS THERE: nothing a person could see. The realtime service tracked its
 * own status (`idle | connecting | open | polling`) and nobody rendered it; the
 * thread and inbox polls swallowed their failures and simply stopped updating.
 * A conversation that could not reach the server looked exactly like a quiet
 * one.
 *
 * WHAT THIS DECIDES, from two things the client actually observes:
 *
 *   1. how its own recent requests to the API ended — answered (`ok`, which
 *      includes a REFUSAL: a 403 is a server that was reached), failed at the
 *      network layer (`network`: the request never got an answer), or answered
 *      with a server error (`server`, 5xx);
 *   2. the realtime stream's status.
 *
 * It never claims more than those show. In particular it cannot know whether
 * the DEVICE is offline (there is no reachability API in this app); OFFLINE
 * here means "Portava could not be reached", and the copy says exactly that.
 * A run of server errors is not "offline" — the device reached a server that
 * failed — so it is POOR_CONNECTION with its own cause and its own words.
 *
 * Pure. The store that feeds it is `connectionMonitor.ts`.
 */

export type ConnectionState = 'ONLINE' | 'POOR_CONNECTION' | 'OFFLINE' | 'RECONNECTING';
export type ConnectionCause = 'network' | 'server' | 'realtime' | null;
export type RequestOutcome = 'ok' | 'network' | 'server';
export type RealtimeStatusLike = 'idle' | 'connecting' | 'open' | 'polling';

/** How many recent request outcomes the state is read from. */
export const OUTCOME_WINDOW = 6;
/** Consecutive unanswered requests before "can't reach Portava" is said. */
export const OFFLINE_AFTER = 2;

export interface ConnectionInputs {
  realtime: RealtimeStatusLike;
  /** The stream has been open at least once this session. */
  everOpen: boolean;
  /** Most recent LAST. */
  outcomes: readonly RequestOutcome[];
  /** The previous state, so "reconnecting" can be told from "connecting for the first time". */
  previous?: ConnectionState;
}

export interface ConnectionView { state: ConnectionState; cause: ConnectionCause }

function trailing(outcomes: readonly RequestOutcome[], kind: RequestOutcome): number {
  let n = 0;
  for (let i = outcomes.length - 1; i >= 0 && outcomes[i] === kind; i--) n++;
  return n;
}

export function deriveConnectionState(i: ConnectionInputs): ConnectionView {
  const window = i.outcomes.slice(-OUTCOME_WINDOW);
  const last = window[window.length - 1];

  // Requests are not being answered at all.
  if (trailing(window, 'network') >= OFFLINE_AFTER) return { state: 'OFFLINE', cause: 'network' };

  // Coming back: the last request was answered after an outage, or the stream
  // is re-opening after it had been open — but it is not open yet.
  const recovering = i.previous === 'OFFLINE' || i.previous === 'RECONNECTING';
  if (recovering && last === 'ok' && i.realtime !== 'open' && i.realtime !== 'idle') {
    return { state: 'RECONNECTING', cause: 'realtime' };
  }
  if (i.everOpen && i.realtime === 'connecting') return { state: 'RECONNECTING', cause: 'realtime' };

  // The server was reached and failed, more than once in a row.
  if (trailing(window, 'server') >= 2) return { state: 'POOR_CONNECTION', cause: 'server' };

  // Answered, but not reliably: a single unanswered request, or failures
  // still inside the window.
  if (last === 'network') return { state: 'POOR_CONNECTION', cause: 'network' };
  if (window.some((o) => o !== 'ok')) {
    return { state: 'POOR_CONNECTION', cause: window.includes('network') ? 'network' : 'server' };
  }

  // Requests are fine but live updates could not be held open: they arrive by
  // polling, later than they would.
  if (i.realtime === 'polling') return { state: 'POOR_CONNECTION', cause: 'realtime' };

  return { state: 'ONLINE', cause: null };
}

/** The words. Null for ONLINE — a healthy connection is not announced. */
export function connectionCopy(v: ConnectionView): string | null {
  switch (v.state) {
    case 'ONLINE':
      return null;
    case 'OFFLINE':
      return "Can't reach Portava. New messages can't arrive, and anything you send won't go through until you're back.";
    case 'RECONNECTING':
      return 'Reconnecting…';
    case 'POOR_CONNECTION':
      if (v.cause === 'server') return 'Portava is having trouble right now — messages may arrive late.';
      if (v.cause === 'realtime') return 'Live updates are paused — new messages may take a few seconds to appear.';
      return 'Your connection is unstable — messages may arrive late.';
  }
}
