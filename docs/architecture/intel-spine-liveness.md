# Intel spine liveness — current state

*Derived from the repository at `claude/portava-continuation-uqta94`, 2026-09-07. Authoritative
for control flow only where it cites a file.*

Paths are relative to `artifacts/api-server/` unless prefixed `travel-buddy-standalone/`.

---

## MEASURED AGAINST PRODUCTION, 2026-09-07 — read this before the verdict below

The body of this document was written **without database access** and correctly listed its own
open questions. Those questions have since been settled by querying production
(`ajrurzioarfkagpuxfnb`) directly. **Two of its premises are wrong, and the correction inverts
half the verdict.**

**The gates are OPEN, not seeded closed.** Live `feature_flags` values in production:

| Flag | Migration seeds | **Production** |
|---|---|---|
| `intel_capture_quick_signal` | `2165:39-41` false | **TRUE** |
| `intel_claim_projection_crowd` | false | **TRUE** |
| `intel_rewards` | `2170:61-63` false | **TRUE** |
| `budget_intelligence_enabled` | — | **TRUE** |
| `disable_intel_live_labels` | — | false |
| `intel_coverage_missions`, `intel_promotion`, `intel_retention`, `intel_pattern_learning`, `intel_calibration`, `intel_attribution`, `intel_scoped_trust` | — | **ABSENT** → read false |

So the §"could not establish" item 2 below resolves in favour of
`docs/handoff/2026-08-30-audit-findings.md` H6, **not** in favour of the migration seed. A
migration file is not evidence of live state in either direction
(`.agents/memory/migration-applied-vs-committed.md`).

This document's own operational warning — *"flip `intel_claim_projection_crowd` and the reward
job starts booking credits on its next tick with no further switch"* — describes a flag that
**is already flipped in production.**

**And yet every table is empty.** Exact `count(*)` against production, not `reltuples`:

| Table | Rows |
|---|---|
| `intel_observations` | **0** |
| `intel_claims` | **0** |
| `intel_evidence` | **0** |
| `intel_state_snapshots` | **0** |
| `intel_coverage_snapshots` | **0** |
| `intel_reward_ledger` | **0** |
| `intel_contribution_consent` | **0** |

`intel_contribution_consent` is the decisive one. This document names it the only intel table
that is **ungated** — writable by any logged-in user through a real settings screen — and calls
it "the cheapest possible test of whether the front door has ever been opened." It holds zero
rows.

**The corrected verdict: the spine is not starved by its gates. Its gates are open, its
schedulers run, its capture endpoint is reachable from a live client screen — and nothing has
ever entered it.** Not "built but switched off". Built, switched on, and unused.

**Consequence for the Sensing census.** Commit `0597a245` records `CORRECT 32.1%` and states
that the whole correct column is pre-existing intel-spine work. That column is counting
machinery which, as of this measurement, has never produced a single row in production. Any
percentage resting on it must say so.

*Everything below this line is the original code-derived analysis. Its control-flow findings —
all eight schedulers registered at `src/index.ts:135-167`, `intel_live_promoted_scopes` having no
writer anywhere, `mediaEvidenceLink.ts:158` having no production caller — were verified against
the tree and stand unchanged. Only its claims about live flag values are superseded above.*

---

## Verdict (as originally written — superseded in part, see above)

**The intel spine is reachable, not inert — but it is reachable and *starved*.**

Every structural excuse for a dead lane is absent here. Every one of the eight intel schedulers
is registered at a real line in the server's startup path (`src/index.ts:135-167`), every intel
router is mounted (`src/routes/index.ts:291-300`), the capture endpoint has a live client caller
with a real navigation path into it, and nine of the ten tables have a writer that some
registered route or scheduler can actually invoke. This is **not** the `activity_events` shape —
a producer nothing calls — and it is not the `public.circles` shape — readers with no producer
anywhere.

What holds it empty is different and simpler: **a chain of fail-closed feature flags, each
seeded `false`, whose head is `intel_capture_quick_signal`.** Nothing enters the spine except
through `writeObservation`, and `writeObservation` refuses on that flag before it does anything
else (`src/services/intel/IntelCaptureService.ts:324`). Every downstream table's producer reads
rows that only capture can create, and each returns early on an empty input rather than writing.
So the spine's emptiness is one switch deep, not ten defects deep — and flipping that one switch
does **not** open the spine, because each stage carries its own separately-seeded `false`.

