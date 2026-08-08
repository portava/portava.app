# External Cryptography Review — Scoping Brief

**Project:** Portava (social travel platform) — end-to-end encrypted messaging
**Engagement:** 1.5–2 weeks, single senior applied-cryptography reviewer
**Budget band:** $5–15K (per internal design doc, Appendix B) — see note on scope growth below
**Timing:** after internal two-device verification passes; before E2EE is enabled beyond internal test accounts

> **Scope note (2026-08-08):** encrypted DM **attachments** are now in scope for
> implementation and therefore for this review. The earlier revision of this
> brief deferred all media to "later phases, implementation review not
> expected". That is no longer true: media envelope encryption ships in the
> same increment as 1:1 text. The timebox above was widened from ~1 week
> accordingly. If a candidate quotes against the old 1-week figure, the media
> sections are the difference.

## Current state — please read before quoting

Stated plainly so the engagement is not mis-scoped. **Updated 2026-08-08 after
the Rust was compiled for the first time; the previous revision understated
this.**

- The cryptographic core (Rust/OpenMLS module, identity and device keys,
  KeyPackage pool, safety numbers, server ciphertext columns) is **written and
  merged**. The server schema is **already live in production**.
- **The Rust module does not currently compile.** It had never been built —
  `cargo`/`rustup` were absent from the development environment and compilation
  was assumed to happen only on EAS workers. A host toolchain has now been
  installed and the crate compiled for the first time: **~32 errors**, the
  significant ones being:
  - **Manifest and source disagree on the OpenMLS version.** `Cargo.toml` pins
    `openmls 0.5.0 / openmls_rust_crypto 0.2.0 / openmls_basic_credential
    0.2.0`, but the source is written against **0.6 APIs**
    (`MlsGroupCreateConfig`, `StagedWelcome`, `tls_deserialize_exact_bytes`).
    Bumping to 0.6 removes some errors, not all.
  - **`uniffi` declares a `scaffolding` feature that does not exist** in
    0.28.3, so dependency resolution fails before any code compiles.
  - **`thiserror` is used but never declared as a dependency**, so the error
    type implements neither `Display` nor `ToString`.
  - **The group-state persistence model is not supported by the library.** The
    module serialises an `MlsGroup` to bytes and restores it, and the
    TypeScript layer is built on that contract — "group state is loaded fresh
    on each operation and stored back immediately after". **`MlsGroup` is not
    TLS-serialisable in 0.5 or 0.6.** OpenMLS persists groups through a
    `StorageProvider` trait (`MlsGroup::load<Storage: StorageProvider>`). This
    is an architectural change to the module and to the JS boundary, not a
    compile fix.
- Consequently **the two-device verification runbook has never been run**
  (`docs/security/e2ee-verification-runbook.md`; running it green is a
  precondition for this engagement), and the `encrypt_message` signature-key
  defect disclosed below has never been reached at runtime — it is a semantic
  bug sitting behind ~32 compile errors.
- **The existing test suite does not exercise real cryptography.** The E-0/E-1/
  E-2 Jest tests call `jest.mock('expo-openmls')` and run against a
  deterministic in-memory mock with a fake encrypt/decrypt round-trip. They
  demonstrate wiring and lifecycle, not cryptographic correctness. Please do
  not read "42 tests passing" as evidence about the protocol.

**What this means for the engagement.** The module will be brought to a
compiling, two-device-verified state *before* the review starts — that is
unchanged. But a candidate should know the persistence layer is being reworked
first, and that the version to review is the post-rework one. We will confirm
readiness before booking dates.

We will supply a **fixed commit SHA and branch** at engagement start, plus a
working EAS development build.

## What we built

End-to-end encryption for 1:1 Telegraph direct messages — **text and
attachments** — in a React Native / Expo app. Group messaging, push envelopes,
and calls remain planned for later phases.

- **Protocol:** MLS (RFC 9420) via the OpenMLS Rust crates. **Version is
  currently inconsistent** — the manifest pins 0.5.0 while the source targets
  0.6 APIs; this will be settled (expected: 0.6) as part of making the module
  build, and the review copy will carry a single consistent version.
- **Ciphersuite:** MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519.
- **Bridge:** Rust → React Native via UniFFI 0.28, packaged as an Expo
  native module (`packages/expo-openmls`).
- **Identity:** long-lived Ed25519 identity key per user; Ed25519+X25519
  device key per install; KeyPackages published to the server
  (Supabase/Postgres) and consumed one-shot on group add.
- **Key storage:** expo-secure-store (iOS Keychain
  WHEN_UNLOCKED_THIS_DEVICE_ONLY; Android Keystore-backed).
