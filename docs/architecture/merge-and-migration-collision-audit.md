# Merge and migration collision audit

**Measured 2026-09-08** on branch `claude/portava-continuation-uqta94`, against
`origin/main` and every open pull request. Nothing in this file was inferred from
a PR title; every row was read out of the PR's own branch.

**The working branch was not mutated to produce this.** `git merge-tree
--write-tree` and `git fetch` of each PR head are the only operations involved.

## Merge shape

| Fact | Value | How |
|---|---|---|
| Commits ahead of `origin/main` | **363** | `git rev-list --count origin/main..HEAD` |
| Commits behind | **0** | `git rev-list --count HEAD..origin/main` |
| Merge result | **fast-forward** | `git merge-tree --write-tree origin/main HEAD` returns a tree **byte-identical** to `HEAD^{tree}` — not "no conflicts reported", the same tree |
| Merged | **no** | — |

A fast-forward is a property of *this moment*. It stops being one the instant any
open PR lands, and eight of them carry migrations.

## Every migration in an open PR

Read from each PR's branch with `git diff --name-only origin/main...<head> --
'artifacts/api-server/src/migrations/*.sql'`. Thirty-three PRs are open;
**twenty-five carry no migration at all**, which is itself the useful half of the
answer.

| Migration | PR | Objects it touches |
|---|---|---|
| `2296_map_journey_intelligence` | #393 | creates `trip_plan_item_votes` |
| `2310_memory_projector_canonical_saves` | #451 | no DDL — repoints a projector |
| `2311_intel_claim_reviews` | #456, and #457 stacked on it | creates `intel_claim_reviews` |
| `2312_layover_travel_time_unknown` | #463 | `ALTER COLUMN … DROP NOT NULL/DEFAULT` on `layover_recommendations.travel_time_min` and `layover_plan_stops.travel_min` |
| `2313_highlights_permanent` | #461 | `highlights`: `expires_at` DROP NOT NULL, one NOT VALID CHECK, **replaces `highlights_select` and `highlights_select_active`**, adds `highlights_owner_archive_idx` |
| `2315_sensing_anon_contributions` | #475 | creates `sensing_anon_contributions` |
| `2320_memory_episode_provenance_spine` | #470 | creates `memory_episodes`, `memory_evidence` |
| `2325_telegraph_unsend_before_seen` | #472 | `messages` |

## Prefix collisions

`2296, 2310, 2311, 2312, 2313, 2320, 2325` — **none of these numbers exists on
this branch.** `check:migration-prefixes` guards collisions *within* a tree; this
is the cross-tree question it cannot ask.

`2315` is the exception and it is not a collision:
`2315_sensing_anon_contributions.sql` exists on **both** this branch and #475,
and the two files are **byte-identical** (`diff` of the PR's blob against the
working tree returns nothing). Merging #475 changes that file by zero bytes.

`2311` appears in both #456 and #457 because #457 is stacked on #456 — one file,
two PRs, not two files.

## Object collisions with the ten migrations certified onto portava-ci today

| Certified today | Open-PR toucher of the same object | Verdict |
|---|---|---|
| `2700` — creates `layover_certified_computations`, and its postcondition asserts `layover_recommendations` has **no** `engine_version` / `input_hash` | `2312` also touches `layover_recommendations` | **No collision, and this was checked rather than assumed.** 2312 only relaxes NOT NULL and DROPs a DEFAULT on `travel_time_min`; it adds no column at all, so 2700's co-toucher postcondition still passes after it. Worth recording that `layover_recommendations` now has **three** unapplied touchers — 2411, 2700 (by assertion only) and 2312 — which is the exact condition `layoverCutoverEvaluate.ts` requires to be classified in writing. |
| `2723` — adds five columns, two NOT VALID CHECKs and `highlights_pinned_idx` to `highlights` | `2313` alters the same table | **No NAME collision** — disjoint columns, disjoint constraint names, disjoint index names. There IS a deliberate SEMANTIC dependency, and 2723's own header states it: `lifetime_class = 'PERMANENT'` is admitted by its CHECK but **unrepresentable while `expires_at` is NOT NULL**, which is precisely what 2313 changes. They are complementary. Order does not matter for either to apply; it matters for `PERMANENT` to become usable. |
| `2730` — creates `memory_derivative_registry` | `2320` creates `memory_episodes`, `memory_evidence` | No collision. Different names, no shared constraint or index name. |
| `2710`/`2711` — the memory command kernel, on `memory_domain_events` | `2320` | No collision. The rename away from `memory_events` is what keeps it that way. |

## The one standing hazard, now with its mechanism

`docs/architecture/migration-queue.md` already records that **#461's 2313
reintroduces the `trip_members` self-join that production-applied 2530 removed.**
This audit adds the mechanism rather than restating the warning: 2313 does

```sql
DROP POLICY IF EXISTS highlights_select ON public.highlights;
DROP POLICY IF EXISTS highlights_select_active ON public.highlights;
```

and recreates both. 2530 rewrote that same family in production on 2026-09-07.
So the reintroduction is not a subtle interaction — it is a policy replacement
whose replacement text predates the fix. **Whatever the merge order, 2313 must be
rebased onto 2530's predicate before it is applied anywhere.** The rebase patch
is in `docs/architecture/`.

This is owner-side: it touches `STORY_HIGHLIGHT_VISIBILITY`.

## What this audit does NOT establish

- **Merge conflicts in non-migration files.** Only the migration surface was
  enumerated. Twenty-five of the thirty-three open PRs carry no migration and are
  invisible to this audit entirely.
- **That any of these PRs is otherwise ready.** CI status, review state and the
  content of the other files were not examined.
- **Anything about apply order between the eight.** Each was read against
  `origin/main`, not against the others. Two PRs that both alter `highlights`
  (#461's 2313) or both alter `layover_recommendations` (#463's 2312) have been
  compared to THIS branch's migrations, not to each other's.
