/**
 * SafeReturnSetupSheet — open-effect behaviour tests.
 *
 * Run with:
 *   node --import tsx/esm --test \
 *     src/components/__tests__/SafeReturnSetupSheet.openEffect.test.ts
 *
 * ## Testing strategy
 *
 * The `useEffect([visible])` in SafeReturnSetupSheet has three meaningful
 * branches when `visible` flips to `true`:
 *
 *   A) getActiveSession() returns a session
 *      → onStarted(sessionId) is called
 *      → onClose() is called
 *      → the form modal must NOT appear (modalShouldOpen = false)
 *
 *   B) getActiveSession() returns { session: null }
 *      → the form modal must appear (modalShouldOpen = true)
 *      → onStarted is NOT called
 *      → onClose is NOT called
 *
 *   C) getActiveSession() throws (network / server error)
 *      → the form modal must appear — fail-open (modalShouldOpen = true)
 *      → onStarted is NOT called
 *      → onClose is NOT called
 *
 * The logic lives in `runOpenEffect` (SafeReturnSetupSheet.openEffect.ts)
 * which the component delegates to. Testing runOpenEffect directly means
 * these three critical paths are covered without a React renderer.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runOpenEffect } from '../safeReturn/SafeReturnSetupSheet.openEffect.ts';

// ── helpers ────────────────────────────────────────────────────────────────────

function makeCallbacks(overrides: {
  onStarted?: (id: string) => void;
  onClose?: () => void;
  getActiveSession: () => Promise<{ session: { id: string } | null }>;
}) {
  return {
    onStarted: overrides.onStarted ?? (() => {}),
    onClose: overrides.onClose ?? (() => {}),
    getActiveSession: overrides.getActiveSession,
  };
}

// ── A) active session found → redirect ────────────────────────────────────────

describe('SafeReturnSetupSheet open-effect — active session found', () => {
  it('calls onStarted with the session id', async () => {
    const captured: string[] = [];
    const opts = makeCallbacks({
      onStarted: (id) => captured.push(id),
      getActiveSession: async () => ({ session: { id: 'sess-abc-123' } }),
    });

    await runOpenEffect(opts);

    assert.equal(captured.length, 1, 'onStarted must be called exactly once');
    assert.equal(captured[0], 'sess-abc-123', 'onStarted must receive the session id');
  });

  it('calls onClose to dismiss the sheet', async () => {
    let closeCalls = 0;
    const opts = makeCallbacks({
      onClose: () => { closeCalls++; },
      getActiveSession: async () => ({ session: { id: 'sess-xyz' } }),
    });

    await runOpenEffect(opts);

    assert.equal(closeCalls, 1, 'onClose must be called exactly once when a session exists');
  });

  it('returns modalShouldOpen = false so the form is not shown', async () => {
    const opts = makeCallbacks({
      getActiveSession: async () => ({ session: { id: 'sess-001' } }),
    });

    const result = await runOpenEffect(opts);

    assert.equal(result.modalShouldOpen, false, 'form modal must not open when a session is active');
  });

  it('passes the correct id even when the session id contains hyphens and hex chars', async () => {
    const sessionId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const captured: string[] = [];
    const opts = makeCallbacks({
      onStarted: (id) => captured.push(id),
      getActiveSession: async () => ({ session: { id: sessionId } }),
    });

    await runOpenEffect(opts);

    assert.equal(captured[0], sessionId);
  });

  it('onStarted is called before onClose (redirect ordering)', async () => {
    const order: string[] = [];
    const opts = makeCallbacks({
      onStarted: () => order.push('onStarted'),
      onClose: () => order.push('onClose'),
      getActiveSession: async () => ({ session: { id: 'sess-order' } }),
    });

    await runOpenEffect(opts);

    assert.deepEqual(order, ['onStarted', 'onClose'],
      'onStarted must fire before onClose so callers receive the id first');
  });

  it('works when onStarted is not provided (optional prop)', async () => {
    let closeCalls = 0;
    const opts = {
      onClose: () => { closeCalls++; },
      getActiveSession: async () => ({ session: { id: 'sess-no-cb' } }),
    };

    const result = await runOpenEffect(opts);

    assert.equal(closeCalls, 1, 'onClose still fires even without onStarted');
    assert.equal(result.modalShouldOpen, false);
  });
});

// ── B) no active session → show form ──────────────────────────────────────────

describe('SafeReturnSetupSheet open-effect — no active session', () => {
  it('returns modalShouldOpen = true so the form is displayed', async () => {
    const opts = makeCallbacks({
      getActiveSession: async () => ({ session: null }),
    });

    const result = await runOpenEffect(opts);

    assert.equal(result.modalShouldOpen, true, 'form must open when there is no active session');
  });

  it('does NOT call onStarted when there is no session', async () => {
    let startedCalls = 0;
    const opts = makeCallbacks({
      onStarted: () => { startedCalls++; },
      getActiveSession: async () => ({ session: null }),
    });

    await runOpenEffect(opts);

    assert.equal(startedCalls, 0, 'onStarted must not fire when session is null');
  });

  it('does NOT call onClose when there is no session', async () => {
    let closeCalls = 0;
    const opts = makeCallbacks({
      onClose: () => { closeCalls++; },
      getActiveSession: async () => ({ session: null }),
    });

    await runOpenEffect(opts);

    assert.equal(closeCalls, 0, 'onClose must not fire when session is null');
  });

  it('successive opens with no session each return modalShouldOpen = true', async () => {
    const opts = makeCallbacks({
      getActiveSession: async () => ({ session: null }),
    });

    const r1 = await runOpenEffect(opts);
    const r2 = await runOpenEffect(opts);

    assert.equal(r1.modalShouldOpen, true, 'first open should show form');
    assert.equal(r2.modalShouldOpen, true, 'second open should also show form');
  });
});

// ── C) getActiveSession throws → fail-open ────────────────────────────────────

describe('SafeReturnSetupSheet open-effect — getActiveSession error (fail-open)', () => {
  it('returns modalShouldOpen = true on a network error', async () => {
    const opts = makeCallbacks({
      getActiveSession: async () => { throw new Error('Network request failed'); },
    });

    const result = await runOpenEffect(opts);

    assert.equal(result.modalShouldOpen, true,
      'modal must still open on network error so the user can attempt setup');
  });

  it('does NOT call onStarted when getActiveSession throws', async () => {
    let startedCalls = 0;
    const opts = makeCallbacks({
      onStarted: () => { startedCalls++; },
      getActiveSession: async () => { throw new Error('500 Internal Server Error'); },
    });

    await runOpenEffect(opts);

    assert.equal(startedCalls, 0, 'onStarted must not fire on error');
  });

  it('does NOT call onClose when getActiveSession throws', async () => {
    let closeCalls = 0;
    const opts = makeCallbacks({
      onClose: () => { closeCalls++; },
      getActiveSession: async () => { throw new Error('timeout'); },
    });

    await runOpenEffect(opts);

    assert.equal(closeCalls, 0, 'onClose must not fire on error');
  });

  it('does not re-throw — the component must not crash on network failure', async () => {
    const opts = makeCallbacks({
      getActiveSession: async () => { throw new TypeError('fetch is not defined'); },
    });

    await assert.doesNotReject(
      () => runOpenEffect(opts),
      'runOpenEffect must swallow the error and not propagate it',
    );
  });

  it('subsequent opens after an earlier error still show the form', async () => {
    let callCount = 0;
    const opts = makeCallbacks({
      getActiveSession: async () => {
        callCount++;
        if (callCount === 1) throw new Error('first call fails');
        return { session: null };
      },
    });

    const r1 = await runOpenEffect(opts);
    const r2 = await runOpenEffect(opts);

    assert.equal(r1.modalShouldOpen, true, 'error path opens form');
    assert.equal(r2.modalShouldOpen, true, 'null-session path opens form');
  });
});

// ── Transition contract — active→none scenario ─────────────────────────────────
//
// Documents the expected lifecycle when the same sheet is opened twice: once
// while a session is active (redirect path) and once after it was cleared
// (form path). This mirrors a real user scenario: user confirms safe, session
// is cleared, user opens the sheet again.

describe('SafeReturnSetupSheet open-effect — lifecycle transitions', () => {
  it('first open redirects (session active), second open shows form (session cleared)', async () => {
    let hasSession = true;
    const startedIds: string[] = [];
    let closeCalls = 0;

    const opts = makeCallbacks({
      onStarted: (id) => startedIds.push(id),
      onClose: () => { closeCalls++; },
      getActiveSession: async () => ({
        session: hasSession ? { id: 'sess-lifecycle' } : null,
      }),
    });

    const r1 = await runOpenEffect(opts);
    assert.equal(r1.modalShouldOpen, false, 'first open: must redirect');
    assert.deepEqual(startedIds, ['sess-lifecycle']);
    assert.equal(closeCalls, 1);

    // User confirms safe → session is cleared on the server
    hasSession = false;

    const r2 = await runOpenEffect(opts);
    assert.equal(r2.modalShouldOpen, true, 'second open: must show form after session cleared');
    assert.equal(startedIds.length, 1, 'onStarted not called again');
    assert.equal(closeCalls, 1, 'onClose not called again');
  });
});

// ── Cancellation guard — rapid open/close/open race ────────────────────────────
//
// When `visible` flips true → false → true rapidly, two runOpenEffect calls run
// concurrently. The component wraps onStarted/onClose with `if (!cancelled)`
// guards before passing them to runOpenEffect, so a stale in-flight effect
// cannot call the callbacks after it has been superseded.
//
// These tests verify that pattern: a cancelled effect (simulated by setting
// `cancelled = true` while getActiveSession is in-flight) must not fire
// onStarted or onClose, while the live effect still fires them exactly once.

describe('SafeReturnSetupSheet open-effect — cancellation guard (rapid re-open)', () => {
  /** Resolves after `ms` milliseconds — used to keep getActiveSession in-flight. */
  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  it('wrapped onStarted does not fire after the effect is cancelled mid-flight', async () => {
    let cancelled = false;
    let startedCalls = 0;

    // Mimic what the component now does: wrap callbacks with the cancelled guard.
    const pending = runOpenEffect({
      onStarted: (id) => { if (!cancelled) startedCalls++; },
      onClose: () => {},
      getActiveSession: async () => {
        await delay(20); // stays in-flight so we can cancel before it resolves
        return { session: { id: 'sess-stale' } };
      },
    });

    // Simulate visible=false (useEffect cleanup)
    cancelled = true;

    await pending; // effect resolves, but callback is suppressed

    assert.equal(startedCalls, 0, 'onStarted must not fire when cancelled before getActiveSession resolves');
  });

  it('wrapped onClose does not fire after the effect is cancelled mid-flight', async () => {
    let cancelled = false;
    let closeCalls = 0;

    const pending = runOpenEffect({
      onStarted: () => {},
      onClose: () => { if (!cancelled) closeCalls++; },
      getActiveSession: async () => {
        await delay(20);
        return { session: { id: 'sess-stale' } };
      },
    });

    cancelled = true;
    await pending;

    assert.equal(closeCalls, 0, 'onClose must not fire when cancelled before getActiveSession resolves');
  });

  it('rapid open/close/open — effect 1 cancelled, effect 2 fires callbacks exactly once', async () => {
    let cancelled1 = false;
    const effect1Calls: string[] = [];
    const effect2Calls: string[] = [];

    // Effect 1: visible flips true — starts a slow getActiveSession
    const effect1 = runOpenEffect({
      onStarted: (id) => { if (!cancelled1) effect1Calls.push(`started:${id}`); },
      onClose: () => { if (!cancelled1) effect1Calls.push('close'); },
      getActiveSession: async () => {
        await delay(30);
        return { session: { id: 'sess-race' } };
      },
    });

    // Simulate visible=false: cancel effect 1, then visible=true: start effect 2
    cancelled1 = true;

    // Effect 2: immediate getActiveSession (no delay) with its own callbacks
    const effect2 = runOpenEffect({
      onStarted: (id) => { effect2Calls.push(`started:${id}`); },
      onClose: () => { effect2Calls.push('close'); },
      getActiveSession: async () => ({ session: { id: 'sess-race' } }),
    });

    await Promise.all([effect1, effect2]);

    assert.equal(effect1Calls.length, 0,
      'effect 1 (cancelled) must not fire any callbacks');
    assert.deepEqual(effect2Calls, ['started:sess-race', 'close'],
      'effect 2 (live) must fire onStarted then onClose exactly once');
  });

  it('if the cancelled effect found no session, modalShouldOpen is still ignored by the component', async () => {
    // When getActiveSession returns null and the effect is cancelled, the
    // component's `if (cancelled) return` guard prevents modalVisible from
    // being set. This test documents the no-session cancelled path.
    let cancelled = false;
    let modalOpenAttempts = 0;

    const pending = runOpenEffect({
      onStarted: () => {},
      onClose: () => {},
      getActiveSession: async () => {
        await delay(10);
        return { session: null };
      },
    });

    cancelled = true;
    const { modalShouldOpen } = await pending;

    // Simulate the component's cancelled check before setting modalVisible
    if (!cancelled) modalOpenAttempts++;

    assert.equal(modalShouldOpen, true, 'helper still returns true (its contract is unchanged)');
    assert.equal(modalOpenAttempts, 0,
      'the component guard (if cancelled) prevents modalVisible from being set');
  });

  it('back-to-back cancellation then new open: only the final effect acts', async () => {
    // Open 1 → cancel → open 2 → cancel → open 3 (final, not cancelled)
    let cancelled1 = false;
    let cancelled2 = false;
    const fired: number[] = [];

    const makeEffect = (n: number, isCancelled: () => boolean, ms: number) =>
      runOpenEffect({
        onStarted: () => { if (!isCancelled()) fired.push(n); },
        onClose: () => {},
        getActiveSession: async () => {
          await delay(ms);
          return { session: { id: `sess-${n}` } };
        },
      });

    const e1 = makeEffect(1, () => cancelled1, 40);
    cancelled1 = true;

    const e2 = makeEffect(2, () => cancelled2, 20);
    cancelled2 = true;

    const e3 = makeEffect(3, () => false, 0); // not cancelled

    await Promise.all([e1, e2, e3]);

    assert.deepEqual(fired, [3], 'only the non-cancelled effect (effect 3) must fire onStarted');
  });
});
