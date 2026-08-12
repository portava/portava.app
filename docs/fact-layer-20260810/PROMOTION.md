# PROMOTION — how this packet entered the repository

**Promoted 2026-08-12** from `_incoming/portava-docs-20260810/` by the commit that
added this file. The six documents alongside it are **byte-identical to the
quarantined originals**. Read `README_FIRST.md` next, then `ERRATA.md`, in that
order — their own instructions still govern.

This file is not part of the packet. It records why promotion happened when it
did, and — more importantly — **what has changed underneath the packet since its
anchor**, so a reader in six months does not cite a stale entry believing the
promotion date vouched for it.

---

## Why promotion is correct now

### 1. `_incoming/` is gitignored, so the packet was one container restart from gone

`.gitignore:87` ignores `_incoming/`. These six files had **never been in version
control**. They existed only in a working directory that restarts without
warning, and `DECISIONS.md` is described by `README_FIRST.md` as *"the only one
of the five that could not be reconstructed from the repository."*

That is the whole argument on its own. Everything below is why promoting it is
also *safe* rather than merely urgent.

### 2. Two of the packet's own blocking unknowns are now settled

`README_FIRST.md` sets the governing rule: *"no P1 architecture work may use an
unverified factual claim as a prerequisite,"* and names the ones worth settling
first. Two `[UNVERIFIED]` entries that the packet itself flagged as
decision-blocking have since been answered with live evidence — see
**"What changed since the anchor"** below, items A and B.

The one the packet calls *"the claim you should trust least"* — §9.9, whether
Supabase Management API tokens can be project-scoped — is **still unsettled**.
It cannot be settled by reading code, and it has not been settled here. The
`ci-readme-addition.md` thesis still rests on it, which is why that file carries
its own do-not-merge instruction and why promotion does **not** merge it.

### 3. Promotion moves files; it does not ratify claims

Nothing in the packet was edited, corrected, or upgraded on the way in. A
`[UNVERIFIED]` tag still means unverified. An `ERRATA` entry still stands. The
packet's provenance tags remain the only thing that says how much any sentence
is worth, and this file adds no authority to any of them.

---

## What is NOT promoted

`ci-readme-addition.md` is here as a **document**, not as a change to
`docs/ci/README.md`. Its own header says *"Do not merge as-is"*, and `ERRATA.md`
explains why: three of its factual claims have no fact-layer entry behind them,
and its central thesis rests on the unsettled token-scoping claim. It is stored
so the draft is not lost. **It has not been applied to `docs/ci/README.md` and
must not be until §9.9 is settled.**

---

## What changed since the anchor `13dcfe3`

Everything factual in the packet is anchored at clone commit `13dcfe3`. The live
repository has moved. These are the divergences known as of 2026-08-12. This
list is certainly incomplete — it covers what work since then happened to touch.

### A. §8.4 — `post_media_storage_public_read` **is live**. Resolved.

The packet marks this `[UNVERIFIED]` and `upload-ingest-consolidation.md` §4
calls it *"the one that decides how severe §3 is"*, splitting it into U4a
(is the policy live?) and U4b (what does it grant?).

**U4a is answered: yes.** Verified 2026-08-12 by read-only query against
production `pg_policies` — present on `storage.objects`, `FOR SELECT`, to role
`public`, qualifier `bucket_id = 'post-media'`, no path or owner predicate.

`ERRATA.md` item 2 is therefore **discharged**: it objects that §8.4's heading
says the policy *grants* where the entry says *declares*. The heading's stronger
reading is now the correct one — though for a reason the entry did not have when
it was written, and the entry's body is still right that a migration file is not
evidence of application.

U4b — what `SELECT TO public` grants when the bucket is `public=false` — is
**still open**, and the packet's refusal to guess between its two readings still
stands.

### B. §8.3 — the four undeclared policies are now named. Resolved.

