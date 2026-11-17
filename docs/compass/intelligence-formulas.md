# Portava intelligence formulas

These formulas give Compass, Sensing, community information and personal media a common objective: help a traveler make a useful real-world choice with the evidence and permissions actually available. They preserve each system's existing responsibility and make the reasons for a decision inspectable.

The executable model in [intelligence-formulas.mjs](../../scripts/src/intelligence-formulas.mjs) is an offline reference for evaluation. It is not imported by application code, changes no production ranking weights, and activates no collection, notification or sharing capability. Coefficients must be calibrated against outcomes; none is presented as an empirically optimal value.

## Core principles

1. **User agency.** Respect current intent, explicit corrections, exclusions and confirmation requirements. A recommendation is not permission to execute it.
2. **Truth before persuasion.** Keep observation, community report, historical evidence, prediction, inference and generated content distinguishable. Attach evidence to the specific claim it supports.
3. **Context before popularity.** A relevant, feasible option should beat an impressive option that does not fit this trip, available time, budget, access needs or energy.
4. **Privacy by purpose.** Permission to collect is not permission to infer, personalize, publish or share. Anonymous world evidence cannot become an individual's location history.
5. **Useful restraint.** Staying, waiting, asking one necessary question and making no interruption are valid choices. Preserve plans that already work.
6. **Independent evidence.** Copies, coordinated reports, repeated impressions and repeated telemetry are not independent confirmations.
7. **Learning from actual outcomes.** A view is a view; a save is a save. Neither proves a visit, satisfaction, safety, or a permanent preference.
8. **Understandable decisions.** Retain the factors, constraints, uncertainty and policy version that produced each choice. Explain the important reasons without exposing private inputs.

These principles follow the [Compass roadmap](master-roadmap.md), [Compass architecture upgrade](../specs/upgrades-v2/01-COMPASS-v2.md), [Sensing specification](../specs/Portava_Sensing_World_Experience_Intelligence_Upgrade_Architecture_v1.txt), and [Media specification](../specs/Portava_Media_Engineering_Architecture_and_Design_Spec.txt).

## Shared decision formula

For candidate action or item `a`, traveler `u`, context `c` and time `t`:

```text
Eligible(a,u,c,t) = permission ∧ privacy ∧ safety-policy ∧ hard-constraints ∧ evidence-use

U(a | u,c,t) = Σ wᵢ × supportedBenefitᵢ(a,u,c,t)
              − Σ λⱼ × costⱼ(a,u,c,t)

Choose the most useful eligible option, including stay / wait / no interruption.
```

Eligibility is three-state: **eligible**, **blocked**, or **needs verification**. An unknown required permission cannot count as a pass. A safety-policy pass means the use is permitted; it is not a claim that a place or person is safe. A blocked candidate is excluded, not assigned zero where it could accidentally beat negative-scoring eligible candidates.

Each factor is normalized to `[0,1]` using a versioned definition. Positive weights sum to one; cost coefficients are separately specified. The resulting utility is an index, not a probability. Essential safety, privacy and consent are gates, never costs that popularity or revenue can offset.

Populate factors from the existing measured features and qualified projections. The language model must not invent numeric evidence scores. Do not count the same signal repeatedly under different names; calibrate overlapping factors together.

Only use measurements appropriate to the question. Unknown travel time is not zero; a high creator rating is not evidence of opening hours. The `evidence-use` gate checks that the requested use preserves the evidence's limitations. Historical media can qualify for a history view while failing to qualify as proof of current conditions.

### Missing information and additional reasoning

Unknown benefit contributes `[0,wᵢ]`; unknown cost contributes `[-λⱼ,0]`. This yields a lower and upper utility bound. Do not renormalize weights around missing fields, because that can reward poorly documented candidates.

An option is a robust leader only when its lower bound exceeds every eligible alternative's upper bound. Otherwise, identify the uncertain factor that could change the choice. Fetch permitted evidence or ask a focused question when the expected decision improvement exceeds the time and interruption cost. If it does not, give a conditional recommendation with the uncertainty stated. These are evidence bounds, not statistical confidence intervals.

## Compass

```text
Ucompass = w₁ intentFit + w₂ personalFit + w₃ timingFit
           + w₄ continuity + w₅ actionability
           − λ₁ travelFriction − λ₂ switchingCost
```

