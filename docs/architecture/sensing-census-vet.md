# Sensing — census vet and completion pass

*Measured 2026-09-07 against branch `claude/portava-continuation-uqta94`, working tree after commit
`df691868`, with read-only queries against both databases. Vets `docs/architecture/census-sensing.md`
(HEAD `0177f0be`), `sensing-s0-reuse-map.md`, `sensing-input-gap.md`, and the coordinator's claim that
"Sensing cannot reach 100 %". Then records what was built, which census rows it moves, and the honest
recomputed figure over the same 127-row denominator.*

Paths are relative to `artifacts/api-server/src/` unless prefixed.

---

## Part 1 — What was wrong on measurement

### 1.1 The census was stale at the moment it was committed

`census-sensing.md` says (PR #475 section) *"`src/lib/sensingAnonStore.ts` is absent from the
worktree"* and scores the PR as *"not in HEAD"*. Dating:

| Event | Commit | Time (UTC) |
|---|---|---|
| Spec enters the tree | `ebe72b34` | 2026-09-07 06:34:59 |
| Store, service, aggregate, migration 2315 enter the tree | `e7769a45` | 06:55:03 |
| Retention scheduler enters the tree | `90ce2835` | 06:55:44 |
| Census committed, still saying the store is absent | `31f921d1` | 06:57:22 |
| S0 reuse map committed | `5ec200c4` | 08:06:03 |
| Wall cites "Sensing §108" | `9e31577a` | 08:15:02 |

The census was written against `0177f0be` (06:36) and committed 2 minutes **after** the files it calls
absent had landed — and its own commit amended `sensingAnonStore.test.ts`, the tripwire of the store it
says does not exist. Consequences for its rows: **S18** is BC, not NB (rotating ids exist and are
tested); **S26**'s raw half is BC for the anonymous path (72 h structural ceiling *and* a registered
sweep, `index.ts:146`); **S112** is improved (identity-free revocation exists). The census's own
"with #475" table predicted exactly these moves; they had already happened.

### 1.2 The 0.0 % attribution is right for the store and wrong for the tree

- **The store is not spec-attributable, by dating.** PR #475's commit `0597a245` is authored
  `2026-09-06 21:32 −0400` = **01:32 UTC**, five hours before the spec (`06:34 UTC`). It implements the
  quoted owner ruling, cites no spec section, and its `§3.2` citations are to `sensing-input-gap.md`,
  not the spec. The brief's worry about false-positive citations applies: a grep for `§` in
  `lib/sensing*.ts` returns only those doc references.
- **But "no artifact in this tree cites this spec" is now false.** `services/wall/LiveForYouService.ts:117`,
  `lib/wallProjection.ts:136-164,214,307-314,502-508`, `test/wallTruthClass.test.ts:2-7` and
  `test/wallLiveForYouKinds.test.ts:329` cite "Sensing §108 / §5.1 / §2 / §9" — spec **line** 108 is
  the §5.1 sentence *"Every server-built state … should carry truth class, confidence, freshness and
  coverage"*. Committed 08:15 UTC, after the spec. Spec-attributable work exists; the census predates it.
- The Map sibling's uncommitted `lib/mapExperienceState.ts` and `lib/mapObjects.ts` changes cite
  "Sensing §7 / §5.3 / §5.1" and would move S43, S49, S53, S59, S64 when they land.

### 1.3 The denominator is reproducible; the brief's fear does not materialise here

127 is internally consistent: the per-section counts sum to 127 and the S-id ranges match every
section (§3 = S17–S27 = 11, §5 = S39–S54 = 16, §20 = S114–S119 = 6, …). One judgement call is
visible: §3's single bullet *"Sensitive-location suppression, rare-path suppression, cohort thresholds,
anti-differencing controls and minimum independence requirements"* is split into three rows
(S22–S24) while other multi-clause bullets are one row. That is a choice, not an error. No section was
miscounted the way the sibling censuses found.

### 1.4 The CANNOT-VERIFY row hides a code-answerable half

S17 *"TLS in transit and encrypted storage at rest"*:

