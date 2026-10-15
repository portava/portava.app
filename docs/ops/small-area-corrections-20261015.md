# Small-area integration evidence — 2026-10-15

## Boundary and provenance

Delivery: `/Users/areyouok/portava-sandbox/wt-codex-small-area-delivery-20261015`, branch
`codex/small-area-corrections-20261015`, exact HEAD `5b2a20fdaaafb6805467b4284ae2ac2e63ccdf70`.
Worker bases `5fad1c98c91bc783b2a12cefbb759f61e4d190f7` have the same tree, not the same commit.
The current delivery diffs and reports were read; no reset, branch, commit, push, network, database,
migration, flag, provider request or dependency installation was performed by this evidence pass.
Parent/worker implementation and test edits are not edits by this documentation lane.

This is **bounded correction evidence, not a full recensus or deployment certification**. Existing
`head_commit` declarations and grades are unchanged. Previously integrated Passport §37 and its
operations report are preserved; only displaced Passport citation anchors were corrected here.
Freshness reasons are appended narrowly, preserving every earlier reason verbatim. Untouched
historical assertions, dated live measurements and worker-reported results are not newly verified.

## All 43 assigned rows remain W

| Area | Exact assigned IDs | Remaining requirements after the bounded fixes |
|---|---|---|
| Wall (1) | W71 | Native deferred-start cancellation/terminal-event correctness, reviewed privacy-safe contract/integration, owner approval, native builds and real locale/API-level/device proof. JS lifecycle safety alone is insufficient. |
| Passport (3) | P42, P61, P77 | Respectively: Discovery ranker hold/authorized scope; complete four-gate deployment and protected-place evidence; authoritative consent-bearing Passport-to-Memory association and People consumer. |
| Compass (12) | CX-03, CX-05, CX-11, CT-02, CT-08, CT-09, CPH-01, CPH-08, CPH-EVAL, CCL-01, CCL-05, CPV2-03 | Typed multi-trip/count/roster migration for CT-02; authorized schema/flag/provider rollout and enabled-path/model evidence elsewhere; historical evaluation/sequence gaps cannot be manufactured now. |
| Sensing (13) | S18, S19, S24, S26, S32, S39, S49, S66, S92, S97, S111, S112, S118 | Split-consent legal/grant/pepper/release proof, coordinated identity/nullable-subject cutover, publication/surface/retention/session-memory prerequisites and genuine contribution/erasure/device evidence. OD-MAP-7 already answers retention policy. |
| Trust (14) | A6, TV-P2, TV-P3, TV-0a, TV-0e, TV-1c, TV-2c, TV-4a, TV-4b, TV-5a, TV-5b, TV-6b, TV-U1, TV-P0 | Real eligible stamp/provider/badge proof; owner-controlled target schema/activation; DOB/retention/subject-link/scoring rulings; audited content removal, account-auth/appeal-target/client journey, approved community guidelines and privacy-safe eligibility preview. |

No row is promoted to C; every existing C grade is unchanged. Census additions: Compass §59, Sensing §36, Trust §43, Wall §25 and
Input Intelligence §47. The original Passport §37 is the Passport correction, not a new claim here.

## Admitted implementation and exact changed tests

Paths below are repository-relative. These changes were read, not authored by this evidence lane.

### Passport

- No production change: P61's activation inventory now names both upstream hidden-gem gates plus
  the existing Passport side-effect and Place-stamp gates. P42/P61/P77 are still blocked as above.
- Test: `artifacts/api-server/src/test/passportPlaceStamp.test.ts`.
- Existing integrated evidence: `docs/architecture/census-passport.md` and
  `docs/ops/passport-small-corrections-20261015.md`.

### Compass

- Sources: `artifacts/api-server/src/compass/CompassCurrentTrip.ts` and
  `artifacts/api-server/src/domain/trips/projections/TripCompassProjection.ts`.
- Non-array membership/owned/member-trip/plan rowsets take existing unread outcomes; readable
  empty arrays remain empty. No authorization, selection, cap, ranking or wire-contract change.
- Test: `artifacts/api-server/src/test/compassTripProjectionReads.test.ts`.

### Sensing

- Sources: `artifacts/api-server/src/scripts/auditMigrationsVsLive.ts`,
  `artifacts/api-server/src/scripts/checkMissingLiveColumns.ts`,
  `artifacts/api-server/src/scripts/lib/sensingPostureOnDisk.ts`.
