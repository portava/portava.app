/**
 * TypeScript types for the expo-openmls native module.
 * Mirror of the UniFFI dictionary types defined in openmls.udl.
 */

export interface KeyPairBytes {
  /** Ed25519 public key, base64-encoded. */
  pubKeyB64: string;
  /** Ed25519 private key, base64-encoded. NEVER LOG. */
  privKeyB64: string;
}

export interface DeviceKeyPairBytes {
  /** Ed25519 public key for MLS credential signing, base64-encoded. */
  ed25519PubB64: string;
  /** Ed25519 private key. NEVER LOG. */
  ed25519PrivB64: string;
  /** X25519 public key for HPKE, base64-encoded. */
  x25519PubB64: string;
  /** X25519 private key. NEVER LOG. */
  x25519PrivB64: string;
}

export interface GroupCreateResult {
  /** Serialised MLS group state, base64-encoded. Store in SecureStore. */
  groupStateB64: string;
  /** MLS Welcome message, base64-encoded. Send to recipient via server. */
  welcomeB64: string;
}

export interface EncryptResult {
  /** MLS-encrypted ciphertext, base64-encoded. */
  ciphertextB64: string;
  /** Updated group state after MLS epoch advancement. Store back to SecureStore. */
  updatedGroupStateB64: string;
}

export interface DecryptResult {
  /** Decrypted plaintext. NEVER send to server. */
  plaintext: string;
  /** Updated group state after processing the received message. Store back to SecureStore. */
  updatedGroupStateB64: string;
}

/** All errors thrown by expo-openmls native functions. */
export type OpenMlsErrorCode =
  | 'KeyGenFailed'
  | 'SerializationFailed'
  | 'DeserializationFailed'
  | 'KeyPackageGenFailed'
  | 'GroupCreateFailed'
  | 'GroupJoinFailed'
  | 'EncryptFailed'
  | 'DecryptFailed'
  | 'SafetyNumberFailed'
  | 'InvalidInput';

export class OpenMlsError extends Error {
  constructor(public readonly code: OpenMlsErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'OpenMlsError';
  }
}
