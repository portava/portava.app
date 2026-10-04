/**
 * One Idempotency-Key per booking-creation ATTEMPT (payments PAY-T12).
 *
 * THE DEFECT. A creation request whose answer never arrived left the traveller
 * with an error and a booking they could not see; tapping again made a second
 * booking and a second earnings ledger. Nothing tied the retry to the first try.
 *
 *   K1  a request whose answer is LOST (no answer, or a 5xx) keeps its key, so
 *       the retry carries the SAME key and the server returns the original;
 *   K2  a DEFINITE answer ends the attempt: success, or a 4xx refusal — the next
 *       request is a new attempt with a new key;
 *   K3  a different payload, or a different resource, is a different attempt;
 *   K4  the key has the shape the server accepts;
 *   K5  the four service functions that create a booking all send through the
 *       registry, and nothing else builds a creation request by hand.
 *
 * The server half (the key stored on the booking behind a unique index, the
 * retry answered with the original) is
 * artifacts/api-server/src/test/rentABuddyGateConsolidation.test.ts and the
 * database test's group K.
 *
 * Run via:
 *   node --import tsx/esm --test src/services/__tests__/rentABuddy.creationKey.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CREATION_KEY_RE,
  createAttemptRegistry,
  isDefiniteAnswer,
  mintCreationKey,
  type CreationResult,
} from '../rentABuddyCreation.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/** A registry whose keys are k1, k2, … and a sender that records what it was given. */
function harness(answers: Array<CreationResult<{ id: string }> | Error>) {
  let n = 0;
  const registry = createAttemptRegistry(() => `key-${String(++n).padStart(6, '0')}`);
  const sent: string[] = [];
  let i = 0;
  const send = async (headers: { 'Idempotency-Key': string }) => {
    sent.push(headers['Idempotency-Key']);
    const a = answers[Math.min(i++, answers.length - 1)]!;
    if (a instanceof Error) throw a;
    return a;
  };
  return { registry, sent, send };
}
const OK: CreationResult<{ id: string }> = { ok: true, data: { id: 'bk-1' } };
const PAYLOAD = { buddyId: 'b1', bookingDate: '2026-11-01', durationH: 2, city: 'Lisbon' };

describe('an attempt keeps its key until the server answers definitely', () => {
  it('K1 no answer at all (a network error): the retry carries the SAME key', async () => {
    const { registry, sent, send } = harness([{ ok: false, error: 'Network request failed' }, OK]);
    const first = await registry.send('book:b1', PAYLOAD, send);
    assert.equal(first.ok, false);
    assert.equal(registry.size(), 1, 'the attempt is still in doubt');
    const second = await registry.send('book:b1', PAYLOAD, send);
    assert.equal(second.ok, true);
    assert.deepEqual(sent, ['key-000001', 'key-000001'], 'a retry after a lost answer must not look like a new booking');
    assert.equal(registry.size(), 0);
  });

  it('K1 a 5xx is UNKNOWN — the booking may exist: the key is kept', async () => {
    const { registry, sent, send } = harness([
      { ok: false, error: 'ledger_write_failed', status: 503 },
      { ok: false, error: 'HTTP 502', status: 502 },
      OK,
    ]);
    await registry.send('book:b1', PAYLOAD, send);
    await registry.send('book:b1', PAYLOAD, send);
    await registry.send('book:b1', PAYLOAD, send);
    assert.deepEqual(sent, ['key-000001', 'key-000001', 'key-000001']);
  });

  it('K1 a send that THROWS is an unknown outcome too: reported, and the key is kept', async () => {
    const { registry, sent, send } = harness([new Error('socket hang up'), OK]);
    const first = await registry.send('book:b1', PAYLOAD, send);
    assert.deepEqual(first, { ok: false, error: 'socket hang up' });
    await registry.send('book:b1', PAYLOAD, send);
    assert.deepEqual(sent, ['key-000001', 'key-000001']);
  });

  it('K1 the same payload with its keys in another order is the same attempt', async () => {
    const { registry, sent, send } = harness([{ ok: false, error: 'timeout' }, OK]);
    await registry.send('book:b1', { a: 1, b: { c: 2, d: [1, 2] }, e: undefined }, send);
    await registry.send('book:b1', { b: { d: [1, 2], c: 2 }, a: 1 }, send);
    assert.deepEqual(sent, ['key-000001', 'key-000001']);
  });

  it('K2 success ends the attempt: booking the same thing AGAIN, deliberately, is a new booking', async () => {
    const { registry, sent, send } = harness([OK, OK]);
    await registry.send('book:b1', PAYLOAD, send);
    await registry.send('book:b1', PAYLOAD, send);
    assert.deepEqual(sent, ['key-000001', 'key-000002']);
  });

  it('K2 a 4xx refusal ends the attempt: nothing was created, and a corrected request is a new one', async () => {
    for (const status of [400, 403, 404, 409, 422]) {
      const { registry, sent, send } = harness([{ ok: false, error: 'ledger_refused', status }, OK]);
      await registry.send('book:b1', PAYLOAD, send);
      assert.equal(registry.size(), 0, String(status));
      await registry.send('book:b1', PAYLOAD, send);
      assert.deepEqual(sent, ['key-000001', 'key-000002'], String(status));
    }
  });

  it('K3 another payload, or another resource, is another attempt with another key', async () => {
    const { registry, sent, send } = harness([{ ok: false, error: 'timeout' }]);
    await registry.send('book:b1', PAYLOAD, send);
    await registry.send('book:b1', { ...PAYLOAD, bookingDate: '2026-11-02' }, send);
    await registry.send('book:b2', PAYLOAD, send);
    await registry.send('offer:o1', null, send);
    await registry.send('offer:o2', null, send);
    assert.deepEqual(sent, ['key-000001', 'key-000002', 'key-000003', 'key-000004', 'key-000005']);
    // …and each is remembered separately.
    await registry.send('offer:o1', null, send);
    assert.equal(sent.at(-1), 'key-000004');
  });

  it('isDefiniteAnswer: success and 4xx are definite; no status and 5xx are not', () => {
    assert.equal(isDefiniteAnswer({ ok: true, data: {} }), true);
    for (const status of [400, 401, 403, 404, 409, 422, 499]) assert.equal(isDefiniteAnswer({ ok: false, error: 'x', status }), true, String(status));
    for (const status of [500, 502, 503, 504, 399, undefined]) assert.equal(isDefiniteAnswer({ ok: false, error: 'x', status }), false, String(status));
  });
});

