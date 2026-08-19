# PORTAVA MIGRATION-TREE RECONCILIATION PACKET

**Status:** proposal for review. Nothing has been applied, nothing in the repository was modified, and no database was contacted.
**Prepared:** 2026-08-18 · **Repo root:** `/Users/areyouok/portava-sandbox/Portava-Manager`
**Canonical tree:** `artifacts/api-server/src/migrations` (283 files)

**How to read this.** §1, §5, §6 and §8 are for the owner and carry the decision. §2, §3, §4, §7 and §9 are for the engineer who implements it. Every live-state claim in this document reads `UNKNOWN-PENDING-LIVE (Qn)` and names the query in §4.1 that resolves it — because there is no database access here and none was sought.

---

## 1. BOTTOM LINE

**What is broken.** Production's schema is a *merge* of at least three migration trees that were each applied at different times, and no single tree describes it — proven by column evidence, not inference: live `geo_zones` carries `bounds_json`, which appears in exactly one file in the entire repository (`artifacts/api-server/migrations/0034_geo_zones.sql:14`, verified), *and* `polygon_geojson`, which appears only in the canonical and repo-root trees; live `plan_geofences` carries `check_in_radius_m` (only `artifacts/api-server/migrations/0035_plan_geofences.sql:11`) *and* `zone_id` (only canonical and repo-root). Because the canonical tree is therefore a partial and in places *wrong* description of production, roughly a quarter of the schema cannot be audited in either direction.

**What this packet fixes.** It stops the bleeding mechanically (a hash-pinned freeze across every non-canonical SQL location, closing the modification and deletion blindness in the guard that exists today), it replaces the unauditable pre-history with one artifact read from the database itself (a versioned, execution-forbidden baseline), it adds the missing reverse direction to the auditor (live objects nobody declares), it forces every public table to carry a written RLS disposition, and it specifies 19 forward-only corrective migrations — three of which address what look like **open live defects**, not merely drift.

**What it does not fix.** It does not stop a human pasting SQL into the Supabase SQL editor, which is how migrations are actually applied in this project and is outside every mechanism in this repository. It does not recover the true history of what ran; the baseline replaces that history rather than reconstructing it. It does not, and cannot, tell you the current state of a single live object.

**What it needs from the owner that no agent can do.** Two things, and both gate everything else: **the baseline capture** (§5.1) and **the clean-build proof** (§6.6), each of which requires database access that this session does not have and must not seek — the local credentials point at production. Until the baseline exists, the manifest's live-state column stays empty, the reverse auditor is meaningless, and 13 of the 19 forward migrations cannot responsibly be written. **This is the gating dependency, not a footnote.**

---

## 2. THE ROOTS

### 2.1 Measured subject, and a correction to the brief's framing

`git ls-files '*.sql'` → **474 tracked `.sql` files**, in **19 directories literally named `migrations`** plus 6 other SQL-bearing locations (verified). The brief's 480/30 counts untracked material — `_incoming/` (gitignored at `.gitignore:87`), `recovery-backups/`, `.recovery/`. **A CI guard can only act on tracked files, so 474 is the enforceable number**, and using `git ls-files` as the enumerator puts gitignored working material out of scope by definition rather than by omission.

The arithmetic that matters:

```
283  canonical                              (stays open)
175  in 20 frozen directory roots           (18 migrations-dirs + docs/sql + portava-ai-header-generation)
 16  loose .sql files in no root at all     (11 at repo root + 5 scattered)
────
474  tracked .sql
```

**"19 roots" and "191 files" are not the same set, and treating them as one is how three declaration sources get missed.** 19 is the count of directories named `migrations` — one of which is canonical, so **18** freeze. 191 is the count of non-canonical files, which needs **20 directory roots plus 16 individually-pinned loose files** to cover. A directory-based freeze cannot satisfy ruling 2.

### 2.2 The three sources a directory rule misses

| source | why it matters |
|---|---|
| `artifacts/api-server/migration.sql` | The **only** file declaring `profiles.username / display_name / passport_visibility / username_updated_at` — all live. Also carries a third `user_follows` policy family (`:59-67`), a fourth `profiles` family (`:71-80`), and a third `passport_postcards` family (`:84-97`) — **all verified present**. |
| `docs/sql/` — 13 files | Each is a "paste into the Supabase SQL Editor" runbook. Declares a third policy family across the interaction/safety cluster. Executable by a human at any moment. |
| 16 loose files | `0160_beta_field_passthrough.sql`, `0177_`–`0185_` (nine), `CHECK-upsert_city_stamp-RPC.sql`, plus `artifacts/api-server/scripts/2080-rollback.sql`, `audit-closeout/sql/optional-drop-dead-buddy-tables.sql`, `qa2fix-r2/diagnostics.sql`, `scripts/probe-full-name.sql`, and `migration.sql` above. Numbered like migrations, in no tree, under no guard. |

### 2.3 Disposition table

**Inert** means: no script, workflow, `package.json`, `.replit` entry or shell file in this repository executes it. I grepped every `*.json`, `*.yml`, `*.sh`, `*.mjs`, `*.ts`, `*.js` and `.replit` for each non-canonical root path and found **zero executable references** — only prose. Inert here means *inert to CI*, not inert to a human with the Supabase SQL editor open.

| # | path | files | executable? | evidence / hazard | disposition |
|---|---|---|---|---|---|
| — | **`artifacts/api-server/src/migrations`** | **283** | yes — the only one | `package.json:13,14,16` read it | **CANONICAL — stays open** |
| 1 | `artifacts/api-server/migrations` | 71 | inert to CI | Sole source of live `bounds_json` (`0034:14`) and `check_in_radius_m` (`0035:11`); `0038` is the RLS hardening canonical never got | already guarded (name-only) → **upgrade to hash** |
| 2 | `migrations` | 34 | inert to CI | Sole creator of the spine: `profiles` (`0001_spine.sql:29`), `trips` (`:72`), `trip_members` (`:100`), `messages`, `message_threads` | already guarded (name-only) → **upgrade to hash** |
| 3 | `supabase/migrations` | 14 | **replayable by `supabase db push`** | `supabase/README.md:32-38`; sole creator of 6 stamp tables and `enforce_is_official_service_role()` | **FREEZE — ruling 2** |
| 4 | `docs/sql` | 13 | **human-executable by design** | Each file is a paste-into-SQL-editor runbook; 4th `pulse_geo_tags` policy family | **FREEZE** |
| 5 | `artifacts/api-server/supabase/migrations` | 12 | **replayable by `supabase db push`** | Sole creator of `viewer_creator_fatigue` (`20260801_ranking_discovery_foundation.sql:114`), which canonical `2058` alters | **FREEZE — ruling 2** |
| 6 | `files/artifacts/api-server/src/migrations` | 6 | inert | Shadow copy of a canonical path prefix | **FREEZE** |
| 7 | `docs/migrations` | 5 | inert | Sole creator of the entire `events` family (`0065_events.sql:33` + 6 sub-tables) and `memories` (`0067:7`) | **FREEZE** |
| 8 | `db/migrations` | 4 | inert | Only in-repo file matching the recorded live `user_location_state` column names (`0025_location_system.sql:13-16`); sole `recent_places` declaration | **FREEZE** |
| 9 | `travel-buddy-standalone/migrations` | 3 | inert | Duplicate `can_see_trip` body | **FREEZE** |
| 10 | `portava-stamp-wave1-files/…/src/migrations` | 2 | inert | Staged drop bundle | **FREEZE** |
| 11 | `portava-ai-header-generation` | 2 | **`apply.py` writes into canonical** | See §2.4 — the one active hazard in the list | **FREEZE + neutralize** |
| 12 | `stamps-backend/migrations` | 1 | inert; **APPLY.md names the prod project ref** | Duplicate `upsert_city_stamp` | **FREEZE** |
| 13 | `posts-backend/migrations` | 1 | inert; APPLY doc | **Sole creator of `public.posts` (`0003_posts.sql:36`), its RLS enable (`:123`) and all four policies — verified: canonical declares zero policies on `posts`** | **FREEZE** |
| 14 | `passport-backend/migrations` | 1 | inert; **APPLY.md:13 carries prod ref `ajrurzioarfkagpuxfnb`** | Sole creator of `passport_postcards` | **FREEZE** |
| 15 | `friends-backend/migrations` | 1 | inert; APPLY doc | Sole creator of `user_friendships`, `friend_requests` | **FREEZE** |
| 16 | `follows-backend/migrations` | 1 | inert; **APPLY.md:9 carries prod ref** | Sole creator of `user_follows` | **FREEZE** |
| 17 | `composer-pkg/migrations` | 1 | inert; **APPLY.md:8 carries prod ref** | 4 `storage.objects` policies that may be defeating canonical `2089`'s revoke | **FREEZE** |
| 18 | `portava-stamp-wave2-files/…` | 1 | inert | Staged drop | **FREEZE** |
| 19 | `portava-stamp-wave3-files/…` | 1 | inert | Staged drop | **FREEZE** |
| 20 | `portava-ai-header-generation/files/api-server/src/migrations` | 1 | **copied into canonical by `apply.py`** | §2.4 | **FREEZE + neutralize** |
| — | 16 loose files | 16 | mixed | §2.2 | **LOOSE_SQL ledger — pin individually, one written disposition each** |
| — | `artifacts/api-server/baseline/` (new) | — | must never run | §5 | **FREEZE, `executionForbidden`** |