- **Local store:** SQLCipher-backed SQLite for decrypted history +
  FTS5 search; root key held in secure store.
- **Server:** stores ciphertext only for E2EE threads
  (`messages.ciphertext`, `body` NULL); SSE fanout of ciphertext;
  metadata (sender, thread, timestamps, receipts) intentionally
  server-visible.
- **Media (new):** per-item random 256-bit content key; AEAD envelope
  encryption client-side **before** upload; ciphertext to a separate storage
  bucket via a **new opaque-blob upload route**; **content key, nonce and
  content-type hint carried inside the MLS-encrypted message body**. Encrypted
  thumbnails generated client-side.
- **Safety numbers:** per-1:1 derivation from both identity keys, with
  change-detection banner.
- **Deliberate scope exclusions:** traffic analysis, endpoint compromise,
  compelled disclosure. Comments and the in-app AI assistant chat are
  intentionally not E2EE (documented).

### Threat-model decisions we have already taken

These are choices, not oversights. Please evaluate the design **as chosen**
rather than assuming a recovery path exists:

- **Single device per user.** A fresh install produces a new identity and a new
  safety number. Multi-device (as MLS group members) is a later phase.
- **No key backup, and no message-history recovery.** Lose the device, lose the
  history — permanently, for the user and for us. Keys are
  `WHEN_UNLOCKED_THIS_DEVICE_ONLY` and deliberately excluded from OS backup.
  Cloud key escrow (iCloud/Google) and QR key-export were both considered and
  **rejected**, because either would make "end-to-end" conditional.
- **Attachments inherit that property by construction**, because the content
  key lives only inside the encrypted message body. See invariant (10) below.

Full internal docs the reviewer receives: threat model + design
(`docs/security/e2ee-design.md`), execution plan, completion report,
verification runbook with results, and the scoping proposal that records the
media decision (`docs/security/e2ee-scoping-proposal.md`).

## What we want reviewed (priority order)

1. **UniFFI boundary and Rust integration** (`packages/expo-openmls/src/lib.rs`)
   — state management of `MlsGroup` instances, serialization of key
   material across the FFI boundary, error handling, anything that could
   leak secrets into JS-visible memory or logs.
2. **Key lifecycle** — identity/device key generation, KeyPackage
   publication and one-shot consumption, epoch rotation on membership
   change, what happens on reinstall / device removal / KeyPackage
   exhaustion.
3. **Session and group state persistence** — how MLS group state is
   persisted between app launches, whether stale or forked state is
   possible, replay handling.
4. **The send/receive path** (`src/lib/mlsSession.ts`, and its integration in
   `src/services/messaging.ts` / `src/services/telegraph*.ts`) — plaintext
   handling windows, whether plaintext can reach the server or logs on any code
   path, offline queue behavior, SSE reconnect behavior.
5. **Graceful-fallback correctness** — the module detects when the native
   binary is unavailable and falls back to plaintext with a visible
   indicator; confirm this cannot be triggered adversarially to downgrade
   a session silently.
6. **Safety-number derivation** — construction, collision/format issues,
   change-detection correctness.
7. **Local encrypted store** — SQLCipher keying, FTS index behavior,
   key handling on backup/uninstall.
8. **Server-side assumptions** — KeyPackage endpoints (authz, signature
   validation, malformed-package rejection), whether the server can
   perform an active MitM at group establishment that safety numbers
   would not surface.

### Media-specific targets (new, and unreviewed by anyone)

9. **The opaque-blob upload route.** DM attachments cannot use our existing
   `POST /media/upload`, because that route sniffs magic bytes to identify the
   format (ciphertext has none, so it rejects), re-encodes images (which would
   destroy ciphertext), and generates thumbnails server-side (which requires
   readable pixels). The encrypted path therefore needs a **brand-new route
   that accepts opaque bytes and does none of those things** — and is
   consequently new, unreviewed code on an authenticated upload surface.

   Please check explicitly that it **re-implements the safety controls the
   existing path provides**: the 15 MB image / 100 MB video size caps, the
   `disable_media_uploads` feature-flag check, and the 30-uploads-per-5-minutes
   rate limit. Our own assessment is that **silently dropping one of these is
   the realistic failure mode** — it would not break anything visibly, and it
   is exactly the kind of omission an external pair of eyes should be pointed
   at. Also worth your attention: what an unauthenticated or cross-user actor
   can do to this route, and whether opaque bytes can be used as arbitrary
   object storage.

