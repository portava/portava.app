# E2EE spike — MLS group persistence round trip

**Date:** 2026-08-08 · **Result: YES, it works.** · **Timebox: 2–4 days. Actual: under half a day.**

Code: `spikes/mls-storage-roundtrip/` — throwaway by design, safe to delete.
These findings are here rather than in that directory so they survive deleting it.

## Objective

One `MlsGroup` created, persisted via a `StorageProvider`, reloaded, and used to
encrypt; peer decrypts. Proving the primitive, not building the feature.

## Result

Both tests pass:

```
test spike::group_round_trips_through_storage_snapshot ... ok
test spike::old_behaviour_signing_with_a_fresh_keypair_is_rejected ... ok
```

The full loop works: A creates a group → adds B → **snapshot storage to bytes →
drop group and provider → restore from bytes → `MlsGroup::load` → encrypt** → B
decrypts, plaintext matches byte-for-byte.

The `MlsGroup`-is-not-TLS-serialisable blocker is real but **not fatal**. It is
the wrong mechanism, not a missing capability. The right one exists.

## How persistence actually works

Not `MlsGroup::tls_serialize` (which does not exist). Instead:

- `MemoryStorage` — the storage provider behind `OpenMlsRustCrypto` — holds a
  flat `HashMap<Vec<u8>, Vec<u8>>` and exposes `serialize(&mut Vec<u8>)` /
  `deserialize(&mut impl Read)`.
- Snapshot the **whole provider**, not the group. Restore it, then
  `MlsGroup::load(storage, &group_id)` rehydrates the group.
- The signer comes back out of the same storage via
  `SignatureKeyPair::read(storage, leaf_signature_key, alg)`.

So the existing TS contract — "group state is a blob we load before each
operation and store after" — **survives in shape**. It becomes *provider*
snapshot rather than *group* snapshot. `mlsSession.ts`'s external interface can
stay close to what it is; the Rust side and the meaning of the blob change.

## Four findings that affect the build

1. **`MemoryStorage::serialize`/`deserialize` are `#[cfg(feature = "test-utils")]`**,
   commented "For testing (KATs in particular)". The spike enables that feature
   to get the answer. **Shipping production persistence on a test-only feature
   is not acceptable** — the real answer is a custom `StorageProvider`
   implementation backed by SecureStore/SQLCipher. That is the single largest
   remaining piece of work and it is not in the current code at all.
2. **`OpenMlsRustCrypto` cannot be rehydrated.** Its `key_store` field is
   private with no constructor taking a restored `MemoryStorage`. A provider
   struct has to be hand-rolled (the spike's `SpikeProvider`, ~10 lines).
   Production needs this regardless.
3. **`into_welcome` / `into_protocol_message` are test-only too.** The
   production path is `tls_serialize_detached()` → `MlsMessageIn::
   tls_deserialize_exact_bytes()` → `.extract()`. This is what the wire does
   anyway, so it is a correction, not a cost.
4. **The group must be created with `.use_ratchet_tree_extension(true)`**, or
   the Welcome carries no ratchet tree and the joiner cannot build the group.
   The first attempt failed here, not on persistence. One line; easy to lose.

## The signature-key defect — demonstrated, and the fix fell out

`vendor/expo-openmls/src/lib.rs` `encrypt_message` generates a fresh random
`SignatureKeyPair` per call instead of the member's own leaf signer.

`old_behaviour_signing_with_a_fresh_keypair_is_rejected` reproduces it. Two
things worth knowing:

- **Local encryption still succeeds.** `create_message` accepts the wrong
  signer without complaint. The failure is entirely at the peer. That is why it
  was never noticed: nothing goes wrong on the sending device.
- The peer rejects it at `process_message`, as it must.

**The fix is one line and it fell out of having a harness**, exactly as
predicted: read the signer from storage instead of minting one —
`SignatureKeyPair::read(storage, own_leaf_node().signature_key(), alg)`.
It is already in the passing round-trip test. It has **not** been applied to
`vendor/expo-openmls`, because that was not this spike's job.

## Version decision

**Pinned to 0.6**, not rewritten down to 0.5.0. Reason: the source already
targets 0.6 APIs, so 0.6 was the shorter path to an answer, and 0.6 is where
the `StorageProvider` model the fix depends on is properly established.
Dependencies resolve and compile clean on 0.6 in a standalone crate.

## What this does to the estimate

The spike says the architecture is sound and the library supports what is
needed. It does not make the earlier 4.5–6 weeks credible again on its own,
because that number was built on "wire two joins" and the Rust module needs
more than wiring. Revised view:

| Work | Estimate |
|---|---|
| Manifest fixes (0.6 pin, uniffi feature, add `thiserror`) | 0.5 d |
| Rewrite module persistence to provider-snapshot + hand-rolled provider | 2–3 d |
| **Custom `StorageProvider` over SecureStore/SQLCipher** (replaces the test-only path) | **4–6 d** |
| Signature-key fix + Rust tests around it | 0.5 d |
| Remaining compile errors (credential API, KeyPackageIn validation) | 1–2 d |
| First real EAS build, iOS + Android, incl. cross-compile targets | 1–3 d, high variance |
| **Rust module to green** | **9–15 d** |

Then the previously-scoped work continues: send-path wiring, thread-list
previews, moderation excerpts, attachments, verification, external review.

**Revised total: 6.5–8.5 weeks** (was 4.5–6). The delta is the Rust module,
which the earlier estimate assumed was done.

Biggest remaining unknown is **not** cryptographic — it is the first EAS build.
Nothing here has ever been cross-compiled for iOS or Android, and the Rust
toolchain needed two workarounds even to run on x86-64 Linux
(`GLIBC_TUNABLES=glibc.rtld.optional_static_tls=2097152`,
`RUST_MIN_STACK=16777216`). Those are this sandbox's problems and should not
recur on EAS workers, but "should not" is not "has not".

## Build-vs-replace

This is a **cheap success**, so on the criterion set for it, **A1 stands** —
the library does what the design needs, and the existing design was pointed the
right way even though the code was not. The reason to reopen the question would
be the Rust module's quality, not the protocol choice; and the module is ~370
lines, so rewriting its internals against a working harness is days, not weeks.

Recorded so it is not decided by momentum: the estimate went 2–3 wk → 4.5–6 wk
→ 6.5–8.5 wk across three passes, each time because something assumed-done was
not. That trend is itself worth weighing.

## Reproducing

```bash
export PATH="$HOME/.cargo/bin:$PATH"
export GLIBC_TUNABLES=glibc.rtld.optional_static_tls=2097152
export RUST_MIN_STACK=16777216
cd spikes/mls-storage-roundtrip && cargo test
```

Toolchain lives in `$HOME`, outside the repo, and is not committed. The spike is
not part of any build: there is no root `Cargo.toml`, so nothing picks it up.
