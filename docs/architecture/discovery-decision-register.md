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

## W10-O — outcomes, telemetry product rules, stop conditions

*Lane W10-O, branch `disc-w10-o-outcomes`, 2026-09-28. Census section: `docs/architecture/census-discovery.md` §82. Nothing below is applied to `portava-ci` or production, deployed, or flag-enabled.*

### D-W10-O-1 — the seven stop-condition halt values (DV-82, DC-32; A-5)

- **The question.** `docs/specs/discovery-v1/12_Claude_Code_Implementation.md:206#Stop conditions`: "Stop rollout if: event rejection rises, recommendation logging gaps appear, creator concentration spikes, reports/hides increase materially, cache bypass reappears, RLS leaks occur, attribution double-counts." Census §54.13 Q1: *"For each, what value halts the rollout, over what window, and on how much evidence?"*; Q2: *"Do you ratify the enforced values — a 5 % event-rejection rate, a 10 % logging gap, a 20-attempt floor and a 10-minute window — or replace them?"*
- **Options considered.**
  - (a) Leave five unruled: they are measured and can never halt, so `12`'s stop is 2 of 7 in effect.
  - (b) Relative thresholds (×N a trailing baseline): no baseline exists, because production has never run the ranked path (§48.1). A relative rule over no baseline cannot fire, or fires on noise.
  - (c) Absolute conservative values, one window, each a named config value, armed by a flag seeded FALSE. **Chosen.**
- **Decision and rationale.** No spec and no ROADMAP step gives a number for any of the seven (ROADMAP has none; `12` gives verbs). A trip can only move a request to `legacy`, which is what production already serves, so a false halt costs a paused rollout and a missed halt costs a user-facing defect. So the values err toward halting:

  | condition | halts when | minimum evidence | named value |
  |---|---|---|---|
  | `event_rejection_rate` | > 0.05 of serve-log insert attempts | 20 attempts | `EVENT_REJECTION_RATE_THRESHOLD`, `STOP_MIN_SAMPLE` (kept from §12.5) |
  | `recommendation_logging_gap` | > 0.10 of served items | 20 attempts | `LOGGING_GAP_THRESHOLD` (kept) |
  | `creator_concentration` | HHI > 0.25 | 100 resolved exposures | `CREATOR_CONCENTRATION_HHI_THRESHOLD`, `CREATOR_CONCENTRATION_MIN_RESOLVED` |
  | `reports_hides` | (dismisses + place reports + Trail reports) / exposures > 0.05 | 100 exposures | `REPORTS_HIDES_RATE_THRESHOLD`, `REPORTS_HIDES_MIN_EXPOSURES` |
  | `cache_bypass` | any bypass (share > 0) | 1 owed rank | `CACHE_BYPASS_SHARE_THRESHOLD`, `CACHE_BYPASS_MIN_OBLIGATIONS` |
  | `rls_leak` | any deviation from 3390's posture | 1 catalogue read | `RLS_LEAK_DEVIATION_THRESHOLD`, `RLS_LEAK_MIN_SAMPLE` |
  | `attribution_double_count` | any live double count | 1 attribution | `ATTRIBUTION_DOUBLE_COUNT_THRESHOLD`, `ATTRIBUTION_DOUBLE_COUNT_MIN_SAMPLE` |

  One window for all seven: `STOP_WINDOW_MS`, 10 minutes (kept). HHI 0.25 is "more concentrated than four creators sharing the page equally", the classic "highly concentrated" line on the 0–1 scale. "Reappears", "occur" and "double-counts" name events, so any one halts. The two §12.5 values are kept because their healthy value is 0 and nothing measured argues for another.
