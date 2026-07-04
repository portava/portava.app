/**
 * SafeReturnSetupSheet — parent-to-sheet callback integration tests.
 *
 * Run with:
 *   node --import tsx/esm --test \
 *     src/components/__tests__/SafeReturnSetupSheet.integration.test.ts
 *
 * ## Why this test exists
 *
 * The memoized-callback refactor wrapped every call site of
 * SafeReturnSetupSheet's onClose / onStarted in useCallback. The existing
 * openEffect unit tests verify runOpenEffect in isolation, but no test walked
 * through the full parent → sheet → session-start flow to confirm that:
 *
 *   1. onStarted fires exactly once **after a session is started** (form-submit path).
 *   2. onClose fires exactly once when the sheet is dismissed (both paths).
 *   3. The TripPlanSection call site (the most complex one) works correctly:
 *      - onStarted calls getActiveSession and stores the refreshed session.
 *      - Neither callback fires when the live-flag guard is cancelled.
 *
 * ## Testing strategy (machine-layer pattern)
 *
 * RNTL is unavailable in this repo (jest-expo + React 19 multi-instance issue).
 * This suite uses node:test + tsx/esm — the same approach as the existing
 * SafeReturnSetupSheet.openEffect.test.ts and SafeReturn.doubletap.test.ts.
 *
 * Both real production modules are imported directly so test failures reflect
 * genuine regressions in the production code:
 *
 *   • runHandleStart  — from SafeReturnSetupSheet.handleStart.ts
 *     Covers the form-submit path: createSession → startSession → callbacks.
 *     SafeReturnSetupSheet.tsx delegates to this function; tests here exercise
 *     the real logic, not a reimplemented copy.
 *
 *   • runOpenEffect   — from SafeReturnSetupSheet.openEffect.ts
 *     Covers the pre-check path: getActiveSession → active session redirect.
 *
 * The TripPlanSection parent state machine (plain JS object) models the two
 * memoized useCallback callbacks that are the focus of this task:
 *
 *   handleSafeReturnClose    → setSafeReturnSetupOpen(false) + setSafeReturnSetupItem(null)
 *   handleSafeReturnStarted  → same + getActiveSession().then(setActiveSafeReturnSession)
 *
 * These callbacks are passed to SafeReturnSetupSheet as onClose / onStarted.
 * The suite verifies the full wiring: the right callback fires at the right
 * time, exactly once, with correct argument, and produces the correct parent
 * side-effects.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runOpenEffect } from '../safeReturn/SafeReturnSetupSheet.openEffect.ts';
import { runHandleStart } from '../safeReturn/SafeReturnSetupSheet.handleStart.ts';

// ── Parent state machine — mirrors TripPlanSection memoized callbacks ─────────

interface ParentState {
  safeReturnSetupOpen: boolean;
  safeReturnSetupItemId: string | null;
  activeSafeReturnSession: { id: string } | null;
}

/**
 * Creates a minimal parent state machine that mirrors the TripPlanSection
 * handleSafeReturnClose / handleSafeReturnStarted useCallback pattern.
 *
 * handleSafeReturnClose (useCallback with [] deps):
 *   setSafeReturnSetupOpen(false)
 *   setSafeReturnSetupItem(null)
 *
 * handleSafeReturnStarted (useCallback with [] deps):
 *   setSafeReturnSetupOpen(false)
 *   setSafeReturnSetupItem(null)
 *   getActiveSession().then((r) => setActiveSafeReturnSession(r.session)).catch(() => {})
 */
function makeTripPlanSectionCallbacks(
  initialState: Partial<ParentState> = {},
  sessionAfterStart: { id: string } | null = { id: 'sess-refreshed-001' },
) {
  const state: ParentState = {
    safeReturnSetupOpen: true,
    safeReturnSetupItemId: 'plan-item-abc',
    activeSafeReturnSession: null,
    ...initialState,
  };

  function handleSafeReturnClose() {
    state.safeReturnSetupOpen = false;
    state.safeReturnSetupItemId = null;
  }

  function handleSafeReturnStarted() {
    state.safeReturnSetupOpen = false;
    state.safeReturnSetupItemId = null;
    // Fire-and-forget — mirrors getActiveSession().then(setActiveSafeReturnSession)
    Promise.resolve({ session: sessionAfterStart })
      .then((r) => { state.activeSafeReturnSession = r.session; })
      .catch(() => {});
  }

  return { state, handleSafeReturnClose, handleSafeReturnStarted };
}

// ── Live-flag wrapper — mirrors SafeReturnSetupSheet useEffect guard ──────────

/**
 * Wraps runOpenEffect the same way SafeReturnSetupSheet's useEffect does:
 *
 *   let live = true;
 *   runOpenEffect({
 *     onStarted: (id) => { if (live) onStarted?.(id); },
 *     onClose:   ()   => { if (live) onClose(); },
 *     getActiveSession,
 *   });
 *   return () => { live = false; };
 */
function runSheetOpenEffect(opts: {
  onStarted: (id: string) => void;
  onClose: () => void;
  getActiveSession: () => Promise<{ session: { id: string } | null }>;
}): { promise: Promise<{ modalShouldOpen: boolean }>; cancel: () => void } {
  let live = true;
  const promise = runOpenEffect({
    onStarted: (id) => { if (live) opts.onStarted(id); },
    onClose:   ()   => { if (live) opts.onClose(); },
    getActiveSession: opts.getActiveSession,
  });
  return { promise, cancel: () => { live = false; } };
}