The one live exception matters and cuts the other way: `intel_rewards = TRUE` in production, so
`runIntelRewardPass` is **executing on a timer right now** and is genuinely capable of writing
`intel_reward_ledger`. It writes nothing because its first read —
`intel_state_snapshots WHERE privacy_eligible AND expires_at > now()` — returns zero rows and it
returns early (`src/lib/intelRewardScheduler.ts:143`). That is a *starved live job*, not an
unreached one. The distinction is the whole finding.

**What this means for commit `0597a245`'s "CORRECT 32.1%".** If that census counted intel-spine
machinery as implemented, the count is defensible as *code that exists, is wired, and would run*
— but it is not evidence of *anything having run*. Nine of ten tables have a reachable writer;
whether any has ever accepted a row could not be established from the tree, and the one instrument
that could settle it is a production count this document is not permitted to take. The honest
qualification is: **the spine is built and wired; whether it has ever produced a row is
unestablished, and the flag evidence makes "never" the more likely reading.**

### One documentary datum that would change the reading, which I could not verify

`docs/handoff/2026-08-30-audit-findings.md` (finding H6) states flatly:
**"Flag `intel_capture_quick_signal` is on in prod."** That claim is 8 days old, is not a
measurement I took, and is not in the set of live facts I was given. If it is true, then
`POST /v1/intel/observations` is *live* and `intel_observations`, `intel_claims` and
`intel_confirmations` are writable by any consenting authenticated user today — and the "never
exercised" framing collapses for the top three tables. If it is stale, the seeded `false`
(`src/migrations/2165_intel_capture_quick_signal_flag.sql:39-41`) stands.

**Could not establish from code; requires a production read of
`feature_flags WHERE flag = 'intel_capture_quick_signal'`.** This is the single highest-value
follow-up in this document, and it is a one-row read, not a count.

The same H6 finding also asserts a *live caller* pressing "Approve & make it live" in
`app/intel/moment.tsx` and generating duplicate `status='candidate'` rows. That is an assertion
about user behaviour in production. If it was true, `intel_claims` was non-empty in August. The
routing defect it describes is fixed (`src/routes/intel.ts:299-300` now uses slash segments, with
the 2026-08-29 post-mortem inline at `:275-298`), but the fix does not tell us whether rows
landed first. **Could not establish from code.**

---

## Method, and its inherited caveat

`src/scripts/checkWriterlessReads.ts` is the repo's own instrument for exactly this question, and
this document uses its definition of a writer (`:29-37`): `.insert/.upsert/.update/.delete` in
server TS, the same in client TS, or `INSERT/UPDATE/COPY` anywhere in SQL including function and
trigger bodies. It also carries a caveat this document inherits verbatim:

> A dynamic `.from(expr)` anywhere makes attribution incomplete, and the run says so rather than
> pretending otherwise. […] This check errs toward silence: an unattributable write means a table
> is NOT reported. — `checkWriterlessReads.ts:39-40`, `:344-345`

**How that caveat lands here.** Dynamic `.from(table)` does occur in this lane: three
`fetchIn<T>()` helpers take the table name as a parameter —
`src/lib/intelRewardScheduler.ts:95`, `src/lib/intelCoverageScheduler.ts:77`,
`src/lib/intelAttributionScheduler.ts:84`. I read all three bodies. Each builds only
`db.from(table).select(columns).in(column, slice)` — **read-only, no write verb reachable
through any of them**. So for the ten intel tables specifically, the dynamic-`from` blind spot
hides no writer. Other dynamic sites exist elsewhere in the tree
(`src/lib/rentBuddyRequestSweeper.ts:368`, `src/lib/canonicalLocations.ts:416`) and touch no
intel table.

I also cross-checked every table against SQL function bodies and against the client workspace, on
the explicit warning that a `from("table")` grep alone misses variable and RPC access. That
cross-check found two writers a TS-only grep would have missed:
`system_promote_admissible_intel_claims` (an RPC that INSERTs `intel_claims`,
`src/migrations/2174_intel_system_claim_promotion.sql:85`) and the retention/erasure DELETE
functions in `2130`, `2173` and `2278`.