| Factor | Meaning |
| --- | --- |
| intentFit | Serves the latest request, including negations and exclusions. |
| personalFit | Fits declared or permitted learned preferences; remains distinct from community popularity. |
| timingFit | Fits verified availability, fixed commitments and the useful time window. Essential feasibility is a gate; this term ranks options that already qualify. |
| continuity | Builds on the current conversation and plan, preserving choices the traveler has already made. |
| actionability | Offers a real, supported next step through existing app capabilities. |
| travelFriction | Grounded travel effort, cost and inconvenience relative to the traveler's needs. |
| switchingCost | The disruption of leaving a current experience or changing a plan that works. |

Operate in this order: understand the request → recover authorized context → retrieve real candidates → apply constraints → compare → explain the best fit and tradeoff → propose the next action → learn only from confirmed outcomes.

Use the most recent explicit instruction ahead of an inferred preference. Do not ask again for a known destination. Do not silently weaken a hard requirement to fill a list. Recheck current evidence and trip authorization before proposing or confirming changes.

Example: the traveler is tired and has 45 minutes. A nearby quiet café may have higher utility than a famous rooftop across town. If the travel time is unknown, Compass cannot claim the rooftop fits. If the traveler is already enjoying a suitable café, staying must compete with moving.

## Sensing and attention

Sensing first estimates the world from authorized evidence. Compass Sense and the attention engine then decide whether a change matters enough to show a particular person. Personal preference must not rewrite the shared world estimate.

```text
Usensing = w₁ decisionRelevance + w₂ informationGain + w₃ novelty
           + w₄ urgency + w₅ usefulWindow
           − λ₁ interruptionCost − λ₂ samplingCost
```

`informationGain` means a reduction in uncertainty that could improve a supported decision. `novelty` requires a meaningful new change, not a new copy of the same report. `usefulWindow` asks whether the traveler can still benefit before the evidence or opportunity expires. Sampling cost represents permitted battery, network and processing effort; it cannot purchase additional privacy access.

Evaluate only allowed actions: observe less, collect within an active consented session, refresh a projection, show in-app, notify, or ignore. Collection and notification have different permissions. Presence mode, category permissions, quiet hours, deduplication, approved attention budgets and session revocation still constrain delivery. Only the canonical safety authority can invoke a safety exception; an activity anomaly cannot grant one.

A full café must not become “unsafe”; absent coverage must not become “quiet”; rapid motion must not become “dancing.” Sparse or conflicting signals stay qualified. One device, group or repeated session must not become a crowd.

Example: a fresh closure report affects a saved stop before departure, so it can have high decision value. Repeating an unchanged “busy nearby” observation during quiet hours does not earn another alert.

## Information contributed by users

Keep two questions separate: **how much does this report support a specific claim?** and **how useful is that information to this recipient?**

For a qualified report `j` about the same subject, claim and time window:

```text
freshnessⱼ = 2^(−ageⱼ / claimHalfLife), until hard expiry; then 0
evidenceWeightⱼ = sourceReliabilityⱼ × directnessⱼ × entityMatchⱼ × freshnessⱼ

Within each independence group:
  retain the strongest support and strongest opposition
  cap their combined weight at the strongest report in the group

supportShare = totalSupport / (totalSupport + totalOpposition)
```

Half-lives and expiry come from the existing claim-family policy. Missing or impossible observation times remain unknown. Reliability must be calibrated for the source and claim type, not copied from a person's Trust Score, follower count or posting volume. A new contributor gets an honest uncertainty treatment, not an automatic verdict of unreliability.

Independence groups must come from authorized lineage or deduplication evidence; the model must not invent them. Unproven independence is conservatively grouped. Window-scoped group keys are internal and must not reveal anonymous contributors. `supportShare` is agreement among usable evidence, not the probability a claim is true. Keep independent coverage, contradiction, freshness and unknowns separate. The canonical qualification service retains authority to assign truth metadata.

For showing a qualified contribution to a recipient:

```text
Ucommunity = w₁ evidenceQuality + w₂ decisionRelevance + w₃ freshness
             + w₄ informationGain + w₅ coverageGain
             − λ₁ conflict − λ₂ duplication
```

