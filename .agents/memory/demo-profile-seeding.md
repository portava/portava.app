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

## Idempotency

Use deterministic UUIDs (e.g., UUIDv5 keyed by the target profile id and a seed string) so reruns skip already-inserted rows instead of duplicating content.

**Why:** A seed script will be rerun during demos and fixes. Without deterministic IDs, partial failures leave half the requested rows and the next run creates uncontrolled duplicates.

**How to apply:**
- Generate every primary key with a stable function of `profileId + table + index`.
- Query existing ids before each insert batch and skip those that are already present.
- Log inserted vs. skipped counts per table so the operator can see partial states.
