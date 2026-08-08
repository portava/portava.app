/**
 * threadCrypto — failure paths.
 *
 * The happy path is the least interesting thing here. What matters is that an
 * E2EE thread cannot produce a plaintext send under ANY failure, because that
 * is the one outcome worse than an error: the user has already trusted the lock
 * icon by the time they hit send.
 *
 * Runs under node:test against an injected CryptoPort. The real port lives in
 * ../realPort.ts and is the only file that touches mlsSession/secureStore —
 * those pull in expo-modules-core, which is exactly why the E-0/E-1/E-2 suites
 * are in run-node-tests.mjs's exclude list and have never executed. Keeping the
 * decision logic port-shaped is what makes this suite runnable at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// ── Stubs ───────────────────────────────────────────────────────────────────

type State = {
  native: boolean;
  hasSession: boolean;
  encryptResult: string | null;
  encryptThrows: boolean;
  decryptResult: string | null;
  decryptThrows: boolean;
  joinResult: boolean;
  initiatorResult: { welcomeB64: string } | null;
};

const state: State = {
  native: true,
  hasSession: true,
  encryptResult: 'CIPHERTEXT',
  encryptThrows: false,
  decryptResult: 'plain',
  decryptThrows: false,
  joinResult: true,
  initiatorResult: { welcomeB64: 'WELCOME' },
};

function reset() {
  state.native = true;
  state.hasSession = true;
  state.encryptResult = 'CIPHERTEXT';
  state.encryptThrows = false;
  state.decryptResult = 'plain';
  state.decryptThrows = false;
  state.joinResult = true;
  state.initiatorResult = { welcomeB64: 'WELCOME' };
  pending.clear();
}

const pending = new Map<string, string>();

const port = {
  isNative: () => state.native,
  hasGroupSession: async () => state.hasSession,
  encryptForThread: async () => {
    if (state.encryptThrows) throw new Error('boom');
    return state.encryptResult;
  },
  decryptFromThread: async () => {
    if (state.decryptThrows) throw new Error('boom');
    return state.decryptResult;
  },
  initGroupAsInitiator: async () => state.initiatorResult,
  initGroupAsRecipient: async () => state.joinResult,
  getDeviceSigningKeys: async () => ({ priv: 'PRIV', pub: 'PUB' }),
  getPendingKeyPackageState: async () => pending.get('k') ?? null,
  setPendingKeyPackageState: async (v: string) => { pending.set('k', v); },
  clearPendingKeyPackageState: async () => { pending.delete('k'); },
};

import * as tc from '../threadCrypto.ts';

// ── Send path: the rule ─────────────────────────────────────────────────────

test('plaintext thread is untouched — the existing path must not change', async () => {
  reset();
  const payload = await tc.buildOutgoingPayload(port, 't1', 'hello', false);
  assert.deepEqual(payload, { body: 'hello' });
});

test('E2EE thread produces ciphertext and no body', async () => {
  reset();
  const payload = await tc.buildOutgoingPayload(port, 't1', 'hello', true);
  assert.equal(payload.ciphertext, 'CIPHERTEXT');
  assert.equal(payload.body, undefined, 'a body alongside ciphertext could be persisted in the clear');
});

test('no native module on an E2EE thread THROWS — never plaintext', async () => {
  reset();
  state.native = false;
  await assert.rejects(
    () => tc.buildOutgoingPayload(port, 't1', 'secret', true),
    (e: Error & { reason?: string }) => e.name === 'E2eeSendBlockedError' && e.reason === 'no_native_module',
  );
});

test('no group state on an E2EE thread THROWS — never plaintext', async () => {
  reset();
  state.hasSession = false;
  await assert.rejects(
    () => tc.buildOutgoingPayload(port, 't1', 'secret', true),
    (e: Error & { reason?: string }) => e.reason === 'no_group_state',
  );
});

test('encrypt returning null THROWS — the null must not sail past as "no ciphertext"', async () => {
  reset();
  state.encryptResult = null;
  await assert.rejects(
    () => tc.buildOutgoingPayload(port, 't1', 'secret', true),
    (e: Error & { reason?: string }) => e.reason === 'encrypt_failed',
  );
});

test('encrypt throwing THROWS — the catch must not degrade to plaintext', async () => {
  reset();
  state.encryptThrows = true;
  await assert.rejects(
    () => tc.buildOutgoingPayload(port, 't1', 'secret', true),
    (e: Error & { reason?: string }) => e.reason === 'encrypt_failed',
  );
});

test('no failure path ever yields a body on an E2EE thread', async () => {
  // Belt and braces: sweep every failure and assert none returns plaintext.
  const failures = [
    () => { state.native = false; },
    () => { state.hasSession = false; },
    () => { state.encryptResult = null; },
    () => { state.encryptThrows = true; },
  ];
  for (const apply of failures) {
    reset();
    apply();
    let payload: unknown = null;
    try {
      payload = await tc.buildOutgoingPayload(port, 't1', 'secret', true);
    } catch {
      continue; // threw — correct
    }
    assert.fail(`a failure path returned a payload instead of throwing: ${JSON.stringify(payload)}`);
  }
});

// ── Receive path ────────────────────────────────────────────────────────────

test('plaintext message passes through', async () => {
  reset();
  const out = await tc.decryptIncoming(port, 't1', { id: 'm1', body: 'hi' });
  assert.deepEqual(out, { id: 'm1', body: 'hi', failed: false });
});

test('decrypt failure is surfaced, not hidden', async () => {
  reset();
  state.decryptResult = null;
  const out = await tc.decryptIncoming(port, 't1', { id: 'm1', ciphertext: 'X' });
  assert.equal(out.failed, true);
  assert.equal(out.body, null);
});

test('decrypt throwing is surfaced, not swallowed into a blank message', async () => {
  reset();
  state.decryptThrows = true;
  const out = await tc.decryptIncoming(port, 't1', { id: 'm1', ciphertext: 'X' });
  assert.equal(out.failed, true);
});

test('ciphertext with no group state on this device is marked failed', async () => {
  reset();
  state.hasSession = false;
  const out = await tc.decryptIncoming(port, 't1', { id: 'm1', ciphertext: 'X' });
  assert.equal(out.failed, true);
});

// ── Welcome / join ──────────────────────────────────────────────────────────

test('joins from a Welcome and clears the pending KeyPackage state', async () => {
  reset();
  state.hasSession = false;
  await port.setPendingKeyPackageState('PENDING');
  const joined = await tc.joinFromWelcomeIfNeeded(port, 't1', [
    { id: 'm1', msgType: 'system', subtype: 'e2ee_welcome', body: 'WELCOME' },
  ]);
  assert.equal(joined, true);
  assert.equal(await port.getPendingKeyPackageState(), null, 'one-shot: must not be reusable');
});

test('a Welcome with no pending state does not join — unrecoverable by design', async () => {
  reset();
  state.hasSession = false;
  const joined = await tc.joinFromWelcomeIfNeeded(port, 't1', [
    { id: 'm1', msgType: 'system', subtype: 'e2ee_welcome', body: 'WELCOME' },
  ]);
  assert.equal(joined, false);
});

test('replaying the message list does not clobber a live session', async () => {
  reset();
  state.hasSession = true; // already joined
  await port.setPendingKeyPackageState('PENDING');
  const joined = await tc.joinFromWelcomeIfNeeded(port, 't1', [
    { id: 'm1', msgType: 'system', subtype: 'e2ee_welcome', body: 'WELCOME' },
  ]);
  assert.equal(joined, false, 'a second fetch must not rejoin at a stale epoch');
});

// ── Negotiation ─────────────────────────────────────────────────────────────

function deps(over: Partial<Record<string, unknown>> = {}) {
  return {
    consumeKeyPackage: async () => 'PEER_KP',
    sendWelcome: async () => true,
    markThreadE2ee: async () => true,
    ...over,
  } as never;
}

test('negotiation succeeds and marks the thread last', async () => {
  reset();
  const order: string[] = [];
  const r = await tc.establishE2ee(port, 't1', 'u1', 'u2', deps({
    sendWelcome: async () => { order.push('welcome'); return true; },
    markThreadE2ee: async () => { order.push('mark'); return true; },
  }));
  assert.equal(r.ok, true);
  assert.deepEqual(order, ['welcome', 'mark'],
    'is_e2ee must be set AFTER the Welcome, or the plaintext Welcome is rejected');
});

test('missing or already-consumed KeyPackage fails visibly and leaves the thread plaintext', async () => {
  reset();
  const r = await tc.establishE2ee(port, 't1', 'u1', 'u2', deps({ consumeKeyPackage: async () => null }));
  assert.equal(r.ok, false);
  assert.equal(r.failure, 'no_key_package');
});

test('Welcome delivery failure aborts before the thread is marked encrypted', async () => {
  reset();
  let marked = false;
  const r = await tc.establishE2ee(port, 't1', 'u1', 'u2', deps({
    sendWelcome: async () => false,
    markThreadE2ee: async () => { marked = true; return true; },
  }));
  assert.equal(r.ok, false);
  assert.equal(r.failure, 'welcome_delivery_failed');
  assert.equal(marked, false, 'a thread nobody can read must never be marked encrypted');
});

test('group creation failure aborts negotiation', async () => {
  reset();
  state.initiatorResult = null;
  const r = await tc.establishE2ee(port, 't1', 'u1', 'u2', deps());
  assert.equal(r.ok, false);
  assert.equal(r.failure, 'group_create_failed');
});