The packet records seven live `storage.objects` policies, three declared by
`0103_post_media.sql`, and notes the other four were counted but never listed.
All seven, from the same 2026-08-12 query:

| Policy | Cmd | Role | Declared by a migration? |
|---|---|---|---|
| `post_media_storage_owner_insert` | INSERT | authenticated | `0103:117` |
| `post_media_storage_owner_delete` | DELETE | authenticated | `0103:132` |
| `post_media_storage_public_read` | SELECT | public | `0103:140` |
| `post_media_storage_memories_stories_insert` | INSERT | authenticated | **no** |
| `post_media_memories_stories_delete` | DELETE | authenticated | **no** |
| `stamp_artwork_service_write` | ALL | service_role | **no** |
| `stamp_artwork_public_read` | SELECT | public | **no** |

The fourth row is the consequential one and the packet has no entry for it:
**any authenticated user may INSERT into `post-media` under `memories/{uid}/…`
or `stories/{uid}/…`**, for nine file extensions. The client code that used that
grant was removed on 2026-08-11; the grant was not.

### C. §7.15 — "nothing sweeps storage objects by media state" is **stale**

True at `13dcfe3`. On 2026-08-11, commit `7aa65b61b` added
`POST /api/postcards/sweep-orphans` — internal-secret gated, one-hour cutoff,
removing storage objects before DB rows so a failed removal retries rather than
stranding the object.

The entry's *conclusion* survives in practice, for a different reason than it
gives: **nothing calls the sweeper.** No scheduler, no cron, no workflow. The
API server starts nineteen background schedulers from `index.ts` and this is not
among them. "No sweeper exists" has become "a sweeper exists and is unwired",
which is a different and much cheaper problem.

`ERRATA.md` item 10's complaint about §7.15's call count (eleven grep hits, ten
calls) is unaffected and still stands.

### D. The three named upload bypasses have moved

`upload-ingest-consolidation.md` §2 lists three. Bypass 3 (the postcards signed
upload) is unchanged. The stories/memories direct-write paths that the design
work treated as live violators were **fixed on 2026-08-11** in the same commit as
the sweeper — `uploadStoryMedia` and `uploadMemoryMedia` now POST to
`/api/media/upload`, the processing path.

⚠ **Only in `travel-buddy-standalone/`.** The unfixed copies remain in
`artifacts/travel-buddy/`, which `replit.md` marks LEGACY-FROZEN. The canonical
tree ships the fix; the frozen tree is what a grep finds first. §1.2 of the fact
layer already warns that the frozen tree exists — this is what that warning is
for.

### E. §7.3 — the EXIF census remains void, and is now un-runnable

The entry's tag is `[DB 2026-08-10 · project not recorded]`, which the fact
layer's own rule at `:31` declares VOID; §10.3 lists it for re-run.

It cannot currently be re-run against production. `auditStorageExif` is guarded
by `ciProdReadOnlyAuditGuard`, which hard-fails on the production project ref
from inside the execution path rather than from workflow YAML. Re-running it is
therefore its own decision — a restored snapshot, or a sanctioned path — not a
task someone can just pick up.

### F. Flag facts in §6 have moved

Ten flags were retired from production on 2026-08-12
(`2080_retire_inert_seeded_flags.sql`) after a wire-or-drop pass found no live
reader for any of them, and `routes/airport.ts`'s fail-open `isFlagEnabled`
shadow was deleted on the same day. Any §6 entry naming
`notifications_enabled`, `notification_digests_enabled`,
`realtime_activity_enabled`, `safety_notifications_enabled`, or the six
retired `COMPASS_*` flags describes rows that no longer exist.

---

## How to keep this file honest

It is an addendum, not a second fact layer, and it will rot the same way if it
is allowed to accumulate. When an entry above is folded back into
`00_VERIFIED_STATE.md` as a corrected entry with a fresh provenance tag, **delete
it from here.** A divergence between this file and the fact layer is the exact
failure — restatement — that `ERRATA.md` says these documents got wrong twice.
