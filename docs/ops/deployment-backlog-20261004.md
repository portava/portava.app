# The deployment backlog — measured at `f71cfb85f`, 2026-10-04

**Read-only. Nothing was applied, flipped, deployed or merged in producing this.**
No database was contacted: not production `ajrurzioarfkagpuxfnb`, not
`portava-ci` `hwokxgbmezheskbzskfr`. Every number below is derived from a file
committed to this tree at `f71cfb85f`, and every derivation is named so it can
be re-run and disagreed with.

This document exists because the distance between a census verdict and a user
being able to do the thing is, for a large part of this architecture, **a
migration that nobody has applied and a flag row that does not exist** — and
nobody had a current map of that. It is a map, not a journey. It recommends an
order; it performs nothing.

## What this pass found, in five lines

1. **683** migrations in the canonical tree, **129** recorded applied to
   production, and the record has not moved since 2026-09-22. The honest
   actionable figure is **93** — the files numbered above the newest recorded
   prefix.
2. **299** flag names seeded, **201** with a production row, **107** ON, and
   **101 seeded with no production row at all.** All 101 are seeded FALSE, so
   the INSERT that makes them flippable is runtime-neutral by construction.
3. **The premise that this is mostly an apply backlog is wrong for three of the
   four surfaces traced.** For Trips, Highlights & Memories and most of Layover,
   the migrations are already in production and the blocker's name changed from
   "no migration" to "no flag" without any verdict moving. **~137 census rows
   are one `UPDATE` away** — and not one of those updates is safe to take today.
4. **Telegraph is the exception** and the largest remaining apply payoff: 19
   rows become gradable on `2810` alone, 51 across its whole chain.
5. **The sharpest hazard is an apply order that runs backwards against its own
   numbering**: `3502` must precede `2975`, nothing enforces it, and getting it
   wrong makes every PERMANENT Highlight readable by nobody — with no error.

---

## 0. The two honest caveats, before any number

**(a) The repository's record of what production holds is a tripwire, not an
inventory, and it says so itself.** `production-applied-migrations.json` opens
by stating that migrations applied by hand through the Supabase dashboard write
no `supabase_migrations` row, that production's `schema_migration_ledger`
carries rows only for migrations applied through the ledger discipline, and that
the 2026-09-16 capture found three migrations in one table and five in the other
with no overlap — so **"not in the record" does not mean "not applied."**

