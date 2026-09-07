# Migration disposition ledger

**Measured 2026-09-07.** Companion to `manual-production-migration-runbook.md`,
which says *how* to apply. This says *whether*, and *on what evidence*.

- `travel-buddy` `ajrurzioarfkagpuxfnb` — **production**. Read-only from this
  session; structural and aggregate queries only.
- `portava-ci` `hwokxgbmezheskbzskfr` — the sanctioned CI project.

Nothing in this session applied anything to either database.

---

## Method, and why applied-state has to be measured object by object

**Production has no `schema_migration_ledger`.** There is no table to ask "is
2337 applied?". The only way to answer is to name an object each migration
creates — a function, a column, a constraint, an index, a policy shape, a grant
set, a flag row — and look for it.

That method has one failure mode, and it fired on the first attempt:

> The first applied-state probe written for `2333` checked whether `anon` held
> grants on a table called `memory_moments`. `memory_moments` does not exist in
> either database. `count(*) = 0` was therefore trivially true and the probe
> reported **"2333 is applied"** for a table that was never there.

A marker that can be satisfied by absence is not a marker. Every row below was
re-derived under two rules:

1. **The marker must be positively distinctive.** It must be an object the
   migration *creates*, not the absence of one it removes — unless the table's
   existence is asserted separately.
2. **The marker must belong to exactly one migration.** Where two migrations
   produce the same object, the state is recorded as **CANNOT-VERIFY**, not
   guessed. This costs one row below (`2470`) and that is the correct price.

---

## Finding 1 — CI and production have diverged by eighteen migrations

| | production | portava-ci |
|---|---|---|
| Migrations in the 2330–2490 band with their marker present | **1** (`2402`) | **19** |

Every one of `2333 2334 2335 2336 2337 2338 2339 2340 2350 2360 2361 2370 2371
2400 2410 2420` and the media-canonical family is present on CI and absent in
production.

**Consequence, stated plainly: a green CI run is not evidence about production
for anything in this band.** CI is roughly eighteen migrations ahead. Any check
that reads the live schema — `checkMissingLiveColumns`, `checkAuthorizationContract`,
`rlsPolicyShapeLive` — is describing CI's schema, not the one users are served
from. Where a decision depends on production's shape, it has to be read from
production.

## Finding 2 — the dependency that would have aborted

`2333` REVOKEs on `route_flow_contribution_consent` and
`sensing_anon_contributions`. **Neither exists in production.** `REVOKE ALL ON`
an absent relation raises, so the transaction would have rolled back and none of
its memory revokes would have landed, presenting as one opaque
`relation ... does not exist`.

A sweep for that defect class across all 21 migrations in the band that touch a
pre-existing table (53 distinct tables required, checked against production)
found **five tables absent**, all accounted for:

| Absent in production | Created by | Referenced by | Guarded? |
|---|---|---|---|
| `route_flow_contribution_consent` | `2224` | `2333` | **was not** — now enforced |
| `sensing_anon_contributions` | `2315` | `2333`, `2340` | `2340` yes; `2333` was not — now enforced |
| `sensing_contribution_sessions` | `2480` | `2481` | yes |
| `trip_events` | `2420` | `2450`, `2520` | yes |
| `trip_command_receipts` | `2420` | `2450` | yes |

`2333` was the only unguarded one. It now carries a PRECONDITION block naming
both prerequisites in the error text.

---

## The ledger

Evidence column: **V** = verified in depth this session (file read end to end,
markers measured, postcondition logic run read-only). **M** = applied-state
measured, migration self-declares and carries a postcondition, not re-audited.

