/**
 * webHistoryHarness — a `window` + `window.history` test double that behaves
 * like the browser on the two points the Discovery back-nav guards depend on.
 *
 * WHY THIS EXISTS
 * ===============
 * The stub it replaces documented its own blind spot:
 *
 *   > the event-emitter stub ignores the capture/bubble argument (third arg)
 *   > since there is no second listener competing in tests
 *
 * and its `history` never mutated `state`, so the cleanup branch
 * `if (w.history.state?._discoverySheet)` was permanently falsy. Between them,
 * BOTH mechanisms of the task-3657 fix — capture-phase registration and the
 * `dismissedByBack` flag — were invisible to the test. It passed before the fix
 * and passes with the fix reverted, so it could not have caught the regression
 * it is named after, and cannot catch the next one.
 *
 * A guard that cannot fail is not a guard. This double can fail.
 *
 * WHAT IT MODELS, AND HOW FAITHFULLY
 * ==================================
 * `popstate` is dispatched AT `window`, so window is the whole event path. Per
 * the DOM standard's dispatch algorithm the target struct is invoked twice —
 * once with phase "capturing", once with phase "bubbling" — and `inner invoke`
 * skips capture listeners on the bubbling pass and non-capture listeners on the
 * capturing pass. So capture listeners on the target DO run before non-capture
 * listeners on the same target, even though `eventPhase` reports AT_TARGET for
 * both. That ordering is the entire premise of the fix, and it is what this
 * harness reproduces:
 *
 *   1. capture-phase listeners, in registration order
 *   2. then bubble-phase listeners, in registration order
 *   3. `stopImmediatePropagation()` halts immediately
 *   4. `stopPropagation()` during capture suppresses the bubble pass
 *
 * `history` keeps a real entry stack: `pushState` truncates forward entries and
 * pushes, `back()` decrements and dispatches `popstate`, and `state` reflects the
 * current entry. `back()` dispatches synchronously, which a real browser does
 * not — the browser queues it. That difference is deliberate and safe here: the
 * guards remove their listener before their cleanup calls `back()`, so nothing
 * re-enters, and synchronous dispatch makes a double-`back()` observable in the
 * same tick instead of vanishing.
 *
 * WHAT IT DOES NOT MODEL — read before writing a test against it
 * =============================================================
 * It does not stand in for the app's real popstate competitor.
 * `@react-navigation/native`'s `createMemoryHistory` (`:206`, `:228`) registers
 * a bubble-phase popstate listener at app-init time, before any component
 * effect — that much of the fix's premise is confirmed — but it calls neither
 * `stopPropagation` nor `stopImmediatePropagation`. So a test that registers a
 * propagation-stopping competitor is exercising the HAZARD THE CAPTURE FLAG
 * EXISTS TO DEFEAT, not replaying the field failure. Say that in the test rather
 * than letting it read as a reproduction.
 */

export interface Listener {
  cb: (ev: PopStateEventLike) => void;
  capture: boolean;
}

export interface PopStateEventLike {
  type: string;
  state: unknown;
  stopPropagation(): void;
  stopImmediatePropagation(): void;
}

export interface WebHistoryHarness {
  /** Listeners currently attached, by event type, in registration order. */
  listeners: Map<string, Listener[]>;
  /** How many times `history.back()` was invoked. */
  backCalls(): number;
  /** Depth of the history entry stack (a real browser's `history.length`). */
  depth(): number;
  /** Index of the current entry. */
  index(): number;
  /** Register a competing listener, as an app-init subscriber would. */
  addCompetitor(
    type: string,
    cb: (ev: PopStateEventLike) => void,
    capture?: boolean,
  ): void;
  /** Press the browser's Back button. */
  pressBack(): void;
  /** Order in which listeners fired during the last dispatch, by label. */
  fireOrder: string[];
  /** Restore whatever was on `window` before install. */
  restore(): void;
}

interface Entry {
  state: unknown;
  url: string;
}

/**
 * Install the harness on the global `window`. Call in `beforeEach`; the returned
 * `restore()` puts back the previous descriptors.
 */