The clearest in-tree proof of that is `2401` and `2402`. Neither appears in the
record. Both are recorded as applied to production, and their defect re-read as
closed, at `docs/architecture/blocker-ledger.md:20` and
`docs/architecture/migration-disposition-ledger.md:51`
(*"Production now carries `2334 2337 2370 2371 2401 2402 2420 2460 2461 2462
2490`"*). Any list built by subtracting the record from the tree therefore
over-counts, and the over-count is largest in the oldest bands.

**(b) The production schema snapshot is twelve days old.** The current capture
is pinned at
`artifacts/api-server/src/lib/capability/snapshots/current.ts:104#export const PRODUCTION_SNAPSHOT_FILENAME`
to `20260922-production-schema.json`, `capturedAt` `2026-09-22T16:07:23Z`,
watermark `20260922155706`. Every flag value and every table/column presence
below is that capture's. Anything that changed in production since
2026-09-22 is **unknown** here and only a fresh capture settles it.

---

## 1. Migrations

### The three numbers

| Measure | Value | How it was derived |
|---|---|---|
| Migrations in the canonical tree | **683** | `ls artifacts/api-server/src/migrations/*.sql \| wc -l`. That directory is canonical by the repo's own declaration: `artifacts/api-server/migrations/README.md:6#**The canonical migration chain is` names it, and that sibling directory (71 files) is frozen and explicitly not canonical. |
| Recorded applied to production | **129** | `.migrations.length` of `artifacts/api-server/src/lib/capability/production-applied-migrations.json`. All 129 `name` values match a file in the canonical tree by name; zero orphans. |
| Files not in the record | **554** | 683 − 129, by set difference on filename stem. **This is not the backlog** — see caveat (a). |

The 2026-10-03 figures were 681 / 129. The migration count moved by two over the
108 commits; the record did not move at all. The newest version in the record is
`20260922155706` — the same instant as the snapshot watermark — so **no
migration has been recorded as applied to production since 2026-09-22.**

### A more useful cut than 554

The record's prefixes run from `2120` to `2997`. Counting the canonical tree by
hundred-band against the record:

| band | files | in record | not in record |
|---|---|---|---|
| 0000–0099 | 82 | 0 | 82 |
| 0100–0199 | 93 | 0 | 93 |
| 0200–0299 | 10 | 0 | 10 |
| 2000–2099 | 71 | 0 | 71 |
| 2100–2199 | 75 | 1 | 74 |
| 2200–2299 | 51 | 16 | 35 |
| 2300–2399 | 27 | 10 | 17 |
| 2400–2499 | 15 | 11 | 4 |
| 2500–2599 | 14 | 13 | 1 |
| 2600–2699 | 5 | 4 | 1 |
| 2700–2799 | 53 | 47 | 6 |
| 2800–2899 | 20 | 6 | 14 |
| 2900–2999 | 49 | 21 | 28 |
| 3000–3099 | 5 | 0 | 5 |
| 3100–3199 | 1 | 0 | 1 |
| 3300–3399 | 38 | 0 | 38 |
| 3400–3499 | 43 | 0 | 43 |
| 3500–3599 | 4 | 0 | 4 |
| `20260700`–`20260899` (date-prefixed) | 27 | 0 | 27 |

The `0000`–`2099` bands — 256 files with zero record entries — are the
foundation that production demonstrably has (the 2026-09-22 capture holds 497
relations and 164 functions). Reading those 256 as backlog is the mistake caveat
(a) warns about.

**The figure that is actionable: 93.** Ninety-three files carry a numeric prefix
above `2997`, the highest prefix in the record — i.e. they were authored after
the last apply the repository recorded. Eighty-five of those are in the
`3300`–`3599` bands, which have **no** record entry of any kind. That is the
band where "not in the record" is most likely to mean what it says.

Lower bound on how much of that 93 is genuinely unapplied, from committed
captures rather than subtraction: `2992`'s own precondition names
`layover_certified_computations` as absent; `docs/ops/sensing-cutover-runbook.md:21`
lists `3002`, `3003`, `3004`, `3110`, `3310`–`3315` and `2841` as
**absent from production** against `portava-ci`, each with a date; and
`check:flag-schema-prerequisites` reports 37 latent flags whose schema objects
are absent from the 2026-09-22 capture (§3 below).

---

## 2. The dependency chains that actually block surfaces

This is the part that is worth more than any total: an ordered list of
"apply X and N census rows become gradable".

The row counts are the censuses' own. They were re-derived here with the repo's
own counter (`pnpm --filter api-server run check:census-integrity`, offline, no
database), which at `f71cfb85f` recomputes **3518 verdict rows: C 2436, W 846,
N 211, X 25**, against 3681 stated denominators. 2436/3518 = **69.2 %** correct
of parsed rows; 2436/3681 = **66.2 %** of stated denominators. Both figures are
the same measurement under two conventions, and the 69.2 % in circulation is the
first one.

The four surfaces traced below hold **587 of the 846 `W` rows** (trips 128,
telegraph 177, layover 144, highlights-memories 138).

### 2.1 Telegraph

The chain is real and it is `2325 → 2810 → 3000`, confirmed not from prose but
from `3000`'s own five `RAISE EXCEPTION` preconditions:

| line | requires | supplied only by |
|---|---|---|
| `3000_telegraph_unsend_authoritative.sql:94` | `public.messages` | baseline |
| `3000_telegraph_unsend_authoritative.sql:101` | `messages.unsent_at` | 2325 **or** 2810 |
| `3000_telegraph_unsend_authoritative.sql:109` | `messages.lifecycle_state` | **2810** |
| `3000_telegraph_unsend_authoritative.sql:121` | the `unsent` CHECK value | **2810** |
| `3000_telegraph_unsend_authoritative.sql:130#PRECONDITION FAILED: telegraph_unsend_message_before_seen` | the function's prior existence | **2325** |

So `3000` hard-depends on **both** 2325 and 2810; 2325 and 2810 do not depend on
each other (each adds `unsent_at` `IF NOT EXISTS`). Numeric order satisfies
every edge. The census states the production order at
`docs/architecture/census-telegraph.md:9703`.

**What each apply makes gradable** — quoted from the census's own
artifact→rows table at `docs/architecture/census-telegraph.md:4051`–`4058`:

| apply | flag it seeds | rows that become gradable |
|---|---|---|
| `2810_telegraph_message_kernel.sql` | `2810_telegraph_message_kernel.sql:420#telegraph_message_kernel_enabled` FALSE | **19** — T72, T78, T139, T141, T154, T156, T161, T181, T195, T196, T210, T228, T230, T231, T232, T276, T302, T348, T369 |
| `2811_telegraph_message_side_tables.sql` (seeds no flag; gated by 2810's) | — | **9** — T80, T142, T143, T144, T147, T158, T163, T221, T385 |
| `2400_telegraph_history_bound.sql` + `2400_telegraph_history_bound.sql:182#telegraph_history_bound_enabled` FALSE | | **5** — T211, T313, T362, T390, T444 |
| `2812_telegraph_report_evidence.sql:160#telegraph_report_evidence_enabled` FALSE | | **2** — T283, T284 |
| `2217_protected_locations.sql` | — | **1** — T31 (per the §14.5 correction at `docs/architecture/census-telegraph.md:4647`, which says §13.3's "exhaustive" claim is not) |
| `2990_nearby_reachable_flag.sql:57#nearby_reachable_enabled` FALSE | | **7** — T24, T25, T26, T29, T235, T382, T400 |
| `2989_messages_audio_media_type.sql` | — | **3** — T53, T63, T243 |
| `2991_message_translations_confidence.sql` | — | **1** — T240 |
| the chain `2325 → 2810 → 3000` as a unit | — | **4** — T326, T327, T338, T387 |

Derived total: **51 of Telegraph's 177 `W` rows (28.8 %) are deployment-gated**,
52 if T31's BRANCH→BOTH correction is taken. That sum is derived here across
§13.4, §31, §36, §38 and §41; the census states it per-section and never totals
it. The census's own partition at `docs/architecture/census-telegraph.md:4015`
puts the rest elsewhere: 89 rows — more than half the `W` pile — are blocked on
something that exists in neither tree.

**Three things in this chain that look like deploy items and are not.**

1. `2260_availability_windows.sql` appears in the same census table and **is
   already applied to production** (`availability_windows` is present at
   `artifacts/api-server/baseline/20260907_production_tables.txt:21#availability_windows`).
   T28 waits on its flag alone. Do not schedule 2260.
2. `2813_telegraph_request_origin.sql` caps **nothing**. The census is explicit
   at `docs/architecture/census-telegraph.md:4060`: applying it and enabling its
   flag still leaves T278 open, because five of its six origins are
   unverifiable in principle. *"An owner who read 'capped by 2813' would
   schedule a release and get nothing."*
3. `2217` ships its table empty on purpose
   (`artifacts/api-server/src/migrations/2217_protected_locations.sql:11#-- THIS TABLE SHIPS EMPTY, AND THAT IS THE POINT`),
   so applying it suppresses nothing until a named owner writes real addresses.
   That is a third gate, and it is neither a deploy nor a branch.

**Applying these migrations cannot turn anything on**, which is what makes the
apply the safe half. Three of the four `telegraph_*` flags are
postcondition-locked to FALSE — the migration aborts if the flag is seeded true
(`2810_…:459`, `2812_…:197`, `2813_…:169`) — and `3000` states the principle at
`3000_telegraph_unsend_authoritative.sql:78`: *the flag is an owner decision.*

**The already-applied half is the model for everything else here.** `2400` and
`2966` were applied to production on 2026-09-22 and the flag is **still off**,
deliberately: `docs/ops/telegraph-history-bound-deployment.md:40` measures four
read paths — `lib/mediaAccess.ts`, `routes/telegraphStream.ts`,
`routes/groupChat.ts`, `compass/TelegraphConversationTools.ts` — that **do not
read the bound on `origin/main`**, which is what production deploys. Flipping
before that branch deploys would *"advertise a complete bound while delivering a
partial one."* The flip is ordered after the deploy and is the one step not
taken.

### 2.2 Trips — **the premise reverses here, and this is the most important finding in the document**

Trips was traced expecting a migration chain behind `2420`. There is almost none
left. **Every migration the census names as a Trips blocker is already applied
to production**, and the blocker's name changed from "no migration" to "no
flag" without the verdicts moving. Verified name-by-name against the record:
`2420`, `2450`, `2500`, `2590`, `2760`–`2795` and `2796` are all present in
`production-applied-migrations.json`. The census records the supersession
itself, three times — and *"What changed is the blocker's name — from 'no
migration' to 'no flag' — not the verdict"*
(`docs/architecture/census-trips.md:7489`).

`check:census-integrity` recomputes Trips at `f71cfb85f` as **451 rows: C 320,
W 128, N 3**. §79.1's classification table at
`docs/architecture/census-trips.md:9667` says the code-actionable bucket is
literally zero: `docs/architecture/census-trips.md:9675#code-actionable now`.
The brief's reading of §79.1 is right in substance and needs two corrections:
the table classifies **131** rows (128 W + 3 N), and of the 128 `W` rows
**108**, not all of them, are in the "awaits a hosted apply, a flag or
production evidence" bucket (`docs/architecture/census-trips.md:9676`). The
other 20 are 9 owner-decision, 10 needing a migration nobody has written, and
1 external.

**102 of the 128 reduce to exactly two flag flips.** The authoritative mapping
is §68.2's 130-row "every row, with its blocker" table at
`docs/architecture/census-trips.md:7513`, whose fourth column is *what closes
it*; aggregating its own strings gives 72 migration-named rows (every one of
those migrations now applied) + 30 flag-named + 1 secret. The order and the
reason are fixed by the surface's own activation document,
`docs/TRIPS-PRODUCTION-ACTIVATION.md:126`:

| step | flag | seeded at | why this order |
|---|---|---|---|
| 1 | `trip_operational_projections_enabled` | `artifacts/api-server/src/migrations/2778_trip_operational_projections_flag.sql:31#trip_operational_projections_enabled` FALSE | *"These read fail-closed and probe the schema before use, so a wrong build answers `feature_disabled` rather than 500."* ~13 rows |
| 2 | `trip_kernel_enabled` | `artifacts/api-server/src/migrations/2420_trip_kernel_foundation.sql:189#trip_kernel_enabled` FALSE | *"then create a plan item, edit it, and confirm a `trip_events` row and a `trip_outbox` row appear for it."* ~13 rows directly, plus TR1/TR435/TR378 once their code halves land |

Both flips sit behind a prerequisite this environment cannot satisfy
(`docs/TRIPS-PRODUCTION-ACTIVATION.md:100`): confirm the deployed build, then
run four credentialed checks that *"exit 2 without credentials, which is 'not
run', not 'passed'."* And the 2026-09-07/08 gate analysis that authorised
`2420`'s apply closed with the one instruction that still stands —
`docs/architecture/2420-trip-kernel-foundation-gate.md:3#**Verdict: APPLY.**`,
and *the one thing that must not follow is flipping `trip_kernel_enabled`*.

**One migration triplet does remain unapplied**, and the census does not know
about it: `2797` → `2798` → `2799`, absent from the record, with hard
preconditions —
`artifacts/api-server/src/migrations/2798_trip_kernel_recurrence_family.sql:78#2798: requires 2797`
and
`artifacts/api-server/src/migrations/2799_trip_snapshot_fold_recurrence_vocabulary.sql:51#apply 2773 first`
(`2773` is applied). `2797`'s own header names the row it answers —
`artifacts/api-server/src/migrations/2797_trip_commitment_recurrences.sql:5#census-trips TR427`
— while the census still calls TR427 *"a recurrence and routine subsystem
nobody has written"* at `docs/architecture/census-trips.md:7644`. **That census
statement is stale**, and the triplet plus `trip_kernel_enabled` is what closes
it. A separate committed probe on `portava-ci` already records
`ADD_RECURRING_COMMITMENT` answering `ok=true`
(`docs/TRIPS-PRODUCTION-ACTIVATION.md:228`).

Trips' non-flag blockers, with evidence:

- **Owner decision, 9 rows.** TR1/TR435 (`APPEAL_RESTORE_SEMANTICS`, declared at
  `artifacts/api-server/src/services/appeals/resolveAppeal.ts:104#export const RESTORE_SEMANTICS_DECISION`);
  TR128/TR267/TR341/TR412 (the Routes API decision below); TR261/TR437
  (delete the second optimizer — **after** the flip, because the gate is FALSE
  and the deletion would remove a live surface); TR173.
- **Provider key + owner spend, 4 rows.** The routed provider is written and
  deliberately not wired:
  `artifacts/api-server/src/domain/trips/contracts/GoogleRoutesTravelTimeProvider.ts:4#WIRED 2026-10-05` (it read "PREPARED, NOT WIRED" when this was written; lane C wired it behind the quota and budget gate — census-trips §80.2, §82).
  The key already exists for Places (`GOOGLE_MAPS_API_KEY`); what is missing is
  the owner enabling the Routes API in the same Cloud project and accepting
  per-call spend. Three seams still bind the straight-line provider —
  `artifacts/api-server/src/routes/tripFeasibility.ts:113#const PROVIDER = TRIP_TRAVEL_TIME_PROVIDER;` (it read "const PROVIDER = straightLineTravelTimeProvider;" when this was written)
  and the two projection bindings.
- **Env var, 1 row.** TR174 needs `TRIP_OFFLINE_BUNDLE_SECRET` (falling back to
  `SESSION_SECRET`) on the deployment, read at
  `artifacts/api-server/src/domain/trips/services/TripOfflineBundle.ts:127#TRIP_OFFLINE_BUNDLE_SECRET`
  and enforced at `artifacts/api-server/src/routes/tripOffline.ts:74#is not set`.
  The census contradicts itself on whether this is a deployment row at all —
  `:9676` counts it in the 108, `:7820` argues it cannot be, naming map tiles
  as the real blocker. **unknown**; the reasoned statement is the second.
- **A migration nobody has written, 10 rows.** TR33, TR92, TR93, TR77, TR152,
  TR256, TR378, TR408, TR425, TR440. Not deployment items.
- **EAS rebuild: not a category this census uses.** `census-trips.md` has zero
  matches for `EAS`, `TestFlight` or `app store`. Treat that bucket as absent
  for Trips, not empty.

### 2.3 Layover — uniformly CI-rehearsed and production-untouched, with nine things that must not be flipped

`check:census-integrity` recomputes Layover at `f71cfb85f` as **296 rows: C 83,
W 144, N 69**, which the census states itself at
`docs/architecture/census-layover.md:8565#C=83 W=144 N=69 X=0`.

**The census's apply-state wording is stale and must not be carried forward.**
Every sentence of the form *"applied to no database"* / *"unapplied
everywhere"* is false at `f71cfb85f` for `2700`, `2740`, `2745`, `2851`,
`2977`, `2981`, `2986` and `2992`. The correcting record is
`docs/migrations.md:3128#nine migrations applied to`,
whose table gives a per-file timestamp with an explicit *"not applied"* in the
production column, and `docs/architecture/migration-queue.md:46` for `2700`
(portava-ci `20260908145925`). The pattern is uniform:

| migration | portava-ci | production | source |
|---|---|---|---|
| `2700_layover_certified_feasibility` | ✓ `20260908145925` | **no** | `docs/architecture/migration-queue.md:46` |
| `2740_layover_presence_ladder_flag` | ✓ `20260908150439` | **no** | `docs/architecture/migration-queue.md:47` |
| `2745`, `2851` | ✓ 2026-09-15 | **no** | `docs/migrations.md:1606` |
| `2977` | ✓ 05:57:19 | **no** | `docs/migrations.md:3138` |
| `2981` | ✓ 05:59:41 | **no** | `docs/migrations.md:3139` |
| `2986` | ✓ 06:02:02 | **no** | `docs/migrations.md:3140` |
| `2992` | ✓ 06:05:51 | **no** | `docs/migrations.md:3142` |
| `2411` | — | **no** | `artifacts/api-server/src/migrations/2411_layover_recommendation_rec_key_backfill.sql:7#-- NOT APPLIED ANYWHERE.` — deliberately, measured OPTIONAL |

**The one hard ordering is written into the SQL, not into prose.**
`artifacts/api-server/src/migrations/2992_layover_decision_record_and_operational_tables.sql:252#-- DEPLOYMENT SEQUENCE — DO NOT DEVIATE`
gives five steps, and the precondition at `:323` raises by name if `2700` has
not run. Step 5 is explicit:
`artifacts/api-server/src/migrations/2992_layover_decision_record_and_operational_tables.sql:265#--   5. ONLY THEN flip`.

```
0127 (prod, baseline)
 ├─ 2410 (prod) ──> 2411 ──> [then, and only then, layover_stable_recommendation_ids_enabled]
 ├─ 2700 ──> 2992 ──> [then layover_decision_persistence_enabled]
 ├─ 2860 (prod) ──> 2981 ──> [needs LAYOVER_EVENT_PRODUCER_SECRET + a scheduled consumer]
 ├─ 2745 ──> [then LAYOVER_ROUTED_CORRIDOR_ENABLED + GOOGLE_MAPS_API_KEY]
 └─ 2740 · 2851 · 2977 · 2986   independent of each other
```

Rows the census attributes to each:

| apply | rows the census names |
|---|---|
| `2700` | L1, L5, L6, L191, L209, L240 (`docs/architecture/census-layover.md:1507#8. **Apply` — *"cannot leave `W`/`N` however good the code is"*), plus L95, L206, L207, L238, L233 |
| `2992` (after 2700) | L30, L194, L206, plus the `layover_constraints` / `layover_time_budgets` / `layover_return_plans` / `layover_checkpoints` / `layover_outcomes` family |
| `2740` | L128 |
| `2977` | L204, L246, L249 |
| `2851` | L276 |
| `2981` | L31, L263 |
| `2986` | points at L198; closes no row (it is a precondition for **volume**, not correctness — `docs/architecture/census-layover.md:7896`) |
| `2411`, `2745` | **zero census rows each.** `2411` protects moderation state across a flag flip; `2745` is a precondition for the routed provider |

**Two census misattributions to correct before anyone schedules work.**
`docs/architecture/census-layover.md:6096` says `layover_time_budgets` is *"in
migration 2700"* — it is created by `2992`, verified by grep over the canonical
tree. And `:7100` attributes L196 to `2740`; `2740` seeds one flag row and
creates no table, while the missing object is `layover_presence`, which **no
migration in the tree creates at all** (nor does any create
`layover_snapshots`). Rows resting on those two tables need a migration
**written**, not applied.

**The unsoundness premises, re-checked at HEAD.** One has moved and one has
not:

- *"Travel time is a 15/25-minute constant"* — **no longer true as stated.**
  The fabricated constants were deleted, and
  `artifacts/api-server/src/services/airport/LayoverTravelTime.ts:83#export const LAYOVER_TRAVEL_TIME_PROVIDER`
  now binds a corridor provider whose two gates refuse before a request body is
  built, so every landside leg answers a *named absence*
  (`minutes: null`, `source: "unmeasured"`, `reason: "NO_ROUTED_PROVIDER"`).
  **What is still constant is the buffer arithmetic**:
  `artifacts/api-server/src/services/airport/AirportProfileService.ts:103#const FALLBACK_PROFILE`
  supplies generic figures and production holds 3,206 `airport_profiles` with
  **0 verified and 0 carrying a non-default buffer**
  (`docs/architecture/census-layover.md:26`). So the deployed safety arithmetic
  is generic constants for 100 % of airports. That claim holds.
- *"The entry-permission check fails open"* — half closed. The gate exists and
  is reached (`artifacts/api-server/src/services/airport/layoverEntryGate.ts:116`),
  and it still does not *forbid*, with the reason stated rather than shrugged:
  `entry_requirements` has no INSERT in any migration, so forbidding on
  "not CONFIRMED_ALLOWED" would collapse landside exploration over a data gap.
  **The deployment consequence is the important part**:
  `docs/architecture/census-layover.md:8176#was already TRUE in production when the`
  — that flag is already TRUE, so **the behaviour change rides on the code
  deploy with no flag to stage it behind.** It also appears in §3's divergence
  set: `0169_traveler_passports_entry_requirements.sql:142` seeds it **false**,
  so its production TRUE was set outside any migration.

### The nine Layover things that must not move — carried verbatim

1. **`layover_decision_persistence_enabled` before BOTH `2700` and `2992` are
   applied and their postconditions confirmed.** The writer names every 2992
   column, supabase-js sends the whole payload, and the INSERT fails outright
   (`…/2992_…sql:265`).
2. **`LAYOVER_ROUTED_CORRIDOR_ENABLED` before `feasibilityInputHash` covers the
   corridor risk** — enabling it first *"would start certifying records whose
   inputs the hash does not cover"* (census §39).
3. **`LAYOVER_ROUTED_CORRIDOR_ENABLED` before `2745` is applied to production.**
   The first routed answer puts `travel_time_source` into the insert payload, and
   every recommendation insert then fails on a pre-2745 database.
4. **`layover_event_ingest_enabled` before a producer secret and a scheduled
   consumer exist.** The flag's own description:
   *"ENABLING THIS OPENS A WRITE PATH THAT MOVES SAFETY INPUTS … a producer that
   can publish one can move a traveller return deadline."* The secret is
   `artifacts/api-server/src/routes/layoverEvents.ts:113#LAYOVER_EVENT_PRODUCER_SECRET`.
5. **`layover_maturity_gate_enabled` without curating an airport to L1 first.**
   It *withdraws* every landside card everywhere, and 0 of 3,206 production
   airports reach L1.
6. **`layover_stable_recommendation_ids_enabled` before running `2411`'s
   precondition query.** If `legacy_moderated > 0`, `2411` must run first or
   upheld moderation silently un-upholds; `2411` itself refuses while the flag
   is already TRUE. The committed measurement
   (`artifacts/api-server/src/lib/capability/layover-cutover-measurement.json`)
   says `OPTIONAL` and says of itself that it is **vacuous for its purpose** —
   there was no moderated row to restore — and goes stale the moment one exists.
7. **Re-running `0127_layover_system.sql` after any operator flag decision.**
   `artifacts/api-server/src/migrations/0127_layover_system.sql:230#ON CONFLICT (flag) DO UPDATE SET enabled = EXCLUDED.enabled`
   — that is `DO UPDATE`, not `DO NOTHING`. Re-running it forces
   `airport_mode_enabled`, `layover_safety_engine_enabled`,
   `airport_pulse_enabled`, `layover_plans_enabled` and `layover_compass_enabled`
   **back to TRUE regardless of operator intent.** Every later layover flag
   migration uses `DO NOTHING`. This is the one layover migration that is not
   safe to re-run, and it is the only `DO UPDATE` of its kind found in this pass.
8. **Dropping `2992`'s tables before turning its gate off.** The file's own
   REVERSIBLE BY block: *turn the gate off first, and confirm it* — otherwise
   every `/safety` takes the `write_failed` path and the log reads as an outage.
9. **Do not treat the API code deploy as flag-neutral.** See the entry-gate
   point above: `passport_entry_intelligence_enabled` is already TRUE.

**How many of Layover's 144 `W` rows are deployment-gated: unknown.** The only
`W`-only partition is §13.1's *"(c) GATED — 19"* at
`docs/architecture/census-layover.md:2517`, measured when `W` was 138, before
`2860` was applied and before L197 left the group. No pass since has
re-partitioned the `W` column, and this document will not invent the number.

### 2.4 Highlights & Memories — the blocker is four flags, and one apply order runs backwards

The same reversal as Trips, and the census states it in its own words at
`docs/architecture/census-highlights-memories.md:4862#**Four flags, not one migration, are now what stands between this census and its next tranche of`.
The ten migrations that §M.2 named as blocking **117 rows** —
`2338`, `2339`, `2710`, `2711`, `2720`, `2721`, `2722`, `2723`, `2724`, `2730`
— are **all ten in the production record**, verified name-by-name. What replaced
them:

| flag | seeded at | production value (2026-09-22 capture) | rows |
|---|---|---|---|
| `memory_kernel_enabled` | `artifacts/api-server/src/migrations/2710_memory_command_kernel_tables.sql:282#memory_kernel_enabled` | `false` | ~20 — H175, H130–H133, H136–H141, H147–H149, H152–H154, H160, H29, H30 |
| `highlights_feed_bounded_enabled` | `artifacts/api-server/src/migrations/2339_highlights_feed_bound.sql:54#highlights_feed_bounded_enabled` | `false` | H103 |
| `memory_location_precision_enabled` | `artifacts/api-server/src/migrations/2338_memory_location_precision.sql:212#memory_location_precision_enabled` | `false` | H1, H76, H79 |
| `memory_public_feed_projection_enabled` | `artifacts/api-server/src/migrations/2338_memory_location_precision.sql:214#memory_public_feed_projection_enabled` | `false` | (same tranche) |

A caution on the row counts: §O.2's table at
`docs/architecture/census-highlights-memories.md:4847` writes the kernel tranche
as the range `H175, H130–H141, H147–H154, H160`, and the census itself records
at `:5819` that the range over-reaches by four — H134, H135, H150, H151 are `N`
on their own rows because `MERGE_MEMORY` / `SPLIT_MEMORY` are not declared.
Anyone reading that table as a row list overcounts by four.

**Still unapplied, and genuinely blocking**, with every ordering edge taken from
the files' own `RAISE EXCEPTION` blocks:

```
2710 (applied) ──> 2993 ──> 3001
                     └────> 2994        (needs 2710 AND 2993)
                              └┄┄ EPISODE arm only: needs 2320
2723 (applied) ──> 3502 ──> 2975        RUNS BACKWARDS AGAINST ITS OWN NUMBERS
2970                                    independent (another lane's file)
```

- `artifacts/api-server/src/migrations/2993_highlight_command_boundary.sql:209#apply 2710 first`
- `artifacts/api-server/src/migrations/3001_highlight_kernel_admits_unhide.sql:70#3001 requires 2993`
- `artifacts/api-server/src/migrations/2994_memory_relations_and_outbox_consumer.sql:142#apply 2710 first`
  and `:150#apply 2993 first`

| apply | rows that become gradable |
|---|---|
| `2993`, then `3001` | H142, H143, H145, H158, H159 — **all five also need `memory_kernel_enabled`**, so neither apply moves a verdict on its own |
| `2994` (after 2993) | H27, H30, H161, H162, H220 |
| `3502` **then** `2975` | H98 |
| `2320` | H23, H24, H120 (partly), plus 2994's EPISODE arm |
| `2970` (other lane) | H4, H239 |

**`3502 → 2975` is the sharpest hazard in this whole document, and nothing
mechanical enforces it.** It is recorded in the owner's own runbook, added two
days ago, at `docs/architecture/manual-production-migration-runbook.md:38#3502 ──> 2975`:

> RUNS BACKWARDS AGAINST ITS OWN NUMBERS, and nothing mechanical enforces it: a
> lexicographic replay of the chain applies 2975 first […] So 2975 applied alone
> makes every PERMANENT Highlight insertable, updatable and SELECTABLE BY
> NOBODY, its own owner included — a write-only record, for as long as the
> window stays open.

The runbook adds that both files are on `main`, neither is applied, and *"the
hazard above is not a reservation about future work — it is live for the next
person who replays this chain in file order"*
(`docs/architecture/manual-production-migration-runbook.md:53`). The census
mentions neither `3502` nor the ordering at all, and `3502` is absent from this
census's `CENSUS_SCOPE`, so the freshness guard will not age the document when
`3502` changes. **Treat the runbook, not the census, as authoritative here.**

Two more things in this surface that are not deployment items:

- **`2150_passport_memories_write_boundary.sql` is no longer a blocker.** §AB.4
  at `docs/architecture/census-highlights-memories.md:6577` measured the hosted
  database on 2026-10-03 and found `anon`/`authenticated` hold no INSERT/UPDATE
  on the seven `passport_memories` columns — the boundary 2150 writes is already
  in effect. H204 stays `X` only because *"a verdict moves only on code plus a
  test, and this pass wrote neither"*.
- **Thirteen rows already graded `C` are endangered, not unblocked, by a key.**
  `docs/architecture/census-highlights-memories.md:4425` marks H115–H119, H121,
  H122, H125, H127, H128, H109, H70 and H74 with `⌀`: if
  `AI_INTEGRATIONS_OPENAI_API_KEY` is unset in production, none has ever
  executed there. That is open question **D-C2** and it is **unknown**.

### 2.5 Three chains that are already written down, and should not be re-derived

These are committed, dependency-ordered and better than anything this document
would invent. They are listed here so the ordering in §5 composes with them
rather than competing.

| surface | the chain | where it is written |
|---|---|---|
| Sensing | `2277 → 2278 → 3002 → 3003 → 3310` inside **one quiesced window**, with `3311` before the code, `3312` before the **client** build, `3314` before `memory_projection` goes ON, `3315` before `surface` is granted, and `3004`/`3110`/`3313` any time before the flips | `docs/ops/sensing-cutover-runbook.md:72` (the graph) and `:148` (the per-step table, with a rollback file per step) |
| Discovery | batches P0 → P1 → P2 → P3, then deploy, then flags in a stated order; 25 numbered owner actions each carrying the count of rows it unblocks | `docs/ops/discovery-production-rollout.md:28` and `docs/ops/discovery-owner-approval-request.md:56` |
| Layover decision record | `2700` then `2992`, in that order, neither run | `docs/architecture/migration-queue.md:158` |

Discovery's action table is the single best instance of the shape this document
is asking for, and it is worth reading directly: action 3 (apply P0+P1, 59
files, after a restore point) unblocks **59 rows**; action 4 (deploy the API,
then ship the client) **27**; action 5 (twelve non-ranking flags, one at a
time) **16**; action 8 (PDE serves) **12**; action 24 (the creator ledger)
**15**. Its own summary at `docs/ops/discovery-owner-approval-request.md:26`
splits the open rows **51 wait only on production / 36 wait on an owner policy
answer**.

---

## 3. Flags

### Re-derived counts

Every figure in this section was re-derived at `f71cfb85f` by replicating the
repo's own seed scanner — the quote-aware, schema-qualifier-tolerant matcher at
`artifacts/api-server/scripts/check-flag-polarity.mjs:1888` — over the canonical
tree, and intersecting the result with the `flags` object of the 2026-09-22
snapshot. The guard's own banner agrees on the seeded figure: *"299 flags seeded
across 683 migrations (172 INSERT statements)"*.

| Measure | **Re-derived** | 2026-10-03 figure | How |
|---|---|---|---|
| Distinct flag names seeded by the canonical tree | **299** | 305 | 172 `INSERT INTO [schema.]feature_flags` statements over 683 files; first row literal per name |
| Flag rows in the production capture | **201** | 201 | `flags` object of `20260922-production-schema.json` |
| …of which read TRUE | **107** | 106 | count of `true` values in that object |
| …of which read FALSE | **94** | — | 201 − 107 |
| Seeded **and** present in production | **198** | — | set intersection |
| **Seeded, with no production row at all** | **101** | 107 | set difference |
| Present in production, seeded by nothing | **3** | — | `COMPASS_JOURNEY_ENGINE_ENABLED`, `COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED`, `COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED` |
| Seeded FALSE in the tree, TRUE in production | **73** | 72 | per-name comparison, last seeding statement wins |
| Seeded TRUE in the tree, FALSE in production | **1** | — | `COMPASS_FALLBACK_MODE_ENABLED` |

`198 + 3 = 201` and `299 − 198 = 101` both hold. The older counts in
`docs/ops/flag-disposition.md:17` (152 seeded / 168 live / 14 seeded-absent,
read 2026-08-12) and `docs/ops/unseeded-flag-inventory.md:1` (superseded in
full) are earlier populations, not disagreements; the disposition **rule** at
`docs/ops/flag-disposition.md:63` is unchanged and still governs.

### The 101 with no production row — why they are the sharpest item, and why they are the *safest*

A flag with no row cannot be turned on. `isFlagEnabled` fails closed, the admin
list has nothing to show, and `PATCH` has no row to patch — enabling one needs
an **INSERT**, which is a different operation from a toggle. The repository
already states the consequence, in the migration written for exactly this
class, at
`artifacts/api-server/src/migrations/2300_phantom_feature_flag_rows.sql:21#-- RUNTIME EFFECT OF THIS MIGRATION: NONE.`:

> Every row is seeded false, which is the exact value each reader was already
> resolving to. What changes is that an operator can now turn them on.

**All 101 are seeded FALSE.** That was checked, not assumed: the polarity of
every one of the 101 seeding row literals is `false`. So the INSERT half is
runtime-neutral by construction — it moves a capability from *unflippable* to
*flippable* and changes no behaviour. The risk lives entirely in the second
step, the flip, which this document does not recommend taking for any of them.

**The unit of application is the migration, not the flag.** 76 distinct
migrations seed the 101, and the sixteen that carry more than one are where a
single apply buys the most flippability:
`3475_discovery_trend_v2_flags.sql` (5), `2300_phantom_feature_flag_rows.sql`
(5), `3500_discovery_surface_objective_rank_flags.sql` (3),
`3483_discovery_pipeline_stages_flags.sql` (3),
`2350_map_sensing_projection_flags.sql` (3), and `3496`, `3490`, `3485`, `3480`,
`3468`, `3467`, `3465`, `3453`, `2956`, `2336`, `2279` (2 each).

The 101 names follow, alphabetically, each with the line carrying its name
literal. **A note on the line numbers, because they differ from the guard's by
one in places.** `check-flag-polarity.mjs` reports the line of the row literal's
opening parenthesis; where a migration formats a seed row across several lines
(`2300` does, `2810` does not), that paren sits one line above the name. The
numbers below point at the **name**, so each one can be checked by eye and can
carry an anchor. Every one was verified: the cited line contains the cited flag
name in all 101 cases.

| flag | seeded at (the line carrying the name literal) |
|---|---|
| `COMPASS_TELEGRAPH` | `2300_phantom_feature_flag_rows.sql:135` |
| `MEDIA_HIDDEN_GEMS_NEARBY_ENABLED` | `2300_phantom_feature_flag_rows.sql:120` |
| `MEDIA_TAB_WORLD_DEFAULT_ENABLED` | `3340_media_tab_world_default_flag.sql:50` |
| `MEDIA_WATCH_CONTEXT_OVERLAY_ENABLED` | `3341_media_watch_context_overlay_flag.sql:43` |
| `MEDIA_WATCH_STAGE24_RANKING_ENABLED` | `3343_media_watch_stage24_ranking_flag.sql:51` |
| `MEDIA_WATCH_TAP_TO_PLAY_ENABLED` | `3342_media_watch_tap_to_play_flag.sql:42` |
| `MEDIA_WORLD_SHELL_ENABLED` | `2300_phantom_feature_flag_rows.sql:115` |
| `PORTAVA_FEATURED_BOOST_ENABLED` | `2300_phantom_feature_flag_rows.sql:130` |
| `PORTAVA_PUBLISHER_BOOST_ENABLED` | `2300_phantom_feature_flag_rows.sql:125` |
| `SEARCH_SIGNAL_DECAY_DAYS` | `2306_search_signal_decay_flag_row.sql:70` |
| `compass_city_confidence_windowed_reads_enabled` | `3484_compass_city_confidence_provenance.sql:72` |
| `compass_graph_decay_enabled` | `3469_compass_graph_decay_flag.sql:36` |
| `creator_attribution_enabled` | `2922_creator_attribution_flag.sql:59` |
| `discovery_buddy_launch_gate_enabled` | `2360_discovery_buddy_launch_gate_flag.sql:45` |
| `discovery_cache_a_ranked_enabled` | `3456_discovery_cache_a_ranked_flag.sql:46` |
| `discovery_candidate_sources_enabled` | `3480_discovery_candidate_sources_flag.sql:52` |
| `discovery_circle_candidates_enabled` | `3480_discovery_candidate_sources_flag.sql:57` |
| `discovery_cold_start_enabled` | `3482_discovery_cold_start_flag.sql:43` |
| `discovery_community_byline_canonical_enabled` | `3490_discovery_serve_path_flags.sql:53` |
| `discovery_diversity_axes_enabled` | `3454_discovery_diversity_axes_flag.sql:44` |
| `discovery_dwell_telemetry_enabled` | `3395_discovery_dwell_telemetry_flag.sql:57` |
| `discovery_engagement_integrity_enabled` | `3451_discovery_engagement_integrity_flag.sql:37` |
| `discovery_exploration_inventory_enabled` | `3481_discovery_exploration_inventory_flag.sql:46` |
| `discovery_feature_families_enabled` | `3452_discovery_feature_families_flag.sql:37` |
| `discovery_for_you_pde_enabled` | `3455_discovery_for_you_pde_flag.sql:50` |
| `discovery_integrity_stage_enabled` | `3483_discovery_pipeline_stages_flags.sql:50` |
| `discovery_intent_term_enabled` | `3453_discovery_intent_trip_terms_flags.sql:40` |
| `discovery_live_rank_enabled` | `2850_discovery_live_rank_flag.sql:39` |
| `discovery_outcome_learning_enabled` | `3483_discovery_pipeline_stages_flags.sql:55` |
| `discovery_output_kinds_enabled` | `3483_discovery_pipeline_stages_flags.sql:60` |
| `discovery_place_cooccurrence_enabled` | `3496_discovery_w11x3_flags.sql:39` |
| `discovery_platform_graph_provenance_enabled` | `3490_discovery_serve_path_flags.sql:58` |
| `discovery_ranking_modifiers_enabled` | `2289_discovery_ranking_modifiers_flag.sql:55` |
| `discovery_search_protected_zones_enabled` | `3366_discovery_search_protected_zones_flag.sql:48` |
| `discovery_stop_enforcement_enabled` | `3470_discovery_stop_enforcement_flag.sql:69` |
| `discovery_surface_objectives_enabled` | `3450_discovery_surface_objectives_flag.sql:41` |
| `discovery_trail_exploration_enabled` | `3485_discovery_trail_exploration_flags.sql:58` |
| `discovery_trail_health_order_enabled` | `3485_discovery_trail_exploration_flags.sql:63` |
| `discovery_trail_objective_rank_enabled` | `3500_discovery_surface_objective_rank_flags.sql:53` |
| `discovery_trend_lists_enabled` | `3475_discovery_trend_v2_flags.sql:77` |
| `discovery_trend_normalised_enabled` | `3475_discovery_trend_v2_flags.sql:59` |
| `discovery_trend_post_convergence_enabled` | `3496_discovery_w11x3_flags.sql:44` |
| `discovery_trend_rebuild_scheduler_enabled` | `3475_discovery_trend_v2_flags.sql:65` |
| `discovery_trend_rediscovery_retest_enabled` | `3475_discovery_trend_v2_flags.sql:83` |
| `discovery_trend_snapshot_retention_enabled` | `3475_discovery_trend_v2_flags.sql:71` |
| `discovery_trending_api_enabled` | `3410_discovery_trend_snapshot_parity.sql:239` |
| `discovery_trending_objective_rank_enabled` | `3500_discovery_surface_objective_rank_flags.sql:58` |
| `discovery_trip_match_enabled` | `3453_discovery_intent_trip_terms_flags.sql:45` |
| `discovery_trip_planning_objective_rank_enabled` | `3500_discovery_surface_objective_rank_flags.sql:63` |
| `discovery_trip_viewer_projections_enabled` | `3467_cross_architecture_flags.sql:45` |
| `event_start_transition_enabled` | `2600_event_start_transition_flag.sql:82` |
| `experience_session_enabled` | `2841_experience_session_flag.sql:46` |
| `intel_calibration_report` | `2279_intel_historical_patterns.sql:178` |
| `intel_live_scope_admin_surface_enabled` | `2570_intel_live_scope_admin_surface_flag.sql:107` |
| `intel_outcome_attribution_enabled` | `2277_intel_outcomes_attribution.sql:259` |
| `intel_pattern_learning` | `2279_intel_historical_patterns.sql:173` |
| `intel_safety_candidates_enabled` | `2803_intel_safety_candidates_flag.sql:71` |
| `intel_sensing_credentials_enabled` | `2956_privacy_safe_sensing_credentials.sql:152` |
| `intel_sensing_device_enrollment_enabled` | `2956_privacy_safe_sensing_credentials.sql:153` |
| `layover_decision_persistence_enabled` | `2992_layover_decision_record_and_operational_tables.sql:752` |
| `layover_event_ingest_enabled` | `2981_layover_event_ingest_flag.sql:107` |
| `layover_live_intersection_enabled` | `2851_layover_live_intersection_flag.sql:42` |
| `layover_maturity_gate_enabled` | `2977_layover_maturity_gate_flag.sql:91` |
| `layover_place_dwell_enabled` | `3465_layover_consumer_flags.sql:52` |
| `layover_presence_ladder_enabled` | `2740_layover_presence_ladder_flag.sql:84` |
| `layover_snapshot_consumers_enabled` | `3465_layover_consumer_flags.sql:47` |
| `location_snapshot_purge_enabled` | `2129_location_snapshot_purge_flag.sql:55` |
| `map_contributions_enabled` | `2216_map_observations.sql:86` |
| `map_crowd_flow_enabled` | `2218_crowd_flow.sql:58` |
| `map_display_resolver_enabled` | `2350_map_sensing_projection_flags.sql:86` |
| `map_experience_state_enabled` | `2350_map_sensing_projection_flags.sql:76` |
| `map_projection_enabled` | `2201_map_projection_flag.sql:17` |
| `map_world_intelligence_enabled` | `2295_map_world_intelligence_flag.sql:77` |
| `map_world_moments_enabled` | `2350_map_sensing_projection_flags.sql:81` |
| `media_canonical_read_enabled` | `2336_media_canonical_control_flags.sql:120` |
| `media_canonical_schema_fallback_enabled` | `2336_media_canonical_control_flags.sql:115` |
| `media_captions_enabled` | `3358_media_captions_flag.sql:41` |
| `media_evidence_enabled` | `2255_media_evidence_seam.sql:56` |
| `media_find_busier_enabled` | `3351_media_find_busier_flag.sql:43` |
| `media_moderation_classifier_enabled` | `3356_media_moderation_classifier_flag.sql:52` |
| `media_neighborhood_only_mode_enabled` | `3350_media_neighborhood_only_location_mode.sql:67` |
| `media_pending_upload_sweep_enabled` | `3400_media_pending_upload_sweep_flag.sql:49` |
| `media_perspective_vantage_enabled` | `3352_media_perspective_vantage.sql:78` |
| `media_processing_worker_enabled` | `3338_media_processing_worker_flag.sql:54` |
| `media_request_a_view_enabled` | `2257_media_view_requests.sql:63` |
| `media_transcoder_enabled` | `3357_media_transcoder_flag.sql:39` |
| `media_vision_provider_enabled` | `3355_media_vision_provider_flag.sql:45` |
| `memory_recaps` | `2214_memory_recaps.sql:57` |
| `nearby_reachable_enabled` | `2990_nearby_reachable_flag.sql:57` |
| `passport_event_share_enabled` | `2294_event_passport_shares.sql:170` |
| `passport_telemetry_enabled` | `2287_passport_telemetry_events.sql:149` |
| `sensing_presence_context_enabled` | `3004_sensing_presence_context_flag.sql:71` |
| `sensing_publication_enabled` | `3313_sensing_publication_flag.sql:43` |
| `tag_permission_approval_required_enabled` | `3468_tag_permission_approval_required.sql:51` |
| `tag_permission_consent_copy_enabled` | `3468_tag_permission_approval_required.sql:56` |
| `telegraph_discovery_actions_enabled` | `3467_cross_architecture_flags.sql:50` |
| `telegraph_live_references_enabled` | `2802_telegraph_live_references_flag.sql:48` |
| `telegraph_message_kernel_enabled` | `2810_telegraph_message_kernel.sql:420` |
| `telegraph_report_evidence_enabled` | `2812_telegraph_report_evidence.sql:160` |
| `telegraph_request_origin_enabled` | `2813_telegraph_request_origin.sql:132` |
| `wall_moments_enabled` | `2801_wall_moments_flag.sql:42` |

Paths are relative to `artifacts/api-server/src/migrations/`.

### The flag→schema dependency, machine-checked and offline

`artifacts/api-server/src/scripts/checkFlagSchemaPrerequisites.ts` is the
authority that matters most for ordering, because it grades every flag read in
the tree against the committed snapshot with no database access. Run at
`f71cfb85f` it reports:

```
OK — 2 unguarded (all known), 0 guarded, 37 latent
snapshot ajrurzioarfkagpuxfnb captured 2026-09-22T16:07:23Z (12 days ago):
  497 relations, 164 functions, 201 flag rows (107 on)
```

- **2 UNGUARDED** — flag TRUE in production, code names schema production lacks,
  no capability guard: `intel_capture_quick_signal` and `intel_trail_followup`,
  both missing `intel_contributor_token()` at
  `artifacts/api-server/src/services/intel/IntelCaptureService.ts:412`. These
  are ON and dead today; the fix is the apply, not the flag.
- **37 LATENT** — schema absent, flag OFF or no row: *"one UPDATE away from
  UNGUARDED."* This is the list that says which apply must precede which flip,
  object by object. Notable edges it names: `layover_decision_persistence_enabled`
  → `layover_certified_computations`, `layover_return_plans`,
  `layover_time_budgets`; `telegraph_message_kernel_enabled` →
  `message_reactions`, `messages`, `telegraph_unsend_message_before_seen()`;
  `memory_projection` → `memory_projections`, `memory_are_new_to_user()`,
  `memory_remembers_for_user()`; `rent_buddy_enabled` →
  `rent_buddy_earnings_entries`, `rent_buddy_requests`.

The two counts move in opposite directions for the same action, and the
ordering rule falls straight out of it: **every latent flag becomes unguarded if
it is flipped before its migration lands.** The 2026-09-08 pass recorded the
same lesson at `docs/architecture/on-and-dead-flag-matrix.md:27` — *"striking an
entry makes the report shorter, applying the migration makes the statement
true."*

### The 73 seeded-FALSE-in-tree / TRUE-in-production

This set is a divergence, not a backlog: production is ahead of the tree's seed
for 73 names (and behind it for one, `COMPASS_FALLBACK_MODE_ENABLED`). It
matters here only as a hazard for re-application — a seed migration re-run over
a flipped flag must survive it, which `2740` was explicitly rehearsed for
(`docs/architecture/migration-queue.md:52`, the owner-flip survival test).

**Nothing in this document recommends changing any of the 73.** Several are
safety, privacy, identity or consent controls that are currently ON
(`safe_return_enabled`, `safe_return_live_share_enabled`,
`safe_return_trusted_circle_alerts_enabled`, `trip_crew_live_share_enabled`,
`trip_crew_ghost_mode_enabled`, `trust_gaming_detection_enabled`,
`passport_contribution_enabled`), and they stay exactly as they are.

---

## 4. What each blocked item is blocked on

One category per item. The counts are over the committed ledgers, not over
census rows.

### 4.0 Needs only a flag flip — the category that turned out to be largest

This category was not in the brief and it should have been. For three of the
four surfaces traced, **the schema is already in production and the blocker is a
`feature_flags` UPDATE on a row that exists**:

| surface | flags | rows | prerequisite that is not the apply |
|---|---|---|---|
| Trips | `trip_operational_projections_enabled`, then `trip_kernel_enabled` | **102** | confirm the deployed build, then four credentialed checks (`docs/TRIPS-PRODUCTION-ACTIVATION.md:100`) |
| Highlights & Memories | `memory_kernel_enabled`, `highlights_feed_bounded_enabled`, `memory_location_precision_enabled`, `memory_public_feed_projection_enabled` | **~24** | the §P.2 NULL-reading decision for H75/H200 needs a back-fill migration *before* the flip, or the surfaces go dark |
| Layover | `layover_stable_recommendation_ids_enabled` (L97, L296, L117, L122), `layover_discovery_mode_enabled` (L269), `layover_safe_return_status_enabled` (L33) | **6** | `2411`'s precondition query for the first; a verified deployed consumer for the second |
| Telegraph | `telegraph_history_bound_enabled` | 5 | the four read paths that do not read the bound on `origin/main` must deploy first |

**That is roughly 137 census rows whose entire remaining distance is one
`UPDATE` each — and not one of those updates is safe to take today**, because
every one of them has a stated prerequisite that is a deploy, a decision or a
measurement. Which is the actual shape of this backlog: the applies are mostly
done or safe; the flips are gated on things that are not applies.

### 4.1 Needs an owner decision — 19 open, plus Discovery's 8 questions

`docs/architecture/blocker-ledger.md:116` is the register. Its P5 table carries
**19 rows** at `f71cfb85f`, one of them already resolved and kept for the
record (`WALL_ACCENT_COLOUR`, resolved 2026-09-14). Named, with what each
decides:

`SENSING_AUTH_POSTURE` (bound by `2481`; under Option B that file is never run)
· `MEDIA_CANONICAL_FLAG` (whether to turn the canonical writer back ON — `3321`
requires it before it will run on production) · `LOCATION_PRECISION_DEFAULT` ·
`STORY_HIGHLIGHT_VISIBILITY` (**ruled** 2026-09-15; reopening it is a build) ·
Layover L50 (what BLOCKED means on screen) · `EVENT_START_TRANSITION` (bound by
`2600`, not applied) · `MAP_CANCELLED_TRIP_VISIBILITY` ·
`PASSPORT_CREW_PRESENCE_AUDIENCE` · `GEM_MODERATION_AUDIT_ORDERING` ·
`SAVE_COUNT_UNSAVE_ASYMMETRY` · `RAB_EARNINGS_LEDGER_VOIDING` ·
`TRUST_OVERRIDE_PIN_OR_CAP` · `MESSAGING_DEGRADED_READ_POSTURE` ·
`TRIP_CREW_SIGNAL_ROLE_COVERAGE` · `LAYOVER_RETURN_REMINDER_DELIVERY` ·
`MODERATION_TARGET_NULLABILITY` · `INTERACTION_COOLDOWN_READ_DIRECTION` ·
`PASSPORT_DARK_MODE_FIRST`.

Three of these **block a migration outright** and are therefore ordering
constraints, not just open questions, per `docs/architecture/migration-queue.md:60`:
`2470` (`MEDIA_CANONICAL_FLAG` — *"applying takes the decision"*), `2481`
(`SENSING_AUTH_POSTURE` — its CHECK *encodes* Option A), and `2250`
(`do_not_apply` as written: its own postcondition asserts the flag is FALSE and
it is TRUE, so it fails on itself).

Discovery adds **8 questions** on top — actions 9, 11, 12, 15, 16, 17, 18, 22
and 25 of `docs/ops/discovery-owner-approval-request.md:56`, covering consent,
retention, money and one product definition. Its own summary counts **36 open
census rows waiting on a policy answer**.

### 4.2 Needs a provider key or environment variable — 8 named

| What | The variable(s) | Evidence |
|---|---|---|
| Identity verification (Trust TV-6a, decision `D-PROVIDER`) | `IDENTITY_PROVIDER`, then `STRIPE_IDENTITY_SECRET_KEY` **or** `PERSONA_API_KEY` + `PERSONA_TEMPLATE_ID`, plus `IDENTITY_WEBHOOK_SECRET` | `docs/architecture/census-trust.md:739`; `artifacts/api-server/src/services/identityVerification/readiness.ts:53#const IMPLEMENTED_PROVIDERS` declares only `"mock"` |
| Every Compass AI tool, and 13 Highlights/Memories rows already graded `C` | `AI_INTEGRATIONS_OPENAI_API_KEY` | `artifacts/api-server/src/lib/openai.ts:4#AI_INTEGRATIONS_OPENAI_API_KEY`; `docs/architecture/census-compass.md:3398` records it unset, with the client constructed as `apiKey: "not-configured"` |
| Sensing anonymous ingest and snapshot sealing | `SENSING_CONTRIBUTOR_PEPPER`, `INTEL_EVIDENCE_REFERENCE_KEY` | `docs/architecture/census-sensing.md:6197`; the pepper edge is in the cutover graph at `docs/ops/sensing-cutover-runbook.md:88` — without it the anonymous ingest refuses every caller **by design** |
| Layover routed travel time — the whole §8 family | `LAYOVER_ROUTED_CORRIDOR_ENABLED` **and** `GOOGLE_MAPS_API_KEY`, enablement checked first | `artifacts/api-server/src/lib/providers/googleRoutesCorridorProvider.ts:100#export const ENABLEMENT_ENV = "LAYOVER_ROUTED_CORRIDOR_ENABLED";`. Carries an **owner spend decision**: billed per request, no ceiling in the repo |
| Trips routed travel time (TR128, TR267, TR341, TR412) | `GOOGLE_MAPS_API_KEY` already exists for Places; what is missing is the owner **enabling the Routes API** in the same Cloud project and accepting per-call spend | `artifacts/api-server/src/domain/trips/contracts/GoogleRoutesTravelTimeProvider.ts:4#WIRED 2026-10-05` (it read "PREPARED, NOT WIRED" when this was written; lane C wired it behind the quota and budget gate — census-trips §80.2, §82); three seams still bind the straight-line provider, e.g. `artifacts/api-server/src/routes/tripFeasibility.ts:113#const PROVIDER = TRIP_TRAVEL_TIME_PROVIDER;` (it read "const PROVIDER = straightLineTravelTimeProvider;" when this was written) |
| Layover event ingest (L31, L263) | `LAYOVER_EVENT_PRODUCER_SECRET`, plus a scheduled consumer that does not exist | `artifacts/api-server/src/routes/layoverEvents.ts:113#LAYOVER_EVENT_PRODUCER_SECRET` — unset refuses rather than opens |
| Trips offline bundle (TR174) | `TRIP_OFFLINE_BUNDLE_SECRET`, falling back to `SESSION_SECRET` | `artifacts/api-server/src/domain/trips/services/TripOfflineBundle.ts:127#TRIP_OFFLINE_BUNDLE_SECRET`, enforced at `artifacts/api-server/src/routes/tripOffline.ts:74#is not set` |
| Mobile store/dev builds through CI | `EXPO_TOKEN` in GitHub Actions secrets | `docs/eas-runbook.md:105` |

**Identity verification is an identity control and this document takes no
position on arming it.** It is listed because the blocker is a key and an owner
decision, and a map that omitted it would be wrong. The same restraint applies
to the two spend decisions: they are named, not recommended.

### 4.3 Needs an EAS rebuild — 1 named, and a structural note

`II-TM-A1` at `docs/architecture/census-input-intelligence.md:5345` is the one
item in the censuses whose blocker is explicitly a native build:
`expo-speech-recognition` with its config plugin, plus
`NSSpeechRecognitionUsageDescription`. The census states the constraint
plainly: *"It is a NATIVE module: it needs a new development/store build — an
OTA update cannot add it, and Expo Go cannot load it. Cost $0; no key."* It
unblocks G163 with one device run; the owner is deciding the dependency, the
rebuild, and the dictation consent posture.

**The structural finding is larger than that one row, and no census records it:
there is no OTA channel at all.** Measured at `f71cfb85f` against
`travel-buddy-standalone/package.json` and `travel-buddy-standalone/app.json`:
`expo-updates` is **absent from both `dependencies` and `devDependencies`**,
there is **no `updates` key** in `app.json`, and **no `runtimeVersion`**.
`travel-buddy-standalone/eas.json:1` configures three build profiles
(`development`, `preview`, `production`) and no update channel.

So **every client-side change in this backlog reaches a traveller only through
a native build and a store submission** — there is no "ship the client" step
that is cheaper than that. The censuses do not have a bucket for this: Trips,
Layover and Highlights & Memories each contain zero matches for `EAS`,
`TestFlight` or `app store`, and Layover's partition files its client-side rows
under *"blocked on a file another lane owns"*, which silently merges "code not
written" with "code written, cannot ship". **Recommend adding "EAS build +
store submission" as its own category in whatever supersedes this document.**

The pipeline itself is configured — `eas.json` exists, `app.json` carries both
bundle identifiers (`com.passporttravelbuddy.app`) and an EAS `projectId` — so
a build is an operator action, not a build-out. Whether any build has **shipped**
is **unknown** from the tree: the last committed statement is
`docs/architecture/deployment-readiness.md:46`, where `Mobile deployed` reads
`no` for every surface, and that table is dated 2026-09-08 and records 35
applied migrations against today's 129, so it is stale in the dimension that
matters.

### 4.4 Needs a migration applied first

§2 is its content. The summary form:

- **Telegraph** — 51 rows behind `2325`/`2810`/`2811`/`2812`/`2400`/`2217`/`2989`/`2990`/`2991`/`3000`.
  This is the only surface of the four where the apply is still the dominant
  blocker.
- **Layover** — `2700` then `2992` for the decision record, plus `2740`,
  `2851`, `2977`, `2981`, `2986`. All CI-rehearsed, none in production.
- **Highlights & Memories** — `2993` → `3001`, `2994`, `3502` → `2975`, `2320`,
  and `2970` (another lane's). ~12 rows, and five of them also need a flag.
- **Trips** — `2797` → `2798` → `2799` only, for TR427. Everything else the
  census names is applied.
- **Sensing** — ten files absent from production, listed with dates at
  `docs/ops/sensing-cutover-runbook.md:21`.
- **Discovery** — 59 files in batches P0+P1 (`docs/ops/discovery-owner-approval-request.md:60`, action 3).
- **Flag-level** — the 37 latent entries from `check:flag-schema-prerequisites`,
  each naming the absent objects by name.

A migration that **nobody has written** is not in this category and is not a
deployment item. Trips has 10 such rows; Telegraph has 89 rows blocked on
something in neither tree (`docs/architecture/census-telegraph.md:4015`);
Layover's `layover_snapshots` and `layover_presence` have no `CREATE TABLE`
anywhere in the canonical tree.

### 4.5 Deliberately held, with a reason

`docs/architecture/blocker-ledger.md:338` lists four: **Ranker** (held, not
started, not planned in this pass), **Phase F** (frozen), **Event Truth
Phase-B** (gated), **SX-11** (must not start).

Two more are held for stated reasons rather than appearing in that table:
`2411` was **measured and found OPTIONAL** (30 rows, all unkeyed, nothing to
preserve) and `2600` encodes the open `EVENT_START_TRANSITION` decision —
*"neither is a backlog item"* (`docs/architecture/migration-queue.md:25`).
`2217`'s table ships empty by design. `2893` is explicitly *"last, or never"*
(`docs/ops/discovery-owner-approval-request.md:78`, action 21).

### 4.6 The cross-cutting ordering hazards — four, and three of them bite silently

The authoritative list of hard orderings is
`docs/architecture/manual-production-migration-runbook.md:20#Dependency chain — the only hard orderings`,
last amended 2026-10-02. At `f71cfb85f`:

1. **`3502` before `2975`, against their own numbers, with nothing enforcing
   it.** Covered in full in §2.4. *"2975 applied alone makes every PERMANENT
   Highlight insertable, updatable and SELECTABLE BY NOBODY, its own owner
   included."* The runbook is explicit that this is live for the next person who
   replays the chain in file order. **This is the single most dangerous item in
   the backlog, because the wrong order produces no error — just a write-only
   record.**
2. **`2224` before `2333`.** `2333` REVOKEs on `route_flow_contribution_consent`
   and `sensing_anon_contributions`; a REVOKE against an absent relation is an
   ERROR, so `2333` as originally written would have **aborted and landed
   nothing**. `2315` is in the record; `2224` and `2333` are not. The edge is
   therefore still live.
3. **`2217` before any flip of `map_projection_enabled`** — *"without
   protected_zones the gateway cannot serve"*, per the same runbook graph.
4. **PR #461's `2313` after `2530` reopens a closed security defect.** It
   reproduces the `trip_members` self-join that production-applied `2530`
   removed, letting removed members and pending invitees read trip-scoped
   highlights. `docs/architecture/deployment-readiness.md:193` states it; the
   rebase patch is committed at
   `docs/architecture/pr461-2313-rebase-onto-2530.patch`. **This holds
   regardless of merge order and must be checked before any `23xx` apply.**

And one that is not an ordering but a re-run hazard, found in this pass:
**`0127_layover_system.sql` is the only migration seen here whose flag seed is
`ON CONFLICT (flag) DO UPDATE SET enabled = EXCLUDED.enabled`**
(`artifacts/api-server/src/migrations/0127_layover_system.sql:230`). Re-running
it forces five airport flags back to TRUE regardless of operator intent. Every
later flag migration in the tree uses `DO NOTHING`, and `2740` was explicitly
rehearsed for owner-flip survival (`docs/architecture/migration-queue.md:52`).
`0127` is the exception and it is not safe to re-run after an operator decision.

---

## 5. An ordered activation path

### The rule the order follows

Four states, and none implies the next
(`docs/architecture/deployment-readiness.md:13`): `DEPLOY_READY` is not
`DEPLOYED_FLAG_OFF` is not `DEPLOYED_FLAG_ON` is not `PRODUCTION_REALIZED`.
From that, three sequencing rules that the committed runbooks already follow:

1. **Schema before code, code before flag.** A flipped flag over absent schema
   is the UNGUARDED state, and supabase-js *resolves* on a database error, so
   the failure is silent.
2. **Never batch.** `docs/architecture/migration-queue.md:166` — sequential, in
   verified dependency order, postconditions inside the apply transaction so a
   failure rolls back whole, before-state captured for anything that changes an
   authorization predicate.
3. **A migration that would resolve an unresolved owner decision is not
   applied, however safe it looks.** That is `2470`, `2481`, `2250` and `2600`.

### The first three steps, spelled out

**Step 1 — refresh the production capture. Nothing else should move first.**
Everything in §1 and §3 is graded against a snapshot that is twelve days old,
and `checkFlagSchemaPrerequisites` is built to fail when the applied-migrations
record runs ahead of the snapshot watermark, precisely so a stale snapshot is
caught offline. A new `snapshots/<date>-production-schema.json` plus the
`current.ts` pointer re-derives every count here, converts several **unknown**s
below into facts, and costs one read. It is the only step that changes nothing
and improves every later decision. *Blocked on:* a read-only production
capture, which this session is not permitted to take.

**Step 2 — apply `2700_layover_certified_feasibility.sql`, alone, under its own
gate.** It is the lowest-risk apply in the backlog and the strongest-evidenced:
it **creates one table and alters nothing**; it has **no writer at all**, by its
own header's requirement; it was applied, second-applied and
rollback-rehearsed on `portava-ci` with the applied bytes md5-matched against
the committed file; and `layover_certified_computations` is confirmed absent
from the 2026-09-22 capture
(`docs/architecture/migration-queue.md:155`, `:160`). It unblocks exactly one
thing and that thing is next. *Blocked on:* nothing but the press.

**Step 3 — apply `2992_layover_decision_record_and_operational_tables.sql`,
immediately after, and only after.** Its own precondition block refuses by name
if 2700 has not run —
`artifacts/api-server/src/migrations/2992_layover_decision_record_and_operational_tables.sql:323`
— because *"creating it here would fork the definition of the one object the
whole design turns on."* It has **no UPDATE, no DELETE and no TRUNCATE**; its
`DROP TRIGGER IF EXISTS` statements sit immediately before the `CREATE TRIGGER`
that replaces them; its three `ADD COLUMN IF NOT EXISTS … NOT NULL DEFAULT`
statements take constant defaults and so rewrite no rows. Until both land,
`persistDecision` takes its refusal branch and the safety endpoint answers
`persisted: { state: "not_stored", reason }` — which is the honest state, and is
why census-layover L1 is not graded closed on the merged code
(`docs/architecture/migration-queue.md:165`). It seeds
`layover_decision_persistence_enabled` FALSE at `:751`, and **the flip is not
part of this step.** *Blocked on:* step 2.

### Then, in this order

4. **The Telegraph unsend chain, as three separate applies: `2325`, then
   `2810`, then `3000`.** All three are additive, all three seed or lock flags
   FALSE, and `3000` refuses by name if either predecessor is missing. This is
   the largest single row payoff in the backlog: 19 rows become gradable on
   `2810` alone, 4 more on the completed chain.
5. **`2811`, then `2812`.** 9 and 2 rows. `2811` seeds no flag; both are
   additive.
6. **`2989`, `2990`, `2991`, `2217`** — independent of each other and of
   everything above, 3 + 7 + 1 + 1 rows. `2217` must be understood as buying
   the table, not the suppression.
7. **Deploy the server, then the client.** Several capabilities have no client
   reader at all, so a server deploy realizes nothing for them
   (`docs/architecture/deployment-readiness.md:187`). This is also the step the
   Telegraph history-bound flip has been waiting on since 2026-09-22.
8. **Sensing**, as its runbook sequences it: `2277`/`2278` first, then the
   coupled `3002 → 3003 → 3310` window with the code inside it, with `3311`
   before the code and `3312` before the client ships. This one is **not**
   reorderable — the runbook's edge table explains each direction, and the
   quiesce exists because new code on old schema fails `subject_id NOT NULL`
   while old code on new schema writes duplicates past the replay check.
9. **The Highlights command boundary: `2993`, then `3001`, then `2994`.** Each
   refuses by name without its predecessor. Note what this buys and what it does
   not: **no verdict moves on any of the three**, because all five rows behind
   `2993`/`3001` also need `memory_kernel_enabled`, which this order does not
   flip. It is still worth doing early, because it is additive and because
   `3001` must be the last migration to define `highlight_kernel_execute`.
10. **`3502`, then `2975` — in that order, never in file order.** Isolate this
    pair from every other batch and re-read §2.4 before touching it. If a
    replay tool is involved, check what order it will choose before it chooses
    it.
11. **Sensing**, as its runbook sequences it: `2277`/`2278` first, then the
    coupled `3002 → 3003 → 3310` window with the code inside it, with `3311`
    before the code and `3312` before the client ships. This one is **not**
    reorderable — the runbook's edge table explains each direction, and the
    quiesce exists because new code on old schema fails `subject_id NOT NULL`
    while old code on new schema writes duplicates past the replay check.
12. **Discovery**, by its own plan: the `portava-ci` rehearsal (action 0) before
    anything, then P0+P1 after a confirmed point-in-time restore point. Batch P1
    is **not purely additive** — `3440` rewrites a column, `3375` validates every
    `rank_events` row, `3362`–`3365` and `3422` revoke client privileges — and
    the restore point is a hard requirement for exactly that reason
    (`docs/ops/discovery-production-rollout.md:25`).

Trips' `2797 → 2798 → 2799` can go anywhere after step 1; it closes one row
(TR427) and only in company with `trip_kernel_enabled`.

### What must not move

- **No flag flip is recommended anywhere in this order.** Every step above is an
  apply or a deploy. The 101 INSERTs are runtime-neutral; the flips are not, and
  each is an owner act with its own prerequisites written down in the surface's
  own runbook. The ~137 rows in §4.0 are the ones a reader will be most tempted
  by, and every one of them has a prerequisite that is not an apply.
- **`2470`, `2481`, `2250`, `2600` do not move** until their owner decision is
  taken. Applying any of them takes the decision.
- **`2313` does not move** until it is rebased onto `2530` (§4.6).
- **Nothing in the `23xx` band moves ahead of a `2530` check**, for the same
  reason.
- **`2333` does not move ahead of `2224`**, or it aborts and lands nothing.
- **`0127` is not re-run** after any operator flag decision (§4.6).
- **The nine Layover must-nots in §2.3 stand as written**, in particular that
  the API code deploy is **not** flag-neutral for the entry gate: the flag it
  rides on is already TRUE in production, so step 7 changes the production
  verdict on every layover with nothing to stage it behind. That is a reason to
  read §2.3 before the deploy, not a reason to flip anything.
- **No safety, privacy, payment, identity, consent or moderation control is
  armed, disarmed or re-pointed by this order.** That explicitly covers
  `location_snapshot_purge_enabled` and `media_pending_upload_sweep_enabled`
  (both delete data), `tag_permission_*`, `media_moderation_classifier_enabled`,
  `discovery_search_protected_zones_enabled`, `sensing_publication_enabled`,
  `intel_sensing_credentials_enabled`, `intel_sensing_device_enrollment_enabled`,
  the identity-verification provider, and all 73 names in §3's divergence set.
- **Batch P1 does not move without a restore point.** The 2026-09-14 deployment
  recorded that it proceeded without one and said no non-additive batch may do
  so again.

---

## 6. Unknown — and what would settle each

Written as **unknown** rather than estimated, because a confident wrong number
here sends someone to apply something in the wrong order.

| Question | Why it is unknown | What settles it |
|---|---|---|
| How many of the 683 canonical migrations are *actually* applied to production | The record is a tripwire, not an inventory, and `2401`/`2402` prove the gap in the direction that matters | One read of production's `supabase_migrations.schema_migrations` **and** `schema_migration_ledger`, joined — neither is complete alone |
| Whether anything was applied to production after 2026-09-22 | The record's newest version and the snapshot watermark are the same instant | The same read |
| Production's current flag values, and whether the 101 are still row-less | Every flag value here is the 2026-09-22 capture's | A fresh `feature_flags` capture |
| Whether `AI_INTEGRATIONS_OPENAI_API_KEY`, `SENSING_CONTRIBUTOR_PEPPER` or `INTEL_EVIDENCE_REFERENCE_KEY` are set in production | Secrets are not in the tree. `docs/architecture/census-highlights-memories.md:1887` carries this as open question **D-C2** | The operator reading Replit Secrets |
| Whether any mobile build has shipped | The last committed statement is the 2026-09-08 readiness table, stale by 94 recorded migrations | The EAS dashboard, or a build record |
| The current global value of the "deployment levers removed" delta | `docs/architecture/truth-percentage-without-deployment.md:8` measured it at **+0.7 points** (43.5 % → 44.3 %) on 2026-09-08, by a hand count over 39 candidates. That is a month and ~2000 census rows out of date, and this document does **not** re-derive it | Re-running that hand count at `f71cfb85f` |
| Whether the deployment backlog is "most" of the remaining distance | The two committed measurements point different ways. The 2026-09-08 hand count says the levers are worth 0.7 points globally; the four surfaces traced here have 51 of Telegraph's 177 `W` rows deployment-gated, and census-trips classifies all 128 of its `W` rows as not code-actionable. Both can be true — deployment blocks the rows that *recent correctness work made ready*, without dominating the global figure | The re-run above, scoped per surface rather than globally |
| T31's classification | `docs/architecture/census-telegraph.md:4647` says BOTH (needs `2217`); `:7135` later lists it as closable from code. Last-statement-wins picks the second; the first's argument is a deployment fact no code change touches. Unresolved in the document itself | An owner or census ruling. For deploy ordering, treat it as needing `2217` |
| How many of Layover's 144 `W` rows are deployment-gated | The only `W`-only partition is §13.1's *"(c) GATED — 19"*, measured when `W` was 138, before `2860` was applied and before L197 left the group. §31 records that the companion `N`-row cell was written as 52, summed to 95 against a total of 94, and was ticked anyway | A per-row blocker re-read over `CENSUS_INTEGRITY_DUMP=ALL` for that file |
| Whether `2810`/`3000` are on `portava-ci` | The census states both *"no database has run 2810"* (`docs/architecture/census-telegraph.md:9667`) and, correcting it, that `live-db.yml` applies the chain on `main` (`:9701`). Both statements are current in a committed append-only document and they disagree | One read of `portava-ci`'s ledger |
| Whether `2320` is on `portava-ci` | `docs/architecture/census-highlights-memories.md:230` says "applied to portava-ci only"; `:1804`, corrected 2026-09-22, says "applied nowhere". `docs/architecture/blocker-ledger.md:1396` supports the CI reading | The same read |
| Whether `2797`–`2799` are still unapplied | They are absent from the record, and the record has lagged reality twice by backfill — a blind spot the tripwire cannot see, because it only fires when the file is *ahead* | The same read |
| TR174's category | `docs/architecture/census-trips.md:9676` counts it among the 108 deployment-gated rows; `:7820` argues it cannot be deployment-gated at all, naming map tiles — *"a client permission the server does not hold"* — as the real blocker. §76.3 counts it unclassified | A census ruling. Two of its three statements say it is not an env-var row |
| Whether the deployed API carries any of this code | A read-only `GET /healthz` against `portava.replit.app` returns `curl: (56) CONNECT tunnel failed, response 403` from this egress, and `census-layover.md` records the same refusal. So *"the deployed consumer is verified"* — the stated precondition for both Trips flips and the L269 flip — **cannot be discharged from here by anyone** | An operator with a browser or an unfiltered shell |

---

## 7. How to re-run everything in this document

```
cd artifacts/api-server
pnpm run check:flag-polarity              # 299 seeded / 683 migrations / 172 INSERTs
node --import tsx/esm src/scripts/checkFlagSchemaPrerequisites.ts
pnpm run check:census-integrity           # C 2436 / W 846 / N 211 / X 25
pnpm run check:doc-citations
pnpm run check:census-policy-citations
ls src/migrations/*.sql | wc -l           # 683
node -e "console.log(require('./src/lib/capability/production-applied-migrations.json').migrations.length)"   # 129
```

Every one of those is offline. None touches a database.

**On this document's own citations.** `docs/ops` is **not** in the
`check:doc-citations` registry at
`artifacts/api-server/scripts/check-doc-citations.mjs:111#export const COVERED`
— that registry covers `docs/trust`, `docs/discovery`, `docs/compass`,
`docs/architecture` and two named files, and its header is explicit that
adopting a directory means someone read its citations. This file's citations
were therefore verified by replicating the guard's own grammar (range, plus
first-line anchor) against the tree at `f71cfb85f`, rather than by a registry
entry nobody vouched for. Both guards were run and both pass.
