# Data-seed drift — do the rows the migrations declare actually exist?

**Read-only. Nothing was applied, inserted, updated or deleted.** Production
(`ajrurzioarfkagpuxfnb`) read 2026-08-12 through the guarded read-only audit
path.

## The blind spot this closes

`audit:schema` / `schema drift · migrations vs live` compares **schema objects** —
tables, columns, indexes, constraints. A migration whose entire payload is
`INSERT … VALUES` adds no schema object, so if it never runs, **nothing notices**.
The drift is invisible to every existing check by construction: there is no
column missing, no index absent, no constraint undeclared. Only the rows are
gone.

This was surfaced by the flag census (`flag-disposition.md`), which found all
five flags seeded by `2040_media_ranking_boost_flags.sql` absent from
production — a migration in the repository that production had never run. That
raised the obvious question this sweep answers: **how many others?**

## Scope

Every **top-level `INSERT … VALUES`** in `src/migrations` — the statements that
declare persistent seed/reference/config data. Deliberately excluded:

- **Schema DDL** — already covered by `audit:schema`.
- **`INSERT`s inside `$$ … $$` function and `DO` bodies** (17 found) — runtime
  writes executed by application logic, not seeds.
- **`INSERT … SELECT` backfills** (10 in bodies, 2 top-level) — data transforms
  over existing rows, not declared constants.

The scan is comment-stripped and quote-aware, and its statement terminator
ignores semicolons inside string literals — the defect fixed in the previous
commit, which is exactly the kind of blindness this sweep exists to avoid.

**97 `INSERT` statements** classified → **68 top-level `VALUES`** → 48 are
`feature_flags` (swept separately in `flag-disposition.md`) leaving **20
statements across 11 tables** audited here row by row.

## Results

Every table compared by **natural key**, not by row count — a count can match
while the keys differ.

| Migration | Table | Key | Declared | Present | Absent | Verdict |
|---|---|---|---|---|---|---|
| `0039_plan_geofence_full` | `geofence_admin_settings` | `id` | 1 | 1 | 0 | ✅ applied |
| `0051_compass_foundation` | `compass_intent_modes` | `mode` | 9 | 9 | 0 | ✅ applied |
| `0054_compass_cache` | `compass_frontload_rules` | `rule_name` | 11 | 11 | 0 | ✅ applied |
| `0075_seed_discovery_places` | `discovery_places` | `id` | 46 | 46 | 0 | ✅ applied |
| `0081_stamp_system_v2` | `stamp_collections` | `slug` | 5 | 5 | 0 | ✅ applied |
| `0081`,`0082`,`0145`,`0179`,`0189` | `stamp_definitions` | `slug` | 60 | 60 | 0 | ✅ applied |
| **`0198_place_contributor_stamps`** | **`stamp_definitions`** | **`slug`** | **3** | **0** | **3** | 🔴 **REAL — never applied** |
| `0090_rent_buddy_rollout_tables` | `rent_buddy_global_controls` | `id` | 1 | 1 | 0 | ✅ applied |
| `0092_seed_rent_buddy_launch_cities` | `rent_buddy_city_rollouts` | `city` | 3 | 3 | 0 | ✅ applied |
| `0177_stamp_premium_foundation` | `destination_identities` | `identity_key` | 5 | 5 | 0 | ✅ applied |
| `0182_country_essentials` | `country_essentials` | `code` | 54 | 54 | 0 | ✅ applied |
| `0185_seed_price_baselines` | `price_baselines` | composite | 1560 | 1560 | 0 | ✅ applied |
| `2040_media_ranking_boost_flags` | `feature_flags` | `flag` | 5 | 0 | 5 | ⚪ benign — never applied |
| `0037`, `2074` (+ others) | `feature_flags` | `flag` | — | — | 9 | ⚪ benign — see `flag-disposition.md` |

`discovery_places` holds 184 live rows against 46 declared; the surplus is from
other sources and is not drift. Every declared `id` is present.

**One genuine gap in 20 statements.** Every other data-seeding migration has
fully applied.

## 🔴 `0198_place_contributor_stamps.sql` — and why it never applied

Three rows absent: `place_contributor_bronze`, `place_contributor_silver`,
`place_contributor_gold`.

This is **not** the 2040 pattern of a valid migration nobody ran. **`0198`
cannot apply — it is invalid SQL:**

```sql
INSERT INTO stamp_definitions (slug, name, description, category, stamp_type, metadata, is_active)
```

