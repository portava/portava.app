# E2EE for Telegraph DMs — scoping proposal

**Status:** proposal, for decision. No implementation has been done in this pass.
**Date:** 2026-08-08
**Branch:** `bughunt-20260805`
**Scope, already decided and not reopened here:** E2EE applies to Telegraph
**direct messages only**. Public and shared media stay server-readable so
moderation and the planned 4K transcode pipeline keep working. This document
does not argue with that.

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
duplication** to be aware of before any of this ships — §1.5 and §1.6. The
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
| Safety numbers UI | `src/screens/SafetyNumberScreen.tsx` (259 ln), `src/components/ThreadSafetySheet.tsx` (307 ln) | Present, and `SafetyNumberScreen` is the **only** production caller of `mlsSession` |
| Server: devices | `migrations/20260801_e2ee_devices.sql` | **Live** |
| Server: KeyPackage pool | `migrations/20260802_e2ee_key_packages.sql` + `routes/keyPackages.ts` | **Live.** 3 endpoints: publish, inventory, one-shot consume |
| Server: ciphertext | `migrations/20260803_messages_ciphertext.sql` | **Live** — confirmed in `database.types.ts`, which was regenerated against the live schema in `1c0cfdaea` |
| Server: send path | `routes/messaging.ts:1580-1671` | **Implemented.** Accepts `ciphertext`, enforces `body=null` on E2EE threads, rejects plaintext into an E2EE thread, 64 KB cap |
| Tests | `src/lib/__tests__/{secureStore.e0,localMessageDb.e0,cryptoIdentity.e1,mlsSession.e2}.test.ts` | Present and **already running in the standalone node gate** (part of the green 3696) |

The phase naming (E-0 … E-5) is consistent throughout, so this was executed as
a planned programme, not accreted.

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

**(b) Nothing ever sets `is_e2ee = true`.** The flag is *read* in two places
(send path, translate path) and *written* nowhere. There is no thread-creation
path that negotiates E2EE, consumes the peer's KeyPackage, or calls
`initGroupAsInitiator`. So even if (a) were fixed, every thread would still
take the plaintext branch.

These two gaps are why nothing is encrypted despite everything else existing.

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
| **DM attachments** (`media_url`) | Yes — media stays a plain URL | **Not covered by the current design.** See §1.7 — this needs a decision. |
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

### 1.6 Duplication that will bite

`package.json` resolves the module as `expo-openmls: file:./vendor/expo-openmls`
— it consumes **`travel-buddy-standalone/vendor/expo-openmls`**, not
`packages/expo-openmls`. The two trees are byte-identical today (`diff -q`
clean), so a fix applied to `packages/` — the one you would naturally open —
would not reach the app. Worth collapsing to one before any Rust work.

### 1.7 DM attachments vs public media

DM media currently rides `messages.media_url` as an ordinary URL into the same
private-bucket infrastructure as everything else (signed on read, per the media
work in this branch). Your standing decision covers *public and shared* media.
**DM attachments are neither**, and the existing E2EE design does not encrypt
them — only the text body. So today's design would ship encrypted DM *text*
alongside server-readable DM *photos*.

That may be an acceptable first increment, but it should be a choice rather
than a surprise, and it is the kind of thing a privacy-policy claim gets wrong.
Flagged for §5 sequencing.

### 1.8 Documentation that exists but is loose and stale

`crypto-review-brief.md` and `e2ee-verification-runbook.md` sit **untracked-in-
spirit at the workspace root**, not in `docs/`. Both say "Suggested repo
location: `docs/security/...`" and neither was ever moved there. They also
reference internal docs (`docs/security/e2ee-design.md`, an execution plan, a
completion report) **that do not exist in this repo** — so the authoritative
design document is already lost, exactly the Step-17 failure mode.

The brief is also stale: it claims `openmls 0.6 / openmls_rust_crypto 0.3`,
while `Cargo.toml` pins `0.5.0 / 0.2.0`.

Recommend (not done in this pass): move both into `docs/security/` alongside
this file.

---

## 2. STEP 2 — The three decisions

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
   server-readable under the current design. Encrypted text next to plaintext
   photos is a defensible v1 but an indefensible marketing claim.
10. **Not on your list: message edit/delete and reactions.** `messages` has
    `edited_at` and there is an edit path that touches `body`
    (`messaging.ts:2163` notifies that "the message body changed"). Edits of
    encrypted messages need the same ciphertext treatment as sends; I have not
    traced this fully and it is a known unknown.

---

## 4. STEP 4 — Scope and sequencing

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
