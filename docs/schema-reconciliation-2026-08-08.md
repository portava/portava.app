# Schema reconciliation — production vs repository

**Four-way classification of every known divergence between the migration files
in this repository and the live Supabase schema.** Read-only. Nothing applied,
nothing repaired.

Date: 2026-08-08. Branch `bughunt-20260805`. Project `ajrurzioarfkagpuxfnb`.

**Migration decision is closed: Option A stands.** Nothing in this document
proposes adding `tags.tagged_at` or running the skipped `0044` pieces. Items
that would change production schema or migration ownership are listed as
decision-ready and were not acted on.

---

## 0. Method and scope

Two independent sources, both read-only:

1. **`pnpm run audit:schema`** (`artifacts/api-server/src/scripts/auditMigrationsVsLive.ts`)
   — parses every migration file for the objects it claims and diffs them
   against live via the Management API. **Audited 250 files, 3,726 claimed
   objects.**
2. **Direct `information_schema` / `pg_constraint` queries** for the specific
   objects implicated in this session's findings.

**Scope limit, stated honestly:** the audit covers objects migration files
*claim*. It cannot see live objects that no migration declares — so category C
below is populated only where a divergence happened to surface, not
exhaustively. A complete live-side inventory was not performed.

### The four categories

| | Category | Meaning |
|---|---|---|
| **A** | **RECONCILED** | Repo declares X; live has a known, semantically equivalent Y. Understood, and harmless *provided the code uses Y*. |
| **B** | **DECLARED–NEVER-APPLIED** | Repo declares it; live has no equivalent. A real absence. |
| **C** | **LIVE-AHEAD–EXPLAINED** | Live is ahead of an early migration, and a *later repo migration* accounts for it. Not drift. |
| **D** | **UNDETERMINED** | Cannot be categorised from available evidence. |

---

## 1. Category A — RECONCILED (26 objects)

The repo maintains a curated allowlist of divergences in
`auditMigrationsVsLive.ts` (29 entries). **I verified all 26 column entries
against live.** 25 behave exactly as the allowlist claims.

Renames, confirmed — repo name → live name:

| Repo declares | Live has |
|---|---|
| `feature_flags.key` | `flag` |
| `events.status` | `state` |
| `highlights.user_id` | `owner_id` |
| `highlight_replies.user_id` | `replier_id` |
| `passport_stamps.earned_at` | `awarded_at` |
| `user_location_state.latitude` / `.longitude` | `lat` / `lng` |
| `user_location_state.accuracy` / `.location_source` | `accuracy_meters` / `source` |
| `passport_stamps_gps.latitude` / `.longitude` | `lat` / `lng` |
| `plan_checkins.plan_item_id` | `plan_geofence_id` |
| `plan_attendance_events.plan_item_id` | `plan_geofence_id` |
| `geofence_admin_settings.{default,min,max}_radius` | `*_radius_meters` (see §4.5) |
| `passport_visibility_preferences.map_visibility` / `.stamps_visibility` | `map_visible` / `stamps_visible` |
| `trip_crew_location_preferences.ghost_mode` / `.visibility` | `ghost_mode_enabled` / `visibility_default` |

**One allowlist entry is wrong.** `column:plan_attendance_events.metadata` is
allowlisted with the comment `// live: details`, but **live has both `details`
and `metadata`.** The entry suppresses a check for a column that exists, so a
future regression on `metadata` would be silently ignored. Minor, but it is an
allowlist defect rather than a schema divergence. **Not corrected here** — the
allowlist lives in `src/scripts/`, outside this pass's remit.

---

## 2. Category B — DECLARED, NEVER APPLIED (13 objects + 1)

Straight from `audit:schema`. **These are beyond the allowlist** — real
absences nobody has catalogued.

| File | Missing object | Kind |
|---|---|---|
| `20260731_post_event_links.sql` | **table `post_event_links`** | table |
| | `idx_post_event_links_post_id` | index |
| | `idx_post_event_links_event_id` | index |
| `20260811_media_rls.sql` | policy `media_assets_public_select` | **RLS policy** |
| | policy `media_attachments_public_select` | **RLS policy** |
| `0026_highlights.sql` | policy `users_view_highlight_replies` | **RLS policy** |
| `2033_rls_hardening.sql` | policy `users_view_highlight_replies` (same) | **RLS policy** |
| `0186_geo_indexes.sql` | `user_location_state_geo_idx` | index |
| | `events_geo_idx` | index |
| | `posts_geo_idx` | index |
| | `hidden_gems_geo_idx` | index |
| | `hidden_gems_approx_geo_idx` | index |
| `2044_hidden_gems_canonical_place_id.sql` | `hidden_gems_canonical_place_idx` | index |

**Plus `tags.tagged_at`** — allowlisted as benign, but the one case where an
absence reached executing code and broke an abuse control (finding 16). It sits
formally in category A's allowlist and behaviourally in category B. That
mismatch is the whole lesson of finding 16.

