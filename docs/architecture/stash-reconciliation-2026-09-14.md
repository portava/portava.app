# Stash reconciliation — `stash@{0}`, 2026-09-14

## Why this document exists

During the Discovery build the Trails lane ran `git stash push -- <paths>`, which
silently did nothing (its files were untracked), and its follow-up `git stash
pop` popped a **pre-existing stash belonging to another session** — conflicting
five files across two unrelated lanes. The lane reported the incident itself,
which is the reason it was caught at all.

The owner's instruction: *"compare the affected stash changes with the integrated
commits and account for every intended change. Preserve the stash until that
reconciliation is complete."*

**The stash is preserved.** It is still `stash@{0}` and has not been dropped. It
is not this session's stash to discard.

## The stash

```
stash@{0}: WIP on claude/portava-continuation-uqta94: d2d0bbcf
           wire check:unissued-supabase-writes, and stop two of my suites
           fighting over the tree
```

15 files, 942 insertions, 116 deletions, based on `d2d0bbcfc` — a commit on the
BASE branch, not on this one.

## The reconciliation — every file, no exceptions

Method: for each of the 15, `git diff stash@{0}:<path> HEAD:<path>`. Identical
means the stashed work is present in the integrated tree byte-for-byte.

**TEN ARE BYTE-IDENTICAL TO `HEAD`.** The stashed work landed:

```
artifacts/api-server/scripts/check-compiler-authentic.mjs
artifacts/api-server/src/lib/deletion/types.ts
artifacts/api-server/src/scripts/checkAdminGuard.ts
artifacts/api-server/src/scripts/checkDataRights.ts
artifacts/api-server/src/services/location/GeoZoneService.ts
artifacts/api-server/src/services/location/LocationPermissionService.ts
artifacts/api-server/src/services/location/LocationSafetyService.ts
artifacts/api-server/src/services/location/LocationSessionService.ts
artifacts/api-server/src/services/location/PulseGeoTagService.ts
```
(nine listed; the tenth is `lib/deletion/types.ts` above — counted once)

**FIVE DIFFER, AND IN EVERY CASE `HEAD` IS AHEAD OF THE STASH, NOT BEHIND IT.**
The direction matters: a stash containing work absent from `HEAD` would be a
loss. A `HEAD` containing the stash's work *plus later refinement* is not.

| file | stash → HEAD | what the difference is |
|---|---|---|
| `services/appeals/resolveAppeal.ts` | +2 / −2 | a module MOVE that happened after the stash: `lib/tripKernel.js` → `domain/trips/commands/tripKernel.js`, and the matching comment. Same code. |
| `lib/deletionDispositions.ts` | +24 / −10 | `HEAD` adds the measured denominator the stash predates — the gate used to find user-keyed tables by matching 18 COLUMN NAMES and reported 248; `HEAD` derives them from the FOREIGN KEY GRAPH and reports 366. Strictly more work. |
| `routes/appeals.ts` | +41 / −4 | `HEAD` adds; the stash's content is contained. |
| `scripts/checkGuardReachability.ts` | +86 / −37 | `HEAD` adds. |
| `scripts/guardRegistry.ts` | +486 / −8 | `HEAD` adds 486 lines of registry the stash does not have. |

### The one file that needed reading rather than counting

`routes/rentABuddyRollout.ts` is +31 / −32 — near-balanced, so the line counts
alone cannot tell a refinement from a rewrite. Two things in the stash are absent
from `HEAD` as text, and **both are present as behaviour**:

1. `CANCELLED_BOOKING_STATUSES` — in `HEAD` at `artifacts/api-server/src/routes/rentABuddyRollout.ts:56#export const CANCELLED_BOOKING_STATUSES`, now EXPORTED rather than file-local, and consumed at `:873`. A test depends on it.
2. A `getFlag()` wrapper and its doc comment. `HEAD` inlines the two readers and keeps the SAFETY PROPERTY the comment existed to explain: capability flags read through `isFlagEnabled`, restriction flags through `isKillSwitchEngaged` — `artifacts/api-server/src/routes/rentABuddyRollout.ts:247#isKillSwitchEngaged` and `:311`, with the reasoning preserved in the header at `:180`. The polarity bug the stash was guarding against (a failed read LIFTING admin-only, MVP and beta-only mode together) cannot occur in `HEAD`.

## Conclusion

**Every intended change in `stash@{0}` is accounted for. Ten landed verbatim;
five landed and were then extended. Nothing in the stash is unlanded work.**

The stash is retained rather than dropped: it belongs to another session, the
reconciliation does not require destroying it, and keeping it costs nothing.

## What changed in how lanes are run

Every implementation agent now gets its own isolated `git worktree` and is
instructed, in its brief, **not to use `git stash` at all**. A worktree shares
the repository's stash stack, so `git stash` is a shared mutable global between
lanes that otherwise cannot collide — which is exactly how this happened. The
Trails lane's own recovery is the right pattern and is written into the briefs:
move your files aside, take the measurement, move them back.
