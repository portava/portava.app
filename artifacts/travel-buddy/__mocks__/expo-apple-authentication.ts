/**
 * Jest mock for expo-apple-authentication.
 *
 * Provides deterministic in-memory behaviour:
 *  - signInAsync → succeeds by default with a fake identityToken.
 *  - Call _setAppleCancel(true) before a test to simulate user cancellation.
 *  - Call _setAppleError(msg) to simulate a failure.
 *  - Call _reset() in afterEach to restore default state.
 */

let _shouldCancel = false;
let _errorMessage: string | null = null;
let _callCount = 0;

/** Simulate the user dismissing the Apple sheet. */
export function _setAppleCancel(value: boolean) { _shouldCancel = value; }
/** Simulate an Apple auth failure with a message. */
export function _setAppleError(msg: string | null) { _errorMessage = msg; }
/** Number of times signInAsync was called since last reset. */
export function _getCallCount() { return _callCount; }
/** Reset all state to defaults. */
export function _reset() { _shouldCancel = false; _errorMessage = null; _callCount = 0; }

export enum AppleAuthenticationScope {
  FULL_NAME = 0,
  EMAIL     = 1,
}

export class AppleAuthenticationError extends Error {
  static readonly CANCELED = '1001';
  constructor(public code: string, message: string) { super(message); }
}

export async function signInAsync(_options?: { requestedScopes?: AppleAuthenticationScope[] }) {
  _callCount++;
  if (_shouldCancel) {
    const err = new AppleAuthenticationError('ERR_REQUEST_CANCELED', 'User cancelled Apple sign-in');
    (err as any).code = 'ERR_REQUEST_CANCELED';
    throw err;
  }
  if (_errorMessage) {
    throw new Error(_errorMessage);
  }
  return {
    user: 'apple-user-001',
    email: 'test@privaterelay.appleid.com',
    fullName: { givenName: 'Jane', familyName: 'Doe' },
    identityToken: 'mock-apple-identity-token',
    authorizationCode: 'mock-apple-auth-code',
    realUserStatus: 0,
    state: null,
  };
}

export async function isAvailableAsync() {
  return true;
}