`stamp_definitions` **has no `metadata` column** and never has had one. Its 27
columns are `id, slug, name, description, stamp_type, category, icon_url,
rarity, is_active, is_repeatable, max_awards_per_user, level_config,
criteria_type, criteria, visibility_default, source_system, city, country,
starts_at, ends_at, created_at, updated_at, universal_artwork_url,
template_family, edition_size, is_limited, display_priority`. The only
`metadata`-named column in the stamp schema is
`stamp_artwork_versions.qc_metadata` (`0177:110`), a different table.

Running it raises `column "metadata" of relation "stamp_definitions" does not
exist`. So this migration has never been runnable in any environment, and the
file's own header comment — *"metadata.threshold drives the award logic in the
collections worker"* — describes a column that does not exist and a mechanism
that does not work.

> The header also calls it "Migration 0113" while the file is `0198`.

### The feature is broken for a second, independent reason

Applying the rows would **not** switch the feature on. `placeCollectionsWorker.ts:167`
awards by an **untiered** slug:

```ts
await awardFn(sc, { userId, definitionSlug: "place_contributor", metadata: { placeId, threshold } });
```

`place_contributor` — with no tier suffix — is seeded by **no migration** and
does not exist in production. The three rows `0198` declares are
`place_contributor_bronze` / `_silver` / `_gold`. The lookup can never match any
of them.

And the failure is doubly silent:

- `StampAwardEngine.awardStamp` does `.eq("slug", definitionSlug).maybeSingle()`
  and returns `{ awarded: false, reason: "definition_not_found" }` — it does not
  throw; and
- `tryAwardStamp` **discards the return value** inside a bare
  `catch { /* best-effort only */ }`.

So a user crossing 10, 50 or 100 posts at a place has a stamp award attempted,
declined for `definition_not_found`, and the result thrown away. Nothing logs,
nothing alerts, nothing fails. The thresholds themselves are hardcoded in the
worker (`STAMP_THRESHOLDS = [10, 50, 100]`), so the `metadata.threshold` the
migration tried to write would not have driven anything even if the column
existed.

**Verdict: REAL.** Something depends on these rows — they are the only
`place_contributor` definitions that exist anywhere — and the feature they back
is silently dead in production. But **staging the rows is necessary, not
sufficient**: without a code change reconciling the slug, applying them changes
nothing observable.

The apply block is staged at
`_incoming/prod-apply-0198-place-contributor-stamps.sql`, corrected to the real
schema. **It is not applied, and applying it alone will not restore the
feature.** Which slug the worker should use — and where tier/threshold data
belongs now that `metadata` is known not to exist — is an owner decision.

## ⚪ Benign absences

**`2040_media_ranking_boost_flags`** — five `MEDIA_*` ranking flags absent.
Benign: all five seed `false`, and `MediaFeedRankingService.getFlagDefaults()`
initialises every one to `false` before the query and leaves it there when the
row is missing. Absent row and seeded row produce identical behaviour — media
ranking runs base-score-only either way. Unlike `0198`, this migration is valid
SQL; it simply never ran.

**Nine further `feature_flags` rows** absent, dispositioned in
`flag-disposition.md`. Benign for the same reason — every one seeds `false` and
every reader is fail-closed. `rent_buddy_allow_bookings_without_kyc` is the row
where absence actively *is* the safe state: it is the override permitting
Rent-a-Buddy bookings while identity verification is non-operational, and a
missing row reads `false`, keeping the gate shut.

## Method and limits

- One `SELECT` per table through the guarded read-only path. No write of any
  kind, to any environment.
- Declared rows parsed with a comment-stripping, quote-aware scanner; `ON
  CONFLICT` / `RETURNING` clauses cut before row splitting so their parentheses
  are not miscounted as rows.
- Comparison is by natural key where one exists, and by exact row count plus
  distinct-combination count for `price_baselines`, whose seed is
  `INSERT … SELECT FROM (VALUES …)` with a composite key (1560 rows = 24
  category/tier combinations × 65 country values, matching production exactly).
- A migration that was applied and whose rows were **later edited** would show
  as present here. This sweep answers "does the row exist", not "does it still
  match what the migration declared".
- Runtime `INSERT`s in function bodies are out of scope by design; a seed that
  is written by application code rather than a migration would not appear.

**Held and untouched:** production applies, the deferred flag codify/retire set,
`#3586`, Step C.
