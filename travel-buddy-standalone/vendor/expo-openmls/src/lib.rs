// expo-openmls: thin Rust wrapper around OpenMLS for React Native via UniFFI.
//
// Design choices:
// - ALL state is passed in/out as base64-encoded serialised bytes. The caller
//   (TypeScript) stores it in SecureStore. No in-process singleton, so nothing
//   is lost on process kill.
// - The caller's OWN keys are used. Every entry point imports the device
//   signature key it is handed; none of them mint a fresh one. See KEY IMPORT.
// - The credential identity is a PUBLIC identifier. Never key material.
// - Private keys are NEVER logged.
//
// PERSISTENCE
// -----------
// `MlsGroup` is not TLS-serialisable. OpenMLS persists groups through a
// `StorageProvider`, so the unit of persistence here is the whole provider:
// snapshot `MemoryStorage` to bytes, and reload with
// `MlsGroup::load(storage, &group_id)`. `GroupStateBundle` is that snapshot
// plus the group id needed to find the group inside it.
//
// NOTE: This code must compile under:
//   cargo build --target aarch64-apple-ios --release      (iOS)
//   cargo build --target aarch64-linux-android --release  (Android arm64)
//   cargo build --target armv7-linux-androideabi --release (Android arm32)

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use ed25519_dalek::{SigningKey as Ed25519SigningKey, VerifyingKey as Ed25519VerifyingKey};
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_memory_storage::MemoryStorage;
use openmls_rust_crypto::RustCrypto;
use openmls_traits::OpenMlsProvider;
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha512};
use tls_codec::Serialize as _;
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret as X25519StaticSecret};

// UniFFI scaffolding generated from openmls.udl
uniffi::include_scaffolding!("openmls");

const CS: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

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

// ── Provider ───────────────────────────────────────────────────────────────────

/// `OpenMlsRustCrypto` keeps its `MemoryStorage` private and offers no
/// constructor taking a restored one, so a provider that can be rehydrated from
/// a snapshot has to be declared here.
#[derive(Default)]
struct PortavaProvider {
    crypto: RustCrypto,
    storage: MemoryStorage,
}

impl OpenMlsProvider for PortavaProvider {
    type CryptoProvider = RustCrypto;
    type RandProvider = RustCrypto;
    type StorageProvider = MemoryStorage;
    fn storage(&self) -> &Self::StorageProvider { &self.storage }
    fn crypto(&self) -> &Self::CryptoProvider { &self.crypto }
    fn rand(&self) -> &Self::RandProvider { &self.crypto }
}

impl PortavaProvider {
    fn snapshot(&self) -> Result<String, OpenMlsError> {
        let mut buf = Vec::new();
        self.storage
            .serialize(&mut buf)
            .map_err(|_| OpenMlsError::SerializationFailed)?;
        Ok(B64.encode(buf))
    }

    fn restore(b64: &str) -> Result<Self, OpenMlsError> {
        let bytes = decode_b64(b64)?;
        Ok(Self {
            crypto: RustCrypto::default(),
            storage: MemoryStorage::deserialize(&mut bytes.as_slice())
                .map_err(|_| OpenMlsError::DeserializationFailed)?,
        })
    }
}

// ── Serialisable state bundles ──────────────────────────────────────────────────

/// Snapshot of the whole provider plus the id needed to find the group in it.
#[derive(Serialize, Deserialize)]
struct GroupStateBundle {
    storage_b64: String,
    group_id_b64: String,
}

fn pack_group_state(p: &PortavaProvider, gid: &GroupId) -> Result<String, OpenMlsError> {
    let bundle = GroupStateBundle {
        storage_b64: p.snapshot()?,
        group_id_b64: B64.encode(gid.as_slice()),
    };
    let json = serde_json::to_vec(&bundle).map_err(|_| OpenMlsError::SerializationFailed)?;
    Ok(B64.encode(json))
}