### 2.4 The one root that is not inert

`portava-ai-header-generation/apply.py:19-31` walks `files/` and copies each entry into `~/workspace/artifacts/…` (verified by direct read). That lands `files/api-server/src/migrations/0189_generated_visuals.sql` at `artifacts/api-server/src/migrations/0189_generated_visuals.sql` — **where canonical already holds a different `0189_globe_trotter_stamp_definitions.sql`.** The bundle's migration actually shipped as canonical `0194_generated_visuals.sql`, byte-identical, so the drop is superseded. Running `apply.py` today would inject a duplicate under a stale prefix, break `check:migration-prefixes` (`ci.yml:178-181`), and then `apply.py:75` and the bundle's `README.md:31-34` would instruct an operator to run the result against production. The bundle also ships `flip-flags.sql`.

**Freezing the SQL is not sufficient here.** Add an assertion that `apply.py` writes nothing into `artifacts/api-server/src/migrations/`.

---

## 3. WHAT CANNOT BE AUDITED TODAY, AND WHY

### 3.1 The proof that live is a merge

| column | appears in | appears in | live |
|---|---|---|---|
| `geo_zones.bounds_json` | `artifacts/api-server/migrations/0034_geo_zones.sql:14` — **the only occurrence repo-wide (verified)** | — | present |
| `geo_zones.polygon_geojson` | `artifacts/api-server/src/migrations/0034_geo_zones.sql` | `migrations/0034_geo_zones.sql` | present |
| `plan_geofences.check_in_radius_m` | `artifacts/api-server/migrations/0035_plan_geofences.sql:11` — **only occurrence (verified)** | — | present |
| `plan_geofences.zone_id` | canonical `0035:12` | `migrations/0035` | present |

Two disjoint file sets each contributed columns to the same live table. `CREATE TABLE IF NOT EXISTS` cannot add a column to an existing table, and there is **no `ALTER … ADD COLUMN` anywhere in the repository** that adds these. So the live shape was not produced by replaying repository files in any order. **No single tree describes production, and the canonical tree — the one the auditor reads — describes it least completely of the three.**

### 3.2 The five structural consequences

**(a) 97 of the 273 canonical-created tables are ALSO created by a frozen root.** For each, whichever tree ran first defines the live shape and the other's `IF NOT EXISTS` did nothing — so every column difference is live drift the canonical tree cannot see. `docs/migrations.md:708` records this happening for real to `rent_buddy_availability`. **This is the mechanical generator of the "a quarter of the schema cannot be audited" problem.**

**(b) The canonical chain modifies 36 relations it never creates.** `profiles` (156 references, 17 `ADD COLUMN`, RLS enabled at `0195_rls_privacy_baseline.sql:24`) is created only at `migrations/0001_spine.sql:29`. `posts` (44 references) only at `posts-backend/migrations/0003_posts.sql:36`. The whole `events` family only at `docs/migrations/0065_events.sql`. A clean rebuild from canonical alone cannot work, and this is why ruling 4's baseline must carry the spine.

**(c) `public.posts` RLS lives in exactly one file, outside every audited tree.** Verified: zero `create table posts` and zero `alter table posts enable row level security` in any canonical file; zero canonical policies on `posts`. The table (`0003_posts.sql:36`), the enable (`:123`) and all four policies are in `posts-backend/`. Canonical maintains only the *predicate functions* (`0200_backfill_unrecorded_live_objects.sql:65,84,97`), pins their `search_path` (`0201:21`), and attests the policies are live (`0200:53-58`). **Every read-path protection on the most-queried table in the product rests on a file no guard covers and no audit reads.**

**(d) Eight statements in canonical cannot ever have run.** `CREATE TYPE IF NOT EXISTS` is not valid PostgreSQL in any released version — the repo already knows this (`.agents/memory/supabase-migration-access.md:32`). Verified, all eight, each the **first executable statement of its file**, so none of these six files applied as written:

```
0026_highlights.sql:4            0033_location_sessions.sql:4
0032_location_preferences.sql:4  0034_geo_zones.sql:4      → geo_zone_type
0032_location_preferences.sql:8  0035_plan_geofences.sql:4 → geofence_trigger_type
0036_pulse_geo_tags.sql:4        0036_pulse_geo_tags.sql:8
```

Corroborated independently: `0131_location_mode_check_update.sql:4-8` drops a CHECK constraint that only the `text` variant of `location_preferences` can carry — so the repo-root file applied and the canonical file did not. **The canonical tree's description of `geo_zones.zone_type` and `plan_geofences.trigger_type` as enums is false about production.**

**(e) One reference dangles with no provenance at all.** `artifacts/api-server/src/migrations/0058_trip_flow.sql:13` declares `circle_id uuid NULL REFERENCES circles(id) ON DELETE SET NULL` (verified). **No `.sql` file anywhere in this repository creates `circles`** (verified). A clean rebuild aborts at that line today. This single fact is why requirement 9 cannot pass on canonical alone even in principle.

### 3.3 The auditor is one-directional by construction

`artifacts/api-server/src/scripts/auditMigrationsVsLive.ts` (837 lines, wired at `.github/workflows/live-db.yml:427-430`) reads `MIGRATION_DIRS = [canonical]` (`:75`) and consumes every live inventory only via `.has()`. It can answer *"is repo claim X present live"* and nothing else. Seven silences follow, of which four are load-bearing:

- **Unparsed ⟹ silent.** 53 of 283 canonical files contain none of the recognised constructs; the auditor reports the same thing for "declares nothing" and "declares something I failed to parse."
- **`DROP` and `REVOKE` unmodelled** — the script says so at `:241-247`. 68 of 283 canonical files contain a top-level one.
- **Functions name-only** (`:709-712`) — overloads collapse; `prosecdef`/`proconfig` never read, so `0201`'s entire subject (pinned `search_path` on live RLS predicates) is invisible.
- **Policies name-only** — `USING`/`WITH CHECK` never compared. A live policy with a *different predicate* reads as present. This is exactly the hole §7's 2100 exists to close.

And **125 distinct table names are created somewhere in the repo and never in canonical** — including `posts`, `profiles`, `trips`, `messages`, `events` — so they are checked in neither direction.

### 3.4 Three candidate live defects, not drift

These may be open in production right now. They are the reason §8 puts four queries ahead of everything else.

1. **`plan_geofences` — a policy hardening that may have been silently defeated.** Canonical `0035:21-28` creates `trip_members_manage_geofences` **`FOR ALL`** with an *unfiltered* `trip_members` join (verified by direct read). Legacy `0038_plan_geofences_rls_fix.sql` was written specifically to stop invited/pending members reading stored `lat`/`lng` — but it only drops `pgf_select_member` (`:15`), a name canonical never used. **RLS policies OR together.** If both families are live, 0038's hardening is defeated *and* canonical's `FOR ALL` additionally grants **writes** to the same class of user.
2. **`user_follows` and `profiles` — public-read policies nothing drops.** `artifacts/api-server/migration.sql:60` (`"Follows are viewable by authenticated users"`) and `:72` (`"Public profiles are viewable"`) are created with `USING (true)`. Verified: **no file anywhere drops those names.** Canonical `2033_rls_hardening.sql:485,518-522` drops different names and believes it closed the surface.
3. **`plan_checkins` / `plan_attendance_events` — possible write-path outage.** Two roots each declare a differently-named `NOT NULL` FK column (`geofence_id` vs `plan_geofence_id`). If both survived the merge, **no row is insertable.**

