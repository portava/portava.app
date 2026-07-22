# E2EE Execution Plan: Phases E-0 → E-2

**Source of truth:** `docs/security/e2ee-design.md`
**Date:** 2026-07-22
**Scope:** Phases E-0 (prerequisites), E-1 (identity/device keys), E-2 (1:1 message E2EE). E-3 through E-10 are out of scope.

---

## 1. Architecture snapshot (pre-implementation audit)

| Area | Current state | E2EE impact |
|---|---|---|
| Auth session storage | `supabase.createClient({ auth: { persistSession: true } })` — default AsyncStorage | E-0: swap to expo-secure-store adapter |
| Message cache | `useSnapshotCache` → AsyncStorage, JSON snapshots keyed by user+threadId | E-0: mirror in SQLCipher; AsyncStorage cache stays for non-sensitive snapshot needs |
| `messages` table | `id, thread_id, sender_id, body, msg_type, subtype, created_at, edited_at, deleted_at, original_language, sender_original_language, language_detection_source, translated_body_json` | E-2: add `ciphertext TEXT`, `is_e2ee` on threads table |
| Telegraph SSE | `telegraphStream.ts` server-side event bus; `telegraphRealtimeService.ts` XHR-based client | E-2: SSE fanout unchanged; client decrypts after receipt |
| Push pipeline | `NotificationRouter.ts` → `push.ts` (Expo Push API); payload has `title` + `body` | E-5 will encrypt; E-0/E-1/E-2 do not change push payload |
| Translation | `POST /messages/:id/translate/retry`; `GET /me/language-settings`; body scanned server-side | E-2: server refuses translation for `is_e2ee` threads; client shows tooltip |
| Off-app solicitation scanner | Scans `body` in `POST /threads/:threadId/messages` | E-2: scanner skips when `is_e2ee=true`; server can't read ciphertext |
| LiveKit | Token minted in `livekitService.ts`; client in `livekitBridge.ts`; no E2EE config | E-6 (deferred) |
| Compass context | `CompassContextEngine.ts` + `compass-v1.ts` — confirmed does NOT read `messages.body` | No change needed; already clean |
| `notification_devices` table | Push tokens; no crypto keys | E-0 adds separate `devices` table |
| Crypto (server) | `randomUUID`, `randomBytes`, `createHmac` in various files | E-1/E-2 add key-package and ciphertext handling routes |

---

## 2. Phase E-0 — Prerequisites

### 2.1 Dependencies

| Package | Version | Purpose | Native? |
|---|---|---|---|
| `expo-secure-store` | `~14.0.1` (SDK 54 compatible) | iOS Keychain / Android Keystore for key material + auth session | ✅ requires EAS build |
| `@op-engineering/op-sqlite` | `^17.1.2` | SQLCipher-backed SQLite for encrypted local message cache | ✅ requires EAS build |

Both packages are native modules. They are not supported in Expo Go. The project already uses EAS development builds (confirmed in `eas.json`). A **new EAS development build is required** after E-0 lands before the app can run with these packages.

### 2.2 DB migration

`artifacts/api-server/src/migrations/20260801_e2ee_devices.sql`

Creates `devices` table with nullable `public_key` (populated in E-1). Includes a `-- DOWN:` block.

### 2.3 Code changes

**Mobile (`artifacts/travel-buddy/`):**

| File | Change |
|---|---|
| `src/lib/secureStore.ts` | **New.** Typed wrapper around expo-secure-store. Platform guard (falls back to no-op on web). Key-name constants for all E-0/E-1/E-2 SecureStore keys. `SecureStoreAdapter` implementing the Supabase storage interface. |
| `src/lib/supabase.ts` | **Modified.** Pass `SecureStoreAdapter` as `auth.storage`. Guards against web/Jest environments where SecureStore is unavailable. |
| `src/lib/e0Migration.ts` | **New.** One-shot migration. Reads Supabase session from AsyncStorage, writes to SecureStore, clears AsyncStorage copy, marks `e0_migration_done` in SecureStore. Idempotent. Runs once at startup before first Supabase operation. |
| `src/lib/localMessageDb.ts` | **New.** SQLCipher setup. Generates (or recovers) 32-byte DB key from SecureStore. Opens `local_messages.db`. Creates `cached_messages` table. Exports query/insert helpers. FTS5 added in E-2. |
| `__mocks__/expo-secure-store.ts` | **New.** Jest mock (in-memory Map). Used by all E-0/E-1/E-2 tests. |
| `__mocks__/@op-engineering/op-sqlite.ts` | **New.** Jest mock (in-memory SQLite simulation). |

