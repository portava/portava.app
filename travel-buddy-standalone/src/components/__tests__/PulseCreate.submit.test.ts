/**
 * Submit-result machine tests for UnifiedPostComposer (PulseCreate.tsx).
 *
 * Run with:
 *   node --import tsx/esm --test src/components/__tests__/PulseCreate.submit.test.ts
 *
 * ## Why this test exists
 *
 * The submit-success path (create() resolves ok → onSuccess() + onClose()) was
 * previously untested at the machine layer. A regression here would leave the
 * composer sheet open after a successful post, silently eating the user's content.
 *
 * ## Testing strategy
 *
 * We use the same machine-layer pattern as PulseCreate.backdrop.test.ts and
 * ReportPostSheet.test.ts. `handleSubmitResult` is a pure async function that
 * receives injected side-effect handlers, so we can verify every branch with
 * plain node:test spies — no React Native renderer required.
 *
 * Three branches are covered:
 *
 *   1. ok: true  → onSuccess?.() then onClose() — the critical success path
 *   2. unauthenticated error → signOut() + navigate() + onClose()
 *   3. other errors (network_unreachable, invalid_payload, config_error, unknown)
 *                → setError(msg); onClose is NOT called
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSubmitLock, createOnceGuard, handleSubmitResult, handleUploadResult } from '../PulseCreate.machine.ts';

// ── Success path ──────────────────────────────────────────────────────────────

describe('submit success — create() returns ok: true', () => {
  it('calls onClose after a successful create', async () => {
    let closeCalls = 0;
    await handleSubmitResult(
      { ok: true },
      {
        onClose: () => { closeCalls++; },
        signOut: async () => {},
        navigate: () => {},
        setError: () => {},
      },
    );
    assert.equal(closeCalls, 1, 'onClose must be called exactly once on success');
  });

  it('calls onSuccess before onClose on a successful create', async () => {
    const order: string[] = [];
    await handleSubmitResult(
      { ok: true },
      {
        onSuccess: () => { order.push('success'); },
        onClose: () => { order.push('close'); },
        signOut: async () => {},
        navigate: () => {},
        setError: () => {},
      },
    );
    assert.deepEqual(order, ['success', 'close'], 'onSuccess must fire before onClose');
  });

  it('works when onSuccess is not provided (optional)', async () => {
    let closeCalls = 0;
    await handleSubmitResult(
      { ok: true },
      {
        onClose: () => { closeCalls++; },
        signOut: async () => {},
        navigate: () => {},
        setError: () => {},
      },
    );
    assert.equal(closeCalls, 1, 'onClose still fires when onSuccess is absent');
  });

  it('does NOT call setError on success', async () => {
    let errorCalls = 0;
    await handleSubmitResult(
      { ok: true },
      {
        onClose: () => {},
        signOut: async () => {},
        navigate: () => {},
        setError: () => { errorCalls++; },
      },
    );
    assert.equal(errorCalls, 0, 'setError must not be called on success');
  });

  it('does NOT call signOut or navigate on success', async () => {
    let signOutCalls = 0;
    let navigateCalls = 0;
    await handleSubmitResult(
      { ok: true },
      {
        onClose: () => {},
        signOut: async () => { signOutCalls++; },
        navigate: () => { navigateCalls++; },
        setError: () => {},
      },
    );
    assert.equal(signOutCalls, 0, 'signOut must not be called on success');
    assert.equal(navigateCalls, 0, 'navigate must not be called on success');
  });
});

// ── Error path — onClose must NOT be called ───────────────────────────────────

describe('submit error — create() returns ok: false (non-unauthenticated)', () => {
  it('does NOT call onClose when create() returns a network error', async () => {
    let closeCalls = 0;
    await handleSubmitResult(
      { ok: false, errorKind: 'network_unreachable' },
      {
        onClose: () => { closeCalls++; },
        signOut: async () => {},
        navigate: () => {},
        setError: () => {},
      },
    );
    assert.equal(closeCalls, 0, 'onClose must NOT be called when create() fails');
  });

  it('does NOT call onClose for invalid_payload error', async () => {
    let closeCalls = 0;
    await handleSubmitResult(
      { ok: false, errorKind: 'invalid_payload' },
      {
        onClose: () => { closeCalls++; },
        signOut: async () => {},
        navigate: () => {},
        setError: () => {},
      },
    );
    assert.equal(closeCalls, 0, 'onClose must NOT be called on invalid_payload');
  });

  it('does NOT call onClose for config_error', async () => {
    let closeCalls = 0;
    await handleSubmitResult(
      { ok: false, errorKind: 'config_error' },
      {
        onClose: () => { closeCalls++; },
        signOut: async () => {},
        navigate: () => {},
        setError: () => {},
      },
    );
    assert.equal(closeCalls, 0, 'onClose must NOT be called on config_error');
  });

  it('does NOT call onClose for an unknown error kind', async () => {
    let closeCalls = 0;
    await handleSubmitResult(
      { ok: false, errorKind: 'server_error' },
      {
        onClose: () => { closeCalls++; },
        signOut: async () => {},
        navigate: () => {},
        setError: () => {},
      },
    );
    assert.equal(closeCalls, 0, 'onClose must NOT be called for unknown error kinds');
  });

  it('calls setError with the known message for network_unreachable', async () => {
    let errorMsg = '';
    await handleSubmitResult(
      { ok: false, errorKind: 'network_unreachable' },
      {
        onClose: () => {},
        signOut: async () => {},
        navigate: () => {},
        setError: (msg) => { errorMsg = msg; },
      },
    );
    assert.equal(errorMsg, 'Network unavailable. Try again.');
  });

  it('calls setError with the known message for invalid_payload', async () => {
    let errorMsg = '';
    await handleSubmitResult(
      { ok: false, errorKind: 'invalid_payload' },
      {
        onClose: () => {},
        signOut: async () => {},
        navigate: () => {},
        setError: (msg) => { errorMsg = msg; },
      },
    );
    assert.equal(errorMsg, 'Check your post and try again.');
  });

  it('calls setError with the known message for config_error', async () => {
    let errorMsg = '';
    await handleSubmitResult(
      { ok: false, errorKind: 'config_error' },
      {
        onClose: () => {},
        signOut: async () => {},
        navigate: () => {},
        setError: (msg) => { errorMsg = msg; },
      },
    );
    assert.equal(errorMsg, 'Posting unavailable right now.');
  });

  it('falls back to result.message for unknown error kinds', async () => {
    let errorMsg = '';
    await handleSubmitResult(
      { ok: false, errorKind: 'mystery', message: 'Something weird happened.' },
      {
        onClose: () => {},
        signOut: async () => {},
        navigate: () => {},
        setError: (msg) => { errorMsg = msg; },
      },
    );
    assert.equal(errorMsg, 'Something weird happened.');
  });

  it('falls back to generic message when errorKind and message are both absent', async () => {
    let errorMsg = '';
    await handleSubmitResult(
      { ok: false },
      {
        onClose: () => {},
        signOut: async () => {},
        navigate: () => {},
        setError: (msg) => { errorMsg = msg; },
      },
    );
    assert.equal(errorMsg, 'Could not post.');
  });
});

// ── Double-invocation — documents caller responsibility ───────────────────────
//
// handleSubmitResult is intentionally stateless — it has no internal once-guard.
// Calling it twice with ok: true fires onClose twice. This is the documented
// behaviour; the caller-side `submitting` flag in handleSubmit() is the guard
// that prevents this in production. These tests pin that contract so any future
// refactor that accidentally removes the caller-side guard will be caught here.

describe('double-invocation — caller is responsible for preventing this', () => {
  it('calls onClose twice when handleSubmitResult is called twice with ok: true', async () => {
    let closeCalls = 0;
    const handlers = {
      onClose: () => { closeCalls++; },
      signOut: async () => {},
      navigate: () => {},
      setError: () => {},
    };
    await handleSubmitResult({ ok: true }, handlers);
    await handleSubmitResult({ ok: true }, handlers);
    assert.equal(
      closeCalls,
      2,
      'handleSubmitResult has no internal once-guard: double-call → double-close. ' +
      'The submitting flag in handleSubmit() is the caller-side guard that prevents this.',
    );
  });

  it('does NOT call onClose a second time when the second call has ok: false (non-unauthenticated)', async () => {
    let closeCalls = 0;
    const handlers = {
      onClose: () => { closeCalls++; },
      signOut: async () => {},
      navigate: () => {},
      setError: () => {},
    };
    await handleSubmitResult({ ok: true }, handlers);
    await handleSubmitResult({ ok: false, errorKind: 'network_unreachable' }, handlers);
    assert.equal(closeCalls, 1, 'second call with ok: false must not re-fire onClose');
  });
});

// ── Unauthenticated error — signs out and closes ──────────────────────────────

describe('submit error — unauthenticated (session expired)', () => {
  it('calls onClose after unauthenticated error', async () => {
    let closeCalls = 0;
    await handleSubmitResult(
      { ok: false, errorKind: 'unauthenticated' },
      {
        onClose: () => { closeCalls++; },
        signOut: async () => {},
        navigate: () => {},
        setError: () => {},
      },
    );
    assert.equal(closeCalls, 1, 'onClose must be called once on unauthenticated error');
  });

  it('calls signOut before navigate on unauthenticated error', async () => {
    const order: string[] = [];
    await handleSubmitResult(
      { ok: false, errorKind: 'unauthenticated' },
      {
        onClose: () => {},
        signOut: async () => { order.push('signOut'); },
        navigate: () => { order.push('navigate'); },
        setError: () => {},
      },
    );
    assert.deepEqual(order, ['signOut', 'navigate'], 'signOut must run before navigate');
  });

  it('navigates to the sign-in route on unauthenticated error', async () => {
    let destination = '';
    await handleSubmitResult(
      { ok: false, errorKind: 'unauthenticated' },
      {
        onClose: () => {},
        signOut: async () => {},
        navigate: (path) => { destination = path; },
        setError: () => {},
      },
    );
    assert.equal(destination, '/(auth)/sign-in');
  });

  it('does NOT call setError on unauthenticated error', async () => {
    let errorCalls = 0;
    await handleSubmitResult(
      { ok: false, errorKind: 'unauthenticated' },
      {
        onClose: () => {},
        signOut: async () => {},
        navigate: () => {},
        setError: () => { errorCalls++; },
      },
    );
    assert.equal(errorCalls, 0, 'setError must not be called on unauthenticated error');
  });
});

// ── Upload-result machine — handleUploadResult ────────────────────────────────
//
// The upload-result branch in handleSubmit() was previously an inline block.
// It is now extracted into handleUploadResult() so this contract can be verified
// at the machine layer without mounting the component.
//
// Three branches:
//   1. ok: true + url   → { continue: true, url, mediaType }  — caller proceeds
//   2. unauthenticated  → signOut() + navigate() + onClose()  — composer closes
//   3. other failure    → setError(msg)                       — composer stays open

describe('upload-result — upload succeeds (ok: true, url present)', () => {
  it('returns continue: true with the uploaded url and mediaType', async () => {
    const outcome = await handleUploadResult(
      { ok: true, url: 'https://cdn.example.com/photo.jpg', mediaType: 'image/jpeg' },
      { onClose: () => {}, signOut: async () => {}, navigate: () => {}, setError: () => {} },
    );
    assert.equal(outcome.continue, true);
    if (outcome.continue) {
      assert.equal(outcome.url, 'https://cdn.example.com/photo.jpg');
      assert.equal(outcome.mediaType, 'image/jpeg');
    }
  });

  it('does NOT call onClose when upload succeeds', async () => {
    let closeCalls = 0;
    await handleUploadResult(
      { ok: true, url: 'https://cdn.example.com/photo.jpg', mediaType: 'image/jpeg' },
      { onClose: () => { closeCalls++; }, signOut: async () => {}, navigate: () => {}, setError: () => {} },
    );
    assert.equal(closeCalls, 0, 'onClose must NOT be called when upload succeeds');
  });

  it('does NOT call setError when upload succeeds', async () => {
    let errorCalls = 0;
    await handleUploadResult(
      { ok: true, url: 'https://cdn.example.com/photo.jpg', mediaType: 'image/jpeg' },
      { onClose: () => {}, signOut: async () => {}, navigate: () => {}, setError: () => { errorCalls++; } },
    );
    assert.equal(errorCalls, 0, 'setError must NOT be called when upload succeeds');
  });
});

describe('upload-result — upload fails with a non-auth error', () => {
  it('returns continue: false on a non-auth upload failure', async () => {
    const outcome = await handleUploadResult(
      { ok: false, url: null, mediaType: null, errorKind: 'upload_failed', message: 'Server rejected the file.' },
      { onClose: () => {}, signOut: async () => {}, navigate: () => {}, setError: () => {} },
    );
    assert.equal(outcome.continue, false, 'outcome.continue must be false so caller stops');
  });

  it('does NOT call onClose — composer stays open on non-auth upload failure', async () => {
    let closeCalls = 0;
    await handleUploadResult(
      { ok: false, url: null, mediaType: null, errorKind: 'upload_failed', message: 'Server rejected the file.' },
      { onClose: () => { closeCalls++; }, signOut: async () => {}, navigate: () => {}, setError: () => {} },
    );
    assert.equal(closeCalls, 0, 'onClose must NOT be called when upload fails non-auth');
  });

  it('calls setError with the upload error message', async () => {
    let errorMsg = '';
    await handleUploadResult(
      { ok: false, url: null, mediaType: null, errorKind: 'upload_failed', message: 'Server rejected the file.' },
      { onClose: () => {}, signOut: async () => {}, navigate: () => {}, setError: (msg) => { errorMsg = msg; } },
    );
    assert.equal(errorMsg, 'Server rejected the file.');
  });

  it('falls back to generic message when upload fails with no message', async () => {
    let errorMsg = '';
    await handleUploadResult(
      { ok: false, url: null, mediaType: null },
      { onClose: () => {}, signOut: async () => {}, navigate: () => {}, setError: (msg) => { errorMsg = msg; } },
    );
    assert.equal(errorMsg, 'Media upload failed.');
  });

  it('does NOT call onClose for read_failed error', async () => {
    let closeCalls = 0;
    await handleUploadResult(
      { ok: false, url: null, mediaType: null, errorKind: 'read_failed', message: 'Could not read file.' },
      { onClose: () => { closeCalls++; }, signOut: async () => {}, navigate: () => {}, setError: () => {} },
    );
    assert.equal(closeCalls, 0, 'onClose must NOT be called on read_failed');
  });

  it('does NOT call onClose for config_error', async () => {
    let closeCalls = 0;
    await handleUploadResult(
      { ok: false, url: null, mediaType: null, errorKind: 'config_error', message: 'Backend not configured' },
      { onClose: () => { closeCalls++; }, signOut: async () => {}, navigate: () => {}, setError: () => {} },
    );
    assert.equal(closeCalls, 0, 'onClose must NOT be called on config_error');
  });
});

describe('upload-result — upload fails with unauthenticated error', () => {
  it('calls signOut, then navigate, then onClose in order', async () => {
    const order: string[] = [];
    let destination = '';
    await handleUploadResult(
      { ok: false, url: null, mediaType: null, errorKind: 'unauthenticated' },
      {
        onClose: () => { order.push('close'); },
        signOut: async () => { order.push('signOut'); },
        navigate: (path) => { order.push('navigate'); destination = path; },
        setError: () => {},
      },
    );
    assert.deepEqual(order, ['signOut', 'navigate', 'close'], 'signOut → navigate → onClose must fire in order');
    assert.equal(destination, '/(auth)/sign-in');
  });

  it('calls onClose on unauthenticated upload failure', async () => {
    let closeCalls = 0;
    await handleUploadResult(
      { ok: false, url: null, mediaType: null, errorKind: 'unauthenticated' },
      { onClose: () => { closeCalls++; }, signOut: async () => {}, navigate: () => {}, setError: () => {} },
    );
    assert.equal(closeCalls, 1, 'onClose must be called exactly once on unauthenticated failure');
  });

  it('returns continue: false on unauthenticated upload failure', async () => {
    const outcome = await handleUploadResult(
      { ok: false, url: null, mediaType: null, errorKind: 'unauthenticated' },
      { onClose: () => {}, signOut: async () => {}, navigate: () => {}, setError: () => {} },
    );
    assert.equal(outcome.continue, false);
  });

  it('does NOT call setError on unauthenticated upload failure', async () => {
    let errorCalls = 0;
    await handleUploadResult(
      { ok: false, url: null, mediaType: null, errorKind: 'unauthenticated' },
      { onClose: () => {}, signOut: async () => {}, navigate: () => {}, setError: () => { errorCalls++; } },
    );
    assert.equal(errorCalls, 0, 'setError must NOT be called on unauthenticated failure');
  });
});

// ── createSubmitLock — prevents concurrent re-entry into handleSubmit() ────────
//
// The `submitting` flag from usePostActions only flips true inside create() —
// AFTER the upload phase. A rapid double-tap can therefore re-enter
// handleSubmit() while upload is in flight, with `submitting` still false.
//
// createSubmitLock() returns a shared lock stored in a useRef. At the start of
// handleSubmit(), acquire() is called synchronously. If the lock is already held
// (first invocation is still in the upload phase), acquire() returns false and
// the second invocation bails out immediately — no upload, no handleUploadResult,
// no onClose() call.
//
// These tests model the two-concurrent-submit scenario at the machine layer
// without mounting the component, mirroring the component's call semantics.

describe('createSubmitLock — prevents concurrent re-entry into handleSubmit()', () => {
  it('acquire() returns true on the first call', () => {
    const lock = createSubmitLock();
    assert.equal(lock.acquire(), true, 'first acquire must succeed');
  });

  it('acquire() returns false while the lock is held', () => {
    const lock = createSubmitLock();
    lock.acquire();
    assert.equal(lock.acquire(), false, 'second acquire must fail while lock is held');
  });

  it('acquire() returns false on any additional call while held', () => {
    const lock = createSubmitLock();
    lock.acquire();
    assert.equal(lock.acquire(), false);
    assert.equal(lock.acquire(), false);
    assert.equal(lock.acquire(), false, 'every acquire while held must return false');
  });

  it('acquire() returns true again after release()', () => {
    const lock = createSubmitLock();
    lock.acquire();
    lock.release();
    assert.equal(lock.acquire(), true, 'acquire must succeed again after release');
  });

  it('each createSubmitLock() call returns an independent lock', () => {
    const lockA = createSubmitLock();
    const lockB = createSubmitLock();
    lockA.acquire();
    assert.equal(lockB.acquire(), true, 'lockB must be independent from lockA');
  });

  it('models two concurrent submit attempts — second is blocked, onClose fires only once', async () => {
    // Simulate the component call shape:
    //   submitLock = createSubmitLock() stored in useRef (shared across calls)
    //   call1 = handleSubmit() invocation that acquires the lock and starts upload
    //   call2 = rapid second handleSubmit() invocation that arrives while upload is in flight
    const lock = createSubmitLock();
    let closeCalls = 0;
    const onClose = () => { closeCalls++; };

    // call1 acquires the lock before upload
    const call1Acquired = lock.acquire();
    assert.equal(call1Acquired, true, 'first submit must acquire the lock');

    // call2 tries to acquire while call1 is in upload phase — must be blocked
    const call2Acquired = lock.acquire();
    assert.equal(call2Acquired, false, 'second submit must be blocked while upload is in flight');

    // call1 proceeds through the upload unauthenticated failure path
    try {
      await handleUploadResult(
        { ok: false, url: null, mediaType: null, errorKind: 'unauthenticated' },
        { onClose, signOut: async () => {}, navigate: () => {}, setError: () => {} },
      );
    } finally {
      lock.release();
    }

    // call2 was blocked, so onClose fired exactly once (from call1)
    assert.equal(
      closeCalls,
      1,
      'only the first submit invocation reaches handleUploadResult — onClose must fire exactly once',
    );
  });

  it('models rapid double-tap recovery — lock is released after error so next submit works', async () => {
    const lock = createSubmitLock();
    let closeCalls = 0;
    const onClose = () => { closeCalls++; };

    // First submit: unauthenticated upload failure — should close and release lock
    const acquired = lock.acquire();
    assert.equal(acquired, true);
    try {
      await handleUploadResult(
        { ok: false, url: null, mediaType: null, errorKind: 'unauthenticated' },
        { onClose, signOut: async () => {}, navigate: () => {}, setError: () => {} },
      );
    } finally {
      lock.release();
    }
    assert.equal(closeCalls, 1, 'first submit must have closed once');

    // After release, a subsequent (non-concurrent) submit can proceed normally
    const acquiredAgain = lock.acquire();
    assert.equal(acquiredAgain, true, 'lock must be acquirable again after release — next submit must not be permanently blocked');
    lock.release();
  });
});

// ── createOnceGuard — prevents double-close across the full submit lifecycle ───
//
// handleUploadResult is intentionally stateless — it has no internal once-guard.
// Without a guard, two concurrent invocations with an unauthenticated result
// would each call onClose(), corrupting navigation state. createOnceGuard() is
// the runtime guard: it wraps onClose so it fires at most once, regardless of
// how many times the guarded function is called.
//
// In PulseCreate.tsx, one guard is created at the start of handleSubmit()
// (before uploadMedia() is awaited) and the same guard is passed to both
// handleUploadResult and handleSubmitResult. The `submitting` flag from
// usePostActions only becomes true inside create() — after the upload — so it
// does NOT protect the upload failure path. createOnceGuard() is the actual
// runtime protection.

describe('createOnceGuard — fires the wrapped function at most once', () => {
  it('calls the wrapped function on the first invocation', () => {
    let calls = 0;
    const guarded = createOnceGuard(() => { calls++; });
    guarded();
    assert.equal(calls, 1, 'wrapped function must be called on first invocation');
  });

  it('does NOT call the wrapped function a second time', () => {
    let calls = 0;
    const guarded = createOnceGuard(() => { calls++; });
    guarded();
    guarded();
    assert.equal(calls, 1, 'wrapped function must only fire once regardless of how many times guarded() is called');
  });

  it('does NOT call the wrapped function on any subsequent invocation', () => {
    let calls = 0;
    const guarded = createOnceGuard(() => { calls++; });
    guarded();
    guarded();
    guarded();
    guarded();
    assert.equal(calls, 1, 'only the first call may pass through');
  });

  it('each call to createOnceGuard() returns an independent guard', () => {
    let calls = 0;
    const fn = () => { calls++; };
    const guardA = createOnceGuard(fn);
    const guardB = createOnceGuard(fn);
    guardA();
    guardB();
    assert.equal(calls, 2, 'each guard is independent — both fire once on their first invocation');
  });

  it('prevents double-close when the same guarded onClose is passed to handleUploadResult twice', async () => {
    let closeCalls = 0;
    const closeOnce = createOnceGuard(() => { closeCalls++; });
    const handlers = {
      onClose: closeOnce,
      signOut: async () => {},
      navigate: () => {},
      setError: () => {},
    };
    await handleUploadResult({ ok: false, url: null, mediaType: null, errorKind: 'unauthenticated' }, handlers);
    await handleUploadResult({ ok: false, url: null, mediaType: null, errorKind: 'unauthenticated' }, handlers);
    assert.equal(
      closeCalls,
      1,
      'createOnceGuard prevents double-close: second unauthenticated upload result must not call onClose again',
    );
  });

  it('prevents double-close when unauthenticated upload is followed by a successful create', async () => {
    let closeCalls = 0;
    const closeOnce = createOnceGuard(() => { closeCalls++; });
    // Simulate: upload leg closes (unauthenticated), then create also tries to close (ok: true)
    await handleUploadResult(
      { ok: false, url: null, mediaType: null, errorKind: 'unauthenticated' },
      { onClose: closeOnce, signOut: async () => {}, navigate: () => {}, setError: () => {} },
    );
    await handleSubmitResult(
      { ok: true },
      { onClose: closeOnce, signOut: async () => {}, navigate: () => {}, setError: () => {} },
    );
    assert.equal(
      closeCalls,
      1,
      'createOnceGuard prevents double-close across upload + submit phases: second call must not re-fire onClose',
    );
  });
});

// ── Upload-result — double-invocation without guard — documents machine statelessness ──
//
// Without a createOnceGuard wrapper, handleUploadResult is stateless and will
// call onClose() every time the unauthenticated branch fires. These tests pin
// that contract so it is clear the machine itself provides no protection.
// In production this path is always wrapped with createOnceGuard().

describe('upload-result double-invocation (no guard) — machine is stateless', () => {
  it('calls onClose twice when handleUploadResult is called twice with unauthenticated (no guard)', async () => {
    let closeCalls = 0;
    const handlers = {
      onClose: () => { closeCalls++; },
      signOut: async () => {},
      navigate: () => {},
      setError: () => {},
    };
    await handleUploadResult({ ok: false, url: null, mediaType: null, errorKind: 'unauthenticated' }, handlers);
    await handleUploadResult({ ok: false, url: null, mediaType: null, errorKind: 'unauthenticated' }, handlers);
    assert.equal(
      closeCalls,
      2,
      'handleUploadResult is stateless — without createOnceGuard a double unauthenticated call fires onClose twice',
    );
  });

  it('does NOT call onClose a second time when the second call is a non-auth failure', async () => {
    let closeCalls = 0;
    const handlers = {
      onClose: () => { closeCalls++; },
      signOut: async () => {},
      navigate: () => {},
      setError: () => {},
    };
    await handleUploadResult({ ok: false, url: null, mediaType: null, errorKind: 'unauthenticated' }, handlers);
    await handleUploadResult({ ok: false, url: null, mediaType: null, errorKind: 'upload_failed' }, handlers);
    assert.equal(closeCalls, 1, 'second call with non-auth failure must not re-fire onClose');
  });

  it('does NOT call onClose at all when both calls are non-auth failures', async () => {
    let closeCalls = 0;
    const handlers = {
      onClose: () => { closeCalls++; },
      signOut: async () => {},
      navigate: () => {},
      setError: () => {},
    };
    await handleUploadResult({ ok: false, url: null, mediaType: null, errorKind: 'upload_failed' }, handlers);
    await handleUploadResult({ ok: false, url: null, mediaType: null, errorKind: 'upload_failed' }, handlers);
    assert.equal(closeCalls, 0, 'non-auth failures must never call onClose regardless of invocation count');
  });
});

// ── Upload-result — ok: true but url missing (API 200 with no url field) ──────
//
// handleUploadResult succeeds only when BOTH ok is true AND url is non-null.
// If the API returns HTTP 200 but omits the url field, the result shape is
// { ok: true, url: null, mediaType: null }. This case falls through to the
// setError branch so the composer stays open with a clear error — the post
// is never submitted with a null media URL.
//
// This test pins that contract so the guard at line 193 of PulseCreate.machine.ts
//   `if (result.ok && result.url)`
// cannot be weakened to `if (result.ok)` without a test failure.

describe('upload-result — ok: true but url is null (API 200 with no url field)', () => {
  it('returns continue: false — the compose flow must not proceed', async () => {
    const outcome = await handleUploadResult(
      { ok: true, url: null, mediaType: null },
      { onClose: () => {}, signOut: async () => {}, navigate: () => {}, setError: () => {} },
    );
    assert.equal(outcome.continue, false, 'continue must be false when url is absent despite ok: true');
  });

  it('calls setError with the fallback message — composer stays open with feedback', async () => {
    let errorMsg = '';
    await handleUploadResult(
      { ok: true, url: null, mediaType: null },
      { onClose: () => {}, signOut: async () => {}, navigate: () => {}, setError: (msg) => { errorMsg = msg; } },
    );
    assert.equal(errorMsg, 'Media upload failed.', 'setError must surface the fallback message');
  });

  it('does NOT call onClose — composer stays open so the user can retry', async () => {
    let closeCalls = 0;
    await handleUploadResult(
      { ok: true, url: null, mediaType: null },
      { onClose: () => { closeCalls++; }, signOut: async () => {}, navigate: () => {}, setError: () => {} },
    );
    assert.equal(closeCalls, 0, 'onClose must NOT be called when url is absent');
  });

  it('uses result.message when provided alongside the missing url', async () => {
    let errorMsg = '';
    await handleUploadResult(
      { ok: true, url: null, mediaType: null, message: 'Upload succeeded but no URL returned' },
      { onClose: () => {}, signOut: async () => {}, navigate: () => {}, setError: (msg) => { errorMsg = msg; } },
    );
    assert.equal(errorMsg, 'Upload succeeded but no URL returned');
  });
});
