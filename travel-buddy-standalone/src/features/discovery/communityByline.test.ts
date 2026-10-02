/**
 * communityByline tests — node:test + node:assert only.
 * Run: node --import tsx/esm --test src/features/discovery/communityByline.test.ts
 *
 * The byline is the one Discovery surface that renders another traveler's
 * identity, so its privacy rule is pinned here through the whole chain it
 * runs on: communityByline → lib/displayIdentity#primaryIdentityText →
 * utils/identity#truncateDisplayName. Until now only the api-server route→client
 * e2e (discoveryClientRouteE2E) exercised it, and that file cannot load at all
 * on a Node major below CI's pin, so a regression here had no other witness.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { communityBylineText } from './communityByline.ts';
import { DISPLAY_NAME_MAX_LENGTH, truncateDisplayName } from '../../utils/identity.ts';

describe('communityBylineText', () => {
  it('shows the real name when the server authorised it (displayName set)', () => {
    assert.equal(communityBylineText({ displayName: 'Kai Rivera', handle: 'kai' }), 'Kai Rivera');
  });

  it('shows @handle when the server withheld the name (displayName null)', () => {
    assert.equal(communityBylineText({ displayName: null, handle: 'kai' }), '@kai');
  });

  it('fails closed: a real name in the legacy `name` field is never shown while displayName is null', () => {
    // A partial rollout, a stale cache entry or a server regression can leave a
    // real name in `name` (or `fullName`) with displayName withheld. The
    // withholding side wins: the byline reads displayName and handle only.
    const served = { displayName: null, name: 'Kai Rivera', fullName: 'Kai Rivera', handle: 'kai' };
    assert.equal(communityBylineText(served), '@kai');
  });

  it('ignores the legacy `name` presentation of a withheld name ("@username")', () => {
    const served = { displayName: null, name: '@someone-else', handle: 'kai' };
    assert.equal(communityBylineText(served), '@kai');
  });

  it('treats a blank displayName as withheld, not as a name', () => {
    assert.equal(communityBylineText({ displayName: '   ', handle: 'kai' }), '@kai');
  });

  it('does not double the @ of a handle stored with one', () => {
    assert.equal(communityBylineText({ displayName: null, handle: '@kai' }), '@kai');
  });

  it('is never blank: a withheld name with no handle reads "Traveler"', () => {
    const nameOnly = { displayName: null, name: 'Kai Rivera' };
    assert.equal(communityBylineText({ displayName: null, handle: null }), 'Traveler');
    assert.equal(communityBylineText(nameOnly), 'Traveler');
    assert.equal(communityBylineText({}), 'Traveler');
    assert.equal(communityBylineText(null), 'Traveler');
    assert.equal(communityBylineText(undefined), 'Traveler');
  });

  it("caps a legacy over-limit authorised name with utils/identity's truncateDisplayName", () => {
    const long = 'A'.repeat(DISPLAY_NAME_MAX_LENGTH + 20);
    const out = communityBylineText({ displayName: long, handle: 'kai' });
    assert.equal(out, truncateDisplayName(long));
    assert.equal(out, `${'A'.repeat(DISPLAY_NAME_MAX_LENGTH)}…`);
  });
});
