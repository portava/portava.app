# Portava End-to-End Encryption — Design & Threat Model

**Status:** Design. Hand to Replit Agent phase-by-phase after review.
**Scope:** 1:1 Telegraph, group chats, Trip Circles, event chats, Rent-a-Buddy booking chats, LiveKit voice, LiveKit video. Comments and Compass AI chat are explicitly out of scope for E2EE (see §2).
**Guiding principle:** message content inaccessible to the Portava server by default; every exception is explicit and opt-in.

## 0. Current state

- Messaging: `messages` table, `msg_type`, `translated_body_json`, SSE + polling. Same table for DMs, groups, Trip Circles, events, Rent-a-Buddy.
- Calls: LiveKit. Backend mints tokens; mobile uses `@livekit/react-native`.
- Push: Expo Push API. Payload carries readable body text (GPS/addresses redacted). Leak to fix.
- On-device storage: AsyncStorage plaintext. Supabase session plaintext. Biggest current gap, blocks E2EE.
- Crypto: none client-side. `node:crypto` server-side only for HMAC and UUIDs.
- Compass ↔ Telegraph: does not read message bodies.

## 1. Threat model

In scope:
- T1 server compromise (passive): message plaintexts, media content, call media unreadable.
- T2 server compromise (active): key injection detectable via safety numbers.
- T3 insider access: Portava staff cannot read content or recover past content on demand.
- T4 push provider (Expo/FCM/APNs) cannot read message content from notifications.
- T5 device compromise post-hoc: past session keys forward-secret.
- T6 metadata leakage minimization: server routes messages so we can't hide *that* users communicate; minimize *what* leaks.
- T7 MITM at key exchange: detectable via safety-number verification.
- T8 multi-device account: each device has its own key; add/remove is visible.
- T9 reinstall / lost device: designed key-loss story; no silent server backdoor recovery.

Out of scope:
- Traffic analysis (contact graph is a feature).
- Compelled disclosure of ciphertext + metadata.
- Endpoint compromise (rooted device, malware, coerced screenshots).
- Coercion of user to hand over unlocked device.
- Post-compromise recovery of an actively-owned device.

## 2. Scope decisions

In scope for E2EE:
- All content in `messages` across every `thread_type`.
- All media attached to messages (client-side encrypted, ciphertext to object storage).
- LiveKit voice call media.
- LiveKit video call media.
- Push notification content revealing message body.

Out of scope for E2EE (stay server-visible, documented):
- Post comments — encrypting breaks Discovery, ranking, moderation.
- Compass AI chat — the whole point is Compass reads them.
- Message metadata (sender, recipients, thread ID, timestamp, message ID, message type, delivery/read receipts).
- Media metadata (ciphertext object key, size, mime type marker).
- User profile data, presence, availability, block/mute state.
- Reactions — see §5.5, leaning encrypted.

Tradeoffs accepted:
- No server-side search over message content. Search on device.
- No message backup unless user opts in to encrypted backup with user-held key (§7).
- Compass cannot silently read Telegraph. Any Compass↔Telegraph feature must be on-device (§8).
- Compass context expansion must never include Telegraph message content.

## 3. Protocol choices

### 3.1 Messages: MLS (RFC 9420)

Signal Protocol is O(N²) for groups; MLS is O(log N). At 100+ member Trip Circles or event chats, Signal-style pairwise Double Ratchet is a nonstarter. MLS is IETF-standard (2023), handles forward secrecy, post-compromise security, group membership changes, and multi-device by design. 1:1 is a 2-member group. Same code path for everything.

Libraries: OpenMLS (Rust, UniFFI) preferred; MLS-TS (Cisco) fallback if RN binding unstable; wickr-crypto-c mature but AWS-owned. Recommendation: OpenMLS with thin RN native module.

Session keys: long-lived identity key per user (Ed25519); device key per install (Ed25519 + X25519); KeyPackages published (public halves); server never sees private keys. Body ciphertext into new `messages.ciphertext`; `translated_body_json` deprecated for E2EE threads.

### 3.2 Media: envelope encryption

Random 256-bit content key per media item. AES-256-GCM or ChaCha20-Poly1305 (ChaCha faster on mobile without hardware AES). Ciphertext to object storage. Content key + nonce + content-type hint inside MLS-encrypted message body. Encrypted thumbnails; small encrypted preview inline.

### 3.3 Voice / video calls: SFrame over LiveKit

LiveKit's E2EE feature uses SFrame with out-of-band keys. Negotiate SFrame key over MLS message channel. Rotate on participant join/leave via new MLS message; no history rewind for new joiners. Screenshare, video, audio all SFrame-encrypted with the same key. Call signaling stays server-visible (metadata). Only media is E2EE.