- **Reversibility.** Every value is a named constant in one file, and the set carries a version (`STOP_ENFORCEMENT_VALUES_VERSION` = `stop-values-2026-09-28.1`) that a test pins to the values. Disarming is `UPDATE feature_flags SET enabled = false WHERE flag = 'discovery_stop_enforcement_enabled'`; the next non-legacy resolution reads it. Nothing is lost: a trip is evidence in memory that ages out in 10 minutes.
- **Where it is implemented.** `artifacts/api-server/src/lib/discoveryStopConditions.ts` (`ARMED_STOP_CONDITION_RULINGS`, `refreshStopEnforcement`, the §82 block at the foot), the caller `artifacts/api-server/src/lib/discoveryStopMeasurements.ts` (`refreshDiscoveryStopMeasurements` reads the arming flag), migration `3470_discovery_stop_enforcement_flag.sql` (flag `discovery_stop_enforcement_enabled`, seeded FALSE) and its rollback. Tests: `src/test/discoveryStopEnforcement.test.ts` G1–G7; `src/test/discoveryStopSevenConditions.test.ts` (unchanged, flag off).

### D-W10-O-2 — an unreadable stop measurement halts, when armed (DV-82; §54.13 Q3)

- **The question.** §54.13 Q3: *"When a stop measurement cannot be read (3391 unapplied, or the database refuses), should the rollout halt, or report `unreadable` and continue as it does today?"*
- **Options considered.** (a) Continue: a stop that cannot see lets the rollout proceed blind. (b) Halt: the rollout pauses until the instrument can see again. (c) Halt only after N consecutive unreadable reads: needs a second state machine for no stated gain.
- **Decision and rationale.** (b), and only when armed, and only for the four database conditions. The halt resolves to legacy, which is safe. Arming is recommended only with 3391 applied (D-W10-O-3), so "unreadable" then means a real failure rather than a missing function. `stale`, `no_evidence` and `input_absent` still do not halt: the first refresh after a restart is `no_evidence`, and `input_absent` (no `creator_attributions`) means no double count can exist. `STOP_UNREADABLE_HALTS_WHEN_ARMED = true`.
- **Reversibility.** One constant. Nothing is lost.
- **Where it is implemented.** `lib/discoveryStopConditions.ts` (`haltsOnUnreadable`, the `tripped` filter). Tests: G4a–G4c.

### D-W10-O-3 — APPROVAL REQUIRED: arm the stop conditions in production

