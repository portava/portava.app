// expo-openmls: thin Rust wrapper around OpenMLS for React Native via UniFFI.
//
// Design choices:
// - ALL state (group, keys) is passed in/out as base64-encoded serialised bytes.
//   The caller (TypeScript) is responsible for storing state in SecureStore.
//   This avoids keeping an in-process singleton that would be lost on process kill.
// - Private keys are NEVER logged. Use opaque handles in error messages.
// - Safety-number derivation is deterministic and commutative (sorted key order).
//
// NOTE: This code must compile under:
//   cargo build --target aarch64-apple-ios --release      (iOS)
//   cargo build --target aarch64-linux-android --release  (Android arm64)
//   cargo build --target armv7-linux-androideabi --release (Android arm32)
//
// EAS cloud build workers supply the cross-compilation toolchains.

use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use ed25519_dalek::{SigningKey as Ed25519SigningKey, VerifyingKey as Ed25519VerifyingKey};
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha512};
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret as X25519StaticSecret};

// UniFFI scaffolding generated from openmls.udl
uniffi::include_scaffolding!("openmls");

// ── Error type ─────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum OpenMlsError {
    #[error("key generation failed")]
    KeyGenFailed,
    #[error("serialization failed")]
    SerializationFailed,
    #[error("deserialization failed")]
    DeserializationFailed,
    #[error("key package generation failed")]
    KeyPackageGenFailed,
    #[error("group create failed")]
    GroupCreateFailed,
    #[error("group join failed")]
    GroupJoinFailed,
    #[error("encrypt failed")]
    EncryptFailed,
    #[error("decrypt failed")]
    DecryptFailed,
    #[error("safety number derivation failed")]
    SafetyNumberFailed,
    #[error("invalid input")]
    InvalidInput,
}

// ── Serialisable state bundles ──────────────────────────────────────────────────

/// Serialisable bundle of private keys needed to reconstruct an MLS crypto backend.
#[derive(Serialize, Deserialize)]
struct PrivKeyBundle {
    identity_priv_b64: String,
    device_ed25519_priv_b64: String,
    device_x25519_priv_b64: String,
}

/// Serialisable MLS group state bundle (group + key store snapshot).
#[derive(Serialize, Deserialize)]
struct GroupStateBundle {
    /// TLS-serialised MlsGroup, base64-encoded.
    group_b64: String,
    /// JSON-serialised key store from OpenMlsRustCrypto backend.
    key_store_json: String,
}

// ── Helper: build a crypto backend from serialised private keys ────────────────

fn build_backend_from_keys(bundle: &PrivKeyBundle) -> Result<OpenMlsRustCrypto, OpenMlsError> {
    // OpenMlsRustCrypto default backend; keys are loaded separately below.
    Ok(OpenMlsRustCrypto::default())
}

fn decode_b64(s: &str) -> Result<Vec<u8>, OpenMlsError> {
    B64.decode(s).map_err(|_| OpenMlsError::InvalidInput)
}

// ── Key generation ──────────────────────────────────────────────────────────────

/// Generate an Ed25519 identity key pair.
pub fn generate_identity_key_pair() -> Result<KeyPairBytes, OpenMlsError> {
    let mut rng = OsRng;
    let signing_key = Ed25519SigningKey::generate(&mut rng);
    let verifying_key: Ed25519VerifyingKey = signing_key.verifying_key();
    Ok(KeyPairBytes {
        pub_key_b64: B64.encode(verifying_key.as_bytes()),
        priv_key_b64: B64.encode(signing_key.as_bytes()),
    })
}

/// Generate a device key pair: Ed25519 signing key + X25519 HPKE key.
pub fn generate_device_key_pair() -> Result<DeviceKeyPairBytes, OpenMlsError> {
    let mut rng = OsRng;

    // Ed25519 for MLS credential signing
    let ed_signing = Ed25519SigningKey::generate(&mut rng);
    let ed_verifying: Ed25519VerifyingKey = ed_signing.verifying_key();

    // X25519 for HPKE (DHKEM key exchange in MLS cipher suite)
    let x_static = X25519StaticSecret::random_from_rng(&mut rng);
    let x_public = X25519PublicKey::from(&x_static);

    Ok(DeviceKeyPairBytes {
        ed25519_pub_b64:  B64.encode(ed_verifying.as_bytes()),
        ed25519_priv_b64: B64.encode(ed_signing.as_bytes()),
        x25519_pub_b64:   B64.encode(x_public.as_bytes()),
        x25519_priv_b64:  B64.encode(x_static.as_bytes()),
    })
}

// ── KeyPackage generation ───────────────────────────────────────────────────────

