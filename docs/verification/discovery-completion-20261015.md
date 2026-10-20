# Discovery correction pass — 2026-10-15

Historical checkpoint. The [October 16 continuation](discovery-corrections-20261016.md) adds client-cache, exposure-replay, Trail-read and database contribution-filtering corrections with newer test evidence. The external observations below retain their original dates and are not refreshed by that continuation.

## Scope and baseline

Main-app work only. No beta work, deployment, database writes, money movement, new accounts, or feature activation.
Baseline: `324ed0dd2b61371afc6f20a5a843f89406b57cc8`.
The requested list was 85 W requirements out of 188 Discovery requirements (101 C, 85 W, 2 N).

## Verified external evidence

- Main CI run 38753302700, live-DB run 38753302711 and unwired run 38753302651 succeeded at that exact SHA.
- Live-DB job 116485340377 reports zero pending migrations, successful certification of every stage, no missing live columns and a successful schema audit.
- A read-only CI ledger query at 2026-10-15T20:46:11.642282+00:00 found all 41 files named by DC-26 (the original 40 plus 3436). Every SHA-256 matches the current repository bytes. The per-file record is [rehearsal evidence](../discovery/rehearsal-evidence-20261015.json).
- A broader, explicitly bounded 121-file dependency sample has 116 matching comparable CI checksums and five historical backfill sentinels (2760, 2761, 2762, 2763, 2767). A backfill is NOT proof of apply. Those five are outside DC-26's 41-file set.
- Production has 34 matching ledger records in that same 121-file sample; 87 sampled files are absent. This sample includes cross-domain dependencies, not 121 Discovery requirements or a complete production migration audit.
- Contrary to A11's old wording, production already records 2760–2785 with matching checksums. Its operational-projection flag is still FALSE, so A11 does not pass.
- Production's candidate and trip projection flags, engine mode and operational trip projections are FALSE; the serve-log flag is TRUE. Several later activation flags have no row. Missing is reported as missing, not proof of an enabled feature.
- The initial read found main unprotected. After the owner explicitly approved all three checks, active ruleset 25205817 was created for main only. Separate API reads confirm all three verdict contexts are required from GitHub Actions, strict up-to-date checks are enabled, the bypass list is empty and main reports protected. The unrelated August ruleset and main commit are unchanged. [Protection evidence](../discovery/main-branch-protection-20261015.json) closes DV-75's external setting gate.
- On 2026-10-15 the configured main-app URL `https://portava.replit.app/healthz` still returns HTTP 404 and Replit's “This app isn't live yet” HTML, not an application health response. A different deployment URL has not been established as the configured production build.
- PR #592 remains OPEN and unmerged. Its legal-retention hold remains effective.

These are observations, not permission to deploy. The October 4 activation freeze and actual-user consent requirements are not silently overridden by a request to finish code.

## Correction work

Parallel workers have added regression tests and fixes for:
- Candidate feature-gate cache isolation between clients.
- Private/non-cacheable community bylines.
- Shared Moment owner-standing checks that fail closed.
- Trend coordinate, contributor-completeness and truncated-read privacy checks.
- Conservative refusal of unfiltered trend producers when protected-zone filtering is required.
- Trail lifecycle timestamp handling, archived-member rotation and conditional authorized detach.
- Payment-provider identity and recipient readiness checks.
- B03 consumes the existing payment, current adult-identity and hosting-restriction services, read-only behind the existing Buddy launch gate. Candidate checks are limited to four concurrent operations; no provider operation or onboarding runs during Discovery. Stored payment snapshots do not replace checkout's live revalidation.
- Signed payment events can reconcile an already-accepted payout whose reference failed to persist, without requesting another transfer after eligibility is revoked. Binding checks cover provider, account, amount, currency and reference; held-row and competing-write cases have regression tests.
- Census denominator extraction: 188 requirements, not 351 cited files; no phantom 163 requirements.
- The compliance ledger is regenerated from the canonical census instead of its stale 187-row snapshot, and a new freshness check rejects missing/stale generated records without rewriting them. Accepted rows always have blocker NONE.

