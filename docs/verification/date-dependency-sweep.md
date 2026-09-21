# The fixed-date sweep: none of the 163 are bombs, and four other files are

**Swept at** `f224ae67e` (branch `claude/portava-continuation-uqta94`), on 2026-09-16.
**Scope as asked** every `*.test.ts` / `*.test.tsx` in either workspace carrying a
hard-coded `2026-09-1x` date — 128 under `artifacts/api-server/src/test/`, 35 under
`travel-buddy-standalone/src/`.
**Scope as run** that, plus all 1,297 registered `api-server` suites and all 272
`travel-buddy-standalone` node suites, under a moved clock. Widening it was not
thoroughness for its own sake: everything actually dangerous was outside the grep.

Three of that population detonated between 22:00 and 00:00 UTC on 2026-09-15/16 and
were fixed under time pressure in #506 (`a97bfdac0`): `computeTripStatus`,
`tripTodayProjection`, `TripsTab.playBadge`. That commit's own closing note asked for
this sweep. This is it.

## The answer first

| class | count | what it means |
|---|---|---|
| **SAFE** | 162 of the 163 in scope (the 163rd cannot be run outside CI at all — see below) | the assertion is judged against the same clock the fixture is pinned to, or the date is inert data |
| **DANGEROUS** | **4**, all outside the `2026-09-1x` scope | real clock vs pinned fixture. Fixed here. Three more existed and are fixed at the base commit |
| **SECOND CLOCK** | **2** production defects | production code reads the wall clock behind an injected-`now` API. Fixed here |

**The scare number was wrong in both directions.** Not one of the files the
`2026-09-1x` grep found is dangerous — every one survives a clock moved three days
and four hundred days forward. And running the sweep over the WHOLE registered
suite instead of over that grep found four armed bombs the grep could never have
seen, because none of them contains a `2026-09-1x` date:

| file | pinned to | detonates | days from 2026-09-16 |
|---|---|---|---|
| `src/test/tripKernelExpansion.test.ts` | a trip `2026-10-01`→`2026-10-05`, `status: "upcoming"` | **2026-10-05** | **19** |
| `src/test/creatorActivityScore.test.ts` | `created_at: "2026-09-01"` inside a 90-day window | **2026-11-30** | 75 |
| `src/test/inputAssistanceRankingSignals.test.ts` | a trip window `2026-12-01`→`2026-12-10` | **2026-12-10** | 85 |
| `src/test/discoverySearch.test.ts` | a trip `2027-09-12`→`2027-09-15` | **2027-09-15** | 364 |

The nearest one is nineteen days out, and it is `computeTripStatus` again — the
same function that took `tripHealthProjection` down on 2026-09-15, in a suite that
asserts a trip's `status` is `"upcoming"` against an `end_date` the wall clock is
about to pass.

The other half of what the sweep found is in the production tree: two functions with
no clock parameter sitting underneath callers that have one — the same defect
`computeTripStatus` was, in two other domains, where no calendar constant in any
test could ever have exposed them.

**The method matters more than the list.** A grep for one date prefix is a search
for the bombs that already went off. Moving the clock over the whole suite is a
search for the ones that have not.

## Method: move the clock, do not wait for midnight

A fixed date is only dangerous when the **assertion** is judged against the **real**
clock while the **fixture** is pinned to a **constant**. That is not visible by
reading: `tripBoredRoute.test.ts:28` pins `2026-09-12` and is safe, while
`tripTodayProjection.test.ts` pinned `2026-09-15` and was a bomb, and the two files
look alike. The difference is whether the code under test is told what time it is.

So the population was separated by experiment rather than by eye. A preload module
replaces `Date` with one shifted forward by a fixed offset — monotonic, not frozen,
so it simulates running the suite N days later rather than stopping time:

```js
// CLOCK_OFFSET_MS=34560000000  node --import shift-clock.mjs --import tsx/esm --test <file>
const RealDate = Date, realNow = RealDate.now.bind(RealDate);
class ShiftedDate extends RealDate {
  constructor(...a) { a.length === 0 ? super(realNow() + OFFSET_MS) : super(...a); }
  static now() { return realNow() + OFFSET_MS; }
}
globalThis.Date = ShiftedDate;
```

`node --test` forks a child per file and passes `--import` through, so the shift
reaches the test body; a control assertion (`new Date().getUTCFullYear() === 2026`)
fails under the shift, which is how that was established rather than assumed. The
jest component suite gets the same shift through an extra `setupFiles` entry.

Every file in the `2026-09-1x` population was run three times: unshifted, **+3 days**
(2026-09-19 — a different weekday, past every fixture in that population), and
**+400 days** (2027-10-21 — a different month, year and weekday). Then both whole
suites were run at both offsets:

