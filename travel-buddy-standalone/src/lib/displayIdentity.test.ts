/**
 * displayIdentity tests — node:test + node:assert only.
 * Run: node --import tsx/esm --test src/lib/displayIdentity.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  identityHandle,
  identityRealName,
  primaryIdentityText,
  secondaryIdentityText,
} from './displayIdentity.ts';
import { DISPLAY_NAME_MAX_LENGTH } from '../utils/identity.ts';

describe('displayIdentity', () => {
  describe('identityHandle', () => {
    it('prefers handle over username', () => {
      assert.equal(identityHandle({ handle: 'kai', username: 'other' }), 'kai');
    });
    it('falls back to username', () => {
      assert.equal(identityHandle({ username: 'wanda' }), 'wanda');
    });
    it('strips a leading @', () => {
      assert.equal(identityHandle({ handle: '@kai' }), 'kai');
    });
    it('returns null for empty/blank values', () => {
      assert.equal(identityHandle({ handle: '  ', username: '' }), null);
      assert.equal(identityHandle(null), null);
      assert.equal(identityHandle(undefined), null);
    });
  });

  describe('identityRealName', () => {
    it('prefers displayName, then name, then fullName', () => {
      assert.equal(identityRealName({ displayName: 'Kai R', name: 'K', fullName: 'F' }), 'Kai R');
      assert.equal(identityRealName({ name: 'Kai', fullName: 'F' }), 'Kai');
      assert.equal(identityRealName({ fullName: 'Full Name' }), 'Full Name');
    });
    it('treats blank strings as missing (server sends null when hidden)', () => {
      assert.equal(identityRealName({ displayName: '  ', name: '' }), null);
    });
  });

  describe('primaryIdentityText', () => {
    it('shows the real name when the subject opted in (server sent it)', () => {
      assert.equal(primaryIdentityText({ displayName: 'Kai Rivera', handle: 'kai' }), 'Kai Rivera');
    });
    it('shows @handle when the name is hidden (null from server)', () => {
      assert.equal(primaryIdentityText({ displayName: null, handle: 'kai' }), '@kai');
    });
    it('does not double the @ for handles stored with one', () => {
      assert.equal(primaryIdentityText({ handle: '@kai' }), '@kai');
    });
    it('truncates legacy over-limit real names to the shared limit with an ellipsis', () => {
      const long = 'A'.repeat(60);
      const out = primaryIdentityText({ displayName: long, handle: 'kai' });
      assert.equal(out, 'A'.repeat(DISPLAY_NAME_MAX_LENGTH) + '…');
    });
    it('falls back to Traveler when nothing is available', () => {
      assert.equal(primaryIdentityText({}), 'Traveler');
      assert.equal(primaryIdentityText(null), 'Traveler');
    });
  });

  describe('secondaryIdentityText', () => {
    it('returns @handle under a real name', () => {
      assert.equal(secondaryIdentityText({ displayName: 'Kai Rivera', handle: 'kai' }), '@kai');
    });
    it('returns null when the primary line is already the handle', () => {
      assert.equal(secondaryIdentityText({ displayName: null, handle: 'kai' }), null);
    });
    it('returns null when name and handle would duplicate', () => {
      assert.equal(secondaryIdentityText({ displayName: 'kai', handle: 'kai' }), null);
      assert.equal(secondaryIdentityText({ displayName: '@kai', handle: 'kai' }), null);
    });
    it('returns null when there is no handle', () => {
      assert.equal(secondaryIdentityText({ displayName: 'Kai Rivera' }), null);
    });
  });
});
