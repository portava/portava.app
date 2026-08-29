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

/**
 * Returned from generateKeyPackage (openmls.udl:109).
 *
 * This interface was missing entirely, which is why generateKeyPackage was typed
 * as returning a bare string: the KeyPackage half was visible and the private
 * half had nowhere to go in the type system.
 */
export interface KeyPackageResult {
  /** The KeyPackage itself, base64-encoded. Upload to the server's pool. */
  keyPackageB64: string;
  /**
   * Private material belonging to this KeyPackage. NEVER LOG, never upload —
   * processWelcome needs it later to open the Welcome encrypted to this package,
   * so it belongs in SecureStore under MLS_PENDING_KEY_PACKAGE.
   */
  pendingStateB64: string;
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