| suite | files | assertions | unshifted | +400 days |
|---|---|---|---|---|
| `api-server` (`pnpm test`) | 1,297 | 23,025 | green | **4 files red** — the four above |
| `travel-buddy-standalone` (`pnpm test`) | 272 | 6,263 | green | green |
| `travel-buddy-standalone` jest component | 26 of 556 (the date-carrying ones) | 208 | green | green |

The `api-server` +400d column is the entire finding. It is also why the
`travel-buddy` node column is worth stating: 6,263 assertions moved four hundred
days into the future and not one of them noticed, which is a real result about that
workspace rather than an absence of evidence.

**The grep and the clock-shift disagree completely.** Every file the grep found is
safe; every dangerous file is outside it. Not one of the four would have been found
by any refinement of the date prefix, because none of them contains one.

### The harness was proved on the known bombs before it was trusted

A sweep that finds nothing is indistinguishable from a sweep that cannot see. Both
harnesses were therefore run against the PRE-FIX versions of two of the three known
bombs, restored from `a97bfdac0^`:

| control | harness | result |
|---|---|---|
| `tripTodayProjection.test.ts` at `a97bfdac0^` | `node --test` + shift | **1 failed** / 25 passed at +400d |
| `TripsTab.playBadge.component.test.tsx` at `a97bfdac0^` | jest + shift | **2 failed** / 2 passed at +400d |
| `tripBoredRoute.test.ts` (the known survivor) | `node --test` + shift | 16 passed at +400d |

Both harnesses detect the class. Both fixtures were then restored.

## SAFE — all 163 files in the `2026-09-1x` population

All 162 runnable files pass at +3d and +400d, with the 163rd excluded for a reason that is not about
the clock: `src/test/wallSessionIntentLiveDb.test.ts` is a LIVE-DB test whose
`ciSupabaseGuard` refuses to construct a client outside CI, so it exits 2 at every
offset including zero. It is not in the registered `test` list either (the list
carries its `…LiveDbStatus` sibling), so it never runs in `pnpm test`. Excluded as
unrunnable here, not classified.

Within SAFE there are three shapes, and the tables below separate them by the
evidence that distinguishes them: whether any fixed date sits on a **window-bound
field** (`starts_at` / `ends_at` / `start_date` / `end_date` / `expires_at` /
`publish_at` / `valid_until` / `deadline` …). A date on such a field is the only one
that can be compared against a clock at all; a date anywhere else is inert.

* **Inert data** — the date is an id, a payload value asserted equal to itself, a
  `created_at` ordered against another `created_at`, a census timestamp. Nothing
  compares it to a present. 128 of the 163.
* **Relative window** — the dates ARE window bounds, but the horizon they are judged
  against is another constant in the same fixture, not the clock. `wallCandidateLoaders`
  is the clearest: posts at `2026-09-01` and `2026-09-10` with a `snapshotAtIso` of
  `2026-09-05` between them. The snapshot IS the injected clock.
* **Injected clock** — the code under test is handed the instant (`?at=`, `{ now }`,
  `nowMs`, `snapshotAtIso`) and the assertion is judged against that same instant.
  This is the `tripBoredRoute.test.ts` shape and it is correct as written.

### `artifacts/api-server/src/test/` — 128 files, 571 literals, 25 with a window-bound date

