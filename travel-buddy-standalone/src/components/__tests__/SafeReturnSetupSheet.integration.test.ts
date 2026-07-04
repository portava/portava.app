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
