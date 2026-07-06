/**
 * inviteRetryGuard.test.ts
 *
 * Unit tests for the pure retry-guard logic in src/lib/inviteRetryGuard.ts.
 *
 * Critical invariants:
 *   - 4xx responses are NEVER retried (they are definitive server decisions).
 *   - 409 (already-member idempotency signal) must not trigger a retry.
 *   - 410 (link revoked/expired/exhausted) must not trigger a retry.
 *   - 5xx responses are always retriable (transient failures).
 *   - MAX_INVITE_ACCEPT_ATTEMPTS must be 3 (matches acceptInviteByToken loop).
 *
 * Pure function; zero React Native / Supabase dependencies.
 * Run: node --import tsx/esm --test src/lib/__tests__/inviteRetryGuard.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isRetriableStatus, MAX_INVITE_ACCEPT_ATTEMPTS, retryDelayMs } from '../inviteRetryGuard.ts';

describe('isRetriableStatus() — 4xx must NEVER be retried', () => {
  it('does not retry 400 Bad Request', () => {
    assert.equal(isRetriableStatus(400), false);
  });

  it('does not retry 401 Unauthorized', () => {
    assert.equal(isRetriableStatus(401), false);
  });

  it('does not retry 403 Forbidden', () => {
    assert.equal(isRetriableStatus(403), false);
  });

  it('does not retry 409 Conflict (already-member idempotency signal)', () => {
    assert.equal(
      isRetriableStatus(409),
      false,
      '409 is the idempotency guard — retrying would risk a duplicate-member insert',
    );
  });

  it('does not retry 410 Gone (link revoked, expired, or exhausted)', () => {
    assert.equal(
      isRetriableStatus(410),
      false,
      '410 is a definitive tombstone — retrying would loop forever',
    );
  });

  it('does not retry 422 Unprocessable Entity', () => {
    assert.equal(isRetriableStatus(422), false);
  });

  it('does not retry 429 Too Many Requests', () => {
    assert.equal(isRetriableStatus(429), false, '429 back-off is handled by the caller, not via retry');
  });
});

describe('isRetriableStatus() — 5xx should be retried', () => {
  it('retries 500 Internal Server Error', () => {
    assert.equal(isRetriableStatus(500), true);
  });

  it('retries 502 Bad Gateway', () => {
    assert.equal(isRetriableStatus(502), true);
  });

  it('retries 503 Service Unavailable', () => {
    assert.equal(isRetriableStatus(503), true);
  });

  it('retries 504 Gateway Timeout', () => {
    assert.equal(isRetriableStatus(504), true);
  });
});

describe('MAX_INVITE_ACCEPT_ATTEMPTS', () => {
  it('is exactly 3 (matches the loop in acceptInviteByToken)', () => {
    assert.equal(MAX_INVITE_ACCEPT_ATTEMPTS, 3);
  });
});

describe('retryDelayMs()', () => {
  it('has zero delay for the first attempt', () => {
    assert.equal(retryDelayMs(0), 0);
  });

  it('delays 500 ms before the second attempt', () => {
    assert.equal(retryDelayMs(1), 500);
  });

  it('delays 1000 ms before the third attempt', () => {
    assert.equal(retryDelayMs(2), 1000);
  });
});
