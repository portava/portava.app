//! SPIKE — throwaway. Objective: prove one MlsGroup can be created, persisted
//! via a StorageProvider, reloaded, and used to encrypt; and that the peer can
//! decrypt. Nothing here is production shape.

#[cfg(test)]
mod spike {
    use base64::{engine::general_purpose::STANDARD as B64, Engine};
    use openmls::prelude::*;
    use openmls_basic_credential::SignatureKeyPair;
    use openmls_memory_storage::MemoryStorage;
    use openmls_rust_crypto::RustCrypto;
    use openmls_traits::OpenMlsProvider;
    use tls_codec::Serialize as _;

    const CS: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

    /// FINDING: `OpenMlsRustCrypto` has a private `key_store` and no
    /// constructor taking a restored `MemoryStorage`, so a provider that can be
    /// rehydrated has to be hand-rolled. This is what production would need too.
    #[derive(Default)]
    struct SpikeProvider {
        crypto: RustCrypto,
        storage: MemoryStorage,
    }

    impl OpenMlsProvider for SpikeProvider {
        type CryptoProvider = RustCrypto;
        type RandProvider = RustCrypto;
        type StorageProvider = MemoryStorage;
        fn storage(&self) -> &Self::StorageProvider { &self.storage }
        fn crypto(&self) -> &Self::CryptoProvider { &self.crypto }
        fn rand(&self) -> &Self::RandProvider { &self.crypto }
    }

    fn identity(name: &str, p: &SpikeProvider) -> (CredentialWithKey, SignatureKeyPair) {
        let credential = BasicCredential::new(name.as_bytes().to_vec());
        let signer = SignatureKeyPair::new(CS.signature_algorithm()).unwrap();
        signer.store(p.storage()).unwrap();
        (
            CredentialWithKey {
                credential: credential.into(),
                signature_key: signer.public().into(),
            },
            signer,
        )
    }

    /// THE THING UNDER TEST: snapshot the whole storage provider to bytes …
    fn snapshot(p: &SpikeProvider) -> String {
        let mut buf = Vec::new();
        p.storage.serialize(&mut buf).unwrap();
        B64.encode(buf)
    }

    /// … and rebuild a provider from that snapshot.
    fn restore(b64: &str) -> SpikeProvider {
        let bytes = B64.decode(b64).unwrap();
        SpikeProvider {
            crypto: RustCrypto::default(),
            storage: MemoryStorage::deserialize(&mut bytes.as_slice()).unwrap(),
        }
    }

    /// Production wire path: out -> bytes -> in. (`into_welcome` /
    /// `into_protocol_message` are test-only helpers in 0.6.)
    fn wire(msg: MlsMessageOut) -> MlsMessageIn {
        let bytes = msg.tls_serialize_detached().unwrap();
        MlsMessageIn::tls_deserialize_exact_bytes(&bytes).unwrap()
    }