- **Recommended action, exactly.** In this order, on production (`ajrurzioarfkagpuxfnb`), after this tree is merged and deployed:
  1. Apply `3390_discovery_rls_explicit_policies.sql` and `3391_discovery_stop_condition_measurements.sql` (3391 depends on 3390's posture for `rls_leak`).
  2. Apply `3470_discovery_stop_enforcement_flag.sql` (seeds `discovery_stop_enforcement_enabled` FALSE; refuses to commit it ON).
  3. Read the baselines once, read-only, before arming (census §82.8 has the SQL): the HHI of Discovery exposures and the (dismiss + report) share over the last 7 days. If either is already above its value (0.25, 0.05), arming would keep PDE on legacy from the first minute; decide whether that is wanted before step 4.
  4. `UPDATE public.feature_flags SET enabled = true, metadata = jsonb_build_object('values_version', 'stop-values-2026-09-28.1') WHERE flag = 'discovery_stop_enforcement_enabled';`. The row must name the values version: arming reads DISARMED unless `metadata.values_version` equals `STOP_ENFORCEMENT_VALUES_VERSION`, so an approval arms exactly the values it approved, and a later change to any value (which must bump the version) needs a new approval.
  5. The values armed are exactly D-W10-O-1's table, with D-W10-O-2.
- **If approved.** In shadow or PDE mode, any of the seven over its value, or an unreadable measurement, resolves Discovery to legacy (`reason: stop_condition`) for the 10-minute window, and the reading says which. In legacy mode (production today) nothing changes, because the resolver never evaluates stop conditions on legacy.
- **If declined.** Flag-off behaviour stays exactly as now: two unratified thresholds enforced, five measured and reported `unruled`. `12`'s stop stays 2 of 7 in effect, and DV-82 stays `W`.
- **Recovery.** `UPDATE public.feature_flags SET enabled = false WHERE flag = 'discovery_stop_enforcement_enabled';` takes effect at the next non-legacy resolution (at most one 30-second resolver cache period). The row itself is removed only by `db/rollback/2026-09-28-3470-discovery-stop-enforcement-flag-rollback.sql`, which refuses while the flag is TRUE.

### D-W10-O-4 — §47.8's silent production defaults (DC-32; E-3)

- **The question.** `docs/specs/upgrades-v2/02-DISCOVERY-v2.md:42#Existing Ranker and Event Truth holds are`: *"reuse approved weights, exploration budgets, sensitive-location policy, freshness and thresholds; ask rather than choose silent production defaults."* §47.8: *"rule each value, or mark it PROVISIONAL with a review date."*
- **Options considered.** (a) Leave them unruled (the finding stands). (b) Change them now: nothing measured says any is wrong, and changing a served value without evidence is the thing the clause forbids. (c) Rule each as PROVISIONAL at its current value, with a review date and the evidence that would move it, and pin the code to this table. **Chosen.**
- **Decision and rationale.** Every value below is ruled **PROVISIONAL, review by 2027-03-31 or at the first production outcome judgement (D-W10-O-10), whichever is first.** None is changed.

  | value | ruled | what would move it |
  |---|---|---|
  | `CACHE_B_TTL_MS` | 10 min | a production read of how often a replayed page is revoked (`row_revoked`) |
  | `CACHE_TTL_MS` (routes/discovery.ts) | 2 h | provider cost against a measured freshness complaint rate |
  | `SEEN_WINDOW_MS`; `seenPenalty` | 24 h; −0.6 | the judgement's `useful_saves` per serve point with and without the demotion |
  | `MIN_TOTAL_CATEGORY_OBSERVATIONS` | 3 | taste stability over a production cohort |
  | stop values | D-W10-O-1 | D-W10-O-1 |
  | `TREND_MIN_RATE`; growth; decline | 3; ×1.5; ×0.6 | a labelled sample of trending calls against reports |
  | `TRAVEL_HORIZON_MINUTES`; `DEFAULT_QUEUE_TOLERANCE_MINUTES`; `LIVE_RANK_MAX_POSITIONS` | 45; 30; 15 | the live-rank layer's first production reads |
  | `authorPenalty`; `kindPenalty` | 0.35; 0.15 | `creator_diversity` in the judgement |

  The ruled values stay out of the sensitive-location leg: that is 3366 (A-3, B04), another lane's.
- **Reversibility.** A new register entry and a one-line code change per value; the pin test fails until both agree.
- **Where it is implemented.** No served value changed. `src/test/discoveryRulingsPinned.test.ts` R1 reads each value from the code and fails when it drifts from this table.

### D-W10-O-5 — keyless outcomes from shipped builds (DV-37; D-9, §62.7 Q1)

- **The question.** §62.7 Q1, as §69.1 records it: *"keyless outcomes (DV-37, §62.7 Q1)"* — every build shipped before §62's H1 sends outcomes with no `client_event_id`; a keyless retry after a second serve moves a second exposure (`src/test/db/discoveryVerifyChain.db.test.ts` V7d).
- **Options considered.**
  - (a) Server-minted key: minted per request, so a retry gets a new one. It identifies nothing, and makes an unkeyed outcome look keyed.
  - (b) Refuse keyless outcomes: every outcome from every shipped build is lost ("Not interested", opens, saves, trip adds) until the keyed build is the floor. That is right only once the keyed build is the oldest supported one, which is a release decision.
  - (c) Accept, marked unkeyed, with the retry bounded on the natural key. **Chosen.**
- **Decision and rationale.** A keyless outcome is accepted and leaves `outcome_client_event_id` NULL, and that NULL is the mark (3420's column). A keyless outcome that would move a SECOND exposure of the same (viewer, item, surface[, session]) is answered `{ ok: true, duplicate: true }`, and moves nothing, when the same outcome, or one that subsumes it, landed on another exposure of that key within `KEYLESS_OUTCOME_RETRY_WINDOW_MS` = 10 minutes. `04` §3 asks every event write to be "idempotent where retried". Ten minutes is a user-driven retry inside one visit. It is also `CACHE_B_TTL_MS`: inside it, a second serve of the item is most likely the same ranked page replayed. The cost: a genuine repeat of the same act on a new serve inside 10 minutes counts once. That cannot happen for `dismiss`, because a dismissed place is filtered from every serve path. For taps it under-counts, which is the lesser error than V7's double negative signal. A keyed request never takes this path.
- **Reversibility.** The rule is one appended function reached from two lines of the handler. Removing it restores the pre-§82 behaviour. Nothing is lost: a retry answered `duplicate` changed nothing.
- **Where it is implemented.** `artifacts/api-server/src/routes/rankEvents.ts` (`readKeylessOrUpgradable`, `keylessLandingOutcomesFor`, `KEYLESS_OUTCOME_RETRY_WINDOW_MS`). Tests: `src/test/discoveryKeylessOutcome.test.ts` L1–L8; restated: `discoveryKeyedOutcome.test.ts` K2, `rankEventsTripAddOutcome.test.ts` "selects exactly the list", `db/discoveryVerifyChain.db.test.ts` V7d.

### D-W10-O-6 — `hide` vs `not_interested` on Discovery (DV-78; E-8)

- **The question.** `04` §4's Negative list names both `hide` and `not_interested` and defines neither; census §48 DV-78: *"`hide` vs `not_interested` … are not defined by the spec — owner input."*
- **Options considered.** (a) Two controls: "Hide" (this place only, no inference) and "Not interested" (a taste negative). On a PLACE card the two acts are indistinguishable to the viewer. The taste half would feed the ranker, which is held here (and `routes`/ranker files belong to other lanes). (b) One control that records both names as one act. **Chosen.**
- **Decision and rationale.** On Discovery, `hide` ≡ `not_interested`: one control ("Not interested"), one token (`dismiss`), one analytics event (`ranking_item_hidden`, the constant `rankingAnalytics.ts` already maps both `dismiss` and `hide` to). It removes the item for that viewer (`lib/discoveryDismissed.ts`) and feeds the cross-viewer negative statistic. It is not a category-level taste signal. The §12 "hide rate" is the dismiss rate. `hide` remains a distinct act on surfaces that show authored content (the Wall).
- **Reversibility.** A second control could be added later with its own token. The existing rows keep their meaning.
- **Where it is implemented.** `lib/discoveryOutcomeReport.ts` (`dismiss_rate` is the hide rate). Tests: `discoveryOutcomeJudgement.test.ts` J1; `discoveryOutcomeReport.test.ts` O4 (restated); `discoveryNegativeFeedbackSeparation.test.ts` N1.

### D-W10-O-7 — the `immediate_skip` threshold (DV-78)

- **The question.** `04` §4 lists `immediate_skip` first among Negative events, with no threshold (DV-78: *"the threshold for `immediate_skip` [is] not defined by the spec"*).
- **Options considered.** (a) A card scrolled past: needs list viewability, which the list does not report, and is itself dwell collection on the card (§55.10 Q4, B-1). (b) An opened detail sheet left almost at once, derived downstream from the dwell rows (`04` §8: "Sequence features should be derived downstream rather than hard-coded into clients"). **Chosen.**
- **Decision and rationale.** An exposure is an immediate skip when its furthest outcome is `tap` (opened, nothing stronger) and its FOREGROUND dwell (active + passive_foreground, summed across emissions) is below `IMMEDIATE_SKIP_MAX_FOREGROUND_MS` = **2 000 ms**. Idle time never lengthens a view. The sheet animation takes a few hundred ms and reading the name and first line about a second more, so under 2 s the viewer left before reading. It is a measurement, not a ranking input. It exists only where dwell is collected, so it waits on D-W10-O-9.
- **Reversibility.** One constant. Nothing is collected by it.
- **Where it is implemented.** `artifacts/api-server/src/lib/discoveryDwellSkip.ts`. Tests: `src/test/discoveryDwellSkip.test.ts` S1–S5.

### D-W10-O-8 — dwell's interaction window, passive dwell, and the card (DV-41; §55.10 Q2–Q4)

- **The questions.** §55.10 Q2: *"How long after a viewer's last touch does foreground time still count as ACTIVE dwell?"* Q3: *"Is passive-foreground dwell … ever an interest signal?"* Q4: *"Should dwell also be measured on the place CARD?"*
- **Decision and rationale.**
  - Q2: **10 seconds**, ratified at the current `DWELL_INTERACTION_WINDOW_MS`. A detail sheet is read in bursts between touches, and 10 s covers one screenful at reading speed.
  - Q3: **No.** Only `active` is interest. `04` §4 names `active_dwell` alone, and §7 says "Do not infer interest from a phone sitting untouched".
  - Q4: **Not now.** Card dwell needs list viewability and is new collection on a second surface, so it belongs in the consent request (D-W10-O-9), not in a product rule.
- **Reversibility.** Q2 is one client constant. Q3 is `dwellCountsAsInterest`.
- **Where it is implemented.** No code changed. `travel-buddy-standalone/src/services/discoveryDwell.ts` `DWELL_INTERACTION_WINDOW_MS` and `artifacts/api-server/src/lib/discoveryDwellVocabulary.ts` `dwellCountsAsInterest` already hold the ruled values, pinned by `src/test/discoveryRulingsPinned.test.ts` R3.

### D-W10-O-9 — APPROVAL REQUIRED: dwell collection (DV-41, DV-78 dwell; B-1)

This is consent, which is not delegated. Nothing here turns collection on.

- **What is collected, exactly.** For a SIGNED-IN viewer, on the Discovery place DETAIL SHEET only, for a place served to them on surface `discovery` with a served id:
  - milliseconds of `active` (app in the foreground, touched within the last 10 s), `passive_foreground` (foreground, untouched past 10 s) and `idle` (backgrounded, screen off, or iOS inactive) time;
  - written as `rank_events` rows (`event_type 'place_dwell'`, `outcome 'analytics'`, `dwell_ms`, `dwell_kind`), one per kind per emission, with the viewer's user id, the place id and the served `recommendation_id`, `privacy_class` `raw_recent`.
  - Not collected: anything while signed out, anything on the list or the card, location, content of the screen, or other apps.
- **Consent wording needed (recommended, for the privacy notice and the in-app disclosure).** *"When you open a place from Discovery, Portava records how long the place stays open on your screen and whether you were interacting with it, so that recommendations can learn what you actually read. This is linked to your account. It is not collected when you are signed out, and it is never used to infer interest when your phone is idle."* Where the owner's consent model requires opt-in, the flag must be read together with that opt-in. This lane did not build an opt-in, because the consent model is the owner's.
- **Recommended action, exactly.** After the wording is published and a retention horizon is set (`04` §11: *"Exact retention must be decided with privacy/legal review"*; also not delegated): apply `3395_discovery_dwell_telemetry_flag.sql` to production, then `UPDATE public.feature_flags SET enabled = true WHERE flag = 'discovery_dwell_telemetry_enabled';`. The rules that then apply are D-W10-O-8's.
- **If approved.** Dwell rows are written for signed-in Discovery detail-sheet views. `immediate_skip` (D-W10-O-7) becomes measurable. DV-41 can reach `C` on production rows.
- **If declined.** Nothing is collected. The route answers 404 `feature_disabled` and the client sends nothing. DV-41 and DV-78's dwell leg stay `W`.
- **Recovery.** Set the flag FALSE; collection stops at the next flag read (client and server). Deleting rows already written is a retention decision (`04` §11), and the 3395 rollback deliberately does not do it.

### D-W10-O-10 — what "improves" means (DV-19; D-3, §55.10 Q6)

- **The question.** §55.10 Q6: *"For each `01` §12 item, what difference between the PDE and legacy arms, over what sample, counts as 'improves'? And is 'new-creator discovery' about creators new to the viewer or new to the platform?"*
- **Options considered.** (a) Pooled arms with a raw-lift threshold: the arms are observational and serve points are not like for like, so a pooled lift measures the mix. (b) A per-serve-point significance rule with a minimum effect and guardrails. **Chosen.** (c) Leave it the owner's: then DV-19 cannot be judged by anyone.
- **Decision and rationale.**
  1. Per serve point, never pooled.
  2. Both arms need `OUTCOME_MIN_SAMPLE_PER_ARM` = 1 000 units of the metric's own denominator.
  3. A rate differs only when the two-proportion z reaches `OUTCOME_Z_CRITICAL` = 1.96 (two-sided 95 %) AND the relative change is at least `OUTCOME_MIN_RELATIVE_CHANGE` = 0.05. For the funnel's bounded items, BOTH the lower and the upper bound must agree.
  4. Creator diversity (an HHI) differs by `CREATOR_HHI_MIN_RELATIVE_CHANGE` = 0.10 relative.
  5. `improves` iff an INTENT item (useful saves or itinerary additions) improves at some serve point AND no measured item worsens at any. `01` §12: "Raw engagement may rise or fall; it is not the sole acceptance criterion", so place opens alone never suffice.
  6. New-creator = **new to the platform**: first Discovery submission within `NEW_CREATOR_WINDOW_DAYS` = 30 days before the exposure. `01` §1 ("gives new creators fair exploration") and §10 ("suppress new creators solely due to low history") are about creators with little history, not about the viewer.
  7. "Successful trip actions" = an itinerary item from a Discovery exposure that the trip carries out. No Trips plan-item projection reaches Discovery (E-7), so it is unmeasured, and so are completed visits, event attendance, Trail freshness and repeat traveler satisfaction. Each is named, never 0.
- **Reversibility.** Every value is a named constant. The rule is a pure function kept apart from the numbers, so changing it re-judges without re-reading.
- **Where it is implemented.** `artifacts/api-server/src/lib/discoveryOutcomeReport.ts` (`judgeOutcomeImprovement`, the enrichment, the named values), `src/scripts/reportDiscoveryOutcomes.ts` (prints it). Tests: `src/test/discoveryOutcomeJudgement.test.ts` J1–J7.

### D-W10-O-11 — regret, hide and report (DV-19; §55.10 Q7)

- **The question.** §55.10 Q7: *"Is the card's 'Not interested' dismissal the §12 'regret' or 'hide' signal, or must regret be measured separately (for example, a dismissal after a save)?"*
- **Decision and rationale.** Three rates:
  - **hide** is the dismiss rate (D-W10-O-6);
  - **report** is the share of an arm's exposures of a reportable (community) place that the viewer reported (`discovery_place_reports`) within `REPORT_ATTRIBUTION_WINDOW_DAYS` = 7 days after the exposure;
  - **regret** is the share of positive outcomes (tap or stronger) whose item the same viewer dismissed on a LATER exposure within `REGRET_WINDOW_DAYS` = 30 days.

  A dismissal on the same exposure after a save cannot exist, because `dismiss` is recorded only against an impression. So "acted on it, then waved it away next time" is the regret the funnel can see. All three are lower-is-better guardrails in D-W10-O-10. The read joins the viewer's id inside the database and projects none, and the creator leaves only as `md5`.
- **Where it is implemented.** `OUTCOME_ENRICHMENT_SQL`, `readOutcomeEnrichment`. Tests: J3, J6; harness: `src/test/db/discoveryOutcomeEnrichment.db.test.ts`.

### D-W10-O-12 — reason labels and the confidence priors (DC-22; E-1)

- **The question.** §35.4: *"whether `0.8 / 0.6 / 0.4 / 0.2` are the right per-class confidence priors to put in front of a user"*; `11` §5 lists "reason labels" among the Recommendation API's outputs.
- **Options considered.** (a) Replace the priors with measured calibration: nothing measures calibration yet (Event Truth is ROADMAP work). (b) Ratify them as class priors, monotone in evidence, labelled as priors. **Chosen.** (c) Withhold confidence from the client: the spec forbids rendering prediction as fact, and a labelled prior is the honest form of it.
- **Decision and rationale.** `CONFIDENCE_PRIOR` is ratified: corroborated 0.8, observed 0.6, stale 0.4, unknown 0.2. It is PROVISIONAL until a calibration exists, and it is replaced only by one. Reason labels are the grounded `01` §11 codes with their plain-language text (`lib/discoveryReasonCodes.ts`), delivered on the `DiscoveryCandidate` projection behind 2361. §35.4's deploy-ordering blocker (`discoveryLiveRank.ts` branch-only) no longer holds: the module is in this tree.
- **Where it is implemented.** No code changed. `src/test/discoveryRulingsPinned.test.ts` R2 pins the priors to this entry.

### D-W10-O-13 — APPROVAL REQUIRED: reason labels to clients (DC-22; 2361)

- **Recommended action, exactly.** After this tree is merged and deployed to production: `UPDATE public.feature_flags SET enabled = true WHERE flag = 'discovery_candidate_projection_enabled';`. 2361 is already applied in production at `false` (§35.4). Then verify at runtime: one `GET /api/discovery` page, signed in, whose items carry `discoveryCandidate.reasons` with non-empty `text`.
- **If approved.** Every Discovery page item carries the projection: truth class, confidence prior, freshness and reasons. DC-22 can reach `C` on that runtime check.
- **If declined.** Served JSON stays byte-identical to today, and DC-22 stays at 4 of 5.
- **Recovery.** Set the flag FALSE. `withDiscoveryCandidates` returns the same array reference again at the next flag read (30-second cache). Nothing is persisted.

### D-W10-O-14 — APPROVAL REQUIRED: 2893 in production (DV-44; E-4)

- **Recommended action, exactly.** Apply `artifacts/api-server/src/migrations/2893_rank_events_retire_writerless_surfaces.sql` to production as written, in its own transaction (the file carries `BEGIN`/`COMMIT`), and record its ledger row. It narrows `rank_events_surface_check` from fifteen labels to eight: it retires `search`, `nearby`, `story`, `event`, `trip`, `profile` and `explore`, and keeps `pulse`, `discovery`, `events`, `compass`, `live_pulse`, `living_page`, `watch_feed` and `wall`.
- **Dependencies.**
  - 2298 must be in force (production admits the fifteen labels: census row DV-44, §48). The file refuses otherwise.
  - Zero rows may carry a retired label. The file counts them and aborts with the counts otherwise.
  - The code already writes only the eight (`src/test/discoverySurfaceWriterProof.test.ts`).
  - Pre-flight, read-only: `SELECT surface, count(*) FROM public.rank_events GROUP BY 1 ORDER BY 1;` and `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'rank_events_surface_check';`.
- **If approved.** A write on a retired label is refused with 23514, and the existing rejection counter names the constraint. Today no writer exists for any of the seven. The risk grows with time: a future writer on one of the seven loses rows until the reversal (the file's own "WHAT REVERSING THIS COSTS").
- **If declined.** The seven stay admitted and writerless. DV-44 stays `W`, with the retirement in force in code only.
- **Recovery.** The reversal in 2893's header restores the post-2298 fifteen, a strict superset, so it cannot fail on an existing row:

  ```sql
  BEGIN;
  ALTER TABLE public.rank_events DROP CONSTRAINT IF EXISTS rank_events_surface_check;
  ALTER TABLE public.rank_events ADD CONSTRAINT rank_events_surface_check
    CHECK (surface = ANY (ARRAY['pulse','discovery','events','compass','search','nearby','story','event','trip','profile','explore','live_pulse','living_page','watch_feed','wall']::text[]));
  COMMIT;
  ```

  Rows refused in between cannot be recovered.

### D-W10-O-15 — APPROVAL REQUIRED: the keyless-outcome rule and 3420 in production (DV-37)

- **Recommended action, exactly.** Deploy this tree (D-W10-O-5 has no flag: it is a correctness rule of the outcome route). Apply `3420_rank_events_outcome_receipts.sql` to production (§62; A-1 covers `portava-ci` first). Ship the keyed client build (§62.7 H1, built in §63) and make it the oldest supported build.
- **If approved.** Keyed outcomes land once on their receipt, and keyless outcomes from older builds land once within 10 minutes, marked by a NULL key. DV-37 can reach `C` once production shows the receipts.
- **If declined.** The route keeps today's behaviour in production: without 3420 every outcome is recorded keyless, and a keyless retry after a second serve double-counts.
- **Recovery.** Revert the deploy (the rule is code only). 3420's rollback is `db/rollback/2026-09-27-3420-rank-events-outcome-receipts-rollback.sql`.