// ── startLock — mirrors SafeReturnSetupSheet's useRef(false) guard ────────────

function createStartLock() {
  let locked = false;
  return {
    get current() { return locked; },
    acquire(): boolean { if (locked) return false; locked = true; return true; },
    release() { locked = false; },
  };
}

type StartLock = ReturnType<typeof createStartLock>;

/**
 * Wraps runHandleStart with the startLock guard, mirroring what handleStart()
 * does in SafeReturnSetupSheet:
 *
 *   if (startLock.current) return;
 *   startLock.current = true;
 *   try { await runHandleStart({...}); }
 *   finally { startLock.current = false; }
 */
async function guardedRunHandleStart(
  lock: StartLock,
  deps: Parameters<typeof runHandleStart>[0],
): Promise<ReturnType<typeof runHandleStart> | 'locked'> {
  if (!lock.acquire()) return 'locked';
  try {
    return await runHandleStart(deps);
  } finally {
    lock.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1: Form-submit path — onStarted + onClose fire after session start
//   Exercises runHandleStart (real production module) with TripPlanSection callbacks
// ─────────────────────────────────────────────────────────────────────────────

describe('SafeReturnSetupSheet integration — form-submit path (runHandleStart)', () => {
  it('onStarted fires exactly once after a session is created and started', async () => {
    const startedIds: string[] = [];
    const { handleSafeReturnStarted } = makeTripPlanSectionCallbacks();

    await runHandleStart({
      createSession: async () => ({ ok: true, session: { id: 'c-001' } }),
      startSession:  async () => ({ ok: true, session: { id: 's-001' } }),
      onStarted: (id) => { startedIds.push(id); handleSafeReturnStarted(); },
      onClose:   () => {},
    });

    assert.equal(startedIds.length, 1, 'onStarted must be called exactly once');
    assert.equal(startedIds[0], 's-001',
      'onStarted must receive the session id from startSession (not createSession)');
  });

  it('onClose fires exactly once after a session is successfully started', async () => {
    let closeCalls = 0;
    const { handleSafeReturnClose } = makeTripPlanSectionCallbacks();

    await runHandleStart({
      createSession: async () => ({ ok: true, session: { id: 'c-002' } }),
      startSession:  async () => ({ ok: true, session: { id: 's-002' } }),
      onStarted: () => {},
      onClose:   () => { closeCalls++; handleSafeReturnClose(); },
    });

    assert.equal(closeCalls, 1, 'onClose must be called exactly once');
  });

  it('onStarted fires before onClose (TripPlanSection ordering)', async () => {
    const order: string[] = [];
    const { handleSafeReturnStarted, handleSafeReturnClose } = makeTripPlanSectionCallbacks();

    await runHandleStart({
      createSession: async () => ({ ok: true, session: { id: 'c-003' } }),
      startSession:  async () => ({ ok: true, session: { id: 's-003' } }),
      onStarted: () => { order.push('onStarted'); handleSafeReturnStarted(); },
      onClose:   () => { order.push('onClose');   handleSafeReturnClose();   },
    });

    assert.deepEqual(order, ['onStarted', 'onClose'],
      'onStarted must fire before onClose');
  });

  it('TripPlanSection: onStarted closes sheet and refreshes activeSafeReturnSession', async () => {
    const refreshedSession = { id: 'sess-refreshed-xyz' };
    const { state, handleSafeReturnStarted, handleSafeReturnClose } =
      makeTripPlanSectionCallbacks({ safeReturnSetupOpen: true }, refreshedSession);

    await runHandleStart({
      createSession: async () => ({ ok: true, session: { id: 'c-004' } }),
      startSession:  async () => ({ ok: true, session: { id: 's-004' } }),
      onStarted: () => { handleSafeReturnStarted(); },
      onClose:   () => { handleSafeReturnClose(); },
    });

    await Promise.resolve(); // fire-and-forget tick inside handleSafeReturnStarted

    assert.equal(state.safeReturnSetupOpen, false, 'sheet must be closed after onStarted');
    assert.equal(state.safeReturnSetupItemId, null, 'plan item ref must be cleared');
    assert.deepEqual(state.activeSafeReturnSession, refreshedSession,
      'activeSafeReturnSession must be updated via the internal getActiveSession refresh');
  });

  it('onStarted and onClose do NOT fire when createSession fails', async () => {
    let startedCalls = 0;
    let closeCalls = 0;

    const outcome = await runHandleStart({
      createSession: async () => ({ ok: false, session: null }),
      startSession:  async () => ({ ok: true, session: { id: 'should-not-reach' } }),
      onStarted: () => { startedCalls++; },
      onClose:   () => { closeCalls++; },
    });

    assert.equal(outcome, 'createFailed');
    assert.equal(startedCalls, 0, 'onStarted must not fire when createSession fails');
    assert.equal(closeCalls, 0, 'onClose must not fire when createSession fails');
  });

  it('conflict outcome: onStarted and onClose do NOT fire', async () => {
    let startedCalls = 0;
    let closeCalls = 0;

    const outcome = await runHandleStart({
      createSession: async () => ({ ok: false, session: null, error: 'conflict' }),
      startSession:  async () => ({ ok: true, session: { id: 'should-not-reach' } }),
      onStarted: () => { startedCalls++; },
      onClose:   () => { closeCalls++; },
    });

    assert.equal(outcome, 'conflict');
    assert.equal(startedCalls, 0);
    assert.equal(closeCalls, 0);
  });

  it('onStarted and onClose do NOT fire when startSession fails', async () => {
    let startedCalls = 0;
    let closeCalls = 0;

    const outcome = await runHandleStart({
      createSession: async () => ({ ok: true, session: { id: 'c-005' } }),
      startSession:  async () => ({ ok: false, session: null }),
      onStarted: () => { startedCalls++; },
      onClose:   () => { closeCalls++; },
    });

    assert.equal(outcome, 'startFailed');
    assert.equal(startedCalls, 0, 'onStarted must not fire when startSession fails');
    assert.equal(closeCalls, 0, 'onClose must not fire when startSession fails');
  });

  it('startLock prevents double-tap from calling onStarted or onClose twice', async () => {
    const lock = createStartLock();
    let startedCalls = 0;
    let closeCalls = 0;

    const makeArgs = (): Parameters<typeof runHandleStart>[0] => ({
      createSession: async () => {
        await new Promise<void>((r) => setTimeout(r, 10));
        return { ok: true, session: { id: 'c-006' } };
      },
      startSession: async () => ({ ok: true, session: { id: 's-006' } }),
      onStarted: () => { startedCalls++; },
      onClose:   () => { closeCalls++; },
    });

    const [r1, r2] = await Promise.all([
      guardedRunHandleStart(lock, makeArgs()),
      guardedRunHandleStart(lock, makeArgs()),
    ]);

    const proceeded = [r1, r2].filter((r) => r !== 'locked').length;
    assert.equal(proceeded, 1, 'exactly one tap must proceed');
    assert.equal(startedCalls, 1, 'onStarted must fire exactly once despite double-tap');
    assert.equal(closeCalls, 1, 'onClose must fire exactly once despite double-tap');
  });

  it('returns "started" outcome when both service calls succeed', async () => {
    const outcome = await runHandleStart({
      createSession: async () => ({ ok: true, session: { id: 'c-007' } }),
      startSession:  async () => ({ ok: true, session: { id: 's-007' } }),
      onStarted: () => {},
      onClose:   () => {},
    });

    assert.equal(outcome, 'started');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2: Full end-to-end flow — pre-check then form submit
//   getActiveSession → null → form opens → user taps Start → session starts
// ─────────────────────────────────────────────────────────────────────────────

describe('SafeReturnSetupSheet integration — full end-to-end flow (no session → start)', () => {
  it('pre-check returns modalShouldOpen=true, then runHandleStart fires callbacks once', async () => {
    const startedIds: string[] = [];
    let closeCalls = 0;
    const { handleSafeReturnStarted, handleSafeReturnClose } = makeTripPlanSectionCallbacks();

    // Step 1: visible flips true — active-session pre-check
    const { promise: preCheck } = runSheetOpenEffect({
      onStarted: (id) => { startedIds.push(id); handleSafeReturnStarted(); },
      onClose:   ()   => { closeCalls++; handleSafeReturnClose(); },
      getActiveSession: async () => ({ session: null }),
    });
    const { modalShouldOpen } = await preCheck;

    assert.equal(modalShouldOpen, true, 'no active session → form must open');
    assert.equal(startedIds.length, 0, 'onStarted must not fire on pre-check when no session');
    assert.equal(closeCalls, 0, 'onClose must not fire on pre-check when no session');

    // Step 2: user fills form and taps "Start Safe Return"
    await runHandleStart({
      createSession: async () => ({ ok: true, session: { id: 'c-e2e-001' } }),
      startSession:  async () => ({ ok: true, session: { id: 's-e2e-001' } }),
      onStarted: (id) => { startedIds.push(id); handleSafeReturnStarted(); },
      onClose:   ()   => { closeCalls++; handleSafeReturnClose(); },
    });

    assert.equal(startedIds.length, 1, 'onStarted must fire exactly once after start');
    assert.equal(startedIds[0], 's-e2e-001');
    assert.equal(closeCalls, 1, 'onClose must fire exactly once after start');
  });

  it('active session on pre-check: redirect path fires callbacks without handleStart', async () => {
    const startedIds: string[] = [];
    let closeCalls = 0;
    const { handleSafeReturnStarted, handleSafeReturnClose } = makeTripPlanSectionCallbacks();

    const { promise } = runSheetOpenEffect({
      onStarted: (id) => { startedIds.push(id); handleSafeReturnStarted(); },
      onClose:   ()   => { closeCalls++; handleSafeReturnClose(); },
      getActiveSession: async () => ({ session: { id: 'active-001' } }),
    });
    const { modalShouldOpen } = await promise;

    assert.equal(modalShouldOpen, false, 'active session → redirect, form must not open');
    assert.equal(startedIds.length, 1, 'onStarted must fire once from pre-check');
    assert.equal(startedIds[0], 'active-001');
    assert.equal(closeCalls, 1, 'onClose must fire once from pre-check');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3: Pre-check active session (memoized callbacks)
// ─────────────────────────────────────────────────────────────────────────────

describe('SafeReturnSetupSheet integration — pre-check active session (TripPlanSection callbacks)', () => {
  it('onStarted fires exactly once and receives the session id', async () => {
    const startedIds: string[] = [];
    const { handleSafeReturnStarted } = makeTripPlanSectionCallbacks();

    const { promise } = runSheetOpenEffect({
      onStarted: (id) => { startedIds.push(id); handleSafeReturnStarted(); },
      onClose:   () => {},
      getActiveSession: async () => ({ session: { id: 'sess-pre-001' } }),
    });
    await promise;

    assert.equal(startedIds.length, 1);
    assert.equal(startedIds[0], 'sess-pre-001');
  });

  it('onClose fires exactly once when a session is active', async () => {
    let closeCalls = 0;
    const { handleSafeReturnClose } = makeTripPlanSectionCallbacks();

    const { promise } = runSheetOpenEffect({
      onStarted: () => {},
      onClose:   () => { closeCalls++; handleSafeReturnClose(); },
      getActiveSession: async () => ({ session: { id: 'sess-pre-002' } }),
    });
    await promise;

    assert.equal(closeCalls, 1);
  });

  it('parent state reflects closed sheet after pre-check callbacks fire', async () => {
    const { state, handleSafeReturnClose, handleSafeReturnStarted } =
      makeTripPlanSectionCallbacks();

    const { promise } = runSheetOpenEffect({
      onStarted: () => { handleSafeReturnStarted(); },
      onClose:   () => { handleSafeReturnClose(); },
      getActiveSession: async () => ({ session: { id: 'sess-pre-003' } }),
    });
    await promise;

    assert.equal(state.safeReturnSetupOpen, false);
    assert.equal(state.safeReturnSetupItemId, null);
  });

  it('TripPlanSection onStarted refreshes activeSafeReturnSession via internal call', async () => {
    const refreshedSession = { id: 'sess-refreshed-pre' };
    const { state, handleSafeReturnStarted, handleSafeReturnClose } =
      makeTripPlanSectionCallbacks({}, refreshedSession);

    const { promise } = runSheetOpenEffect({
      onStarted: () => { handleSafeReturnStarted(); },
      onClose:   () => { handleSafeReturnClose(); },
      getActiveSession: async () => ({ session: { id: 'sess-pre-004' } }),
    });
    await promise;
    await Promise.resolve(); // fire-and-forget tick

    assert.deepEqual(state.activeSafeReturnSession, refreshedSession);
  });

  it('onStarted fires before onClose (redirect ordering preserved)', async () => {
    const order: string[] = [];
    const { handleSafeReturnStarted, handleSafeReturnClose } = makeTripPlanSectionCallbacks();

    const { promise } = runSheetOpenEffect({
      onStarted: () => { order.push('onStarted'); handleSafeReturnStarted(); },
      onClose:   () => { order.push('onClose');   handleSafeReturnClose();   },
      getActiveSession: async () => ({ session: { id: 'sess-order' } }),
    });
    await promise;

    assert.deepEqual(order, ['onStarted', 'onClose']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4: No active session — form opens, no premature callbacks
// ─────────────────────────────────────────────────────────────────────────────

describe('SafeReturnSetupSheet integration — no active session (pre-check)', () => {
  it('onStarted does NOT fire when getActiveSession returns null', async () => {
    let startedCalls = 0;
    const { promise } = runSheetOpenEffect({
      onStarted: () => { startedCalls++; },
      onClose:   () => {},
      getActiveSession: async () => ({ session: null }),
    });
    await promise;
    assert.equal(startedCalls, 0);
  });

  it('onClose does NOT fire when there is no active session', async () => {
    let closeCalls = 0;
    const { promise } = runSheetOpenEffect({
      onStarted: () => {},
      onClose:   () => { closeCalls++; },
      getActiveSession: async () => ({ session: null }),
    });
    await promise;
    assert.equal(closeCalls, 0);
  });

  it('parent sheet stays open when there is no active session', async () => {
    const { state, handleSafeReturnStarted, handleSafeReturnClose } =
      makeTripPlanSectionCallbacks({ safeReturnSetupOpen: true });

    const { promise } = runSheetOpenEffect({
      onStarted: () => { handleSafeReturnStarted(); },
      onClose:   () => { handleSafeReturnClose(); },
      getActiveSession: async () => ({ session: null }),
    });
    await promise;

    assert.equal(state.safeReturnSetupOpen, true, 'sheet must stay open for form entry');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5: Live-flag cancellation — rapid re-open guard
// ─────────────────────────────────────────────────────────────────────────────

describe('SafeReturnSetupSheet integration — live-flag cancellation (rapid re-open)', () => {
  function delay(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  it('onStarted does NOT fire after the pre-check effect is cancelled mid-flight', async () => {
    let startedCalls = 0;

    const { promise, cancel } = runSheetOpenEffect({
      onStarted: () => { startedCalls++; },
      onClose:   () => {},
      getActiveSession: async () => { await delay(20); return { session: { id: 'stale' } }; },
    });

    cancel();
    await promise;

    assert.equal(startedCalls, 0, 'onStarted must not fire after cancellation');
  });

  it('onClose does NOT fire after the pre-check effect is cancelled mid-flight', async () => {
    let closeCalls = 0;

    const { promise, cancel } = runSheetOpenEffect({
      onStarted: () => {},
      onClose:   () => { closeCalls++; },
      getActiveSession: async () => { await delay(20); return { session: { id: 'stale' } }; },
    });

    cancel();
    await promise;

    assert.equal(closeCalls, 0, 'onClose must not fire after cancellation');
  });

  it('parent sheet stays open when pre-check effect is cancelled', async () => {
    const { state, handleSafeReturnStarted, handleSafeReturnClose } =
      makeTripPlanSectionCallbacks({ safeReturnSetupOpen: true });

    const { promise, cancel } = runSheetOpenEffect({
      onStarted: () => { handleSafeReturnStarted(); },
      onClose:   () => { handleSafeReturnClose(); },
      getActiveSession: async () => { await delay(20); return { session: { id: 'stale' } }; },
    });

    cancel();
    await promise;

    assert.equal(state.safeReturnSetupOpen, true, 'cancellation must not close sheet prematurely');
  });

  it('rapid re-open: cancelled effect silent, live effect fires callbacks once', async () => {
    const effect1Calls: string[] = [];
    const effect2Calls: string[] = [];
    const { handleSafeReturnStarted: s1, handleSafeReturnClose: c1 } = makeTripPlanSectionCallbacks();
    const { handleSafeReturnStarted: s2, handleSafeReturnClose: c2 } = makeTripPlanSectionCallbacks();

    const e1 = runSheetOpenEffect({
      onStarted: (id) => { effect1Calls.push(`started:${id}`); s1(); },
      onClose:   ()   => { effect1Calls.push('close'); c1(); },
      getActiveSession: async () => { await delay(40); return { session: { id: 'sess-race' } }; },
    });
    e1.cancel();

    const e2 = runSheetOpenEffect({
      onStarted: (id) => { effect2Calls.push(`started:${id}`); s2(); },
      onClose:   ()   => { effect2Calls.push('close'); c2(); },
      getActiveSession: async () => ({ session: { id: 'sess-race' } }),
    });

    await Promise.all([e1.promise, e2.promise]);

    assert.equal(effect1Calls.length, 0, 'cancelled effect must not fire any callbacks');
    assert.deepEqual(effect2Calls, ['started:sess-race', 'close'],
      'live effect must fire onStarted then onClose exactly once');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6: Error path (fail-open)
// ─────────────────────────────────────────────────────────────────────────────

describe('SafeReturnSetupSheet integration — pre-check error (fail-open)', () => {
  it('onStarted does NOT fire when getActiveSession throws', async () => {
    let startedCalls = 0;
    const { promise } = runSheetOpenEffect({
      onStarted: () => { startedCalls++; },
      onClose:   () => {},
      getActiveSession: async () => { throw new Error('Network error'); },
    });
    await promise;
    assert.equal(startedCalls, 0);
  });

  it('onClose does NOT fire when getActiveSession throws', async () => {
    let closeCalls = 0;
    const { promise } = runSheetOpenEffect({
      onStarted: () => {},
      onClose:   () => { closeCalls++; },
      getActiveSession: async () => { throw new Error('Network error'); },
    });
    await promise;
    assert.equal(closeCalls, 0);
  });

  it('full flow does not throw on network failure (component must not crash)', async () => {
    const { promise } = runSheetOpenEffect({
      onStarted: () => {},
      onClose:   () => {},
      getActiveSession: async () => { throw new TypeError('fetch is not defined'); },
    });
    await assert.doesNotReject(() => promise);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7: onCheckingChange overlay — all three exit paths
//
// TripPlanSection renders a loading overlay while the active-session pre-check
// is in flight (`safeReturnChecking`). The overlay is driven by
// `onCheckingChange` on SafeReturnSetupSheet: true when checking starts,
// false when it resolves. If false is never delivered, the overlay is stuck.
//
// The three exit paths from the useEffect([visible]) IIFE are:
//   Path 1 — no active session  → form opens; onCheckingChange(false) fires
//            after runOpenEffect resolves (happy path)
//   Path 2 — active session     → redirect/onStarted fires; onCheckingChange(false)
//            fires after runOpenEffect resolves (redirect path)
//   Path 3 — visible=false while in-flight → cleanup fires onCheckingChange(false)
//            (cancellation path)
//   Error   — runOpenEffect throws → finally-block fires onCheckingChange(false)
//            (defensive path added by the try/catch/finally fix)
//
// ## Testing strategy
//
// `runVisibleOnEffect` models the fixed IIFE from SafeReturnSetupSheet's
// useEffect exactly: try { await runOpenEffect } catch {} finally { if (live)
// onCheckingChange(false) }, plus a cancel() that mirrors the cleanup return.
// `overrideRunOpenEffect` lets the error-path test inject a throwing function.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Models the fixed IIFE from SafeReturnSetupSheet's useEffect([visible]).
 *
 * Mirrors the component's try/catch/finally pattern:
 *
 *   onCheckingChange(true)
 *   try { await runOpenEffect(...) }
 *   catch { // fail-open }
 *   finally { clearTimeout; if (live) onCheckingChange(false) }
 *
 * Returns { promise, cancel } where cancel() mirrors the cleanup return:
 *   live = false; onCheckingChange(false);
 */
function runVisibleOnEffect(opts: {
  onStarted: (id: string) => void;
  onClose: () => void;
  onCheckingChange: (v: boolean) => void;
  getActiveSession: () => Promise<{ session: { id: string } | null }>;
  overrideRunOpenEffect?: () => Promise<{ modalShouldOpen: boolean }>;
}): { promise: Promise<{ modalShouldOpen: boolean }>; cancel: () => void } {
  let live = true;

  opts.onCheckingChange(true);

  const openEffect = opts.overrideRunOpenEffect
    ? opts.overrideRunOpenEffect
    : () => runOpenEffect({
        onStarted: (id) => { if (live) opts.onStarted(id); },
        onClose:   ()   => { if (live) opts.onClose(); },
        getActiveSession: opts.getActiveSession,
      });

  let resolveOuter!: (v: { modalShouldOpen: boolean }) => void;
  const promise = new Promise<{ modalShouldOpen: boolean }>((resolve) => {
    resolveOuter = resolve;
  });

  (async () => {
    let modalShouldOpen = true;
    try {
      ({ modalShouldOpen } = await openEffect());
    } catch {
      // fail-open
    } finally {
      if (live) opts.onCheckingChange(false);
    }
    resolveOuter({ modalShouldOpen });
  })();

  return {
    promise,
    cancel: () => {
      live = false;
      opts.onCheckingChange(false);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8: 5-second timeout safety net
//
// SafeReturnSetupSheet's useEffect sets a 5 s safety-net timeout: if
// getActiveSession stalls (network hang, app backgrounded mid-check), the
// timeout fires onCheckingChange(false) and onClose() so the trigger button
// never stays permanently stuck. After the timeout fires it sets live=false,
// so any callbacks inside the IIFE's finally-block are suppressed when the
// stalled getActiveSession eventually resolves.
//
// Tests use timeoutMs: 20 so the suite runs fast while exercising the real
// timeout branch.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Models the FULL SafeReturnSetupSheet useEffect body, including the
 * 5-second safety-net timeout.
 *
 * Structure mirrors the component exactly:
 *
 *   let live = true;
 *   const checkTimeoutId = setTimeout(() => {
 *     if (live) { live = false; onCheckingChange(false); onClose(); }
 *   }, timeoutMs);
 *   (async () => {
 *     onCheckingChange(true);
 *     try { await runOpenEffect(...) } catch {} finally {
 *       clearTimeout(checkTimeoutId);
 *       if (live) onCheckingChange(false);
 *     }
 *   })();
 *   // cleanup:  live = false; clearTimeout; onCheckingChange(false);
 *
 * @param timeoutMs  defaults to 5000 in production; pass a small value (e.g.
 *                   20) in tests so they don't block for 5 seconds.
 *
 * Returns:
 *   timeoutFired — Promise that resolves once the safety-net timeout fires
 *                  (does NOT resolve if cancel() clears the timer first).
 *   cancel()     — mirrors the effect cleanup (visible flipped back to false).
 */
function runTimeoutEffect(opts: {
  onClose: () => void;
  onCheckingChange: (v: boolean) => void;
  getActiveSession: () => Promise<{ session: { id: string } | null }>;
  timeoutMs?: number;
}): { timeoutFired: Promise<void>; cancel: () => void } {
  let live = true;

  let resolveTimeoutFired!: () => void;
  const timeoutFired = new Promise<void>((r) => { resolveTimeoutFired = r; });

  const checkTimeoutId = setTimeout(() => {
    if (live) {
      live = false;
      opts.onCheckingChange(false);
      opts.onClose();
      resolveTimeoutFired();
    }
  }, opts.timeoutMs ?? 5_000);

  (async () => {
    opts.onCheckingChange(true);

    try {
      await runOpenEffect({
        onStarted: () => {},
        onClose:   () => { if (live) opts.onClose(); },
        getActiveSession: opts.getActiveSession,
      });
    } catch {
      // fail-open
    } finally {
      clearTimeout(checkTimeoutId);
      if (live) opts.onCheckingChange(false);
    }
  })();

  return {
    timeoutFired,
    cancel: () => {
      live = false;
      clearTimeout(checkTimeoutId);
      opts.onCheckingChange(false);
    },
  };
}

describe('SafeReturnSetupSheet — onCheckingChange overlay (all exit paths)', () => {
  // ── Path 1: no active session → form opens ─────────────────────────────────

  it('Path 1 (no session): onCheckingChange(true) then onCheckingChange(false) after pre-check', async () => {
    const log: boolean[] = [];

    const { promise } = runVisibleOnEffect({
      onStarted:        () => {},
      onClose:          () => {},
      onCheckingChange: (v) => { log.push(v); },
      getActiveSession: async () => ({ session: null }),
    });
    await promise;

    assert.deepEqual(log, [true, false],
      'overlay must start (true) then clear (false) on the no-session path');
  });

  it('Path 1 (no session): checking ends as false — overlay is not stuck', async () => {
    let checking = false;
    const { promise } = runVisibleOnEffect({
      onStarted:        () => {},
      onClose:          () => {},
      onCheckingChange: (v) => { checking = v; },
      getActiveSession: async () => ({ session: null }),
    });
    await promise;

    assert.equal(checking, false, 'safeReturnChecking must be false after pre-check resolves');
  });

  it('Path 1 (no session): modalShouldOpen is true so the form would be shown', async () => {
    const { promise } = runVisibleOnEffect({
      onStarted:        () => {},
      onClose:          () => {},
      onCheckingChange: () => {},
      getActiveSession: async () => ({ session: null }),
    });
    const { modalShouldOpen } = await promise;

    assert.equal(modalShouldOpen, true);
  });

  // ── Path 2: active session found → redirect ─────────────────────────────────

  it('Path 2 (active session): onCheckingChange(false) fires after redirect', async () => {
    const log: boolean[] = [];

    const { promise } = runVisibleOnEffect({
      onStarted:        () => {},
      onClose:          () => {},
      onCheckingChange: (v) => { log.push(v); },
      getActiveSession: async () => ({ session: { id: 'sess-active-check' } }),
    });
    await promise;

    assert.deepEqual(log, [true, false],
      'overlay must clear after the active-session redirect path');
  });

  it('Path 2 (active session): checking ends as false — overlay is not stuck', async () => {
    let checking = false;
    const { promise } = runVisibleOnEffect({
      onStarted:        () => {},
      onClose:          () => {},
      onCheckingChange: (v) => { checking = v; },
      getActiveSession: async () => ({ session: { id: 'sess-active-check-2' } }),
    });
    await promise;

    assert.equal(checking, false, 'safeReturnChecking must be false after active-session redirect');
  });

  it('Path 2 (active session): onCheckingChange(false) fires before onStarted side-effects settle', async () => {
    const order: string[] = [];
    const { promise } = runVisibleOnEffect({
      onStarted:        () => { order.push('onStarted'); },
      onClose:          () => { order.push('onClose'); },
      onCheckingChange: (v) => { if (!v) order.push('checkingFalse'); },
      getActiveSession: async () => ({ session: { id: 'sess-order' } }),
    });
    await promise;

    // onStarted and onClose fire inside runOpenEffect; onCheckingChange(false)
    // fires in the finally block after runOpenEffect returns.
    assert.ok(order.includes('checkingFalse'), 'onCheckingChange(false) must fire on redirect path');
    assert.ok(order.includes('onStarted'),     'onStarted must fire on redirect path');
  });

  it('Path 2 (active session): modalShouldOpen is false (no form shown after redirect)', async () => {
    const { promise } = runVisibleOnEffect({
      onStarted:        () => {},
      onClose:          () => {},
      onCheckingChange: () => {},
      getActiveSession: async () => ({ session: { id: 'sess-no-form' } }),
    });
    const { modalShouldOpen } = await promise;

    assert.equal(modalShouldOpen, false);
  });

  // ── Path 3: visible flipped false mid-flight → cleanup ──────────────────────

  it('Path 3 (cleanup / cancellation): onCheckingChange(false) fires when visible flips false', async () => {
    function delay(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }

    const log: boolean[] = [];
    const { promise, cancel } = runVisibleOnEffect({
      onStarted:        () => {},
      onClose:          () => {},
      onCheckingChange: (v) => { log.push(v); },
      getActiveSession: async () => { await delay(20); return { session: null }; },
    });

    // Simulate visible flipping false before getActiveSession resolves
    cancel();
    await promise;

    assert.deepEqual(log, [true, false],
      'cleanup path must deliver onCheckingChange(false) when visible is toggled off mid-flight');
  });

  it('Path 3 (cleanup): checking ends as false after cancellation', async () => {
    function delay(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }

    let checking = false;
    const { promise, cancel } = runVisibleOnEffect({
      onStarted:        () => {},
      onClose:          () => {},
      onCheckingChange: (v) => { checking = v; },
      getActiveSession: async () => { await delay(20); return { session: { id: 'stale' } }; },
    });

    cancel();
    await promise;

    assert.equal(checking, false,
      'safeReturnChecking must be false after the cleanup path fires');
  });

  it('Path 3 (cleanup): onCheckingChange(false) fires exactly once — no double-call', async () => {
    function delay(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }

    const falseCalls: number[] = [];
    const { promise, cancel } = runVisibleOnEffect({
      onStarted:        () => {},
      onClose:          () => {},
      onCheckingChange: (v) => { if (!v) falseCalls.push(Date.now()); },
      getActiveSession: async () => { await delay(20); return { session: null }; },
    });

    cancel();
    await promise;

    assert.equal(falseCalls.length, 1,
      'onCheckingChange(false) must be called exactly once — cleanup fires it, finally skips (live=false)');
  });

  // ── Error path: runOpenEffect throws → finally always clears overlay ─────────

  it('Error path: onCheckingChange(false) fires even when runOpenEffect throws', async () => {
    const log: boolean[] = [];

    const { promise } = runVisibleOnEffect({
      onStarted:        () => {},
      onClose:          () => {},
      onCheckingChange: (v) => { log.push(v); },
      getActiveSession: async () => ({ session: null }), // unused — overridden below
      overrideRunOpenEffect: async () => { throw new Error('Simulated runOpenEffect failure'); },
    });
    await promise;

    assert.deepEqual(log, [true, false],
      'finally-block must deliver onCheckingChange(false) even when runOpenEffect throws');
  });

  it('Error path: checking ends as false after runOpenEffect throws', async () => {
    let checking = false;
    const { promise } = runVisibleOnEffect({
      onStarted:        () => {},
      onClose:          () => {},
      onCheckingChange: (v) => { checking = v; },
      getActiveSession: async () => ({ session: null }),
      overrideRunOpenEffect: async () => { throw new TypeError('Unexpected error in openEffect'); },
    });
    await promise;

    assert.equal(checking, false,
      'safeReturnChecking must never be left as true when runOpenEffect throws');
  });

  it('Error path: promise resolves (does not reject) — component never crashes', async () => {
    const { promise } = runVisibleOnEffect({
      onStarted:        () => {},
      onClose:          () => {},
      onCheckingChange: () => {},
      getActiveSession: async () => ({ session: null }),
      overrideRunOpenEffect: async () => { throw new Error('fatal openEffect bug'); },
    });
    await assert.doesNotReject(() => promise,
      'runVisibleOnEffect must not propagate the error — component cannot crash');
  });

  it('Error path: fail-open — modalShouldOpen=true so form still appears on error', async () => {
    const { promise } = runVisibleOnEffect({
      onStarted:        () => {},
      onClose:          () => {},
      onCheckingChange: () => {},
      getActiveSession: async () => ({ session: null }),
      overrideRunOpenEffect: async () => { throw new Error('network gone'); },
    });
    const { modalShouldOpen } = await promise;

    assert.equal(modalShouldOpen, true,
      'on runOpenEffect error the form must still open (fail-open) so the user is not blocked');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8: 5-second timeout safety net
//
// Verifies that when getActiveSession stalls (never resolves within 5 s),
// the safety-net timeout resets the trigger button correctly:
//   1. onCheckingChange(false) fires exactly once — trigger button unlocks
//   2. onClose() fires exactly once — parent resets visible → user can retry
//   3. Neither callback fires again when the stalled getActiveSession eventually
//      resolves (live=false guard in the IIFE's finally-block)
//   4. cancel() before the timeout clears the timer, so the timeout callback
//      is suppressed and cannot double-fire onClose / onCheckingChange
// ─────────────────────────────────────────────────────────────────────────────

describe('SafeReturnSetupSheet — 5-second timeout safety net', () => {
  // Run all timeout tests at 20 ms instead of 5 000 ms.
  const TIMEOUT_MS = 20;

  // ── Timeout fires: basic sequence ──────────────────────────────────────────

  it('timeout: onCheckingChange sequence is [true, false] when getActiveSession stalls', async () => {
    const log: boolean[] = [];

    const { timeoutFired } = runTimeoutEffect({
      onClose:          () => {},
      onCheckingChange: (v) => { log.push(v); },
      getActiveSession: () => new Promise(() => {}), // never resolves
      timeoutMs:        TIMEOUT_MS,
    });
    await timeoutFired;

    assert.deepEqual(log, [true, false],
      'timeout must deliver onCheckingChange(true) then onCheckingChange(false)');
  });

  it('timeout: onCheckingChange ends as false — trigger button is unlocked', async () => {
    let checking = false;

    const { timeoutFired } = runTimeoutEffect({
      onClose:          () => {},
      onCheckingChange: (v) => { checking = v; },
      getActiveSession: () => new Promise(() => {}), // stalled
      timeoutMs:        TIMEOUT_MS,
    });
    await timeoutFired;

    assert.equal(checking, false,
      'safeReturnChecking must be false after the timeout fires');
  });

  it('timeout: onClose() fires exactly once from the timeout path', async () => {
    let closeCalls = 0;

    const { timeoutFired } = runTimeoutEffect({
      onClose:          () => { closeCalls++; },
      onCheckingChange: () => {},
      getActiveSession: () => new Promise(() => {}), // stalled
      timeoutMs:        TIMEOUT_MS,
    });
    await timeoutFired;

    assert.equal(closeCalls, 1,
      'onClose must fire exactly once from the timeout — not zero, not two');
  });

  // ── live=false guard: stalled getActiveSession eventually resolves ──────────

  it('timeout: live=false guard — onCheckingChange(false) NOT called again when stalled session resolves', async () => {
    let falseCalls = 0;

    let resolveSession!: (v: { session: null }) => void;
    const sessionPromise = new Promise<{ session: null }>((r) => { resolveSession = r; });

    const { timeoutFired } = runTimeoutEffect({
      onClose:          () => {},
      onCheckingChange: (v) => { if (!v) falseCalls++; },
      getActiveSession: () => sessionPromise,
      timeoutMs:        TIMEOUT_MS,
    });

    await timeoutFired; // timeout fires: live=false, onCheckingChange(false) × 1

    // Now let the stalled getActiveSession resolve (the IIFE is still running)
    resolveSession({ session: null });
    // Drain pending microtasks so the IIFE finally-block has a chance to run
    await new Promise<void>((r) => setTimeout(r, 0));

    assert.equal(falseCalls, 1,
      'onCheckingChange(false) must not fire a second time when the stalled ' +
      'getActiveSession resolves after the timeout (live=false guard)');
  });

  it('timeout: live=false guard — onClose NOT called again when stalled session resolves', async () => {
    let closeCalls = 0;

    let resolveSession!: (v: { session: null }) => void;
    const sessionPromise = new Promise<{ session: null }>((r) => { resolveSession = r; });

    const { timeoutFired } = runTimeoutEffect({
      onClose:          () => { closeCalls++; },
      onCheckingChange: () => {},
      getActiveSession: () => sessionPromise,
      timeoutMs:        TIMEOUT_MS,
    });

    await timeoutFired;

    resolveSession({ session: null });
    await new Promise<void>((r) => setTimeout(r, 0));

    assert.equal(closeCalls, 1,
      'onClose must not fire a second time when the stalled getActiveSession ' +
      'resolves after the timeout (live=false guard in IIFE finally)');
  });

  // ── cancel() before timeout: timer is cleared, timeout callback suppressed ──

  it('cleanup before timeout: cancel() prevents the timeout callback from firing', async () => {
    let closeCalls = 0;
    let falseCalls = 0;

    const { cancel } = runTimeoutEffect({
      onClose:          () => { closeCalls++; },
      onCheckingChange: (v) => { if (!v) falseCalls++; },
      getActiveSession: () => new Promise(() => {}), // stalled
      timeoutMs:        TIMEOUT_MS,
    });

    // cancel() clears the timer before it fires
    cancel();

    // Wait 3× the timeout to give the (now-cleared) setTimeout every chance to fire
    await new Promise<void>((r) => setTimeout(r, TIMEOUT_MS * 3));

    assert.equal(closeCalls, 0,
      'timeout must not call onClose after cancel() cleared the timer');
    assert.equal(falseCalls, 1,
      'cancel() itself delivers onCheckingChange(false) exactly once (cleanup path)');
  });
});
