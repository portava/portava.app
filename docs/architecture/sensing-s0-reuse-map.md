# Sensing S0 — audit and reuse map

*Discharges requirement **S120** of `docs/architecture/census-sensing.md`, which is step **S0** of
the Sensing spec's own implementation sequence:*

> **S0 — Audit / mapping:** Inventory current consent, route-flow contribution, device/session, map
> projection, intel observations/claims/snapshots, wall, discovery, Compass, schedulers, RLS,
> outbox and feature flags. **Produce reuse map; no mutation.**
> — `docs/specs/Portava_Sensing_World_Experience_Intelligence_Upgrade_Architecture_v1.txt:241`

**No mutation was performed to produce this document.** No migration, no flag, no application code,
no database write. Every production fact below was obtained by a read-only query and is dated
2026-09-07.

**Why this matters more than one census row.** The spec mandates S0 → S1 → … → S11 in order
(`:240-252`), and S0 is the only step with no prerequisite. Its absence meant every later step was
being reasoned about without an agreed map of what already exists — which is precisely the failure
the spec's §1 warns against: *"Inspect the real repository, migrations, schema, enums, feature
flags, schedulers, RLS, services, projections and tests before changing anything"* (`:14`).

Paths are relative to `artifacts/api-server/src/` unless stated.

---

## 0. The headline an implementer needs before reading further

**The intel spine is large, wired, switched ON in production, and has never been used.**

- 33 `lib/intel*` modules; 32 imported by non-test code.
- 9 schedulers, **all nine registered** in the `app.listen` callback (`index.ts:124-167`) as plain
  unconditional `setTimeout` calls — none has the `NODE_ENV` or env-var guard that the stamp worker
  (`:184`) and FX refresh (`:199`) carry beside them.
- 26 HTTP endpoints across 6 mounted routers.
- **Every measurable intel table holds zero rows in production**, with the capture, projection and
  reward gates all **TRUE**. See `intel-spine-liveness.md`.

So the reuse question is not "does the machinery exist" — it does. It is "does the machinery have
evidence flowing through it", and the answer today is no.

---

## 1. Consent

| Owner | State |
|---|---|
| `lib/intelConsent.ts` | The canonical consent surface. `PUT /v1/intel/consent` → `:117`. **Ungated** — no feature flag, auth only — and backed by a real settings screen. |
| `intel_contribution_consent` | Exists in production. **0 rows.** This is the cheapest possible test of whether the front door has ever been opened, and it says no. |
| `route_flow_contribution_consent` | **Absent from production entirely**, and on the `check:writerless-reads` ratchet — no writer in TS, client or SQL. |

**Reuse verdict.** `intelConsent` is the correct owner for S1's purpose scopes. It is **per-account**
(`intelConsent.ts:42`), so it structurally **cannot express anonymous consent** — the one thing the
anonymous store needs. That is a genuine gap, not an extension.

## 2. Route-flow contribution

`route_flow_contribution_consent` is declared by a migration, absent from production, and has no
writer. The flow engine cannot publish: `census-sensing.md` S41 records that only 2 of the required
signal families are wired. **Truly missing**, not reusable.

## 3. Device / session

**The thinnest area in the whole inventory.** The only session-shaped module is
`lib/locateFriendsSession.ts`, which belongs to Locate-My-Friends and whose four tables
(`locate_friends_sessions|members|positions|audit`) are **all absent from production**.

There is **no device identity primitive at all**, and `docs/architecture/sensing-input-gap.md`
records that the client has **no SHA-256/HMAC primitive** — `expo-openmls` exposes thread encryption
and device signing keys only. So `IntelligenceContributionSession` (§19) has **no existing owner to
extend**. This is the load-bearing gap for S1 and S2.

## 4. Map projection

Rich and reusable: `lib/mapAggregation.ts`, `lib/mapCommands.ts`, `lib/mapObjects.ts`,
`lib/mapProducers/`, plus `lib/intelProjection.ts`, `intelProjectionAggregator.ts`,
`intelApiProjection.ts`. The producer→projection→API shape S5 needs already exists and is the right
thing to extend rather than replace — which is what §1's "UPGRADE, DO NOT REBUILD" requires.

**Blocking fact:** `map_telemetry_events` and `map_telemetry_drops` are **absent from production**
(`src/scripts/checkProductionDrift.ts` ratchets both as `unapplied`). Any S5 observability resting
on them lands nowhere in production today.

## 5. Intel observations / claims / snapshots

The canonical lifecycle, and the spec's §1 forbids a second one.

| | |
|---|---|
| Declared in the chain | **15** `intel_*` tables |
| Present in production | **10** |
| CI-only (migrations 2273–2279) | `intel_attributions`, `intel_historical_patterns`, `intel_presence_verifications`, `intel_scoped_trust`, `intel_state_snapshot_versions` |
| Rows in production | **0**, in every measured table |

