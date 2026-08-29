# E2EE for Telegraph DMs — scoping proposal

**Status:** decisions recorded 2026-08-08 (§0.1). Scoping only — no
implementation has been done in any pass.
**Date:** 2026-08-08
**Branch:** `bughunt-20260805`
**Scope, already decided and not reopened here:** E2EE applies to Telegraph
**direct messages only**. Public and shared media stay server-readable so
moderation and the planned 4K transcode pipeline keep working. This document
does not argue with that.

---

> ## ⚠️ Verified against the tree — 2026-08-29
>
> **§1 has been overtaken by implementation. Do not read it as a description of
> what exists today.** §1 was accurate when written — it pins itself to
> `494e4d3bc` (§1 preamble) and its counts were exact at that commit. It has not
> been rewritten; the original claims stay visible and each stale one is annotated
> inline. Every correction below was produced by running a command, not by reading.
>
> **The two that matter, because acting on them would delete working code:**
>
> 1. **"the only production import of `mlsSession` anywhere is `SafetyNumberScreen`
>    … written, tested, and never called"** (§1.3a) — **false.**
>    `src/services/messaging.ts:200` imports `realCryptoPort` and calls through it
>    at `:456`, `:466`, `:500` and `:709`. The funnel is `openDirectThread`
>    (`:644`), which **awaits** `negotiateE2eeForNewThread` at `:675`. The client
>    encrypts today.
> 2. **"Nothing ever sets `is_e2ee = true` … written nowhere"** (§1.3b) —
>    **false.** `artifacts/api-server/src/routes/messaging.ts:1282` does
>    `.update({ is_e2ee: true })` inside `POST /api/threads/:threadId/e2ee`
>    (`:1224`), gated on membership, `thread_type = 'direct'` and a delivered
>    `e2ee_welcome`. The client half is `markThreadE2ee`
>    (`src/services/messaging.ts:532`), wired at `:724`.
>
> **Neither the client encryption path nor the `is_e2ee` write is dead code.**
>
> **"tested" is separately false.** The suite covering the encryption functions,
> `mlsSession.e2.test.ts` (10 cases), executes in no runner. What *does* run is the
> orchestration layer above them — `src/lib/e2ee/__tests__/` (34 cases, passing
> under `pnpm test`) — and it drives a fake `CryptoPort`, so it never reaches
> `mlsSession`. See the corrected test row in §1.1.

---

## 0.1 DECISIONS — recorded 2026-08-08

Both decided by the owner. Not reopened below; the rest of this document is
scoping *for* them, not argument about them.

**Decision 1 — accepted as recommended: A1 / B1 / C1.**
Finish the existing MLS wiring; **single device**; **message history is not
recoverable on device loss**. Multi-device via MLS members and opt-in
passphrase backup come later, in that order.
Explicitly **rejected**: QR key-export (B3) and iCloud/Google key backup (C3).
Both would reverse the existing `WHEN_UNLOCKED_THIS_DEVICE_ONLY` SecureStore
decision and make "end-to-end" require an asterisk.

**Decision 2 — goes further than this document originally recommended, and
deliberately so: DM attachments must be encrypted before E2EE ships.**
Not text-only. The reasoning is the sentence in §1.7 — encrypted text beside
server-readable photos is *defensible as v1 but not as a marketing claim* — and
the owner would rather carry the extra scope than ship a claim needing
qualification.

Consequence: design-phase **E-4 Media E2EE** (`e2ee-design.md` §3.2) moves
*into* the first shippable increment. §6 below scopes it. §4's original
"first increment" and its estimate are superseded by §6.6.

---

## 0. The headline

**Do not scope this as a greenfield build. Most of it already exists in this
repo, and it is further along than anyone appears to remember.**

There is a real MLS (RFC 9420) implementation here: a Rust/OpenMLS Expo native
module, per-user identity keys, per-device keys, a server KeyPackage pool,
ciphertext columns **already live in the production schema**, safety-number
derivation and UI, and an SQLCipher-encrypted local message store. Roughly
70% of a working 1:1 E2EE system.

**It is nonetheless completely inert today.** Not one message is encrypted,
because two specific joins were never made (§1.3). Both are small. Neither is
the hard part of E2EE — the hard part is done.

The decisions you asked for (key management, multi-device, history-on-loss)
are therefore *mostly already made in code*. The real question is no longer
"which design" but **"do we finish, verify and ship the design that is already
here, or deliberately replace it?"** I recommend finishing it. See §5.

There is also **one security-relevant defect** and **one dangerous
duplication** to be aware of before any of this ships — §1.5 and §1.6. Neither
had been caught, because the Rust has never been compiled in this workspace
(no `cargo`/`rustup`) and the two-device runbook has never been run. The
defect would cause every encrypted message to fail signature verification at
the peer, so it would be caught the first time two devices talked to each
other. It is not a silent-data-loss risk, but it does mean "the code exists"
must not be read as "the code works".

---

## 1. STEP 1 — What already exists

Everything in this section was verified by reading code in the working tree at
`494e4d3bc`, not from the design docs. Where I am inferring rather than
confirming, I say so.

### 1.1 Inventory