A fourth, cheap and high-value: **four tables have no `ENABLE ROW LEVEL SECURITY` in any tree** — `content_translations`, `portava_featured`, `post_impressions`, `weather_cache` (verified: zero matches repo-wide) — on a project whose mobile app ships the anon key (`2070_rls_hardening.sql:4`).

---

## 4. THE MANIFEST

### 4.1 The query catalogue

Nothing moves off `UNKNOWN-PENDING-LIVE` except one of these. All are read-only `SELECT`s, all run through the existing production read-only door (`artifacts/api-server/src/lib/ciProdReadOnlyAuditGuard.mjs`, imported first as `auditMigrationsVsLive.ts:64` does). **None may be run from this sandbox.**

| id | resolves | key detail |
|---|---|---|
| Q1 | relation census + RLS flag | `pg_class.relkind, relrowsecurity`; schemas `public`, `storage` |
| Q2 | column shape | type, nullability, default — `information_schema.columns` |
| Q3 | policies **with predicates** | `pg_get_expr(polqual)`, `pg_get_expr(polwithcheck)`, roles — the name-only hole |
| Q4 | functions | keyed by `pg_get_function_identity_arguments`, plus `prosecdef`, `proconfig`; extension-owned excluded via `pg_depend.deptype='e'` |
| Q5 | enum types + labels | settles whether `geo_zone_type` / `geofence_trigger_type` exist at all |
| Q6 | constraints | incl. `convalidated` |
| Q7 | indexes | |
| Q8 | triggers | non-internal only |
| Q9 | table grants | |
| Q10 | **column** grants | required by `REVOKE SELECT (lat,lng) ON user_stamps` (`0081:234,235`) |
| Q11 | routine EXECUTE grants | |
| Q12 | extensions | required — `gen_random_bytes()` at `0080_events_extension.sql:341` needs `pgcrypto`, which no canonical file installs |
| Q13 | `feature_flags` values | seed conflicts |

Full SQL text for each is in the engineering appendix of the implementation ticket; the shapes above are what the manifest's `live_query` field references.

### 4.2 Record schema

Location: **`artifacts/api-server/reconciliation/manifest.json`** — deliberately *not* under `src/migrations/`, which both `checkMigrationPrefixes.ts:25` and `auditMigrationsVsLive.ts:75` read; anything placed there is parsed as claims and would be replayed by an operator. Not under `baseline/` either: the manifest is a living document, the baseline is immutable.

```jsonc
{
  "key":   "policy:public.plan_geofences.trip_members_manage_geofences",
  "class": "DISJOINT_POLICY_FAMILY",
  "canonical_declaration": "artifacts/api-server/src/migrations/0035_plan_geofences.sql:21",
  "legacy_provenance": [
    { "root": "artifacts/api-server/migrations", "at": ".../0038_plan_geofences_rls_fix.sql:19" },
    { "root": "migrations",                      "at": "migrations/0035_plan_geofences.sql:22" }
  ],
  "live_state":  "UNKNOWN-PENDING-LIVE",
  "live_query":  "Q3",
  "intended_final_state": "Single SELECT policy pgf_select_accepted (accepted members only); writes restricted to trip owner + role='member'. Canonical FOR ALL policy removed.",
  "corrective_migration": "2100_plan_geofences_policy_convergence.sql",
  "blocked_on":  ["Q3"],
  "reviewed_on": null,
  "reviewer":    null
}
```

`class` ∈ `MERGED_LIVE_SHAPE` · `SPINE_UNDECLARED` · `DANGLING_REFERENCE` · `UNEXPLAINED_LIVE` · `INVALID_CANONICAL_DDL` · `DISJOINT_POLICY_FAMILY` · `DUPLICATE_CONCEPT` · `OBJECT_KIND_CONFLICT` · `RLS_UNDISPOSED` · `SEED_VALUE_CONFLICT`.

**Mechanical validation** (`reconciliation:check`, credential-free, wired beside `check:frozen-dir` at `.github/workflows/ci.yml:165-168`):

- every `canonical_declaration` and `legacy_provenance.at` must resolve to an existing file at a non-blank line;
- `live_state == "UNKNOWN-PENDING-LIVE"` ⟹ `live_query` present and in the catalogue;
- **`corrective_migration` naming a file ⟹ that file exists in canonical AND sorts `>= "2100"`** — this is ruling 6 made mechanical;
- **vacuity is failure**, borrowing the rule verbatim from `artifacts/api-server/scripts/check-guard-coverage.mjs:44-56`: an empty manifest, an empty `intended_final_state`, or zero records in a declared class → non-zero exit.

**Scope discipline.** The manifest covers only what cannot currently be audited. The ~273 canonical tables created, RLS'd, policied and indexed entirely within canonical are **not** manifest rows — including them would make it a second copy of the schema and destroy its signal.

### 4.3 Sample rows, by class

The full manifest is ~184 rows. These are the ones that carry the argument.

**MERGED_LIVE_SHAPE (27)** — live is a union no file produces.

| object | canonical | legacy | live | intended | corrective |
|---|---|---|---|---|---|
| `column:geo_zones.zone_type` | `0034:11` — `geo_zone_type` **enum**, in a file whose first statement is invalid | legacy `0034:9` `TEXT`; root `0034:7-8` `text` + CHECK | UNKNOWN (Q2,Q5) — **prediction: `text`, enum absent** | `text` + validated CHECK over union vocabulary | **2104** |
| `column:geo_zones.bounds_json` | NONE | legacy `0034:14` — only file repo-wide | present (established) | adopt | baseline adoption |
| `column:plan_geofences.check_in_radius_m` | NONE | legacy `0035:11` — only file repo-wide | present (established) | adopt | baseline adoption |
| `table:plan_checkins` — dual FK | canonical `plan_item_id` | legacy `geofence_id`; root `plan_geofence_id` | UNKNOWN (Q2,Q6) — **if both `NOT NULL`, inserts are impossible** | one FK; other nullable + deprecated | **2102** |
| `table:geofence_admin_settings` | `*_radius` (not live) | legacy `*_radius_m`; root `*_radius_meters` | UNKNOWN (Q2) | `*_m` canonical; `*_meters` backfilled, nullable, deprecated | **2103** |
| `location_preferences` **vs** `user_location_preferences` | canonical `0032` (invalid DDL) | root `0032` `text`+CHECK; **legacy `0032:5` creates a separate table with the same nine columns** | UNKNOWN (Q1,Q2) — `0131:4-8` proves root applied | one table; other deprecated | **2110** |
| `table:place_profiles` | **NONE — canonical never mentions it** | legacy `0034:41` | UNKNOWN (Q1) | adopt | baseline adoption |

**SPINE_UNDECLARED (36)** — modified by canonical, created only in a frozen root. All: live `UNKNOWN (Q1,Q2)`, intended *adopted into baseline, cited to the frozen file as provenance*, corrective `NONE NEEDED — baseline adoption`.

`profiles` (156 refs) · `trips` (51) · `posts` (44) · `events` (40) · `messages` (13) · `rent_buddy_profiles` (13) · `user_follows` (9) · `trip_members` (7) · `passport_postcards` (6) · `user_friendships` (6) · `memories` (5) · `rent_buddy_bookings` (4) · `message_threads` (3) · `profile_views` (3) · `friend_requests` · `message_thread_members` · `city_country_geocode_cache` · `meetups` · `meetup_time_options` · `message_requests` · 5 more `rent_buddy_*` · `memory_likes` · 6 event sub-tables · `storage.objects` (9 policies) · `auth.users` (67 FK targets).

**One exception:** **`viewer_creator_fatigue`** → corrective **2106**. Freezing `artifacts/api-server/supabase/migrations` without adopting it leaves canonical `2058` permanently orphaned — a canonical migration altering a table that no live-writable file declares.

**DANGLING_REFERENCE (1)** — `table:public.circles`. Canonical: NONE; referenced as an FK target at `0058_trip_flow.sql:13`. Legacy: **NONE — nothing in the repository creates it.** Live: UNKNOWN (**Q1 — highest-priority existence check**). Corrective **2105**, branch selected by Q1.

**UNEXPLAINED_LIVE (25)** — ruling 7's reverse direction. `circles`, `compass_analytics`, `public_profile_verification`, `user_trust_scores`; `profiles.role` — which canonical `2078_profiles_role_not_self_writable.sql:28-30` **states in-repo** appears in no migration file and predates this work; 17 further undeclared `profiles` columns; `post_impressions.created_at`; `post_saves.id`.