### 3.4 Push notifications: encrypted envelope

Sender's device encrypts short blob (title, sender name, optional preview) with recipient's push-notification key. Server relays opaque data through Expo/FCM/APNs. Recipient decrypts on receipt in iOS Notification Service Extension / Android FCM data-message handler. Fallback: generic "New message" with no content. Default: sender name + generic message, no body. Opt-in for body preview.

## 4. Key management

### 4.1 Hierarchy

- Identity key (per user, Ed25519): long-lived, signs device keys.
- Device key (per device, Ed25519 + X25519): unique per install, signed by identity key.
- KeyPackages (per device, MLS format): consumed one-shot on group add. Pool refilled on server.
- Group secrets (per MLS group): derived by MLS. Rotate on epoch changes.
- Content keys (per media item): random 256-bit, ephemeral, inside MLS ciphertext.
- Push keys (per device): X25519 or symmetric.

### 4.2 On-device storage — blocks everything else

Current: AsyncStorage plaintext, Supabase session plaintext.

Phase E-0 migration:
- expo-secure-store for key material and auth tokens.
- iOS Keychain WHEN_UNLOCKED_THIS_DEVICE_ONLY for private keys.
- Android Keystore via expo-secure-store defaults, app-level wrapping for at-rest strengthening.
- Supabase session move ships first — security fix regardless of E2EE.
- Cache decrypted secrets in memory only; re-fetch from SecureStore on cold start.

Decrypted message cache: SQLCipher-backed SQLite. Root DB key in expo-secure-store. Supports search, structured queries, encryption at rest.

### 4.3 Multi-device

Devices added via identity-key signature. New install: QR from existing device or push challenge accepted. Sign-in with no existing device: new identity unless restored from encrypted backup (§7); warn loudly, safety number changes for contacts. Server maintains device list; every message goes to every device in a group's member device list.

### 4.4 Safety numbers

Per 1:1: safety number derived from both users' identity keys. Displayed in Telegraph thread settings. QR scan or digit comparison to verify. On key change: non-dismissible banner in the thread. Groups: per-member safety numbers in member list.

### 4.5 Key rotation

MLS handles epoch rotation on membership changes automatically. Periodic rotation for large active groups to bound compromise windows. KeyPackage pool refilled when server signals low inventory.

## 5. Feature reworks

### 5.1 Search
On-device SQLCipher + SQLite FTS5. Banner: "Searching your device only."

### 5.2 Unread badges
Metadata server-visible; `is_read` stays server-side. No change.

### 5.3 Notifications with content
Encrypted push envelope (§3.4). Requires iOS NSE + Android FCM data handler.

### 5.4 Translation
On-device (recommended): Apple Translation iOS 17.4+, ML Kit on Android, or quantized model. Alternative: proxy translation with user opt-in per message and clear warning. Or: no translation in E2EE mode.

### 5.5 Reactions
Recommendation: encrypted via MLS.

### 5.6 Broadcast signatures
Broadcasts stay in unencrypted thread types only in v1.

### 5.7 Moderation
Report: recipient's device attaches reported message plaintext + sender's signature to the report. Server sees only reported message with cryptographic proof of authorship. No proactive scanning.

### 5.8 LiveKit call recording
Kill for E2EE calls. Legitimate recording (with all-party consent) happens client-side after decryption.

## 6. Compass and E2EE — hard rule

- Compass server code never receives Telegraph plaintext. Architectural, not policy.
- Compass system prompt's context blocks never include Telegraph content.
- Future "Compass reads my chat" requires on-device Compass — small model runs locally, decrypts locally, reasons locally, sends only anonymized derived queries.
- Any Compass feature requiring server access to E2EE content is rejected by default.

## 7. Backup and recovery

- No cloud backup by default. Reinstall = new keys = new safety numbers.
- Opt-in encrypted backup: BIP39-style 24-word recovery phrase or long random key + optional 6-digit PIN. Encrypted blob to Supabase Storage. Server sees only ciphertext.
- User must save the recovery phrase; we can't recover it.
- Multi-device sync: new device paired via QR pulls encrypted history bundle from existing device peer-to-peer or via server-relayed ciphertext.
- Legal / account recovery: not possible for content. Account access (email/phone) separate from content keys.

## 8. On-device intelligence

Translation, search, future Compass-on-Telegraph run on device. Small quantized transformer (~50-500 MB) shipped or downloaded on first use. Batch inference; don't run per-keystroke. Not v1 scope. Ship E2EE first with on-device search only; translation next.

## 9. Cost analysis (planning estimates)