| Piece | Location | State |
|---|---|---|
| MLS protocol module (Rust) | `packages/expo-openmls/src/lib.rs`, 373 lines | **Real.** Genuine OpenMLS calls — `MlsGroup::new`, `create_message`, `process_message`, `StagedWelcome`. Not a stub. |
| Ciphersuite | `Cargo.toml` | `openmls 0.5.0`, `openmls_rust_crypto 0.2.0`, UniFFI 0.28.3, ed25519/x25519-dalek, sha2 |
| Native bridges | `packages/expo-openmls/{ios,android}` | Swift + Kotlin Expo modules present |
| Identity & device keys | `src/lib/cryptoIdentity.ts` (169 ln) | Present |
| Key storage | `src/lib/secureStore.ts` (158 ln) | expo-secure-store, `~14.0.1` installed |
| MLS session mgmt | `src/lib/mlsSession.ts` (223 ln) | Present — `initGroupAsInitiator/Recipient`, `encryptForThread`, `decryptFromThread`, `deriveSafetyNumberForThread` |
| Local encrypted store | `src/lib/localMessageDb.ts` (225 ln) | SQLCipher via `@op-engineering/op-sqlite ^17.1.2` (installed). FTS5 referenced. |
| Crypto bootstrap | `src/hooks/useCryptoInit.ts` | **Mounted** — called at `app/_layout.tsx:88`, so identity generation + device registration run on every launch today |
| Safety numbers UI | `src/screens/SafetyNumberScreen.tsx` (259 ln), `src/components/ThreadSafetySheet.tsx` (307 ln) | Present, and `SafetyNumberScreen` is the **only** production caller of `mlsSession` — ⚠️ **stale 2026-08-29:** `src/lib/e2ee/realPort.ts:16` is a second importer, and it is the one the send/receive path runs through |
| Server: devices | `migrations/20260801_e2ee_devices.sql` | **Live** |
| Server: KeyPackage pool | `migrations/20260802_e2ee_key_packages.sql` + `routes/keyPackages.ts` | **Live.** 3 endpoints: publish, inventory, one-shot consume |
| Server: ciphertext | `migrations/20260803_messages_ciphertext.sql` | **Live** — confirmed in `database.types.ts`, which was regenerated against the live schema in `1c0cfdaea` |
| Server: send path | `routes/messaging.ts:1580-1671` | **Implemented.** Accepts `ciphertext`, enforces `body=null` on E2EE threads, rejects plaintext into an E2EE thread, 64 KB cap — ⚠️ **line numbers stale 2026-08-29:** `1580` now lands inside the *GET*-messages translation block. The send path is `POST /threads/:threadId/messages` at **`1698-2009`**, ciphertext logic at **`1707-1813`**. The behaviour described is unchanged |
| Tests | `src/lib/__tests__/{secureStore.e0,localMessageDb.e0,cryptoIdentity.e1,mlsSession.e2}.test.ts` | **CORRECTED 2026-08-08: present but NOT running anywhere.** All four are in the EXCLUDE array in `scripts/run-node-tests.mjs`; they do not match `test:component`'s `\.component\.test\.` filter; and under jest they fail at module resolution. An earlier revision of this table claimed they were part of the green 3696 — that was read off a grep hit inside an exclude list. ⚠️ **The 2026-08-08 correction is itself wrong on two counts, re-checked 2026-08-29.** *(a) The set is wrong.* `secureStore.e0.test.ts` no longer exists — it was repaired, renamed `secureStore.e0.component.test.ts`, removed from the exclude list, and now runs under jest (13 cases passing); and `e0Migration.test.ts`, which this row never named, is orphaned. The orphan set is `cryptoIdentity.e1` (7), `e0Migration` (7), `localMessageDb.e0` (9), `mlsSession.e2` (10) = **33 cases**. *(b) Nothing fails at module resolution under jest.* `cryptoIdentity.e1`, `e0Migration` and `mlsSession.e2` all die at `TypeError: (0, _expoSecureStore._reset) is not a function` — a missing mock, not a resolution failure — and `localMessageDb.e0` never reaches a test: the suite fails to run with `SyntaxError: Cannot use import statement outside a module`, a transform failure. (Run directly under the node:test runner they die inside `expo-modules-core` instead, which is a third failure again.) The array is spelled `KNOWN_BROKEN`, not `EXCLUDE`. |

> ⚠️ **Line counts in the table are the `494e4d3bc` counts — re-measured
> 2026-08-29.** `cryptoIdentity.ts` 169 → **234**, `secureStore.ts` 158 → **168**
> (and 286 on the pending `fix/securestore-keychain-resilience` branch),
> `mlsSession.ts` 223 → **233**, `SafetyNumberScreen.tsx` 259 → **265**,
> `ThreadSafetySheet.tsx` 307 → **311**. `localMessageDb.ts` is still 225, and
> `packages/expo-openmls/src/lib.rs` is still 373 — but see §1.6, that is not the
> file the app builds.

This was executed as a planned programme, not accreted — there are design,
execution-plan and completion-report documents for it (§1.8). Note however that
**the phase numbering is NOT consistent between those documents**: design-phase
E-4 is media encryption, completion-report E-4 is multi-device. Always name the
document alongside the phase.

### 1.2 How DMs are stored today, and what the server can read

- `message_threads` — `id, thread_type, trip_id, circle_owner_id, title,
  created_at, updated_at, last_message_at, status`, plus **`is_e2ee BOOLEAN
  NOT NULL DEFAULT FALSE`**.
- `messages` — `id, thread_id, sender_id, body, deleted_at, created_at,
  edited_at, original_language, msg_type, subtype, media_url, media_type,
  media_thumbnail_url, media_duration_seconds`, plus **`ciphertext TEXT`**
  (nullable).

Today `body` holds plaintext and the server reads it freely. The intended end
state — already coded server-side — is `body NULL` + `ciphertext` populated for
threads where `is_e2ee = true`.

### 1.3 Why it is inert — the two missing joins

**(a) The client never encrypts.** `src/services/messaging.ts:414`:

```ts
export async function sendMessage(threadId, body, opts) {
  return apiPost(`/api/threads/${threadId}/messages`, { body, ...opts });
}
```

Plaintext `body`, always. Nothing in `src/services/` or `app/` imports
`encryptForThread` or `decryptFromThread` — the only production import of
`mlsSession` anywhere is `SafetyNumberScreen`. The encryption functions are
written, tested, and never called.

> ⚠️ **FALSE as of 2026-08-29 — this gap was closed.** `sendMessage` now lives at
> `src/services/messaging.ts:478` and its body is
> `const payload = await buildOutgoingPayload(realCryptoPort, threadId, body, isE2ee === true)`
> (`:500`); on an E2EE thread it throws `E2eeSendBlockedError` rather than falling
> back to plaintext. `realCryptoPort` is imported at `:200`, and
> `src/lib/e2ee/realPort.ts:16` imports `encryptForThread`/`decryptFromThread` from
> `mlsSession` — so "the only production import is `SafetyNumberScreen`" is stale
> too. **"tested" was never true**: `mlsSession.e2.test.ts` runs in no runner.

