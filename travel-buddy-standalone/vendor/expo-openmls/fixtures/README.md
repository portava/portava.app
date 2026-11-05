# Synthetic OpenMLS compatibility fixture

`openmls-0.6.0-session.json` was generated locally on 5 November 2026 by the iOS simulator FFI fixture using fresh `alice-ios-fixture` / `bob-ios-fixture` identities. It contains **test-only private key material**, never user/account credentials or production messages. It is intentionally checked in to prove saved 0.6.0 sessions can still be read by the patched library.

The fixture contains Alice's state after sending one Unicode/NUL test message and Bob's state returned after decrypting it, plus that test ciphertext and Welcome. It reproduces the old receive-secret persistence defect: the 0.6.0 Bob snapshot predates consumption of the decryption key. Compatibility does not imply that old consumed keys can be retroactively erased; tests require newly consumed keys to be removed from newly saved state.

Do not use these identities or snapshots outside tests.
