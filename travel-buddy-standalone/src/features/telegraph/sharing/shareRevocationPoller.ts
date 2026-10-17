/**
 * Telegraph §5.3 / §29 (census-telegraph T359, adversarial fixture F-12) — a
 * shared card that is ALREADY ON SCREEN hears its source change.
 *
 *   "If the source becomes deleted, private or unauthorized, the Telegraph
 *    reference must degrade to an unavailable state."
 *
 * Before this, a card learned its source's state once — from the thread read
 * that drew it, or its own resolve on mount — and kept that answer for as long
 * as it stayed mounted: a post made private while the conversation was open
 * still drew in full until something re-read the page. No source domain
 * publishes a change the client can hear, so this is the census's other named
 * route: POLLING, bounded.
 *
 * ONE POLL PER THREAD, NOT PER CARD. Every card mounted in a thread subscribes
 * here; a timer per thread asks the existing batch route
 * (`POST /threads/:id/share-projections`, the same authorization the page's own
 * read uses) for all of them at once, in chunks of the route's own cap. A card
 * hears only its own answer.
 *
 * BOUNDED.
 *   - every POLL_BASE_MS (60 s, ±10 % jitter so devices do not align);
 *   - a failed poll is not news: nothing is told to any card, and the next poll
 *     waits twice as long, up to POLL_MAX_MS (15 min); a success resets it;
 *   - while the app is not in the foreground nothing is polled; coming back
 *     polls soon if the last answer is older than the base interval;
 *   - the last card leaving a thread stops that thread's timer (nothing is
 *     left scheduled), and no answer is delivered to a card that has left.
 *
 * WHAT A CARD IS TOLD. Only a definite answer: available (with the server's
 * current projection and actions) or unavailable (with its reason). A ref the
 * server names unsupported, or omits, is "cannot tell" — the card keeps what it
 * had. Never collapsed into "available" (the backdoor) or "unavailable"
 * (blanking on a hiccup); see useShareRevocation's three states.
 */
import { AppState, type AppStateStatus } from 'react-native';
import { resolveShareProjections, type ResolvedShare, type ShareRef, type ShareResult, type ResolveResponse } from './shareApi.ts';
import type { ShareRevocation } from './useShareRevocation.ts';

export const POLL_BASE_MS = 60_000;
export const POLL_MAX_MS = 15 * 60_000;
export const POLL_JITTER = 0.1;
/** The batch route's own cap (api-server routes/telegraphShare.ts MAX_SHARE_REFS). */
export const POLL_BATCH_MAX = 100;
/** How soon a foreground return polls, when the last answer is stale. */
export const POLL_RESUME_MS = 1_000;

export type RevocationListener = (next: ShareRevocation) => void;

export interface PollerDeps {
  resolve: (threadId: string, refs: ShareRef[]) => Promise<ShareResult<ResolveResponse>>;
  now: () => number;
  random: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Subscribe to foreground/background; returns the unsubscribe. */
  onAppState: (fn: (active: boolean) => void) => () => void;
  isActive: () => boolean;
}

interface ThreadPoll {
  /** refKey → its listeners. */
  cards: Map<string, { ref: ShareRef; listeners: Set<RevocationListener> }>;
  timer: unknown;
  delayMs: number;
  lastAnswerAt: number;
  inFlight: boolean;
}

const refKey = (r: ShareRef) => `${r.objectType}:${r.objectId}:${r.messageId ?? ''}`;

/** The answer for a ref, matched the way the server names it (messageId when the server echoes one). */
function answerFor(ref: ShareRef, projections: readonly ResolvedShare[]): ResolvedShare | null {
  const sameObject = projections.filter((p) => p.objectType === ref.objectType && p.objectId === ref.objectId);
  if (sameObject.length === 0) return null;
  return sameObject.find((p) => (p.messageId ?? null) === (ref.messageId ?? null)) ?? sameObject[0];
}

export function revocationFromResolved(r: ResolvedShare): ShareRevocation {
  return r.available
    ? { state: 'available', reason: null, resolved: r }
    : { state: 'unavailable', reason: r.reason, resolved: r };
}