**(b) Nothing ever sets `is_e2ee = true`.** The flag is *read* in two places
(send path, translate path) and *written* nowhere. There is no thread-creation
path that negotiates E2EE, consumes the peer's KeyPackage, or calls
`initGroupAsInitiator`. So even if (a) were fixed, every thread would still
take the plaintext branch.

> ⚠️ **FALSE as of 2026-08-29.** `POST /api/threads/:threadId/e2ee`
> (`artifacts/api-server/src/routes/messaging.ts:1224`) writes the flag at `:1282`,
> after checking membership, `thread_type = 'direct'`, and that an `e2ee_welcome`
> system message has already been delivered — no Welcome, no flag. The
> thread-creation path this paragraph says does not exist is
> `negotiateE2eeForNewThread` (`src/services/messaging.ts:705`), awaited from
> `openDirectThread` at `:675` for **newly created** threads only: it consumes the
> peer's KeyPackage, calls `initGroupAsInitiator` through `realCryptoPort`, sends
> the Welcome, then calls `markThreadE2ee` (`:532`, wired at `:724`).

These two gaps are why nothing is encrypted despite everything else existing.

> ⚠️ **Both gaps are closed — 2026-08-29.** New 1:1 threads negotiate MLS and
> encrypt today. What remains unverified is whether the resulting ciphertext is
> *correct*: see §1.5 and the correction under it.

### 1.4 What the server genuinely needs to read — the breakage list

This is the list you asked for **before** deciding. I checked each against the
current code rather than assuming.

| Feature | Reads message content? | Verdict under E2EE |
|---|---|---|
| **Unread counts** (`/me/unread-counts`) | **No** — compares `last_message_at` against `lastReadAt` timestamps | **Survives unchanged.** The single most reassuring finding here. |
| Delivery / SSE fanout | No — routes opaque rows | Survives |
| Thread ordering | No — `last_message_at` | Survives |
| **Thread-list preview** (`messaging.ts:1339`) | **Yes** — `lm.body.slice(0,80)` | **Breaks.** Needs a client-side preview from the local store. |
| **Push notification body** (`NotificationTemplateService.ts:220`) | **Yes** — `body: ({preview}) => preview ?? 'New message'` | **Degrades gracefully already.** With no preview it falls back to "New message". Acceptable day one; §3 has the better fix. |
| **Server-side translation** (`messaging.ts:2044`) | Yes | **Already handled** — explicitly refuses on `is_e2ee` threads |
| **Off-app-contact detection** (`OFF_APP_PATTERNS`, `messaging.ts:1694`) | Yes | **Already handled** — explicitly skipped for E2EE |
| **Moderation of reported DMs** (`routes/moderation.ts`) | Reads `sender_id` only, not body | **Partially ready.** Header already says "For E2EE message reports: subject_id=messageId, thread_id stored for future attachment flow" — the attachment flow does not exist yet. §3. |
| **Message search** | **No server-side DM search exists.** No `ilike`/`tsvector`/`to_tsquery` in `messaging.ts` | **Nothing to break.** Search is already intended to be local (FTS5 in `localMessageDb`). |
| **DM attachments** (`media_url`) | Yes — media stays a plain URL | **Designed but unimplemented.** Envelope encryption is specified in `e2ee-design.md` §3.2 (design-phase E-4); not built, not in the first increment. See §1.7. |
| Spam detection | No dedicated DM content scanner found | Nothing found to break |

**Two of the four features you were most worried about — unread counts and
server-side search — turn out not to be problems at all.** Unread counts are
purely timestamp-based, and server-side DM search was never built.

### 1.5 Security-relevant defect found while reading

`packages/expo-openmls/src/lib.rs:256` in `encrypt_message`:

```rust
let signature_keys = SignatureKeyPair::new(SignatureScheme::ED25519, &backend)
    .map_err(|_| OpenMlsError::EncryptFailed)?;
let message = group.create_message(&backend, &signature_keys, plaintext.as_bytes())
```

This generates a **fresh random signature keypair on every encrypt** instead of
loading the member's own leaf signature key. MLS application messages must be
signed by the sender's credential key, so the peer's verification should reject
every message. `decrypt_message` has no matching call, which reinforces that
this is an oversight rather than a deliberate scheme.

**Impact:** almost certainly a hard failure at the first two-device test, not a
silent weakening. But it means the "two-device verification runbook" in the repo
has **never been run green** — and it must be, before anything ships. I have not
fixed this (no implementation this pass).

**Why it survived, confirmed by the completion report:** `cargo`/`rustup` are
not installed in this workspace, so `e2ee-completion-report.md` §3 states the
Rust "cannot be verified locally" and requires an EAS build. **This code has
never been compiled, let alone run.** Treat every claim about the Rust — mine
included — as unexecuted until an EAS build succeeds.

