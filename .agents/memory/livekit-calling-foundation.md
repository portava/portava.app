---
name: LiveKit calling foundation
description: Durable lessons from the calling-system audit — SDK enum gotcha, binding principles
---

# LiveKit calling foundation

## Phase 6 hardening decisions
- Ghost healing is fail-closed: the sweep only ends an `active` session when a `roomExists` probe positively says the room is gone, after `GHOST_ACTIVE_GRACE_MS`; probe absence/error/live-room all leave the call alone — the 4h cap is the permanent-active backstop. **Why:** a LiveKit API outage must never hang up live calls.
- Direct-start double-tap is deduped server-side: an open direct session (same caller/callee/thread, startedBy=caller) returns a 200 grant into the existing session instead of creating a second ring/push. Client `sessionRef` guard alone was not enough.
- Load review for sweeps/webhooks/tokens lives at `artifacts/api-server/docs/calling-load-review.md`.

- `livekit-server-sdk` v2 rejects string values for `canPublishSources` — use the `TrackSource` enum (`TrackSource.MICROPHONE`); a string throws "Cannot convert TrackSource ... to string" at token mint.
  **Why:** an audio-only grant written with `'microphone' as any` fails at runtime while typechecking clean.
  **How to apply:** any LiveKit grant code — import and use the enum.
- `listRooms` is a safe read-only LiveKit connectivity probe (creates nothing) — use it for prerequisite checks.
- Calling permission floor: only a messaging verdict of `allowed===true` may permit a call — `requires_request` must not.
- RAB bookings' `buddy_id` is the buddy *profile* id, not a user id — always resolve `rent_buddy_profiles.user_id` before comparing against users.
- Full Phase-0 binding table lives in `artifacts/api-server/docs/calling-foundation-audit.md`.

## Phase 7 readiness lessons (2026-07-19)
- The production deployment can lag the repo by days: prod served old routes (`/api/stamps/*` fine) while every `/api/calls/*` 404'd. **Why:** autoscale serves the last published build, not HEAD. **How to apply:** before claiming any endpoint "live", curl the production domain — a webhook registration against an unpublished route silently drops every event.
- A LiveKit webhook round-trip can be self-tested without the dashboard: sign the exact body (JWT `sha256` claim via `AccessToken`) and POST it — expect 200 signed / 401 unsigned / 401 tampered. Use a nonexistent `pcall_*` room so reconciliation is a no-op.
- Watch RLS on follow-up migrations: 0155 enabled RLS everywhere, but 0156's new audit table shipped without it (fixed live in the readiness audit — enable RLS with zero policies for service-role-only tables).
- Release-readiness report lives at `artifacts/api-server/docs/calling-release-readiness.md`; open gates there: republish, LiveKit Cloud webhook registration, device-test gate.

## Group (trip_crew) room semantics — Phase 4 decisions
- Group rooms have NO ring phase: start creates the session and immediately transitions CONNECTED (starter joined, role host). Joiners never re-ring anyone.
- Concurrent start resolves server-side: POST /calls for group finds the open session for (contextType, contextId) and returns a 200 join grant into it — never a second room.
- Rejoin rule lives in `markParticipantJoined`: statuses invited/ringing/joined/left/missed are re-joinable; `removed`/`declined` never resurface (engine also denies removed_from_room).
- Group history line ("Crew Call ended · N min · M participants") is written by the store adapter for trip_crew sessions with null threadId, resolving the trip thread (thread_type='trip'); only on status `ended`.
- One restrained start notification per member via `announceCrewCallStarted` (`_setTestCrewDeps` seam) — excludes starter, honors incoming_call_notifications; realtime `call.group_started`/`call.group_ended` fan out to crew member ids.
- Concurrent group starts are guarded twice: a per-process lock in the calls route serializes lookup+create, and the live DB partial unique index `uniq_open_group_room_per_context` (one open group_voice room per context) turns cross-instance races into GroupRoomConflictError → join the winning room.
- Standalone fork carries Phase 3 gating files but not the Phase 4 crew-call surfaces; check the actual tree before assuming parity either way.