| file | `2026-09-1x` literals | what they are | on a window-bound field |
|---|---|---|---|
| `artifacts/api-server/src/test/tripLifecycle.test.ts` | 22 | window bound | 7 |
| `artifacts/api-server/src/test/tripPostTripProjections.test.ts` | 28 | window bound | 6 |
| `artifacts/api-server/src/test/tripTimelineStageLocalTime.test.ts` | 18 | window bound | 6 |
| `artifacts/api-server/src/test/mapProjectionLayers.test.ts` | 5 | window bound | 4 |
| `artifacts/api-server/src/test/tripOperationalPhase.test.ts` | 34 | window bound | 4 |
| `artifacts/api-server/src/test/tripCloseout.test.ts` | 24 | window bound | 3 |
| `artifacts/api-server/src/test/tripProjections.test.ts` | 21 | window bound | 3 |
| `artifacts/api-server/src/test/tripRouteChainProjection.test.ts` | 8 | window bound | 3 |
| `artifacts/api-server/src/test/wallContextThread.test.ts` | 3 | window bound | 3 |
| `artifacts/api-server/src/test/compassCensusClosure.test.ts` | 8 | window bound | 2 |
| `artifacts/api-server/src/test/coverPrivacyToggle.test.ts` | 2 | window bound | 2 |
| `artifacts/api-server/src/test/mapProjectionTripConsumer.test.ts` | 2 | window bound | 2 |
| `artifacts/api-server/src/test/tripAbsenceGuard.test.ts` | 3 | window bound | 2 |
| `artifacts/api-server/src/test/tripTelegraphProjection.test.ts` | 5 | window bound | 2 |
| `artifacts/api-server/src/test/wallCandidateLoaders.test.ts` | 6 | window bound | 2 |
| `artifacts/api-server/src/test/compassSurfaces.test.ts` | 2 | window bound | 1 |
| `artifacts/api-server/src/test/rlsPrivacyBaseline.test.ts` | 1 | window bound | 1 |
| `artifacts/api-server/src/test/tripBoredRoute.test.ts` | 4 | window bound | 1 |
| `artifacts/api-server/src/test/tripFreedomConsumers.test.ts` | 34 | window bound | 1 |
| `artifacts/api-server/src/test/tripFreedomWindows.test.ts` | 6 | window bound | 1 |
| `artifacts/api-server/src/test/tripHealthProjection.test.ts` | 6 | window bound | 1 |
| `artifacts/api-server/src/test/tripMapProjection.test.ts` | 5 | window bound | 1 |
| `artifacts/api-server/src/test/tripOfflineRoute.test.ts` | 3 | window bound | 1 |
| `artifacts/api-server/src/test/tripPostTripRoutes.test.ts` | 7 | window bound | 1 |
| `artifacts/api-server/src/test/wallLiveStripDedup.test.ts` | 1 | window bound | 1 |
| `artifacts/api-server/src/test/airport.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/attentionEngine.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/censusDigitPrefixIds.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/ciWorkflowArchitecture.test.ts` | 3 | inert data | 0 |
| `artifacts/api-server/src/test/compass-structured-context.test.ts` | 4 | inert data | 0 |
| `artifacts/api-server/src/test/compassCpv2Grounding.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/compassDecision.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/creatorShareCanonicalProperties.test.ts` | 3 | inert data | 0 |
| `artifacts/api-server/src/test/creatorShareReader.test.ts` | 2 | inert data | 0 |
| `artifacts/api-server/src/test/crowdForecastState.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/db/tripLedgerGoalsReservations.db.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/discoveryCandidate.test.ts` | 2 | inert data | 0 |
| `artifacts/api-server/src/test/discoveryCuratedSourceRefusal.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/discoveryDiversityAxes.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/discoveryLayoverMode.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/discoveryLiveRank.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/discoveryRefusalD11.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/discoveryServeLog.test.ts` | 6 | inert data | 0 |
| `artifacts/api-server/src/test/discoveryServeLogProvenance.test.ts` | 2 | inert data | 0 |
| `artifacts/api-server/src/test/discoveryShadowTravelIntent.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/discoverySuggestionSeenCache.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/discoveryTrailModifier.test.ts` | 2 | inert data | 0 |
| `artifacts/api-server/src/test/discoveryTrailRoutes.test.ts` | 2 | inert data | 0 |
| `artifacts/api-server/src/test/docCitations.test.ts` | 2 | inert data | 0 |
| `artifacts/api-server/src/test/experienceSession.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/highlightControlWrites.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/highlightsMemoriesDeployedStorage.test.ts` | 3 | inert data | 0 |
| `artifacts/api-server/src/test/highlightsUnenforceableControls.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/layoverCutover.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/layoverDecisionLedger.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/layoverEnvelope.test.ts` | 2 | inert data | 0 |
| `artifacts/api-server/src/test/layoverEnvelopeBidirectional.test.ts` | 2 | inert data | 0 |
| `artifacts/api-server/src/test/layoverLiveIntersection.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/layoverMaturityModel.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/layoverObservabilityMetrics.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/layoverRecommendationGate.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/layoverReplayDeterminism.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/layoverReturnConditions.test.ts` | 20 | inert data | 0 |
| `artifacts/api-server/src/test/layoverScenarioMatrix.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/layoverScenarioMatrixDisruption.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/layoverSessionEditReplan.test.ts` | 12 | inert data | 0 |
| `artifacts/api-server/src/test/layoverTravelTimeProvenance.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/liveReference.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/mediaExperienceConfidence.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/mediaGemStateLens.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/mediaIndependentSources.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/mediaProjectionGaps.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/mediaReportIntent.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/memoryCommandBus.test.ts` | 2 | inert data | 0 |
| `artifacts/api-server/src/test/migrationDeployability.test.ts` | 2 | inert data | 0 |
| `artifacts/api-server/src/test/notNullWrites.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/opportunityEngine.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/passportDomainTrustBasis.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/passportProjection.test.ts` | 2 | inert data | 0 |
| `artifacts/api-server/src/test/passportStampPlaceVocabulary.test.ts` | 2 | inert data | 0 |
| `artifacts/api-server/src/test/passportStampTypeVocabulary.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/productionDriftExtraction.test.ts` | 5 | inert data | 0 |
| `artifacts/api-server/src/test/rankEventsDirectExposureProvenance.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/safeReturn.test.ts` | 3 | inert data | 0 |
| `artifacts/api-server/src/test/safetyCandidate.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/schemaReferenceMapPayloads.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/sensingCensusRederivation.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/storyHighlightVisibility.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/telegraphMessageKernelMigration.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/telegraphReportEvidence.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/telegraphRequestOrigin.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/telegraphStreamResume.test.ts` | 3 | inert data | 0 |
| `artifacts/api-server/src/test/telegraphVoice.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/tripAttentionFilter.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/tripAttentionPolicy.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/tripCreateValidation.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/tripCrewLocationExpiredGrant.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/tripCrewPresenceReason.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/tripDecisionRiskImpact.test.ts` | 3 | inert data | 0 |
| `artifacts/api-server/src/test/tripDepartureAssumptions.test.ts` | 16 | inert data | 0 |
| `artifacts/api-server/src/test/tripFreedomEngine.test.ts` | 2 | inert data | 0 |
| `artifacts/api-server/src/test/tripImpactUnreadDisclosure.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/tripKernelFamiliesWiring.test.ts` | 9 | inert data | 0 |
| `artifacts/api-server/src/test/tripMeetingCheckpointsRoute.test.ts` | 2 | inert data | 0 |
| `artifacts/api-server/src/test/tripOfflineBundle.test.ts` | 4 | inert data | 0 |
| `artifacts/api-server/src/test/tripOfflineQueue.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/tripOpportunityProjection.test.ts` | 4 | inert data | 0 |
| `artifacts/api-server/src/test/tripPresenceFreshnessClass.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/tripPresenceNewestObservation.test.ts` | 11 | inert data | 0 |
| `artifacts/api-server/src/test/tripProjectionEnvelope.test.ts` | 18 | inert data | 0 |
| `artifacts/api-server/src/test/tripPulseProjection.test.ts` | 7 | inert data | 0 |
| `artifacts/api-server/src/test/tripReadiness.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/tripReplanMeetingRescue.test.ts` | 5 | inert data | 0 |
| `artifacts/api-server/src/test/tripReplanRoutes.test.ts` | 20 | inert data | 0 |
| `artifacts/api-server/src/test/tripScenarios.test.ts` | 8 | inert data | 0 |
| `artifacts/api-server/src/test/tripSensingPolicy.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/tripSignals.test.ts` | 9 | inert data | 0 |
| `artifacts/api-server/src/test/tripSimulateReasonCodes.test.ts` | 2 | inert data | 0 |
| `artifacts/api-server/src/test/tripStatusInjectedClock.test.ts` | 32 | inert data | 0 |
| `artifacts/api-server/src/test/tripTodayProjection.test.ts` | 4 | inert data | 0 |
| `artifacts/api-server/src/test/tripTransportReliability.test.ts` | 5 | inert data | 0 |
| `artifacts/api-server/src/test/trustAdminActionVocabulary.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/unifiedStamps.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/verificationLevelVocabulary.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/verificationProviderNormalization.test.ts` | 4 | inert data | 0 |
| `artifacts/api-server/src/test/verificationRetention.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/wallMoments.test.ts` | 1 | inert data | 0 |
| `artifacts/api-server/src/test/wallSessionIntentLiveDb.test.ts` | 1 | inert data | 0 |