Storage: E2EE adds ~50-150 bytes per message. Encrypted media same size + tiny overhead. KeyPackage store ~1 KB per package, ~50 KB pool per user; 100K users = ~5 GB.

Compute: MLS is client-side; zero server compute cost for crypto.

LiveKit E2EE via SFrame is client-side, no pricing delta. LiveKit Cloud (~$0.004/min) fine at beta/1K users. Self-host tipping point ~50K minutes/mo (~$200-800/mo SFU + egress).

Push: all free. Envelopes add ~100 bytes.

Object storage: Supabase ~$0.021/GB stored, ~$0.09/GB egress. 10K users ~500 GB/mo new. 100K users ~5 TB/mo. 1M: move to S3/R2. Abstract object storage access from day 1.

Cost cliffs: Supabase Storage egress ~500 GB/mo (plan R2 path); LiveKit Cloud ~50K min/mo (plan self-hosted SFU); iOS app size if shipping on-device translation models.

Vendor lock-in: Supabase deep (not E2EE-specific), LiveKit moderate (SFrame is standard), Expo Push light. No E2EE-specific lock-in with OpenMLS.

## 10. Phased plan

E-0 Prerequisites: AsyncStorage → expo-secure-store for auth tokens + Supabase session; SQLCipher-backed SQLite for local message cache (populate plaintext for now); `devices` table (id, user_id, platform, public_key nullable, created_at, last_seen_at); iOS Notification Service Extension scaffolding (empty forwarding handler).

E-1 Identity + device keys: OpenMLS native module built for iOS and Android; identity key (Ed25519) + device key (Ed25519 + X25519) generated once per install, private halves in expo-secure-store; publish device public key + KeyPackage pool; server routes for KeyPackage store (upload/fetch/consume/refill signal); no messaging changes.

E-2 1:1 E2EE: MLS group per new 1:1 thread (old threads stay plaintext, lock badge for E2EE); `messages.ciphertext` column migration; encrypt-on-send, decrypt-on-receive, plaintext to SQLCipher only; safety number screen; Translate disabled on E2EE threads with tooltip; on-device SQLite FTS5 index.

E-3 Group / Trip Circle / event / booking E2EE: same MLS mechanism, N members; membership changes via MLS commits; per-member safety numbers; broadcast signatures disabled for E2EE thread types.

E-4 Media E2EE: envelope encryption on upload; ciphertext to separate bucket; content keys inside MLS messages.

E-5 Push notification E2EE: push key per device; sender encrypts; server relays; iOS NSE + Android FCM data handler decrypt on receipt; notification preview preference (default off).

E-6 Voice call E2EE: LiveKit SFrame; negotiate key over MLS before call joins; rotate on participant changes; server-side recording disabled.

E-7 Video call E2EE: extends E-6 to video + screenshare.

E-8 Backup: BIP39 phrase + optional PIN; encrypted blob to Supabase Storage; rate-limited restore; in-app explainer.

E-9 Multi-device pairing UX: QR add flow; encrypted history sync.

E-10 Cutover: legacy plaintext threads visible under a legacy badge; new messages E2EE; kill remaining plaintext code paths.

## 11. v1 vs later

v1 (post-E-6): 1:1, group, Trip Circle, event, booking chat E2EE; encrypted media; encrypted push; voice call E2EE; on-device search; no on-device translation yet; opt-in encrypted backup.

Later: on-device translation, on-device Compass reading of Telegraph, peer-to-peer cross-device history sync, group video E2EE beyond ~50 participants.

## 12. Risks before E-1

- OpenMLS RN binding stability — needs a spike. Fallback: MLS-TS pure JS.
- iOS NSE reliability — Apple limits ~30s, skippable under battery pressure. Test degraded-notification UX.
- LiveKit E2EE key negotiation timing — MLS commit → SFrame key → call setup before ring. Prototype and measure.
- Migration story — leave old plaintext, new messages E2EE.
- Regulatory exposure — E2EE draws attention (UK Online Safety Act, EU CSAM proposals).

## 13. Handoff order

One phase at a time, gated on previous phase's verification. E-0 first. E-1 onward waits for review.

## Appendix A: what this design does NOT do

No proprietary crypto. No hand-rolled AES modes. No custom key derivation. No key escrow, no law-enforcement backdoor, no server-side decrypt path. No feature silently reading plaintext across E2EE boundary. No claim to defend against traffic analysis or endpoint compromise.

## Appendix B: audit and review

Before E-1 ships, identity/device key layer + MLS integration should get external cryptography review. Minimum: one senior applied-crypto reviewer for a week (~$5-15K). Ship internal work first, small opt-in beta, then review, then default-on.