> ⚠️ **Wrong tree — 2026-08-29.** The defect is real at
> `packages/expo-openmls/src/lib.rs:256`, but that is not the tree the app builds
> (see §1.6's correction). The shipping tree,
> `travel-buddy-standalone/vendor/expo-openmls`, is a different and larger
> implementation whose `encrypt_message` (`src/lib.rs:349`) signs with
> `own_signer(&provider, &group)` (`:336`) instead of minting a keypair — so this
> specific defect does not exist in the code that ships. The paragraph's
> conclusion survives for a different reason: **neither** tree has been compiled
> here, so this correction is as unexecuted as the claim it corrects.

### 1.6 Duplication that will bite

`package.json` resolves the module as `expo-openmls: file:./vendor/expo-openmls`
— it consumes **`travel-buddy-standalone/vendor/expo-openmls`**, not
`packages/expo-openmls`. The two trees are byte-identical today (`diff -q`
clean), so a fix applied to `packages/` — the one you would naturally open —
would not reach the app. Worth collapsing to one before any Rust work.

> ⚠️ **"byte-identical" is FALSE — 2026-08-29.**
> `diff -rq packages/expo-openmls travel-buddy-standalone/vendor/expo-openmls`
> reports **17 differences** (16 of substance; the seventeenth is `packages/`' own
> `node_modules`). The trees have diverged, not drifted: `Cargo.toml`, `build.rs`,
> `package.json`, both native modules and `src/lib.rs` all differ; vendor is
> OpenMLS **0.6.0** against `packages/`' **0.5.0**; vendor's `lib.rs` is **673**
> lines against **373**. Only vendor carries `expo-module.config.json`, so only
> vendor autolinks, and `package.json:69` pins `file:./vendor/expo-openmls`.
> `packages/expo-openmls` is a stale, unreferenced fork. The section's advice is
> right and now urgent, with the direction made explicit: **read and fix
> `vendor/`. `packages/` is the decoy.**

### 1.7 DM attachments vs public media — CORRECTED 2026-08-08

DM media currently rides `messages.media_url` as an ordinary URL into the same
private-bucket infrastructure as everything else (signed on read, per the media
work in this branch). Your standing decision covers *public and shared* media.
**DM attachments are neither.**

**Correction to an earlier revision of this document:** I wrote that "the
existing E2EE design does not encrypt them — only the text body". That was
wrong about the *design*. `e2ee-design.md` §3.2 specifies media envelope
encryption in detail — a random 256-bit content key per item, AES-256-GCM or
ChaCha20-Poly1305, ciphertext to object storage, content key and nonce carried
*inside* the MLS-encrypted message body, encrypted thumbnails. It is listed
there as design-phase **E-4 Media E2EE**.

So the design is complete on this point. What is true is that **it is not
implemented**, and it is not in the first increment. The practical consequence
is unchanged and is the thing that matters:

> As currently built, DM text would be encrypted while DM photos stay
> server-readable. That is **defensible as v1 but not as a marketing claim.**

That sentence is the one that should stop anyone putting "end-to-end encrypted"
on a landing page before design-phase E-4 ships.

### 1.8 Documentation — CORRECTED 2026-08-08

**An earlier revision of this document claimed that `e2ee-design.md`, the
execution plan and the completion report "do not exist in this repo". That was
wrong. All three exist, are tracked, and are substantial:**

| Document | Lines |
|---|---|
| `docs/security/e2ee-design.md` | 226 |
| `docs/security/e2ee-execution-plan.md` | 301 |
| `docs/security/e2ee-completion-report.md` | 146 |
| `docs/security/crypto-review-brief.md` | 110 |
| `docs/security/e2ee-verification-runbook.md` | 169 |
| `.agents/memory/e2ee-conventions.md` | 39 |

The error came from listing `travel-buddy-standalone/docs/` and concluding
about the repo-root `docs/` — the same working-directory confusion that made
the repo root itself hard to find earlier in this session. Absence was asserted
from a search that had never been run at the right path. Recorded here rather
than quietly amended, because "the design doc is lost" would have been acted on.

The brief and the runbook were loose at the workspace root; they were moved
into `docs/security/` alongside everything else. The move also *fixed* one
reference: the runbook's pointer to `docs/security/crypto-review-brief.md` is
now correct, where before it pointed at a path that did not exist.

Two real documentation hazards remain, and these are the ones worth knowing:

1. **The phase numbering conflicts between documents.** In `e2ee-design.md`,
   **E-4 is media encryption**. In `e2ee-completion-report.md`, **E-4 is
   multi-device pairing** (media is not in its deferred list under that name).
   Any conversation that says "E-4" without naming the document is ambiguous.
2. **The completion report is stale in one direction that matters.** It marks
   Phase E-2 "1:1 E2EE Messaging" complete, and its own "Known gaps" section
   lists epoch rotation, multi-device and push — but **not** the fact that
   nothing ever activates E2EE (§1.3). The report is defensible read narrowly:
   every row in its E-2 table describes a *capability* that genuinely was
   built. It is misleading read quickly, because "E-2 complete" reads as
   "1:1 DMs are encrypted", and they are not.

The brief is also stale on versions: it claims `openmls 0.6 / openmls_rust_crypto
0.3`, while `Cargo.toml` pins `0.5.0 / 0.2.0`.

---

## 2. STEP 2 — The three decisions

> **DECIDED — see §0.1.** A1 / B1 / C1 accepted; B3 and C3 rejected.
> Retained below as the reasoning behind that choice, not as an open question.

### (a) Key management

Because a working MLS implementation is already here, the honest options are
not "which protocol from scratch" but "keep, simplify, or replace".

**Option A1 — Finish the existing MLS implementation. (Recommended.)**
Long-lived Ed25519 identity per user, Ed25519+X25519 per device, KeyPackages
published to the server and consumed one-shot at group formation, group state
in SecureStore.
*Cost:* fix §1.5, wire the two joins in §1.3, run the runbook, commission the
external review the brief already scopes ($5–15K, ~1 week).
*Pro:* it is 70% done and already schema-live; MLS is an IETF standard with
forward secrecy and post-compromise security; it generalises to group chat
later without redesign, which matters because Telegraph already has trip and
circle threads.
*Con:* MLS is genuinely complex; the Rust/UniFFI boundary needs specialist
review; requires an EAS native build (no Expo Go), which is already true here.

**Option A2 — Replace with a simpler per-conversation key.**
One symmetric key per thread, wrapped to each participant's public key.
*Pro:* far less code; easy to reason about; no ratchet state to corrupt.
*Con:* no forward secrecy and no post-compromise security — one device
compromise exposes all history for that thread, forever. Throws away working
code. Would need a fresh external review anyway.
*Honest read:* this is the option to choose only if you conclude the MLS code
is unmaintainable. Nothing I read suggests that.

**Option A3 — Swap to libsignal (double ratchet).**
*Pro:* the most battle-tested option; excellent 1:1 properties.
*Con:* strictly more work than A1 from here, because A1 is partly built and A3
is not. Weaker group story than MLS. Larger native footprint.

**What I would choose: A1.** The expensive, specialist part — a real MLS
binding — is the part that already exists. Replacing it would discard the only
component you cannot cheaply rebuild, to solve a problem (complexity) that the
external review in the brief is designed to address.

### (b) Multi-device

This is where the current design is weakest, and the brief admits it: *"Multi-
device pairing UX (QR flow) not yet implemented; a fresh install currently
means a new identity."*

**Option B1 — Single device, explicitly. (Recommended first increment.)**
One active device per user. A new install = new identity = new safety number,
and the peer sees the "safety number changed" banner that is already built.
*Cost:* near zero — this is today's behaviour. Needs honest UI copy.
*Con:* no tablet/second phone; reinstall loses history (see (c)).

**Option B2 — MLS multi-device: each device is its own group member.**
The protocol-native answer. Each device publishes its own KeyPackage and is
added to the group; every device decrypts independently.
*Cost:* device-management UI (list, name, revoke), pairing flow, epoch rotation
on add/remove, and — the real cost — **new devices cannot read history sent
before they joined**, because MLS epochs only grant forward access.
*Pro:* no key export between devices; revocation is clean and real.

**Option B3 — Export identity to a second device via QR.**
Both devices share one identity, so both can decrypt everything.
*Cost:* a private key crosses a channel; a QR containing key material is a
genuinely dangerous artifact (shoulder-surfing, screenshots, screen recording).
Revocation becomes near-impossible — you cannot un-copy a key.
*Con:* materially weakens the security story for a convenience feature.

**What I would choose: B1 now, B2 later.** Ship single-device honestly, with
copy that says so. B2 is the correct end state and the KeyPackage infrastructure
already supports it. B3 I would avoid — it trades the strongest property of the
system for convenience that B2 delivers more safely.

### (c) Message history on device loss

The decision that most determines whether this is *genuinely* end-to-end.

**Option C1 — History is lost. (Recommended first increment.)**
Keys live only in SecureStore; lose the device, lose the history. Server holds
ciphertext nobody can read.
*Pro:* the strongest and most honest guarantee; zero extra attack surface;
matches Signal's default.
*Con:* users will lose history and some will be angry. **Requires prominent,
truthful onboarding copy** — and this is the single biggest product objection
to the whole feature.

**Option C2 — User-held recovery passphrase.**
Key material encrypted under a passphrase-derived key (Argon2id), stored
server-side.
*Pro:* history survives; still end-to-end — the server holds an opaque blob.
*Con:* security collapses to passphrase strength; users forget passphrases and
will then blame you for losing the history you promised to save; needs careful
KDF choice and rate-limiting on the retrieval endpoint.

**Option C3 — Cloud backup to iCloud/Google (device-keychain-backed).**
*Pro:* invisible to users; history "just works".
*Con:* **this is where "end-to-end" starts to be a lie.** Trust moves to Apple
or Google, who are compellable. Current SecureStore usage is documented as
`WHEN_UNLOCKED_THIS_DEVICE_ONLY`, i.e. deliberately *not* backed up — so C3
would be reversing an existing, correct decision.

**What I would choose: C1 for the first increment, C2 as an opt-in later.**
C1 is the only option that lets you make the strong claim without an asterisk.
C2 is a reasonable opt-in for users who want durability and understand the
trade. I would not do C3 — if you adopt it, the marketing copy has to change,
and that is a worse outcome than losing history.

---

## 3. STEP 3 — What breaks

Ordered by how much it will actually hurt. Items marked ✅ are already handled
in the existing code.

1. **Thread-list previews** — `messaging.ts:1339` slices `body` for every
   thread row. Under E2EE there is no body. *Fix:* client renders previews
   from the local decrypted store. Moderate work; touches a hot list path.
2. **Push notification content** — degrades to "New message" automatically ✅.
   The proper fix (Phase E-5 in the brief) is an encrypted push envelope
   decrypted by a notification service extension — that is a substantial piece
   of platform-specific work and should **not** be in the first increment.
3. **Moderation of reported DMs** — a reporter can report a message, and
   `moderation.ts` records `subject_id` + `thread_id`, but admins cannot read
   it. *Fix:* reporter's client attaches the decrypted excerpt **it already
   holds** to the report. This is the standard approach (WhatsApp does exactly
   this) and preserves E2EE: the content is disclosed by a participant, not by
   the server. The route header already anticipates this ("future attachment
   flow"). **This one is worth doing in the first increment** — shipping
   unmoderatable DMs is a real safety and app-store risk.
4. **Admin support** — support staff currently able to inspect a thread to
   debug a complaint will no longer be able to. Policy change, not a code
   change; worth deciding explicitly.
5. **Server-side translation** — already refuses on E2EE threads ✅. Product
   consequence: **E2EE threads lose translation**, which for a travel app with
   cross-language users is a bigger deal than it looks. Client-side translation
   would send plaintext to a third party, which mostly defeats the point.
   Worth an explicit decision.
6. **Off-app-contact detection** — already skipped ✅. Accepted loss.
7. **Spam / abuse heuristics on DM content** — I found no dedicated server-side
   DM content scanner, so nothing concrete breaks. Any future one is now
   restricted to metadata (rate, fan-out, recipient novelty), which is where it
   should have lived anyway.
8. **Search** — no server-side DM search exists ✅. Local FTS5 is already the
   plan and partly built.
9. **Not on your list, and it matters: DM attachments** (§1.7) remain
   server-readable **as built**. Envelope encryption for them IS specified in
   `e2ee-design.md` §3.2 (design-phase E-4) but is not implemented and is not
   in the first increment. Encrypted text beside server-readable photos is
   **defensible as v1 but not as a marketing claim.**
10. **OPEN QUESTION — message edit/delete.** `messages` has `edited_at` and
    there is an edit path that touches `body` (`messaging.ts:2163` notifies
    that "the message body changed"). Edits of encrypted messages need the same
    ciphertext treatment as sends. **I have not traced this path, and it is
    absent from `e2ee-design.md` as well** — searching that document for
    edit/delete/redact returns nothing on the subject. So this is not merely
    untraced by me; it appears genuinely unspecified. Recorded as an open
    question, not an assumption.

---

## 4. STEP 4 — Scope and sequencing

> **PARTLY SUPERSEDED by Decision 2 (§0.1).** The migration stance (new threads
> only) still holds. The "first shippable increment" and the 2–3 week estimate
> below are text-only and are replaced by §6.8.

### Migration stance

**New threads only. Do not migrate existing DMs.** The schema was deliberately
built this way — `is_e2ee` defaults FALSE and the migration comment says
"Existing threads and messages are UNAFFECTED". Migrating would require every
historical message re-encrypted by a client that holds the keys, for both
participants, with no correctness benefit. The runbook already has a step
asserting legacy threads keep working. Keep that.

### Size estimate

Rough, and I would treat the review as the long pole:

| Increment | Work | Rough size |
|---|---|---|
| **E-2a** Fix §1.5 signature key; collapse `vendor`/`packages` duplication | Rust + packaging | 0.5–1 day |
| **E-2b** Wire the two joins: E2EE negotiation at thread creation (`is_e2ee=true`, KeyPackage consume, `initGroupAsInitiator/Recipient`) + encrypt/decrypt in the send/receive path | The core gap | 3–5 days |
| **E-2c** Thread-list previews from the local store | Hot path, care needed | 1–2 days |
| **E-2d** Reporter-attached excerpt for DM moderation | Server + client | 1–2 days |
| **E-2e** Run the two-device runbook on real hardware | Requires EAS build ×2 devices | 1 day + build turnaround |
| **E-2f** External crypto review | Already scoped in the brief | ~1 week, $5–15K, elapsed not effort |
| **E-2g** Fix review findings | Unknown until findings land | budget 2–5 days |

**≈2–3 weeks of engineering, plus review elapsed time**, to a defensible opt-in
beta. That is dramatically less than a from-scratch E2EE build, and the reason
is entirely that the hard part is already in the repo.

### The first shippable increment

You said you would rather ship something narrow and correct than a
half-finished ratchet. Concretely:

> **New 1:1 Telegraph DMs between two users who both have registered device
> keys are end-to-end encrypted with MLS. Single device per user. History does
> not survive device loss. DM attachments are not yet encrypted. Legacy threads
> stay plaintext and keep every existing feature. Behind a flag, internal
> accounts only.**

That is E-2a through E-2e. It is honest, it is verifiable by the runbook that
already exists, and it does not pretend to multi-device or backup.

Explicitly **not** in the first increment: group-thread E2EE (trip/circle
threads), encrypted push envelopes, encrypted DM media, multi-device pairing,
key backup.

### Sequencing note on the flag

Rollout gating is a flag decision and therefore yours. I have not touched
`media_private_buckets_enabled` or any other flag, and I did not create an
E2EE flag — I found no existing one. Worth noting that today's behaviour is
safe by default: with nothing setting `is_e2ee=true`, the system cannot
accidentally start encrypting.

---

## 5. Recommendation, stated plainly

> **Recorded outcome:** accepted, except that the owner extended scope to
> include encrypted DM attachments before ship (Decision 2, §0.1). The
> "defensible as v1" carve-out for media below is therefore NOT being taken.

Finish what is here rather than start again. Specifically: fix the signature-key
defect, collapse the duplicated module, wire the two missing joins, add
reporter-attached moderation excerpts, run the existing two-device runbook on
real hardware, then commission the review the brief already scopes.

Take **A1 / B1 / C1** for the first increment — MLS, single device, history not
recoverable — because that combination is the only one you can describe to
users in one honest sentence. Add B2 (multi-device via MLS members) and C2
(opt-in passphrase backup) afterwards, in that order.

The two things I would not defer: the §1.5 defect, because it means this has
never actually worked end-to-end and everything else is built on that
assumption; and DM moderation, because shipping unmoderatable direct messages
is a safety and store-review risk that is much cheaper to handle now.

---

## 6. Encrypted DM attachments — scoping for Decision 2

Design questions surfaced, not solved. Everything below was checked against
code; line references are to the tree at `61007b897`.

### 6.0 The blocker to know first

**DM attachments cannot use the existing upload endpoint.** `POST /media/upload`
(`api-server/src/routes/posts.ts:76`) does three things to every byte it
receives:

1. `sniffMedia(rawBody)` — reads magic bytes to identify the format, and
   **rejects anything it cannot identify**. Ciphertext has no magic number, so
   an encrypted upload is rejected outright.
2. `processImage(rawBody, sniffed)` — re-encodes and downscales (`MAX_IMAGE_DIM
   2048`). Re-encoding ciphertext destroys it.
3. `makeThumbnail(...)` — server-side thumbnail at `THUMBNAIL_DIM 400`, which
   requires readable pixels.

So this is not "add a flag to the upload path". Encrypted attachments need
their own opaque-blob upload route that does no sniffing, no processing and no
thumbnailing. That route is small, but it must also **re-implement the safety
controls the sniffing path provides today** — size caps (currently 15 MB image
/ 100 MB video), the `disable_media_uploads` flag check, and the 30-per-5-min
rate limit. Losing those by accident is the realistic failure mode.

### 6.1 Where does encryption happen, and does DM media need its own bucket?

The design (`e2ee-design.md` §3.2, phase E-4) already answers the crypto:
per-item random 256-bit content key, AES-256-GCM or ChaCha20-Poly1305,
ciphertext to object storage, **content key + nonce + content-type hint carried
inside the MLS-encrypted message body**. That last part is the important one:
the key rides the message, so it inherits the message's confidentiality and
there is no second key-distribution problem to solve. Line 188 also says
"ciphertext to separate bucket".

Encryption happens **client-side, before upload**. Plaintext must never reach
`/media/upload`.

*Separate bucket vs. marker on the row* — genuinely open, but the arguments are
lopsided:

- **Separate bucket (e.g. `dm-media`), recommended.** `appStorageUrlInfo`
  (`api-server/src/lib/mediaUrl.ts:11`) has a hard `ALLOWED_BUCKETS` allowlist
  of exactly `post-media` and `profile-media`. A third bucket is a
  one-line-ish addition and gives a *structural* guarantee: nothing that
  reads public media can accidentally read DM ciphertext, because it is not in
  a bucket those paths accept. It also keeps lifecycle rules (retention,
  transcode, moderation scanning) cleanly separable.
- **Marker column on `messages`.** Cheaper, but the guarantee becomes "every
  read path remembered to check the marker". The bare-image sweep earlier in
  this branch is direct evidence of how that goes: 102 call sites bound media
  URLs without checking anything, across 73 files.

**Note:** a new bucket is a schema/infra change and is therefore out of scope
for this pass. Recorded as a recommendation, not done.

### 6.2 Thumbnails and previews — the good news

This is the question I expected to be hardest and it is close to solved
already.

**DM thumbnails are already client-generated today.** In the DM attach route
(`messaging.ts:1890`), `thumbnailUrl` and `durationSeconds` arrive **from the
client** in the request body and are merely validated as app-storage URLs. The
server-side `makeThumbnail` path is used by posts/postcards/profile — **not by
DMs**. `messaging.ts` does not import `mediaProcessing` at all.

The client also already has the tools: `expo-image-manipulator ~14.0.8` (used
in `imageRender.ts` and `renderFilteredImage.ts`) and **`expo-video-thumbnails
~10.0.8`**, already installed.

So the shape is: client generates the thumbnail → encrypts it with its own
content key (or the same one) → uploads it as a second opaque blob → the
thumbnail key rides the same MLS message. **No new capability is required, only
wiring.** That is a materially smaller job than it looked.

What the DM *list* shows before decryption is then a product choice:

- **Placeholder + sender/type only** (e.g. "📷 Photo"). Zero risk, zero cost.
  Recommended for the first increment.
- **Decrypted thumbnail from the local store.** Once the thread is opened and
  decrypted, thumbnails cache locally and the list can show them. Natural
  extension; needs the local-store work that is already part of the design.
- **Blurhash-style tiny preview.** The design mentions "small encrypted preview
  inline". Note a blurhash computed from the image and stored *unencrypted*
  would leak a low-resolution impression of every DM photo to the server —
  which contradicts the whole decision. If a preview is wanted, it must be
  encrypted like everything else.

### 6.3 Download / decrypt flow, and where plaintext lands

**This is the area with the least existing groundwork, and the answer is
uncomfortable.**

`expo-file-system` is **not installed**. Neither is `expo-crypto` nor
`react-native-quick-crypto`. Verified against `package.json`. So today the app
has **no general-purpose client-side file I/O and no general-purpose symmetric
crypto**. Everything media-related currently goes `URL → expo-image/expo-av`,
which fetch and decode internally and never hand the app bytes.

That means encrypted attachments need **new native surface** that does not
exist yet:

- a way to fetch ciphertext bytes,
- a way to AEAD-decrypt them (the OpenMLS Rust module could expose this,
  avoiding a second crypto dependency — worth considering, since a
  `decrypt_blob` UniFFI function is a small addition to a module that already
  does AEAD),
- a way to hand the plaintext to `expo-image` / `expo-av` for display.

**Where the plaintext lands is the crux.** `expo-av` and `expo-image` want a
URI, not a buffer. The realistic options:

- **Decrypt to a temp file in the app sandbox, display, delete on thread
  close.** Works with existing players. But plaintext media touches disk, is
  visible to anything with app-sandbox access, and will be picked up by OS
  backups unless explicitly excluded (iOS `isExcludedFromBackup`, Android
  `allowBackup`/auto-backup rules). **A plaintext DM photo silently landing in
  an iCloud device backup would undo the decision in §0.1 as thoroughly as
  option C3 would.** This needs an explicit, tested answer, not a default.
- **In-memory only, custom image source.** Strongest, but requires either
  base64 data-URIs (memory-expensive, roughly +33% and duplicated through JS)
  or a native image source, which is real platform work.
- **Local HTTP loopback server serving decrypted bytes.** Common in other apps;
  adds an attack surface and background-execution complexity. I would avoid it.

For images, in-memory is plausible. **For video it is not** — see §6.4.

### 6.4 Size and memory, especially low-end Android

Current caps on the shared upload path: **15 MB image, 100 MB video**.

- **Images at 15 MB:** decrypting in memory is fine on any device that can
  already decode them. Low risk.
- **Video at 100 MB: this is the genuinely hard part.** You cannot hold 100 MB
  of plaintext video in JS memory on a low-end Android device — that is an OOM,
  not a slowdown. And you cannot stream it, because AES-GCM authenticates the
  *whole* ciphertext: correct AEAD use means you do not release plaintext until
  the tag verifies, which for a single-blob 100 MB video means buffering all of
  it before playback starts.

  The standard answer is **chunked encryption** — split into (say) 1 MB frames,
  each with its own nonce and tag, decrypt progressively, and accept that a
  truncation attack at a chunk boundary is detectable only with an explicit
  chunk counter and final-chunk marker. That is a real cryptographic design
  task, not a wiring task, and it is the single item most likely to blow the
  estimate.

  A pragmatic first increment: **cap encrypted DM video far below 100 MB** (say
  10–25 MB, with client-side downscale before encryption using the
  `expo-image-manipulator` / recompression tooling already present) and defer
  chunked streaming. Worth deciding explicitly, because it is user-visible:
  "you can send a 100 MB video in a public post but only a 25 MB one in a DM".

### 6.5 Device loss — confirming attachments match the text story

**Confirmed: they match, and by construction rather than by discipline.**

Under Decision 1 (C1) the MLS group state and identity keys live only in
SecureStore and are lost with the device. The per-item content key lives
*inside the MLS-encrypted message body* (§6.1). So losing the device loses the
message, which loses the content key, which makes the attachment ciphertext
permanently undecryptable — by the user and by the server alike.

There is **no path where photos survive and text does not**, provided the
content key is never stored anywhere but inside the encrypted message. That is
worth stating as an invariant to hold onto: *the content key must never be
written to the `messages` row, to a column, or to any server-visible field.* If
someone later "optimises" by putting the content key beside `media_url`, the
whole property collapses silently.

One consequence to communicate: server-side attachment ciphertext becomes
garbage that nobody can ever read. It should be included in the existing
retention/deletion sweeps rather than accumulating forever.

### 6.6 The 4K pipeline — plainly

**The planned 4K/transcode pipeline is unaffected, and less affected than
feared, because it does not exist yet.** `docs/app-audit.md:166` records
"Video transcoding pipeline | 🔴 Not implemented | Postcards support video MIME
types but no transcode step". There is no transcode step for E2EE to break.

Going forward the split is clean and permanent:

- **Public/shared media** — server-readable, server-transcodable. The 4K
  pipeline applies here in full. Unchanged by any of this.
- **DM attachments** — the server sees opaque bytes and **can never transcode
  them**. Not "harder"; impossible by construction, which is the point.

What that means for DM video quality, stated plainly:

- No server-side adaptive bitrate, no HLS/DASH ladder, no format normalisation
  for DM video. One blob, one quality, whatever the sender's device produced.
- The sender's device becomes responsible for making the file sane before
  encryption: downscale, re-encode to a widely-supported codec (H.264 rather
  than HEVC, which is where cross-platform playback actually breaks), cap
  duration/bitrate. Client-side handling **is viable** — the app already does
  client-side image resizing in `imageRender.ts` and already generates video
  thumbnails — but video re-encode on-device is slow on low-end Android and is
  the main UX cost.
- Practical consequence: **DM video will be lower quality and more
  size-limited than public video, permanently.** That is the correct trade for
  the decision taken, but it is a product-visible difference worth agreeing
  now rather than discovering.

### 6.7 What is genuinely hard here

Ranked, so the estimate is legible:

1. **Chunked AEAD for large video** (§6.4) — real crypto design, the most
   likely thing to double an estimate. Mitigable in v1 by capping DM video size
   and deferring streaming.
2. **Where decrypted plaintext lives** (§6.3) — new native surface, plus the
   OS-backup-exclusion question that could silently undo the §0.1 decision.
3. **A new opaque-upload path that keeps today's safety controls** (§6.0) —
   not hard, but easy to get subtly wrong by dropping a size cap or the
   feature-flag check.
4. **Separate bucket** (§6.1) — infra + `ALLOWED_BUCKETS`, straightforward but
   touches schema/infra, so it is a decision, not a task.
5. Thumbnails (§6.2) — **easier than expected**; the client already does this.

### 6.8 Revised estimate, covering both decisions

Superseding §4. Same caveats: the external review is elapsed time, not effort,
and none of the Rust has ever been compiled (§1.5).

| Increment | Rough size |
|---|---|
| E-2a Fix the signature-key defect; collapse `vendor`/`packages` duplication | 0.5–1 d |
| E-2b Wire the two missing joins (negotiation + encrypt/decrypt on send/receive) | 3–5 d |
| E-2c Thread-list previews from the local store | 1–2 d |
| E-2d Reporter-attached excerpt for DM moderation | 1–2 d |
| **E-4a Opaque-blob upload route + bucket + safety controls** | **2–3 d** |
| **E-4b Client envelope encryption + content key inside the MLS body** | **3–4 d** |
| **E-4c Client encrypted thumbnails** (tooling already present) | **1–2 d** |
| **E-4d Download → decrypt → display, incl. plaintext-at-rest and backup-exclusion decisions** | **4–6 d** |
| **E-4e Video: size caps + client-side downscale/re-encode before encryption** | **3–5 d** |
| **E-4f Chunked AEAD for large video** — *deferrable if video is capped* | **5–8 d if taken now** |
| E-2e Two-device runbook on real hardware (now must cover attachments) | 1–2 d |
| E-4g Extend the runbook with attachment steps | 0.5 d |
| E-2f External crypto review (scope now includes media envelope) | ~1–1.5 wk elapsed |
| E-2g Fix review findings | 2–5 d |

**Text-only (previous estimate): ~2–3 weeks.**
**Both decisions, with DM video capped and chunked AEAD deferred: ~4.5–6 weeks.**
**Both decisions, with chunked AEAD in v1: ~6–7.5 weeks.**

So: **Decision 2 roughly doubles it.** Not because encryption is hard — the
design and the thumbnail tooling are largely in place — but because §6.3 and
§6.4 introduce native file/crypto surface the app has never had, and because
video forces either a capability (chunked AEAD) or a product concession (size
cap). Capping DM video is worth roughly 1–1.5 weeks and I would take it for v1.

The external review also grows: it was scoped in `crypto-review-brief.md` as
1:1 text with media explicitly **out of scope** ("The planned later phases
(group E2EE, media, push envelopes, calls, backup/recovery) — design feedback
welcome, implementation review not expected"). With Decision 2 that brief needs
rewriting before it is sent, or the reviewer will not look at the part that now
ships. **Not done in this pass** — flagged because sending a stale brief would
waste the engagement.

---

## Appendix — verification notes

Verified by reading code at `494e4d3bc`: module reality and OpenMLS call sites;
`Cargo.toml` versions; `useCryptoInit` mount point; absence of
`encryptForThread`/`decryptFromThread` callers; absence of any `is_e2ee = true`
writer; live schema via `database.types.ts`; server send-path ciphertext
handling; unread-count implementation; thread-preview body slice; notification
template fallback; moderation subject resolution; absence of server-side DM
search; `vendor` vs `packages` resolution and byte-equality.

Not verified, and flagged as such: whether the Rust actually compiles under EAS
(no build run); whether FTS5 is fully wired in `localMessageDb`; the full
edit/delete path for encrypted messages; whether the live DB rows match the
migration files (I did not query production).

Added for §6 (Decision 2), verified at `61007b897`: `/media/upload` performs
`sniffMedia` + `processImage` + `makeThumbnail` (`routes/posts.ts:76-185`) with
15 MB / 100 MB caps; `messaging.ts` does **not** import `mediaProcessing`, and
DM `thumbnailUrl`/`durationSeconds` are client-supplied (`messaging.ts:1890`);
`ALLOWED_BUCKETS` is `{post-media, profile-media}` (`lib/mediaUrl.ts:11`);
`expo-video-thumbnails ~10.0.8` and `expo-image-manipulator ~14.0.8` are
installed while `expo-file-system`, `expo-crypto` and `react-native-quick-crypto`
are **absent**; `docs/app-audit.md:166` records the transcode pipeline as not
implemented.

Not verified for §6: actual decrypt throughput on a low-end Android device (no
device testing); whether `expo-av` can accept an in-memory or data-URI source at
acceptable cost; the precise OS-backup-exclusion behaviour for a decrypted temp
file on either platform. All three are §6.3/§6.4 risks and are stated as open.

---
