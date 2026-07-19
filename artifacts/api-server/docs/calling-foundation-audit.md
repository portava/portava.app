# Phase 0 — Calling Foundation Audit (2026-07-19)

Gate audit for the LiveKit-based calling system. Foundation files under
`src/lib/calls/` were audited, **not modified**.

## 1. LiveKit prerequisite check — **PASSED** (with one flagged mismatch)

Ran `scripts/livekit-prereq-check.ts` (`node --import tsx/esm scripts/livekit-prereq-check.ts`):

| Check | Result |
|---|---|
| `LIVEKIT_URL` | present |
| `LIVEKIT_API_KEY` | present |
| `LIVEKIT_API_SECRET` | present |
| Short-TTL token mint (video grant) | OK — valid 3-segment JWT |
| Short-TTL token mint (audio-only grant) | **FAILED — mismatch M1 below** |
| Connectivity (`listRooms`, read-only, no room created) | OK — 0 active rooms |

**Verdict: PASSED** — secrets valid, project reachable, tokens mintable. Later phases are unblocked, but M1 must be resolved in Phase 1 before audio-only (voice) calls can mint tokens.

## 2. Foundation health check — **GREEN**

`node --import tsx/esm --test src/test/callSystem.test.ts` → **21/21 pass** (permission matrix, state machine, reconciler idempotency/CAS/sweeps).

## 3. Live schema check — **migration 0155 NOT applied**

Queried the live database via the Supabase Management API (`information_schema.columns`): **none of `call_sessions`, `call_participants`, `call_preferences` exist.** Phase 1 must apply `src/migrations/0155_calling_system.sql` via the Management API (one request per file; direct psql is unreachable from this workspace). Record it in `docs/migrations.md` once applied.

## 4. Genuine foundation↔architecture mismatches (flagged, NOT fixed)

### M1 — `mintCallToken` audio-only grant breaks against installed SDK (blocking for voice calls)
`livekitService.ts` passes `canPublishSources: ['microphone' as any]`. Installed `livekit-server-sdk@2.17.0` requires the `TrackSource` enum (`TrackSource.MICROPHONE`); the string throws `Cannot convert TrackSource microphone to string` at mint time. Video-grant path (`canPublishSources: undefined`) works.
**Recommendation:** in Phase 1, with user approval, change to `TrackSource.MICROPHONE` (import from `livekit-server-sdk`). One-line fix; all other foundation behavior verified good.

### M2 — `canMessage` signature differs from the gateway port (adapter concern, not a defect)
Gateway port: `canMessage(userA, userB, threadId) => boolean`. Existing helper: `canMessage(sc, senderId, recipientId) => MessagePermissionVerdict` (no thread arg; returns verdict object). Adapter must map `verdict.allowed === true` → `true` (a `requires_request` verdict must NOT permit calling) and ignore `threadId` (thread membership is checked separately via `getThreadParticipants`).

### M3 — no `canCall` moderation field
`TrustRestrictionService.getRestrictionState` exposes `canHost`, `canMessage`, `canJoinPrivatePlans`, `canJoinLocationPlans` — no calling-specific restriction. **Recommendation:** bind `isCallRestricted(userId)` → `!state.canMessage` (messaging restriction is the calling floor); add a dedicated `calling` restriction_type later only if moderation needs it.

No other mismatches found — all remaining ports map cleanly (below).

## 5. Gateway/store port → existing-system bindings

### `CallContextGateway` (permission engine)

| Port | Recommended binding |
|---|---|
| `getThreadParticipants(threadId)` | `message_thread_members` where `thread_id = ? AND left_at IS NULL` → `user_id[]`; null when no rows/thread missing. |
| `canMessage(a, b, threadId)` | `lib/messagingPermissions.ts` `canMessage(sc, a, b)` → `verdict.allowed === true` (see M2). |
| `isBlockedEither(a, b)` | `blocks` table, both-direction `.or(...)` pattern used in `messagingPermissions.ts` / `circleAccessGuard.ts`. |
| `getCallPreferences(userId)` | `call_preferences` PK lookup (0155); absent row → defaults (`people_i_message`, rab=true, video=true). |
| `isEligibleRabConversation(threadId, a, b)` | `rent_buddy_bookings` where `telegraph_thread_id = threadId`, parties = `traveler_id` + `rent_buddy_profiles.user_id` (identity contract: `buddy_id` is the *profile* id — resolve to user_id!), status ∈ `scheduled | in_progress | completed_pending_traveler_confirmation`. |
| `isActiveCrewMember(tripId, userId)` | `trip_members` where `trip_id = ? AND user_id = ? AND role IN ('owner','member')` (matches `isAcceptedTripMember` in `lib/http.ts`; `invited` is not active). |
| `eventRoomIneligibility(eventId, userId)` | Delegate to the canonical event participation path used by `routes/events.ts`: attendance/privacy from event membership, age via `lib/ageEligibility.ts`, trust via `CompassEligibilityEngine.runEligibilityCheck` / trust floors. Map to `not_event_eligible` / `age_ineligible` / `trust_ineligible`. |
| `isCallRestricted(userId)` | `getRestrictionState(sc, userId)` → `!canMessage` (see M3). |
| `isSessionTerminated` / `wasRemovedFromCall` | `call_sessions.status` terminal check / `call_participants.status = 'removed'` (0155). |
| `lastDeclineAt(caller, callee, threadId)` | `call_sessions` join `call_participants`: latest session in thread with `status='declined'` where callee declined caller → `ended_at`. Covered by `idx_call_sessions_thread`. |
| `startsInLastHour(userId)` | Count `call_sessions` where `started_by = ? AND started_at > now()-1h` (`idx_call_sessions_starter`). Optionally also `lib/rateLimit.ts` `checkRateLimit` as an in-memory fast path; the DB count is authoritative. |

