# E2EE Two-Device Verification Runbook

For Phase E-2 (1:1 Telegraph encryption). Run this after the first successful
EAS development build installs on two devices. Every step has a pass
condition; stop at the first failure and record what you saw.

Suggested repo location: `docs/security/e2ee-verification-runbook.md`

## Prerequisites

- [ ] EAS development build installed on **two physical Android devices**
      (emulator acceptable for Device B, but at least one real device).
- [ ] Two separate test accounts: **User A** and **User B**, both signed in.
- [ ] Access to the Supabase SQL editor (dashboard → SQL) for server-side checks.
- [ ] Both devices on network. Note: do the offline test (step 6) with
      airplane mode, not by killing wifi at the router.

Record before starting: build ID, commit SHA, device models, OS versions.

## 1. Native module presence

On both devices, cold-start the app and open Telegraph.

- PASS: no `[mlsSession] expo-openmls not available — EAS build required`
  in the device logs (`adb logcat | grep mlsSession`).
- FAIL: that line appears → the Rust module didn't compile into the build.
  Stop; check the EAS build log's prebuild step.

## 2. Device provisioning

After first launch signed in, on each device:

```sql
select id, user_id, platform, left(public_key, 16) as pk, created_at
from devices
order by created_at desc
limit 10;
```

- PASS: one row per device, distinct `public_key` values, correct user_id.
- FAIL: no rows → identity/device key generation didn't run.
- FAIL: same public_key for both devices → key generation is not unique
  per install. **Security-critical, stop.**

## 3. MLS group establishment

User A creates a **new** 1:1 thread with User B and observes the thread
header.

- PASS: lock badge (E2eeBadge) renders in the thread header.
- PASS: server has an MLS group / thread record marked E2EE (check whatever
  column the migration added — e.g. `message_threads.is_e2ee = true`).

## 4. Ciphertext-only on the server

User A sends: `test message alpha 001`.

```sql
select id, body, left(ciphertext, 24) as ct, created_at
from messages
order by created_at desc
limit 3;
```

- PASS: for the new message, `body` is NULL and `ciphertext` is populated.
- PASS: the ciphertext does not contain the plaintext (obvious check:
  `select count(*) from messages where ciphertext::text like '%alpha 001%';`
  must return 0).
- FAIL: body contains the plaintext → encryption is not actually running
  on the send path. **Stop.**
- FAIL: ciphertext is base64 of the plaintext (decode a sample and look) →
  placeholder encoding, not encryption. **Security-critical, stop.**

## 5. Decrypt on receive

User B opens the thread.

- PASS: `test message alpha 001` renders in plaintext on B's screen.
- PASS: B replies; A sees the reply in plaintext; server row for the reply
  is again body NULL + ciphertext populated.

## 6. Offline queue and reconnect

1. Put Device B in airplane mode.
2. User A sends three messages: `offline 1`, `offline 2`, `offline 3`.
3. Take B out of airplane mode; reopen the thread.

- PASS: all three decrypt correctly, in order, exactly once.
- FAIL: any message missing, duplicated, or showing a decrypt error.

## 7. SSE reconnect during send

1. On Device A, start sending a message, and immediately toggle airplane
   mode on then off (forcing the SSE stream to drop and reconnect).
2. Repeat 3 times with different messages.

- PASS: every message arrives at B exactly once. No silent drops, no
  double-decrypted duplicates.

## 8. Tamper rejection

In the Supabase SQL editor, corrupt one ciphertext:

```sql
update messages
set ciphertext = overlay(ciphertext placing 'ff' from 12 for 2)
where id = '<a recent e2ee message id>';
```

Force-refresh the thread on Device B (or clear the app's local cache for
that thread if refresh serves from cache).

- PASS: B shows a clear per-message error state ("couldn't decrypt" or
  equivalent). No crash. No silently rendering wrong content.
- FAIL: app crashes, or the message renders as if valid.

## 9. Safety numbers

On both devices, open the thread settings → safety number screen.

- PASS: the safety number displayed on A's device for this thread equals
  the one on B's device. (Photograph both screens side by side.)
- Then: sign User B in on a third install (or clear app data + re-login
  on Device B, which generates a new device identity).
- PASS: Device A shows the non-dismissible "safety number changed" banner
  in that thread.
- FAIL: numbers differ between A and B for the same thread before any
  device change → derivation bug. **Security-critical, stop.**

## 10. Local search over encrypted messages

On Device B, use Telegraph search for `alpha`.

- PASS: finds the decrypted message via the on-device FTS index.

## 11. Legacy plaintext threads unaffected

Open a thread created **before** this build (a legacy plaintext thread).

- PASS: history renders, sending works, translation button present and
  functional, notifications arrive, search finds old messages.
- PASS: the legacy thread does NOT show the lock badge.

## 12. No plaintext or key material in logs

While performing steps 3–9, keep `adb logcat` running on both devices.
Afterwards, search the captured logs:

```
grep -iE "alpha 001|offline 1|BEGIN.*KEY|sk_|private" logcat.txt
```

- PASS: no message plaintext and no private key material appears.
- FAIL: **security-critical**, file the exact log line and stop.

## Recording results

Copy this file, fill PASS/FAIL per step, attach: build ID, commit SHA,
device models, screenshots of steps 3, 8, 9. A run with any
security-critical FAIL means E2EE stays disabled for users until fixed
and re-verified — no exceptions.

## After a fully green run

1. Keep E2EE limited to internal test accounts.
2. Commission the external cryptography review (see
   `docs/security/crypto-review-brief.md`).
3. Only after review findings are resolved: opt-in beta → default-on,
   per the design doc's rollout guidance.
