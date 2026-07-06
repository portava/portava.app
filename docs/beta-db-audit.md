# Beta Phase 12 — Database Audit

Generated: 2026-07-06. Tracks unapplied migrations and schema gaps identified
during the Phase 12 admin-tools / feature-flags audit. Apply all items in the
order listed before cutting a release build.

---

## Unapplied migrations (apply in order)

| # | File | Status | Verify query |
|---|------|--------|-------------|
| 1 | `artifacts/api-server/src/migrations/0117_beta_feature_flags.sql` | **pending** | `SELECT flag, enabled FROM feature_flags WHERE flag IN ('disable_signups','disable_posting','disable_messaging','disable_rab_bookings','invite_only_beta','rent_buddy_enabled') ORDER BY flag;` — 6+ rows must appear |
| 2 | `artifacts/api-server/migrations/0123_engagement_user_indexes.sql` | **pending** | `SELECT indexname FROM pg_indexes WHERE indexname IN ('idx_posts_likes_user_created','idx_post_reactions_user_created','idx_comment_likes_user_created','idx_highlight_likes_user_created','idx_memory_likes_user_created');` — 5 rows |

### Migration 0117 — Beta feature flags

Seeds 12 flags via `ON CONFLICT (flag) DO NOTHING` so re-runs are safe:

```sql
INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('rent_buddy_enabled',              TRUE,  'Feature gate — Rent a Buddy'),
  ('safe_return_live_share_enabled',  TRUE,  'Feature gate — Safe Return live share'),
  ('find_your_circle_enabled',        TRUE,  'Feature gate — Find Your Circle'),
  ('compass_ai_enabled',             TRUE,  'Feature gate — Compass AI'),
  ('hidden_gems_enabled',            TRUE,  'Feature gate — Hidden Gems feed'),
  ('push_notifications_enabled',     TRUE,  'Feature gate — push notification delivery'),
  ('disable_signups',                FALSE, 'Kill switch — blocks new registrations'),
  ('disable_posting',                FALSE, 'Kill switch — blocks POST /posts'),
  ('disable_messaging',              FALSE, 'Kill switch — blocks POST /threads/:id/messages'),
  ('disable_rab_bookings',           FALSE, 'Kill switch — blocks POST /api/rent-a-buddy/bookings'),
  ('city_launch_mode',               FALSE, 'Kill switch — restricts to seeded launch cities only'),
  ('invite_only_beta',               FALSE, 'Kill switch — requires invite code to register')
ON CONFLICT (flag) DO NOTHING;
```

### Migration 0123 — Engagement user indexes

Adds five user-perspective like/reaction indexes used by profile pages and "liked
by me" feed indicators. File: `artifacts/api-server/migrations/0123_engagement_user_indexes.sql`.

---

## Kill-switch enforcement map

| Flag | Enforced at | Fail-open? |
|------|------------|-----------|
| `disable_posting` | `POST /posts` (posts.ts) | ✓ yes |
| `disable_messaging` | `POST /threads/:id/messages` (messaging.ts) | ✓ yes |
| `disable_rent_buddy_booking` | `POST /api/rent-a-buddy/bookings` (rentABuddy.ts) | ✓ yes |
| `disable_signups` | `GET /api/auth/signup-status` (auth.ts) | ✓ yes |
| `invite_only_beta` | `GET /api/auth/signup-status` (auth.ts) | ✓ yes |
| `city_launch_mode` | documented — per-city disable managed via `rent_buddy_city_rollouts.status='disabled'` | n/a |
| `rent_buddy_enabled` | `POST /api/rent-a-buddy/bookings` via `requireRentBuddyEnabled` | ✓ yes |

> **Mobile contract**: the mobile app MUST call `GET /api/auth/signup-status`
> before initiating Supabase Auth sign-up and display an appropriate message
> when `signupsEnabled=false` or `inviteOnly=true`.

---

## Feature-gate status

| Flag | Default | Route using it |
|------|---------|---------------|
| `rent_buddy_enabled` | ON | `checkRentBuddyAccess` (all RAB routes) |
| `safe_return_live_share_enabled` | ON | safe-return live-share routes |
| `find_your_circle_enabled` | ON | circle discovery routes |
| `compass_ai_enabled` | ON | `GET /api/compass/feed` etc. |
| `hidden_gems_enabled` | ON | `GET /api/hidden-gems/*` |
| `push_notifications_enabled` | ON | notification delivery path |

---

## Schema gaps identified — no SQL needed, all columns exist

| Table | Column | Migration that adds it | Notes |
|-------|--------|----------------------|-------|
| `profiles` | `account_status` | 0094 | read by `requireUser` in lib/http.ts |
| `compass_analytics` | `onboarding_completed`, `onboarding_completed_at` | 0107 | read by `GET /admin/users` onboardingStatus field |
| `feature_flags` | `flag`, `enabled`, `description` | pre-existing | seeded by 0117 |

---

## Pre-release checklist

Run before cutting the next build:

```bash
bash scripts/pre-release-check.sh
```

Outstanding items that will cause `db-triggers` check to fail if not applied:

- Migration 0117 must be applied so `feature_flags` rows exist.
- Migration 0123 must be applied so `engagement-indexes` check passes.

See [docs/migrations.md](migrations.md) for full migration history and apply instructions.
