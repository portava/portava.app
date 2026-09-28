# Discovery decision register

Owner authorisation, 2026-09-28. These instructions come from the owner:

- The 2026-08-15 ranker implementation hold is lifted. The held designs may be built and tested behind flags seeded FALSE.
- Routine architecture and product decisions are to be made from the specifications, recorded here, and implemented.
- Four kinds of decision are NOT delegated:
  - real user consent;
  - financial obligations (rates, payouts, commercial terms);
  - data-retention policy;
  - production activation (production migrations, deploys, flags turned on in production).

  For each of those this register carries an exact recommended action and a specific approval request. Nothing is chosen silently.

Each lane appends its own `## <lane> — <topic>` section and never edits another lane's section. An entry has:

- **Decision id:** `D-<lane>-<n>`.
- **The question:** quoted from the census section or spec that raised it, with a citation.
- **Options considered:** each with its consequence.
- **Decision and rationale:** with spec citations.
- **Reversibility:** how to undo it, and whether anything is lost.
- **Where it is implemented:** file references, plus the tests that pin it.

An entry that needs owner approval is marked **APPROVAL REQUIRED**. It gives the recommended action with exact values, the consequence of approving, the consequence of declining, and the recovery path.

## W10-R4 — one ranking pipeline for GET /discovery (census-discovery §79)

*Lane W10-R4, branch `disc-w10-r4-pipeline`, 2026-09-28. Migrations 3455 and 3456, both seeded FALSE. The evidence is controlled: in-process routes over an in-memory database, plus a local PostgreSQL 16 harness. None of it is production evidence.*

### D-W10R4-1 — Q66-2: how `for_you` joins the PDE pipeline

- **The question.** §66.9 Q2 asks: *"Signed-in `for_you` pages are ordered by Compass's ranker and every other category by the PDE pipeline. Is `for_you` to be consolidated into the PDE pipeline under Phase F gate 2, which changes its order with no flag in front of it, or retired now?"* (`docs/architecture/census-discovery.md` §66.9). The same question is in §47.3 and in `docs/discovery/ranker-hold-designs.md` §6.
- **Options considered.**
  - (a) Retire the Compass branch now, with no flag. Every signed-in `for_you` order changes at deploy, and there is no rollback short of a revert. That is production activation, which is not delegated.
  - (b) Ride `DISCOVERY_ENGINE_MODE` (ranker-hold-designs §6): skip Compass in `pde` mode for in-cohort viewers. This couples the consolidation to the engine-mode cohort, which also governs shadow. The shadow comparison could then never measure `for_you` before the flip.
  - (c) A new capability flag, seeded FALSE, with Compass kept as a candidate gate. Chosen.
- **Decision and rationale.** (c), `discovery_for_you_pde_enabled` (3455):
  - When ON, a signed-in `for_you` page is ordered by `rankForViewer` and nothing else.
  - Compass keeps the part of its job that is not ordering. Its pipeline gates decide which candidates enter PDE: the fail-closed safety filter, eligibility, safe-return attention and Live exclusions (`compassEligibleForDiscovery`).
  - `rankItemsForDiscovery` is not called and Cache B is neither read nor written.
  - Grounds:
    - `10` §1: *"Avoid parallel systems"* (`docs/specs/discovery-v1/10_Database_Architecture.md:5#Avoid parallel systems`).
    - `12` §0: *"Do not implement PDE as a greenfield subsystem"* (`docs/specs/discovery-v1/12_Claude_Code_Implementation.md:5#Do not implement PDE as a greenfield subsy`).
    - `06` §10: *"Feature flag must keep old user-visible output unchanged"*.
    - ranker-hold-designs' common rule: *"Eligibility is not ranking."*
  - When OFF, serve points 4 and 5 are byte-identical to before (Z0, and L0).
  - A Compass failure degrades to every candidate, which is the same DV-07 degradation the Compass-order path already takes.