fn unpack_group_state(s: &str) -> Result<(PortavaProvider, MlsGroup), OpenMlsError> {
    let json = decode_b64(s)?;
    let bundle: GroupStateBundle =
        serde_json::from_slice(&json).map_err(|_| OpenMlsError::DeserializationFailed)?;
    let provider = PortavaProvider::restore(&bundle.storage_b64)?;
    let gid = GroupId::from_slice(&decode_b64(&bundle.group_id_b64)?);
    let group = MlsGroup::load(provider.storage(), &gid)
        .map_err(|_| OpenMlsError::DeserializationFailed)?
        .ok_or(OpenMlsError::DeserializationFailed)?;
    Ok((provider, group))
}

fn decode_b64(s: &str) -> Result<Vec<u8>, OpenMlsError> {
    B64.decode(s).map_err(|_| OpenMlsError::InvalidInput)
}

// ── KEY IMPORT ─────────────────────────────────────────────────────────────────

/// Import the caller's device signature key.
///
/// This is the whole point of the rewrite. The previous implementation called
/// `SignatureKeyPair::new(...)` at every entry point, minting a throwaway key
/// and discarding the one it was handed — so the keys the client registered
/// with the server had no relationship to the keys MLS used, and safety numbers
/// derived from them verified nothing.
///
/// `from_raw` expects exactly what `generate_device_key_pair` emits for
/// ED25519: a 32-byte seed and a 32-byte public key.
fn import_signer(priv_b64: &str, pub_b64: &str) -> Result<SignatureKeyPair, OpenMlsError> {
    let private = decode_b64(priv_b64)?;
    let public = decode_b64(pub_b64)?;
    if private.len() != 32 || public.len() != 32 {
        return Err(OpenMlsError::InvalidInput);
    }
    Ok(SignatureKeyPair::from_raw(
        CS.signature_algorithm(),
        private,
        public,
    ))
}

/// Build a credential from a PUBLIC identifier.
///
/// The identity bytes end up in the leaf node, in the KeyPackage published to
/// the server, and in the Welcome sent to the peer. They must never be key
/// material — the previous implementation put the identity PRIVATE key here.
fn credential_for(user_id: &str, signer: &SignatureKeyPair) -> CredentialWithKey {
    CredentialWithKey {
        credential: BasicCredential::new(user_id.as_bytes().to_vec()).into(),
        signature_key: signer.public().into(),
    }
}

fn group_config() -> MlsGroupCreateConfig {
    MlsGroupCreateConfig::builder()
        .ciphersuite(CS)
        // Without this the Welcome carries no ratchet tree and the joiner
        // cannot construct the group.
        .use_ratchet_tree_extension(true)
        .build()
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
    let ed_signing = Ed25519SigningKey::generate(&mut rng);
    let ed_verifying: Ed25519VerifyingKey = ed_signing.verifying_key();
    let x_static = X25519StaticSecret::random_from_rng(&mut rng);
    let x_public = X25519PublicKey::from(&x_static);

    Ok(DeviceKeyPairBytes {
        ed25519_pub_b64: B64.encode(ed_verifying.as_bytes()),
        ed25519_priv_b64: B64.encode(ed_signing.as_bytes()),
        x25519_pub_b64: B64.encode(x_public.as_bytes()),
        x25519_priv_b64: B64.encode(x_static.as_bytes()),
    })
}

// ── KeyPackage generation ───────────────────────────────────────────────────────

