/**
 * Jest mock for expo-secure-store.
 *
 * Uses an in-memory Map to simulate Keychain/Keystore storage.
 * Exposes _reset() for beforeEach cleanup in tests.
 */

const _store = new Map<string, string>();

export function _reset(): void {
  _store.clear();
}

export async function getItemAsync(key: string): Promise<string | null> {
  return _store.get(key) ?? null;
}

export async function setItemAsync(key: string, value: string): Promise<void> {
  _store.set(key, value);
}

export async function deleteItemAsync(key: string): Promise<void> {
  _store.delete(key);
}

// Accessibility constants (values match real expo-secure-store)
export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 'WhenUnlockedThisDeviceOnly';
export const WHEN_UNLOCKED = 'WhenUnlocked';
export const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY = 'AfterFirstUnlockThisDeviceOnly';
export const AFTER_FIRST_UNLOCK = 'AfterFirstUnlock';
export const ALWAYS_THIS_DEVICE_ONLY = 'AlwaysThisDeviceOnly';
export const ALWAYS = 'Always';
export const WHEN_PASSCODE_SET_THIS_DEVICE_ONLY = 'WhenPasscodeSetThisDeviceOnly';