**What this document cannot do.** It cannot distinguish "a writer that has never fired" from "a
writer that fired and whose rows were later swept". `2173_intel_contribution_retention.sql` and
`2133_intel_retention.sql` both delete intel rows on a cutoff, and both sweeps are themselves
flag-gated off. An exact `count(*)` per table is the only instrument that settles it, and it is
out of scope by instruction.

---

## The gate that explains everything: one flag chain, all seeded off

`src/lib/intelContracts.ts:764-771` declares the dependency graph in code, and every migration
that seeds a link in it seeds `false`:

| Flag | Seeded | Citation | Gates |
|---|---|---|---|
| `intel_capture_quick_signal` | **false** | `2165_intel_capture_quick_signal_flag.sql:39-41` | all capture: observations, propose, approve, confirm, correct, evidence |
| `intel_trail_followup` | false | `2166_intel_trail_followup_flag.sql:48` | the `trail` capture surface (also requires the above) |
| `intel_claim_projection_crowd` | **false** | `2132_intel_projection_flag.sql:32-36` | projection scheduler **and** promotion scheduler |
| `intel_coverage` | **false** | `2181_intel_coverage_snapshots.sql:72-79` | coverage snapshot producer |
| `intel_missions` | **false** | `2181_intel_coverage_snapshots.sql:82-83` | mission generation + dispatch |
| `intel_pattern_learning` | **false** | `2279_intel_historical_patterns.sql:194`, postcondition `:202-205` asserts on_count=0 | pattern producer |
| `intel_calibration_report` | **false** | `2279_intel_historical_patterns.sql:197` | calibration report (read-only) |
| `intel_outcome_attribution_enabled` | **false** | `2277_intel_outcomes_attribution.sql:299-302` — postcondition *raises* if seeded ON | attribution ledger + scoped-trust fold |
| `intel_retention_sweep_enabled` | false | `2133_intel_retention.sql:81` | snapshot expiry sweep |
| `intel_contribution_retention_enabled` | false | `2173_intel_contribution_retention.sql:114` | 180-day contribution purge |
| `map_contributions_enabled` | **false** | `2216_map_observations.sql:85-87` | `POST /api/map/observations` (second gate; capture flag still applies) |
| `media_request_a_view_enabled` | false | `2257_media_view_requests.sql:15` | Request-a-View mission rows |
| **`intel_rewards`** | seeded false `2170_intel_reward_ledger.sql:60-64` — **TRUE in production** (given) | — | reward ledger booking |

`isFlagEnabled` is fail-closed on an absent row and on a read error; `src/routes/intel.ts:350-353`
records the house rule that a flag arrives with its reader and an absent row reads as off.

The chain declared at `intelContracts.ts:765-770` is real, not decorative:
`intel_claim_projection_crowd` depends on `intel_capture_quick_signal`,
`intel_live_label_crowd` on projection, `intel_missions` on capture. Turning on any downstream
flag alone produces nothing, because the upstream stage never wrote the rows it reads.

---

## 1. Per-table write paths

Each row answers: is there a writer, and can a registered route/scheduler actually invoke it?

