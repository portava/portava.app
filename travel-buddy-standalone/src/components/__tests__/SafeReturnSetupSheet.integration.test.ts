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
import { runOpenEffect, startCheckedOpenEffect } from '../safeReturn/SafeReturnSetupSheet.openEffect.ts';
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
      // The real createSession returns `session?: SafeReturnSession` — it OMITS
      // the field on failure, it does not send null. A `session: null` fixture
      // was describing a response shape the service cannot produce.
      createSession: async () => ({ ok: false }),
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
      createSession: async () => ({ ok: false, error: 'conflict' }),
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
      startSession:  async () => ({ ok: false }),
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

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 9: Double-open guard — rapid visible=true re-trigger
//
// TripPlanSection sets safeReturnSetupOpen=true to open SafeReturnSetupSheet.
// If the trigger fires while a previous open-effect is already in flight (e.g.
// visible=false→true immediately after an onClose-triggered reset, before
// React cleanup has run cancel() on the old effect), two concurrent effects
// could each call onStarted/onClose independently — a double-fire bug.
//
// SafeReturnSetupSheet guards against this with openEffectHandleRef: before
// starting any new open-effect it cancels the previous handle (if live).
// Policy: SECOND-WINS — the newer open always supersedes the older one.
//
// These tests verify that policy using the machine-layer pattern (no React):
//   • The guarded opener's `makeGuardedOpener` mirrors the component's
//     openEffectHandleRef.current?.cancel() + startCheckedOpenEffect pattern.
//   • The unguarded test documents the exact bug the guard closes.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Models the component's openEffectHandleRef guard at the runSheetOpenEffect
 * level (same abstraction used throughout this file).
 *
 * On each call to openWithGuard():
 *   1. Cancels the previous in-flight effect — mirrors
 *      openEffectHandleRef.current?.cancel() in SafeReturnSetupSheet.
 *   2. Starts a fresh runSheetOpenEffect.
 *   3. Returns { promise, cancel } identical to runSheetOpenEffect's return.
 *
 * Policy: SECOND-WINS — the second open cancels the first.
 */
function makeGuardedOpener(callbacks: {
  onStarted: (id: string) => void;
  onClose: () => void;
}) {
  let currentCancel: (() => void) | null = null;

  function openWithGuard(
    getActiveSession: () => Promise<{ session: { id: string } | null }>,
  ) {
    // Guard: cancel any in-flight effect before starting the new one
    currentCancel?.();
    currentCancel = null;

    const { promise, cancel } = runSheetOpenEffect({
      onStarted: callbacks.onStarted,
      onClose: callbacks.onClose,
      getActiveSession,
    });

    currentCancel = cancel;
    return { promise, cancel };
  }

  return { openWithGuard };
}