| Mig | Subject | prod | ci | Disposition | Ev |
|---|---|---|---|---|---|
| 2330 | rent-a-buddy money atomicity | absent | absent | `ready_for_manual_apply` | M |
| 2331 | creator counter atomicity | absent | absent | `ready_for_manual_apply` | M |
| 2332 | money grant boundary | absent | absent | `ready_for_manual_apply` | M |
| 2333 | derived-memory + consent grant boundary | absent | **applied** | `ready_for_manual_apply` — **requires 2224 + 2315** | V |
| 2334 | route-plan crew visibility (`authz.is_trip_crew`) | absent | **applied** | `ready_for_manual_apply` — prerequisite for 2337 | M |
| 2335 | layover recommendation write boundary | absent | **applied** | `ready_for_manual_apply` — *Layover lane verifying no read path breaks* | V |
| 2336 | media canonical control flags | absent | **applied** | `ready_for_manual_apply` (seeds flags FALSE) | M |
| 2337 | trip-crew RLS membership convergence | absent | **applied** | `ready_for_manual_apply` — **requires 2334** | V |
| 2338 | memory `location_precision` | absent | **applied** | `ready_for_manual_apply` — DEFAULT is a deliberate no-op; the *product* default is `LOCATION_PRECISION_DEFAULT` and is **not** taken by applying this | V |
| 2339 | highlights feed bound | absent | **applied** | `ready_for_manual_apply` (seeds flag FALSE) | M |
| 2340 | sensing anon replay + time bounds | absent | **applied** | `ready_for_manual_apply` — **requires 2315**, already enforced | M |
| 2350 | map/sensing projection flags | absent | **applied** | `ready_for_manual_apply` (seeds flags FALSE) | M |
| 2360 | discovery buddy launch gate flag | absent | **applied** | `ready_for_manual_apply` | M |
| 2361 | discovery candidate projection flag | absent | **applied** | `ready_for_manual_apply` | M |
| 2370 | trust table privileges | absent | **applied** | `ready_for_manual_apply` | M |
| 2371 | trust profile evidence columns | absent | **applied** | `ready_for_manual_apply` | M |
| 2400 | telegraph history bound | absent | **applied** | `ready_for_manual_apply` (seeds flag FALSE) | M |
| 2401 | telegraph messages latent disclosure | **applied** | applied | done | V |
| 2402 | telegraph membership RLS recursion | **applied** | applied | done — refuses without 2401 | V |
| 2410 | layover recommendation identity (`rec_key`) | absent | **applied** | `ready_for_manual_apply` (path behind a FALSE flag) | M |
| 2420 | trip kernel foundation | absent | **applied** | `ready_for_manual_apply` — **requires 2334 + 2337** | M |
| 2430 | intel live scope promotion writer | absent | absent | `ready_for_manual_apply` | M |
| 2450 | trip kernel trip + participant families | absent | absent | `ready_for_manual_apply` — **requires 2334→2337→2420**, enforced | M |
| 2460 | meetup self-invite latent disclosure (inert defuse) | absent | absent | `ready_for_manual_apply` — **apply before 2461** | V |
| 2461 | meetup RLS recursion repair | absent | absent | `ready_for_manual_apply` — **requires 2460** | V |
| 2462 | meetup time-vote write boundary | absent | absent | `ready_for_manual_apply` — **requires 2460** | V |
| 2470 | media canonical columns, flag-agnostic | absent | **CANNOT-VERIFY** | `blocked_by_owner_decision` — **MEDIA_CANONICAL_FLAG** | V |
| 2480 | sensing contribution sessions | absent | absent | `ready_for_manual_apply` | M |
| 2481 | sensing sessions Option A issuer | absent | absent | `blocked_by_owner_decision` — **SENSING_AUTH_POSTURE**. Its CHECK *encodes* Option A; applying it takes the decision | V |
| 2490 | destructive privilege boundary (schema-wide) | absent | absent | `ready_for_manual_apply` — apply to CI first | V |
| 2250 | media asset canonical model | absent | see 2470 | **`do_not_apply` as written** — its own postcondition asserts `media_canonical_enabled` is FALSE; it is TRUE in production, so it fails on itself. 2470 exists because of this | V |

### Why 2470 is CANNOT-VERIFY on CI

`2250` and `2470` add the same columns and the same two constraints to
`media_assets`. No object distinguishes them. On production the question does
not arise — `media_assets.captured_at` is absent, so **neither** is applied. On
CI the column is present and which of the two put it there cannot be determined
from the schema. Recorded as unknown rather than assumed.

---

## Owner decisions, isolated

Applying a migration must not silently take one of these. Each is named at the
one row where it actually binds.

| Decision | Bound by | What applying decides |
|---|---|---|
| `SENSING_AUTH_POSTURE` | **2481** | Its CHECK constrains `issuance_class` to `authenticated_profile`. Under Option B this file is never run and the column never exists. 2480 alone is neutral. |
| `MEDIA_CANONICAL_FLAG` | **2470** | `media_canonical_enabled` is TRUE in production while the columns are absent — the condition that caused three weeks of swallowed write loss. The decision is whether to add the columns under the live flag or take the flag down first. |
| `LOCATION_PRECISION_DEFAULT` | *not bound by a migration* | 2338 deliberately defaults to `'exact'` so that applying it changes no served row. The default for *newly created* memories is a product decision and is not encoded anywhere yet. Applying 2338 does not pre-empt it. |
| `STORY_HIGHLIGHT_VISIBILITY` | *not bound by a migration in this band* | 2339 gates only feed bounding, behind a FALSE flag. |