export function createShareRevocationPoller(deps: PollerDeps) {
  const threads = new Map<string, ThreadPoll>();
  let unsubscribeAppState: (() => void) | null = null;

  function jittered(ms: number): number {
    const j = 1 + (deps.random() * 2 - 1) * POLL_JITTER;
    return Math.round(ms * j);
  }

  function schedule(threadId: string, t: ThreadPoll, ms: number): void {
    if (t.timer !== null) deps.clearTimer(t.timer);
    t.timer = deps.setTimer(() => {
      t.timer = null;
      void tick(threadId);
    }, ms);
  }

  async function tick(threadId: string): Promise<void> {
    const t = threads.get(threadId);
    if (!t || t.inFlight) return;
    if (!deps.isActive()) return; // resumed by the foreground listener
    const refs = [...t.cards.values()].map((c) => c.ref);
    if (refs.length === 0) return;
    t.inFlight = true;
    let ok = true;
    const answers: ResolvedShare[] = [];
    try {
      for (let i = 0; i < refs.length; i += POLL_BATCH_MAX) {
        const r = await deps.resolve(threadId, refs.slice(i, i + POLL_BATCH_MAX));
        if (!r.ok) { ok = false; break; }
        answers.push(...r.data.projections);
      }
    } catch {
      ok = false;
    }
    t.inFlight = false;
    if (threads.get(threadId) !== t) return; // every card left while asking: tell nobody, schedule nothing
    if (ok) {
      t.delayMs = POLL_BASE_MS;
      t.lastAnswerAt = deps.now();
      for (const card of t.cards.values()) {
        const a = answerFor(card.ref, answers);
        if (!a) continue; // unsupported / omitted: cannot tell, keep what the card has
        const next = revocationFromResolved(a);
        for (const l of [...card.listeners]) {
          try { l(next); } catch { /* one card's failure never silences another */ }
        }
      }
    } else {
      t.delayMs = Math.min(t.delayMs * 2, POLL_MAX_MS);
    }
    if (t.cards.size > 0) schedule(threadId, t, jittered(t.delayMs));
  }

  function onForeground(active: boolean): void {
    if (!active) return;
    for (const [threadId, t] of threads) {
      if (t.inFlight) continue;
      if (deps.now() - t.lastAnswerAt >= POLL_BASE_MS) schedule(threadId, t, POLL_RESUME_MS);
    }
  }

  /**
   * A mounted card listens for its source's state. Returns the unsubscribe;
   * the last card leaving a thread stops that thread's timer.
   */
  function subscribe(threadId: string, ref: ShareRef, listener: RevocationListener): () => void {
    let t = threads.get(threadId);
    if (!t) {
      t = { cards: new Map(), timer: null, delayMs: POLL_BASE_MS, lastAnswerAt: deps.now(), inFlight: false };
      threads.set(threadId, t);
      schedule(threadId, t, jittered(POLL_BASE_MS));
    }
    if (!unsubscribeAppState) unsubscribeAppState = deps.onAppState(onForeground);
    const key = refKey(ref);
    let card = t.cards.get(key);
    if (!card) {
      card = { ref: { objectType: ref.objectType, objectId: ref.objectId, messageId: ref.messageId ?? null }, listeners: new Set() };
      t.cards.set(key, card);
    }
    card.listeners.add(listener);
    const thread = t;
    const entry = card;
    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0) thread.cards.delete(key);
      if (thread.cards.size === 0 && threads.get(threadId) === thread) {
        if (thread.timer !== null) deps.clearTimer(thread.timer);
        thread.timer = null;
        threads.delete(threadId);
      }
      if (threads.size === 0 && unsubscribeAppState) {
        unsubscribeAppState();
        unsubscribeAppState = null;
      }
    };
  }

  return {
    subscribe,
    /** Test seam: the threads with a live poll, and how many cards each holds. */
    activeThreads(): Record<string, number> {
      return Object.fromEntries([...threads].map(([id, t]) => [id, t.cards.size]));
    },
  };
}

export type ShareRevocationPoller = ReturnType<typeof createShareRevocationPoller>;

/** The app's poller: the real batch route, the real clock and the real foreground state. */
export const shareRevocationPoller: ShareRevocationPoller = createShareRevocationPoller({
  resolve: (threadId, refs) => resolveShareProjections(threadId, refs),
  now: () => Date.now(),
  random: () => Math.random(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  onAppState: (fn) => {
    const sub = AppState.addEventListener('change', (s: AppStateStatus) => fn(s === 'active'));
    return () => sub.remove();
  },
  // Only a KNOWN background/inactive state pauses; an unknown one (no native AppState) polls.
  isActive: () => AppState.currentState !== 'background' && AppState.currentState !== 'inactive',
});
