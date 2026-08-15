# Retention policy — orphaned storage objects and orphaned rows

**Status: in force from 2026-08-14. Window: 90 days. Window end: 2026-11-12.**

Ruled by the owner, 2026-08-14, as the operator default. This closes two items
that were both explicitly held open pending exactly this number:

- `docs/media/staging-boundary-decisions.md` D5=B — *"quarantine first, sweep
  after a defined window"* — which recorded that *"quarantine needs a window
  length"* and that **one window defined once should cover both populations**.
- `docs/fact-layer-20260810/DECISIONS.md` — *"`content_stamps` reaper — held
  pending an explicit retention window. **[OWNER]**"*

## The rule, in one paragraph

Nothing in this repository deletes an orphaned object or an orphaned row.
Orphaned storage objects are **quarantined**, not deleted, and remain restorable
for at least 90 days. Orphaned rows are **snapshotted** and are not deleted at
all. At window end, deletion is a **scheduled decision taken by a person**, made
against evidence that the window produced. It is never an automatic job, and
there is deliberately no code path in this repo that would make it one.

---

## Populations

Both were **re-measured on 2026-08-14** rather than carried forward. Both had
moved. That is the argument for re-measuring, not a footnote to it.

### A. Storage orphans — 34 objects, 26.8 MB

Objects in `post-media` / `profile-media` that **no column in the discovered
reference set names**. Measured by `pnpm run audit:unreferenced-objects`
(read-only; it walks the bucket and joins outward to every referencing column
discovered from `information_schema` at run time).

| | |
|---|---|
| unreferenced objects | **34** |
| total size | 26.8 MB (25.5 MiB) |
| oldest | 2026-06-20 |
| referenced objects | 26 |

**The packet said 28. It is 34.** Six more since 2026-08-12. The figure is not
static and must be re-derived before any action, which is why the quarantine
tool re-runs the census itself rather than accepting a list.

This count is a **LOWER BOUND**. The census matches generously — an object counts
as referenced if any column value equals, ends with, or contains its key —
because a false "referenced" merely keeps an object alive, while a false
"unreferenced" is what deletes a real user's photo. The asymmetry is the design.

**Nothing in the data distinguishes an abandoned upload from a real photo whose
reference was lost to a bug.** That distinction does not exist, and it is
precisely why the ruled disposition is quarantine-then-sweep rather than sweep.

### B. Orphaned rows — 353 captured, 140,619 censused

Four tables reference `posts` polymorphically (a type column plus a loosely typed
id column) with **no foreign key**, so a post deletion cascades nothing and warns
nothing. Measured by `pnpm run snapshot:orphan-rows`.

| table | type filter | orphans | rows captured? |
|---|---|---:|---|
| `content_stamps` | `entity_type='post'` | **254** | ✅ full rows |
| `compass_recommendation_scores` | `item_type='post'` | **99** | ✅ full rows |
| `trip_plan_items` | `source_type='post'` | **0** | ✅ (none to capture) |
| `rank_events` | `content_type='post'` | 86,476 | censused only |
| `rank_events` | `content_type IS NULL` | 53,790 | censused only |
| | **total** | **140,619** | **353 captured** |

#### The 18.7k figure means something different from what it looks like

The brief for this work described *"the ~18.7k `content_stamps` orphan rows"*.
**`content_stamps` orphans are 254.** The 18,756 in `docs/migrations.md` is the
**four-table total at 2026-08-10 backup time**, and it is dominated by
`rank_events` (18,404 of it). The two numbers describe different things and it
is easy to carry one forward as the other.

The live totals also differ sharply from that backup, because they answer a
different question. The backup counted rows dangling **because of the 21 posts
deleted on 2026-08-10**. The table above counts rows pointing at **any** post id
that does not currently resolve — a superset that includes ordinary lifecycle
deletions across the table's whole history. Neither number is wrong; they are not
comparable, and this file states which one it is reporting.

#### The type column is load-bearing

Counting without filtering on the type column counts every row that legitimately
points at a place, an event, a buddy or a trip:

| table | unfiltered | filtered to `post` |
|---|---:|---:|
| `rank_events` | 192,994 | 86,476 |
| `compass_recommendation_scores` | 10,863 | 99 |

`docs/migrations.md` records this exact mistake being made and corrected once
already — *"a measurement artifact of the query that produced it."* Every query
in `snapshotOrphanRows.ts` states its filter, and the artifact records the full
type distribution alongside each count so a reader can see what was excluded
rather than trust that something was.

#### Why `rank_events` is censused and not captured

`docs/algorithm/rank-events-signal-gaps.md` rules it **deliberately untouched**.
A snapshot exists to make a deletion reversible; there is no deletion to reverse.
Capturing it would put ~140,000 full rows — on the order of a hundred megabytes —
into git to guard against something that is ruled out. It is censused so the
number is on the record and drift stays visible.

**If `rank_events` is ever brought into deletion scope, `captureRows` flips to
`true` in the same change that proposes it — never afterwards.**

---

## The deterministic-restoration precondition

**No deletion of any row in population B may be executed unless a snapshot
artifact exists that can restore it exactly, and that restoration has been
demonstrated — not assumed — on a non-production project first.**

Concretely, all four must hold at the moment of any deletion decision:

1. `docs/ops/artifacts/orphan-rows-snapshot.json` exists and covers the rows in
   question with `rowsCaptured: true`.
2. The snapshot holds **complete rows** (`to_jsonb`), not ids. An id list is not
   a restore source: it cannot recreate a row, and by the time anyone needs it
   the row is gone. `snapshotOrphanRows.ts` refuses to write a partial capture —
   if `count()` and the captured array disagree it exits 1 rather than emit a
   file that looks like a restore source and is not.
