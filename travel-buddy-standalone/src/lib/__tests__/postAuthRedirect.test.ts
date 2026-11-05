/**
 * postAuthRedirect — a signed-out person who opened an invite link is sent
 * back to it after signing in, and nothing else can be smuggled in as a path.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  REDIRECT_TTL_MS,
  clearPostAuthRedirect,
  getPostAuthRedirect,
  isSafeInAppPath,
  postAuthDestination,
  setPostAuthRedirect,
} from '../postAuthRedirect.ts';

describe('postAuthRedirect', () => {
  beforeEach(() => clearPostAuthRedirect());

  it('goes to the tabs when nothing is remembered', () => {
    assert.equal(postAuthDestination(), '/(tabs)');
  });

  it('returns to the invite until the invite screen clears it', () => {
    setPostAuthRedirect('/invite/tok123', 1_000);
    assert.equal(postAuthDestination(2_000), '/invite/tok123');
    assert.equal(postAuthDestination(3_000), '/invite/tok123', 'reading twice is safe');
    clearPostAuthRedirect();
    assert.equal(postAuthDestination(4_000), '/(tabs)');
  });

  it('forgets a stale path', () => {
    setPostAuthRedirect('/invite/tok123', 0);
    assert.equal(getPostAuthRedirect(REDIRECT_TTL_MS + 1), null);
    assert.equal(getPostAuthRedirect(0), null, 'and stays forgotten');
  });

  it('accepts only a single-slash in-app path', () => {
    for (const bad of ['https://evil.example', '//evil.example', 'invite/x', '/a b', '/a\\b', '', null, 42]) {
      assert.equal(isSafeInAppPath(bad), false, String(bad));
    }
    setPostAuthRedirect('//evil.example');
    assert.equal(getPostAuthRedirect(), null);
    assert.equal(isSafeInAppPath('/invite/abc'), true);
  });
});