10. **INVARIANT WE WANT ATTACKED: the content key never leaves the MLS
    ciphertext.** Per-item media content keys are carried *inside* the
    MLS-encrypted message body and nowhere else. Not in a column, not beside
    `media_url`, not in any server-visible field.

    This single invariant is what makes attachments share the text's fate: lose
    the device → lose the message → lose the content key → the attachment
    ciphertext is permanently undecryptable by anyone, including us.

    **We are asking you to attack it specifically, because it fails quietly.**
    If a future change stored the content key alongside `media_url` — as an
    apparently harmless optimisation — every feature would keep working, no
    test would fail, no user-visible behaviour would change, and the property
    would be silently gone. We would like both an assessment of whether the
    current design actually holds the invariant, and a recommendation for how
    to make a violation *loud* (a test, an assertion, a schema constraint).

11. **Client-supplied attachment metadata.** `thumbnailUrl`, `durationSeconds`,
    `mediaType` and size hints are supplied by the client and **cannot be
    verified server-side**, because the server cannot read the ciphertext they
    describe. Please consider what a malicious or compromised client can do
    with that: mismatched content-type hints, a thumbnail that does not
    correspond to the payload, absurd durations, thumbnails pointing at
    unrelated objects, or metadata used as a covert channel. We would like a
    view on which of these matter and which are acceptable.

12. **Media envelope construction.** Cipher choice (AES-256-GCM vs
    ChaCha20-Poly1305), nonce generation and reuse risk across items and
    retries, whether one content key is reused for a payload and its thumbnail,
    key derivation, and whether the AEAD covers enough associated data to bind
    an attachment to its message and sender.

13. **Large-media handling.** With a single-blob AEAD, correct use means not
    releasing plaintext until the tag verifies, which conflicts with streaming
    a large video on a memory-constrained device. Our current intent is to
    **cap DM video size well below the public 100 MB limit** and defer chunked
    AEAD. We would value a view on that trade, and — if chunking is advised —
    on the construction (per-chunk nonce, chunk counter, final-chunk marker,
    truncation and reordering resistance).

14. **Plaintext at rest after decryption.** Decrypted media must reach the
    platform image/video players. If that requires writing plaintext to a temp
    file, we want confirmation that it is excluded from OS backup on both
    platforms and reliably removed — a decrypted DM photo captured in an iCloud
    or Android auto-backup would defeat the no-recovery decision above as
    thoroughly as key escrow would.

## Out of scope for this engagement

- The planned later phases (group/circle E2EE, push envelopes, calls,
  multi-device pairing, backup/recovery) — design feedback welcome,
  implementation review not expected. **Media is no longer in this list.**
- General app security outside the E2EE subsystem.
- Formal verification.

## Deliverables requested

- Written findings: severity-ranked (critical / high / medium / low /
  informational), each with location, impact, and recommended fix.
- A go / no-go opinion on enabling E2EE for an opt-in beta.
- An explicit yes/no on invariant (10), and on whether the new upload route
  (9) preserves the existing safety controls.
- One review call to walk the findings.
- Optional: re-review of fixes for critical/high items (budget permitting).

## Access we provide

- Read access to the repository, at a **fixed commit SHA** supplied at start.
- The internal docs listed above.
- A development build for hands-on testing on request.
- Async contact with the developer for questions during the week.

## Candidate profile

Senior applied cryptographer or security engineer with direct experience
in at least one of: MLS/OpenMLS, libsignal or Signal-protocol
deployments, secure messaging systems at production scale, or Rust FFI
security review. Prior published audits (NCC, Trail of Bits, Cure53
style) a strong plus.

## What we already know is imperfect (so review time goes to the unknown)

- **A known defect in `encrypt_message`** (`packages/expo-openmls/src/lib.rs`):
  it currently generates a fresh random `SignatureKeyPair` per call instead of
  using the member's leaf signature key. We expect this to fail signature
  verification at the peer. It will be fixed and verified before the
  engagement; noted here so you do not spend time rediscovering it, and as a
  candid signal about what "merged but never compiled" means for this codebase.
- Push notifications currently carry readable payloads (Phase E-5 will
  fix; known).
- **No MLS epoch rotation in 1:1 threads.** Membership never changes, so the
  ratchet advances only on group re-creation. We accept the post-compromise-
  security gap this creates; a view on whether that is defensible is welcome,
  but it is a known choice rather than an oversight.
- Old threads remain plaintext by design ("legacy" migration stance).
- Multi-device is deliberately absent, not merely unimplemented (see threat
  model above); a fresh install means a new identity.
- No formal protection against a malicious server withholding or
  reordering ciphertext (availability attacks accepted in threat model).
- Attachment metadata (approximate size, upload time, sender, thread) remains
  server-visible; only the payload and thumbnail are encrypted.
- Undecryptable attachment ciphertext accumulates in storage after device loss;
  retention/cleanup policy is not yet defined.