Conflict reduces suitability for an unqualified recommendation; it does not suppress opposing evidence from the truth pipeline or a labeled disagreement view. Distinguish facts (“entrance closed at 18:10”), preferences (“too loud for me”) and predictions. Encourage specific, timely, checkable reports that fill an information gap. Credit permitted, attributable helpful outcomes rather than rewarding raw volume or agreement with the majority.

Example: one current access report with independent corroboration can be more useful than 100 reposts of an old caption. A contradictory current report should trigger a qualified state or recheck, not be outvoted by copies.

## Media shown to each individual

```text
Umedia = w₁ intentFit + w₂ tripFit + w₃ visualUsefulness
         + w₄ discoveryValue + w₅ socialRelevance
         − λ₁ repetition − λ₂ irrelevance − λ₃ staleness
```

`visualUsefulness` means the asset helps answer the viewer's question about a place or experience. `discoveryValue` includes a useful new perspective or undercovered destination; novelty alone is insufficient. `socialRelevance` uses only allowed follows, crew and shared experiences. Staleness depends on purpose: last year's photo is unsuitable as a current view, but may be excellent in a personal memory collection.

Apply visibility, moderation, blocks, location precision and Hidden Gem protection before publication. Preserve the existing rule that authentic imagery outranks generated fallback. This is an ordering tier, not a weighted bonus that synthetic imagery can overcome. Unknown provenance remains unknown.

Select a set of perspectives, not just the top independent scores. Apply the existing author/place/category repetition controls, avoid near-duplicates, and keep bounded room for useful discovery. Respect the active surface: World emphasizes place and time; People emphasizes permitted social context; My World preserves the user's library controls; Wall remains chronological/current-life. One global ranking must not erase these choices.

Use current intent and trip context ahead of inferred historical habits. Honor “not interested,” hides and blocks; treat an isolated skip cautiously. Watch time and likes may diagnose playback or interaction, but do not determine truth or dominate this objective.

Example: two people in Da Nang can receive different permitted perspectives. A traveler planning a quiet family morning may see access, shade and daytime conditions. Someone explicitly looking for tonight's music may see relevant event and venue perspectives. Both receive the same underlying truth metadata about a place.

The Passport menu entry uses the signed-in person's display photo, with an initials fallback, so the personal destination is visually identifiable.

## Existing owners and integration boundaries

| Responsibility | Existing code owner |
| --- | --- |
| Compass candidate gates and ranking | `artifacts/api-server/src/compass/CompassPipeline.ts`, `CompassScoringEngine.ts`, `CompassRecommendationEngine.ts` |
| Current experience and switching | `artifacts/api-server/src/lib/compassDecision.ts`, `compassPolicy.ts` |
| Conversation and actions | `artifacts/api-server/src/routes/compass.ts`, `compass/CompassTools.ts` |
| Sensing consent and aggregation | `artifacts/api-server/src/lib/sensingContributionPolicy.ts`, `sensingConsentGrants.ts`, `sensingWindowAggregate.ts` |
| Proactive attention | `artifacts/api-server/src/lib/attentionEngine.ts`, `compass/CompassSenseEngine.ts` |
| Qualified world evidence | `artifacts/api-server/src/lib/liveClaimRead.ts`, `intelEvidenceCapture.ts`, `media/mediaEvidenceEligibility.ts` |
| World media ranking and signals | `artifacts/api-server/src/services/media/MediaRankingService.ts`, `lib/mediaRankingSignals.ts` |
| Legacy Watch feed | `artifacts/api-server/src/services/ranking/MediaFeedRankingService.ts`; evaluate this path separately from World media |

Use the formulas to refine these owners. Do not install a parallel ranking authority, truth store, consent model or place identity.

## Calibration and acceptance

Measure useful outcomes separately: a relevant place saved, a plan explicitly confirmed, an avoided conflict, an acknowledged helpful alert, a useful report corroborated, or an experience the traveler explicitly valued. A direction request does not establish a completed visit. Avoid double-counting a single causal outcome across media, Compass and Sensing.

Compare candidate weights to the current baseline with time-separated evaluation data. Inspect results by intent, city coverage, new versus returning users and affected surface. Account for what people were actually shown; missing outcomes and an unseen candidate are not negative judgments. Bounded, permission-respecting exploration is needed before claiming one option is causally better. Durable preferences remain editable and revocable.

