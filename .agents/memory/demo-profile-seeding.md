---
name: Demo profile seeding gotchas
description: Live DB constraints and stale code paths that blocked seeding the demo profile, and the fixes that made it idempotent.
---

## Rule of thumb

When seeding production-like data for a profile, always query the **live** schema first; the generated `database.types.ts` and the application code both drift from the deployed constraints.

## What broke and why

1. **`passport_stamps.stamp_type` check constraint** — `database.types.ts` says `text`, but the live DB only allows `verification | destination | event | trip | achievement | host | rent_a_buddy`. The `PassportStampService.createStamp` code tries to insert `city | plan | activity`, which would also fail if it were ever called. We seeded directly with the allowed values.

2. **`memories.visibility` check constraint** — the app code accepts `only_me`, `public`, `friends_only`, `trip_crew`, `circle_only`, `custom`; `private` is not allowed. We switched the demo seed to use those values.

3. **`highlights` has no `updated_at` column** and its `visibility` check allows `public | travelers_nearby | circle_only | trip_only | private`. We removed `updated_at` and stopped using `friends_only`.

4. **`profileTabs.ts` `/users/:username/stamps` endpoint queries a non-existent `stamps` table.** The app actually fetches profile stamps via `/stamps/profile/:username` (in `routes/stamps.ts`), which reads `user_stamps`. So the demo data needed to be in `user_stamps` to render on the profile; `passport_stamps` alone is not surfaced there.

5. **`event_roles` has no `id` column.** The live table uses a composite key on `(event_id, user_id)`, while `database.types.ts` shows a single `id`. Upserts must target the composite key.

6. **`events` discovery code referenced `profiles.is_verified`.** The live `profiles` column is `verified`, not `is_verified`. This caused the gate queries to fail and the event feed to return zero rows for users with age/verified-only gates. We aligned the events route to the live column.

7. **`/api/users/:userId/events` in `events.ts` shadowed the public `/users/:username/events` profile tab.** Both routes were mounted at the same path; the auth-gated one won, so unauthenticated profile viewers got 401. We removed the duplicate route and made `profileTabs.ts` resolve by UUID as well as handle/username.

8. **Demo memories were seeded but not demo-ready.** The original 20 demo memories had mixed visibility (`only_me`/`friends_only`/`public`) and null `location_city`/`location_country`. The Memories tab and map viewers need those fields. We updated the seed to make them all public, fill in locations, and link matching public events by city. The `fix:demo-memories` script applies the same upgrade to already-seeded rows.

## Social graph + engagement seeding gotchas

1. **`auth.admin.getUserById` for a missing user returns `{ data: { user: null }, error: ... }`, not `{ data: null }`.** Checking `if (!data)` is therefore truthy even when the user does not exist; always inspect `data.user` before deciding to call `createUser`.

2. **`friend_requests` and `user_friendships` are not in the generated `database.types.ts`.** Live `friend_requests` columns are `id, requester_id, recipient_id, status, created_at` (no `updated_at`). Live `user_friendships` columns are `user_a, user_b, created_at` (no `accepted_request_id`). Use live queries or the REST API to verify these tables before inserting.

3. **`memory_likes` and `memory_saves` have no `id` column; the primary key is the composite `(memory_id, user_id)`.** Deduplication must be keyed on that composite pair, not on a single `id` field.

4. **`passport_postcards` has no `media_type` column, but the public postcard wall (`/users/:username/passport/postcards`) requires a matching `post_media` row.** The wall filters `post_media.processing_status = 'ready'` and `moderation_status != 'rejected'`. Seeding a postcard alone renders nothing; you must also seed a `post_media` row (or upload through the real media pipeline). The `post_media` table itself is also absent from `database.types.ts`; required live columns include `post_id, user_id, media_type, storage_bucket, storage_path, public_url, mime_type, processing_status, moderation_status, sort_order` (no `expires_at`).

5. **External sample video URLs (e.g., Google Storage `gtv-videos-bucket`) may return 403 from the server and from the app**, even though they play in some browsers. Use a consistently reachable URL (e.g., `w3schools.com/html/mov_bbb.mp4`) for demo assets that must actually load in `expo-av`.

6. **The supported verification path for a demo account is the admin verify endpoint (or the equivalent service-role update).** `POST /admin/users/:userId/verify` sets `profiles.verified = true`, `verification_status = 'verified'`, and `verified_at`, and also awards a `verified_traveler` stamp. Do not set a UI-only fake badge; read the real `verified` / `verification_status` fields and use `isTravelBuddyVerified()`.

## Idempotency

Use deterministic UUIDs (e.g., UUIDv5 keyed by the target profile id and a seed string) so reruns skip already-inserted rows instead of duplicating content.

**Why:** A seed script will be rerun during demos and fixes. Without deterministic IDs, partial failures leave half the requested rows and the next run creates uncontrolled duplicates.

**How to apply:**
- Generate every primary key with a stable function of `profileId + table + index`.
- Query existing ids before each insert batch and skip those that are already present.
- For composite-key tables, dedupe on the actual primary key, not an `id` column that may not exist.
- Log inserted vs. skipped counts per table so the operator can see partial states.