- The 2481 exemption requires established `anonymous_capable`; missing/unknown posture grants
  nothing. The negative helper is removed; policy/import graph/parser remain unchanged. This is
  never permission to apply 2481. The database-backed auditors were not executed.
- Test: `artifacts/api-server/src/test/sensing2481AuditReconciliation.test.ts` executes the extracted
  audit predicates in a VM instead of importing their database entry points.

### Trust

- Server: `artifacts/api-server/src/lib/restrictedAccountAccess.ts` adds only the exact modern
  safety-report POST exception, preserving auth-service/account-state refusal and neighboring routes.
  `artifacts/api-server/src/routes/follows.ts` projects existing flag-gated current badges only for
  final admitted traveler IDs; no raw identity facts, ranking or legacy-boolean change.
- Server tests: `artifacts/api-server/src/test/restrictedAccountAccess.test.ts`,
  `artifacts/api-server/src/test/moderation.test.ts`,
  `artifacts/api-server/src/test/identityVerifiedBadges.test.ts`.
- Client sources: `travel-buddy-standalone/src/services/follows.ts`,
  `travel-buddy-standalone/src/components/TravelerRow.tsx`,
  `travel-buddy-standalone/src/components/interaction/UserNameButton.tsx`,
  `travel-buddy-standalone/src/components/events/EventAttendancePanel.tsx`,
  `travel-buddy-standalone/app/profile/edit/safety.tsx`, `travel-buddy-standalone/app/appeals.tsx`.
- These carry optional server badges through existing identity links, add existing verification and
  no-context SOS destinations, and distinguish unread appeal history from empty history. No new
  emergency number, outbound call, inferred location, consent, account-appeal target or policy.
- Client tests: `travel-buddy-standalone/src/components/__tests__/TravelerRow.identityBadge.component.test.tsx`,
  `travel-buddy-standalone/src/components/events/__tests__/EventAttendancePanel.identityBadge.component.test.tsx`,
  `travel-buddy-standalone/app/profile/edit/__tests__/safety.trustSheet.component.test.tsx`,
  `travel-buddy-standalone/app/__tests__/appeals.restrictions.component.test.tsx`.
- Final integrated client sources: `travel-buddy-standalone/src/components/interaction/UserIdentityLink.tsx`,
  `travel-buddy-standalone/src/components/passport/PassportIdentityCard.tsx`,
  `travel-buddy-standalone/src/components/BuddyCard.tsx`,
  `travel-buddy-standalone/src/components/ReviewsSection.tsx`.
- Final test: `travel-buddy-standalone/src/components/__tests__/IdentityBadgeSurfaces.navigation.component.test.tsx`.
  Existing badge/name pairs move inside the shared wrapper without changing badge authority/size.
  Buddy's optional callback preserves its existing listing route, stops propagation before the
  disabled/block checks and invents no handle. Own names route through Passport; anonymous reviews
  stay anonymous. Nonidentity controls and body-report targeting remain separate. Mounted assertions
  do not certify physical responder/layout/accessibility behavior or whole-card access control.

### Wall / shared voice

- Sources: `travel-buddy-standalone/src/platform/input-assistance/voice/speechRecognizer.ts`,
  `travel-buddy-standalone/src/platform/input-assistance/hooks/useVoiceDictation.ts`,
  `travel-buddy-standalone/src/features/wall/components/WallPushToTalk.tsx`.
- Module serialization lasts through `end`; aborted permission never starts capture; failed start
  removes listeners; capability receives selected language. The hook rejects superseded/unmounted
  callbacks but accepts the current final result after normal stop. Wall disable/background/inactive
  ends a hold; return/enable does not restart it. Cleanup removes the app-state listener.
- Tests: `travel-buddy-standalone/src/platform/input-assistance/voice/__tests__/speechRecognizer.test.ts`,
  `travel-buddy-standalone/src/platform/input-assistance/voice/__tests__/voiceDictation.component.test.tsx`,
  `travel-buddy-standalone/src/features/wall/components/__tests__/WallPushToTalk.component.test.tsx`.

**EXCLUDED: native dependency/bootstrap/plugin/vendor patch.** Parent review reports unpatched
3.1.3 default-locale capability on iOS rather than selected locale, and Android API31/32 support
reporting while local-recognizer selection begins only on API33+. This pass did not reproduce the
vendor/device review. A JS language argument does not repair it. No native import/package/lock/plugin
is admitted. Input §34.5 is prominently marked historical/superseded; its direct-module installation
example must not be followed. Parent removed the unsafe code-header/bootstrap example.