    #[test]
    fn group_round_trips_through_storage_snapshot() {
        // ── A creates a group ────────────────────────────────────────────────
        let a1 = SpikeProvider::default();
        let (a_cred, a_signer) = identity("alice", &a1);

        let mut a_group = MlsGroup::new(
            &a1,
            &a_signer,
            &MlsGroupCreateConfig::builder()
                .ciphersuite(CS)
                .use_ratchet_tree_extension(true)
                .build(),
            a_cred,
        )
        .expect("create group");
        let gid = a_group.group_id().clone();

        // ── B publishes a KeyPackage ─────────────────────────────────────────
        let b = SpikeProvider::default();
        let (b_cred, b_signer) = identity("bob", &b);
        let b_kp = KeyPackage::builder()
            .build(CS, &b, &b_signer, b_cred)
            .expect("build key package");

        // ── A adds B ─────────────────────────────────────────────────────────
        let (_commit, welcome, _gi) = a_group
            .add_members(&a1, &a_signer, &[b_kp.key_package().clone()])
            .expect("add member");
        a_group.merge_pending_commit(&a1).expect("merge");

        // ── DIAGNOSTIC: is the group in the LIVE provider's storage? ─────────
        let live = MlsGroup::load(a1.storage(), &gid).expect("live load ok");
        eprintln!("DIAG live-storage group present: {}", live.is_some());
        let snap = snapshot(&a1);
        eprintln!("DIAG snapshot bytes(b64 len): {}", snap.len());
        let round = restore(&snap);
        eprintln!("DIAG restored key count: {}", round.storage.values.read().unwrap().len());
        eprintln!("DIAG live key count:     {}", a1.storage.values.read().unwrap().len());
        drop(a_group);
        drop(a1);

        // ── B joins from the Welcome ─────────────────────────────────────────
        let welcome_in = match wire(welcome).extract() {
            MlsMessageBodyIn::Welcome(w) => w,
            _ => panic!("expected a Welcome"),
        };
        let mut b_group = StagedWelcome::new_from_welcome(
            &b,
            &MlsGroupJoinConfig::default(),
            welcome_in,
            None,
        )
        .expect("stage welcome")
        .into_group(&b)
        .expect("join group");

        // ── RELOAD A from the snapshot, then encrypt ─────────────────────────
        let a2 = restore(&snap);
        let mut a_group2 = MlsGroup::load(a2.storage(), &gid)
            .expect("load ok")
            .expect("group present in restored storage");

        let a_signer2 = SignatureKeyPair::read(
            a2.storage(),
            a_group2.own_leaf_node().unwrap().signature_key().as_slice(),
            CS.signature_algorithm(),
        )
        .expect("signer recovered from restored storage");

        const PLAINTEXT: &[u8] = b"spike message alpha 001";
        let ct = a_group2
            .create_message(&a2, &a_signer2, PLAINTEXT)
            .expect("encrypt after reload");

        // ── B decrypts ───────────────────────────────────────────────────────
        let protocol_msg: ProtocolMessage = match wire(ct).extract() {
            MlsMessageBodyIn::PrivateMessage(pm) => pm.into(),
            MlsMessageBodyIn::PublicMessage(pm) => pm.into(),
            _ => panic!("expected an application message"),
        };
        let processed = b_group.process_message(&b, protocol_msg).expect("decrypt");

        match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(app) => {
                assert_eq!(app.into_bytes(), PLAINTEXT, "round-tripped plaintext");
            }
            _ => panic!("expected an application message"),
        }
    }

    /// The disclosed defect, demonstrated. `encrypt_message` in
    /// vendor/expo-openmls generates a FRESH random SignatureKeyPair per call
    /// instead of reading the member's own leaf signer out of storage. This
    /// reproduces that and asserts it does not survive the peer.
    ///
    /// The fix is the `SignatureKeyPair::read(...)` line in the test above —
    /// it fell out of having a working harness, exactly as predicted.
    #[test]
    fn old_behaviour_signing_with_a_fresh_keypair_is_rejected() {
        let a = SpikeProvider::default();
        let (a_cred, a_signer) = identity("alice", &a);
        let mut a_group = MlsGroup::new(
            &a,
            &a_signer,
            &MlsGroupCreateConfig::builder()
                .ciphersuite(CS)
                .use_ratchet_tree_extension(true)
                .build(),
            a_cred,
        )
        .unwrap();

        let b = SpikeProvider::default();
        let (b_cred, b_signer) = identity("bob", &b);
        let b_kp = KeyPackage::builder().build(CS, &b, &b_signer, b_cred).unwrap();
        let (_c, welcome, _g) = a_group
            .add_members(&a, &a_signer, &[b_kp.key_package().clone()])
            .unwrap();
        a_group.merge_pending_commit(&a).unwrap();

        let welcome_in = match wire(welcome).extract() {
            MlsMessageBodyIn::Welcome(w) => w,
            _ => unreachable!(),
        };
        let mut b_group =
            StagedWelcome::new_from_welcome(&b, &MlsGroupJoinConfig::default(), welcome_in, None)
                .unwrap()
                .into_group(&b)
                .unwrap();

        // ── THE DEFECT: a fresh signer, not the member's own ─────────────────
        let bogus = SignatureKeyPair::new(CS.signature_algorithm()).unwrap();
        let ct = a_group
            .create_message(&a, &bogus, b"signed with the wrong key")
            .expect("local encrypt still succeeds — which is why this is silent locally");

        let protocol_msg: ProtocolMessage = match wire(ct).extract() {
            MlsMessageBodyIn::PrivateMessage(pm) => pm.into(),
            MlsMessageBodyIn::PublicMessage(pm) => pm.into(),
            _ => unreachable!(),
        };
        let result = b_group.process_message(&b, protocol_msg);
        assert!(
            result.is_err(),
            "peer must reject a message signed with a non-member key; got {:?}",
            result.map(|_| "accepted")
        );
    }
}