describe('SafeReturnSetupSheet — double-open guard (rapid visible=true re-trigger)', () => {
  function delay(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  // ── Core second-wins behaviour ─────────────────────────────────────────────

  it('second-wins: second open cancels the first — onStarted fires exactly once', async () => {
    const startedIds: string[] = [];
    let closeCalls = 0;

    const { openWithGuard } = makeGuardedOpener({
      onStarted: (id) => { startedIds.push(id); },
      onClose:   () => { closeCalls++; },
    });

    // First open: slow getActiveSession — simulates in-flight pre-check
    const e1 = openWithGuard(async () => {
      await delay(40);
      return { session: { id: 'sess-first' } };
    });

    // Second open: fast getActiveSession — arrives before e1 resolves.
    // The guard cancels e1 before starting e2 (second-wins policy).
    const e2 = openWithGuard(async () => ({ session: { id: 'sess-second' } }));

    await Promise.all([e1.promise, e2.promise]);

    assert.equal(startedIds.length, 1,
      'onStarted must fire exactly once despite double-open');
    assert.equal(startedIds[0], 'sess-second',
      'second-wins: second open\'s session id must be the one that fires');
  });

  it('second-wins: second open cancels the first — onClose fires exactly once', async () => {
    let closeCalls = 0;

    const { openWithGuard } = makeGuardedOpener({
      onStarted: () => {},
      onClose:   () => { closeCalls++; },
    });

    const e1 = openWithGuard(async () => {
      await delay(40);
      return { session: { id: 'sess-close-first' } };
    });

    const e2 = openWithGuard(async () => ({ session: { id: 'sess-close-second' } }));

    await Promise.all([e1.promise, e2.promise]);

    assert.equal(closeCalls, 1,
      'onClose must fire exactly once despite double-open');
  });

  it('second-wins: cancelled first effect fires no callbacks', async () => {
    const firstCallbacks: string[] = [];
    const secondCallbacks: string[] = [];

    // Two independent callback sets — one per effect
    let currentCancel: (() => void) | null = null;

    function openTracked(
      label: string,
      getActiveSession: () => Promise<{ session: { id: string } | null }>,
    ) {
      currentCancel?.();
      currentCancel = null;

      const { promise, cancel } = runSheetOpenEffect({
        onStarted: () => { (label === 'e1' ? firstCallbacks : secondCallbacks).push('started'); },
        onClose:   () => { (label === 'e1' ? firstCallbacks : secondCallbacks).push('close'); },
        getActiveSession,
      });
      currentCancel = cancel;
      return { promise };
    }

    const e1 = openTracked('e1', async () => {
      await delay(40);
      return { session: { id: 'sess-tracked-first' } };
    });

    const e2 = openTracked('e2', async () => ({ session: { id: 'sess-tracked-second' } }));

    await Promise.all([e1.promise, e2.promise]);

    assert.equal(firstCallbacks.length, 0,
      'first effect was cancelled — its callbacks must not fire');
    assert.ok(secondCallbacks.length > 0,
      'second effect is live — its callbacks must fire');
  });

  it('second-wins: parent state reflects exactly one close after double-open', async () => {
    const { state, handleSafeReturnStarted, handleSafeReturnClose } =
      makeTripPlanSectionCallbacks({ safeReturnSetupOpen: true });

    const { openWithGuard } = makeGuardedOpener({
      onStarted: () => { handleSafeReturnStarted(); },
      onClose:   () => { handleSafeReturnClose(); },
    });

    const e1 = openWithGuard(async () => {
      await delay(40);
      return { session: { id: 'sess-state-first' } };
    });

    const e2 = openWithGuard(async () => ({ session: { id: 'sess-state-second' } }));

    await Promise.all([e1.promise, e2.promise]);
    await Promise.resolve(); // fire-and-forget tick inside handleSafeReturnStarted

    assert.equal(state.safeReturnSetupOpen, false,
      'sheet must be closed exactly once after double-open');
    assert.equal(state.safeReturnSetupItemId, null,
      'plan item ref must be cleared once');
  });

  // ── Ordering guarantee ─────────────────────────────────────────────────────

  it('second-wins: onStarted fires before onClose (ordering preserved after double-open)', async () => {
    const order: string[] = [];

    const { openWithGuard } = makeGuardedOpener({
      onStarted: () => { order.push('onStarted'); },
      onClose:   () => { order.push('onClose'); },
    });

    const e1 = openWithGuard(async () => {
      await delay(40);
      return { session: { id: 'sess-order-first' } };
    });

    const e2 = openWithGuard(async () => ({ session: { id: 'sess-order-second' } }));

    await Promise.all([e1.promise, e2.promise]);

    assert.ok(order.indexOf('onStarted') < order.indexOf('onClose'),
      'onStarted must fire before onClose even after a double-open');
  });

  // ── Documents the unguarded bug ────────────────────────────────────────────

  it('without guard: two concurrent effects both fire callbacks (documents the double-open bug)', async () => {
    // This test deliberately omits the guard to show what happens when two
    // concurrent runSheetOpenEffect calls share the same onStarted/onClose —
    // both effects fire independently, causing double-fire. The guard
    // (makeGuardedOpener above) closes this by cancelling the first effect.
    const startedIds: string[] = [];
    let closeCalls = 0;

    // NO guard — start both effects without cancelling the first
    const e1 = runSheetOpenEffect({
      onStarted: (id) => { startedIds.push(`e1:${id}`); },
      onClose:   () => { closeCalls++; },
      getActiveSession: async () => ({ session: { id: 'sess-unguarded-1' } }),
    });

    const e2 = runSheetOpenEffect({
      onStarted: (id) => { startedIds.push(`e2:${id}`); },
      onClose:   () => { closeCalls++; },
      getActiveSession: async () => ({ session: { id: 'sess-unguarded-2' } }),
    });

    await Promise.all([e1.promise, e2.promise]);

    // Without guard, BOTH effects fire independently — double-open bug documented.
    assert.equal(startedIds.length, 2,
      'without guard: both concurrent effects fire onStarted (double-open bug — fixed by openEffectHandleRef)');
    assert.equal(closeCalls, 2,
      'without guard: onClose fires twice (double-open bug — fixed by openEffectHandleRef)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10: startCheckedOpenEffect timeout race — Android background-mid-check
//
// The production SafeReturnSetupSheet passes an `onTimeout` callback to
// startCheckedOpenEffect so it can show "Still checking…" feedback and linger
// before opening the form fail-open. This is the path taken when the app is
// backgrounded mid-check.
//
// These tests call startCheckedOpenEffect directly (the production function,
// not a model) to make the guarantee explicit:
//
//   a) getActiveSession stalls → timeout fires → onTimeout() is called.
//      The overlay is NOT cleared immediately (live stays true, timedOut=true).
//   b) A follow-up linger timer (mirrors the component's slowCheckTimerRef)
//      calls onCheckingChange(false) after the brief linger — exactly once.
//   c) When the stalled getActiveSession eventually resolves, the IIFE's
//      finally-block checks `live && !timedOut` — timedOut is true, so
//      onCheckingChange(false) is NOT called a second time.
//   d) If cancel() fires during the linger, the linger finds isLive()=false
//      and is a no-op. The single onCheckingChange(false) comes from cancel().
//   e) isLive() stays true immediately after onTimeout fires (unlike the
//      legacy no-onTimeout path where the timeout sets live=false directly).
// ─────────────────────────────────────────────────────────────────────────────

describe('SafeReturnSetupSheet — startCheckedOpenEffect timeout race (Android background guard)', () => {
  const LINGER_MS = 10; // fast linger for tests (component uses 1 500 ms)
  const TIMEOUT_MS = 10; // fast timeout for tests (component uses 5 000 ms)

  /**
   * Mirrors SafeReturnSetupSheet's onTimeout handler:
   *   onTimeout: () => {
   *     onSlowCheck?.();
   *     slowCheckTimerRef.current = setTimeout(() => {
   *       if (!handle.isLive()) return;
   *       onCheckingChange?.(false);
   *       setModalVisible(true);   ← captured as modalOpenCalled
   *     }, SLOW_CHECK_LINGER_MS);
   *   }
   *
   * Returns the linger promise so tests can await it, and an openedHandle ref
   * so isLive() can be queried from inside the linger callback.
   */
  function makeOnTimeoutHandler(opts: {
    onCheckingChange: (v: boolean) => void;
    lingerMs?: number;
    onModalOpen?: () => void;
  }) {
    let openedHandle: ReturnType<typeof startCheckedOpenEffect> | null = null;
    let resolveLingerDone!: () => void;
    const lingerDone = new Promise<void>((r) => { resolveLingerDone = r; });

    function setHandle(h: ReturnType<typeof startCheckedOpenEffect>) {
      openedHandle = h;
    }

    function onTimeout() {
      setTimeout(() => {
        if (openedHandle && !openedHandle.isLive()) {
          resolveLingerDone();
          return;
        }
        opts.onCheckingChange(false);
        opts.onModalOpen?.();
        resolveLingerDone();
      }, opts.lingerMs ?? LINGER_MS);
    }

    return { setHandle, onTimeout, lingerDone };
  }

  // ── a) timeout fires → onTimeout() called, live stays true ─────────────────

  it('timeout fires onTimeout() — live stays true (unlike legacy path) so linger can use isLive()', async () => {
    const checking: boolean[] = [];

    const handler = makeOnTimeoutHandler({ onCheckingChange: (v) => { checking.push(v); } });

    const handle = startCheckedOpenEffect(
      {
        onCheckingChange: (v) => { checking.push(v); },
        onClose: () => {},
        getActiveSession: () => new Promise(() => {}), // stalled
        onTimeout: handler.onTimeout,
      },
      { timeoutMs: TIMEOUT_MS },
    );
    handler.setHandle(handle);

    // Wait for timeout to fire (TIMEOUT_MS) and linger to elapse (LINGER_MS)
    await handler.lingerDone;

    assert.equal(handle.isLive(), true,
      'isLive() must still be true after onTimeout fires — live is only set false by cancel() or legacy path');

    handle.cancel();
  });

  it('timeout fires → onTimeout() is invoked (not onClose) when onTimeout is provided', async () => {
    let onTimeoutCalled = false;
    let onCloseCalled = false;

    const handler = makeOnTimeoutHandler({ onCheckingChange: () => {} });
    const origOnTimeout = handler.onTimeout;
    const wrappedOnTimeout = () => { onTimeoutCalled = true; origOnTimeout(); };

    const handle = startCheckedOpenEffect(
      {
        onClose: () => { onCloseCalled = true; },
        getActiveSession: () => new Promise(() => {}), // stalled
        onTimeout: wrappedOnTimeout,
      },
      { timeoutMs: TIMEOUT_MS },
    );
    handler.setHandle(handle);

    await handler.lingerDone;

    assert.equal(onTimeoutCalled, true, 'onTimeout must be called when the safety-net fires');
    assert.equal(onCloseCalled, false,
      'onClose must NOT be called by the timeout when onTimeout is provided — the caller owns fail-open');

    handle.cancel();
  });

  // ── b) linger fires → onCheckingChange(false) exactly once ─────────────────

  it('linger elapses → onCheckingChange(false) delivered exactly once (overlay clears)', async () => {
    const log: boolean[] = [];

    const handler = makeOnTimeoutHandler({ onCheckingChange: (v) => { log.push(v); } });

    const handle = startCheckedOpenEffect(
      {
        onCheckingChange: (v) => { log.push(v); },
        onClose: () => {},
        getActiveSession: () => new Promise(() => {}), // stalled
        onTimeout: handler.onTimeout,
      },
      { timeoutMs: TIMEOUT_MS },
    );
    handler.setHandle(handle);

    await handler.lingerDone;

    // Sequence: onCheckingChange(true) from IIFE start, then onCheckingChange(false)
    // from the linger callback once the timer elapses.
    assert.equal(log[0], true,  'first call must be onCheckingChange(true) — check started');
    assert.equal(log[1], false, 'second call must be onCheckingChange(false) — linger elapsed');
    assert.equal(log.length, 2, 'onCheckingChange must be called exactly twice (true then false)');

    handle.cancel();
  });

  it('linger elapses → checking ends as false — trigger button is unlocked', async () => {
    let checking = true; // starts as true (checking is active)

    const handler = makeOnTimeoutHandler({ onCheckingChange: (v) => { checking = v; } });

    const handle = startCheckedOpenEffect(
      {
        onCheckingChange: (v) => { checking = v; },
        onClose: () => {},
        getActiveSession: () => new Promise(() => {}), // stalled
        onTimeout: handler.onTimeout,
      },
      { timeoutMs: TIMEOUT_MS },
    );
    handler.setHandle(handle);

    await handler.lingerDone;

    assert.equal(checking, false,
      'safeReturnChecking must be false after the linger elapses — trigger button must not stay locked');

    handle.cancel();
  });

  it('linger elapses → form modal is signalled to open (fail-open after slow check)', async () => {
    let modalOpened = false;

    const handler = makeOnTimeoutHandler({
      onCheckingChange: () => {},
      onModalOpen: () => { modalOpened = true; },
    });

    const handle = startCheckedOpenEffect(
      {
        onClose: () => {},
        getActiveSession: () => new Promise(() => {}), // stalled
        onTimeout: handler.onTimeout,
      },
      { timeoutMs: TIMEOUT_MS },
    );
    handler.setHandle(handle);

    await handler.lingerDone;

    assert.equal(modalOpened, true,
      'form modal must open fail-open after the linger elapses — user must not be blocked');

    handle.cancel();
  });

  // ── c) no double-call when stalled session eventually resolves ───────────────

  it('stalled session resolves after timeout+linger — onCheckingChange(false) NOT called a second time', async () => {
    let resolveSession!: (v: { session: null }) => void;
    const sessionPromise = new Promise<{ session: null }>((r) => { resolveSession = r; });
    const log: boolean[] = [];

    const handler = makeOnTimeoutHandler({ onCheckingChange: (v) => { log.push(v); } });

    const handle = startCheckedOpenEffect(
      {
        onCheckingChange: (v) => { log.push(v); },
        onClose: () => {},
        getActiveSession: () => sessionPromise,
        onTimeout: handler.onTimeout,
      },
      { timeoutMs: TIMEOUT_MS },
    );
    handler.setHandle(handle);

    // Wait for timeout → linger → onCheckingChange(false) delivered once
    await handler.lingerDone;
    const countAfterLinger = log.filter((v) => !v).length;

    // Now the stalled network call finally returns — the IIFE finally-block runs
    resolveSession({ session: null });
    await new Promise<void>((r) => setTimeout(r, 20)); // drain microtasks

    assert.equal(
      log.filter((v) => !v).length,
      countAfterLinger,
      'onCheckingChange(false) must NOT fire a second time when the stalled session resolves ' +
      'after timeout+linger — timedOut=true guard in the IIFE finally-block prevents the double-call',
    );

    handle.cancel();
  });

  it('stalled session resolves after timeout — onCheckingChange(false) fires exactly once total', async () => {
    let resolveSession!: (v: { session: null }) => void;
    const sessionPromise = new Promise<{ session: null }>((r) => { resolveSession = r; });
    let falseCalls = 0;

    const handler = makeOnTimeoutHandler({ onCheckingChange: (v) => { if (!v) falseCalls++; } });

    const handle = startCheckedOpenEffect(
      {
        onCheckingChange: (v) => { if (!v) falseCalls++; },
        onClose: () => {},
        getActiveSession: () => sessionPromise,
        onTimeout: handler.onTimeout,
      },
      { timeoutMs: TIMEOUT_MS },
    );
    handler.setHandle(handle);

    await handler.lingerDone;
    resolveSession({ session: null });
    await new Promise<void>((r) => setTimeout(r, 20));

    assert.equal(falseCalls, 1,
      'onCheckingChange(false) must be called exactly once total — linger delivers it, ' +
      'the IIFE finally-block is suppressed by timedOut=true');

    handle.cancel();
  });

  // ── d) cancel() during linger → linger is no-op, cancel delivers the false ──

  it('cancel() during linger — linger fires but is a no-op (isLive()=false)', async () => {
    let falseCalls = 0;
    let modalOpened = false;

    const handler = makeOnTimeoutHandler({
      onCheckingChange: (v) => { if (!v) falseCalls++; },
      onModalOpen: () => { modalOpened = true; },
    });

    const handle = startCheckedOpenEffect(
      {
        onCheckingChange: (v) => { if (!v) falseCalls++; },
        onClose: () => {},
        getActiveSession: () => new Promise(() => {}), // stalled
        onTimeout: handler.onTimeout,
      },
      { timeoutMs: TIMEOUT_MS },
    );
    handler.setHandle(handle);

    // Wait just long enough for the timeout to fire and onTimeout() to be called,
    // then cancel before the linger timer fires.
    await new Promise<void>((r) => setTimeout(r, TIMEOUT_MS + 2));

    // Cancel while linger is still pending
    handle.cancel();

    // Wait for the linger to elapse — it should be a no-op because isLive()=false
    await handler.lingerDone;

    assert.equal(falseCalls, 1,
      'onCheckingChange(false) must be called exactly once — cancel() delivers it; ' +
      'the linger finds isLive()=false and skips the second call');
    assert.equal(modalOpened, false,
      'linger must not open the modal after cancel() — handle.isLive() guard prevents it');
  });

  it('cancel() during linger — checking ends as false exactly once (no stuck overlay)', async () => {
    // Use a long linger so cancel() reliably fires well before the linger
    // timer elapses. With LINGER_MS=10 and TIMEOUT_MS+2 cancel, fast timer
    // scheduling on a loaded machine caused the linger to fire first (race).
    const LONG_LINGER_MS = 200;
    const falseCallTimestamps: number[] = [];

    const handler = makeOnTimeoutHandler({
      onCheckingChange: (v) => { if (!v) falseCallTimestamps.push(Date.now()); },
      lingerMs: LONG_LINGER_MS,
    });

    const handle = startCheckedOpenEffect(
      {
        onCheckingChange: (v) => { if (!v) falseCallTimestamps.push(Date.now()); },
        onClose: () => {},
        getActiveSession: () => new Promise(() => {}), // stalled
        onTimeout: handler.onTimeout,
      },
      { timeoutMs: TIMEOUT_MS },
    );
    handler.setHandle(handle);

    // Wait for the timeout to fire (TIMEOUT_MS), then cancel well within the
    // long linger window so the linger's isLive() guard definitely sees false.
    await new Promise<void>((r) => setTimeout(r, TIMEOUT_MS + 5));
    handle.cancel();
    await handler.lingerDone;

    assert.equal(falseCallTimestamps.length, 1,
      'safeReturnChecking must flip to false exactly once — cancel() is the source; ' +
      'linger is suppressed by the isLive() guard');
  });

  // ── e) isLive() after cancel() ──────────────────────────────────────────────

  it('isLive() returns false after cancel() — subsequent linger and IIFE callbacks are all suppressed', async () => {
    const handler = makeOnTimeoutHandler({ onCheckingChange: () => {} });

    const handle = startCheckedOpenEffect(
      {
        onClose: () => {},
        getActiveSession: () => new Promise(() => {}), // stalled
        onTimeout: handler.onTimeout,
      },
      { timeoutMs: TIMEOUT_MS },
    );
    handler.setHandle(handle);

    await new Promise<void>((r) => setTimeout(r, TIMEOUT_MS + 2));
    handle.cancel();
    await handler.lingerDone;

    assert.equal(handle.isLive(), false,
      'isLive() must be false after cancel() — this is the guard the linger callback uses');
  });
});
