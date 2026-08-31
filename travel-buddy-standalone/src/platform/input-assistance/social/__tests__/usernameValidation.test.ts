/**
 * Phase 4 (Social Identity) — the SINGLE username rule set (§23).
 *
 * These rules are shared by the profile identity editor and onboarding step 1,
 * so a handle accepted at one entry point can never be rejected at the other
 * (the exact divergence the client audit flagged). Pure logic — node:test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  sanitizeUsername,
  usernameSyntaxError,
  isUsernameCheckable,
  interpretAvailability,
  USERNAME_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_TOO_SHORT_MESSAGE,
  USERNAME_UNAVAILABLE_MESSAGE,
} from '../usernameValidation.ts';

// ── sanitize ──────────────────────────────────────────────────────────────────

test('sanitize strips a leading @, lowercases, and drops invalid characters', () => {
  assert.equal(sanitizeUsername('@Maya_Torres'), 'maya_torres');
  assert.equal(sanitizeUsername('Hello World!'), 'helloworld');
  assert.equal(sanitizeUsername('a.b_c123'), 'a.b_c123');
  // Multiple leading @ are all stripped (matches the identity screen regex).
  assert.equal(sanitizeUsername('@@@ghost'), 'ghost');
});

test('sanitize caps length at USERNAME_MAX_LENGTH', () => {
  const long = 'a'.repeat(40);
  assert.equal(sanitizeUsername(long).length, USERNAME_MAX_LENGTH);
  assert.equal(USERNAME_MAX_LENGTH, 24); // reconciles the identity 30-vs-"3-24" mismatch
});

// ── min-length ────────────────────────────────────────────────────────────────

test('rejects a non-empty handle below the minimum length', () => {
  assert.equal(USERNAME_MIN_LENGTH, 3);
  assert.equal(usernameSyntaxError('ab'), USERNAME_TOO_SHORT_MESSAGE);
  assert.equal(usernameSyntaxError('a'), USERNAME_TOO_SHORT_MESSAGE);
});

test('an empty handle is not a syntax error (username is optional)', () => {
  assert.equal(usernameSyntaxError(''), null);
});

test('a handle at or above the minimum has no syntax error', () => {
  assert.equal(usernameSyntaxError('abc'), null);
  assert.equal(usernameSyntaxError('maya_torres'), null);
});

test('isUsernameCheckable gates the availability call on the minimum length', () => {
  assert.equal(isUsernameCheckable('ab'), false);
  assert.equal(isUsernameCheckable('abc'), true);
});

// ── availability interpretation ───────────────────────────────────────────────

test('available → status available, no message', () => {
  assert.deepEqual(interpretAvailability({ available: true }), {
    status: 'available',
    message: null,
  });
});

test('taken → status taken with the server reason', () => {
  assert.deepEqual(interpretAvailability({ available: false, reason: 'Already taken' }), {
    status: 'taken',
    message: 'Already taken',
  });
});

test('taken with no reason → the shared fallback message', () => {
  assert.deepEqual(interpretAvailability({ available: false }), {
    status: 'taken',
    message: USERNAME_UNAVAILABLE_MESSAGE,
  });
});

// ── end-to-end: a 1–2 char handle is now rejected everywhere ──────────────────

test('the audit bug: a 1–2 char handle is rejected by the shared min-length rule', () => {
  // Onboarding used to accept this with no check; identity rejected it. Both now
  // run this same rule, so acceptance can no longer diverge.
  const cleaned = sanitizeUsername('@Ab');
  assert.equal(cleaned, 'ab');
  assert.equal(usernameSyntaxError(cleaned), USERNAME_TOO_SHORT_MESSAGE);
  assert.equal(isUsernameCheckable(cleaned), false);
});