The independent report `/Users/areyouok/portava-sandbox/codex-corrections-20261015/WALL-NATIVE-READINESS.txt`
was also read. Extracted/stubbed Swift reproduces deferred startup surviving stop/abort (including
startup after `end`) and initializer error without `end`; seven scenarios repeated twenty times
demonstrate findings/controls, **not native acceptance**. JS pre-start checks cannot cancel an already
launched native task; early `end` can release the JS lock before stale native work starts. Native
cancellation and terminal-event correctness need a separately authorized fix. Seven-file Swift
typecheck/code generation used a local Expo shim, not real Expo bridge/linking. Android compilation
was unavailable without JDK 17/SDK 36. These are code/integration blockers, not merely missing
device proof. The investigation did not edit repository sources or exercise a real microphone.

## Evidence read, not rerun as product certification

Sibling worktrees share the `/Users/areyouok/portava-sandbox/` parent:

- `wt-codex-passport-small-20261015/docs/ops/passport-small-corrections-20261015.md`: reports
  93 API + 6 client passes; P61 red/mutation proof. There was no separate Passport REPORT.md.
- `wt-codex-compass-small-20261015/evidence/compass-small-20261015/REPORT.md`: reports 29/29
  changed-suite, 117/117 focused and 16 isolated ranking passes. The broader attempt with two
  offline-guard file failures is explicitly **not green**; mocked passes are not provider proof.
- `wt-codex-sensing-small-20261015/evidence/sensing-small-20261015/REPORT.md`: reports 22/22
  readiness and 255/255 across 17 focused files (22 is included, not added); eight readiness cases
  failed before correction. No database auditor ran.
- `wt-codex-trust-client-small-20261015/TRUST-CLIENT-CORRECTIONS-20261015.txt`: reports 83
  mounted + 9 age-refusal passes and failing-first controls; no device/hosted-path certification.
- Same checkout, `TRUST-TV2C-SURFACES-INCREMENT-20261015.txt`: author reports 38 new cases
  (10 red before source fixes), 113/113 across 12 exact suites. Its missing-server-producer statement
  describes the worker base and is superseded by the producer already integrated/read here.
- `wt-codex-trust-server-small-20261015/evidence/trust-server-small-20261015/REPORT.md`: reports
  71/71 changed suites and 430/430 focused passes; four red cases before the reporting correction.
- Same directory, `TV-2c-PRODUCER.md`: 28/28 producer tests and 228/228 focused passes, eight
  red producer cases before correction. Fixtures do not evaluate SQL `.or()` or RLS; caught seen-cache
  warnings are an existing fake limitation, not persistence proof. These totals overlap, not sum.
- Final parent verification: 415 integrated focused tests pass; both source package typechecks pass;
  test-typing ratchets remain API 862 diagnostics / 115 files and client 173 / 60 files. Parent reports
  final ESLint with zero errors. The final client run passed 157/157 across 16 suites.
  A final parent sweep of 48 existing mounted suites referencing the changed identity components
  passed all 272 tests. This overlaps the 157-test run and is not additive. Existing animation/teardown
  warnings remain; it does not substitute for native-device responder or accessibility evidence.
  Independent final-increment review was accepted with no findings: 113 client + 110 server tests
  and 6 privacy probes passed. These results overlap, not sum, and are attributed parent/reviewer
  results, not reruns or full-suite/CI claims by this evidence lane. The producer implementation gap
  is code-closed; deployment/current-verification/device and the other recorded W requirements remain.

## Local metadata verification

Run from `artifacts/api-server`, with `env -i PATH="$PATH" HOME="$HOME" TSX_DISABLE_CACHE=1`,
no environment file, network or database. All eight checks exit 0:

- `node --import tsx/esm src/scripts/checkCensusIntegrity.ts`: 13 censuses, 3,518 parsed rows;
  the existing 163 prose-counted requirements remain outside this parser.
- `node --import tsx/esm src/scripts/checkCensusScopeCoverage.ts`: all 13 at 100% of the resolved,
  graded citation denominator; existing ambiguous/missing-path exclusions are still limitations.
- `node --import tsx/esm src/scripts/checkCensusRowMoveLabels.ts`: 0 mislabeled objects.
- `node --import tsx/esm src/scripts/checkCensusPolicyCitations.ts`: 20 policy citations, including
  9 superseded definitions whose current migration is cited. Not semantic SQL verification.