3. The snapshot is **re-taken immediately before** the deletion. The one on disk
   is evidence about the day it was written; both populations have already been
   observed moving.
4. A restore has been **performed and verified** on the CI project from that
   artifact.

A population marked `rowsCaptured: false` fails precondition 1 by construction,
which is the mechanism by which `rank_events` cannot be deleted by this process
even if someone forgets that it is out of scope.

## Storage quarantine (D5=B)

Quarantine **moves** an orphan within its bucket to
`_quarantine/<YYYY-MM-DD>/<original-key>` and records the mapping in a manifest.
It does not delete. Restoration is moving the object back to the key the manifest
records, which is why the manifest is the artifact that matters and not the
object listing.

- **TTL ≥ the window.** Quarantined objects are retained at least 90 days from
  the date in their prefix. The date is *in the key*, so an object's eligibility
  is legible from its name and does not depend on a database the sweeper might
  not be able to reach.
- **Eligibility is computed, not asserted.** `quarantine:sweep-check` derives each
  object's age from the date in its own key and reports `ELIGIBLE` or `held`. An
  object under the quarantine prefix with no date stamp is reported as
  not-eligible and flagged, because something other than this tooling put it
  there and that is worth knowing before touching it.
- **ELIGIBLE MEANS "THE WINDOW HAS PASSED", NOT "DELETE IT".** There is no sweeper
  that deletes. No cron entry, no workflow trigger, no `--apply` flag anywhere in
  this tooling. Deletion at window end is a decision taken by a person against the
  agenda below, and making it executable was deliberately left undone.

## Tables created under this window

### `discovery_shadow_serves` — P1 Stage 2, operator ruling D7=A

Created by migration `2092_discovery_shadow_serves.sql`. Holds one row per
shadow-mode discovery serve: what legacy served, what PDE would have served, the
serve point, and both timings. It exists so the two engines can be compared on
the traffic users actually receive.

It is named here because the ruling that created it — D7=A — was made **on the
strength of this window**: the argument for a separate table rather than
`rank_events` was append-only-by-construction *plus 90-day retention cover*. A
retention rule that is assumed rather than written down is not cover.

| | |
|---|---|
| retention | **90 days**, the window in force from 2026-08-14 |
| reaper | **none.** No cron, no TTL, no `DELETE` in any code path |
| mutability | `UPDATE` blocked by trigger. `DELETE` reachable **only** via the `auth.users` cascade |
| client surface | none. No route reads or writes it; `anon` and `authenticated` hold no privilege on it |
| population today | **0 rows.** `DISCOVERY_ENGINE_MODE` resolves to `legacy`, so nothing writes here yet |

The same rule as everything else on this page applies to it: at window end,
deletion is a scheduled decision taken by a person against the evidence the
window produced, and there is deliberately no code path in this repository that
would make it automatic.

**Why `DELETE` is not blocked when `UPDATE` is.** The trigger would otherwise
make account deletion fail — the `ON DELETE CASCADE` from `auth.users` would hit
this table and abort the transaction. An observability table must not be able to
hold a user's deletion request hostage. What D7=A was protecting against is a row
that says something different later than it said when written, and that is fully
blocked.

## At window end — 2026-11-12

This is a **decision**, taken by a person, on this agenda:

1. Re-run both censuses. Do not act on the numbers in this file; they are dated
   evidence, and both populations have already moved once.
2. For storage: has anything in quarantine been missed by a user? A quarantined
   object that a real surface needed produces a visible failure, and 90 days is
   long enough for that to have surfaced. If nothing surfaced, that is evidence —
   it is not proof, and the difference should be stated when the decision is
   recorded.
3. For rows: decide per population, not in aggregate. `content_stamps` (254,
   provenance fully established as backfill artifacts) and `rank_events` (86k+,
   ruled untouched) are not the same question and must not be answered together.
4. Verify the deterministic-restoration precondition **at that moment**, not by
   reference to this document.
5. Record the decision and its evidence next to this file.

**Nothing happens automatically on 2026-11-12.** The date is when a question
becomes answerable, not when an action fires.

## Tools

| command | what it does | database writes? |
|---|---|---|
| `pnpm run audit:unreferenced-objects` | storage orphan census | none |
| `pnpm run snapshot:orphan-rows` | row census + capture → artifact | none (writes one local file) |
| `pnpm run quarantine:plan` | re-runs the census, emits the move list + manifest | none (writes one local file) |
| `pnpm run quarantine:sweep-check` | reports which quarantined objects are past the window | none |

**None of these four can move, delete, or modify anything.** There is no
`--apply` flag on any of them, by design.

That is not caution for its own sake. This repository has exactly two sanctioned
doors to a live project: the **strict** guard (sanctioned CI project only,
refuses production unconditionally) and the **read-only audit** door
(production, reads only, opened by typing
`PORTAVA_PROD_READ_ONLY_AUDIT='read-only-audit-against-production'` — a sentence,
not a flag). Moving 34 real user objects in production is not a reason to invent
a third door.

So the tooling produces the **plan**, and executing it against production is a
separate owner-authorized step taken against that concrete artifact — the same
shape as the 2089 policy apply. The plan is what gets reviewed; the move is
mechanical once approved.

### Current state

**The quarantine has NOT been executed.** `docs/ops/artifacts/storage-quarantine-plan.json`
holds the reviewed plan for the 34 objects; no object has moved. The snapshot
artifact for population B **has** been taken and is committed.
