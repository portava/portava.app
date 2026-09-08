# Deployment readiness ledger

**Generated 2026-09-08.** Branch `claude/portava-continuation-uqta94`.

This exists because "built" and "live" were being conflated, repeatedly and in
both directions. A census said 6.4% correct while the code had moved; a
migration was described as safe because it looked additive; server routes were
called shipped while no client called them. Those are three different mistakes
with one shape: a state that sounds finished standing in for one that is not.

## The vocabulary. These are not synonyms and none implies the next.

| State | Means | Does NOT mean |
|---|---|---|
| `BRANCH_BUILT` | the code exists on this branch and its tests pass | that anything can reach it |
| `MERGE_READY` | it would merge into the target cleanly | that it has been merged |
| `DEPLOY_READY` | merged code plus every migration it needs, applied | that a server is running it |
| `DEPLOYED_FLAG_OFF` | running in production behind a flag that is FALSE | that any user can do it |
| `DEPLOYED_FLAG_ON` | running, flag TRUE | that the client calls it |
| `PRODUCTION_REALIZED` | a user can actually perform the action end to end | — |

**BUILT ON BRANCH is not MERGED. MERGED is not DEPLOYED. DEPLOYED is not FLAG
ENABLED. FLAG ENABLED is not PRODUCTION REALIZED.**

## Branch-wide facts, measured

| Fact | Value | How |
|---|---|---|
| Commits ahead of `origin/main` | **363** | `git rev-list --count origin/main..HEAD` |
| Commits `origin/main` is ahead | **0** | `git rev-list --count HEAD..origin/main` |
| Merge shape | **fast-forward, zero conflicts** | `git merge-tree --write-tree`; resulting tree byte-identical to HEAD's |
| Merged | **NO** | — |
| Server deployed | **NO** | no deploy performed in this session |
| Mobile deployed | **NO** | — |
| Migrations applied to production | **35** | `production-applied-migrations.json`, reconciled against `supabase_migrations.schema_migrations` |
| Migrations written, NOT applied to PRODUCTION | **10** (unchanged — nine of them now exist on CI, which is not production) | 2700, 2710, 2711, 2720–2724, 2730, 2740 |
| Of those, applied to **portava-ci** | **9** | 2710 `20260908142429`, 2711 `20260908142652`, 2700 `20260908145925`, 2740 `20260908150439`, 2730 `20260908151001`, 2720 `20260908151339`, 2721 `20260908151706`, 2722 `20260908151954`, 2724 `20260908152035` — CI is not production and this row exists so the two are never read as one |

## Per-surface

`Migr` = every migration this surface needs is applied to production.
`Client` = a client code path actually calls it.

| Surface | Branch built | Branch wired | Branch tested | Migr applied | Merged | Server deployed | Mobile deployed | Flag | Prod realized |
|---|---|---|---|---|---|---|---|---|---|
| Layover — feasibility record | yes | yes | yes | **ci only (2700)** — and NO WRITER exists, by design | **no** | no | no | n/a | **no** |
| Layover — sharing gate / presence | yes | yes | yes | **ci only (2740)** | **no** | no | no | ladder flag FALSE — a real row on CI, **still no row in production**, where `isFlagEnabled` fails closed to the same answer for a different reason | **no** |
| Layover — safe return / abort | yes | yes | yes | **yes (2741)** | **no** | no | **client built, undeployed** | `layover_safe_return_status_enabled` FALSE | **no** |
| Layover — crew constraints | yes | **no** (no route) | yes | n/a | **no** | no | no | n/a | **no** |
| Layover — offline bundle | yes | yes (server) | yes | n/a | **no** | no | **displayed, not cached** | n/a | **no** |
| Highlights — permission rule | yes | yes | yes | n/a | **no** | no | no | n/a | **no** |
| Highlights — archive | yes | yes | yes | yes (0026, pre-existing) | **no** | no | no | n/a | **no** |
| Highlights — consent / resurfacing | yes | partial | yes | **ci only (2720, 2721)** | **no** | no | no | LOCATION_PRECISION_DEFAULT unmade — 0 policy rows, so §10 is UNENFORCED, not defaulted | **no** |
| Memories — command bus / outbox | yes | yes | yes | **ci only (2710, 2711)** | **no** | no | no | `memory_kernel_enabled` FALSE on CI, NO ROW in production | **no** |
| Memories — projections / retrieval | yes | **no HTTP surface** | yes | **ci only (2730)** | **no** | no | no | n/a | **no** |
| Trips / Trip Kernel | prior | prior | yes | yes (2420) | **no** | no | no | — | **no** |
| Map | prior | prior | yes | yes (2520, 2610) | **no** | no | no | — | **no** |
| Discovery | prior | prior | yes | yes (2550) | **no** | no | no | flag-gated | **no** |
| Telegraph | prior | prior | yes | yes (2401, 2402) | **no** | no | no | — | **no** |
| Passport | prior | prior | yes | yes | **no** | no | no | — | **no** |
| RAB | prior | prior | yes | yes (2305, 2330) | **no** | no | no | `rent_buddy_enabled` | **no** |
| Events / Meetups | prior | prior | yes | yes (2460–2462) | **no** | no | no | — | **no** |
| Safety (Safe Return, SOS) | partial | partial | yes | yes (2741) | **no** | no | no | FALSE | **no** |
| Trust | prior | prior | yes | yes (2370, 2371, 2540, 2650, 2660) | **no** | no | no | — | **no** |
| Intel / Sensing | prior | prior | yes | partial (2481 owner-blocked) | **no** | no | no | — | **no** |
| Media | prior | prior | yes | **no (2470 owner-blocked)** | **no** | no | no | `media_canonical_enabled` TRUE with columns ABSENT | **no** |

