# Telegraph OpenMLS iOS runtime validation

This fixture compiles the actual Rust library and generated Swift UniFFI bindings, then launches three **separate iOS simulator processes**. It creates and deletes its own simulator and removes scratch session material. It does not use a physical device, account credentials, production endpoints, feature flags or the app's React Native runtime.

## What the run proves

- Actual iOS simulator execution and native key generation across UniFFI.
- Alice/Bob create/join, distinct local MLS credential owners and agreeing member safety numbers.
- Encrypted Unicode/NUL payloads and both message directions.
- Persisted ratchet and owner restoration after the previous process exits.
- Refusal of replayed ciphertext, corrupted ciphertext, another recipient's Welcome, malformed sessions and a mismatched stored group ID.
- Compatibility with the checked-in, synthetic OpenMLS 0.6.0 session snapshot: both owners restore, new bidirectional messages work, and a newly consumed ciphertext cannot be consumed again from the newly returned state.

The run has 21 named checks across create (7), restore (9) and legacy (5) processes. Runtime assertions are repeated in each process; this is not 21 physical-device acceptance tests. It tests generated Swift → UniFFI → Rust execution. The Expo wrapper is separately compiled by the integration build; full Expo/React Native application invocation is not claimed here.

## Reproduce

Prerequisites: Xcode with an installed iOS simulator runtime, a compatible existing simulator device type, Rust with `aarch64-apple-ios-sim`, and the locked Cargo dependencies already downloaded. The runner builds offline and refuses source-local Cargo targets so it cannot touch the shared Android target. Use a new output directory.

```sh
python3 tools/telegraph/native-ios/run-fixture.py \
  --module /tmp/portava-telegraph-native/expo-openmls \
  --output /tmp/portava-openmls-ios-proof-next \
  --target-dir /tmp/portava-openmls-ios-cargo \
  --bindings /tmp/portava-telegraph-native/expo-openmls/ios/Rust/uniffi/openmls
```

Run from repository root. `--module` may instead name the repository's current vendored module. Omit `--bindings` to generate Swift bindings from its actual UDL; when reusing bindings they must come from that API. UniFFI's runtime function checksums also reject incompatible bindings. The evidence records source, binding, static-library and executable hashes, exact SDK/runtime, three reports, and `physicalDevice:false` / `expoReactNativeRuntimeExercised:false`. `commands.json` records executable command arrays. No private session state appears in test logs; the compatibility snapshot contains only deliberately generated test identities, described in its fixture README.

## November 5 result and repaired defect

Final proof: `/tmp/portava-openmls-ios-proof-2/evidence.json` — **21/21 checks**, iOS 27.1 simulator, three actual processes, arm64 iOS-simulator executable and real OpenMLS static library. The temporary simulator and scratch sessions were deleted. `/tmp/portava-openmls-patched-rust-tests.log` records **11/11 Rust tests**.

The first real runtime run exposed consumed-message replay after state reload. The new regression also failed under the original Rust dependency (`/tmp/portava-openmls-replay-red.log`). The cause is the receive-secret persistence defect described by upstream [GHSA-qr9h-x63w-vqfm](https://github.com/openmls/openmls/security/advisories/GHSA-qr9h-x63w-vqfm): old library processing changed in-memory receive secrets without persisting them.

The module now pins the [OpenMLS 0.7.4 maintenance release](https://github.com/openmls/openmls/releases/tag/openmls-v0.7.4), with `openmls_rust_crypto=0.4.4` and credential/traits/memory storage `0.4.1`; `Cargo.lock` fixes the complete graph. Choosing only 0.7.1 would omit the later [tag-validation fix](https://github.com/openmls/openmls/security/advisories/GHSA-8x3w-qj7j-gqhf) and provider maintenance. The existing wrapper API and serialized 0.6 sessions required no format rewrite. The UDL's stale base64url comment was corrected to match the implementation's standard padded base64; the wire encoding did not change.

### Legacy-state boundary

The patched version persists **newly consumed** receive keys. It cannot retroactively erase a key that 0.6 consumed only in memory and failed to record as consumed in an old saved snapshot. The legacy test deliberately verifies forward compatibility and new consumption behavior; it does not relabel old artifacts as retrospectively repaired. Upstream describes recovery through subsequent authenticated epoch advancement or enough subsequent receive progress to move old secrets outside the configured window. This change does not manufacture commits, discard outgoing messages, skip generations or rewrite crypto storage to simulate that progress. The client's canonical message deduplication and encrypted plaintext cache remain separate application controls, not proof that an old native snapshot had deleted a key.

Android's corresponding instrumentation checks, including persisted replay refusal, are documented separately by the native Android lane. Neither simulator result establishes physical-device lifecycle, production deployment, recovery across all historical releases, or a general security certification.