Retain the standing Compass nine-query evaluation and measure factual grounding, continuity, permission compliance and action correctness separately. Record latency and tool cost alongside usefulness. No aggregate success score can hide a privacy or unsupported-claim failure.

Before production tuning, require these behavioral checks:

- A maximally popular candidate cannot overcome a failed hard constraint.
- Unknown permission produces no disclosure; unknown travel time remains unknown.
- A small benefit cannot overcome a larger known switching cost.
- 100 copies do not outweigh one independent contrary report.
- Expired or future-dated evidence does not become a current observation.
- Revoked sessions stop collection and queued disclosure through their existing owners.
- An unchanged signal cannot buy a second interruption with a higher score.
- Different declared intentions can change media ordering without changing world truth.
- Generated fallback cannot outscore real imagery into the current-view lead.
- One author or place cannot fill a slate by uploading duplicates.

Run the reference checks with `pnpm run test:intelligence-formulas`. Its fixtures prove algebraic properties, not real model quality, production privacy behavior, calibrated reliability or a measured optimum. Live evaluations and the existing domain tests supply those separate forms of evidence.

## Baseline grades before the A++ hardening pass

Assessment date: 2026-11-13. These are provisional **implementation grades** from code inspection and targeted local checks. They are not measured production accuracy or usefulness scores. The new formulas are a reference design; passing their synthetic tests does not raise a live system's grade.

An **A** requires coherent implementation, integration evidence and measured real-world effectiveness. A **B** has substantial working implementation and passing contract tests, with material validation or integration gaps. A **C** has important behavior only partially implemented or inconsistent across primary paths. A **D/F** indicates demonstrated fundamental failures. A minus marks a significant remaining limitation within the band.

| System | Grade | Evidence from this pass | What prevents an A |
| --- | --- | --- | --- |
| Compass | B | Provider-request tests preserve conversation constraints and card identities; place/event retrieval ranks a broader pool; action tests retain confirmation, authorization and valid trip dates. | Live model answer quality, multi-tool latency and achieved traveler outcomes were not evaluated. The new objective weights are not calibrated or deployed. |
| Sensing and attention | B− | Cohort/window aggregation, consent, consumer revocation and attention-routing tests pass; insufficient coverage is distinct from an empty observation. | Real sensor accuracy, independent coverage in each city, battery cost and alert helpfulness need field evidence. Production capability activation was not inspected. |
| User-contributed information | B− | Independence tests collapse copied media, shared sources and coordinated observations; media evidence qualification and its pipeline seam pass. | Source reliability and helpfulness need calibration against independent ground truth and actual outcomes. The proposed contribution objective is not a deployed reliability model. |
| Personalized media | B− | World ranking tests cover context, utility, provenance and diversity; Watch routing tests exercise both the legacy and Stage 24 ranking paths. | Cross-surface policy depends on the existing Watch flag; its production state was not verified. Real-world usefulness, cold-start quality and device behavior remain unmeasured. |

Evidence recorded locally: 14 reference-model tests; 241 tests across `sensingWindowAggregate`, `sensingCoverageAggregate`, `sensingConsentGrants`, `sensingConsumersRevocationReach`, `attentionEngine`, `intelIndependence`, `mediaEvidenceEligibility`, `mediaEvidenceSeam`, `mediaRankingObjectives` and `mediaWatchStage24Ranking`. The earlier Compass pass ran 119 focused tests and a further 105 action/ranking/permission tests; those runs overlap and must not be summed as unique tests. These tests use controlled fixtures, not live provider or field observations.

The next evidence needed for stronger grades is distinct for each system: the standing Compass evaluation with real answers and independent adjudication; Sensing field trials against known conditions; contribution reliability and abuse-resistance checks against independent outcomes; and media comparisons measuring relevant actions and reported satisfaction across both feed paths. Preserve all hard gates while tuning.

## A++ target and implemented hardening

The requested target is **A++ for all four systems**. This is an acceptance target, not a replacement label for missing evidence. The following changes now run in the existing production code paths; they do not enable deployment flags or activate the reference coefficients.

