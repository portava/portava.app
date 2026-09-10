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

---

## 1. State at handoff

| Thing | State |
|---|---|
| Repo | `portava/portava.app`, checkout at `/home/user/portava.app` |
| Branch | `claude/portava-continuation-uqta94` |
| Code HEAD | `ed168ed7` — **pushed**. This handoff commit sits directly on top of it and changes no code, so `ed168ed7` is the commit every measurement below was taken at. |
| Working tree | clean |
| PR | [#481](https://github.com/portava/portava.app/pull/481) — **27 of 27 check runs pass, `mergeable_state: clean`** |
| `main` | `0edcb3eb` — has not moved since the PR opened |
| Production Supabase | `ajrurzioarfkagpuxfnb` (travel-buddy) — **read-only queries only; DO NOT mutate** |
| CI Supabase | `hwokxgbmezheskbzskfr` (portava-ci) — migrations may be applied here for rehearsal |

**PR #481 is green and mergeable but has NOT been merged, and merging it is not
delegated.** Nothing in this session asked for or received permission to merge.

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

Thirteen censuses, **3,290 declared requirements**, measured at `ed168ed7` with
`check:census-integrity`:

| census | denom | C | W | N | unparsed | CORRECT | CONSTRUCTED |
|---|---:|---:|---:|---:|---:|---:|---:|
| wall | 205 | 196 | 1 | 0 | 8 | 95.6 % | 96.1 % |
| passport | 169 | 152 | 15 | 1 | 1 | 89.9 % | 98.8 % |
| trust | 52 | 44 | 2 | 0 | 6 | 84.6 % | 88.5 % |
| map | 293 | 213 | 48 | 5 | 27 | 72.7 % | 89.1 % |
| media | 450 | 282 | 69 | 81 | 18 | 62.7 % | 78.0 % |
| discovery | 67 | 39 | 6 | 7 | 15 | 58.2 % | 67.2 % |
| input-intelligence | 373 | 204 | 69 | 70 | 30 | 54.7 % | 73.2 % |
| compass | 90 | 45 | 18 | 15 | 12 | 50.0 % | 70.0 % |
| sensing | 127 | 60 | 39 | 22 | 5 | 47.2 % | 78.0 % |
| telegraph | 451 | 98 | 172 | 157 | 24 | 21.7 % | 59.9 % |
| trips | 451 | 86 | 110 | 186 | 69 | 19.1 % | 43.5 % |
| layover | 296 | 28 | 120 | 148 | 0 | 9.5 % | 50.0 % |
| highlights-memories | 266 | 13 | 65 | 32 | 154 | 4.9 % | 29.3 % |
| **ALL** | **3,290** | **1,460** | **734** | **724** | **369** | **44.4 %** | **66.7 %** |

`C` BUILT-AND-CORRECT · `W` BUILT-BUT-WRONG · `N` NOT-BUILT.

**44.4 % correct / 66.7 % constructed, both floors.** If every one of the 369 prose-counted
requirements were correct the ceiling is 55.6 % / 77.9 %. On parsed rows alone: 50.0 % /
75.1 %.

### What that number is not — quote none of it without these

1. **369 requirements (11 %) are counted in prose the parser cannot read.** Highlights-
   memories is the extreme: 154 of its 266, so its 4.9 % is a floor with enormous room
   above it.
2. **`check:census-integrity` checks each census against *itself*, not against the code.**
   Its own NOTE says so. Neither census guard reads the implementation.
3. **Three censuses carry correction headers** admitting their headline drifted from their
   own body, and several bodies are superseded by later addenda: trust's addendum states
   50/52 → **96.2 % correct, 100 % constructed**, above the 84.6 % its parsed rows give;
   `census-trips.md`'s body headline still reads 41.7 % / 17.3 % and predates §26–§35.
4. **7 of 13 censuses declare no `head_commit` at all** — compass, input-intelligence, map,
   media, passport, sensing, telegraph — so **2,013 of 3,290 requirements cannot be checked
   for staleness in either direction.** That is a weaker state than STALE, not a safer one,
   and it is now the largest measurable gap in the tree.

---

## 5. Pick up here

### A. PR #481 — green, mergeable, NOT merged

Merging is the owner's call and was never delegated. If it merges, **`head_commit`
`42aeac38` stays valid** (it is on `main` already) but the *next* census measured on a
branch must declare a commit that survives the squash — the new guard will tell you if it
does not.

A self check-in was scheduled into **this** session for 02:59 UTC to re-check CI and
mergeability. **It will not reach a new account.** If you want that watch, re-subscribe:
`subscribe_pr_activity(portava, portava.app, 481)`.

### B. OWNER ACTION — production deploy, Batch C

`docs/architecture/manual-production-migration-runbook.md` § "Batch C — Trips v4,
`2450 → 2777` (22 files)" at line 313. **Production is manual by design; do not deploy
automatically.** Preconditions, expected objects, rollback points and post-deployment
certification commands are in that document. Nothing in Batch C has been applied to
`ajrurzioarfkagpuxfnb`.

### C. Re-run the Trips census from zero on merged main

The one task from the owner's plan that is genuinely unfinished. `census-trips.md` has
§29–§35.1 appended and is FRESH at `42aeac38`, but **a from-zero recount of all 451
requirements has not been done** — its parsed 86 C / 110 W is the body plus 13 row
revisions, and its stated headline (41.7 % / 17.3 %) predates everything from §26 onward.
Expect the real number to be materially higher than 19.1 %. Do not quote either until the
recount exists.

### D. The seven censuses with no `head_commit`

Each needs its owning lane to declare one and add a `CENSUS_SCOPE` entry in
`checkCensusFreshness.ts`. Cheapest large win available: it converts 2,013 requirements
from unmeasurable to measurable.

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
