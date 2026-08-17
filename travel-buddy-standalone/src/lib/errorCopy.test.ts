/**
 * errorCopy — the domain-neutral "never show a machine string" rule.
 *
 * The cases below are not invented: each is a string some service in this repo
 * actually puts into `error`, cited by file and line.
 *
 * Run via: node --import tsx/esm --test src/lib/errorCopy.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { errorCopy, isMachineString } from './errorCopy.ts';

const FALLBACK = 'Could not block user';

describe('isMachineString', () => {
  it('flags the shapes services in this repo really produce', () => {
    // services/rentABuddy.ts apiFetch — a bare server code
    assert.equal(isMachineString('verification_unavailable'), true);
    assert.equal(isMachineString('db_error'), true);
    // services/tagging.ts:31 — `?? \`HTTP ${res.status}\``
    assert.equal(isMachineString('HTTP 403'), true);
    // services/hashtag.ts:28, tripCrewLocation.ts:84 — `?? res.statusText`
    assert.equal(isMachineString('Forbidden'), true);
    assert.equal(isMachineString('Not Found'), true);
    assert.equal(isMachineString('Internal Server Error'), true);
    // services/hashtag.ts:32 — `String(err)`
    assert.equal(isMachineString('TypeError: Network request failed'), true);
    assert.equal(isMachineString(''), true);
    assert.equal(isMachineString('   '), true);
  });

  it('does NOT flag real copy', () => {
    for (const s of [
      'You are not a member of this context.',
      'This buddy is not available on that date.',
      'Network request failed',
      'Your account is currently restricted from sending messages.',
    ]) {
      assert.equal(isMachineString(s), false, s);
    }
  });
});

describe('errorCopy', () => {
  it('replaces every machine string with the caller\'s sentence', () => {
    for (const s of ['db_error', 'HTTP 500', 'Forbidden', 'Not Found', 'TypeError: x failed']) {
      assert.equal(errorCopy(s, FALLBACK), FALLBACK, s);
    }
  });

  it('passes real copy through untouched', () => {
    const real = 'You cannot message this user.';
    assert.equal(errorCopy(real, FALLBACK), real);
  });

  it('uses generic copy when the caller gives no fallback', () => {
    const generic = errorCopy('db_error');
    assert.ok(/\s/.test(generic) && generic.length > 15);
    assert.notEqual(generic, 'db_error');
    assert.equal(errorCopy(null), generic);
    assert.equal(errorCopy(undefined), generic);
  });

  it('carries NO domain wording — the Rent-a-Buddy map must not leak here', () => {
    // A block/report flow answering feature_disabled must never tell the user
    // about Rent a Buddy. This is why the map lives in the Rent-a-Buddy module
    // and this function stays neutral.
    for (const code of ['feature_disabled', 'verification_unavailable', 'waitlist_only']) {
      const copy = errorCopy(code, FALLBACK);
      assert.equal(copy, FALLBACK, code);
      assert.doesNotMatch(copy, /Rent a Buddy/i);
    }
  });
});