| System | Implemented behavior | Regression evidence |
| --- | --- | --- |
| Compass | Model rounds and the summary share a 65-second allowance measured from request arrival, with a 25-second per-round cap and a reserved final-answer window. Disconnects abort upstream generation. Malformed tool arguments produce a repair request without executing a tool. Memory fallback retrieval has a five-second limit. | API cases for finishing within the remaining allowance, retryable exhaustion without assistant persistence, argument repair, tool authorization, grounding, history and memory fallback; transport tests for ignored cancellation and late answers. |
| Sensing | Dwell requires consecutive publishable sightings. Every reduced feature must pass the existing contributor/group privacy gate using its own valid supporters; a large presence cohort cannot expose one person's acoustic or motion reading. | Gapped and unreadable-window cases; sparse acoustic/density features remain withheld while supported fields remain useful; consent and revocation regressions. |
| User contributions | Reports from the same actor merge into one independence cluster even across changing or overlapping crews. Existing media-copy, common-source and coordination detectors remain in force. | Reversed-input determinism, changing group keys, overlapping crews, evidence qualification, and the aggregation/replay pipeline. |
| Personalized media | Freshness uses canonical capture time where present. Re-uploading old media does not refresh it; a future capture is not fresh. Synthetic media cannot consume real media's diversity allowance or fill an observational coverage gap. | Capture-time and future-date cases, synthetic insertion invariance, World objectives, Watch integration, and evidence eligibility. |

The Compass allowance bounds model work, not the entire API handler: database context assembly, tool writes and final card hydration retain their existing owners. A model deadline is not permission to cancel or repeat an uncertain write. Legacy media without capture metadata still use the existing upload-time fallback; that fallback is not proof of when a scene occurred.

`pnpm run test:intelligence-quality` runs the 14 reference checks and the focused server regression set. The hardening run passed **433 server checks** across 21 suites/files. A focused rerun covers final Compass budget changes; overlapping reruns are not additional unique tests. Runtime TypeScript and the existing test-type ratchet are separate gates. No iPhone build, provider evaluation, field trial or deployment is implied by these checks.

### Evidence required to award A++

All systems must pass their executable invariants, retain permission/consent and uncertainty boundaries, and demonstrate useful outcomes on held-out data through the actual serving path. Missing measurements remain **unverified**, not zero failures.

- **Compass:** the standing nine-query run must pass machine checks and all independent adjudications, plus multi-turn corrections, changing destinations, inaccessible history, slow tools and interrupted transports. Record end-to-end latency and actual action outcomes; model-time tests alone cannot certify either.
- **Sensing:** compare claims to independent field observations across sparse and dense coverage, gaps, sensor classes and device states. Measure false confidence, revocation behavior, battery cost and unwanted interruptions. Keep unknown conditions unknown.
- **User contributions:** use independently established outcomes to evaluate reliability and conflicting reports, with users and time periods held out from tuning. Include copied evidence, overlapping parties and coordinated submissions; popularity must never substitute for independence.
- **Personalized media:** evaluate both World and Watch, cold starts and explicit intent changes. Compare relevance, useful actions and reported satisfaction against the current serving baseline; measure playback reliability separately. Neither watch time nor synthetic test scores establish user benefit.

Current status after hardening: **local regressions verified; A++ effectiveness not yet certified**. This workspace has no configured non-production evaluation API/model provider, and no field or outcome dataset was supplied. Live evaluation remains pending that environment and evidence. The earlier B-range grades are historical provisional assessments; no A++ grade has been fabricated from the local pass count.

## Production monitoring follow-up

On 2026-11-13 the user authorized a production monitor, now installed for these four systems plus **Discovery** and **Input**. See [the deployment record](../ops/intelligence-monitor-production.md) for the saved dashboard, exact production verification and limits. Hourly aggregate health monitoring supplies ongoing operational evidence; it does not replace model-answer adjudication, field calibration or measured usefulness.

Discovery's provisional implementation grade is **B** (loading reliability and uneven place/photo coverage remain limitations). Input's is **B+** (stronger typo, ambiguity, privacy and correction handling; prefill reliability and device latency remain limitations). The focused local review passed 236 checks. Initial production telemetry is too sparse to certify their effectiveness: no Discovery diagnostic timing samples and one Input timing sample in the first monitored window.
