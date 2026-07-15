import {
  identityHandle,
  identityRealName,
  primaryIdentityText,
  secondaryIdentityText,
} from './displayIdentity';

describe('displayIdentity', () => {
  describe('identityHandle', () => {
    it('prefers handle over username', () => {
      expect(identityHandle({ handle: 'kai', username: 'other' })).toBe('kai');
    });
    it('falls back to username', () => {
      expect(identityHandle({ username: 'wanda' })).toBe('wanda');
    });
    it('strips a leading @', () => {
      expect(identityHandle({ handle: '@kai' })).toBe('kai');
    });
    it('returns null for empty/blank values', () => {
      expect(identityHandle({ handle: '  ', username: '' })).toBeNull();
      expect(identityHandle(null)).toBeNull();
      expect(identityHandle(undefined)).toBeNull();
    });
  });

  describe('identityRealName', () => {
    it('prefers displayName, then name, then fullName', () => {
      expect(identityRealName({ displayName: 'Kai R', name: 'K', fullName: 'F' })).toBe('Kai R');
      expect(identityRealName({ name: 'Kai', fullName: 'F' })).toBe('Kai');
      expect(identityRealName({ fullName: 'Full Name' })).toBe('Full Name');
    });
    it('treats blank strings as missing (server sends null when hidden)', () => {
      expect(identityRealName({ displayName: '  ', name: '' })).toBeNull();
    });
  });

  describe('primaryIdentityText', () => {
    it('shows the real name when the subject opted in (server sent it)', () => {
      expect(primaryIdentityText({ displayName: 'Kai Rivera', handle: 'kai' })).toBe('Kai Rivera');
    });
    it('shows @handle when the name is hidden (null from server)', () => {
      expect(primaryIdentityText({ displayName: null, handle: 'kai' })).toBe('@kai');
    });
    it('does not double the @ for handles stored with one', () => {
      expect(primaryIdentityText({ handle: '@kai' })).toBe('@kai');
    });
    it('falls back to Traveler when nothing is available', () => {
      expect(primaryIdentityText({})).toBe('Traveler');
      expect(primaryIdentityText(null)).toBe('Traveler');
    });
  });

  describe('secondaryIdentityText', () => {
    it('returns @handle under a real name', () => {
      expect(secondaryIdentityText({ displayName: 'Kai Rivera', handle: 'kai' })).toBe('@kai');
    });
    it('returns null when the primary line is already the handle', () => {
      expect(secondaryIdentityText({ displayName: null, handle: 'kai' })).toBeNull();
    });
    it('returns null when name and handle would duplicate', () => {
      expect(secondaryIdentityText({ displayName: 'kai', handle: 'kai' })).toBeNull();
      expect(secondaryIdentityText({ displayName: '@kai', handle: 'kai' })).toBeNull();
    });
    it('returns null when there is no handle', () => {
      expect(secondaryIdentityText({ displayName: 'Kai Rivera' })).toBeNull();
    });
  });
});