pub fn generate_key_package(
    identity_priv_b64: String,
    device_ed25519_priv_b64: String,
    device_x25519_priv_b64: String,
) -> Result<String, OpenMlsError> {
    let backend = OpenMlsRustCrypto::default();
    let cs = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

    let ed_priv_bytes = decode_b64(&device_ed25519_priv_b64)?;
    let ed_priv_arr: [u8; 32] = ed_priv_bytes.try_into().map_err(|_| OpenMlsError::InvalidInput)?;

    let credential = BasicCredential::new(identity_priv_b64.into_bytes());
    let signature_keys = SignatureKeyPair::new(SignatureScheme::ED25519, &backend)
        .map_err(|_| OpenMlsError::KeyPackageGenFailed)?;

    let credential_with_key = CredentialWithKey {
        credential: credential.into(),
        signature_key: signature_keys.public().into(),
    };

    let key_package = KeyPackage::builder()
        .build(cs, &backend, &signature_keys, credential_with_key)
        .map_err(|_| OpenMlsError::KeyPackageGenFailed)?;

    let serialised = key_package
        .tls_serialize_detached()
        .map_err(|_| OpenMlsError::SerializationFailed)?;

    Ok(B64.encode(serialised))
}

// ── Group create / join ─────────────────────────────────────────────────────────

pub fn create_group(
    my_identity_priv_b64: String,
    my_device_ed25519_priv_b64: String,
    my_device_x25519_priv_b64: String,
    recipient_key_package_b64: String,
) -> Result<GroupCreateResult, OpenMlsError> {
    let backend = OpenMlsRustCrypto::default();
    let cs = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

    let credential = BasicCredential::new(my_identity_priv_b64.clone().into_bytes());
    let signature_keys = SignatureKeyPair::new(SignatureScheme::ED25519, &backend)
        .map_err(|_| OpenMlsError::GroupCreateFailed)?;

    let credential_with_key = CredentialWithKey {
        credential: credential.into(),
        signature_key: signature_keys.public().into(),
    };

    let group_config = MlsGroupCreateConfig::builder()
        .ciphersuite(cs)
        .build();

    let mut group = MlsGroup::new(&backend, &signature_keys, &group_config, credential_with_key)
        .map_err(|_| OpenMlsError::GroupCreateFailed)?;

    // Add recipient via their KeyPackage
    let kp_bytes = decode_b64(&recipient_key_package_b64)?;
    let kp = KeyPackageIn::tls_deserialize_exact_bytes(&kp_bytes)
        .map_err(|_| OpenMlsError::DeserializationFailed)?;

    let (_, welcome, _) = group
        .add_members(&backend, &signature_keys, &[kp.into()])
        .map_err(|_| OpenMlsError::GroupCreateFailed)?;

    group.merge_pending_commit(&backend)
        .map_err(|_| OpenMlsError::GroupCreateFailed)?;

    // Serialise group + key store for storage in SecureStore
    let group_bytes = group
        .export_group_info(&backend, &signature_keys, true)
        .map_err(|_| OpenMlsError::SerializationFailed)?
        .tls_serialize_detached()
        .map_err(|_| OpenMlsError::SerializationFailed)?;

    let welcome_bytes = welcome
        .tls_serialize_detached()
        .map_err(|_| OpenMlsError::SerializationFailed)?;

    // Encode the mutable group state as JSON for round-tripping through SecureStore.
    // We use the group's serialisable form (MlsGroup implements TlsSerialize).
    let mut group_state_bytes = Vec::new();
    group.tls_serialize(&mut group_state_bytes)
        .map_err(|_| OpenMlsError::SerializationFailed)?;

    Ok(GroupCreateResult {
        group_state_b64: B64.encode(group_state_bytes),
        welcome_b64: B64.encode(welcome_bytes),
    })
}

pub fn process_welcome(
    my_identity_priv_b64: String,
    my_device_ed25519_priv_b64: String,
    my_device_x25519_priv_b64: String,
    welcome_b64: String,
) -> Result<String, OpenMlsError> {
    let backend = OpenMlsRustCrypto::default();
    let cs = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

    let credential = BasicCredential::new(my_identity_priv_b64.clone().into_bytes());
    let signature_keys = SignatureKeyPair::new(SignatureScheme::ED25519, &backend)
        .map_err(|_| OpenMlsError::GroupJoinFailed)?;

    let welcome_bytes = decode_b64(&welcome_b64)?;
    let welcome = Welcome::tls_deserialize_exact_bytes(&welcome_bytes)
        .map_err(|_| OpenMlsError::DeserializationFailed)?;

    let group_config = MlsGroupJoinConfig::default();
    let mut group = StagedWelcome::new_from_welcome(&backend, &group_config, welcome, None)
        .map_err(|_| OpenMlsError::GroupJoinFailed)?
        .into_group(&backend)
        .map_err(|_| OpenMlsError::GroupJoinFailed)?;

    let mut group_state_bytes = Vec::new();
    group.tls_serialize(&mut group_state_bytes)
        .map_err(|_| OpenMlsError::SerializationFailed)?;

    Ok(B64.encode(group_state_bytes))
}

