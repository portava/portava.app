/**
 * Jest mock for expo-openmls.
 *
 * Types come from vendor/expo-openmls — the tree that actually ships
 * (package.json pins "expo-openmls": "file:./vendor/expo-openmls", and only
 * vendor carries expo-module.config.json, so only vendor autolinks). This mock
 * previously imported from packages/expo-openmls, a stale unbuilt fork at
 * OpenMLS 0.5.0, which made it the last thing referencing that tree.
 *
 * All functions return deterministic in-memory results.
 * Key material is fabricated — never real cryptographic material.
 * The encrypt/decrypt cycle is a no-op XOR-style substitution for testing
 * control flow; it is NOT secure.
 */

import type {
  KeyPairBytes,
  DeviceKeyPairBytes,
  GroupCreateResult,
  EncryptResult,
  DecryptResult,
} from '../vendor/expo-openmls/src/ExpoOpenmls.types';

// In-memory group state store (base64 string → plaintext message map for test inspection)
const _groupStore = new Map<string, string>();

export function _resetMls(): void {
  _groupStore.clear();
}

// Fake deterministic key bytes (safe to use in test assertions)
const FAKE_IDENTITY_PUB  = Buffer.from('fake-identity-pub-key-32bytes!!!').toString('base64');
const FAKE_IDENTITY_PRIV = Buffer.from('fake-identity-priv-key-32bytes!!').toString('base64');
const FAKE_ED25519_PUB   = Buffer.from('fake-device-ed25519-pub-key-32by').toString('base64');
const FAKE_ED25519_PRIV  = Buffer.from('fake-device-ed25519-priv-key-32b').toString('base64');
const FAKE_X25519_PUB    = Buffer.from('fake-device-x25519-pub-key-32byt').toString('base64');
const FAKE_X25519_PRIV   = Buffer.from('fake-device-x25519-priv-key-32by').toString('base64');
const FAKE_GROUP_STATE   = Buffer.from('fake-mls-group-state-v1').toString('base64');
const FAKE_WELCOME       = Buffer.from('fake-mls-welcome-message-v1').toString('base64');
const FAKE_KEY_PACKAGE   = Buffer.from('fake-mls-key-package-v1').toString('base64');
const FAKE_SAFETY_NUMBER = '012340123401234012340123401234012340123401234012340123401234';

export const generateIdentityKeyPair = jest.fn(async (): Promise<KeyPairBytes> => ({
  pubKeyB64:  FAKE_IDENTITY_PUB,
  privKeyB64: FAKE_IDENTITY_PRIV,
}));

export const generateDeviceKeyPair = jest.fn(async (): Promise<DeviceKeyPairBytes> => ({
  ed25519PubB64:  FAKE_ED25519_PUB,
  ed25519PrivB64: FAKE_ED25519_PRIV,
  x25519PubB64:   FAKE_X25519_PUB,
  x25519PrivB64:  FAKE_X25519_PRIV,
}));

export const generateKeyPackage = jest.fn(async (
  _identityPrivB64: string,
  _deviceEd25519PrivB64: string,
  _deviceX25519PrivB64: string,
): Promise<string> => FAKE_KEY_PACKAGE);

export const createGroup = jest.fn(async (
  _myIdentityPrivB64: string,
  _myDeviceEd25519PrivB64: string,
  _myDeviceX25519PrivB64: string,
  _recipientKeyPackageB64: string,
): Promise<GroupCreateResult> => ({
  groupStateB64: FAKE_GROUP_STATE,
  welcomeB64:    FAKE_WELCOME,
}));

export const processWelcome = jest.fn(async (
  _myIdentityPrivB64: string,
  _myDeviceEd25519PrivB64: string,
  _myDeviceX25519PrivB64: string,
  _welcomeB64: string,
): Promise<string> => FAKE_GROUP_STATE);

export const encryptMessage = jest.fn(async (
  groupStateB64: string,
  plaintext: string,
): Promise<EncryptResult> => {
  // Store mapping for decryptMessage to retrieve in tests
  const handle = Buffer.from(`enc:${plaintext}`).toString('base64');
  _groupStore.set(handle, plaintext);
  return {
    ciphertextB64:        handle,
    updatedGroupStateB64: groupStateB64, // state unchanged in mock
  };
});

export const decryptMessage = jest.fn(async (
  groupStateB64: string,
  ciphertextB64: string,
): Promise<DecryptResult> => {
  const plaintext = _groupStore.get(ciphertextB64)
    ?? Buffer.from(ciphertextB64, 'base64').toString('utf8').replace(/^enc:/, '');
  return {
    plaintext,
    updatedGroupStateB64: groupStateB64,
  };
});

// One argument, the group state — matching lib.rs:417, openmls.udl:72 and the
// generated Swift. The historical mock declared two identity pubkeys, copying
// the wrong signature in vendor/expo-openmls/src/index.ts:125.
export const deriveSafetyNumber = jest.fn(async (
  _groupStateB64: string,
): Promise<string> => FAKE_SAFETY_NUMBER);

export { FAKE_IDENTITY_PUB, FAKE_IDENTITY_PRIV, FAKE_ED25519_PUB, FAKE_KEY_PACKAGE, FAKE_GROUP_STATE, FAKE_WELCOME, FAKE_SAFETY_NUMBER };
