/**
 * signInProviders — a social button is shown only when platform, build and
 * backend all can; an unknown backend hides nothing.
 *
 * Run: node --import tsx --test src/lib/__tests__/signInProviders.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { visibleSignInProviders, canSignInWithAppleFrom } from '../signInProviders.ts';

const ALL_ON = { apple: true, google: true, email: true };

describe('visibleSignInProviders', () => {
  it('iOS store build, backend all on: Apple and Google', () => {
    assert.deepEqual(visibleSignInProviders({ platform: 'ios', buildCanSignInWithApple: true, backend: ALL_ON }), { apple: true, google: true });
  });

  it('Android never shows Apple (no Apple web OAuth here)', () => {
    assert.deepEqual(visibleSignInProviders({ platform: 'android', buildCanSignInWithApple: true, backend: ALL_ON }), { apple: false, google: true });
  });

  it('a Personal Team build (no entitlement) hides Apple even with the backend on', () => {
    assert.deepEqual(visibleSignInProviders({ platform: 'ios', buildCanSignInWithApple: false, backend: ALL_ON }), { apple: false, google: true });
  });

  it("the backend's switches hide a provider it has off (production on 2026-11-04: Apple off)", () => {
    assert.deepEqual(visibleSignInProviders({ platform: 'ios', buildCanSignInWithApple: true, backend: { ...ALL_ON, apple: false } }), { apple: false, google: true });
    assert.deepEqual(visibleSignInProviders({ platform: 'ios', buildCanSignInWithApple: true, backend: { ...ALL_ON, google: false } }), { apple: true, google: false });
  });

  it('an unknown backend answer (unreachable, fail-open) hides nothing the build can do', () => {
    assert.deepEqual(visibleSignInProviders({ platform: 'ios', buildCanSignInWithApple: true, backend: null }), { apple: true, google: true });
    assert.deepEqual(visibleSignInProviders({ platform: 'ios', buildCanSignInWithApple: false, backend: null }), { apple: false, google: true });
  });
});

describe('canSignInWithAppleFrom', () => {
  it('only an explicit false disables: absent extra, absent key and true all read as capable', () => {
    assert.equal(canSignInWithAppleFrom(undefined), true);
    assert.equal(canSignInWithAppleFrom(null), true);
    assert.equal(canSignInWithAppleFrom({}), true);
    assert.equal(canSignInWithAppleFrom({ signInWithApple: true }), true);
    assert.equal(canSignInWithAppleFrom({ signInWithApple: false }), false);
  });
});