- **Reversibility.** Set the flag FALSE; it takes effect within 30 s (flag cache). Nothing is written by the flag, so nothing is lost. Rollback file: `db/rollback/2026-09-28-3455-discovery-for-you-pde-enabled-rollback.sql`.
- **Where it is implemented.**
  - `artifacts/api-server/src/lib/discoveryOnePipeline.ts`
  - `artifacts/api-server/src/compass/CompassFeedBuilder.ts:866#export async function compassEligibleForDiscovery(`
  - `artifacts/api-server/src/routes/discovery.ts:2106#const forYouM = await forYouCandidatesForServe(`
  - `artifacts/api-server/src/routes/discovery.ts:2276#if (callerUserId) { const places = forYouM.places;`
  - `artifacts/api-server/src/routes/discovery.ts:1838#const forYouA = await forYouCandidatesForServe(`
  - migration 3455
  - Tests: `artifacts/api-server/src/test/discoveryOnePipeline.test.ts` P1–P4 and Z0.

### D-W10R4-2 — E-2: Phase F gates 1 and 2 — **APPROVAL REQUIRED**

- **The question.** §69.1 E-2 is *"Phase F gates 1 and 2"*. `docs/discovery/ROADMAP.md` Phase F lists two gates, both *"not ruled"*:
  - *"Enabling `shadow` for any cohort"*;
  - *"The `pde`-serving flip for real users"*.
- **What was decided here (delegated).**
  - Gate 2 is expressed as the two capability flags this lane built:
    - 3455 (`for_you` on one pipeline, D-W10R4-1);
    - 3456 (Cache A ranked for every signed-in viewer, D-W10R4-4).
  - `DISCOVERY_ENGINE_MODE` keeps gate 1 (shadow) and the staged `pde` cohort.
  - The shadow now measures the consolidated pipeline before either flag is on (D-W10R4-6).
  - Sequence: gate 1, then a reading of the shadow rows, then gate 2.
- **What is NOT decided: production activation.** The recommended actions, with exact values:
  1. **Apply 3455 and 3456 to production.** Each inserts one row, FALSE, and the postcondition refuses TRUE.
  2. **Gate 1.**
     - `UPDATE public.feature_flags SET enabled = true, metadata = '{"mode":"shadow","cohort":{"kind":"users","userIds":["<internal account ids>"]}}' WHERE flag = 'DISCOVERY_ENGINE_MODE';`
     - After 7 days with no stop condition tripped, widen to `{"kind":"percent","percent":5}`.
     - Read `discovery_shadow_serves` for serve points 1, 4 and 5: `overlap_count`, `top_changed` and `pde_stages->'phase9'`.
  3. **Gate 2**, after 14 days of shadow rows and the owner's reading of them:
     - `UPDATE public.feature_flags SET enabled = true WHERE flag IN ('discovery_for_you_pde_enabled','discovery_cache_a_ranked_enabled');`
     - Then set `DISCOVERY_ENGINE_MODE` back to `{"mode":"legacy"}` or leave it in `shadow`. With both flags on, the shadow skips pages that PDE already served (`routes/discovery.ts:1960#shadowCohort`).
- **Consequence of approving.**
  - Signed-in `for_you` pages and every signed-in Cache A hit are ordered by the PDE pipeline.
  - `rank_events` gains a real impression row per served item on serve points 1, 2 and 3 (they wrote serve-log rows before).
  - C32, DC-24, DV-03, A05 and DC-14 then need only their production evidence. C32 and DC-24 also need D-W10R4-7.
- **Consequence of declining.**
  - Production keeps serving `for_you` in Compass's order.
  - Signed-in Cache A hits stay unranked.
  - Those rows stay `W`.
- **Recovery.** Set the flags FALSE, and the old behaviour returns within 30 s. Restore the previous `DISCOVERY_ENGINE_MODE` metadata. Impression rows already written are measurements, and removing them is a retention decision, not a rollback.

### D-W10R4-3 — D-7: who owns Sensing `:129` on the Compass serve points, and what a failed Live-claim read serves