- **Deployment half — genuinely unverifiable from the tree**, as the census says: TLS termination and
  Supabase at-rest encryption are platform facts.
- **Code half — answerable, and BUILT.** `app.ts:26` `app.use(helmet())` sets
  `Strict-Transport-Security` by default (helmet's HSTS is on unless disabled). And the World
  Intelligence store's own at-rest control is application-level: `contributor_token` and `group_token`
  are HMACs under a server pepper (`lib/sensingAnonStore.ts`), the device secret is never stored, and
  `lib/sensingAnonService.ts` refuses to write or revoke unless a dedicated ≥ 32-char
  `SENSING_CONTRIBUTOR_PEPPER` is configured. A leaked table cannot be correlated by an outsider.

So the row is half BC, half CV. It still cannot be closed to BC from code, so the coordinator's
statement that **this row alone caps Sensing below 100 %** is technically right — but it is the least
important reason. The rows that keep Sensing off 100 % are the owner-decision rows (§1.5) and the
canonical FK (S19/S118), not TLS.

### 1.5 The "11 owner decisions" — which are decisions

From `sensing-input-gap.md` §3.2:

| # | Item | Verdict |
|---|---|---|
| 1 | Any HTTP route | **Decision.** Transport = exposure; forces 2–3. |
| 2 | Auth posture for an anonymous caller | **Decision.** |
| 3 | Abuse budget and its key | **Half engineering.** Per-credential **replay/idempotency** is code (§4.3 names it) and is now built (2340). The per-device *rate* budget and what keys it remain a decision. |
| 4 | A `groupTag` producer | **Decision** (independence semantics; the gate's ≥ 5-group floor depends on it). |
| 5 | What `signal_bucket` means | **Decision** (2315 says so). |
| 6 | Client capture | **Decision.** |
| 7 | Purpose-registry entry | **Decision** on the lawful basis; the *verbs* are now distinct in code (`sensingContributionPolicy.ts`), which was S25's ask. |
| 8 | Whether a dedicated pepper must be provisioned first | **Not a decision any more — an operator task.** `e7769a45` made it mandatory in code: `sensingAnonService.sensingPepperPosture()` refuses without `SENSING_CONTRIBUTOR_PEPPER`. Mislabelled. |
| 9 | Publishing any aggregate | **Decision.** |
| 10 | Applying 2315 (and now 2340) to production | **Operator action by policy** (`ROADMAP.md:485-486`), i.e. a decision by rule. |
| 11 | Enabling any flag | **Nothing to decide yet.** No sensing flag exists (the tripwire asserts none was invented). Mislabelled as a pending decision. |

Eight genuine decisions; one already forced by code (8); one has no object (11); one is half
code-answerable and the code half is now done (3).

### 1.6 The S0 reuse map — three corrections

1. **The summary arithmetic is wrong.** §13's table marks **five** contracts TRULY MISSING
   (`IntelligenceContributionSession`, `VibeState`, `ExperienceState`, `WorldMoment`, **and**
   `ExperienceSession`), one EXISTS (`PrivacyReducedContribution`), five REUSE/EXTEND, one BLOCKED
   (`FlowState`). The summary says "Four … five … three". It is 5 / 6 / 1.
2. **`PresenceObservation → EXTEND intel_observations + coverageAssembly`** points at the wrong owner
   for the anonymous path — that table's `actor_id NOT NULL` is the thing the ruling was answering.
   The census's S39 evidence is also a **name collision**: `presence/domain/types.ts:88`
   `PresenceObservation` is one device's identifiable raw observation (`sessionId`,
   `subjectEphemeralId`, a point), the opposite of §19's *aggregate* zone activity + coverage. Both
   documents cite a type of a different meaning. The correct owner for the anonymous aggregate is the
   sensing aggregate itself, now `lib/sensingPresenceState.ts`.
3. **`CrowdState → REUSE crowdFlowProducer`** contradicts the census's own S40 ("there is no
   `CrowdState` object"); `crowdFlowProducer` is the *Flow* engine. And **"IntelligenceContributionSession
   … blocks S1/S2"** overstates it: S1 asks to *define* the contract "using existing policy
   primitives", which is doable without an issuer (done, §2.3 below); what is blocked is issuing a
   session and transporting a contribution.

### 1.7 Production facts the documents got wrong (read-only, aggregate)

| Claim | Measured 2026-09-07 |
|---|---|
| census S26 / reuse map §12: flag `intel_retention` **absent** from production | No such flag name. The sweep reads `intel_retention_sweep_enabled` (`intelRetentionScheduler.ts:74`) = **TRUE** in production; the raw purge reads `intel_contribution_retention_enabled` (`:119`) = **FALSE, present** (not absent). |
| reuse map §12: `intel_coverage` absent | **Present**, `false`. |
| census / inventory / brief: "three intel flags TRUE in production" | **Eight**: `intel_capture_quick_signal`, `intel_claim_projection_crowd`, `intel_limited_live`, `intel_live_label_crowd`, `intel_missions`, `intel_retention_sweep_enabled`, `intel_rewards`, `intel_trail_followup`. |
| reuse map §12: `map_world_intelligence_enabled` "seeded false" | Seeded false in **CI**; the row **does not exist** in production (reads false either way). |
| — | `intel_limited_live` and `intel_live_label_crowd` are ON while `intel_live_promoted_scopes` has **0 rows** and no writer: `liveClaimRead.ts:317` returns `[]` for every subject in production. This is the WallMoment blocker, confirmed from the database. |
| — | Production has **no `schema_migration_ledger` table** at all; the ledger the certifier stages on is CI-only. |
| brief: "all 7 measurable intel tables hold 0 rows" | Confirmed for the six I could count (`intel_observations`, `intel_claims`, `intel_state_snapshots`, `intel_coverage_snapshots`, `intel_live_promoted_scopes`, `intel_contribution_consent`): all **0**. `sensing_anon_contributions` and `protected_zones` are absent from production. |
| 2315's "UPDATE is not granted to anyone" | True in CI (`has_table_privilege('service_role', …, 'UPDATE')` = false) but by luck of default privileges, not by REVOKE — the decorative-grant hazard the brief names. 2340 makes it a checked postcondition. |

### 1.8 Two live defects in the store the census scored BW for the wrong reason

Census S33 says replay/idempotency "both exist, both keyed on the account". For the **anonymous** store
in the tree, neither existed: `recordSensingContribution` inserted every call, so a replayed
`{commitment, epoch, zone, bucket}` wrote a row per attempt. Census S35 says timestamps are handled by
`clampObservedAt`; the anonymous store only checked that the claimed epoch matched the instant — and a
device chooses both — so an observation dated twenty hours ahead or a week back was stored into a cohort
it had no business in. Both are fixed below (2340 + store), and both are hand-revert-proven.

---

## Part 2 — What was built, and what it moves

Everything below is **inert**: no route, no flag, no scheduler, no consumer. Each module is pure (no
clock, no I/O) and is called by nothing on a live path; the tripwire in `test/sensingAnonStore.test.ts`
lists every file that may reference the store and asserts no route does.

### 2.1 Migration `2340_sensing_anon_replay_and_time_bounds.sql` — applied to **portava-ci only**

Rollback: `db/rollback/2026-09-07-2340-sensing-anon-replay-and-time-bounds-rollback.sql`.

| Change | Rows |
|---|---|
| `UNIQUE INDEX (cohort_key, contributor_token)` — one contribution per contributor per cohort; a replay is a 23505 and the store returns `{ok:true, duplicate:true}` | **S33** (replay per credential), **S13** (one device ≠ crowd is now a row property) |
| `CHECK (time_bucket <= created_at + 60 s AND time_bucket >= created_at − 72 h)` mirrored in `buildSensingContributionRow` as `observed_at_in_future` / `observed_at_too_old` | **S35** (impossible timestamps) |
| `REVOKE ALL … FROM service_role` before the narrow grant; postcondition asserts no UPDATE, no user-role SELECT | closes the decorative-grant hazard 2315 left |

CI after apply: index unique ✓, CHECK present ✓, `service_role` SELECT/INSERT/DELETE ✓ UPDATE ✗,
`authenticated`/`anon` SELECT ✗, 0 FKs, 0 rows.

### 2.2 `lib/truthClass.ts` — the shared §5.1 vocabulary (S48)

Seven classes verbatim; **CORROBORATED representable** (the census found it nowhere); `weakestTruthClass`
(fail-weak combinator); coverage buckets with no `none`. Pinned at compile time to the Wall's
`WallTruthClass`/`WallCoverage` (type-only import) and at runtime in `test/truthClass.test.ts` to the
Map's `TRUTH_CLASSES`/`COVERAGE_STATES` when present. One recorded divergence: the Wall's
`NON_OBSERVATION_TRUTH_CLASSES` omits `conflicting` (it would render a materially conflicting fact as an
observation); ours refuses it. **Coordination:** three copies now exist (Wall, Map-in-flight, this);
both siblings should re-export from here — a one-line change each in files I may not edit.

### 2.3 `lib/sensingContributionPolicy.ts` — the S1 privacy contract (S30, S25, S35)

§4.2's `IntelligenceContributionSession` as a typed POLICY with every listed property bound to the
primitive that owns it (purpose scopes = §3's seven verbs; credential = the store's rotating commitment;
precision = the presence ladder; sampling = 2340's replay key; retention = 2315's ceiling; revocation =
epoch-secret reveal; capability = `reduction_version`). The four ungranted verbs (`infer`, `personalize`,
`surface`, `share`) are **refused by default**. `admitSensingContribution` is the pure admission an
ingest would call: unknown/ungranted scope, coordinate pair in the zone label, TTL past policy,
unsupported reduction version, future/stale credential epoch, then the store's own refusals.
`IssuedContributionSession` is a **type only** and `captureMode: "not_decided"` /
`maxCohortsPerEpoch: null` record the owner decisions as undecided rather than defaulting them.
One relationship pinned for the owner: a contribution is stored at `zone` precision while the ladder's
`crowd_intelligence` ceiling for rendering an individual is `presence_only`; acceptable only because
nothing but k-gated aggregates leave the store.

### 2.4 `lib/sensingPresenceState.ts` + aggregate median — §19 PresenceObservation (S39, S38, S12, S49-shape)

`SensingCohortAggregate` gains `medianSignalBucket` — a per-**contributor** statistic (latest row per
token), **null unless the gate cleared the cohort**. `buildSensingPresenceState` turns an aggregate into
a state carrying truth class / confidence / freshness / coverage: `presence` is `observed | unknown`
with **no `absent`/`quiet` value in the type**; sub-k, failed-read and dominated cohorts are the same
unknown state at the surface (reason only in provenance); coverage bucket via `liveClaimRead.
sourceCountBucket`; truth class `observed`/`corroborated`/`stale`, never `inferred`; the ordinal is
unlabelled (vocabulary is the owner's). Named to avoid the identifiable `presence/domain/types.ts`
`PresenceObservation`.

### 2.5 `lib/experienceTruth.ts` — the composition rule (S116-form; supports S49/S53)

The §5.1 metadata block and `composeTruth`: weakest truth class, weakest band, oldest freshness, least
coverage, provenance unioned. **Deliberately not an ExperienceState**: the Map sibling's in-flight
`lib/mapExperienceState.ts` already carries §5.3's tree for Map, and a second shape would be the parallel
contract §1 forbids. Noted for the Map owner: its `foldCoverage` takes the *widest* bucket of any
consensus-eligible claim (a per-subject question); `composeTruth` takes the *narrowest* (a per-composite
question). Both are recorded so neither is mistaken for the other.

### 2.6 `lib/vibeInference.ts` — §5.2 Vibe engine, guarded (S9, S42, S51, S52)

`inferVibe(features, nowMs)` → `SensingVibeState` (named to avoid `intelContracts.VibeState`, the
five-value human tap). Mutation-proven invariants: rapid movement ≠ dancing (high energy with arrhythmic
or unbounded motion caps `danceLikelihood` ≤ 0.1; unknown periodicity ⇒ `null`); no coverage ≠ quiet
(all null, truth `unknown`); truth class always `inferred` and the band structurally below
`MIN_BAND_FOR_LIVE_STATE`; acoustic features **refused** without the separate permission; nothing
exceeds 0.9. **Its inputs exist nowhere** (S28 NB — client capture is an owner decision); this is S4's
contract and its tests, so a future feature pipeline meets a guarded engine.

### 2.7 Rows moved — census-consistent scoring (an artifact that is correct and would run)

| id | Was | Now | By |
|---|---|---|---|
| S18 | NB | **BC** | tree (`e7769a45`, pre-spec store) |
| S120 | NB | **BC** | tree (`5ec200c4`, S0 reuse map) |
| S48 | BW | **BC** | `lib/truthClass.ts` + Wall's `WallTruthClass` |
| S33 | BW | **BC** | 2340 + store (anonymous path; intel path stays account-keyed by design) |
| S35 | BW | **BC** | store time bounds + policy scope/credential refusals |
| S30 | NB | **BC** (contract; issuer owner-blocked) | `sensingContributionPolicy.ts` |
| S25 | BW | **BC** (World-Intelligence path; intel human-claim consent stays one boolean) | `sensingContributionPolicy.ts` |
| S38 | BW | **BC** | `sensingPresenceState.ts` (coverage ≠ activity), Wall states |
| S39 | BW | **BC** | `sensingPresenceState.ts` |
| S9 | NB | **BC** | `vibeInference.ts` |
| S42 | BW | **BC** | `vibeInference.ts` |
| S51 | NB | **BC** (inputs unproduced) | `vibeInference.ts` |
| S52 | NB | **BC** | `vibeInference.ts` |
| S26, S112, S125, S49 | BW | BW, improved | anonymous halves closed; canonical FK / Map coverage remain |
| S17 | CV | CV (code half BC) | `app.ts:26`, peppered tokens |
| S43, S53, S59, S64 | NB/BW | would become BC | **Map sibling, uncommitted** — not counted below |

**Recomputed over 127:** BUILT-AND-CORRECT **78** (was 65) → **CORRECT 61.4 %**; CONSTRUCTED
**110** (was 104) → **86.6 %**. If the Map sibling's in-flight fold lands: 80 / 112 → 63.0 % / 88.2 %.
Spec-attributable CORRECT (artifacts built for this spec, after `ebe72b34`): **12 / 127 = 9.4 %**
(S48, S33, S35, S30, S25, S38, S39, S9, S42, S51, S52, S120), up from 0.0 %.
**Realised in production: still 0.0 %** — see Part 3.

Sub-score "sensing input + inference core" (31 rows): 16 / 31 = **51.6 %** correct (was 22.6 %).

**Strict reading.** A reader who refuses to count a callerless contract as BC should subtract S30, S25,
S51 and S52 (the inputs or issuer do not exist): 74 / 127 = 58.3 %. The census's own rule counted
"code that is correct and would run", so 61.4 % is the like-for-like figure.

### 2.8 Why not 100 % — the specific blocker per open row

| Rows | Blocker |
|---|---|
| S19, S118, S125(part) | `intel_observations.actor_id NOT NULL REFERENCES profiles(id)` (2130:142) — the canonical table; changing it is a reviewed schema decision, not a sensing PR. |
| S20, S32, S28, S29, S21 | route / auth posture / client capture — owner decisions 1, 2, 6. |
| S17 | deployment half. |
| S24 | anti-differencing needs a consumer to budget queries against; none exists. |
| S40, S41(liveness), S44, S45, S46, S54, S55, S56, S60, S65, S66, S68, S70, S72, S73, S74, S76, S78–S80, S83, S85–S88, S92, S102, S103, S106, S110, S111, S113 | surface-owned (Map, Wall, Discovery, Compass, Trips, Telegraph) or downstream of live claims, which `intel_live_promoted_scopes` (no writer, 0 rows) keeps at `[]` in production. |
| S22, S89–S91, S105 | vacuous BC — unchanged. |

---

## Part 3 — Deployment reality: what stays dark regardless of code

- **No sensing table in production.** 2315 and 2340 are CI-only; applying them is an operator action.
- **No route.** Nothing can write, revoke or read a sensing contribution over HTTP; the tripwire forbids it.
- **`SENSING_CONTRIBUTOR_PEPPER`** is OPTIONAL at boot (`envValidation.ts:44`); whether it is set in
  production is not readable from the tree. Without it every write and revocation refuses
  `pepper_unconfigured` even if a route existed.
- **Every intel table is at 0 rows** with eight intel flags ON; `intel_live_promoted_scopes` is empty
  and writerless, so `readLiveClaims` is `[]` for every subject in production. Any Map/Wall consumer
  of live claims — including the Map sibling's ExperienceState fold — serves nothing there.
- The sensing retention scheduler is registered and is an inert heartbeat in production (`store_absent`).

---

## Part 4 — Coordination items (not edited; other owners)

1. **Truth vocabulary consolidation:** `lib/wallProjection.ts` and `lib/mapObjects.ts` should
   re-export `TruthClass`/coverage from `lib/truthClass.ts` (pins exist in both directions today).
2. **Wall:** `NON_OBSERVATION_TRUTH_CLASSES` omits `conflicting`; `deriveWallTruthClass` says a
   material conflict is "never a Live label" but `truthClassMayRenderAsObservation("conflicting")` is
   true there. `test/truthClass.test.ts` pins the divergence as exactly that value.
3. **Map:** `mapExperienceState.ts`'s `vibe.energy` is a human tap (`VIBE_STATES`); `SensingVibeState`
   and `SensingPresenceState` are the engine outputs its `sociality`/`dance_likelihood` leaves and its
   crowd leaves would consume once an owner wires the sensing aggregate through the injected read seam.
   Its widest-of `foldCoverage` vs `composeTruth`'s narrowest-of is recorded in §2.5.
4. **`presence/domain/types.ts`:** the `PresenceObservation` name collides with §19's aggregate; the
   presence owner may want to rename or document.

---

## Part 5 — Proof

Every behaviour claimed above was hand-reverted (pristine copy in the scratchpad, `timeout 300`,
restore verified with `diff -q`):

| # | Behaviour reverted | Reverted | Restored |
|---|---|---|---|
| R1 | 23505 ⇒ `duplicate:true` | fail 2, exit 1 | fail 0, exit 0 |
| R2 | `observed_at_in_future` / `observed_at_too_old` | fail 4, exit 1 | fail 0, exit 0 |
| R3 | median withheld unless publishable | fail 1, exit 1 | fail 0, exit 0 |
| R3b | latest row per contributor wins (first test was insensitive; rewritten, then proven) | fail 1, exit 1 | fail 0, exit 0 |
| R4 | sub-k cohort ⇒ `unknown`, not `observed` | fail 2, exit 1 | fail 0, exit 0 |
| R5 | `weakestTruthClass` weakest-not-strongest | fail 5, exit 1 | fail 0, exit 0 |
| R6 | rapid movement ≠ dancing | fail 2, exit 1 | fail 0, exit 0 |
| R7 | acoustic without permission refused | fail 1, exit 1 | fail 0, exit 0 |
| R8 | ungranted scope refused | fail 1, exit 1 | fail 0, exit 0 |
| R9 | 2340 `REVOKE … FROM service_role` before GRANT | fail 1, exit 1 | fail 0, exit 0 |

Ten sensing-related test files: **220 tests, 0 fail, exit 0**. `pnpm typecheck` exit 0.
`pnpm typecheck:tests`: 901 diagnostics / 122 files against the 880 / 118 baseline — the 21 new
diagnostics are all in four sibling-owned in-flight files (`highlightsBlockFailClosed` 3,
`highlightsFeedFiniteness` 4, `mapSensingProjectionGates` 2, `memoryLocationPrecision` 12); the six new
sensing test files contribute 0. Full-suite result is recorded in the session report.