**Three of these matter more than the rest:**

- **`post_event_links` does not exist.** An entire declared table is absent.
  Any code path that reads it fails the same way finding 16 did.
- **Three RLS policies are missing**, two on `media_assets` /
  `media_attachments`. Given `docs/app-audit.md` already records that only ~20%
  of tables have explicit RLS and the API uses a service-role client that
  bypasses RLS, absent policies are not currently the only guard — but they are
  declared controls that do not exist.
- **Five geo indexes are missing.** `docs/algorithm/signal-audit.md` §2 rates
  Location/Trip Relevance at 20% of the Portava Score; those queries are
  running unindexed.

---

## 3. Category C — LIVE-AHEAD, EXPLAINED (1 object group)

**`rank_events` — fully explained, and a correction to my own earlier claim.**

`docs/algorithm/signal-audit.md` §10d reported the live CHECK constraints as
wider than any migration file and flagged it as ungoverned drift of the same
class as finding 16. **That was wrong.** Migration
`0197_rank_events_analytics_columns.sql` declares every one of the differences:

| Object | Live | Declared by |
|---|---|---|
| `outcome` CHECK — 7 values incl. `analytics` | ✅ | 0197 |
| `surface` CHECK — 11 values | ✅ | 0197 |
| `event_type`, `content_type` columns | ✅ present | 0197 |
| `item_kind`, `position` nullable | ✅ nullable | 0197 |

Live matches 0197 exactly. The migration was applied; I had read only 0153 and
0154 and inferred drift from their absence of these values. **No governance
issue exists here.** §10d is corrected in that document.

The lesson cuts both ways: reading migration files instead of live schema
produced the original error, and reading *some* migration files instead of all
of them produced the false alarm.

---

## 4. Category D — UNDETERMINED

Cannot be categorised from available evidence. Listed rather than guessed.

1. **Were the 13 category-B objects skipped deliberately or missed?** Nothing
   records a decision either way. `docs/migrations.md` marks rows "applied"
   that demonstrably are not — the memory note already warns that those rows
   lie. Determining intent needs a human who was present.
2. **Is `post_event_links` abandoned or pending?** The migration is dated
   `20260731`. No code was traced to it in this pass.
3. **`hashtags.normalized_name`** — allowlisted as absent; live has `slug`
   described in migration 0043 as "lowercase-normalized". Functionally
   equivalent, but whether `slug` was *intended* as the rename or the two are
   separate concepts is not determinable from the files.
4. **`canonical_place_id` is 100% NULL** on both `posts` and `post_media`
   (evidence in `docs/design/tagging-directions.md` §8c), while
   `location_place_id` carries real data. Schema present, data absent. Whether
   the column is abandoned, awaiting backfill, or newly added is unknown — and
   `2044_hidden_gems_canonical_place_id.sql` adds a *further* canonical-place
   index that is also missing (§2). Something in this area is half-built.
5. **`geofence_admin_settings` has duplicate column families** — live has
   `default_radius_meters`, `min_radius_meters`, `max_radius_meters` **and**
   `default_radius_m`, `min_radius_m`, `max_radius_m`. Which is canonical, and
   whether either is written, was not determined.
6. **`passport_visibility_preferences` and `trip_crew_location_preferences`
   both carry layered near-duplicates** (`stamps_visible` alongside
   `default_stamp_visibility`; `visibility_default` alongside
   `default_visibility`). Same question, same non-answer.

---

## 5. Decision-ready — nothing acted on

Per the standing rule, these change production schema or migration ownership
and are returned rather than executed.

1. **13 declared objects do not exist live** (§2). Apply, or formally abandon
   and delete the migrations. The current state — declared, absent, uncatalogued
   — is the exact condition that produced findings 9, 10, 13 and 16.
2. **Three missing RLS policies** (§2) should be triaged ahead of the indexes;
   they are declared security controls.
3. **The allowlist has a defect** (§1): `plan_attendance_events.metadata` is
   suppressed but exists. Removing the entry restores a real check.
4. **`docs/migrations.md` "applied" rows are not trustworthy** and this audit
   demonstrates it again. Whether that file should remain the record of truth,
   or be regenerated from `audit:schema`, is an ownership decision.
5. **Six UNDETERMINED items** (§4) need someone with history, not more queries.

## 6. Verification note

- `audit:schema` output is reproduced as run; it applies the repo's own
  allowlist and skip-list, so the 13 are net of known-and-accepted divergences.
- Every category-A column was independently verified against
  `information_schema.columns`, not taken from the allowlist comments — which is
  how the `plan_attendance_events.metadata` defect surfaced.
- The category-C correction was verified by reading `0197` in full and
  comparing all four of its claims against live.
- **Not verified:** live objects that no migration declares. The audit is
  one-directional by construction (§0).