- **The question.** §57.10 Q1: *"On GET /discovery's Compass serve points, which gate owns Sensing `:129`: Discovery's `discovery_live_rank_enabled`, via the demotion-only pass §57.9 wires, or Compass's `COMPASS_LIVE_CONSTRAINTS_ENABLED` environment switch?"* The brief adds what to serve when that read fails.
- **Options considered.**
  - (a) Compass's environment switch owns it. Then one surface would be governed by two unrelated switches, and a `unsafe_density` place could lead the page (§57.4 C1).
  - (b) Discovery's 2850 owns it on every GET /discovery serve path. Chosen.
  - For a failed read, three answers were considered:
    - fail open, keeping the claim. That is today's behaviour, and it contradicts Sensing §20;
    - hide the candidate. That turns a read failure into a second failure;
    - **fail closed: serve the candidate, withhold the claim, and say so.** Chosen.
- **Decision and rationale.**
  - (b): one flag and one grade for one surface. Compass's switch stays Compass's own exclusion inside its pipeline, and under 3455 it runs as part of the candidate gate.
  - The failure rule applies on all four serve paths, not only on the Compass path. With 3455 ON, For You moves to the PDE path, and a rule scoped to the Compass path would silently stop applying to For You.
  - A row fails when it has a canonical live subject (so a read was owed) and either the live layer did not run with the flag on, or its grade is `unreadable`. The row is still served in its place. Its `nearby_now` reason (*"Close to you and open around now."*) and its why-now are withheld, and the envelope carries `meta.liveSafety: { readable: false, claimsWithheld }`.
  - Grounds:
    - Sensing §20: *"Schema/permission/infrastructure failure ≠ no activity"* (`docs/specs/Portava_Sensing_World_Experience_Intelligence_Upgrade_Architecture_v1.txt:230#Schema/permission/infrastructure failure`).
    - Sensing §7: *"A dangerous place must never simultaneously be promoted as 'best move now'"* (`:129`).
    - `11` §9: a failure must not masquerade as success.
  - `DiscoveryPlace.isOpenNow` is an opening-hours fact the `openNow` filter reads, not a Live claim. The Discovery card does not render it, so it is untouched.