| Table | Writer (file:line) | Reachable from | Gate | Reachable? |
|---|---|---|---|---|
| `intel_observations` | `services/intel/IntelCaptureService.ts:427` (`insert`) | `POST /v1/intel/observations` — `routes/intel.ts:189`, router mounted `routes/index.ts:291`; **client caller** `travel-buddy-standalone/src/services/intelCapture.ts:100`, reached from `app/intel/quick-signal.tsx:254` (`PromptBlock`), which is navigated to from `src/components/place/living/LivingDestinationPage.tsx:314,426` and deep-link `src/navigation/portavaRoutes.ts:2005`. Second caller: `POST /api/map/observations` (`routes/mapObservations.ts:111`, mounted `routes/index.ts:265`). | `intel_capture_quick_signal` (`IntelCaptureService.ts:324`) **then** D4 consent row (`:331`) | **YES — full UI-to-table path** |
| `intel_contribution_consent` | `lib/intelConsent.ts:117` (`upsert`) | `PUT /v1/intel/consent` — `routes/intel.ts:176`; **client** `travel-buddy-standalone/src/services/intelConsent.ts:14`, called from `app/settings/intel-prompts.tsx:49` and `src/components/intel/IntelConsentGate.tsx:15`; entered from `app/settings/index.tsx:278` and `app/profile/edit/index.tsx:96` | **NONE — no feature flag.** Auth only. | **YES — ungated. The one intel table any logged-in user can write today.** |
| `intel_claims` | (a) `IntelCaptureService.ts:526` (`insert`, propose); (b) `IntelCaptureService.ts:551` (`update` → active, approve); (c) RPC `system_promote_admissible_intel_claims` `2174_intel_system_claim_promotion.sql:85` | (a)/(b): `POST …/claims/propose` and `…/claims/approve`, `routes/intel.ts:299-300`; client `app/intel/moment.tsx:26`. (c): `lib/intelPromotionScheduler.ts:55` (`db.rpc`), started `index.ts:136` | (a)/(b) `intel_capture_quick_signal`; (c) `intel_claim_projection_crowd` | **YES** (two independent paths) |
| `intel_confirmations` | `IntelCaptureService.ts:587` (`insert`) | `POST /v1/intel/claims/:id/confirm`, `routes/intel.ts:309`; client `app/intel/moment.tsx:26` | `captureSystemEnabled` (either capture flag, `IntelCaptureService.ts:101-106`) + consent | **YES** |
| `intel_state_snapshots` | `lib/intelProjection.ts:410` (`upsert`); `lib/intelProjectionScheduler.ts:167` (`update`, go-dark) | `lib/intelProjectionScheduler.ts:97` → `projectAndStore`, started `index.ts:137` | `intel_claim_projection_crowd` | **YES — scheduler runs; input starved** |
| `intel_reward_ledger` | `services/intel/RewardService.ts:72` (`insert`) | `lib/intelRewardScheduler.ts:240` → `recordEarnedReward`, started `index.ts:158` | `intel_rewards` — **TRUE in production** | **YES — and the gate is OPEN. Starved only by empty `intel_state_snapshots` (`intelRewardScheduler.ts:143`).** |
| `intel_coverage_snapshots` | `lib/intelCoverageScheduler.ts:198` (`insert`), `:112` (`delete` prune) | started `index.ts:145` | `intel_coverage` | **YES — scheduler runs; gate closed** |
| `intel_mission_candidates` | (a) `services/intel/CoverageService.ts:77` (`insert`); (b) `services/media/MediaViewRequestService.ts:182` (`insert`) | (a) `lib/intelCoverageScheduler.ts:206` and admin `POST /v1/internal/intel/missions` (`routes/intelCoverage.ts:112`, mounted `routes/index.ts:293`); (b) `routes/mediaViewRequest.ts:24`, mounted `routes/index.ts:279` | (a) `intel_missions` (`CoverageService.ts:59`); (b) `media_request_a_view_enabled` (`MediaViewRequestService.ts:96`) | **YES** (two paths, both gated) |
| `intel_evidence` | (a) `lib/intelEvidenceCapture.ts:262` (`insert`); (b) `lib/media/mediaEvidenceLink.ts:158` (`insert`) | (a) `routes/mapObservations.ts:773` → `attachMediaEvidence`, mounted `routes/index.ts:265`. (b) **NO PRODUCTION CALLER** — `linkMediaEvidence` is imported nowhere outside `src/test/mediaEvidenceSeam.test.ts`; the module says so itself at `mediaEvidenceLink.ts:33-49`. | (a) `map_contributions_enabled` (`mapObservations.ts:741`) **then** `intel_capture_quick_signal` (`intelEvidenceCapture.ts:205`) **then** consent **then** an existing owned `intel_observations` row (`:227-238`) | **PARTIAL — (a) reachable and quadruple-gated; (b) is a writer in a module nothing imports, i.e. not a write path** |
| `intel_live_promoted_scopes` | **NONE.** No `.insert/.upsert/.update/.delete` in server TS, client TS, or any SQL file. Only grant is `GRANT SELECT, INSERT, UPDATE, DELETE … TO service_role` (`2179_intel_live_promoted_scopes.sql:38`). Sole reader: `lib/liveClaimRead.ts:229`. | — | — | **NO — by design. See below.** |