/// Build a KeyPackage for publication to the server.
///
/// Returns the pending provider snapshot alongside it: a KeyPackage has private
/// material that `process_welcome` needs later. The previous implementation
/// built it against a throwaway backend and dropped that material on the floor,
/// so a Welcome could never have been processed.
pub fn generate_key_package(
    user_id: String,
    device_ed25519_priv_b64: String,
    device_ed25519_pub_b64: String,
) -> Result<KeyPackageResult, OpenMlsError> {
    let provider = PortavaProvider::default();
    let signer = import_signer(&device_ed25519_priv_b64, &device_ed25519_pub_b64)?;
    signer
        .store(provider.storage())
        .map_err(|_| OpenMlsError::KeyPackageGenFailed)?;

    let bundle = KeyPackage::builder()
        .build(CS, &provider, &signer, credential_for(&user_id, &signer))
        .map_err(|_| OpenMlsError::KeyPackageGenFailed)?;

    let serialised = bundle
        .key_package()
        .tls_serialize_detached()
        .map_err(|_| OpenMlsError::SerializationFailed)?;

    Ok(KeyPackageResult {
        key_package_b64: B64.encode(serialised),
        pending_state_b64: provider.snapshot()?,
    })
}

// ── Group create / join ─────────────────────────────────────────────────────────

pub fn create_group(
    user_id: String,
    device_ed25519_priv_b64: String,
    device_ed25519_pub_b64: String,
    recipient_key_package_b64: String,
) -> Result<GroupCreateResult, OpenMlsError> {
    let provider = PortavaProvider::default();
    let signer = import_signer(&device_ed25519_priv_b64, &device_ed25519_pub_b64)?;
    signer
        .store(provider.storage())
        .map_err(|_| OpenMlsError::GroupCreateFailed)?;

    let mut group = MlsGroup::new(
        &provider,
        &signer,
        &group_config(),
        credential_for(&user_id, &signer),
    )
    .map_err(|_| OpenMlsError::GroupCreateFailed)?;

    let kp_bytes = decode_b64(&recipient_key_package_b64)?;
    let kp_in = KeyPackageIn::tls_deserialize_exact_bytes(&kp_bytes)
        .map_err(|_| OpenMlsError::DeserializationFailed)?;
    let kp = kp_in
        .validate(provider.crypto(), ProtocolVersion::Mls10)
        .map_err(|_| OpenMlsError::DeserializationFailed)?;

    let (_commit, welcome, _gi) = group
        .add_members(&provider, &signer, &[kp])
        .map_err(|_| OpenMlsError::GroupCreateFailed)?;
    group
        .merge_pending_commit(&provider)
        .map_err(|_| OpenMlsError::GroupCreateFailed)?;

    let welcome_bytes = welcome
        .tls_serialize_detached()
        .map_err(|_| OpenMlsError::SerializationFailed)?;

    let gid = group.group_id().clone();
    Ok(GroupCreateResult {
        group_state_b64: pack_group_state(&provider, &gid)?,
        welcome_b64: B64.encode(welcome_bytes),
    })
}

pub fn process_welcome(
    welcome_b64: String,
    pending_state_b64: String,
) -> Result<String, OpenMlsError> {
    // The provider must be the one that built the KeyPackage — it holds the
    // private material the Welcome is encrypted to.
    let provider = PortavaProvider::restore(&pending_state_b64)?;

    let welcome_bytes = decode_b64(&welcome_b64)?;
    let msg = MlsMessageIn::tls_deserialize_exact_bytes(&welcome_bytes)
        .map_err(|_| OpenMlsError::DeserializationFailed)?;
    let welcome = match msg.extract() {
        MlsMessageBodyIn::Welcome(w) => w,
        _ => return Err(OpenMlsError::DeserializationFailed),
    };

    let group = StagedWelcome::new_from_welcome(
        &provider,
        &MlsGroupJoinConfig::default(),
        welcome,
        None,
    )
    .map_err(|_| OpenMlsError::GroupJoinFailed)?
    .into_group(&provider)
    .map_err(|_| OpenMlsError::GroupJoinFailed)?;

    let gid = group.group_id().clone();
    pack_group_state(&provider, &gid)
}

// ── Message encrypt / decrypt ───────────────────────────────────────────────────

