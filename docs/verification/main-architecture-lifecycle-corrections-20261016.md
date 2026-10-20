# Main application lifecycle corrections

## Scope and result

October 16, 2026 followup on detached baseline `324ed0dd2b61371afc6f20a5a843f89406b57cc8`, preserving the checkout's earlier uncommitted corrections. Work is local to the main application; beta and the separate Media integration checkout were untouched. Six parallel workers were reused for bounded implementation, triage and independent review.

Four areas now have additional tested corrections. **647 tests in 115 suites across 27 selected files pass**, with no failures, skips or cancellations. This is not the entire repository suite. Census verdicts remain **2,506 C / 894 W / 94 N / 24 X**, totaling 3,518; **71.23% local documentary correctness**, not a new whole-architecture audit. This pass promotes no requirements and makes no deployment-readiness claim.

## Implemented corrections

### Compass cache build provenance

`CompassCacheEngine.captureCacheBuild` captures immutable viewer/generation provenance before asynchronous profile and candidate work. The internal cache setter checks it before L1 insertion and again before queued L2 persistence. Full-feed, section-feed and frontload routes supply that context; all existing production writers use it. Failed invalidation continues withholding that viewer's cache until recovery.

Eight actual-handler tests cover delayed profile/candidate/tier work, stale-result refusal and fresh-request caching. Existing cache, expiry, invalidation and local-time tests remain green. The delayed frontload regression failed before implementation; an independent negative control moving capture after profile loading also fails.

This prevents same-process stale cache repopulation. It does not cancel an already-running response, provide distributed generations or certify every upstream profile cache.

### Telegraph retranslation lifecycle

`messageTranslation` reuses the existing structured-envelope classifier so language-change sweeps cannot send storage keys or other envelope payloads to the translation provider. Current message, active viewer membership, history window and explicit non-E2EE thread state must authorize retranslation. Source identity/version and authorization are reread before retry and persistence, including same-language and failed-provider paths. Existing authenticated settings gates and own-history exceptions remain intact.

Thirteen envelope and sixty-three authorization tests cover the additions. The selected translation family separately passed 275 tests before integration into the final run. Failures withhold translation rather than creating substitute content. No new provider or blanket messaging block policy was introduced.

The final authorization read and write remain separate statements. Already-sent provider plaintext cannot be revoked; concurrent opt-out is not request cancellation; old translation derivatives are not purged by this change. Additional reads increase per-message work, and hosted query cost remains unmeasured.

### Trips cancelled transport

`TripRiskTriggers` excludes both accepted case forms of cancelled transport from crew-capacity mismatch calculation, as it already excludes completed transport. Fourteen focused tests cover segment/plan/crew party-size inputs and active/disrupted controls; seven failed before the correction. Independent neighboring risk, Today and replan checks pass.

Actual capacity feeds, complete served-plan linkage and risk-recipient integration are not supplied by this predicate fix. Replan's existing consumption limits remain.

### Memories evidence draining and retry concurrency

`memoryEvidenceErasure` repeatedly reads owner-scoped Memory links in batches of 100, retires before purging and requires an empty confirmation read. It rejects malformed links, non-progress and work beyond 100 batches. A missing store after a discovered link is a retryable failure, not absence. A subsequent invocation can continue the remaining work.

`memoryDeletionLifecycle` records a versioned required/absent-store marker in the existing bounded dead-letter detail. Required or uncertain history cannot become successful absence on a later attempt, another API invocation or scheduler redrive. A known initially absent store remains compatible with corrections-only retries when retry metadata is readable. Unreadable/legacy metadata is conservatively blocking rather than assumed clean.

Failure writes use bounded compare-and-swap updates and ignore-conflict inserts; completion also requires conditional resolution of any open letter. Predicates match Memory, owner, letter count, failure timestamp and resolution state. Failure writes increment the count; resolution/moot closure changes resolution state; operator bump changes failure time. All runtime writers found in this repository participate, including the scheduler's moot and operator paths. Required history cannot be downgraded by a stale absent-store writer, and a later failure is not resolved by an older overlapping attempt. Already-resolved timestamps are preserved. Error detail stays in request bodies, not long URL filters.

The evidence suite contains 68 additions from this pass. Review exposed sequential retry, marker-overwrite and scheduler-moot races before acceptance. Thirteen independent deterministic probes cover lifecycle and scheduler races/controls; twenty-seven installed-client probes cover request construction, returned-row checks and bounded conflict handling with 70 synthetic requests and no network. Maximum measured URL length is 309 characters. These are not live multi-connection database tests.

No migration or permission change is required. Existing migration 3670 supplies the columns, key and service-role operations. No hosted migration, flag, scheduler activation or database write was performed.

## Validation and artifact

Commands use an isolated environment, dummy credentials and synthetic fixtures. Loopback HTTP servers are test-only. Parallel test concurrency is capped at two rather than running multiple full suites simultaneously.

| Check | Result |
|---|---|
| Final selected API regression | 647 passed, 115 suites, 27 files, zero failures/skips |
| API source types and focused changed-test types | Passed |
| Test registration | 2,019 files: 1,986 registered, 33 allowlisted; floors unchanged |
| Static schema references | No new undeclared references; 573 tables / 858 migrations; 189 dynamically unresolved sites remain outside this check |
| Census integrity and freshness | 3,518 parsed verdicts; thirteen scoped acknowledgments; zero stale under existing checker rules |
| Production bundle and dependency guard | Passed; all 31 required OpenTelemetry packages verified |
| Artifact manifest | Twelve generated regular files independently hash-verified |

Artifact: `sha256:d25f953586b54e4c3e94aba09b86901616934cf91baddbf605246cce1bad73d9`. Two existing Expo base-config warnings remain in this symlinked workspace. The bundle was not started or deployed.

Temporary command logs include `/private/tmp/architecture-lifecycle-combined-final-20261016.log`, `/private/tmp/architecture-lifecycle-source-types-20261016.log`, `/private/tmp/architecture-lifecycle-test-types-20261016.log`, `/private/tmp/architecture-lifecycle-build-20261016.log`, `/private/tmp/architecture-lifecycle-schema-20261016.log`, and `/private/tmp/memory-cas-version-client-probe-20261016.log`. Counts from separate overlapping runs must not be added together.

## Remaining work and safety boundaries

- Memory retirement/purge helpers still accept ambiguous null, malformed or partial mutation responses. The new drain detects surviving Memory links, not every episode postcondition. Next work must positively confirm retirement/scrubbing or genuine absence and no remaining owner-scoped episode evidence in both call paths; preserve links until retirement is confirmed.
- Required-marker history is not a new transactional job ledger. Process crashes before failure recording, mixed old/new deployments, external unversioned writers and delete/recreate identity reuse are not certified by these CAS tests. Legacy or unreadable metadata may intentionally leave deletion incomplete; logs alone are not durable recovery.
- Returned mutation counts may undercount capped database responses. Existing episode-wide retirement and collateral erasure semantics were preserved, not newly authorized.
- Distributed Compass invalidation, atomic translation authorization, real provider/device quality, release gates and the remaining census predicates require separate evidence. Missing infrastructure remains disabled; no bypass or invented behavior closes those rows.
- Input G160 timing preservation is a possible next bounded slice for resolved venues, but full free-form itinerary acceptance requires the documented owner contract. Passport protected-place and association gaps must not be filled by guessed rules. See `input-passport-next-work-20261016.md`.

All changes remain uncommitted and unmerged. No paid infrastructure, new account, beta operation, hosted migration, deployment or production flag change occurred.
