# External Cryptography Review — Scoping Brief

**Project:** Portava (social travel platform) — end-to-end encrypted messaging
**Engagement:** ~1 week, single senior applied-cryptography reviewer
**Budget band:** $5–15K (per internal design doc, Appendix B)
**Timing:** after internal two-device verification passes; before E2EE is enabled beyond internal test accounts

Suggested repo location: `docs/security/crypto-review-brief.md`

## What we built

End-to-end encryption for 1:1 messaging in a React Native / Expo app, with
group messaging, media, push, and calls planned in later phases.

- **Protocol:** MLS (RFC 9420) via the OpenMLS Rust crates
  (`openmls 0.6`, `openmls_rust_crypto 0.3`, `openmls_basic_credential 0.3`).
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
- **Safety numbers:** per-1:1 derivation from both identity keys, with
  change-detection banner.
- **Deliberate scope exclusions:** traffic analysis, endpoint compromise,
  compelled disclosure. Comments and the in-app AI assistant chat are
  intentionally not E2EE (documented).

Full internal docs the reviewer receives: threat model + design
(`docs/security/e2ee-design.md`), execution plan, completion report,
verification runbook with results.

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
4. **The send/receive path** (`src/lib/mlsSession.ts`,
   `src/services/telegraphService.ts` integration) — plaintext handling
   windows, whether plaintext can reach the server or logs on any code
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

## Out of scope for this engagement

- The planned later phases (group E2EE, media, push envelopes, calls,
  backup/recovery) — design feedback welcome, implementation review not
  expected.
- General app security outside the E2EE subsystem.
- Formal verification.

## Deliverables requested

- Written findings: severity-ranked (critical / high / medium / low /
  informational), each with location, impact, and recommended fix.
- A go / no-go opinion on enabling E2EE for an opt-in beta.
- One review call to walk the findings.
- Optional: re-review of fixes for critical/high items (budget permitting).

## Access we provide

- Read access to the repository (branch with the E2EE work).
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

- Push notifications currently carry readable payloads (Phase E-5 will
  fix; known).
- Old threads remain plaintext by design ("legacy" migration stance).
- Multi-device pairing UX (QR flow) not yet implemented; a fresh install
  currently means a new identity.
- No formal protection against a malicious server withholding or
  reordering ciphertext (availability attacks accepted in threat model).