/// Recover the caller's own signer from persisted storage.
///
/// THE SIGNATURE-KEY FIX. The previous implementation called
/// `SignatureKeyPair::new(...)` here, signing with a key that is not a group
/// member. Local encryption still succeeded — `create_message` does not check —
/// so the failure appeared only at the peer, which is why it went unnoticed.
fn own_signer(
    provider: &PortavaProvider,
    group: &MlsGroup,
) -> Result<SignatureKeyPair, OpenMlsError> {
    let leaf = group.own_leaf_node().ok_or(OpenMlsError::EncryptFailed)?;
    SignatureKeyPair::read(
        provider.storage(),
        leaf.signature_key().as_slice(),
        CS.signature_algorithm(),
    )
    .ok_or(OpenMlsError::EncryptFailed)
}

pub fn encrypt_message(
    group_state_b64: String,
    plaintext: String,
) -> Result<EncryptResult, OpenMlsError> {
    let (provider, mut group) = unpack_group_state(&group_state_b64)?;
    let signer = own_signer(&provider, &group)?;

    let message = group
        .create_message(&provider, &signer, plaintext.as_bytes())
        .map_err(|_| OpenMlsError::EncryptFailed)?;

    let ciphertext_bytes = message
        .tls_serialize_detached()
        .map_err(|_| OpenMlsError::SerializationFailed)?;

    let gid = group.group_id().clone();
    Ok(EncryptResult {
        ciphertext_b64: B64.encode(ciphertext_bytes),
        updated_group_state_b64: pack_group_state(&provider, &gid)?,
    })
}

pub fn decrypt_message(
    group_state_b64: String,
    ciphertext_b64: String,
) -> Result<DecryptResult, OpenMlsError> {
    let (provider, mut group) = unpack_group_state(&group_state_b64)?;

    let ciphertext_bytes = decode_b64(&ciphertext_b64)?;
    let msg = MlsMessageIn::tls_deserialize_exact_bytes(&ciphertext_bytes)
        .map_err(|_| OpenMlsError::DeserializationFailed)?;
    let protocol_msg: ProtocolMessage = match msg.extract() {
        MlsMessageBodyIn::PrivateMessage(pm) => pm.into(),
        MlsMessageBodyIn::PublicMessage(pm) => pm.into(),
        _ => return Err(OpenMlsError::DecryptFailed),
    };

    let processed = group
        .process_message(&provider, protocol_msg)
        .map_err(|_| OpenMlsError::DecryptFailed)?;

    let plaintext = match processed.into_content() {
        ProcessedMessageContent::ApplicationMessage(msg) => {
            String::from_utf8(msg.into_bytes()).map_err(|_| OpenMlsError::DecryptFailed)?
        }
        _ => return Err(OpenMlsError::DecryptFailed),
    };

    let gid = group.group_id().clone();
    Ok(DecryptResult {
        plaintext,
        updated_group_state_b64: pack_group_state(&provider, &gid)?,
    })
}

// ── Safety number derivation ────────────────────────────────────────────────────

/// Derive the safety number from the group's ACTUAL member signature keys.
///
/// This replaces a version that hashed two identity public keys supplied by the
/// caller. Because the old implementation minted a throwaway signing key at
/// every entry point, those identity keys were never used by the MLS session —
/// so a matching safety number proved nothing about the session and could not
/// have detected a MitM at group establishment.
///
/// Reading the keys out of the ratchet tree is what makes verification genuine:
/// substitute a member and the leaf signature key changes, so the number
/// changes. Sorted, so both sides derive the same value.
pub fn derive_safety_number(group_state_b64: String) -> Result<String, OpenMlsError> {
    let (_provider, group) = unpack_group_state(&group_state_b64)?;

    let mut keys: Vec<Vec<u8>> = group.members().map(|m| m.signature_key).collect();
    if keys.len() < 2 {
        return Err(OpenMlsError::SafetyNumberFailed);
    }
    keys.sort();

    let mut hasher = Sha512::new();
    hasher.update(b"portava_safety_number_v2");
    for k in &keys {
        hasher.update((k.len() as u32).to_be_bytes());
        hasher.update(k);
    }
    let hash: [u8; 64] = hasher.finalize().into();

    let mut result = String::with_capacity(60);
    for i in 0..12 {
        let chunk = u32::from_be_bytes([
            hash[i * 4],
            hash[i * 4 + 1],
            hash[i * 4 + 2],
            hash[i * 4 + 3],
        ]);
        result.push_str(&format!("{:05}", chunk % 100_000));
    }
    Ok(result)
}