**The prohibition that shapes S1.** `intel_observations.actor_id` is
`uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE`
(`migrations/2130_intel_storage.sql:142`) — a permanent account FK, which is exactly what the
spec's §3 forbids for World-Intelligence contributions. The only contribution table with a writer
cannot carry anonymous input. This is why the owner ruling made room for a separate anonymous store
rather than an extension.

`intel_presence_verifications` is additionally **write-only**: written at
`services/intel/IntelCaptureService.ts:303`, read by nothing. `checkWriterlessReads` cannot see this
shape — it walks the reads map only.

## 6. Wall

`routes/wall.ts`, `services/wall*`, `lib/wall*`, and `wall_session_intents` (which does have
writers and is *not* on the writerless ratchet).

**Sensing §9 obligations, none of which the Wall census counted:** a server-built `WallMoment`
projection carrying subject, transition, `occurred_at`, relevance window, reason, truth class,
freshness and expiry. **`WallMoment` has zero occurrences in the tree.** Also absent from
production: `wall_telemetry_events`, so 13 of the 15 §32 Wall telemetry events land nowhere.

## 7. Discovery

The largest existing surface: ten instrumented serve points, `portavaRank`, `FeedSlotAllocator`,
the two-level cache. See `01_Portava_Discovery_Engine.md` and `06_Recommendation_Engine.md`.

**Gated, and not by this spec.** The ranker is on explicit owner **HOLD**
(`docs/discovery/ROADMAP.md:222`, `:648`); `DISCOVERY_ENGINE_MODE` ships `legacy` and Phase F is
**FROZEN + NOT AGENT WORK** (`:534`). S6's `DiscoveryCandidate` may not be built into the ranker
without moving a hold that is not this spec's to move.

## 8. Compass

`services/compass/`, the `CompassGraphEngine`, `compass_*` tables. `05_Graph_Engine.md` records the
graph ships and is rebuilt on a schedule.

**The dual-score invariant constrains S7.** Compass Match must carry **zero popularity inputs** and
Community Score zero viewer inputs (`.agents/memory/compass-dual-score-ranking.md`). Any
`UserNowProjection` feeding Compass must respect that split, or S7 silently violates a rule no
Sensing document mentions.

## 9. Schedulers

Nine, **all registered**, none guarded by an env var:

`intelligenceGraph` `:124` · `intelRetention` `:135` · `intelPromotion` `:136` ·
`intelProjection` `:137` · `intelCoverage` `:145` · `intelPattern` `:150` ·
`intelCalibration` `:154` · `intelReward` `:158` · `registerScopedTrustApplier` `:166` ·
`intelAttribution` `:167`

**Four run in production against tables that do not exist there** —
`intelAttributionScheduler`, `intelPatternScheduler`, `intelScopedTrustApply`, `intelReplay`. They
return early only because their flags are unseeded and an unseeded flag reads `false`
(`.agents/memory/unseeded-feature-flag-gates.md`). **Seeding any one of those three flags points a
running scheduler at a missing table.**

The house shape for S2's TTL sweep is `lib/intelRetentionScheduler.ts`, and
`lib/sensingRetentionScheduler.ts` now follows it.

## 10. RLS

The canonical deny-by-default pattern is migration `2217_protected_locations.sql:156-161`:
`REVOKE ALL` from PUBLIC/anon/authenticated **and `service_role`**, then grant back exactly what is
needed — because Supabase's `public` schema carries `ALTER DEFAULT PRIVILEGES` granting ALL at
`CREATE TABLE` time. `2092`→`2093` is the worked failure.

**`protected_zones` is absent from production**, so the pattern every new migration is told to copy
has no production instance to compare against. Migration `2315` already applies the posture
correctly for the anonymous store (RLS on, service_role only, no anon/authenticated policy).

**Authorization helpers live in the `authz` schema, not `public`** — `authz.is_blocked`,
`authz.in_accepted_circle`, `authz.can_see_location`. Verified applied in **both** production and
CI. A `public.is_blocked(...)` reference fails at apply time with `42883`; that bug is live in open
PR #461 right now.

## 11. Outbox

`lib/intelDomainEvents.ts` is the intel lane's event surface. There is **no general application
outbox** — `grep` for `outbox` outside it reaches only `lib/tripReminderScheduler.ts` and
`routes/admin.ts`. The spec's §1 assumption that "outbox/event patterns" exist to reuse holds for
the intel lane and **not** platform-wide. An implementer expecting a shared outbox will not find
one.

## 12. Feature flags

16 flag rows are seeded by migrations, **every one seeded `false`**; 3 are declared and never
seeded (and therefore read `false` — `unseeded-feature-flag-gates.md`).

**But the seed is not the live value, and here they disagree:**

| Flag | Migration seeds | Production |
|---|---|---|
| `intel_capture_quick_signal` | `2165:39-41` false | **TRUE** |
| `intel_claim_projection_crowd` | false | **TRUE** |
| `intel_rewards` | `2170:61-63` false | **TRUE** |
| `intel_attribution`, `intel_pattern_learning`, `intel_scoped_trust`, `intel_coverage_missions`, `intel_promotion`, `intel_retention`, `intel_calibration` | — | **absent → read false** |