- `node --import tsx/esm src/scripts/checkCensusFreshness.ts`: 13 checkable, 0 stale, 0 undeclared,
  0 unscoped. Named-path acknowledgements are not a new full-census measurement.
- `node scripts/check-doc-citations.mjs`: 0 invalid ranges/anchors/full anchors/unbindable forms;
  20,489 citations, 14,057 anchored and 13,862 whole-anchor-checkable at this snapshot.
- `node scripts/check-citation-targets.mjs`: existing 155 dead targets / ceiling 155.
- `node scripts/check-citation-symbols.mjs`: existing 0 absent / 34 misplaced symbols, ceilings 0/34.

Unanchored debt is 6,432 / unchanged ceiling 6,434: two displaced historical overlay-chip pointers
now carry exact anchors, with their historical line number explicitly identified as historical.
Dead-target and symbol debt are unchanged from the initial local scan; no new debt is waived and
none of these counts proves historical semantic accuracy. No ceilings,
floors, exclusions, checker rules or production/test code were edited by this lane. Five newly cited
source paths alone were added to `CENSUS_SCOPE`: the Sensing posture helper, server follows route,
client follows service, TravelerRow and UserNameButton. The machinery-anchor shifts in Media,
Trust and Wall were repaired, not hidden by changing the checker.

Metadata regression command: `node --import tsx/esm --test --test-concurrency=1` followed by these
ten explicit paths under `artifacts/api-server/src/test/`: `censusAckCanonicalForm.test.ts`,
`censusDigitPrefixIds.test.ts`, `censusDumpCompleteness.test.ts`, `censusHeadCommit.test.ts`,
`censusIdGrammar.test.ts`, `censusIntegrityQualifiedVerdicts.test.ts`, `censusPolicyCitations.test.ts`,
`censusRowMoveLabels.test.ts`, `censusScopeCoverage.test.ts`, `docCitations.test.ts`.
**142 passed, 0 failed/skipped/cancelled.** No product suite, full typecheck or CI was rerun here.
The canonical dump (`CENSUS_INTEGRITY_DUMP=W`) independently lists exactly the 43 assigned W rows
in the five named areas. `git diff --check` passes.
An in-memory comparison using the unchanged integrity parser against exact HEAD documents confirms
all 3,518 `(census, id, verdict)` tuples are unchanged, including all 2,504 parsed C grades.

Preservation checks confirm all 13 old acknowledgement reasons remain literal and encoded byte
prefixes, all old path-list order and `since` values survive, retired entries are unchanged, JSON is
canonical, and integrated Passport §37 prose is identical after normalizing citation line numbers.
Other Passport changes are displaced
citation repairs (Place-stamp tests and the final identity-card wrapper), including explicitly
historical wording on the two old overlay-chip pointers; no integrated Passport argument was
removed. The final client copy arrived during an earlier metadata regression run and made its
citation test fail; those new anchor shifts were repaired before the final rerun, not waived as debt.

## Exact evidence-lane writes

- `docs/architecture/census-compass.md`
- `docs/architecture/census-discovery.md` (citation repair only)
- `docs/architecture/census-input-intelligence.md`
- `docs/architecture/census-media.md` (machinery citation repair only)
- `docs/architecture/census-passport.md` (preserved integration; citation repairs only here)
- `docs/architecture/census-sensing.md`
- `docs/architecture/census-trust.md`
- `docs/architecture/census-wall.md`
- `docs/ops/small-area-corrections-20261015.md`
- `artifacts/api-server/src/scripts/CENSUS_STALENESS_ACKNOWLEDGED.json`
- `artifacts/api-server/src/scripts/checkCensusFreshness.ts` (five path additions only)

## Final handoff

All announced production/test paths are now integrated and read; no source-copy path remains pending
at this snapshot. Parent reports independent final-increment review accepted without findings;
publishing remains the parent's action, separate from this metadata pass.
Any later source fix or reformatting of the server follows import/report allow-list requires another
anchor/freshness scan. Same-path acknowledgements can hide subsequent changes mechanically, so
fresh green output is not a substitute for an explicit new argument. Native readiness evidence stays
in the documents, not an empty freshness suffix. No native delivery, grade upgrade, threshold change
or historical-assertion certification is authorized by this handoff.
