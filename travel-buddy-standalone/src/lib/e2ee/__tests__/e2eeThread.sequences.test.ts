/**
 * e2eeThread — the sequences, and what happens when each step fails.
 *
 * threadCrypto's suite covers the decisions. This one covers the ORDER, which
 * is where a thread nobody can ever read gets created. Every test here is a
 * failure mode a real messaging system hits: a peer with no KeyPackages, a
 * Welcome that does not deliver, a device receiving ciphertext for a group it
 * never joined.
 *
 * `establishE2ee` and `hydrateIncomingMessages` are exercised through
 * threadCrypto directly with an injected port, so the network layer is not
 * involved — the point is the sequencing, not the HTTP.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  establishE2ee,
  joinFromWelcomeIfNeeded,
  decryptIncoming,
  type CryptoPort,
} from '../threadCrypto.ts';

// ── Port ────────────────────────────────────────────────────────────────────

function makePort(over: Partial<CryptoPort> = {}): CryptoPort {
  const pending = new Map<string, string>();
  return {
    isNative: () => true,
    hasGroupSession: async () => true,
    encryptForThread: async () => 'CT',
    decryptFromThread: async () => 'plain',
    initGroupAsInitiator: async () => ({ welcomeB64: 'WELCOME' }),
    initGroupAsRecipient: async () => true,
    getDeviceSigningKeys: async () => ({ priv: 'PRIV', pub: 'PUB' }),
    getPendingKeyPackageState: async () => pending.get('k') ?? null,
    setPendingKeyPackageState: async (v) => { pending.set('k', v); },
    clearPendingKeyPackageState: async () => { pending.delete('k'); },
    ...over,
  };
}

function makeDeps(over: Record<string, unknown> = {}) {
  return {
    consumeKeyPackage: async () => 'PEER_KP',
    sendWelcome: async () => true,
    markThreadE2ee: async () => true,
    ...over,
  } as never;
}

// ── The ordering invariant ──────────────────────────────────────────────────

test('the Welcome is always sent before the thread is marked encrypted', async () => {
  const order: string[] = [];
  const r = await establishE2ee(makePort(), 't1', 'me', 'peer', makeDeps({
    consumeKeyPackage: async () => { order.push('consume'); return 'PEER_KP'; },
    sendWelcome: async () => { order.push('welcome'); return true; },
    markThreadE2ee: async () => { order.push('mark'); return true; },
  }));
  assert.equal(r.ok, true);
  assert.deepEqual(order, ['consume', 'welcome', 'mark']);
});

// ── Failure: KeyPackage missing or already consumed ─────────────────────────

test('peer has no KeyPackages — negotiation fails, thread stays usable', async () => {
  let welcomeSent = false;
  let marked = false;
  const r = await establishE2ee(makePort(), 't1', 'me', 'peer', makeDeps({
    consumeKeyPackage: async () => null,
    sendWelcome: async () => { welcomeSent = true; return true; },
    markThreadE2ee: async () => { marked = true; return true; },
  }));
  assert.equal(r.failure, 'no_key_package');
  assert.equal(welcomeSent, false, 'no group, so nothing to welcome anyone into');
  assert.equal(marked, false, 'a thread with no group must never be flagged encrypted');
});

test('KeyPackage already consumed by someone else behaves the same', async () => {
  // The server deletes on consume, so a race returns the same null.
  const r = await establishE2ee(makePort(), 't1', 'me', 'peer', makeDeps({
    consumeKeyPackage: async () => null,
  }));
  assert.equal(r.ok, false);
  assert.equal(r.failure, 'no_key_package');
});

// ── Failure: Welcome does not deliver ───────────────────────────────────────

test('Welcome delivery failure never leaves the thread flagged encrypted', async () => {
  let marked = false;
  const r = await establishE2ee(makePort(), 't1', 'me', 'peer', makeDeps({
    sendWelcome: async () => false,
    markThreadE2ee: async () => { marked = true; return true; },
  }));
  assert.equal(r.failure, 'welcome_delivery_failed');
  assert.equal(marked, false,
    'this is the unrecoverable case: flagged + no Welcome = nobody can ever read it');
});

test('a Welcome that throws is treated as undelivered, not as success', async () => {
  await assert.rejects(() => establishE2ee(makePort(), 't1', 'me', 'peer', makeDeps({
    sendWelcome: async () => { throw new Error('network'); },
  })));
  // Throwing propagates rather than being swallowed into ok:true — the caller
  // must not conclude the thread is encrypted.
});

test('server refusing to mark the thread is reported, not ignored', async () => {
  const r = await establishE2ee(makePort(), 't1', 'me', 'peer', makeDeps({
    markThreadE2ee: async () => false,
  }));
  assert.equal(r.ok, false);
});

// ── Failure: group creation ─────────────────────────────────────────────────

test('group creation failure stops before any server state changes', async () => {
  let welcomeSent = false;
  const r = await establishE2ee(
    makePort({ initGroupAsInitiator: async () => null }),
    't1', 'me', 'peer',
    makeDeps({ sendWelcome: async () => { welcomeSent = true; return true; } }),
  );
  assert.equal(r.failure, 'group_create_failed');
  assert.equal(welcomeSent, false);
});

test('no native module means no negotiation at all', async () => {
  const r = await establishE2ee(makePort({ isNative: () => false }), 't1', 'me', 'peer', makeDeps());
  assert.equal(r.failure, 'no_native_module');
});

// ── Failure: receiving on a device with no group state ──────────────────────

test('a device with no group state marks incoming ciphertext failed, not blank', async () => {
  const port = makePort({ hasGroupSession: async () => false });
  const out = await decryptIncoming(port, 't1', { id: 'm1', ciphertext: 'CT' });
  assert.equal(out.failed, true);
  assert.equal(out.body, null);
});

test('that device still renders plaintext system messages in the same thread', async () => {
  // Mixed content is the normal case straight after negotiation: the Welcome is
  // plaintext, everything after it is not.
  const port = makePort({ hasGroupSession: async () => false });
  const out = await decryptIncoming(port, 't1', { id: 'm1', body: 'hello' });
  assert.equal(out.failed, false);
  assert.equal(out.body, 'hello');
});

test('a device that never joined does not silently self-heal on later fetches', async () => {
  // No pending KeyPackage state — e.g. a reinstall. Under decision C1 this is
  // unrecoverable, and it must stay visibly unreadable rather than appear to work.
  const port = makePort({ hasGroupSession: async () => false });
  const joined = await joinFromWelcomeIfNeeded(port, 't1', [
    { id: 'w', msgType: 'system', subtype: 'e2ee_welcome', body: 'WELCOME' },
  ]);
  assert.equal(joined, false);

  const out = await decryptIncoming(port, 't1', { id: 'm1', ciphertext: 'CT' });
  assert.equal(out.failed, true);
});

// ── Recipient's first fetch ─────────────────────────────────────────────────

test('recipient joins from the Welcome on first fetch, then decrypts', async () => {
  let joinedOnce = false;
  const port = makePort({
    hasGroupSession: async () => joinedOnce,
    initGroupAsRecipient: async () => { joinedOnce = true; return true; },
    getPendingKeyPackageState: async () => 'PENDING',
  });

  const joined = await joinFromWelcomeIfNeeded(port, 't1', [
    { id: 'w', msgType: 'system', subtype: 'e2ee_welcome', body: 'WELCOME' },
  ]);
  assert.equal(joined, true);

  const out = await decryptIncoming(port, 't1', { id: 'm1', ciphertext: 'CT' });
  assert.equal(out.failed, false);
  assert.equal(out.body, 'plain');
});