// ── UniFFI dictionary types ────────────────────────────────────────────────────

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

pub struct KeyPackageResult {
    pub key_package_b64: String,
    pub pending_state_b64: String,
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

// ── Tests ───────────────────────────────────────────────────────────────────────
//
// These exist so "the module ignores its inputs" cannot silently return. That
// was the defect class, not a one-line bug, and it was invisible because
// everything still *ran*.

#[cfg(test)]
mod tests {
    use super::*;

    /// A→B: create, join, encrypt, decrypt — through the module's own API.
    fn pair() -> (String, String) {
        let a_dev = generate_device_key_pair().unwrap();
        let b_dev = generate_device_key_pair().unwrap();

        let b_kp = generate_key_package(
            "user-bob".into(),
            b_dev.ed25519_priv_b64.clone(),
            b_dev.ed25519_pub_b64.clone(),
        )
        .unwrap();

        let created = create_group(
            "user-alice".into(),
            a_dev.ed25519_priv_b64.clone(),
            a_dev.ed25519_pub_b64.clone(),
            b_kp.key_package_b64.clone(),
        )
        .unwrap();

        let b_state = process_welcome(created.welcome_b64, b_kp.pending_state_b64).unwrap();
        (created.group_state_b64, b_state)
    }

    #[test]
    fn round_trip_through_the_module() {
        let (a_state, b_state) = pair();

        let enc = encrypt_message(a_state, "module round trip 001".into()).unwrap();
        let dec = decrypt_message(b_state, enc.ciphertext_b64).unwrap();

        assert_eq!(dec.plaintext, "module round trip 001");
    }

    #[test]
    fn state_survives_a_full_serialise_reload_cycle() {
        // The persistence claim: state is an opaque string the caller stores and
        // hands back. Encrypt twice, feeding the returned state back in.
        let (a_state, b_state) = pair();

        let e1 = encrypt_message(a_state, "first".into()).unwrap();
        let e2 = encrypt_message(e1.updated_group_state_b64, "second".into()).unwrap();

        let d1 = decrypt_message(b_state, e1.ciphertext_b64).unwrap();
        let d2 = decrypt_message(d1.updated_group_state_b64, e2.ciphertext_b64).unwrap();

        assert_eq!(d1.plaintext, "first");
        assert_eq!(d2.plaintext, "second");
    }

    /// KEY IMPORT. The caller's device key must be the key MLS actually uses.
    /// If this fails, the module has gone back to minting its own.
    #[test]
    fn the_group_uses_the_device_key_it_was_given() {
        let a_dev = generate_device_key_pair().unwrap();
        let b_dev = generate_device_key_pair().unwrap();

        let b_kp = generate_key_package(
            "user-bob".into(),
            b_dev.ed25519_priv_b64.clone(),
            b_dev.ed25519_pub_b64.clone(),
        )
        .unwrap();
        let created = create_group(
            "user-alice".into(),
            a_dev.ed25519_priv_b64.clone(),
            a_dev.ed25519_pub_b64.clone(),
            b_kp.key_package_b64,
        )
        .unwrap();

        let (_p, group) = unpack_group_state(&created.group_state_b64).unwrap();
        let keys: Vec<String> = group
            .members()
            .map(|m| B64.encode(m.signature_key))
            .collect();

        assert!(
            keys.contains(&a_dev.ed25519_pub_b64),
            "alice's own device key must be in the group"
        );
        assert!(
            keys.contains(&b_dev.ed25519_pub_b64),
            "bob's device key must be in the group"
        );
    }

