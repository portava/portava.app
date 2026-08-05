# Wave 3 Bundle — 26 Runtime Bug Fixes (25 files)

Round-2 bug hunt on runtime logic (areas the first audit didn't deep-dive), all fixes validated against the real API test suite: **5,968 / 5,968 tests pass** (suite run in full after all changes). Unzip `portava-wave3-files.zip` over the repo root or `git apply --binary portava-wave3.patch`.

## ⚠️ Two NEW migrations to run in Supabase (after 2069/2070)
1. `artifacts/api-server/src/migrations/2071_stamp_progress_atomic.sql` — atomic stamp-progress counter RPC (fixes lost increments under concurrency). Code degrades gracefully until applied.
2. `2072_user_stamps_unique.sql` — **deduplicates existing duplicate stamp rows, then adds a unique index** preventing double-awards. Take a snapshot of `user_stamps` first (the migration header explains); validated on Postgres 16 incl. idempotent re-run and revoke→re-award path.

Details appended to `APPLY-NEW-MIGRATIONS.md`.

## Server fixes (highest impact first)
- **E2EE message send no longer 500s after insert** (messaging.ts) — was crashing on `body.trim()` with null ciphertext body → stored message + client retry duplicates.
- **Grid feed pagination no longer skips posts** (mediaFeed.ts) — cursor now anchors to last *served* item; previously up to 80% of chronological posts were unreachable.
- **DMs can no longer land in trip/circle chats** (messaging.ts) — direct-thread reuse now requires `thread_type='direct'`; 2-person trip chats matched before.
- **Left threads are revived on reuse** (messaging.ts) — open-thread/request-accept reset `left_at`, so accepted conversations no longer vanish for a party who once left.
- **Message-request accept is race-safe** (messaging.ts) — compare-and-swap on status; double-tap no longer creates duplicate threads/messages.
- **Trip-completed review prompt** (trips.ts) — no longer notifies pending invitees/removed members; goes through NotificationService so privacy guard + dedup run.
- **Trip status honors the trip's timezone** (trips.ts) — no more premature "completed" (+ stamps + review pushes) at UTC midnight mid-trip.
- **Leaving a trip chat sticks** (chatSync.ts) — member sync no longer force-rejoins voluntary leavers.
- **Stamp fixes** (StampAwardEngine.ts + migrations) — atomic progress counter; unique index kills concurrent double-awards; 23505 mapped to `already_earned`.
- **Unified passport count** (UnifiedStampService.ts) — distinct location-less achievements no longer collapse into one stamp.
- **Compass scoring** (CompassScoringEngine.ts) — languages no longer dilute interest-match; place-affinity boost re-clamped to 0-100.
- **Notification dedup** (NotificationDeduplicationService.ts) — different event types about the same source no longer suppress each other.
- **devices.ts** — type guard on route param (caught by typecheck during the test run).

## Client fixes (travel-buddy-standalone)
- **Sign-out now wipes E2EE identity/device keys** (SessionContext.tsx) — was leaving user A's crypto identity for user B to inherit (cross-account contamination).
- **Crypto init runs on sign-in, not just cold start** (useCryptoInit.ts) — new users get E2EE in their first session; tokens fetched per-call instead of stale snapshot.
- **"See destination" on trip detail works** (trip/[id].tsx) — effect dependency read a field that never exists.
- **Feed refresh vs pagination races fixed** (usePosts.ts, usePulseFeed.ts) — generation fencing; no more corrupted lists/skipped pages after pull-to-refresh.
- **Notification center pagination gap fixed** (useNotifications.ts) — offset resets when realtime events refresh page 1.
- **Group chat**: loadMore in-flight guard + dedupe (no duplicate messages), null-guard on unconfigured builds (no crash), stale-userId fix on optimistic sends.
- **Thread switching no longer interleaves two conversations** (useMessaging.ts) — messages cleared + results fenced on threadId change.
- **Account-status fetch fenced** (SessionContext.tsx) — a slow response can't apply the previous account's status after sign-out/switch.

## Test evidence
- Full API suite after all Wave 3 changes: **5,968 pass / 0 fail** (~7.5 min run).
- Migrations 2071/2072 validated against real Postgres 16 (concurrency, idempotent re-run, revoke→re-award).
- 4 test files updated where fixtures asserted the old buggy behavior (stale `compass_analytics`/`start_at` fixtures, dead-code meetups handler, one mock that was masking the grid-cursor bug) — each flagged and explained in comments.
- Client changes syntax-verified (esbuild); run the standalone suites in the workspace for full validation.

## After applying
1. Run api-server tests in the workspace (expect green).
2. Apply migrations 2071 + 2072 in Supabase.
3. Redeploy the API.
4. Rebuild the mobile app (client fixes included).