### `intel_live_promoted_scopes` is not a defect

The ratchet records it as `human-allowlist`, and the recorded note (`checkWriterlessReads.ts:172-180`)
is the ruling:

> Migration 2179's per-scope Live allowlist. It starts EMPTY so that turning the global
> `intel_limited_live` flag on exposes nothing until a scope is explicitly promoted after a
> density gate and human review — the fix for a single-global-flag over-exposure bug. This is why
> `wall_live_for_you_enabled` should stay off: it would serve an empty strip.

Its emptiness is the fail-closed default, deliberately with no application write path. Rows are
expected to arrive by operator action. **Whether any operator has ever inserted one could not be
established from code; requires a production row count.** Note the ratchet's own consequence
clause: if this table is empty, the Wall's Live strip serves nothing regardless of any other flag.

---

## 2. Scheduler registration — the crux

**Every intel scheduler is registered. There is no unregistered scheduler in this lane.** This is
the finding that most changes the shape of the question, so each is cited individually.

| Scheduler | `start…()` defined | Registered at | Flag it reads |
|---|---|---|---|
| `intelRetentionScheduler` | `lib/intelRetentionScheduler.ts:147` | **`src/index.ts:135`** | `intel_retention_sweep_enabled`, `intel_contribution_retention_enabled` (`:153`) |
| `intelPromotionScheduler` | `lib/intelPromotionScheduler.ts:80` | **`src/index.ts:136`** | `intel_claim_projection_crowd` (`:83`) |
| `intelProjectionScheduler` | `lib/intelProjectionScheduler.ts:216` | **`src/index.ts:137`** | `intel_claim_projection_crowd` (`:219`) |
| `intelCoverageScheduler` | `lib/intelCoverageScheduler.ts:262` | **`src/index.ts:145`** | `intel_coverage` (`:29`) |
| `intelPatternScheduler` | `lib/intelPatternScheduler.ts:196` | **`src/index.ts:150`** | `intel_pattern_learning` (`:37`) |
| `intelCalibrationScheduler` | `lib/intelCalibrationScheduler.ts:131` | **`src/index.ts:154`** | `intel_calibration_report` (`:36`) |
| `intelRewardScheduler` | `lib/intelRewardScheduler.ts:271` | **`src/index.ts:158`** | `intel_rewards` (`:56`) — **TRUE live** |
| `intelAttributionScheduler` | `lib/intelAttributionScheduler.ts:242` | **`src/index.ts:167`** | `intel_outcome_attribution_enabled` (`:38`) |
| `registerScopedTrustApplier` (§15 fold, runs inside the attribution pass) | `lib/intelScopedTrustApply.ts:266` | **`src/index.ts:166`** | rides the attribution flag |
| `intelligenceGraphScheduler` | `lib/intelligenceGraphScheduler.ts` | **`src/index.ts:124`** | — writes **no** `intel_*` table; this is the Compass intelligence graph, a different lane despite the name |

There are no other `src/lib/intel*` schedulers; the enumeration above is complete for that glob.

**The registration is real, not nominal.** All ten sit inside the `app.listen` callback
(`src/index.ts:98`), which is the production entrypoint: `package.json:9` runs
`./dist/index.mjs`, built by `build.mjs` from `src/index.ts`. Each `start…()` is a plain
`setTimeout` self-rescheduling loop with no `NODE_ENV`, no env-var guard, and no conditional
around the call site — compare `STAMP_WORKER_ENABLED` at `src/index.ts:184` and
`FX_REFRESH_ENABLED` at `:199`, which *are* env-guarded. Concretely, for the projection
scheduler: `startIntelProjectionScheduler` at `intelProjectionScheduler.ts:216-227` logs
"scheduled (no-op until the flag is enabled)" and arms the timer unconditionally.

**Consequence.** On every production boot, eight timers arm and eight passes run on their
intervals. Seven of them call `isFlagEnabled`, get `false`, and return `{reason: "disabled"}`
without a read or a write. The eighth — reward — gets `true`, performs a real
`intel_state_snapshots` SELECT, gets zero rows, and returns at
`src/lib/intelRewardScheduler.ts:143`. That is the entire observed behaviour of the spine.