## Residuals — recorded, not closed

1. **`supabase_admin`'s default ACL** cannot be altered from a migration
   (`postgres` is not a member of it), so 2490 cannot stop a table created by
   that role from re-inheriting the blanket grant. Production has exactly one
   such table, PostGIS's `spatial_ref_sys`, which holds no user data.
2. **Eighteen-migration CI/production drift** (Finding 1). Nothing in this band
   closes it; only applying does.
3. **`2335` and `2410` are applied on CI**, so the Layover surface's live CI
   behaviour already differs from production's. Read the Layover lane's report
   before applying either.

---

## Extension — migrations 2500-2550, written during the parallel lane pass

All were authored 2026-09-07 by lanes running under "apply nothing". **Every
marker below was verified ABSENT on portava-ci**, and production is behind CI on
every migration in the band, so none is applied anywhere.

| Mig | Prod marker | CI marker | Ledger | Dependency | Status | Reason |
|---|---|---|---|---|---|---|
| 2500 | `trip_kernel_execute` body contains `JOIN_VIA_LINK` — absent | absent | not ledgered | **2334 → 2337 → 2420 → 2450** | `blocked_by_dependency` | Adds `JOIN_VIA_LINK` and widens two commands from `owner` to `host`. A 2450 database refuses the new type as `TRIP_COMMAND_UNKNOWN_TYPE` — tested, not assumed. Production has none of the chain. |
| 2510 | verify-only; would RAISE today | would pass | not ledgered | **strictly after 2335** | `ready_for_manual_apply` | The postcondition block 2335 lacks, as a separate file because 2335 is ledgered on CI by sha256 and `checkMigrationLedger` reports an edited applied migration as a finding. Proven to discriminate: on production `layover_recs_owner` is `polcmd='*'` with `authenticated` holding all eight privileges, so it raises; on CI `polcmd='r'` with SELECT only, so it passes. |
| 2520 | `trip_map_projection_drain` — absent | absent | not ledgered | **2334 → 2337 → 2420** | `blocked_by_dependency` | Outbox projection worker. Its own precondition RAISEs until the kernel chain lands. Flag `trip_map_projection_worker_enabled` seeded FALSE. |
| 2530 | `highlights_select_active` qual contains `shares_accepted_trip` — absent | absent | not ledgered | **2337** (creates `authz.shares_accepted_trip`) | `ready_for_manual_apply` | Rewrites one branch of one policy, shape-agnostic, refuses any shape it does not recognise. **Ordering hazard: PR #461's 2313 restores the `trip_members` self-join byte-for-byte.** If 2313 is applied after 2530 on production the defect returns — see runbook. |
| 2531 | `crew_session_owner_select` qual free of `allowed_member_ids` — absent | absent | not ledgered | none | `ready_for_manual_apply` | Removes the branch admitting any stranger listed in `allowed_member_ids`. This is the policy 2337 deferred to reconciliation-staging/2118. |
| 2532 | `pg_policies_snapshot_v2` — absent | absent | not ledgered | none | `ready_for_manual_apply` | Diagnostic snapshot keeping USING and WITH CHECK apart. 2199's fuses them, so no consumer of it can distinguish a `FOR ALL` that wrote `WITH CHECK` from one that did not — the distinction this whole pass turns on. |
| 2540 | index `trust_events_one_shot_uniq` — absent | absent | not ledgered | none | `ready_for_manual_apply` | Partial unique index scoped to the five event types whose emitters were wired. Every other type deliberately excluded for its owner to extend. Rehearsed on CI inside a rolled-back transaction. |
| 2550 | *(Discovery consumer lane in flight)* | — | — | — | *pending* | Will seed the Discovery-consumer flag FALSE. Recorded here so the band is not silently incomplete. |

### Why 2500 and 2520 are `blocked_by_dependency` rather than `ready`

Both are correct files. Neither can be applied to production today because
`trips.version` does not exist there (measured 2026-09-07: `trips.version`
absent, `trip_events` absent, 43 trips, 12 discoverable). They are not blocked on
a decision or on more engineering — only on 2334 → 2337 → 2420 → 2450 being
applied, in that order.

### The meetup cycle, re-swept after the RLS lane landed

A recursive policy-graph sweep run against **both** databases today returns
exactly one cycle, identically on each:

```
meetups -> meetup_invites -> meetups
```

No new cycle was introduced by 2530/2531/2532. The cycle is repaired **in code**
by 2460 → 2461 and remains **live in both databases** because neither is applied.
It is `ready_for_manual_apply`, blocked only on manual SQL.