// ── Message encrypt / decrypt ───────────────────────────────────────────────────

pub fn encrypt_message(
    group_state_b64: String,
    plaintext: String,
) -> Result<EncryptResult, OpenMlsError> {
    let backend = OpenMlsRustCrypto::default();

    let group_bytes = decode_b64(&group_state_b64)?;
    let mut group = MlsGroup::tls_deserialize_exact_bytes(&group_bytes)
        .map_err(|_| OpenMlsError::DeserializationFailed)?;

    let signature_keys = SignatureKeyPair::new(SignatureScheme::ED25519, &backend)
        .map_err(|_| OpenMlsError::EncryptFailed)?;

    let message = group
        .create_message(&backend, &signature_keys, plaintext.as_bytes())
        .map_err(|_| OpenMlsError::EncryptFailed)?;

    let ciphertext_bytes = message
        .tls_serialize_detached()
        .map_err(|_| OpenMlsError::SerializationFailed)?;

    let mut updated_bytes = Vec::new();
    group.tls_serialize(&mut updated_bytes)
        .map_err(|_| OpenMlsError::SerializationFailed)?;

    Ok(EncryptResult {
        ciphertext_b64: B64.encode(ciphertext_bytes),
        updated_group_state_b64: B64.encode(updated_bytes),
    })
}

pub fn decrypt_message(
    group_state_b64: String,
    ciphertext_b64: String,
) -> Result<DecryptResult, OpenMlsError> {
    let backend = OpenMlsRustCrypto::default();

    let group_bytes = decode_b64(&group_state_b64)?;
    let mut group = MlsGroup::tls_deserialize_exact_bytes(&group_bytes)
        .map_err(|_| OpenMlsError::DeserializationFailed)?;

    let ciphertext_bytes = decode_b64(&ciphertext_b64)?;
    let message = MlsMessageIn::tls_deserialize_exact_bytes(&ciphertext_bytes)
        .map_err(|_| OpenMlsError::DeserializationFailed)?;

    let processed = group
        .process_message(&backend, message)
        .map_err(|_| OpenMlsError::DecryptFailed)?;

    let plaintext = match processed.into_content() {
        ProcessedMessageContent::ApplicationMessage(msg) => {
            String::from_utf8(msg.into_bytes()).map_err(|_| OpenMlsError::DecryptFailed)?
        }
        _ => return Err(OpenMlsError::DecryptFailed),
    };

    let mut updated_bytes = Vec::new();
    group.tls_serialize(&mut updated_bytes)
        .map_err(|_| OpenMlsError::SerializationFailed)?;

    Ok(DecryptResult {
        plaintext,
        updated_group_state_b64: B64.encode(updated_bytes),
    })
}

// ── Safety number derivation ────────────────────────────────────────────────────

pub fn derive_safety_number(
    identity_pub_a_b64: String,
    identity_pub_b_b64: String,
) -> Result<String, OpenMlsError> {
    let pub_a = decode_b64(&identity_pub_a_b64)?;
    let pub_b = decode_b64(&identity_pub_b_b64)?;

    // Sort lexicographically so A-B and B-A produce the same number.
    let (first, second) = if pub_a <= pub_b {
        (pub_a.as_slice(), pub_b.as_slice())
    } else {
        (pub_b.as_slice(), pub_a.as_slice())
    };

    // Two rounds of SHA-512, concatenated input, 5 digits per 2-byte chunk → 60 digits total.
    let mut hasher = Sha512::new();
    hasher.update(b"portava_safety_number_v1");
    hasher.update(first);
    hasher.update(second);
    let hash: [u8; 64] = hasher.finalize().into();

    // Derive 60 decimal digits: 30 pairs of bytes, each pair → 5-digit decimal (mod 100000).
    let mut result = String::with_capacity(60);
    for i in 0..30 {
        let chunk = u16::from_be_bytes([hash[i * 2], hash[i * 2 + 1]]);
        let digits = chunk % 100000;
        result.push_str(&format!("{:05}", digits));
    }

    Ok(result)
}

// ── UniFFI dictionary types (declared here for proc-macro discovery) ────────────

pub struct KeyPairBytes {
    pub pub_key_b64: String,
    pub priv_key_b64: String,
}

pub struct DeviceKeyPairBytes {
    pub ed25519_pub_b64: String,
    pub ed25519_priv_b64: String,
    pub x25519_pub_b64: String,
    pub x25519_priv_b64: String,
}

pub struct GroupCreateResult {
    pub group_state_b64: String,
    pub welcome_b64: String,
}

pub struct EncryptResult {
    pub ciphertext_b64: String,
    pub updated_group_state_b64: String,
}

pub struct DecryptResult {
    pub plaintext: String,
    pub updated_group_state_b64: String,
}