    /// CREDENTIAL CONTENT. The old code put the identity PRIVATE key here.
    #[test]
    fn credential_carries_a_public_identifier_not_key_material() {
        let a_dev = generate_device_key_pair().unwrap();
        let b_dev = generate_device_key_pair().unwrap();

        let b_kp = generate_key_package(
            "user-bob".into(),
            b_dev.ed25519_priv_b64.clone(),
            b_dev.ed25519_pub_b64.clone(),
        )
        .unwrap();
        let created = create_group(
            "user-alice".into(),
            a_dev.ed25519_priv_b64.clone(),
            a_dev.ed25519_pub_b64.clone(),
            b_kp.key_package_b64,
        )
        .unwrap();

        let (_p, group) = unpack_group_state(&created.group_state_b64).unwrap();
        for m in group.members() {
            let identity = m.credential.serialized_content().to_vec();
            let as_text = String::from_utf8_lossy(&identity).to_string();
            assert!(
                as_text.contains("user-"),
                "credential should hold a user identifier, got {as_text:?}"
            );
            for secret in [&a_dev.ed25519_priv_b64, &b_dev.ed25519_priv_b64] {
                assert!(
                    !as_text.contains(secret.as_str()),
                    "a private key must never appear in a credential"
                );
            }
        }
    }

    /// SAFETY NUMBERS must be genuine: both sides agree, and the value is bound
    /// to the keys actually in the group.
    #[test]
    fn safety_number_agrees_on_both_sides() {
        let (a_state, b_state) = pair();
        let a_num = derive_safety_number(a_state).unwrap();
        let b_num = derive_safety_number(b_state).unwrap();

        assert_eq!(a_num.len(), 60);
        assert_eq!(a_num, b_num, "both members must derive the same number");
    }

    #[test]
    fn safety_number_differs_for_a_different_peer() {
        // A different peer means a different leaf signature key, so a MitM
        // substitution is visible. If this ever fails, verification is theatre.
        let (a1, _) = pair();
        let (a2, _) = pair();
        assert_ne!(
            derive_safety_number(a1).unwrap(),
            derive_safety_number(a2).unwrap(),
            "a different peer must produce a different safety number"
        );
    }

    /// THE ORIGINAL DEFECT, carried across from the spike so it stays
    /// demonstrated. Signing with a non-member key must not survive the peer —
    /// and note the sender sees no error, which is why it went unnoticed.
    #[test]
    fn old_behaviour_signing_with_a_fresh_keypair_is_rejected() {
        let (a_state, b_state) = pair();
        let (provider, mut group) = unpack_group_state(&a_state).unwrap();

        let bogus = SignatureKeyPair::new(CS.signature_algorithm()).unwrap();
        let msg = group
            .create_message(&provider, &bogus, b"signed with the wrong key")
            .expect("local encrypt still succeeds — this is why it was silent");

        let bytes = msg.tls_serialize_detached().unwrap();
        let (provider_b, mut group_b) = unpack_group_state(&b_state).unwrap();
        let incoming = MlsMessageIn::tls_deserialize_exact_bytes(&bytes).unwrap();
        let protocol_msg: ProtocolMessage = match incoming.extract() {
            MlsMessageBodyIn::PrivateMessage(pm) => pm.into(),
            MlsMessageBodyIn::PublicMessage(pm) => pm.into(),
            _ => unreachable!(),
        };

        assert!(
            group_b.process_message(&provider_b, protocol_msg).is_err(),
            "peer must reject a message signed with a non-member key"
        );
    }

    #[test]
    fn import_signer_rejects_malformed_key_material() {
        assert!(import_signer("not-base64!!", "also-bad").is_err());
        assert!(import_signer(&B64.encode([0u8; 16]), &B64.encode([0u8; 32])).is_err());
    }
}
