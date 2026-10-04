/**
 * Telegraph §22 on the client — a send the server paused is not a send that
 * dropped (`lifecycle/readState.ts`, and its wiring on both chat screens).
 *
 * WHY THIS EXISTS. The server's burst limit used to guard one send door and now
 * guards all of them, so a 429 is a refusal a real person can meet. Before this
 * change the client folded `rate_limited` into `db_error`, both chat screens drew
 * the literal words "Tap to retry", and a tap inside the window was refused
 * again — which reads as the app being broken. The row now says what happened
 * and roughly when to come back.
 *
 * A node:test file (not a jest component test) on purpose: everything asserted
 * here is either a pure function or a statement about source, so it runs
 * wherever node runs. The two chat screens cannot be mounted under jest-expo
 * (census-telegraph §41.7), so their wiring is held the way that section holds
 * it — by source assertions. WHAT SECTION C DOES NOT SHOW: a rendered row on a
 * device. It shows the reason is recorded, passed and drawn in source; reading
 * the row under a refused message needs a tester who sends past the limit.
 *
 * SHOWN RED FIRST: against a pristine copy of `main` at `f71cfb85f`, all nine
 * cases fail (`sendFailureFrom` is not exported, so the file does not load).
 * Eight mutations after the change, each applied alone and restored by sha256,
 * all killed:
 *   • `failedSendCopy` returns 'Tap to retry' for rate_limited   → A3, A4, A6.
 *   • `sendFailureFrom` ignores `ok`                              → A2.
 *   • the wait rounded DOWN                                       → A4.
 *   • a stale reason shown while the message is sending again     → A6.
 *   • 'rate_limited' removed from the transport's `known` list    → C1.
 *   • a hook's `sendFailure: sendFailureFrom(res)` removed        → C2.
 *   • a retry that keeps the old reason                           → C2.
 *   • a screen's `{failedSendCopy(sendFailure)}` put back to text → C3.
 *
 * Run: node --import tsx --test src/features/telegraph/__tests__/sendFailure.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  failedSendCopy,
  ownMessageStatus,
  ownMessageStatusLabel,
  parseRetryAfterSeconds,
  sendFailureFrom,
} from '../lifecycle/readState.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '../../../..');
const read = (rel: string) => readFileSync(resolve(APP, rel), 'utf8');

describe('A. what a failed send may say', () => {
  it('A1. Retry-After is read as whole seconds, and anything else is "not stated"', () => {
    assert.equal(parseRetryAfterSeconds('237'), 237);
    assert.equal(parseRetryAfterSeconds(' 5 '), 5);
    // Not stated, unreadable, or nonsense: null, never a guessed number.
    for (const raw of [null, undefined, '', '0', '-3', '1.5', 'soon', 'Wed, 21 Oct 2026 07:28:00 GMT', '12345678']) {
      assert.equal(parseRetryAfterSeconds(raw as any), null, `raw ${JSON.stringify(raw)}`);
    }
  });

  it('A2. only a refused, rate-limited result carries a failure reason', () => {
    assert.deepEqual(
      sendFailureFrom({ ok: false, errorKind: 'rate_limited', retryAfterSeconds: 240 }),
      { kind: 'rate_limited', retryAfterSeconds: 240 },
    );
    // The server gave no wait: still rate-limited, wait unknown.
    assert.deepEqual(sendFailureFrom({ ok: false, errorKind: 'rate_limited' }), { kind: 'rate_limited', retryAfterSeconds: null });
    assert.deepEqual(sendFailureFrom({ ok: false, errorKind: 'rate_limited', retryAfterSeconds: Number.NaN }), { kind: 'rate_limited', retryAfterSeconds: null });
    // Every other failure keeps the words it had — this module does not claim
    // to know why a send failed unless the server said.
    for (const errorKind of ['db_error', 'forbidden', 'network_unreachable', 'invalid_payload', undefined]) {
      assert.equal(sendFailureFrom({ ok: false, errorKind }), null, `errorKind ${errorKind}`);
    }
    // A SUCCESS never carries one, whatever else the object holds.
    assert.equal(sendFailureFrom({ ok: true, errorKind: 'rate_limited', retryAfterSeconds: 60 }), null);
  });

  it('A3. THE POINT: a paused send does not say "Tap to retry"', () => {
    for (const s of [null, 1, 59, 60, 600]) {
      const copy = failedSendCopy({ kind: 'rate_limited', retryAfterSeconds: s });
      assert.ok(!/tap to retry/i.test(copy), `"${copy}" still tells the person to retry at once`);
      assert.match(copy, /sending too fast/i);
    }
  });

  it('A4. the wait is coarse and rounded UP — never a precise countdown this screen does not keep', () => {
    assert.equal(failedSendCopy({ kind: 'rate_limited', retryAfterSeconds: null }), 'Sending too fast · try again in a moment');
    assert.equal(failedSendCopy({ kind: 'rate_limited', retryAfterSeconds: 12 }), 'Sending too fast · try again in under a minute');
    assert.equal(failedSendCopy({ kind: 'rate_limited', retryAfterSeconds: 60 }), 'Sending too fast · try again in about 1 min');
    assert.equal(failedSendCopy({ kind: 'rate_limited', retryAfterSeconds: 61 }), 'Sending too fast · try again in about 2 min');
    assert.equal(failedSendCopy({ kind: 'rate_limited', retryAfterSeconds: 599 }), 'Sending too fast · try again in about 10 min');
  });

  it('A5. CONTROL: a failure with no stated reason keeps the words it always had', () => {
    assert.equal(failedSendCopy(null), 'Tap to retry');
    assert.equal(failedSendCopy(undefined), 'Tap to retry');
    assert.equal(ownMessageStatusLabel({ kind: 'failed' }, { isGroup: false }), 'Not sent · tap to retry');
  });

  it('A6. the status carries the reason only while the message is failed', () => {
    const failure = { kind: 'rate_limited' as const, retryAfterSeconds: 120 };
    const failed = ownMessageStatus({ deliveryStatus: 'failed', sendFailure: failure, receiptsState: 'ready' });
    assert.deepEqual(failed, { kind: 'failed', failure });
    assert.equal(ownMessageStatusLabel(failed, { isGroup: true }), 'Not sent · sending too fast · try again in about 2 min');
    // A stale reason left on a message that is sending again, or sent, is not shown.
    assert.deepEqual(ownMessageStatus({ deliveryStatus: 'sending', sendFailure: failure, receiptsState: 'ready' }), { kind: 'sending' });
    assert.deepEqual(ownMessageStatus({ deliveryStatus: 'sent', sendFailure: failure, receiptsState: 'ready' }), { kind: 'sent' });
    assert.deepEqual(ownMessageStatus({ deliveryStatus: 'failed', receiptsState: 'ready' }), { kind: 'failed' });
  });
});

describe('C. the reason reaches the screen — source wiring (these screens cannot be mounted under jest-expo)', () => {
  it('C1. the transport keeps `rate_limited` distinct and carries the server\'s Retry-After', () => {
    const src = read('src/services/messaging.ts');
    assert.match(src, /const known: MsgErrorKind\[\] = \[[^\]]*'rate_limited'[^\]]*\]/, '`rate_limited` is folded into db_error again');
    assert.match(src, /mapApiError<T>\(res\.status, await res\.json\(\)\.catch\(\(\) => \(\{\}\)\), res\.headers\?\.get\?\.\('Retry-After'\) \?\? null\)/);
    assert.match(src, /retryAfterSeconds: parseRetryAfterSeconds\(retryAfter\)/);
  });

  it('C2. both send hooks record why a send failed, on send AND on retry, and clear it while retrying', () => {
    for (const rel of ['src/hooks/useMessaging.ts', 'src/hooks/useGroupChat.ts']) {
      const src = read(rel);
      const recorded = src.match(/deliveryStatus: 'failed' as const, sendFailure: sendFailureFrom\(res\)/g) ?? [];
      assert.equal(recorded.length, 2, `${rel}: expected the send and the retry branch to record the reason, found ${recorded.length}`);
      assert.equal((src.match(/deliveryStatus: 'failed' as const \}/g) ?? []).length, 0, `${rel}: a failure branch drops the reason`);
      assert.match(src, /deliveryStatus: 'sending' as const, sendFailure: null/, `${rel}: a retry keeps showing the old reason`);
    }
  });

  it('C3. both chat screens draw the reason, not the literal words', () => {
    for (const rel of ['app/messages/[id].tsx', 'src/components/GroupChatScreen.tsx']) {
      const src = read(rel);
      assert.match(src, /\{failedSendCopy\(sendFailure\)\}/, `${rel} does not draw the failure reason`);
      assert.doesNotMatch(src, />Tap to retry</, `${rel} still draws the literal "Tap to retry"`);
      assert.match(src, /sendFailure=\{mine \? \(m\.sendFailure \?\? null\) : null\}/, `${rel} does not pass the reason to the bubble`);
    }
  });
});