- **Limit found, and routed (not this lane's file).** `lib/liveClaimRead.readLiveClaims` resolves `[]` on a snapshot read error. So a claim read that errors reaches Discovery as "no claim" (`none`), not as `unreadable`, and nothing is withheld. This is pinned by `discoveryOnePipeline.test.ts` F2. The fix is for the read path's owner: return a failure the caller can see.
- **Reversibility.** With 2850 FALSE (its seeded state) nothing here runs. The rule has no flag of its own, because it only ever removes a claim.
- **Where it is implemented.**
  - `artifacts/api-server/src/lib/discoveryLiveRank.ts:519#export function liveClaimReadFailures(`
  - `artifacts/api-server/src/lib/discoveryLiveRank.ts:552#export function withLiveClaimsWithheld<`
  - `artifacts/api-server/src/lib/discoveryLiveRankRead.ts:237#gradedById: graded.byId`
  - the four serve paths in `routes/discovery.ts`
  - Tests: F1, F3, F4, F5, U1–U5, and the F2 limit.

### D-W10R4-4 — DV-03: how Cache A stops bypassing ranking

- **The question.** `01` §7: *"A user-independent candidate cache that serves raw candidates must never bypass personalization/ranking"* (`docs/specs/discovery-v1/01_Portava_Discovery_Engine.md:157#must never bypass personalization/ranking`). The brief: *"Make Cache A viewer-safe, or bypass it for personalized paths, behind a flag."*
- **Options considered.**
  - (a) Only `pde` mode plus the cohort, as today. The cold path already ranks every signed-in viewer in every mode, so the cache path disagreeing with it is a serve-path defect, not an experiment. The cohort is also shared with shadow.
  - (b) Skip Cache A for signed-in viewers. This moves Overpass load onto every signed-in request for no ranking gain.
  - (c) A flag that ranks every signed-in Cache A hit per request, which is `01` §7's *"allowed pattern"*: cache candidates, rank per user, log, serve. Chosen.
- **Decision.** (c), `discovery_cache_a_ranked_enabled` (3456):
  - When ON, serve points 1, 2 and 3 rank for the viewer in every engine mode.
  - Anonymous requests are unchanged.
  - A ranker failure still serves the cached order, as the `pde` branch always has. It is recorded as a `cache_bypass` obligation by `recordRankObligation`, and the page is marked `rankedBy: "none"`.
- **Reversibility.** Set the flag FALSE; it takes effect within 30 s.
- **Where it is implemented.**
  - `artifacts/api-server/src/routes/discovery.ts:1854#const cacheARanked = await cacheARankedEnabled(`
  - migration 3456
  - Tests: V1 and V2 (and Z0).

### D-W10R4-5 — A05 / Q71-2: For You under Compass ignores the intent mode

- **The question.** §71.6 Q71-2: *"When Compass answers, For You shows Compass's feed, which takes no mode."* The options given there:
  - carry the mode into the Compass feed request;
  - do not offer the selector on For You while Compass supersedes.
- **Decision.** Neither. Under 3455, For You's `GET /discovery` page is the one-pipeline page, and the live layer ranks it in the chosen mode like every other category (M1). The client tab stops superseding that page with the Compass feed (O1, O1b), and does not request the feed. Compass's own rails below the list are unchanged.
  - Carrying the mode into the Compass feed would keep a second ordering on the tab.
  - Hiding the selector would leave For You without intent.
  - With 3455 OFF the tab is exactly as before (O1c, O3).
- **Reversibility.** It follows 3455.
- **Where it is implemented.**
  - `travel-buddy-standalone/src/components/discovery/ForYouTab.tsx:228#if (forYouPde || !compass.data`
  - Test: `travel-buddy-standalone/src/components/discovery/__tests__/ForYouTab.onePipeline.component.test.tsx`

### D-W10R4-6 — DC-14: the shadow covers the consolidated pipeline

- **Decision.**
  - Shadow mode now observes Compass serve points 4 and 5 (`observeForYouShadow`). The legacy side is the Compass page served. The PDE side is the page the consolidated pipeline would serve: Compass's gates, then `rankForViewer`, then the same post-rank layers.
  - The Cache A shadow's `for_you` side is also the consolidated pipeline's.
  - `pde_stages.candidateSource` names the source.
  - Every call in the shadow gets a write-suppressed client, Compass's eligibility run included. S1 pins that the shadow adds exactly one write, its own row.
  - A shadow run is skipped when the served page is already PDE's, because there is no "old" page to compare.
- **Grounds.** `06` §10: *"compute old ranking, compute PDE ranking, compare overlap … Feature flag must keep old user-visible output unchanged."*
- **Reversibility.** The shadow runs only in `shadow` mode for a cohort, and production is `legacy`.
- **Where it is implemented.**
  - `artifacts/api-server/src/routes/discovery.ts:4464#async function observeForYouShadow(`
  - `artifacts/api-server/src/routes/discovery.ts:1971#const shadowCands =`
  - Tests: S1–S3.

### D-W10R4-7 — retiring the old `for_you` path — **APPROVAL REQUIRED**

- **The question.** C32's criterion is *"One ranking pipeline in the tree"*. While the flag-off branch exists, the tree still holds Compass's ordering of `for_you`.
- **Why it is not done here.** Deleting the branch now makes 3455's ON behaviour the only behaviour at deploy. That is production activation without a flag, and it removes the only rollback that does not need a revert.
- **Recommended action.** After 3455 has been TRUE in production for 14 days with no Discovery stop condition tripped, merge one commit that:
  - deletes the Compass-order branch of `routes/discovery.ts`: serve points 4 and 5, `_compassCandidateCache` for Discovery, and the value import of `rankItemsForDiscovery`;
  - deletes `forYouCandidatesForServe`'s flag read, so the consolidated path is unconditional;
  - restates `discoveryVerifyAudit2.test.ts` R1 and R2 and `discoveryOnePipeline.test.ts` P4 to the one-path behaviour;
  - adds a migration that deletes the `discovery_for_you_pde_enabled` row.
- **Consequence of approving.** The tree has one ordering pipeline for Discovery, so C32 and DC-24 can be graded `C` on runnable evidence. Rollback after that is a revert of the commit.
- **Consequence of declining.** Two orderings stay in the tree behind a flag, and C32 and DC-24 stay `W`.
- **Recovery.** `git revert` of the retirement commit restores the branch and the flag read. The flag row would need re-seeding by re-running 3455.