**Server (`artifacts/api-server/`):**

| File | Change |
|---|---|
| `src/migrations/20260801_e2ee_devices.sql` | **New.** devices table. |
| `src/routes/devices.ts` | **New.** `POST /me/devices` (register), `GET /me/devices` (list), `DELETE /me/devices/:id` (unregister), `PUT /me/devices/:id/public-key` (E-1 uses this). |
| `src/routes/index.ts` | **Modified.** Import and mount `devicesRouter`. |

**iOS NSE scaffold:**

| File | Change |
|---|---|
| `artifacts/travel-buddy/ios/PortavaNSE/NotificationService.swift` | **New.** Empty forwarding handler (E-5 adds decryption). |
| `artifacts/travel-buddy/plugins/withPortavaNSE.js` | **New.** Expo config plugin that adds the NSE target to the Xcode project. |
| `artifacts/travel-buddy/app.json` | **Modified.** Add `plugins: ["./plugins/withPortavaNSE"]`. |

### 2.4 Systems changing behavior

- **Supabase auth session:** Stored in Keychain/Keystore instead of AsyncStorage. Invisible to code that calls `supabase.auth.getSession()` (SDK handles it). Tests that mock the Supabase client directly are unaffected.
- **SSE reconnect / `apiToken.ts`:** Calls `auth.getSession()` → now reads from SecureStore. Transparent to the caller; no code change needed in `apiToken.ts`.
- **`useSnapshotCache`:** Continues using AsyncStorage. Not affected by E-0.
- **Translation prefs (`thread_translation:<id>`):** Continues using AsyncStorage. Not affected.
- **Compass persistence:** Continues using AsyncStorage. Not affected.
- **Web preview:** SecureStore not available on web. The `SecureStoreAdapter` falls back to a no-op in-memory shim so the app renders in the web preview without crashing (auth won't persist across reloads on web, which is acceptable).

### 2.5 Security risks mitigated

- Supabase access token no longer readable from AsyncStorage by other processes or debugging tools.
- Local message cache encrypted at rest (SQLCipher AES-256).

### 2.6 Security risks introduced

- SQLCipher DB key is device-local. Reinstall (E-0 only, before E-8) = unrecoverable cache loss. Messages are still available from the server (plaintext in E-0; ciphertext from E-2 onward — see E-2 risk note).
- SecureStore items survive app reinstall on Android (Keystore behavior) but not on iOS (Keychain cleared on delete). Documented gap; E-8 addresses recovery.

### 2.7 Rollback strategy (E-0)

1. Server: `DROP TABLE IF EXISTS devices;` (no FK dependencies yet).
2. Client: revert `supabase.ts` to remove `SecureStoreAdapter`. Remove `expo-secure-store` and `@op-engineering/op-sqlite` from `package.json`. Users who installed the E-0 build must log in again (session migrated to SecureStore won't be in AsyncStorage on rollback build).
3. Deploy rollback as app update. Impact: one re-login.

### 2.8 Validation gate (E-0)

- [ ] All existing tests pass (`mobile-test`, `standalone-test`, `api-test` workflows)
- [ ] New tests: SecureStore round-trip (mocked), SQLCipher open/query (mocked), e0Migration idempotency, devices table API (up/down)
- [ ] `mobile-typecheck` and `standalone-typecheck` pass
- [ ] EAS development build installs without error (requires manual EAS build trigger)
- [ ] Manual: fresh install → app works; upgrade install → session migrated, no re-login prompt; iOS NSE target present in Xcode project

---

## 3. Phase E-1 — Identity and Device Keys

### 3.1 Dependencies

| Package | Location | Version | Purpose |
|---|---|---|---|
| `packages/expo-openmls` | new monorepo package | local | Expo native module wrapping OpenMLS via Rust + UniFFI |
| `openmls` (Rust) | `packages/expo-openmls/Cargo.toml` | `0.5.1` | MLS RFC 9420 implementation |
| `uniffi` (Rust) | same | `0.28.3` | FFI bindings generator (Swift + Kotlin) |
| `tls_codec` (Rust) | same | `0.4.1` | TLS serialization for KeyPackages |
| `ed25519-dalek` (Rust) | same | `2.1.1` | Ed25519 key generation independent of MLS (for identity key) |
| `x25519-dalek` (Rust) | same | `2.0.1` | X25519 key generation for device HPKE key |
| `sha2` (Rust) | same | `0.10.8` | SHA-512 for safety number derivation |
| `base64` (Rust) | same | `0.22.1` | Base64 encode/decode for byte ↔ string boundary |

### ⚠️ CRITICAL: Rust/Cargo environment requirement

**Rust is not installed in the Replit workspace** (`cargo-not-found`, `rustup-not-found`).

The `packages/expo-openmls` Rust source will be compiled exclusively in **EAS cloud build** workers, which have `rustup` and `cargo` pre-installed (macOS M-series for iOS, Ubuntu with Android NDK for Android).

**The EAS build must be configured to:**
1. Install cross-compilation targets: `aarch64-apple-ios` (iOS), `aarch64-linux-android` + `armv7-linux-androideabi` (Android 32/64).
2. Run `cargo build --release` for each target before the Xcode/Gradle build.
3. Link the resulting `.a` / `.so` libraries into the respective platforms.

This is handled by the `ExpoOpenmls.podspec` (iOS) and `android/build.gradle` (Android) in the native module.

**Halting condition (per hard rules):** If the EAS build fails to compile `packages/expo-openmls` for iOS or Android, halt and report. Do not fall back to a JS MLS implementation.

### 3.2 Code changes

**New package `packages/expo-openmls/`:**

| File | Purpose |
|---|---|
| `package.json` | Expo native module metadata |
| `Cargo.toml` | Rust workspace config; OpenMLS + UniFFI deps |
| `src/lib.rs` | Rust implementation: key gen, KeyPackage gen, group create/join, encrypt/decrypt, safety number |
| `openmls.udl` | UniFFI interface definition (functions exposed to Swift/Kotlin) |
| `build.rs` | UniFFI scaffolding generation |
| `ios/ExpoOpenmls.podspec` | CocoaPods spec; links Rust static lib + UniFFI-generated Swift |
| `ios/ExpoOpenmls/ExpoOpenmlsModule.swift` | Expo module (wraps UniFFI bindings, async functions) |
| `android/build.gradle` | Gradle build; JNI library from Rust cross-compile |
| `android/src/main/java/expo/modules/openmls/ExpoOpenmlsModule.kt` | Expo module (wraps UniFFI-generated Kotlin) |
| `src/index.ts` | TypeScript API surface (re-exports typed functions) |
| `src/ExpoOpenmls.types.ts` | TypeScript types for all function signatures |

**Mobile (`artifacts/travel-buddy/`):**

| File | Change |
|---|---|
| `src/lib/cryptoIdentity.ts` | **New.** Key generation on first launch. Checks SecureStore for existing keys; generates if absent; populates `devices` table via API. |
| `src/hooks/useCryptoInit.ts` | **New.** React hook that calls `cryptoIdentity.ts` once per session on first launch. Mounted in root `_layout.tsx`. |
| `__mocks__/expo-openmls.ts` | **New.** Jest mock for all OpenMLS functions. |

**Server (`artifacts/api-server/`):**

| File | Change |
|---|---|
| `src/routes/keyPackages.ts` | **New.** `POST /me/devices/:deviceId/key-packages` (upload pool), `GET /users/:userId/key-packages/consume` (consume one), `GET /me/devices/:deviceId/key-packages/inventory` (count). |
| `src/lib/database/migrations/20260801_e2ee_devices.sql` | Already created in E-0; `key_package_count` added via column in original migration. |
| `src/routes/index.ts` | **Modified.** Add `keyPackagesRouter`. |

### 3.3 Systems changing behavior

- First-launch cold start adds ~200ms for key generation (Ed25519 + X25519, one-time only).
- `devices` table populated with real public keys. Device list visible to authenticated server (metadata, not key material).
- KeyPackage pool uploaded to server (public material only; private halves never leave device).

### 3.4 Security risks mitigated

- Identity established per-device. No key material on server.

### 3.5 Security risks introduced

- No multi-device pairing in E-1 (E-9 scope). Second device registration creates a fresh identity, breaking continuity with any E-2 threads established by the first device.
- KeyPackage pool exhaustion (server signals low inventory; client must refill). Until refill, new groups cannot be formed with this device as recipient.

### 3.6 Rollback (E-1)

Remove `packages/expo-openmls` from monorepo. Remove server `keyPackages.ts` and `devices` route public-key endpoint. Revert `_layout.tsx` to remove `useCryptoInit`. Private keys remain in SecureStore (harmless; overwritten on next E-1 install).

### 3.7 Validation gate (E-1)

- [ ] All existing tests pass
- [ ] New tests: key generation idempotency (mocked), KeyPackage upload/consume server routes, malformed signature rejection
- [ ] Typecheck passes on both trees
- [ ] EAS build compiles `packages/expo-openmls` for iOS and Android (manual EAS trigger required)
- [ ] On device: keys generated once per install; private material never in logs or server payloads (grep + network inspection)
- [ ] Two devices for same user appear in `devices` table with distinct public keys

---

## 4. Phase E-2 — 1:1 E2EE Messaging

### 4.1 Dependencies

No new npm packages. Depends on E-0 (SecureStore + SQLCipher) and E-1 (OpenMLS native module).

### 4.2 DB migrations

| File | Purpose |
|---|---|
| `20260802_messages_ciphertext.sql` | `ALTER TABLE messages ADD COLUMN ciphertext TEXT;` + `ALTER TABLE message_threads ADD COLUMN is_e2ee BOOLEAN NOT NULL DEFAULT FALSE;` with indexes and `-- DOWN:` block |

### 4.3 Code changes

**Mobile:**

| File | Change |
|---|---|
| `src/lib/mlsSession.ts` | **New.** MLS group state management. Open/create/join groups, persist group state in SecureStore, encrypt/decrypt message bodies. |
| `src/services/messaging.ts` | **Modified.** `sendMessage()` encrypts if `isE2ee=true`. `getThreadMessages()` decrypts each message after fetch. |
| `src/lib/localMessageDb.ts` | **Modified.** Add FTS5 virtual table over decrypted content. |
| `src/components/GroupChatScreen.tsx` or thread header | **Modified.** Render lock badge when `thread.isE2ee`. |
| `src/screens/SafetyNumberScreen.tsx` | **New.** Displays safety number for a 1:1 E2EE thread, derived from both users' identity public keys. |
| `src/components/TranslateButton.tsx` or equivalent | **Modified.** Show tooltip "Translation unavailable for encrypted messages" when `thread.isE2ee`. |
| `__mocks__/expo-openmls.ts` | Already created in E-1. |

**Server:**

| File | Change |
|---|---|
| `src/routes/messaging.ts` | **Modified.** `POST /threads/:threadId/messages`: accept `ciphertext` field; when `is_e2ee=true` on the thread, `body` must be null and `ciphertext` must be non-empty. Off-app solicitation scanner skips E2EE threads. `POST /messages/:messageId/translate/retry`: return 422 if thread `is_e2ee=true`. |
| `src/routes/messaging.ts` | **Modified.** `POST /users/:userId/open-thread`: mark new 1:1 threads as `is_e2ee=true` if both users' devices have public keys registered. |

### 4.4 Systems changing behavior

- **Translation:** Server-side translation refuses E2EE threads at the API layer (422 with `e2ee_thread` error code). Client disables the button with a tooltip.
- **Off-app solicitation scanner:** Skips `body` scan for E2EE threads (body is null; ciphertext is opaque).
- **SSE fanout:** Unchanged. Ciphertext field forwarded in SSE events alongside other metadata.
- **Push notifications:** `body` field in push payload is set to `null` for E2EE messages in E-0/E-1/E-2. Full encrypted push is E-5. In E-2, recipient receives a generic "New message" push.
- **Compass:** No changes. Already confirmed Compass does not read `messages.body`. The E-2 route changes ensure `body=null` for E2EE messages, making any accidental read return null.

### 4.5 Security risks mitigated

- Message content is never in server DB in plaintext for new 1:1 threads.
- Translation pipeline cannot access E2EE content (server-enforced).

### 4.6 Security risks introduced

- Loss of MLS group state (SecureStore wipe) = permanent message loss. The local SQLCipher DB is also lost. Mitigated post-E-8 with encrypted backup.
- No periodic epoch rotation in E-2 (deferred to E-3 operational work). Forward secrecy advances only on membership changes (none for 1:1). Post-compromise security gap: an attacker with a snapshot of group state at time T can decrypt all future messages until a membership-change epoch. For 1:1 (never changes membership), this means a one-time key compromise has broad impact. Accepted as known gap for v1; documented.
- Old plaintext 1:1 threads remain readable in DB. Backfill encryption is deferred and out of scope.

### 4.7 Rollback (E-2)

1. Server migration down: `ALTER TABLE messages DROP COLUMN IF EXISTS ciphertext; ALTER TABLE message_threads DROP COLUMN IF EXISTS is_e2ee;`
2. Revert server `messaging.ts` changes.
3. Revert client `mlsSession.ts`, `messaging.ts`, badge, safety number screen.
4. E2EE threads become unreadable to rolled-back clients (orphaned ciphertext). Only new threads were E2EE; old threads continue working.

### 4.8 Validation gate (E-2)

- [ ] All existing tests pass
- [ ] New unit tests: encrypt/decrypt round-trip (mocked MLS), group establishment, safety number derivation, ciphertext column write/read
- [ ] Integration test: plaintext thread and E2EE thread coexist; clients don't cross wires
- [ ] Regression: legacy plaintext threads — delivery, translation, push, search all pass existing test suite
- [ ] Grep: `messages.body` reads in Compass code paths do not intersect with `is_e2ee=true` thread routing
- [ ] Typecheck passes on both trees
- [ ] EAS build + two real devices: full end-to-end scenario from the design spec

---

## 5. Cross-cutting rules

- Never log: plaintext message bodies, private keys, recovery secrets, KeyPackage private halves, MLS group secrets, or any derived key material.
- Log opaque handles only (e.g. message ID, thread ID, device ID).
- All new server routes use `requireUser` and reject anonymous callers.
- All new DB columns are additive (no existing NOT NULL constraints broken).
- Compass code paths are audited at end of each phase for accidental plaintext access.

---

## 6. EAS build configuration changes

| Phase | Change |
|---|---|
| E-0 | No explicit EAS config change needed; `expo-secure-store` and `op-sqlite` are auto-linked by Expo. |
| E-1 | `eas.json` `prebuildCommand` must install Rust cross-compilation targets. `packages/expo-openmls/ios/ExpoOpenmls.podspec` and `android/build.gradle` must trigger `cargo build` before linking. Custom EAS build hook in `scripts/eas-install-rust.sh`. |
| E-2 | No additional EAS changes. |

---

## 7. Environment variables / production config required

| Item | Phase | Note |
|---|---|---|
| No new env vars | E-0 | SecureStore uses device-local Keychain/Keystore; no server secret needed |
| No new env vars | E-1 | Key material device-local; server stores only public keys |
| No new env vars | E-2 | Ciphertext stored in existing DB; no new infrastructure |
| New EAS build hook | E-1 | Manual: configure `eas.json` `prebuildCommand` to install Rust toolchain |
| Supabase migration apply | E-0, E-2 | Run migrations against production via Management API (see `supabase-migration-access.md`) |