**Routers, for completeness.** All six intel routers are mounted:
`intelRouter` `routes/index.ts:291`, `intelCoverageRouter` `:293`, `intelApiRouter` `:294`,
`intelReadModelsRouter` `:295`, `intelOutcomesRouter` `:298`, `intelObservabilityRouter` `:300`.
`src/test/intelRouterRegistrationGuard.test.ts` exists to keep them mounted. The three internal
ones (`intelCoverage`, `intelObservability`, and the missions routes) are `requireAdmin`-gated
(`routes/intelCoverage.ts:61,72,101,113,123,137,158,176`;
`routes/intelObservability.ts:55`) — admin-gated is not unreachable, unlike the
internal-secret-gated-with-no-caller shape `checkWriterlessReads.ts:224-236` warns about.

---

## 3. Flag-gated write paths, and what `intel_rewards = TRUE` actually buys

Only one intel write path is **not** flag-gated: `setIntelConsent` → `intel_contribution_consent`
(`lib/intelConsent.ts:93-125`). It has an auth check and nothing else. Every other intel write in
the table above passes at least one `isFlagEnabled` call, all seeded `false`.

`intel_rewards = TRUE` means `runIntelRewardPass` is live and `recordEarnedReward` would not
refuse (`RewardService.ts:49`). The pass is therefore **not inert** — but it is structurally
starved, in a specific and checkable order (`lib/intelRewardScheduler.ts:132-165`):

1. read served snapshots: `intel_state_snapshots` where `privacy_eligible = true` and
   `expires_at > now()`. **If zero → return, no write** (`:143`).
2. else read `intel_observations` for those subjects. **If zero → return** (`:166`).
3. else read `intel_contribution_consent` and the prior `intel_reward_ledger` rows, grade, book.

Step 1's only producer is `intelProjection.projectAndStore` (`lib/intelProjection.ts:410`), gated
on `intel_claim_projection_crowd = false`. So the live reward job's first read is against a table
whose only writer is switched off. **The flag being on has no observable effect while projection
is off.** That is worth stating plainly because "intel_rewards is TRUE" reads, at a glance, like
the reward lane is producing.

An operational consequence follows: if `intel_claim_projection_crowd` is ever flipped on, the
reward job will begin booking non-cash credits on its next tick without any further switch, for
every consenting contributor behind a served snapshot with positive confidence
(`intelRewardScheduler.ts:229-236`). Idempotency is real (unique `(actor_id, idempotency_key)`,
`2180_intel_reward_ledger_idempotency.sql`; replay handling `RewardService.ts:77-82`), and
`cash_amount` is `0` by table constraint — so this is a bounded consequence, not a money risk.
But the ordering should be a deliberate choice, not a side effect.

---

## 4. `intel_observations.actor_id` — confirmed, and what it forecloses

Confirmed at `src/migrations/2130_intel_storage.sql:142`, verbatim:

```sql
CREATE TABLE IF NOT EXISTS public.intel_observations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id           uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
```

`NOT NULL`, FK to `public.profiles(id)`, `ON DELETE CASCADE`.

**What it implies for anonymous contribution: there is none, and there cannot be one without a
migration.**

- Every observation is permanently attributed to a real profile row. No pseudonymous actor, no
  null actor, no synthetic "anonymous" principal — a NULL is rejected by the column and an
  invented UUID is rejected by the FK.
- The route enforces the same thing independently: `routes/intel.ts:190` calls `requireUser`
  before anything else, and `writeObservation(sc, auth.user.id, …)` passes the authenticated id
  (`:238`). There is no service-role or internal-secret capture path that could supply a
  different actor.
- The D4 consent gate is *keyed on that same id* (`IntelCaptureService.ts:331` →
  `hasValidIntelConsent(sc, actorId)` → `intel_contribution_consent.user_id`). Anonymity and
  consent are therefore mutually exclusive by construction: you cannot check consent for an actor
  you do not identify. Removing attribution would require redesigning the lawful basis, not
  relaxing a column.