The sharpest row: `profiles.{username, display_name, passport_visibility, cover_photo_url, username_updated_at}` are declared only in `artifacts/api-server/migration.sql:7-13`, a **6-column atomic `ALTER TABLE … ADD COLUMN`** of which 5 are live and `updated_by` is not. A multi-column `ALTER` cannot half-apply. **The committed file is therefore not the text that ran** — which is the packet's clearest proof that repo assertions of "applied" cannot be trusted.

**INVALID_CANONICAL_DDL (8)** — §3.2(d). Intended final state: **the files stay untouched** (rulings 3 and 6). They are pre-cutover, so the clean build never replays them. The manifest records them `NEVER_APPLIED`; the corrective for their *semantic* content is **2104** where a live gap exists, `NONE NEEDED` otherwise.

**DISJOINT_POLICY_FAMILY (12 relations + 5 orphan DROP targets)** — policy names are the identity `DROP POLICY` uses, so disjoint families coexist and OR together. `plan_geofences` → **2100** · `user_follows`, `profiles`, `passport_postcards` → **2101** · `feature_flags` → **2114** · `storage.objects` post-media → **2116** · `pulse_geo_tags` (four families) → **2117** · `passport_stamps`, `trip_crew_location_sessions`, `discovery_places`, `user_privacy_settings` → **2118** · `public.posts` → **baseline adoption**, the canonical example of a row that the baseline rather than a migration resolves.

Separately, **five `DROP POLICY` statements target names no root ever creates** — `cmp_public_read` (`0108:308`), `event_updates_public_read` (`2033:396`), two post-media names (`20260815_close_memories_stories_grant.sql:79-80`), `locpriv_all` (root `0002:127`). These were written against live state observed out-of-band and are therefore *evidence of undocumented live policies*. Each becomes a ledger entry once Q3 returns.

**SEED_VALUE_CONFLICT (1)** — `feature_flags.trip_crew_ghost_mode_enabled`. Verified: **`false`** at canonical `0037:41`, canonical `0041:65`, root `0041:83`; **`true`** at legacy `0041:132` and legacy `20260702_crew_location_flags_reseed.sql:10`. Five unordered writes, last-writer-wins, live value presently unknowable from files. → **2111**.

**RLS_UNDISPOSED (51)** — §5.4.

**OBJECT_KIND_CONFLICT (1)** — `buddy_bookings` is a base table at `0050_rent_a_buddy.sql:112` and a view at `0147_buddy_bookings_compat_view.sql:23` (guarded to skip when a real table exists, `:16-20`). On a canonical-only replay 0050 wins and the view silently never materialises. → **2113**.

### 4.4 Totals

| class | rows |
|---|---|
| MERGED_LIVE_SHAPE | 27 |
| SPINE_UNDECLARED | 36 |
| UNEXPLAINED_LIVE | 25 |
| undeclared functions / types | 17 |
| DISJOINT_POLICY_FAMILY | 12 (+5 orphan DROP targets) |
| INVALID_CANONICAL_DDL | 8 |
| DANGLING_REFERENCE / OBJECT_KIND_CONFLICT / SEED_VALUE_CONFLICT | 1 each |
| RLS_UNDISPOSED | 51 |
| **total** | **~184** |

Against a live schema of several hundred relations, that is the audit-blocked set — not a copy of the schema.

---

## 5. THE PLAN

Ordered by dependency. **OWNER-ONLY** steps need database access this session does not have and must not seek.

### Step 1 — Extend `check:frozen-dir` · AGENT-EXECUTABLE · no prerequisites

Do this first: it is the only step with zero dependencies, needs no credentials, and closes rulings 2, 3 and 6 mechanically.

`artifacts/api-server/src/scripts/checkFrozenDir.ts` already exists, is wired in three places, and has two declared single-source-of-truth manifests. **Extend it — do not build a second mechanism.** Four defects, all verified by direct read:

| defect | evidence | consequence |
|---|---|---|
| Coverage 2 of 20 | two hardcoded `resolve()` calls | 105 of 474 files guarded |
| **Name-only ⟹ modification-blind** | `entries.filter(f => !frozenSet.has(f))` on a bare filename | **Editing the contents of a frozen historical migration passes green today.** Rulings 3 and 6 forbid rewriting history; nothing can detect a rewrite. |
| **Deletion- and absence-blind** | the filter runs over directory entries, never the frozen set; `catch { return [] }` | Deleting a file is invisible; **deleting an entire frozen root prints `PASSED`.** |
| Path-hardcoded, directory-scoped | — | A 20th root is invisible; the 16 loose files are unreachable by any directory rule |

**The extension:**

1. **One declarative table** — new `src/scripts/frozenRoots.ts`: `{ path, label, frozenOn, manifest: Map<filename, sha256>, mustExist: true, executionForbidden?: true }`. Upgrade `frozenLegacyFiles.ts` and `frozenRootFiles.ts` **in place** from `Set<string>` to `Map<string, sha256>` — their own headers forbid a parallel structure.
2. **Four verdicts replacing one:** `ROGUE` (on disk, not in manifest — existing behaviour) · **`MODIFIED`** (sha differs) · **`DELETED`** (in manifest, absent) · **`ABSENT ROOT`** (`mustExist` and directory missing).
3. **The anti-vacuity sweep — what makes "20" not a magic number.** After the per-root pass, enumerate **every tracked `.sql` via `git ls-files`** and classify each as `CANONICAL`, a declared frozen root, `LOOSE_SQL`, or `BASELINE`. **Anything unclassified fails.** A 20th root then cannot be created without a diff to `frozenRoots.ts`. If `git` is unavailable, **exit non-zero** — never fall back to a filesystem walk that silently changes the subject (`.github/workflows/ci.yml:16-18`: a step that cannot establish its result FAILS).
4. **Vacuity is failure** per `check-guard-coverage.mjs:44-56`.
5. **The reference assertion.** Fail on any non-comment reference from an executable file to a frozen root path — keeping the property I measured true by enforcement rather than by luck.
6. **Neutralize `apply.py`** per §2.4.
7. **Close the prefix band.** Add to `checkMigrationPrefixes.ts`: after cutover, any new canonical filename must match `^2[1-9]\d{2}_`. Reserve `2096`–`2099` as an unusable buffer. **Without this the cutover line silently breaks** — see §5.1.

**No new CI surface is required.** All enforcement points already invoke the script by name: `artifacts/api-server/package.json:14`, `.github/workflows/ci.yml:165-168`, `artifacts/api-server/scripts/run-all-checks.sh:122`, and a second independent copy inside the audit's own startup path (`auditMigrationsVsLive.ts:94-116`) so `audit:schema` refuses to start against a tampered frozen dir. Extend that copy in lockstep. `.github/scripts/assert-ci-scripts.mjs:9-19` already derives every `(dir, package, script)` triple from workflow text and fails before install if one is missing.

**CODEOWNERS.** `.github/CODEOWNERS:19-21` already covers the guard files under the stated rationale *"the guards cannot guard themselves"* (verified). A quiet edit to a **hash manifest** is exactly that case. Add `frozenRoots.ts`, `frozenLegacyFiles.ts`, `frozenRootFiles.ts`, `baseline/MANIFEST.json`, `reconciliation/manifest.json`.

**On the two Supabase roots specifically.** Hash-freezing them is necessary but is **not what protects them**, and the packet should not imply otherwise: a frozen file list does not stop `supabase db push` from replaying all 14 files (`supabase/README.md:32-38`). What actually protects them already exists in the same guard family — `assert-ci-scripts.mjs` fails CI on any `supabase` CLI invocation under `.github/`, and `assert-nonprod-supabase.sh` fails if the CLI is on `PATH`, if a `linked-project.json` exists, or if any `config.toml` declares a `project_id`. **Verified: no `config.toml` exists anywhere in the repo.** So the freeze here is: pin the 26 files, add READMEs, and add one assertion to the existing family — **neither Supabase root may acquire a `config.toml` or a `.temp/` directory.**

### Step 2 — Run the four priority queries · **OWNER-ONLY**

§3.4, in that order. These are candidate live defects, and three of them may be open today. Everything downstream is cheaper once they return; nothing downstream is *correct* without them.

### Step 3 — Capture the baseline · **OWNER-ONLY** · §6

Sets `CUTOVER_PREFIX = "2100"`.