describe('the key', () => {
  it('K4 has the shape the server accepts, with and without crypto.randomUUID', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const k = mintCreationKey();
      assert.match(k, CREATION_KEY_RE, k);
      seen.add(k);
    }
    assert.equal(seen.size, 200, 'two attempts were given the same key');

    const g = globalThis as any;
    const real = Object.getOwnPropertyDescriptor(g, 'crypto');
    Object.defineProperty(g, 'crypto', { value: undefined, configurable: true });
    try {
      const fallback = new Set<string>();
      for (let i = 0; i < 200; i++) {
        const k = mintCreationKey();
        assert.match(k, CREATION_KEY_RE, k);
        fallback.add(k);
      }
      assert.equal(fallback.size, 200);
    } finally {
      if (real) Object.defineProperty(g, 'crypto', real); else delete g.crypto;
    }
  });

  it('the client pattern is the server\'s (lib/rentBuddyEarningsLedger.ts#CREATION_KEY_RE)', () => {
    const server = readFileSync(join(HERE, '../../../../artifacts/api-server/src/lib/rentBuddyEarningsLedger.ts'), 'utf8');
    const m = server.match(/export const CREATION_KEY_RE = (\/.+\/);/);
    assert.ok(m, 'the server no longer exports CREATION_KEY_RE');
    assert.equal(m![1], String(CREATION_KEY_RE));
  });
});

describe('every booking-creation request goes through the registry', () => {
  const service = readFileSync(join(HERE, '../rentABuddy.ts'), 'utf8');
  const bodyOf = (fn: string) => {
    const at = service.indexOf(`export async function ${fn}(`);
    assert.notEqual(at, -1, `${fn} is gone`);
    return service.slice(at, service.indexOf('\n}\n', at));
  };

  it('K5 createBooking, rebookBooking, acceptOffer and bookPackage send an Idempotency-Key scoped by the resource', () => {
    const EXPECTED: Record<string, string> = {
      createBooking: 'creationAttempts.send(`book:${payload.buddyId}`, payload,',
      rebookBooking: 'creationAttempts.send(`rebook:${originalBookingId}`, payload,',
      acceptOffer: 'creationAttempts.send(`offer:${offerId}`, null,',
      bookPackage: 'creationAttempts.send(`package:${packageId}`, payload,',
    };
    for (const [fn, call] of Object.entries(EXPECTED)) {
      const body = bodyOf(fn);
      assert.ok(body.includes(call), `${fn} does not send through the attempt registry`);
      assert.match(body, /method: 'POST', headers/, `${fn} does not pass the registry's headers to the request`);
    }
  });

  it('apiFetch reports the HTTP status of a refusal — without it a 4xx and a 5xx could not be told apart', () => {
    assert.match(service, /error: \(body as any\)\?\.error \?\? `HTTP \$\{res\.status\}`, status: res\.status,/);
  });

  it('an offer no longer carries a deposit or a cash split from the client', () => {
    const body = bodyOf('submitOffer');
    assert.equal(/depositAmountUsd|cashBalanceDue/.test(body.replace(/\/\/[^\n]*/g, '')), false,
      'the deposit is not the client\'s to name: the server stores the database\'s terms');
  });
});
