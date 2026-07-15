/**
 * Web shim for react-native-view-shot.
 * captureRef is a no-op on web — usePassportShare falls back to text-only share.
 */
export function captureRef() {
  return Promise.reject(new Error('captureRef is not supported on web'));
}
