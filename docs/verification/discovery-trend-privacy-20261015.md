# Discovery trend privacy — local verification, 2026-10-15

Baseline: `324ed0dd2b61371afc6f20a5a843f89406b57cc8`. Main-app code only, in the assigned detached checkout. No census verdict changes or production certification.

## Owner decisions and scope

Read `docs/ops/discovery-owner-approval-request.md` (§8.2–8.4, §8.10) and `docs/ops/owner-decisions-20261004.md` before implementation. Q12 requires at least 15 travellers and protected-zone suppression. Q15 dwell publishing and all three Q16 people-derived uses remain held. Production activation remains frozen.

Requirement coverage: B04 and DV-29 directly; shared trend production/reading protections support DV-28, DV-30, DV-31, DV-32, DV-33 and the existing permitted portion of DV-34. These are protection changes, not completion claims for those requirements.

## Existing implementation preserved

The baseline already applied the shared k floor in both windows and had zone checks on Local Pulse and emerging Trail members. Those mechanisms were not rebuilt. The Trail boundary tests now exercise exactly 15 and 14 travellers. Normalisation arithmetic, ranking objectives, post-convergence feature gates and held data sources are unchanged.

## Demonstrated defects and fixes

- Missing, non-finite and out-of-range place coordinates previously passed the trend zone guard. They now withhold the place and any dependent aggregate or emerging Trail claim.
- Local Pulse cleared cells even when a contributor could not be resolved or its place row was missing. Clearance now requires every known contributor to resolve to a zone-clear place.
- A truncated contributor read could clear a cell without checking all its contributing places. The read requests an exact count and refuses clearance unless every counted row arrived; unavailable count also fails closed. Large destinations can therefore return `eligibility_read_failed` instead of publishing a partial privacy assessment.
- The in-process momentum/trend producer and rebuild scheduler previously did not check zone policy. They now share an uncached existence guard before reading events/replaying cache or invoking the rebuild RPC. Active zones, missing policy storage, read errors, malformed responses and exceptions prevent production. A blocked in-process load clears cached trend and retest readings.

The producer gate intentionally blocks the entire unfiltered producer when **any active zone exists**, even a distant one. It is a conservative hold, not contribution-level filtering. It reads only existing policy IDs, does not reinterpret geometry, adds no personal-data source, and does not alter flags. The existing read-side zone geometry rules remain authoritative for lists. With a successfully read empty active-zone policy, existing producer behaviour is preserved.

## Regression evidence

Before changing production code, the focused `Q12 regression|L-Z5` selection failed all 11 assertions/tests on the baseline: ten newly added regression tests plus the tightened missing-position expectation. Failures included a published area with an unresolved contributor, partial contributor reads treated as complete, a cached emerging claim after policy changed, events read despite an unreadable zone policy, and the scheduler invoking its rebuild RPC with an active protected zone.

After the fix, **224 tests passed, zero failed/skipped/cancelled**, across these 11 focused files:

- `discoveryTrendingLists.test.ts`
- `discoveryLocalMomentum.test.ts`
- `discoveryTrendOps.test.ts`
- `discoveryTrendNormalised.test.ts`
- `discoveryTrendPostConvergence.test.ts`
- `discoveryTrendReviewSuppression.test.ts`
- `discoveryDerivedStoreProvenance.test.ts`
- `discoveryDerivedProvenance.test.ts`
- `discoveryDerivedProvenanceGolden.test.ts`
- `discoveryTrendingApi.test.ts`
- `discoverySurfaceObjectiveRank.test.ts`

Executed from `artifacts/api-server` with `SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy NODE_ENV=production node --import tsx/esm --test --test-reporter=tap` followed by the explicit `src/test/` paths above. Loopback permission was required for HTTP tests; two sandbox-stalled attempts were interrupted. Database access was stubbed. No hosted database, migration, CI, deployment, beta or production operation ran. No dependencies were installed or changed.

Compatibility fixture changes provide an explicitly readable empty zone policy and valid coordinates; golden arithmetic hashes and ranking assertions were not changed.

## Remaining gates

1. The SQL rebuild function itself is unchanged. Direct RPC/manual SQL execution bypasses the scheduler guard. An atomic, database-side contribution filter and execution-level SQL parity tests are still required before activation; this local patch does not certify stored producer safety.
2. The preflight existence query is not a transaction with a subsequent read or rebuild. A concurrent policy change remains an activation concern. Contributor-location semantics and any new data needed to establish them require the recorded owner/privacy resolution, not inferred movement or new collection.
3. Existing stored snapshots are not rewritten or purged. Missing coordinates/contributors and oversized contributor responses deliberately reduce availability rather than weaken privacy.
4. The production freeze, deployment/environment isolation, retention/legal review, Q11(b)/(c) decisions and Q15/Q16 holds remain unchanged. No census row is promoted on these local tests.