### `travel-buddy-standalone` node:test — 9 files, 40 literals

| file | `2026-09-1x` literals | what they are | on a window-bound field |
|---|---|---|---|
| `travel-buddy-standalone/src/features/trips/crew/__tests__/tripNavigationHandoff.test.ts` | 8 | window bound | 3 |
| `travel-buddy-standalone/src/features/trips/offline/__tests__/tripOffline.test.ts` | 7 | window bound | 2 |
| `travel-buddy-standalone/src/features/trips/today/__tests__/tripPhase.test.ts` | 6 | window bound | 2 |
| `travel-buddy-standalone/src/features/trips/today/__tests__/tripToday.test.ts` | 6 | window bound | 2 |
| `travel-buddy-standalone/src/features/map/telemetry/__tests__/whyShownOpened.test.ts` | 3 | inert data | 0 |
| `travel-buddy-standalone/src/features/trips/closeout/__tests__/tripCloseout.test.ts` | 1 | inert data | 0 |
| `travel-buddy-standalone/src/features/trips/crew/__tests__/presence.test.ts` | 1 | inert data | 0 |
| `travel-buddy-standalone/src/features/trips/timeline/__tests__/tripTimeline.test.ts` | 7 | inert data | 0 |
| `travel-buddy-standalone/src/services/__tests__/tripProjectionEnvelope.test.ts` | 1 | inert data | 0 |

