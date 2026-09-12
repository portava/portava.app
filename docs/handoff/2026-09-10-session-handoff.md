# Handoff — 2026-09-10

Written for the next Claude session, on a **different account**. Everything below was
verified by running something or reading a live response. Where a claim is inherited
rather than measured, it says so.

The predecessor to this file is `docs/handoff/2026-08-30-session-handoff.md`. Its two
opening rules still hold and are restated here because they earned their place twice more
in this session.

---

## 0. Read this first

**A green run proves nothing until you have seen it go red.** Every guard changed in this
session was mutation-tested: break it, watch it fail, restore, watch it pass. One mutation
test in this session was itself invalid — I appended a line to a counted file and the
freshness check still said FRESH, which looked like a hole and was not: the check diffs
two *commits*, so an uncommitted change is invisible to it by design. I only found that
out by asking why the mutation did not bite. **When a mutation does not catch, suspect the
mutation before the guard.**

**Read the object, not the sentence about the object** (§32.7 in `census-trips.md`). Cost
this session: I read a ledger entry saying a function had "moved" and wrote that its body
was byte-identical. It was not — it had been reimplemented inline, and the ledger entry
said so in a clause I had skimmed. The conclusion survived (the inlined body is the
delegate's body, verbatim), but only because I diffed it instead of trusting my summary.

**Three specific traps this repository sets, all encountered:**

1. **Squash-merge orphans commits.** A `head_commit` declared from a working tree is an
   ancestor of nothing the moment its branch lands. It resolves in the container that
   wrote it and nowhere else — so a check over it is *green locally, red in CI*. This
   caused the only red CI on PR #481. Now guarded (§3 below).
2. **A guard's allowlist is a claim, not a config.** An entry asserts "this object is
   still broken". Leaving a fixed one in excuses the next regression.
3. **Tests that assert an allowlist's *contents* make that list un-shrinkable.** This
   appeared four separate times. The fix is to parameterise the checker so each test
   states the list it needs.
4. **The checkout may be SHALLOW, and that looks exactly like squash-orphaning.** Added
   2026-09-11. This container held 54 commits. Every census `head_commit` failed to
   resolve, which is precisely the symptom of the orphaning those documents describe —
   and would have been recorded as *proven* while resting on a clone that simply did not
   contain the history. `git fetch --unshallow` (4,300 commits) confirmed the orphaning is
   real, so the conclusion survived; the evidence for it did not, until then. **Run
   `git rev-parse --is-shallow-repository` before concluding anything from a commit that
   will not resolve.**

---

## 1. State at handoff

| Thing | State |
|---|---|
| Repo | `portava/portava.app`, checkout at `/home/user/portava.app` |
| Branch | `claude/portava-continuation-uqta94` — **restarted from `main` after the merge**, per the rule that a merged PR cannot track new work |
| `main` | **`014a25d5`** — the squash of #481. It was `0edcb3eb` for the whole session until then. **`CI (live DB)` is RED on it** — pre-existing, not the merge's doing, see §5A2. `CI` and `Unwired checks` are green. |
| Measurement commit | `ed168ed7` — every number in §4 was taken there. Its content is in `014a25d5`; the two commits after it changed no code. |
| Working tree | clean |
| PR | [#481](https://github.com/portava/portava.app/pull/481) — **MERGED** 2026-09-10, squashed to `014a25d5`, on 27 of 27 green at `28c95411`. **Successor: [#482](https://github.com/portava/portava.app/pull/482)**, opened 2026-09-11 — these doc corrections plus the Trips §36 recount and six census declarations. |
| Production Supabase | `ajrurzioarfkagpuxfnb` (travel-buddy) — **read-only queries only; DO NOT mutate** |
| CI Supabase | `hwokxgbmezheskbzskfr` (portava-ci) — migrations may be applied here for rehearsal |

**CORRECTED AFTER THE FACT.** This document was written while #481 was still
open, and said in three places that it was green, mergeable and **not** merged,
and that merging was not delegated. That was true when written. The owner then
said "merge it", and it was squashed to `014a25d5` on 27 of 27 green — so all
three statements are now false and are corrected here rather than left to be
quoted by whoever reads this next. Everything else in this file was measured at
`ed168ed7` and still holds; the merge changed no code.

The rest of §1 describes the state **after** that merge.

---

## 2. Standing directives inherited from the owner

These came from the owner across several messages and were in force for the whole session.
Carry them forward.

- Do not stop for a report. Do not ask routine questions. Keep working.
- **Do not modify `.claude/settings.local.json`.** Specifically, do not add
  `mcp__Supabase__execute_sql` to the persistent permission allowlist.
- Do not cross OWNER decisions. Do not cross HOLD boundaries.
- Do not fabricate production data. Do not call unmerged code deployed.
- Do not call a migration safe because it "looks additive."
- Do not stop because the current branch is green.
- **BUILT ON BRANCH IS NOT MERGED. MERGED IS NOT DEPLOYED. DEPLOYED IS NOT FLAG ENABLED.
  FLAG ENABLED IS NOT PRODUCTION REALIZED.**
- **P24** — before every green architectural claim ask: *what exactly would turn this red?*
  If there is no concrete answer, the claim is not certified.
- Do not say **"100 %"** unless all of these are true: BUILT, WIRED, REACHABLE, TESTED,
  MERGED, CI-MIGRATED, CI-CERTIFIED, PRODUCTION-MIGRATED, PRODUCTION-CERTIFIED, ENABLED
  where appropriate, GITHUB CLEAN, DATABASE LEDGERS TRUE. **They are not all true.**
- Stop only for: a genuine credential/permission blocker, a destructive or irreversible
  action requiring the owner, a production action, or contradictory evidence that prevents
  a truthful certification.

### GIT SAFETY — non-negotiable, another lane may have staged files

**Never** use `git add -A`, `git add .`, or a bare `git commit`. Every commit:

1. inspect `git status --short`;
2. commit only owned paths via `git commit --only <paths>`;
3. verify with `git diff-tree --no-commit-id --name-only -r HEAD`.

### A trap that cost real work this session

`git checkout -- <file>` to undo a **mutation test** also reverts any *real* edit you made
to that file earlier in the same uncommitted batch. I destroyed two finished edits this
way and had to redo them. **Commit before you mutation-test, or back the file up first.**

---

## 3. What this session did

Fifteen commits on the branch, all pushed. Newest first:

| Commit | What |
|---|---|
| `ed168ed7` | Re-declared the last three orphan `head_commit`s; taught the freshness guard to catch the next one locally |
| `bd3c0af0` | Emptied the last RLS allowlist — 2531 closed the array grant it excused |
| `e866d207` | Shrank the FOR ALL baseline by the three entries 2534/2535 closed |
| `84acc852` | Emptied three allowlists the migrations closed, and the trap emptying them sets |
| `be9b2946` | Re-declared Discovery too; corrected a count I had stated wrong |
| `1c07a842` | The memory kernel race test consumed its own idempotency key |
| `2d25ead2` | Re-declared Trips and Trust at a commit CI can resolve |
| `ef6b03cb` | `audit:schema` finds an `authz` function's grant where the grant actually lives |
| `c96c09e5` | Made the kernel certification executable; wired the suite that never ran |
| `43efdb59` | Executed the kernel — a live vertical slice, and the two things it found |
| `2c9ca4a5` | Merge `origin/main` |
| `d077ed07` | Recorded what the merge did and did not change for Trust and Passport |
| `1cb80622` | A measured trust score is distinguishable from the substituted 50 |
| `9779ac73` | `audit:schema` resolves `authz`; two allowlist entries retired |
| `49e226ec` | Corrected `CI_SUPABASE_TOKEN_401`: an ENVIRONMENT secret, not a repository one |

### The four things worth knowing in detail

**The Trips kernel was executed for the first time.** `trip_kernel_execute` is 103,400
characters of PL/pgSQL (`md5(prosrc)` = `5fd683a457c26a4d084887e365a1fb73`) and nothing had
ever run it. `census-trips.md` §35 records a twelve-command vertical slice against
portava-ci; §35.1 makes it executable as `src/test/tripKernelLive.test.ts`, wired into
`live-db.yml`. **12 of 12 green on its first CI run and every run since.** The function is
`trip_kernel_execute`, *not* `trip_kernel_apply`.

**Memory's live suite had a package script and no caller.** 562 lines invoked by nothing.
Wiring it took one line — and it **found a real defect on its first invocation**: the race
case consumed its own idempotency key, so two of its three assertions were passing on the
CREATE's evidence.

**Four RLS allowlists were emptied**, each verified against `pg_policies_snapshot_v2` /
`pg_trip_members_readers_snapshot`. Emptying one exposed a live trap: the matcher built
`\b(?:public\.)?()\s*\(` from an empty list — an empty alternation group matching **any**
expression containing `(`. A guard that becomes a false-positive generator the instant its
subject is repaired.

**Census `head_commit`s that CI could not resolve.** Six censuses declared pre-squash
commits. Reproduced with `git clone --single-branch` of the branch — which is what CI has
— and the check printed exactly the errors the PR was red on. All six now declare
`42aeac38`. Three moved with zero scoped files changed; the other three required
re-measuring a six-file delta, each verified mechanically before the declaration moved.
The acknowledgements are **retired, not deleted** — they live in a `retired` array in
`CENSUS_STALENESS_ACKNOWLEDGED.json` that nothing reads, because the per-file argument is
the only thing that makes the re-declaration defensible.

`checkCensusFreshness.ts` now rejects a `head_commit` that does not resolve, and separately
one that resolves but is **not an ancestor of HEAD**. Ancestor-of-HEAD rather than
ancestor-of-main on purpose: a census measured on a branch must keep working.

---

## 4. Where the architecture actually stands

Thirteen censuses, **3,290 declared requirements**. **RE-MEASURED 2026-09-11** at merged
`main` `014a25d5` with `check:census-integrity`, after that guard was taught to read three
row shapes it had been silently dropping (see §5C). The figures below are the corpus as it
actually counts today; the `ed168ed7` column they replace was **44.4 % / 66.7 %**.

| census | denom | C | W | N | X | unparsed | CORRECT | CONSTRUCTED |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| wall | 205 | 196 | 1 | 0 | 8 | 0 | 95.6 % | 96.1 % |
| passport | 169 | 152 | 15 | 1 | 1 | 0 | 89.9 % | 98.8 % |
| trust | 52 | 44 | 5 | 0 | 0 | 3 | 84.6 % | 94.2 % |
| map | 293 | 231 | 48 | 5 | 5 | 4 | 78.8 % | 95.2 % |
| media | 450 | 291 | 69 | 88 | 2 | 0 | 64.7 % | 80.0 % |
| discovery | 67 | 39 | 6 | 7 | 0 | 15 | 58.2 % | 67.2 % |
| input-intelligence | 373 | 207 | 69 | 70 | 4 | 23 | 55.5 % | 74.0 % |
| compass | 90 | 47 | 18 | 15 | 0 | 10 | 52.2 % | 72.2 % |
| sensing | 127 | 65 | 39 | 22 | 1 | 0 | 51.2 % | 81.9 % |
| telegraph | 451 | 98 | 172 | 157 | 3 | 21 | 21.7 % | 59.9 % |
| trips | 451 | 88 → **303** (§40–§56, branch) | 162 → **123** | 200 → **24** | 1 | 0 | 19.5 % → **67.2 %** | 55.4 % → **94.5 %** |
| layover | 296 | 28 | 120 | 148 | 0 | 0 | 9.5 % | 50.0 % |
| highlights-memories | 266 | 13 | 65 | 59 | 2 | 127 | 4.9 % | 29.3 % |
| **ALL** | **3,290** | **1,499** | **789** | **772** | **27** | **203** | **45.6 %** | **69.5 %** |

`C` BUILT-AND-CORRECT · `W` BUILT-BUT-WRONG · `N` NOT-BUILT · `X` CANNOT-VERIFY.

**45.6 % correct / 69.5 % constructed, both still floors.**

> **UPDATED 2026-09-11 (later the same day).** The trips row now reads 88/162/200
> rather than 89/127/234, and the corpus 45.6 % / 69.5 % rather than 45.6 % / 68.5 %
> — the corpus CORRECT figure is unchanged to one decimal and the CONSTRUCTED one
> is not, which is the shape of what moved.
>
> **This time verdicts WERE edited**, which the paragraph below says the earlier
> movement was not: census-trips §38 moved TR51 and TR200 C→W against the code, and
> §39 moved thirty-four N rows — thirty-three to W and TR417 to **C** — all
> thirty-four falsified by the single squash merge (`42aeac38e`, #476) that census
> declares as its `head_commit`. **Only census-trips has had a verdict re-derived.**
> The other twelve rows in this table are still the document counting itself,
> exactly as below.

The original movement from 44.4 % / 66.7 %
was **not** work landing — **no verdict in any census was edited.** It is 166 rows that were
always written and never counted: ranges (`| TR38–TR45 | … | **N** ×8 |`), compound ids, and
the labelled id cells (`` | TR78 `trip_stages` | ``) that every "Row moves" and "Row
corrections" table uses. The `X` column is new to this table because `?` had never been in
the checker's alias list at all, so CANNOT-VERIFY was being under-reported corpus-wide —
wall alone carries 8.

**The unparsed column fell 369 → 203**, and six censuses now have **no prose gap at all**
(layover, media, passport, sensing, trips, wall), up from two. Where that column reads 0,
the headline is the table counted and `check:census-integrity` now enforces that they are
equal, not merely that they sum.

### What that number is not — quote none of it without these

1. **203 requirements (6 %) are still counted in prose the parser cannot read**, down from
   369. Highlights-memories is the extreme and is now almost all of it: **127 of the 203**,
   against its own denominator of 266, so its 4.9 % remains a floor with enormous room
   above it. Six censuses have no prose gap at all.
2. **Neither census guard reads the implementation.** `check:census-integrity` checks each
   census against *itself*; `check:census-freshness` checks its AGE. Its own NOTE says so.
   **Nothing in this repository has ever checked a census verdict against the code**, and
   after the 2026-09-11 recount that is unchanged and is the largest remaining gap.
3. **Three censuses carry correction headers** admitting their headline drifted from their
   own body, and several bodies are superseded by later addenda: trust's addendum states
   50/52 → **96.2 % correct, 100 % constructed**, above the 84.6 % its parsed rows give.
   `census-trips.md`'s headline is **no longer one of these** — it was restated from its own
   rows on 2026-09-11 and the guard now enforces that equality wherever a census has no
   prose gap.
4. **1 of 13 censuses declares no `head_commit`** — `census-passport.md`, 169 requirements —
   down from 7 and 2,013. It is the one that **argues** for its own absence: declaring would
   report FRESH about 165 rows nobody re-read, which its header calls *"a worse lie than
   CANNOT BE CHECKED"*. Do not overturn that without re-measuring passport.
5. **A declaration starts a clock; it does not certify a past.** The six declared on
   2026-09-11 were all measured at pre-squash working trees that exist nowhere, so the
   interval before `42aeac38` cannot be diffed and is not claimed to be empty. FRESH means
   *no counted file has moved since the declared commit* — never that a row was re-read.

---

## 5. Pick up here

### A. PR #481 — MERGED, and the one thing that follows from it

Squashed to `014a25d5` on `main`. The PR-watching subscription and the scheduled
check-in that went with it are both retired; there is nothing left to babysit.

**What the merge means for the census guard, which is the only live consequence.**
`head_commit` `42aeac38` stays valid — it was already on `main`. But `014a25d5` is a
*squash*, so every commit on the merged branch (`ed168ed7`, `28c95411`, all sixteen) is now
an ancestor of nothing. **Any census declaring one of them would be exactly the defect this
session closed.** None do. The next census measured on a branch must declare a commit that
survives the squash, and `checkCensusFreshness.ts` will now say so — locally, before CI —
if it does not. That guard is the reason this paragraph is a note and not a trap.

### A2. `main` is RED on `CI (live DB)` — read this before you "fix" it

The push build of the squash (`34430889373`) fails, and it will keep failing until someone
outside this repository acts. **Do not try to make it green.**

```
✖  check:migration-ledger FAILED — this database does not represent this branch.
   3 ledger row(s) name a migration file that is not in src/migrations/.
     • 2311_intel_claim_reviews.sql              (applied_by=manual)
     • 2320_memory_episode_provenance_spine.sql  (applied_by=manual)
     • 2325_telegraph_unsend_before_seen.sql     (applied_by=manual)
```

This is `CI_DB_HAND_APPLIED_FROM_UNMERGED_BRANCHES`, opened the day before the merge. The
three files live in PRs #456/#457/#470/#472, all still open, **#470 marked DO NOT MERGE**.
`certify:migrations` fails at stage 1, so `schema-drift` fails and the verdict job reports
`live-db-security-suites` and `post-media-revocation-rehearsal` as NOT EXECUTED.

**Not the merge's doing, and that is measured, not assumed.**
`git diff --name-status 0edcb3eb 014a25d5 -- artifacts/api-server/src/migrations/` is
EMPTY: the squash added and changed no migration. All three rows are `applied_by=manual`.
Everything else in that job passed — `apply-migrations` had nothing to do (109 proven, 0
pending), and `audit:schema` reported *"Live schema contains every object claimed by the
migrations"* over 494 files and 5,748 objects.

**Deleting those three rows would turn `main` green in one commit. Do not.** It erases the
only evidence that portava-ci ran schema no merged branch can show, which is the whole
finding. The honest closures are in the blocker entry and belong to those branches' owners.

### A3. The limit of "27 of 27 green", stated because I did not state it at the time

`db:apply-migrations` and `certify:migrations` are gated on
`github.ref == 'refs/heads/main'` (`live-db.yml:746`, `:757`). A PR's `schema-drift` job
runs the **dry run** and skips both. So #481's 27-of-27 was true and **never covered
`certify:migrations`** — that gate first executes on the push build *after* a merge. I
reported the green without this caveat. Any "certified" claim resting on PR checks alone is
scoped narrower than it sounds; on this repository, merging is part of the test.

### B. OWNER ACTION — production deploy, Batch C

`docs/architecture/manual-production-migration-runbook.md` § "Batch C — Trips v4,
`2450 → 2777` (22 files)" at line 313. **Production is manual by design; do not deploy
automatically.** Preconditions, expected objects, rollback points and post-deployment
certification commands are in that document. Nothing in Batch C has been applied to
`ajrurzioarfkagpuxfnb`.

### C. Re-run the Trips census from zero on merged main — **DONE 2026-09-11, see §36**

**The recount exists: C 89 / W 127 / N 234 / X 1 = CONSTRUCTED 47.9 %, CORRECT 19.7 %**,
at `head_commit` `014a25d5`. Quote those and not the 41.7 % / 17.3 % or the 19.1 % this
section used to warn about — both are superseded and both are now wrong.

The diagnosis was not what this section expected. The headline was never the hard part:
`check:census-integrity` was reading **382 of 451 rows** because three row shapes were
invisible to it, and the worst of them was the labelled id cell (`` | TR78 `trip_stages` |
W | **W** | ``) that **every** "Row moves" table in §29.4/§30.3/§31.3 and every "Row
corrections" table in §32.4 uses. So the guard was counting superseded originals and
discarding all **28 revisions** that superseded them. The parser now reads all of them,
plus `?` and `⌀`; corpus-wide the unreadable gap went **369 → 203**.

**Not one verdict was moved by that pass.** The +11 C and +17 W are revisions the document
had already written and its guard could not read. §36.4 records four premises merged `main`
falsified — 2760–2777 *are* on main, portava-ci carries through 2777 (13 of 18 rows
`applied_by='ci'`), all eleven §5.1 tables exist there, 61 files read a trip version — and
explains why none of it moves a verdict: production carries **0 of 11** and Batch C is
unapplied, so §29.5's chain advanced two links, not five.

**Still true and still the biggest gap: no census has ever been read against the code.**
19.7 % is the document counted, not the surface measured.

### D. The seven censuses with no `head_commit` — **SIX DONE 2026-09-11**

**12 of 13 censuses are now checkable**, up from 6. Declared with a derived `CENSUS_SCOPE`:
media (450), telegraph (451), input-intelligence (373), map (293), sensing (127), compass
(90) — 1,784 requirements out of unmeasurable.

**`census-passport.md` is deliberately left alone.** Its header argues that declaring would
report FRESH about 165 rows nobody re-read, and that this is *"a worse lie than CANNOT BE
CHECKED"*. That is a lane's stated decision about its own document. Do not overturn it
without re-measuring passport.

**Read what those declarations claim before relying on them.** Each starts a clock; none
certifies a past. Every one of these censuses was measured at a pre-squash working tree
that exists nowhere, so the interval before `42aeac38` cannot be diffed and is *not*
claimed to be empty. FRESH means *no counted file has moved since `42aeac38`* — it does not
mean a row was re-read, and none was.

**A trap worth carrying forward:** this container held a **shallow clone (54 commits)** in
which every census commit failed to resolve — which looks exactly like the squash-orphaning
the documents describe and has an entirely different cause. `git fetch --unshallow` (4,300
commits) confirmed the orphaning is real, but a proof resting on the shallow clone would
have been worthless. **Check `git rev-parse --is-shallow-repository` before concluding
anything from a commit that will not resolve.**

### E. Preserved follow-up finding — do not lose this

**32 unbound-`error` Supabase reads on the Trips surface fabricate a fact on read failure**
— a failed query returns the permissive/default value rather than throwing. The
authorization-critical ones were fixed and fail closed; the rest are recorded and open. The
owner explicitly asked that this be preserved as a separate finding and that the
migration/certification scope **not** be widened for it unless one of them invalidates a
certification.

---

## 6. Blocker ledger — `docs/architecture/blocker-ledger.md`

**Closed in this session** (all four now say so in their headings):

- `TRIPS_HAS_NO_LIVE_KERNEL_SUITE` — closed 2026-09-09, and its "not closed until CI runs
  it" half is now closed too: 12/12 green.
- `MEMORY_LIVE_KERNEL_SUITE_NEVER_RUNS` — closed 2026-09-09; found a real defect on first run.
- `CENSUS_HEAD_COMMITS_UNREACHABLE_IN_CI` — closed 2026-09-10.
- `CI_SUPABASE_TOKEN_401` — closed 2026-09-10. The credential is on the
  **`ci-nonprod-supabase` environment**, not the repository. Evidence is a green
  `schema drift` job, which cannot pass without a working Management API token.

**Still open and relevant:**

| Blocker | Owner | Note |
|---|---|---|
| `TRIP_KERNEL_CREATE_TRIP_UNGUARDED_INSERT` | Trips | The trip family's INSERT is unwrapped, so a draft with no `destination_city` reports a *transient outage* for a permanent error. **Pinned in the live suite as current behaviour** — fixing it turns that test red on purpose. Read the pin before you "fix" the test. |
| `CI_DB_HAND_APPLIED_FROM_UNMERGED_BRANCHES` | — | `certify:migrations` stage 1 fails on three ledger rows naming files this repository does not contain (`2311`, `2320`, `2325`), from #456/#457/#470/#472 — all still open, **#470 says DO NOT MERGE**. Not fixable from inside this repo. |
| `TRIP_KERNEL_NEVER_DEPLOYED` | Trips | Superseded in part by Batch C above; re-read before acting. |
| `PROPOSAL_DECISION_RULE`, `APPEAL_RESTORE_SEMANTICS`, `TRUST_OVERRIDE_PIN_OR_CAP`, `WALL_ACCENT_COLOUR`, `VISA_BUDDY_CAPABILITY`, `DISPLAY_NAME_RULE_LOCAL_COPIES`, `CLIENT_NODE_SUITE_CANNOT_RUN` | various | Owner decisions or other lanes. Untouched this session. |

---

## 7. How to run things

```bash
# a single api-server test file
cd artifacts/api-server
SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
  node --import tsx/esm --test src/test/<file>.test.ts

# the census guards
node --import tsx/esm src/scripts/checkCensusIntegrity.ts
node --import tsx/esm src/scripts/checkCensusFreshness.ts
node --import tsx/esm src/scripts/checkGuardReachability.ts

# reproduce what CI sees, which is NOT what this container sees
git clone --quiet --branch <branch> --single-branch /home/user/portava.app /tmp/cisim
ln -sfn /home/user/portava.app/artifacts/api-server/node_modules \
        /tmp/cisim/artifacts/api-server/node_modules
cd /tmp/cisim/artifacts/api-server && node --import tsx/esm src/scripts/checkCensusFreshness.ts
```

That last one is the single most useful trick this session produced. A plain local clone
drops unreachable objects, which is exactly the difference between this container and a CI
runner.

**Live database work** goes through `mcp__Supabase__execute_sql` with `BEGIN … ROLLBACK`.
Multi-statement works, it returns the last `SELECT`, and it leaves the database unchanged —
that is how the kernel slice was executed without writing anything.

`run-live-suite.sh` scores on **output** (`pass > 0` AND `skipped == 0`), not on exit code.
A suite that skips everything and exits 0 is a failure.

`live-db-security-suites` needs only `[preflight, live-db-slot, schema-drift]` — **not**
`api-server-check-all`.

---

## 8. Honest gaps in this handoff

- **The Trips percentage in §4 is body-derived and understated.** I did not do the recount
  (§5C) and am not guessing at what it would produce.
- **No census has been read against the code.** Neither guard does that; nothing in this
  session did either. Every percentage here is a document measuring itself.
- **PR #481's green is CI green, which is not production truth.** Batch C is unapplied,
  no flag is enabled, and no production certification exists.
- I re-declared `head_commit` on **five censuses owned by other lanes** (Discovery, Trust
  earlier; highlights-memories, layover, wall in `ed168ed7`). Each declaration row says it
  was changed by the Trips lane, gives the measurement, and invites a revert. If a lane
  disagrees, reverting costs only the check.

---

## 9. Addendum — the 2026-09-11 session, and what it leaves for the next one

Written by the session that picked this file up from the branch. Three commits on
`claude/portava-continuation-uqta94`, all on [#482](https://github.com/portava/portava.app/pull/482).

**What was done.** §5A's doc corrections landed on a PR (they were only ever on a branch
before, so `main`'s copy was still misleading). §5C is DONE — the Trips recount exists and
the number is **19.7 % correct / 47.9 % constructed**. §5D is six-sevenths done — **12 of 13
censuses are now ageable**, passport excepted on its own documented argument.

**The finding worth carrying.** The Trips headline was never the hard part. The guard was
reading 382 of 451 rows, and the shape it dropped hardest was the labelled id cell that
**every** "Row moves" and "Row corrections" table uses — so it was counting superseded
verdicts and discarding all 28 corrections that superseded them, with a guard's authority
behind the wrong answer. A census whose corrections are the one thing its checker cannot
read is worse than an uncounted one. Corpus unreadable gap: **369 → 203**.

**Two guard defects were found green.** `check:census-integrity` matched headline buckets
with `CANNOT-VERIFY[^|]*`, which also matches the `CANNOT-VERIFY share` row beneath it and
read `**1 / 451 = 0.2 %**` as `2`. It had never fired because the check it feeds only runs
when parsed rows equal the denominator, which no census reached while whole row shapes were
being dropped — fixing the parser would have failed four censuses on arithmetic that was
never wrong. And `?` was missing from the verdict alias table entirely, so CANNOT-VERIFY
was under-counted corpus-wide. **Both were green for their whole lives because nothing had
ever reached them.** That is the §0 rule in its least obvious direction: not "a green run
proves nothing until you have seen it go red", but *a guard that has never been reached is
not a guard yet.*

### What is NOT done, stated plainly

- **No census has ever been read against the code.** Every percentage in §4, the recounted
  Trips figure included, is a document measuring itself. This is now the largest gap in the
  tree by a wide margin, and it is unchanged by everything above.
- **`main` is still RED on `CI (live DB)`** for `CI_DB_HAND_APPLIED_FROM_UNMERGED_BRANCHES`
  (§5A2). Nothing in this repository can close it. It was not touched.
- **Batch C is still unapplied.** Production carries **0 of 11** §5.1 trip tables — verified
  read-only this session, not inherited. Owner action, §5B.
- **`census-passport.md` is still unmeasurable**, by its lane's choice.
- **The 32 unbound-`error` Supabase reads (§5E) were not touched** and remain open.
- **Trips §36.5 lists what the recount does not claim.** Sections of the spec outside those
  §26–§35 reopened still carry `68ed59d9` verdicts; the Trip Kernel programme plausibly
  moved rows in several of them, and nobody has looked.

### The next cheapest large win — **TAKEN for Trips, see census-trips §37**

That win was stated here as: a guard that takes a census's C rows and confirms the cited
`file:line` still exists and still contains what the row says. It turned out the guard
already existed — `check:doc-citations` — with its *range* half enforced over
`docs/architecture/` and its *anchor* half opt-in and largely unused. §37 is that pass,
run over Trips.

**It moved no verdict, and it found that 37 citations had rotted.** `census-trips.md`
carries 338 citations; **315 of 338 were range-only**, and a range check asks only whether
the file is still long enough. Under the 89 BUILT-AND-CORRECT rows the drift was severe and
entirely invisible: the only reader of `trip_activity_log` off by **641** lines, the
`DELETE members` route by **480**, the plan-mutation guard in `routes/trips.ts` by **219**,
`isAcceptedTripMember` by **22**, `canEditPlan` by **10**. Every one stayed *in range*, so
the check was green on all of them for as long as they have been wrong. 37 corrected and
anchored; the repo-wide anchored count is **243 → 278** and the ratchet floor moved with it.

**The structural finding is the one to carry.** `check:census-freshness` reported Trips
FRESH throughout — truthfully, about the wrong half. The census cites 49 distinct files and
**10 were in its `CENSUS_SCOPE`**; the 39 missing were led by `lib/tripCrewLocation.ts` (34
citations), `routes/trips-expansion.ts` (28) and `compass/CompassTools.ts` (26). The scope
covered the Trip Kernel programme — so it watched the **W** rows, the ones saying something
is *not* right, and left the **C** rows unguarded. **Check every other census's scope for
the same inversion**: the five declared on 2026-09-11 were scoped from their citations, so
they should be better, but none has been audited this way.

**And one method rule, bought at the cost of a near-miss.** §37 almost recorded TR10 as
wrong — the census says `trip_crew_map_enabled` is seeded false at
`0041_trip_crew_location.sql:63`, and the first resolution showed line 130 seeding it
**true**. *Three files share that basename.* The census means the one under
`src/migrations/`, where line 63 seeds false and the citation is exactly right. **A
basename that resolves to more than one file has not been resolved** —
`check:doc-citations` reports **593** such citations corpus-wide, 53 of them in Trips.

### What is still open after §37

- **No verdict has been re-derived.** §37 checked that each cited artifact exists and still
  says what the row says. Whether the BUILT-AND-CORRECT *judgement* was right is untouched.
- **Only the C rows' unreadable citations were opened** — 132 range-only citations on W rows
  and 40 on N rows were not read, and are as likely to have drifted.
- **An anchor pins a line, not a meaning.** `#canEditPlan` cannot tell that the function's
  behaviour changed under a stable name.
- **The other twelve censuses have had no citation pass at all**, and 5,900 of the corpus's
  6,213 citations remain range-only.

---

## 10. Addendum — §38 and §39, and what they leave

§9 named the next cheapest large win and §37 took it. Two passes have gone
further, and the second one is the reason this section exists.

| pass | what it re-derived | what moved |
| --- | --- | --- |
| **§38** | 44 of the 89 **C** rows, against the code | TR51 and TR200 C→W. **Down.** |
| **§39** | 34 of the 234 **N** rows, against the code | thirty-three N→W and one N→**C**. **Up 7.5 points of CONSTRUCTED, 0.2 of CORRECT.** |

**The finding that matters is not either set of rows. It is that until §39 every
pass this corpus had run could only travel in one direction.** §37 and §38 read C
rows. A C row is falsified by the thing being broken. An **N** row is falsified by
the thing being **built** — which is the normal outcome of working on the product
— so N rows rot by default, silently, and in the direction that makes the
architecture look worse than it is. Nobody had ever looked.

Trips was **88 C / 162 W / 200 N / 1 X — 55.4 % constructed, 19.5 % correct** at §39;
after census-trips §40.1–§56 on `claude/sweet-fermat-fmx7up` (not merged) it is
**303 C / 123 W / 24 N / 1 X — 94.5 % constructed, 67.2 % correct**, every moved row
graded on a file, a line, a test and a mutation that went red, and every kernel-era
projection behind `trip_operational_projections_enabled` seeded FALSE.
Thirty-three of the thirty-four are built and not shown to work. The thirty-fourth,
**TR417 (§22.4 idempotency), is proven live** — `tripKernelLive.test.ts:325-342`
replays a command key and gets `duplicate: true` at the ORIGINAL version with no
second row written — and is the first verdict any pass has moved INTO correct.
`trip_kernel_enabled` is still seeded FALSE, so that proof is portava-ci's, not
production's.

### The three things a next session should take from it

1. **The other twelve censuses have had no N-row pass at all.** 776 N rows across
   the corpus stand on whenever they were last written. Trips' thirty were all
   falsified by **one squash merge** — the same one the census declares as its
   `head_commit` — so the question to ask each census is not "is this row old"
   but **"what landed since, and which of these rows did it build?"**
2. **Three mechanical routes find them, and none is a verdict.** (a) Source files
   that cite a census row id: 65 in Trips, 16 of them scored N, 10 real. (b) N rows
   naming a backticked identifier in the absence position: 46 in Trips, 12 with
   hits. (c) N rows claiming an endpoint is "Not registered": 10 in Trips, 4 real,
   checked against `routes/index.ts`. All three are reasons to open a file. §38's
   TR353 rule holds — a count is evidence for opening a file, never a substitute for
   opening it — and four of §39's twelve Route-2 candidates were other domains
   entirely.
3. **`check:census-row-move-labels` is new and it found the structural cause.**
   census-trips §29.4 restated its moved rows as `` | TR90 `trip_outcomes` | ``,
   and from TR89 on the ids ran one ahead of the objects. Every count uses the id,
   so TR91 was never moved and kept "Does not exist." while
   `CREATE TABLE public.trip_outcomes` sat on `main`. The mislabelling had already
   propagated into the code — migration 2768 comments
   `RECORD_OUTCOME -> trip_outcomes (TR90)`. **Run that check against any census
   before trusting its "Row moves" section.**

### What is NOT done

- **200 N rows and all 162 W rows in Trips are still un-re-derived**, and 45 of the
  88 C rows. §39 looked where three greps pointed and nowhere else — and the third
  route ran *after* §39.6 had already declared the pass finished, which is why §39.6
  is left standing unedited beside §39.7. "I stopped looking, then looked again and
  found four more" is the rate, and editing it away would hide it.
- **`census-passport.md` still declares no `head_commit`**, deliberately and with a
  stated argument in its own header. That is its lane's call; `checkCensusFreshness.ts`
  records the refusal rather than overriding it. Twelve of thirteen are checkable.
- **Nothing here is merged.** PR #482 is draft on purpose, and the `certify:migrations`
  blocker on `main` is unchanged and is not this work's doing. **Do not clear it by
  deleting ledger rows 2311/2320/2325** — that erases the only evidence of the problem.