`.agents/memory/migration-applied-vs-committed.md` is the rule this proves: a migration file is not
evidence of live state **in either direction**.

---

## 13. The §19 logical contracts, mapped onto existing owners

§19 is explicit: *"These names describe responsibilities. Claude must first inspect existing
tables/types/services and map them onto canonical owners before deciding whether a new table/type is
needed."* That mapping is the point of S0, and here it is.

| §19 contract | Existing owner | Verdict |
|---|---|---|
| `IntelligenceContributionSession` | none — only `locateFriendsSession` (absent from production, wrong domain) | **TRULY MISSING.** No device identity primitive, no client crypto. Blocks S1/S2. |
| `PrivacyReducedContribution` | `lib/sensingAnonStore.ts` (PR #475, migration 2315) | **EXISTS, CI-ONLY, INERT.** Correct shape; needs a route and a decision, both owner-gated. |
| `PresenceObservation` | `intel_observations` + `lib/coverageAssembly.ts` + `intelCoverageScheduler` | **EXTEND** — but `actor_id NOT NULL` blocks the anonymous path. |
| `CrowdState` | `lib/crowdFlowProducer.ts`, `intelProjectionAggregator` | **REUSE.** Counting rules already established. |
| `FlowState` | flow engine present; `route_flow_contribution_consent` has no writer and is absent from production | **BLOCKED** on consent + signal families. |
| `VibeState` | none | **TRULY MISSING.** S4. |
| `ExperienceState` | none | **TRULY MISSING.** S4. |
| `WorldMoment` | none; `WallMoment` also zero occurrences | **TRULY MISSING.** S5/S6. |
| `ForecastState` | `intelCalibrationScheduler` exists as calibration machinery | **EXTEND** once there is anything to forecast from. |
| `OpportunityProjection` | `FeedSlotAllocator`, `portavaRank` | **REUSE — BUT RANKER-GATED.** Owner HOLD. |
| `ExperienceSession` | none | **TRULY MISSING.** S9. |
| `ExperienceOutcome` | `lib/intelOutcomes.ts`, `intelAttributionScheduler` | **EXTEND** — but `intel_attributions` is absent from production. |

**Four of twelve are truly missing. Five are reusable or extendable. Three are blocked by something
other than this spec** — the ranker HOLD, the consent gap, and a production table that does not
exist.

> **CORRECTION 2026-09-12 (census-sensing §1).** The sentence above does not summarise the table
> above it. Counting the table's own verdicts: **five** contracts are TRULY MISSING
> (`IntelligenceContributionSession`, `VibeState`, `ExperienceState`, `WorldMoment` and
> `ExperienceSession` — the summary omitted the last), **six** are REUSE / EXTEND / EXISTS
> (`PrivacyReducedContribution`, `PresenceObservation`, `CrowdState`, `ForecastState`,
> `OpportunityProjection`, `ExperienceOutcome`), and **one** is BLOCKED (`FlowState`). 5 / 6 / 1, not
> 4 / 5 / 3. Two rows are also wrong on their object and are left standing so the correction is
> visible beside them: `PresenceObservation → EXTEND intel_observations` names the very table whose
> `actor_id NOT NULL` FK is the anonymous path's blocker — the aggregate's owner is
> `lib/sensingPresenceState.ts` (which did not exist when this map was written); and
> `CrowdState → REUSE crowdFlowProducer` names the Flow engine, not a crowd state (census S40
> records that no `CrowdState` object exists). The table's own S-step references (S1/S2, S4,
> S5/S6, S9) are the spec's §21 steps, not census rows. The inventory in §1–§12 is unaffected.

---

## 14. What S0 concludes

1. **Nothing needs rebuilding.** The spec's "UPGRADE, DO NOT REBUILD" directive is satisfiable —
   every layer from ingest to projection to consumer has an existing owner, except the four
   contracts named above.
2. **The gap is the input layer, exactly as commit `0597a245` judged.** `actor_id NOT NULL` is the
   single structural blocker, and the anonymous store already built for it is inert and CI-only.
3. **The second gap is device identity**, and it is larger than the first: no session primitive, no
   client crypto, no abuse key that is not an identity.
4. **A large amount of correct machinery has never run.** Zero rows everywhere, with the gates open.
   Any percentage counting that machinery as satisfying a requirement is counting code that would
   run, not evidence that anything has.
5. **Production and CI disagree about the schema**, and CI cannot see it —
   `check:production-drift` exists now for that reason.

**What S0 does NOT authorise.** Producing this map does not start S1. Eleven downstream steps need
owner decisions this document deliberately does not make: any route at all, the anonymous auth
posture, the abuse budget and its key, a `groupTag` producer, what `signal_bucket` means, client
capture, a purpose-registry entry, publishing any aggregate, applying `2315` to production, and
enabling any flag. They are enumerated with reasoning in `sensing-input-gap.md` §3.2.
