---
name: Account-scoped AsyncStorage sweep methodology
description: How to audit every AsyncStorage key in a shared-device mobile app for cross-account leakage, and the pattern used to fix each leak found.
---

## The audit technique
Grep every `AsyncStorage.getItem/setItem/removeItem` call site in the app. For
each key, ask one question: **"If account B reads this key on the same
device, could it return data written by account A — and does that matter?"**
Classify into:
- **Genuinely global** (device/app-level preference, not tied to who's
  signed in) — leave unscoped. Examples: map layer toggles, video-mute
  state, preferred external-maps app, shared per-city place caches keyed by
  a resource id (not by account).
- **Real leak** — personal dismissal flags, personal "seen/viewed" markers,
  personal saved/bookmarked state, one-time celebration flags. These read
  as correct in isolation (single-account testing never surfaces them) but
  silently misbehave the moment a device is shared or an account switches.

A partial fix within a stated scope reads as "done" the same way an
unscoped leak reads as "working" — sweep the *entire* codebase for the
pattern before declaring the class of bug fixed, don't stop at the first
few instances found.

## The fix pattern (repeated across ~9 keys in travel-buddy-standalone)
1. A synchronous, testable kill-switch flag (`isAccountScopedStorageEnabled()`
   in `src/config/accountScopedStorageFlag.ts`) gates all new behavior;
   ships OFF until validated on a real device.
2. `getCurrentAccountId()` (`src/services/accountId.ts`) resolves the
   signed-in account without a React tree (lazy-imports auth.ts so pure
   node:test files never load react-native).
3. Per key: a `scoped<Name>Key(id, accountId)` function, a
   `resolve<Name>Key(storage)` function that returns the legacy key when the
   flag is off, the scoped key (running a one-time migration first) when an
   account is resolvable, or `null` when it isn't — callers must treat
   `null` as "no data" for reads and skip the write, never falling back to
   the legacy key.
4. One-time migration on first resolve per account: best-guess attribution
   of the existing unscoped blob to whichever account is first signed in
   post-upgrade, then delete the legacy key. Side effects tied to the data
   (e.g. cancelling scheduled notifications) must fire regardless of
   attribution correctness — a wrong guess is bounded and recoverable, a
   leftover live side effect firing for the wrong account is not.
5. A `_resetMigrated<Name>...` test seam plus (if the file imports
   'react-native' anywhere, even transitively) extraction of the pure
   storage/migration logic into a sibling module with no react-native
   import chain, so it's unit-testable under node:test. Check the *full*
   import chain, not just the file's own imports — a hook can look pure but
   transitively import supabase.ts/react-native through a services file.
6. Module-level singleton caches (e.g. an in-memory `Set` initialized once
   at import time) need an explicit "reload if the resolved key changed"
   guard, not just a key-name swap — otherwise switching accounts
   mid-session keeps serving the previous account's in-memory state even
   after storage itself is correctly scoped.
7. Tests per key: cross-account read isolation, migration + legacy-key
   deletion, migration idempotency, and flag-OFF byte-identical behavior.
