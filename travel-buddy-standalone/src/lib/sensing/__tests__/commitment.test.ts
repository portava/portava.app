/**
 * commitment — the device's hashes agree with the server's, byte for byte.
 *
 * The server derives the contributor token from the commitment the device
 * sends; a device that computed the commitment differently would still be
 * ACCEPTED (any 16..128-char string passes the schema) but could never
 * withdraw, because its revealed epoch secret would not hash to what it sent.
 * So the property under test is agreement with `node:crypto` on the exact
 * strings `artifacts/api-server/src/lib/sensingAnonStore.ts` hashes.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';

import {
  commitmentFor,
  deriveEpochSecret,
  deviceCommitment,
  deviceSecretFromBytes,
  hmacSha256Hex,
  sha256Hex,
} from '../commitment.ts';

const EPOCH_CONTEXT = 'sensing-anon/epoch/v1';

describe('SHA-256 and HMAC-SHA256 agree with node:crypto', () => {
  test('published vectors', () => {
    assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    // RFC 4231 test case 2
    assert.equal(
      hmacSha256Hex('Jefe', 'what do ya want for nothing?'),
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  test('random inputs, including multi-block messages and long keys', () => {
    for (let i = 0; i < 40; i++) {
      const msg = randomBytes(1 + Math.floor(Math.random() * 300)).toString('base64');
      const key = randomBytes(1 + Math.floor(Math.random() * 120)).toString('base64');
      assert.equal(sha256Hex(msg), createHash('sha256').update(msg).digest('hex'));
      assert.equal(hmacSha256Hex(key, msg), createHmac('sha256', key).update(msg).digest('hex'));
    }
  });
});

describe("the server's derivations, mirrored", () => {
  const deviceSecret = 'a-device-secret-that-never-leaves-the-device';

  test('deriveEpochSecret is the server\'s HMAC over the epoch context', () => {
    for (const epoch of [0, 1, 498_611, 2 ** 31]) {
      const expected = createHmac('sha256', deviceSecret).update(`${EPOCH_CONTEXT}|${epoch}`).digest('hex');
      assert.equal(deriveEpochSecret(deviceSecret, epoch), expected);
    }
  });

  test("commitmentFor is the server's SHA-256 over the canonicalised epoch secret", () => {
    const secret = deriveEpochSecret(deviceSecret, 7);
    assert.equal(commitmentFor(secret), createHash('sha256').update(secret.trim().toLowerCase()).digest('hex'));
    assert.equal(commitmentFor(`  ${secret.toUpperCase()}  `), commitmentFor(secret), 'canonicalisation matches the server');
  });

  test('the commitment is stable within an epoch and different across epochs', () => {
    assert.equal(deviceCommitment(deviceSecret, 7), deviceCommitment(deviceSecret, 7));
    assert.notEqual(deviceCommitment(deviceSecret, 7), deviceCommitment(deviceSecret, 8));
    assert.match(deviceCommitment(deviceSecret, 7), /^[0-9a-f]{64}$/, 'within the schema\'s 16..128 characters');
  });

  test('the commitment reveals neither the device secret nor the epoch secret', () => {
    const c = deviceCommitment(deviceSecret, 7);
    assert.ok(!c.includes(deviceSecret));
    assert.ok(!c.includes(deriveEpochSecret(deviceSecret, 7)));
  });

  test('a device secret needs 32 random bytes; fewer is refused', () => {
    assert.equal(deviceSecretFromBytes(new Uint8Array(32).fill(7)).length, 64);
    assert.throws(() => deviceSecretFromBytes(new Uint8Array(16)), /32 random bytes/);
    assert.throws(() => deriveEpochSecret('', 1), /device secret is required/);
    assert.throws(() => deriveEpochSecret(deviceSecret, -1), /non-negative/);
  });
});