Independent review found and corrected two regressions: unknown Trail timestamps being mistaken for legacy nulls, and lost-reference payout reconciliation after eligibility revocation. A separate review found and corrected serial Buddy candidate queries. The final reviewed scope has no remaining change-blocking findings; this is not production certification.
Any active protected zone intentionally disables unfiltered trend producers globally. The application preflight is non-atomic, direct SQL bypasses it, and existing snapshots are not retroactively sanitized. Atomic database-side filtering and a controlled snapshot rebuild remain prerequisites before activating this functionality. Approved retention is still honored; no retention policy was enabled or changed.
This pass does not certify translation, media, or beta work from other checkouts.

## Honest completion boundary

DC-26's remaining CI rehearsal gate is now supported by live evidence, not by mock tests or an assumed green run.
An independent acceptance review verified the 41-file set and hashes and accepted DC-26 only.
Certification's run-scoped stages may have no newly applied files; a successful zero-pending run does not prove that every historical postcondition was re-executed.
After DC-26, the owner separately authorized and the API verified DV-75's main-branch check enforcement. The local census now records 103 C, 83 W, 2 N: 54.8% correct, 98.9% constructed. The census file on main still records 101 C until these documentation changes land, although the GitHub protection itself is already active.
The remaining rows must retain their production, privacy, commercial, retention or observation gates.
In particular, retiring the rollback ranker (C32/DC-24) before its required production observation period would remove the only rollback and is not safe.
No language below authorizes fabricated production events, forced data collection, live payment testing, or a claim of 100% correctness.

## Verification and remaining acceptance work

- The initial combined 16-file regression run passed 446 tests.
- The broader Discovery/payment run passed 3,234 of 3,236 reported tests. One assertion still expected the old database-read list; it was corrected to include the new protected-zone policy read, then its 15-test suite passed. The other reported failure was a live-database suite refusing an unconfigured target before doing any work. Its production denylist was not weakened or bypassed.
- Both unchanged legacy sort suites passed in that broad run. The final offline rerun passed all 3,213 tests across 173 files in 66.8 seconds, with zero failures, cancellations or skips. It excludes those two slow suites (22 previously passing tests) and the live-database suite, not failed product behavior.
- Server typechecking and targeted typechecking of all changed test files pass. The latter includes the repository's ambient declarations and existing request-logging augmentation, without changing the compiler rules.
- Test registration, census integrity/freshness, Discovery query-path coverage and Trust table ownership pass. The documentation citation check passes after scanning 20,499 citations and making 140 targeted repairs (138 line repoints and two baseline-pinned historical links); its reported ambiguity limitations still apply. No live database tests, production concurrency certification or deployed-device acceptance are claimed by these local results.

The 83 remaining W rows have primary gates of production rollout (61), owner approval (16), production/runtime evidence (3), and observation windows (3). The two N rows are separate commercial choices and remain unbuilt. These categories name the next gate, not every outstanding acceptance criterion; in particular the trend containment above is not a finished database-side privacy filter.

The full repository's corrected local census is 2,506 C / 3,518 requirements, or 71.23% correct. Its other buckets are 894 W, 94 N and 24 X. The recorded main census baseline remains 2,504 C / 3,518, or 71.18%, until a reviewed documentation change is merged; the new GitHub protection is already active. These are requirement-census ratios, not a measured probability of correctness or release readiness.

All repository changes remain uncommitted in the isolated Discovery checkout. The only external change is the explicitly approved main-branch protection. No feature was activated; no main-app deployment, production data mutation or beta work was performed.

### External evidence links

- [Main CI](https://github.com/portava/portava.app/actions/runs/38753302700)
- [Main live DB](https://github.com/portava/portava.app/actions/runs/38753302711)
- [Main unwired checks](https://github.com/portava/portava.app/actions/runs/38753302651)
- [Held retention PR](https://github.com/portava/portava.app/pull/592)