### `travel-buddy-standalone` jest component — 26 files, 82 literals

| file | `2026-09-1x` literals | what they are | on a window-bound field |
|---|---|---|---|
| `travel-buddy-standalone/src/features/passport/__tests__/PlansScreen.component.test.tsx` | 5 | window bound | 3 |
| `travel-buddy-standalone/src/features/trips/today/__tests__/TripTodayCard.component.test.tsx` | 7 | window bound | 3 |
| `travel-buddy-standalone/src/components/passport/__tests__/PassportHomePreviews.component.test.tsx` | 4 | window bound | 2 |
| `travel-buddy-standalone/src/features/passport/__tests__/TripInvitePickerSheet.component.test.tsx` | 2 | window bound | 2 |
| `travel-buddy-standalone/src/components/layover/__tests__/CanILeaveCard.shortfall.component.test.tsx` | 6 | window bound | 1 |
| `travel-buddy-standalone/src/features/trips/offline/__tests__/TripOfflineCard.component.test.tsx` | 10 | window bound | 1 |
| `travel-buddy-standalone/src/components/__tests__/TripsTab.playBadge.component.test.tsx` | 2 | inert data | 0 |
| `travel-buddy-standalone/src/components/__tests__/TripsTab.staleActiveStatus.component.test.tsx` | 1 | inert data | 0 |
| `travel-buddy-standalone/src/components/discovery/__tests__/DiscoveryCategoryTab.refusal.component.test.tsx` | 1 | inert data | 0 |
| `travel-buddy-standalone/src/components/discovery/__tests__/DiscoveryEventPostsRail.refusal.component.test.tsx` | 1 | inert data | 0 |
| `travel-buddy-standalone/src/components/discovery/__tests__/ForYouTab.refusal.component.test.tsx` | 1 | inert data | 0 |
| `travel-buddy-standalone/src/components/layover/__tests__/CanILeaveCard.component.test.tsx` | 2 | inert data | 0 |
| `travel-buddy-standalone/src/components/layover/__tests__/LayoverCompassCard.component.test.tsx` | 2 | inert data | 0 |
| `travel-buddy-standalone/src/components/layover/__tests__/LayoverFlightChangeCard.component.test.tsx` | 10 | inert data | 0 |
| `travel-buddy-standalone/src/components/layover/__tests__/LayoverMapCard.envelope.component.test.tsx` | 8 | inert data | 0 |
| `travel-buddy-standalone/src/components/map/__tests__/MapSearchSheet.refusal.component.test.tsx` | 1 | inert data | 0 |
| `travel-buddy-standalone/src/components/passport/__tests__/memoryViews.component.test.ts` | 5 | inert data | 0 |
| `travel-buddy-standalone/src/components/passport/__tests__/PassportRatifiedIdentity.decision.component.test.ts` | 2 | inert data | 0 |
| `travel-buddy-standalone/src/components/search/__tests__/SearchSuggestionsPanel.refusal.component.test.tsx` | 1 | inert data | 0 |
| `travel-buddy-standalone/src/features/highlights/__tests__/HighlightLifetimePicker.component.test.tsx` | 1 | inert data | 0 |
| `travel-buddy-standalone/src/features/telegraph/__tests__/inboxTypedPreview.component.test.ts` | 1 | inert data | 0 |
| `travel-buddy-standalone/src/features/trips/closeout/__tests__/TripCloseoutCard.component.test.tsx` | 1 | inert data | 0 |
| `travel-buddy-standalone/src/features/trips/timeline/__tests__/TripTimelineConflictsCard.component.test.tsx` | 5 | inert data | 0 |
| `travel-buddy-standalone/src/hooks/__tests__/useCommunityDiscovery.refusal.component.test.tsx` | 1 | inert data | 0 |
| `travel-buddy-standalone/src/hooks/__tests__/useSearchSuggestions.refusal.component.test.tsx` | 1 | inert data | 0 |
| `travel-buddy-standalone/src/services/__tests__/discovery.refusal.component.test.tsx` | 1 | inert data | 0 |

## DANGEROUS — 4 armed, all found outside the grep, all fixed here

Zero in the 163. Four in the rest of the suite, found by running the WHOLE registered
list under the +400-day clock. All four are the canonical shape — a fixture pinned to
a calendar constant, an assertion judged against the real clock — and all four pass
unshifted today, which is exactly why nothing was looking at them.

Each is fixed by deriving the window from the clock the assertion is judged against.
No constant was moved to a newer date anywhere in this diff.

### `src/test/tripKernelExpansion.test.ts` — detonates 2026-10-05, nineteen days out