### Step 4 — Fill the manifest's live-state column · AGENT-EXECUTABLE once §6 census exists

Every `UNKNOWN-PENDING-LIVE` either resolves against the census CSVs or gets an explicit written reason it could not.

### Step 5 — Build `audit:live-unexplained` · AGENT-EXECUTABLE · requires Step 3

New script `src/scripts/auditLiveVsCanonical.ts` — a separate script, not a flag on the existing one, for three reasons: the current exit contract (0/1/2) is consumed literally at `live-db.yml:424-430`; the existing allowlist means "declared-but-absent" and would become ambiguous; and the inverse check is meaningless before the baseline exists while `audit:schema` runs today.

**The model is NOT the canonical tree.** This is the load-bearing decision:

```
MODEL = baseline_schema ∪ canonical files sorting >= "2100" ∪ EXPLAINED ledger
```

If the model were the canonical tree alone, run one would report ~125 tables — `posts`, `profiles`, `trips` — as "unexplained." Every line would be a true statement about the tree and useless as a signal, and **a permanently-red check is one discarded exit code away from being no check at all** (`run-all-checks.sh:128-142`). **Requirement 4 must land before requirement 7 is switched on.**

It enumerates ten inventories (relations, columns, functions, RLS+policies, triggers, grants, enums, indexes, constraints, extensions) and errors on anything live that the MODEL does not explain. Three closures matter: **functions keyed by identity arguments** closes the overload hole at `:709-712`; **policies compared by predicate** closes the name-only hole; **grants compared as exact sets — excess privilege is an error** closes the hole `auditShadowAppendOnly.ts:6-20` already wrote up. **Constraints are unmodelled today in both directions** and are exactly where a clean-build proof will otherwise diverge silently.

Exit contract: `0` clean · `1` unexplained objects found · `2` could not establish a result. **An unrunnable inverse audit exits 2, never 0.**

