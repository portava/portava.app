---
name: LiveKit calling foundation
description: Durable lessons from the calling-system audit — SDK enum gotcha, binding principles
---

# LiveKit calling foundation

- `livekit-server-sdk` v2 rejects string values for `canPublishSources` — use the `TrackSource` enum (`TrackSource.MICROPHONE`); a string throws "Cannot convert TrackSource ... to string" at token mint.
  **Why:** an audio-only grant written with `'microphone' as any` fails at runtime while typechecking clean.
  **How to apply:** any LiveKit grant code — import and use the enum.
- `listRooms` is a safe read-only LiveKit connectivity probe (creates nothing) — use it for prerequisite checks.
- Calling permission floor: only a messaging verdict of `allowed===true` may permit a call — `requires_request` must not.
- RAB bookings' `buddy_id` is the buddy *profile* id, not a user id — always resolve `rent_buddy_profiles.user_id` before comparing against users.
- Full Phase-0 binding table lives in `artifacts/api-server/docs/calling-foundation-audit.md`.