The fixture is a trip `start_date: "2026-10-01", end_date: "2026-10-05",
status: "upcoming"`, and `PATCH /trips/:id/settings` asserts the response carries
`status: "upcoming"`. The route echoes what `computeTripStatus` derives, and that
function turns an `upcoming` trip whose `end_date` has passed into `completed`. So
this is `computeTripStatus` claiming a fourth suite, three weeks after it claimed
`tripHealthProjection` — and the file carries no `2026-09-1x` date, so the grep that
went looking for the first three could not see it.

Fixed: the window opens `dayOffset(1)` and closes `dayOffset(5)`, which is
`"upcoming"` on every day, in every timezone.

### `src/test/creatorActivityScore.test.ts` — detonates 2026-11-30

`CreatorSignalAggregator.aggregate` derives `ago24h` / `ago7d` / `ago30d` / `ago90d`
from `Date.now()` and counts every signal inside one of them. The fixtures pinned
`created_at: "2026-09-01T00:00:00Z"`, which leaves the 90-day window on 2026-11-30.
After that the counts read 0 and the assertions — which are about `.in()` chunking
above a 100-id limit — read as "the chunking regressed", which is a worse failure
than a timeout because it is a plausible one.

Fixed: a `recentlyIso(minutesAgo)` helper puts every row inside the NARROWEST window
(24h) on any day the suite runs.

### `src/test/inputAssistanceRankingSignals.test.ts` — detonates 2026-12-10

A Trip window of `2026-12-01`→`2026-12-10` with an out-of-window event at
`2026-10-01` and an in-window one at `2026-12-05`. The suggestion pipeline serves
only events that have not started, so past 2026-12-10 the search returns nothing,
`events.length` is 0 instead of 2, and the §18 G124 demotion test reads as "the
demotion stopped demoting".

Fixed: the window opens in 90 days and closes in 99; the two events keep the only
structure the assertions depend on — the out-of-window one is EARLIER, so it leads
on the search's own `starts_at` ordering and the demotion is a reordering the test
can see. The two assertions that named the constants now name the same derived
values. The one PURE case in that file (`classifyFeasibility` with a literal window
and a literal `startsAt`) is left alone: both sides are constants, so it is SAFE.

### `src/test/discoverySearch.test.ts` — detonates 2027-09-15

A Paris trip "a year out" at `2027-09-12`→`2027-09-15`, with the tripFit
constellation on the 13th. "A year out" has to mean a year out from the clock the
search filters on. Pinned, it returns an empty result set from 2027-09-13, and since
no assertion in that block names a date the failure reads as "tripFit stopped being
attached".

Fixed: `anchorMs()` is `Date.now() + 366 days` and every instant hangs off it,
keeping the relative structure the assertions depend on exactly — day 2 of a
four-day trip, commitment A at 10:00Z, B due 16:00Z ~10 km north, the clashing
event at 15:50Z inside the travel reserved before B, the fitting one at 18:00Z.

### The three from 2026-09-15, re-verified

Fixed at the base commit; re-run here at +400 days in their fixed form and green:

| test | what was pinned | fixed by |
|---|---|---|
| `tripHealthProjection` / `tripStatusInjectedClock` | nothing — the defect was a second clock in `computeTripStatus` | `a97bfdac0` |
| `tripTodayProjection` | a stage `ends_at` of `2026-09-15T23:59` | `a97bfdac0` |
| `TripsTab.playBadge` | a trip window that ended `2026-09-15` | `a97bfdac0` |

**What this sweep does NOT claim.** +400 days is one sample of the future, not all of
it. It lands on a different weekday, month and year from today, which covers the
common shapes, but a fixture that breaks only on a leap day, only in a specific DST
transition, or only when a month is 28 days long would survive both offsets. The
`travel-buddy-standalone` jest component suite was swept over the 26 date-carrying
files rather than all 556, so a bomb in a component file with no `2026-09-1x` date
is the one gap this sweep did not close — the node half of that workspace WAS swept
whole, and was clean. The harness is in this document; running it
at another offset, or over another file list, costs one command.

## SECOND CLOCK — 2 production defects, both fixed here

Both are the `computeTripStatus` shape: a caller that HAS an injected clock reaching
a function that has nowhere to put one. Neither could ever have been caught by a
date in a test, which is why a sweep for `2026-09-1x` alone would have missed both.

They were found by two static passes over the production tree (both scripts are
described below), then confirmed by a test written to fail before the fix.

### 1. `getCrewMap` — the crew map answered on the wall clock inside two injected-clock projections

`artifacts/api-server/src/domain/trips/services/TripCrewLocationService.ts`

Two projection builders take a `now` and thread it into everything they own:

* `buildTripPulseProjection(sc, tripId, viewerId, { now })`
  → `readCrewPresenceForPulse(sc, tripId, viewerId, nowMs)`
* `buildTripTodayProjection(sc, tripId, viewerId, { now })`
  → `readCrewSummary(sc, tripId, viewerId, rows, nowMs)`

Both then called `getCrewMap(sc, tripId, viewerId)`, which had **no clock parameter**,
and which reads the clock twice:

* `.gt("expires_at", new Date().toISOString())` — the live-share grant window, which
  decides whether a card carries **exact coordinates**;
* `buildCrewCard(raw)` — dropping the `now` parameter that function has carried since
  it was written, so every card's `freshnessClass` (LIVE / RECENT / LAST_KNOWN /
  OFFLINE) was judged on the real date.

The second one is the part worth naming. `buildCrewCard` already re-checks the grant
expiry against its `now`, and its own comment makes the argument for this fix in
advance:

> TIME-BOXED MEANS THE BOX IS CHECKED HERE. […] The premise held only because
> TripCrewLocationService filters `.gt("expires_at", now)` in SQL, in a different
> file. A guard whose contract is enforced somewhere else is not a guard.

It got the parameter. The function that calls it did not. That is the same sentence
`computeTripStatus`'s fix had to write about `todayInTimezone`.