export function installWebHistoryHarness(
  initialUrl = 'http://localhost/',
): WebHistoryHarness {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  const saved = {
    addEventListener: w.addEventListener,
    removeEventListener: w.removeEventListener,
    dispatchEvent: w.dispatchEvent,
    history: w.history,
    location: w.location,
  };

  const listeners = new Map<string, Listener[]>();
  const entries: Entry[] = [{ state: null, url: initialUrl }];
  let index = 0;
  let backCalls = 0;
  const fireOrder: string[] = [];

  function dispatch(type: string, state: unknown): void {
    fireOrder.length = 0;
    const attached = [...(listeners.get(type) ?? [])];
    let stopImmediate = false;
    let stopBubble = false;

    const ev: PopStateEventLike = {
      type,
      state,
      stopPropagation() { stopBubble = true; },
      stopImmediatePropagation() { stopBubble = true; stopImmediate = true; },
    };

    // Pass 1 — capture listeners, registration order.
    for (const l of attached) {
      if (!l.capture) continue;
      if (stopImmediate) break;
      fireOrder.push('capture');
      l.cb(ev);
    }
    // Pass 2 — bubble listeners, registration order. Skipped entirely if a
    // capture listener called stopPropagation().
    if (!stopImmediate && !stopBubble) {
      for (const l of attached) {
        if (l.capture) continue;
        if (stopImmediate) break;
        fireOrder.push('bubble');
        l.cb(ev);
      }
    }
  }

  w.addEventListener = (type: string, cb: Listener['cb'], capture?: boolean | { capture?: boolean }) => {
    const isCapture = typeof capture === 'object' ? Boolean(capture?.capture) : Boolean(capture);
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type)!.push({ cb, capture: isCapture });
  };

  w.removeEventListener = (type: string, cb: Listener['cb'], capture?: boolean | { capture?: boolean }) => {
    const isCapture = typeof capture === 'object' ? Boolean(capture?.capture) : Boolean(capture);
    const arr = listeners.get(type);
    if (!arr) return;
    // The DOM matches on (type, callback, capture) — a listener added with
    // capture and removed without it is NOT removed. Modelled, because getting
    // that pair out of sync is exactly the kind of silent leak this file exists
    // to make visible.
    const i = arr.findIndex((l) => l.cb === cb && l.capture === isCapture);
    if (i >= 0) arr.splice(i, 1);
  };

  w.dispatchEvent = (event: { type: string }) => {
    dispatch(event.type, entries[index]?.state ?? null);
    return true;
  };

  w.history = {
    pushState(state: unknown, _title: string, url?: string) {
      entries.splice(index + 1);
      entries.push({ state, url: url ?? entries[index]!.url });
      index = entries.length - 1;
    },
    replaceState(state: unknown, _title: string, url?: string) {
      entries[index] = { state, url: url ?? entries[index]!.url };
    },
    back() {
      backCalls += 1;
      if (index === 0) return; // a real browser leaves the document
      index -= 1;
      dispatch('popstate', entries[index]!.state);
    },
    get state() { return entries[index]?.state ?? null; },
    get length() { return entries.length; },
  };

  w.location = {
    get href() { return entries[index]?.url ?? initialUrl; },
  };

  return {
    listeners,
    backCalls: () => backCalls,
    depth: () => entries.length,
    index: () => index,
    addCompetitor(type, cb, capture = false) {
      w.addEventListener(type, cb, capture);
    },
    pressBack() {
      // The browser's own Back: pop the entry, then fire popstate. It does NOT
      // route through history.back(), so it must not count toward backCalls —
      // that counter exists to catch the guard calling back() a second time.
      if (index === 0) return;
      index -= 1;
      dispatch('popstate', entries[index]!.state);
    },
    fireOrder,
    restore() {
      w.addEventListener = saved.addEventListener;
      w.removeEventListener = saved.removeEventListener;
      w.dispatchEvent = saved.dispatchEvent;
      w.history = saved.history;
      w.location = saved.location;
    },
  };
}