### `CallStore` (reconciler)

| Port | Recommended binding |
|---|---|
| `getSessionByRoom` / `getSession` / `listOpenSessions` | `call_sessions` (`room_name` unique; open = `status IN ('ringing','active')`, partial index `idx_call_sessions_open`). |
| `applyTransition` (CAS) | `UPDATE call_sessions SET status=to, ... WHERE id=? AND status=from` — check affected-row count for the compare-and-set contract. |
| `markParticipantJoined/Left` | `call_participants` upsert on `(call_id, user_id)`. |
| `writeCallHistoryMessage` | Insert into `messages` with `msg_type='system'`, `subtype='call_' + status` (mirrors `emitBookingMilestone` in `routes/rentABuddy.ts`); body from `callHistoryLine()`. Skip when `thread_id` is null (event rooms). |

### Infrastructure conventions (for Phases 1–5)

- **Push:** `NotificationService.create` + `NotificationRouter.route`, fire-and-forget (pattern: `notifyBookingParty` in `rentABuddy.ts`); retryable failures via `pushRetryQueue`/`pushRetryWorker`. New eventTypes (e.g. `call.incoming`, `call.missed`) need templates in `NotificationTemplateService`.
- **Realtime/SSE:** `lib/telegraphEvents.ts` — `publishToUsers` / `publishToThread` (per-user channels, cross-instance via `telegraphBroadcast` hook). Ring/accept/end events fan out here.
- **Scheduler:** `setInterval` loops started in `index.ts` (examples: `safeReturnScheduler.ts`, `tripReminderScheduler.ts`). `sweepOpenSessions` should run every ~15–30s the same way (it is idempotent/CAS-safe by design).
- **Rate limiting:** `lib/rateLimit.ts` sliding-window `checkRateLimit` — supplemental only (in-memory, per-instance); engine's DB count is the backstop.
- **Analytics:** `rank_events`-style tables (migration 0153) with fire-and-forget inserts; call analytics can follow the same shape if wanted (out of scope here).
- **Migrations to production:** Supabase Management API `POST /v1/projects/{ref}/database/query`, one file per request; verify against `information_schema`; update `docs/migrations.md`. Startup `schemaDriftCheck` will otherwise degrade silently.
- **Client:** `travel-buddy/src/services/calls.ts` expects `/calls/start`, `/calls/accept`, `/calls/end`, `/calls/active` (base `EXPO_PUBLIC_API_BASE_URL`, deny reasons surfaced from `reason`); `CallContext.tsx` uses a `LiveKitBridge` port — `@livekit/react-native` not yet installed (Phase 1+). Note the spec-alias lesson: register routes at canonical paths, not aliases.

## 6. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| M1 SDK enum mismatch blocks voice tokens | High (blocks voice) | 1-line Phase 1 fix, user-approved |
| 0155 not applied → routes fail at runtime | High | Apply in Phase 1 via Management API; verify live schema, not generated types |
| RAB `buddy_id` = profile id, not user id | Medium | Adapter must resolve via `rent_buddy_profiles.user_id` (identity contract in `rentABuddy.ts` header) |
| `requires_request` verdict mistakenly treated as callable | Medium | Adapter maps only `verdict.allowed === true` |
| In-memory rate limit is per-instance | Low | DB count via `idx_call_sessions_starter` is authoritative |
| Webhook event-name drift across SDK versions | Low | Reconciler treats unknown events as no-ops (verified by test) |

## 7. In-flight task conflict check

Perf tasks #1611–#1615 are merged. Current open project tasks are all PROPOSED micro-verification tasks; none touch Telegraph event/navigation/provider files (`telegraphEvents.ts`, `CallContext.tsx`, navigation providers). No conflicts for Phase 1.

## 8. Recommended implementation order (Phases 1–5)

1. **Phase 1 (backbone):** apply 0155 (Management API), fix M1 (user-approved), implement gateway + store adapters per §5, wire the sweep scheduler.
2. **Phase 2:** routes (`/calls/start|accept|end|active`, webhook endpoint with signature verification) at canonical paths.
3. **Phase 3:** push templates + SSE fan-out for ring/answer/end.
4. **Phase 4:** client — install `@livekit/react-native`, implement `LiveKitBridge`, wire `CallContext`.
5. **Phase 5:** group rooms (trip crew / event) + preferences UI + moderation surface.