- `ON DELETE CASCADE` plus the explicit `erase_intel_for_actor` DELETEs
  (`2130_intel_storage.sql:420-428`, `2278_intel_scoped_trust.sql:209-217`) means erasure removes
  the contribution outright rather than anonymising it. There is no "keep the signal, drop the
  identity" path. A user who leaves takes their observations with them, so the corpus is not
  additive over departed users.
- `visibility` (default `'private'`, `2130:150`) controls *who sees* an observation, never
  *whether it is attributed*. It is not an anonymity control and should not be read as one.

This is a coherent, defensible privacy design — but it does bound the product: **the spine can
never accept a contribution from a signed-out user, and can never retain one from a deleted user.**
Any density or coverage target has to be met entirely by consenting, logged-in, still-present
profiles.

---

## 5. Not built / could not establish

**Not built** (asserted from the tree, with citation):

- `intel_live_promoted_scopes` has **no application writer at all** — nothing in server TS, client
  TS, or SQL. Deliberate; `checkWriterlessReads.ts:172-180`.
- `lib/media/mediaEvidenceLink.ts:119` `linkMediaEvidence` has **no production caller**; only
  `src/test/mediaEvidenceSeam.test.ts`. The module documents this itself at `:33-49`, including
  why it cannot simply be wired: the write needs an `intel_observations` row and a canonical
  `media_assets` row in the same hand and no path holds both. Its read half
  (`observationsHaveEligibleMediaEvidence`, `:228`) *is* wired
  (`lib/intelProjectionAggregator.ts:405`) and therefore returns `false` on every claim even with
  `media_evidence_enabled` on. See `docs/map/media-evidence-seam-state-20260903.md`.
- There is **no system auto-promotion of claims other than the RPC**: `approveClaim`
  (`routes/intel.ts:267`) is `requireAdmin` (`:268`); the only non-admin promotion is
  `system_promote_admissible_intel_claims`, gated on `intel_claim_projection_crowd`.
- `reportIntelFunnel.ts` / `reportIntelLineageAudit.ts` are manual npm scripts
  (`package.json:39,169`) with **no CI or scheduler invocation** — no workflow under
  `.github/workflows/` references them. The funnel instrument exists but nothing runs it on a
  cadence.

**Could not establish from code; requires a production read:**

1. **Whether any of the ten tables has ever held a row.** Requires exact `count(*)` per table.
   `reltuples` is explicitly not evidence.
2. **The live value of `intel_capture_quick_signal`** — one row from `feature_flags`. This is the
   pivot: it decides whether the top three tables are writable *today*.
   `docs/handoff/2026-08-30-audit-findings.md` H6 asserts it is on; the migration seeds it off;
   I could not adjudicate.
3. **The live values of the other twelve flags** in the table in §"The gate that explains
   everything". Only `intel_rewards = TRUE` was given to me.
4. **Whether `intel_contribution_consent` holds any rows.** It is the only ungated intel write
   path and it has real, navigable UI, so it is the table most likely to be non-empty — and it is
   the cheapest possible test of whether the lane has *ever* been touched by a user. A single
   non-zero count here would prove the spine's front door has been opened; a zero would prove no
   user has ever consented, which by itself makes every downstream table provably empty regardless
   of any flag.
5. **Whether rows were written and later swept.** `2133` and `2173` both DELETE intel rows on a
   cutoff. Both sweeps are flag-gated off, so a sweep is unlikely to have run — but "unlikely" is
   not "did not", and no code artifact records past sweep executions.
6. **Whether the August H6 duplicate-candidate defect actually produced `intel_claims` rows in
   production.** The routing bug is real and fixed; the claim that a live user was pressing the
   button is documentary only.

---

## Reading guide for the next person

If you have one production query, spend it on:

```
select flag, enabled from public.feature_flags where flag like 'intel_%' or flag = 'map_contributions_enabled';
select count(*) from public.intel_contribution_consent;
```

The first settles §3 and the H6 contradiction. The second settles whether the spine's front door
has ever been opened by a human. Together they convert most of §5 from "could not establish" into
fact, and they tell you whether "CORRECT 32.1%" is counting a lane that has run or a lane that is
merely armed.