**Fix.** `getCrewMap` gains `nowMs: number = Date.now()` — additive, so every call
site that does not pass one is byte-identical. Both clock reads use it. The two
projections pass theirs. `readCrewPresenceLayer` (the map projection's crew layer) is
deliberately left on the default: its only caller is the HTTP route, which has no
injected clock, so the wall clock is the right answer there.

**Guard.** `artifacts/api-server/src/test/tripCrewMapInjectedClock.test.ts`, six cases,
five of which fail without the fix. It asks about two instants that are never the
present — `2019-05-04` and `2031-02-03` — so the wall clock is wrong in BOTH
directions and no single day can make it accidentally green:

* a grant active at the past instant is served (the wall clock calls it expired);
* a position one minute old at that instant is `LIVE` (the wall clock: years old);
* a grant that expired 30 minutes BEFORE the future instant is refused — **this is the
  leaking direction**: on the wall clock that grant is still years in the future, so
  exact coordinates were released under a grant the viewer no longer holds;
* with no clock passed, the answer is the wall clock's, exactly as before;
* the Pulse and the Today builder each read the grant window at their own instant,
  asserted by recording the `.gt("expires_at", …)` argument.

The existing crew coverage could not have caught this: the fake client in
`tripKernelFamiliesWiring.test.ts` ignores `.gt()` entirely, so the window it fakes is
never applied. The new fake honours it.

### 2. `filterEligibleMediaCandidates` — the delayed-publish gate, behind nine injected-clock builders

`artifacts/api-server/src/lib/mediaEligibility.ts`

`publish_at <= now` decides whether a scheduled post has come due. Every media
builder — the six World-shell projections, the experience resolver, the action rail
and §38 search — takes a `nowMs`, stamps its envelope's `generatedAt` from it, and
then reached this filter through `loadEligibleCandidatesOrRefuse`, which had no way
to say which instant the answer was about. So one gate in an injected-clock answer
was decided by the real date.

Nothing went red for this on 2026-09-15, and that is the honest reason it is worth
recording: **no test on this path pins a `nowMs`**. The defect was invisible because
of a gap in coverage, not because it was not there.

**Fix.** `nowMs` is added to `CandidateFilter` and as a defaulted last parameter of
`filterEligibleMediaCandidates`; the choke point `loadEligibleCandidatesOrRefuse`
threads it; the nine builders pass theirs. Additive throughout — the three legacy
`routes/mediaFeed.ts` call sites pass nothing and are unchanged.

**Guard.** `artifacts/api-server/src/test/mediaEligibilityInjectedClock.test.ts`, five
cases, four of which fail without the fix, again at two instants that are never now
and in both directions: a post due an hour AFTER the asked-about instant is withheld
though the wall clock says it is long published, and one due an hour BEFORE it is
served though the wall clock says it is not due yet.

## Observed and deliberately not changed

Each of these was reached by the same scans and judged. They are recorded because
"we looked and decided" and "we did not look" are different states.

| site | why it is not a second clock |
|---|---|
| `lib/media/mediaEvidenceEligibility.ts` `computeFreshnessClass`, `services/memory/historicalTruth.ts` `currentWorldUnknown`, `services/wall/WallDiscoveryInsertionService.ts` `isRecent`, `services/wall/WallRankingService.ts` `newRankSession` | all four are the safe `now ?? Date.now()` idiom: the parameter wins when present |
| `lib/freshnessPolicy.ts` `loadPolicies`, `compass/flags.ts` `getFlags`, `compass/CompassGraphEngine.ts` `learnCityTimezone`, `lib/places/placeDays.ts` `cityTimezone` | cache TTLs and `updated_at` write stamps. The wall clock is the right clock for "how old is this cache entry" |
| `lib/liveIntelligence.ts` `makeConfidence` | stamps `checkedAt` — an audit record of when the read happened, not a decision. Reachable from several injected-`now` engines; changing it would touch dozens of call sites for a metadata field nothing asserts on. **Recorded as a judgement, not as clean.** |
| `domain/telegraph/policies/sendRateLimit.ts` → `lib/rateLimit.ts` `checkRateLimit` | genuinely two clocks — the tier cache uses the injected `nowMs`, the limiter window uses `Date.now()`. Left alone because the limiter's buckets are in-memory and anchored to real elapsed time; injecting a past instant into them is not a meaningful question |
| `lib/weatherCache.ts` `getWeatherContext` | derives its own `today` for an outbound weather query. One clock read per call, deliberately (its own comment says so); the split is with the caller, not inside it |
| `services/airport/LayoverRecommendationService.ts` `readLayoverLive` | false positive — it DOES pass `now` into `readLiveClaimEnvelopes`, in an options object the scanner's argument match missed |
| `routes/tripPostTrip.ts`, `server/trips/readRoutes/tripMapProjection.ts` calling `liveEnvelope()` | HTTP route handlers with no injected clock and no `?at=` parameter. The wall clock is the clock |
| the 18 `travel-buddy-standalone` sites that call a wall-clock-defaulted helper without its `now` | all are screens and hooks (`app/(tabs)/events.tsx`, `app/event/[id].tsx`, `useQuickMedia`, `cityPulseUtils`). A screen IS the clock boundary. No injected-`now` API sits behind any of them |

### Two things found in passing that are NOT clock defects — reported, not fixed

1. **`readCrewPresenceForPulse` can never produce an observation.**
   `artifacts/api-server/src/domain/trips/projections/TripPulseCrewPresence.ts` does
   `map.members.find((m) => m.userId === viewerId)` to get `viewerPoint`, but
   `getCrewMap` excludes the viewer from `allUserIds` by design, so `me` is always
   `null`, `viewerPoint` is always `null`, and the `for` loop always `continue`s.
   The Pulse's `crew_presence` source reports `status: "ok"` with `observations: 0`
   on every trip. It is a real defect and it is not a clock defect, so it is named
   here rather than fixed inside a date sweep. It is also why the Pulse guard above
   asserts on the recorded query argument instead of on the returned observations.

2. **`src/test/wallSessionIntentLiveDb.test.ts` cannot be run here at all.**
   Its `ciSupabaseGuard` refuses before constructing a client when
   `KNOWN_PROD_PROJECT_REF` / `CI_SUPABASE_PROJECT_REF` are unset, which is correct
   and by design. It exits 2 identically at every offset, and it is not in the
   registered `test` list (that carries `wallSessionIntentLiveDbStatus.test.ts`
   instead), so it never runs under `pnpm test`. Named so the sweep's one red file
   is not read as a finding of the sweep — and so that nobody later reads its
   absence from the classification as an oversight.

## The two scans, so this is repeatable

Neither is committed — they are analysis tools, not product code — but the shapes
they look for are worth writing down, because the next second clock will be one of
these two:

1. **Transitive.** A function with a clock parameter that calls, through resolved
   imports, a function with NO clock parameter that reaches `Date.now()` /
   `new Date()`. 34 candidate edges across 1,119 files; all triaged above. This is
   the `computeTripStatus` shape.
2. **Unpassed default.** A call to a function whose clock parameter is DEFAULTED to
   the wall clock (`now: number = Date.now()`), made without that argument. 24 sites
   in `api-server`, 18 in `travel-buddy-standalone`; exactly one —
   `getCrewMap` → `buildCrewCard(raw)` — sat under a caller with an injected clock.
   This is the shape a fix like `computeTripStatus`'s CREATES if the parameter is
   added and the call sites are not updated, which makes it the one to re-run after
   any such fix.

## What a reviewer should check

* The two guards fail if the production functions reach for the wall clock again.
  Revert either fix and the counts go 5-of-6 and 4-of-5 red.
* Neither fix changes behaviour for a caller that passes no clock. Both suites
  include that case explicitly.
* No test was deleted, skipped or `.skip()`-ed, and no constant was moved to a newer
  date. Every one of the four fixture fixes replaces a constant with an expression
  over `Date.now()`; none introduces a date literal.
* The cheapest way to keep this true is to run the suite once at an offset in CI —
  the same `--import` preload, one extra job, no change to any test.