**The EXPLAINED ledger** — `src/scripts/explainedLiveObjects.ts`, in source, in one file, where a diff shows it. Each entry carries `key`, `kind`, `provenance` (file:line of whatever *actually* created it, **including frozen roots** — this is requirement 5's legacy-provenance column, and the ledger is the only place a frozen root may be cited as authority; **citing a frozen root is allowed, replaying it is not**), `disposition`, `reason`, `reviewed_on`, and conditionally `corrective_migration` / `deep_verifier`. Rules, all mechanically checked and all taken from `check-guard-coverage.mjs` rather than invented: vacuity is failure; **every entry must be reachable** — an entry naming an object the live sweep does not see is a failure, because a stale explanation is a lie and this is what stops the ledger growing into a second copy of the schema; `provenance` must resolve; `CORRECTIVE_MIGRATION_PENDING:<file>` must name a canonical file sorting `>= "2100"`.

**Composition with what exists — no table is judged twice.** The forward auditor's `rls` claim kind (`auditMigrationsVsLive.ts:425,663-682,757-767`) owns *"every table that declares RLS has it."* The inverse check owns **only the complement**: *"every live table that declares RLS nowhere either has it, or carries a reviewed exemption."* Implement by **exporting `parseMigration` (currently module-private at `:536`)** and importing it, then adjudicating exactly `live.relations MINUS tables_with_an_rls_claim`. One RLS parser exists in this codebase; keep it that way. And **breadth delegates to depth**: `auditShadowAppendOnly.ts` asserts exact grants and triggers for one named table; the inverse check must never restate those expectations — instead `deep_verifier` is mandatory for `HARDENED_INVARIANT`, and the inverse check fails if the named verifier is not wired into CI. Adding a hardened table then *forces* a depth verifier to exist.

### Step 6 — Populate `rlsDispositions.ts` · AGENT-EXECUTABLE, owner reviews · §5.4 is the seed list

### Step 7 — Author the forward migrations whose blocking queries have returned · AGENT-EXECUTABLE · §7

### Step 8 — Clean-build proof, then the production diff · **OWNER-ONLY** · §6.6

### Step 9 — Review, then apply

**Nothing is applied to production** until this packet, the rollback plan, the clean-build proof and the live diff are reviewed — and per standing preference, **the owner presses the final trigger on every irreversible production action.**

---

## 5.4 THE RLS DISPOSITION MODEL (ruling 8)

**Every relation returned by Q1 with `relkind IN ('r','p')` in schema `public` must carry exactly one disposition. There is no default and no inherited silence.**

```
RLS_REQUIRED         relrowsecurity = true AND >= 1 policy
DENY_ALL_BY_DESIGN   relrowsecurity = true AND 0 policies (service_role bypasses).
                     Requires a written reason.
REVIEWED_EXEMPT      relrowsecurity = false, deliberately. Requires reason,
                     named reviewer, date, AND a deep_verifier wired into CI.
UNKNOWN-PENDING-LIVE Permitted only until Q1/Q3 have run once; a hard failure after.
```

Lives in `src/scripts/rlsDispositions.ts`, under CODEOWNERS. Kept separate from the EXPLAINED ledger deliberately: the ledger explains *unmodelled* objects, this covers *every* public table including the ~273 canonical ones. Separation is what lets the ledger stay small enough to read.

Enforced inside `audit:live-unexplained` as a fourth failure mode: a live table with no record → exit 1 (**this is the property `post_event_links` lacked** — `docs/migrations.md:1303` records that the audit "would have caught it, but only after the table had already sat unprotected"); a record for a nonexistent table → exit 1 (staleness is failure); disposition/live mismatch → exit 1; vacuity → exit 2.

**Seed list.** Canonical measured: 273 distinct `CREATE TABLE` names, 266 get `ENABLE ROW LEVEL SECURITY` somewhere in canonical, 240 have ≥1 surviving policy.

| class | count | contents | corrective |
|---|---|---|---|
| **C** — created in canonical, neither RLS nor policy anywhere in canonical | 12 | `compass_memories`, `geofence_admin_settings`, `media_dedup_groups`, `media_dedup_memberships`, `place_ai_summaries`, `place_best_of`, `place_cache_invalidation_queue`, `place_coverage_buckets`, `place_living_cache`, `place_merge_log`, `place_top_contributors`, `post_bucket_ledger` | **2107**, gated on a read-path audit |
| **D** — created only outside canonical, **no `ENABLE ROW LEVEL SECURITY` in any tree (verified)** | 4 | `content_translations`, `portava_featured`, `post_impressions`, `weather_cache` | **2108** — highest residual exposure; the mobile app ships the anon key |
| **A** — RLS enabled, zero surviving policy | 35 | Mostly deliberate (`2070_rls_hardening.sql` says so) → `DENY_ALL_BY_DESIGN` with a one-line reason. **Seven are user-facing and warrant an explicit reviewed disposition rather than inherited silence**: `devices`, `key_packages`, `comment_likes`, `post_reactions`, `post_shares`, `circle_invites`, `safe_return_contacts` — if any client path reads them with the anon key, deny-all is an outage, not a hardening | **2109** where a policy is needed |
| **B** — policies declared in canonical, no `ENABLE` anywhere in canonical | 9 | `events` + 6 sub-tables, `trip_members`, `storage.objects`. The `ENABLE` lives at `docs/migrations/0065_events.sql:76` — frozen. **On a canonical-only rebuild these policies are never created at all** (the `DO … EXCEPTION WHEN undefined_table` swallows it), so the events surface would be wide open with no error raised | **2115** |
| **E** — unexplained live tables | 4 | `circles`, `compass_analytics`, `public_profile_verification`, `user_trust_scores` | disposition required the moment Q1 confirms |

*(`geofence_admin_settings` **does** get an enable — in the legacy and repo-root trees, not canonical. Another instance of the merge.)*

For context on privileges: canonical has 39 `REVOKE` and 21 `GRANT`, all narrow. **No `GRANT … ON ALL TABLES IN SCHEMA`. Nothing grants to `anon`.**

---

## 6. WHAT NEEDS THE OWNER

**Two steps in this plan cannot be done by any agent in this session, and both gate the rest.** The local credentials point at production; running `psql`, the Supabase CLI or the Management API from here is forbidden and was not attempted. Requirements 4 and 9 are therefore *specified* below, precisely enough for the owner or a CI job to execute — not simulated.

### 6.1 The cutover line — one decision the rest depends on

Apply order here is plain lexicographic (`checkMigrationPrefixes.ts:29-31` — `readdirSync(...).filter(...).sort()`). Measured canonical bands, verified: **185** files `0010…0209`, **27** files `20260720…20260815`, **71** files `2027…2095`. 185 + 27 + 71 = 283. ✓

Under JS `.sort()` these compare as `"0209…" < "20260720…" < "2095…" < "2100…"` — the `2026…` band loses to `2095` on the second character (`0` < `9`), and `2100` wins over `2095` on the second character (`1` > `0`). **Verified: zero existing canonical files sort `>= "2100"`.**

So **`filename >= "2100"` is an exact, single-comparison test for "authored after the baseline."** Forward migrations are numbered above 2099 by arithmetic, not convention.

> **CUTOVER** := the baseline capture instant. **POST-CUTOVER SET** := canonical files sorting `>= "2100"`. At capture that set is empty; it grows only with §7.

**The one way this breaks:** a future file named `20270101_foo.sql` sorts *below* `"2100"` and would be wrongly classified pre-cutover. Step 1.7 closes the date band; without it the cutover line fails silently.

### 6.2 Baseline capture — OWNER-ONLY

Read-only, against production, from a machine that is not this sandbox.

```bash
export BASELINE_DATE=$(date -u +%Y%m%d)
export OUT=artifacts/api-server/baseline

# 1. Schema-only structural dump — public AND storage.
#    --no-privileges is FORBIDDEN: it drops exactly the grant set
#    auditShadowAppendOnly.ts:6-20 proved is load-bearing.
pg_dump "$PROD_URL" --schema-only --no-owner \
  --schema=public --schema=storage \
  --file="$OUT/${BASELINE_DATE}_baseline_structure.sql"

# 2. Catalog census — Q1..Q12, each to CSV under $OUT/census/.
```

**Why both a dump and a census.** The dump is what gets replayed; the census is what proves the dump faithful, and it is the artifact the manifest's live-state column is filled from. **A dump alone cannot be checked against itself.**

### 6.3 The mandatory post-capture assertion

`docs/ci/BOOTSTRAP.md:140-158,264` warns in explicit terms that dump tools are exactly what silently drops RLS and storage policies. The capture must end by asserting, and fail loudly otherwise:

```
count(policies WHERE schema='public')    > 0
count(policies WHERE schema='storage')  > 0
count(relations WHERE relkind IN ('r','p')) > 0
count(functions) > 0 ; count(triggers) > 0
count(constraints WHERE contype='f') > 0
count(grants WHERE grantee='service_role') > 0
structure dump contains >= 1 'ENABLE ROW LEVEL SECURITY'
structure dump contains >= 1 'CREATE POLICY'
every relation in relations.csv appears in the structure dump
every policy   in policies.csv  appears in the structure dump
```

The last two are the real faithfulness test: **the census is the independent witness, the dump is the artifact, and the baseline is valid only if the artifact reproduces the witness.** `BOOTSTRAP.md:787-799` documents an RLS assertion that "returned empty" and passed — the exact failure this guards against.

### 6.4 Storage, versioning, and why it cannot execute against production

```
artifacts/api-server/baseline/
  20260818_baseline_structure.sql   ← the replayable artifact
  census/*.csv                       ← 12 files, the independent witness
  MANIFEST.json                      ← version, timestamp, project ref, pg_version,
                                       pg_dump_version, sha256 of every file,
                                       assertion counts, CUTOVER_PREFIX="2100",
                                       and the resolved apply order of the post-cutover set
  README.md
```

**A baseline is immutable.** A new capture is a new dated directory and a new manifest; the previous one stays. `CUTOVER_PREFIX` moves only with a new capture, and moving it is a reviewed change — it changes which migrations the clean-build proof replays.

**Three independent barriers**, because location alone is not enough:

1. **Location.** Not under `src/migrations/`. Both `checkMigrationPrefixes.ts:25` and `auditMigrationsVsLive.ts:75` read that directory; a `0000_baseline.sql` placed there would be replayed by an operator following `APPLY-NEW-MIGRATIONS.md:27-30` *and* parsed as several thousand phantom claims.
2. **Freeze.** Registered in `FROZEN_ROOTS` with `executionForbidden: true`; the reference assertion (Step 1.5) fails on any executable file referencing the baseline path.
3. **In-file guard.** The dump's first statement aborts unless the caller passes an explicit psql variable:

```sql
\if :{?allow_baseline}
\else
  \echo 'REFUSED: baseline is a schema snapshot, not a migration.'
  \echo 'It reconstructs a database from empty. Running it against a populated'
  \echo 'database is not idempotent and is not supported.'
  \quit
\endif
```

CI passes `-v allow_baseline=1`; **the Supabase SQL editor cannot set psql variables at all.** I could not test this — there is no database here — so it ships as a specification with that fact on its face, and the owner should verify the `\if :{?…}` form against the target psql version before relying on it.

### 6.5 What the baseline must contain that no canonical file provides

It is the **only** artifact that can carry the spine, because ruling 3 forbids moving the historical files and ruling 6 forbids editing them:

the 36 spine relations · 5 enum types (`member_role`, `trip_status`, `event_role_type`, `event_rsvp_status`, `event_state`) · 6 authorization/utility functions (`set_updated_at`, `in_accepted_circle`, `can_see_location`, `shares_trip_with`, `add_owner_as_member`, `handle_new_user`) plus the four `0200` predicates as they are live · **`public.posts`' RLS enable and its four policies** · `circles` if Q1 says it exists · the merged column shapes of §4.3 **as they actually are, not as canonical describes them** · the 4 unexplained live tables and the 18 undeclared `profiles` columns · `storage.objects` policies.

### 6.6 The clean-build proof — OWNER-ONLY (requirement 9)

A **new credentialed CI job**, sanctioned CI project only. It writes, so it imports the **strict** `ciSupabaseGuard.mjs` — never the read-only door — and runs `assert-nonprod-supabase.sh` first, as the existing 2089 rehearsal job does (`live-db.yml:472,570`).

```
1. assert-nonprod-supabase.sh                     # refuse if anything resolves to prod
2. DROP SCHEMA public CASCADE; CREATE SCHEMA public;
3. install extensions from the Q12 census         # pgcrypto is required and no canonical file installs it
4. psql -v allow_baseline=1 -f baseline/<V>_baseline_structure.sql
5. apply, in a deterministic total order, every canonical file sorting >= "2100"
6. audit:schema            against the rebuilt DB  -> expect exit 0
7. audit:live-unexplained  against the rebuilt DB  -> expect exit 0
8. audit:live-unexplained  read-only against PROD  -> R_prod
9. diff R_rebuilt vs R_prod                        -> this IS ruling 10's live diff
```

**Step 5's ordering must be defined, not assumed.** There is **no `schema_migrations` table in this project** — `checkMigrationPrefixes.ts:44-46` states it, verified 2026-08-09. And two prefixes collide **by design and permanently**: `2059` and `2089`, both documented with live verification evidence at `checkMigrationPrefixes.ts:59-88` (verified). Both are pre-cutover so they do not affect the replay, but the rule must still be written: **sort by `(numeric prefix, full filename)`**, and record the resolved order verbatim in `MANIFEST.json` so the proof is reproducible byte-for-byte.

**What "matches expected schema" means operationally** — not "the audits are green," because both audits carry allowlists. It is a **three-way census comparison**:

```
MATCH  ⟺  CENSUS_REBUILT ≡ CENSUS_BASE ⊕ (declared effect of the post-cutover set)
DRIFT  ⟺  CENSUS_PROD_NOW ≠ CENSUS_BASE, for anything not explained by an
          applied post-cutover migration
```

compared per inventory as sorted sets of normalised tuples. **Grants compare as exact sets — excess is failure.** The one comparison needing real care is policies: `pg_get_expr` output must be normalised (collapse whitespace, strip redundant parens, sort role arrays) and is stable within a PG major version but not across them — which is why `MANIFEST.json` records `pg_version`.

**Do not reach for a third-party schema-diff tool.** Nothing off the shelf understands this repo's three load-bearing specifics: the EXPLAINED ledger, the `CUTOVER_PREFIX` string rule, and exact-set grant comparison. A generic differ would emit thousands of lines and be discarded — the failure mode `run-all-checks.sh:128-142` exists to prevent. Use a new credential-free `src/scripts/compareSchemaCensus.ts` reading three CSV sets.

**Vacuity guard on the proof itself:** assert relation, policy, function, trigger and constraint counts in `CENSUS_REBUILT` are non-zero **and within a stated tolerance of the production census** — otherwise it is a clean build of nothing that passes every comparison trivially.

**Known blockers the proof will hit on its first run, so a red result is not mistaken for a new discovery.** All are pre-cutover and all are resolved by the baseline carrying the spine: 206 statements target relations canonical never creates (170 unguarded across 67 files; **17 wrapped in `DO … EXCEPTION WHEN undefined_table`, which degrade silently to no-ops** — its own hazard, since the `events`/`trips`/`trip_members` hardening policies would simply not be created and nothing would report it); the 8 invalid `CREATE TYPE IF NOT EXISTS`; unguarded `CREATE TYPE` at `0058_trip_flow.sql:6,7,54,55,100`, fine on a fresh build and fatal on replay; `gen_random_bytes()` at `0080_events_extension.sql:341` needing `pgcrypto`; and the 97 double-created tables of §3.2(a).

**The clean build runs `baseline + files >= "2100"` and never replays canonical from `0010`.** That is not a workaround — it is the only construction under which requirement 9 can pass at all.

---

## 7. THE FORWARD MIGRATIONS

Described, not written. All numbered `>= 2100`, which §6.1 shows sorts after every existing file. All idempotent, additive-or-tightening, never editing an old file (rulings 3, 6). **13 of the 19 are blocked on a named query and cannot responsibly be written until it returns** — writing DDL against a schema nobody can see is how the current mess was made.

| # | what it does | why it is safe | blocked on |
|---|---|---|---|
| **2100** | `plan_geofences` policy convergence: drop canonical's `trip_members_manage_geofences` (`FOR ALL`, unfiltered join, `0035:21-28`); ensure `pgf_select_accepted` with `tm.role='member'`; add explicit INSERT/UPDATE/DELETE policies scoped to trip owner + accepted members | Strictly tightening; `DROP … IF EXISTS` no-ops when absent. Restores what legacy `0038` was written to achieve and additionally closes the **write** path canonical's `FOR ALL` opened. **Highest-priority item in the packet.** | Q3 |
| **2101** | Drop the exact policy names created only by `migration.sql`: `"Follows are viewable by authenticated users"` (`:60`), `"Public profiles are viewable"` (`:72`), the `passport_postcards` family (`:84-97`) | All `USING (true)`. Canonical already declared this intent at `2033:485,518-522` and used the wrong names. No policy the canonical model wants is removed. | Q3 |
| **2102** | `plan_checkins` / `plan_attendance_events`: designate `geofence_id` canonical, backfill from `plan_geofence_id`, drop its NOT NULL, `COMMENT` it deprecated. Same for `details` → `metadata`. **No `DROP COLUMN`.** | Drop-NOT-NULL and backfill are non-destructive and instantly reversible. If Q2 shows both `NOT NULL`, this **restores insertability** to two broken write paths. | Q2, Q6 |
| **2103** | `geofence_admin_settings`: `*_radius_m` canonical, backfill from `*_meters`, drop NOT NULL, comment deprecated | Same shape as 2102. Three vocabularies live; picks one without discarding data. | Q2 |
| **2104** | If Q5 confirms the two enums are **absent** (the prediction, since `0034:4` and `0035:4` are invalid SQL): add `CHECK … NOT VALID` on `geo_zones.zone_type` over the union vocabulary and on `plan_geofences.trigger_type` over `{enter,exit,dwell,both}`. Do **not** create the enums. Widen `radius_meters` to `double precision` if live is `integer` | `NOT VALID` adds no scan and no rewrite; `VALIDATE` is a separate reviewable step. Corrects a place where **the canonical model is wrong about live** — which no baseline alone can fix, since the baseline would faithfully record an unconstrained `text` column. | Q2, Q5, Q6 |
| **2105** | Branch on Q1. If `circles` is live: comment-only, table adopted into baseline with `provenance: NONE`. If absent: drop the FK constraint at `0058:13` and comment the column vestigial | The FK currently makes a clean rebuild abort. Dropping a constraint whose target does not exist cannot break a working write path. | Q1 |
| **2106** | Adopt `viewer_creator_fatigue` into canonical with its live shape and RLS disposition | Its only creator is in a root ruling 2 freezes; without adoption canonical `2058` is permanently orphaned. `IF NOT EXISTS` no-ops on production. | Q1, Q2, Q3 |
| **2107** | `ENABLE ROW LEVEL SECURITY` on the 12 Class-C tables | Enabling with zero policies denies anon/authenticated while service_role bypasses. **Requires a read-path audit first** — if any client queries these with the anon key this is an outage, not a hardening. All 12 are internal caches by name, but *by name* is not evidence. | Q1, Q3 + read-path audit |
| **2108** | RLS + minimal policies on the 4 Class-D tables | Highest residual exposure in the packet **and** the highest breakage risk — these look like read-through caches the client may query directly. One statement per table so rollback is per-table. **Do not apply blind.** | Q1, Q3 + read-path audit |
| **2109** | Owner-scoped policies on whichever of the 7 user-facing Class-A tables a read-path audit shows a client queries | Additive only — can only widen from deny-all toward intended access, never beyond. Tables that prove service-role-only get `DENY_ALL_BY_DESIGN` instead and are not touched. | Q3 + read-path audit |
| **2110** | Designate one of `location_preferences` / `user_location_preferences` canonical; backfill the loser; comment it deprecated. No drop. | Two tables with the same nine columns live side by side. Fully reversible. Dropping either is a separate, later, reviewed decision — ruling 3's spirit applied to live objects. | Q1, Q2 |
| **2111** | Set `trip_crew_ghost_mode_enabled` to the single reviewed value, idempotently, from canonical | Five unordered writes seeded it (§4.3); live value unknowable from files. A single-row `UPDATE` under existing flag-polarity governance is the smallest safe fix. | Q13 |
| **2112** | Comment-only: record the resolution of the canonical `0027` gap (`docs/production-migration-runbook.md:54,131,1420`) | No DDL. Its value is that the runbook's open question stops being open. | Q1 |
| **2113** | Branch on Q1's `relkind` for `buddy_bookings`: rename the table aside and create the compat view, or record that it is already a view | Rename-aside is reversible; no data dropped. | Q1 |
| **2114** | Drop `ff_select_all` (`USING (TRUE)`, declared only in a frozen root) and declare service-role-only **in canonical** | Canonical `2071:39-41` currently reasons about a frozen file's policy as though it were its own and leaves it in place. This moves the declaration into the tree that owns it. | Q3 |
| **2115** | Idempotently enable RLS on `events` + 6 sub-tables, declared in canonical | On production a no-op; **on a rebuild it is the difference between a hardened events surface and one that is wide open with no error raised**, because the `DO … EXCEPTION` swallows the failure. | Q1 |
| **2116** | Drop composer-pkg's four `storage.objects` policy names; ensure canonical's three as amended by `2089` | Two disjoint families on the same bucket OR together, so composer-pkg's `public read` may still be defeating `2089`'s revoke. | Q3 |
| **2117** | Collapse **four** disjoint `pulse_geo_tags` policy families into one canonical-owned family | Same as 2116 with four families. | Q3 |
| **2118** | Same treatment for `passport_stamps`, `trip_crew_location_sessions`, `discovery_places`, `user_privacy_settings` | Grouped because each is the identical mechanical operation. **If Q3 shows any one is materially riskier, split it out** — this packet should not group a security change with a cosmetic one. | Q3 |

**What deliberately gets NO forward migration.** Most of the manifest resolves through the baseline, not through DDL. Where a canonical file is merely a *wrong description* of live — `passport_stamps`, `passport_memories`, `passport_visibility_preferences`, `trip_crew_location_preferences`, `location_sessions`, the `pulse_geo_tags` columns, the 18 undeclared `profiles` columns, the whole 36-relation spine — **the correction is the baseline plus a manifest row, and the corrective column reads `NONE NEEDED — baseline adoption`.** Writing DDL to make production match a file that never ran would be changing production to fit a fiction. Forward migrations are reserved for **live defects** (2100–2104, 2107–2109, 2111) and for **declarations that must move into canonical ownership** (2106, 2114–2118).

---

## 8. ROLLBACK

Every step that changes anything, and how to undo it.

| step | changes | rollback | residual risk |
|---|---|---|---|
| **1. Extend the freeze guard** | Repo only — new/edited TS, no DDL | `git revert`. CI returns to today's coverage. | **None to production.** Risk is inverse: a wrong hash manifest turns CI red for legitimate work. Mitigate by generating manifests from `git ls-files` output in the same commit that adds them, and land it on its own branch so a red CI is unambiguous. |
| **2. Priority queries** | Nothing — read-only `SELECT`s through the existing read-only door | n/a | The door is the mitigation. If it refuses, **stop** — do not route around it. |
| **3. Baseline capture** | Adds files to the repo; `pg_dump --schema-only` takes only `ACCESS SHARE` | Delete the directory; capture again. Baselines are immutable and dated, so a bad capture is superseded, never edited. | A capture that violates §6.3's assertions is **worse than none**, because everything downstream trusts it. The assertions are not optional. |
| **4–7. Manifest, auditors, dispositions** | Repo only | `git revert` | New auditors may be red on first run. **Do not discard the exit code to make it green** (`run-all-checks.sh:128-142`); fix the model or add a reviewed ledger entry. |
| **8. Clean-build proof** | Drops and rebuilds the **sanctioned CI** database | Re-run the job; it is idempotent by construction (it starts from `DROP SCHEMA`) | The only real risk is target confusion. `assert-nonprod-supabase.sh` runs first, as it does for the 2089 rehearsal. **If it cannot establish the target, the job must fail, not proceed.** |
| **9a. Comment-only migrations** (2105-if-live, 2112) | Nothing executable | No rollback needed | None |
| **9b. Additive migrations** (2106, 2109) | `CREATE TABLE IF NOT EXISTS`, `CREATE POLICY` | Paired `DROP POLICY IF EXISTS` / `DROP TABLE IF EXISTS`, pre-written and reviewed **before** the forward file is applied | Adding a policy to a table with RLS on and zero policies can only widen from deny-all. Low. |
| **9c. Backfill + relax** (2102, 2103, 2110) | `UPDATE`, `ALTER COLUMN DROP NOT NULL`, `COMMENT` | `ALTER COLUMN SET NOT NULL` restores the constraint; the backfill is idempotent and additive; **no column is dropped, so no data is lost** | If a `SET NOT NULL` rollback fails, it is because a null was written in the interim — which means the relax was load-bearing and should not be rolled back. Detect with a count query before reverting. |
| **9d. Policy convergence** (2100, 2101, 2114, 2116, 2117, 2118) | `DROP POLICY` + `CREATE POLICY` | **Capture Q3's exact output for the affected tables immediately before applying**, and pre-write the `CREATE POLICY` statements that reconstruct them verbatim. This is the rollback script — it cannot be written from the repo, only from live. | **The real risk is over-tightening: a policy someone depends on disappears and a read path 403s.** Apply one table per transaction, verify the intended read path, then proceed. Do not batch 2118's four tables into one transaction. |
| **9e. RLS enable** (2107, 2108, 2115) | `ALTER TABLE … ENABLE ROW LEVEL SECURITY` | `ALTER TABLE … DISABLE ROW LEVEL SECURITY` — instant, complete | **The highest-risk group in the packet.** Enabling RLS on a table a client reads with the anon key turns every such read into an empty result — silently, with no error. **A read-path audit is a hard precondition, not a nicety.** One table per statement, per transaction, with the disable-statement staged and ready. |
| **9f. Constraint add** (2104) | `CHECK … NOT VALID` | `DROP CONSTRAINT` | `NOT VALID` blocks only *new* violating writes and takes no lock beyond a brief `ACCESS EXCLUSIVE`. Existing rows are untouched until a separate `VALIDATE`. |
| **9g. Flag value** (2111) | One-row `UPDATE` on `feature_flags` | `UPDATE` back — but **record the pre-change value first**, since it is currently unknown | If the flag gates a user-visible behaviour, flipping it is a product change, not a schema change. Confirm which way is intended before applying. |

**Two rollback preconditions that apply to the whole of step 9:**

1. **Every policy-touching migration needs its rollback captured from live before it runs.** Q3's output for the affected tables *is* the rollback script. It cannot be derived from the repository — that is the whole premise of this packet.
2. **Per standing preference, the owner presses the final trigger.** Stage, verify, then hand over the press.

---

## 9. WHAT THIS DOES NOT FIX

- **The Supabase SQL editor.** Production migrations in this project are applied by a human pasting SQL (`supabase/README.md:19-25`). No mechanism in this repository can reach that. Worse, the `*-backend/APPLY.md` docs carry the **production project ref `ajrurzioarfkagpuxfnb` directly in their instruction lines** (`composer-pkg/APPLY.md:8`, `follows-backend/APPLY.md:9`, `passport-backend/APPLY.md:13`). **Freezing the SQL does not disarm those documents.** Each frozen root's README must state at the top that the APPLY doc beside it is historical and must not be executed — and that is documentation, not enforcement. If one further hardening is wanted beyond this packet, it is scrubbing the production ref from every APPLY doc.
- **The true history.** The baseline *replaces* the unauditable pre-history; it does not reconstruct it. After cutover there is exactly one description of the pre-cutover schema, and its authority is that it was read from the database rather than assembled from files. The question "which file actually ran" stays permanently unanswered for the 97 double-created tables, and that is the accepted cost.
- **A README is not a guard.** Ruling 2 asks for a freeze. The hash manifest is the enforcement; the README is convention. The packet should not let those blur.
- **Drift between capture and application.** Anything applied to production between the baseline capture and the review is invisible to the packet. The §6.6 step-8 production diff is the detector, and it must be re-run immediately before any application, not once.
- **The 53 unparsed canonical files.** The forward auditor cannot distinguish "declares nothing" from "declares something I failed to parse." The inverse auditor covers the *live* consequences of that gap, but the parser's blind spot itself remains.
- **Any live-state claim in this document.** Every one is `UNKNOWN-PENDING-LIVE`. This packet is a specification and a decision request, not a report of production.

---

## 10. OPEN QUESTIONS

Stated plainly rather than inferred.

1. **Every live-state cell.** The only live artifact in the repo is `artifacts/api-server/src/test/generated/liveColumns.json`, whose header says it is `information_schema.columns` for `public` — **column names only: no types, nullability, constraints, policies, grants, functions, triggers or indexes** — and whose `generatedAt` is `2026-07-21T02:32:33.856Z`. Absence from it is not evidence of absence for anything applied after that date.
2. **Whether any file in `db/migrations`, `docs/migrations`, `supabase/migrations` or `artifacts/api-server/supabase/migrations` is the applied text for its objects.** Every "applied" claim here is a repo assertion, and `.agents/memory/migration-applied-vs-committed.md:12-16` documents those assertions being wrong **in both directions** — `0108` logged applied but never ran; the entire `0047`–`0113` rent_buddy chain found unapplied.
3. **Whether `db/migrations/0025_location_system.sql` is the source of the live `lat/lng/accuracy_meters/source` names** or a coincident third draft. Three distinct 0025 texts exist. Requires Q2.
4. **Whether `docs/migrations/0069_profile_privacy_settings.sql` and `0070_profile_views.sql` correspond to live objects at all.** No markdown, script or workflow in the repository references them; they sit outside both guards, outside the audit, and outside every inventory.
5. **Which duplicate function body is live** for the 17 functions defined in more than one root — `can_see_post`, `can_post_to_trip`, `is_accepted_trip_member`, `can_see_postcard`, `can_see_trip`, `is_blocked`, `upsert_city_stamp`, `purge_old_ranking_debug_samples` among them. Requires Q4, **except** the four that canonical `0200:14-19` attests were read via `pg_get_functiondef()` and are re-verified by `artifacts/api-server/scripts/verify-backfill-0200.mjs`.
6. **Whether the `\if :{?allow_baseline}` guard behaves as specified** on the target psql version. No database here to test against.
7. **Whether a guard exists that requires a public table to declare RLS.** I searched scripts, tests, workflows, `.replit` and migration `DO` blocks and **found none.** The two mechanisms in Step 5 are what exist. If the ruling assumed a third, I did not find it, and I am not naming a substitute as though I had.
8. **Whether `.replit`'s deployment commands are authoritative** — `.replit:6-14` warns the Replit Deployments UI overrides the file. No migration step appears in `build` or `run` either way.

---

### THE DECISION THIS PACKET ASKS FOR

**Approve Step 1** (agent-executable today, repo-only, reversible by `git revert`, zero production risk) **and schedule Steps 2 and 3** (the four priority queries and the baseline capture — both requiring database access only the owner has).

Everything else in this document is blocked behind those two, and three of the four priority queries may be describing an open live defect right now.