### Changes since this ledger was generated, and what they did NOT change

Two lanes landed on the branch. Neither moved any row past `BRANCH_BUILT`, and
the table above is written to make that visible rather than to hide it behind a
new "yes".

- **Layover mobile reachability** (`a718beb5`) gave three server capabilities a
  gesture: one-tap abort, the certification footer, and the Compass question
  panel. `Mobile deployed` is still `no` for every one of them — a component
  that exists in a branch is not an app anybody has. The census recensus records
  the same three as `W → C` and CONSTRUCTED% as UNCHANGED, which is the same
  fact stated in the other document's vocabulary.
- **Memory kernel certification** (`3721cb39`) applied 2710 and 2711 to
  **portava-ci only**, verified the applied bytes by md5 against the files on
  disk, and proved the transaction rolls back whole under an injected fault.
  Production was never contacted. `Migr applied` for that surface therefore
  reads `ci only`, which is a state this table did not previously have a word
  for and needed one.
- **2700** (layover certified computations) was certified and applied to
  **portava-ci only** in this session: object names verified free first, applied
  bytes md5-matched against the committed file, postconditions re-read
  independently, second apply and rollback both rehearsed inside transactions
  that were rolled back. It creates a table with **no writer at all**, which the
  migration's own header requires — a writer that names a column fails outright
  on a database that has not run this, so the order is schema first. `Branch
  wired` for that row therefore means "every route consults one certified record
  per request", not "the record is stored anywhere".

A live confirmation worth recording because so much depends on it: production's
`public.profiles` has **182 inbound `ON DELETE CASCADE` foreign keys and ZERO
outbound ones** — it does not reference `auth.users` at all. Account deletion
anonymises the profile row rather than deleting it, so every one of those 182
cascades is permanently disarmed. That is exactly what `lib/deletionDispositions
.ts:5` already says; this pass measured it against the live catalogue instead of
taking the comment's word, and it holds. Any table whose erasure story is "the
profiles cascade takes it" is not erased.

**Every row ends `PRODUCTION_REALIZED = no`, because the branch is unmerged.**
That single fact dominates the table: no amount of branch-side completeness
changes it, and nothing in this session moved it.

## What IS live in production right now

Only schema. 35 migrations, of which this session applied three under the full
gate: `2535`, `2551`, `2741` (plus `2335` and `2510` earlier in the day). No
application code from this branch runs anywhere.

Two of those are worth naming because they changed live behaviour rather than
just shape:
- `2551` withdrew EXECUTE on `increment_hashtag_usage_count` from
  `authenticated`, closing a trending-counter inflation primitive.
- `2741` widened two CHECK constraints so the abort route's ledger row is legal.
  Nothing writes the new values yet; the flag is FALSE.

## The blocking sequence

1. **Merge.** Fast-forward, zero conflicts, available now. It stops being a
   fast-forward the moment any of the seven open migration-bearing PRs lands.
2. **Apply the 10 queued migrations**, each under its own gate. Not batched.
3. **Deploy the server.**
4. **Deploy the client** — and note that several capabilities have no client
   reader at all, so deploying the server alone realizes nothing for them.
5. **Only then** consider flags, and only the ones whose code and schema are
   both realized.

## The one cross-cutting hazard

**PR #461's migration `2313` reproduces the `trip_members` self-join that
production-applied `2530` removed.** If #461 reaches production after 2530, it
reopens a defect where removed members and pending invitees can read
trip-scoped highlights. It must be rebased before its 2313 is applied,
regardless of merge order. This is owner-side: it touches
`STORY_HIGHLIGHT_VISIBILITY`.
