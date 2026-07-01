---
name: Profile visibility system
description: resolveProfileVisibility helper, profile_privacy_settings vs user_privacy_settings, profile tab endpoints pattern
---

## resolveProfileVisibility helper

`artifacts/api-server/src/lib/profileVisibility.ts` — shared helper returning one of:
- `full` — public profile or viewer is owner
- `followers_only` — private/followers-only profile, viewer IS a follower or friend
- `limited_preview` — private profile, viewer is NOT follower/friend or unauthenticated
- `blocked` — block relationship (FAIL-CLOSED on block query error)
- `unavailable` — account deactivated/banned/deleted

Call signature: `resolveProfileVisibility(sc, viewerId | null, targetId, targetProfileRow)`

**Why:** Used by both passport route and profile tab routes to avoid duplicating block + account-state + privacy checks.

## Two privacy tables — keep in sync

- `user_privacy_settings` — used by `resolveInteractionPermissions()` engine for `profile_visibility`, `who_can_tag`, `age_restriction_enabled`. Legacy, fewer fields.
- `profile_privacy_settings` — NEW comprehensive table (migration 0069) with 17 fields including show_posts, show_stamps, show_trips, allow_tagging, etc.

**Why:** When PATCH /api/me/privacy updates `profile_visibility` in `profile_privacy_settings`, also upsert `user_privacy_settings.profile_visibility` so the interactionPermissions engine stays consistent. `followers_only` maps to `null` in user_privacy_settings.

## Passport viewer object derivation

Passport route calls `resolveInteractionPermissions()` when viewer is authenticated and not the target. Maps:
- `label === "following" || label === "mutual_follow"` → `is_following: true`
- `label === "friend"` → `is_friend: true`
- `label === "outgoing_request"` → `has_pending_friend_request_sent: true`
- `label === "incoming_request"` → `has_pending_friend_request_received: true`
- `label === "blocked" || label === "mutual_block"` → `is_blocked_by_me: true`
- `label === "blocks_you" || label === "mutual_block"` → `has_blocked_me: true`

## Username rules (updated)

- `USERNAME_RE = /^[a-z0-9_]{3,30}$/` — no periods, max 30 chars
- Reserved: admin, support, travelbuddy, official, root, system, null, undefined, help, security, moderator, owner + legacy list
- 30-day cooldown via `username_updated_at` column on profiles; skipped if same username

## Account management routes

- `POST /api/me/deactivate` — upserts `user_account_states.state='deactivated'`
- `POST /api/me/delete-request` — upserts `user_deletion_requests` (30-day hold) + deactivates
- `GET/PATCH /api/me/privacy` — `profile_privacy_settings` with defaults fallback

## Profile tab endpoints

`src/routes/profileTabs.ts` — all 5 tabs use the same pattern:
1. Fetch target profile by username
2. `getOptionalViewerId()` from auth header
3. `applyVisibilityGuard()` → blocked/unavailable → 200 with flags; limited_preview → empty items
4. Check specific privacy setting (show_posts, show_stamps, etc.) — owner bypasses
5. Cursor-based pagination: `?cursor=<iso-timestamp>&limit=<n>` → `{ items, nextCursor }`
