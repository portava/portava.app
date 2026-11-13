# Whole-system A++ acceptance

Scope: Compass, Sensing, community information, personalized media, Discovery,
Input, Wall, Map, Trips, Events, Highlights, Moments and Stamps. Passport/profile,
shared-post destinations, session ownership and media delivery are cross-cutting
parts of the same release. No iPhone build is authorized.

## Grading contract

A++ is a target, not an assertion that the current release has earned it. The
production monitor reports operational evidence, not an effectiveness grade.
An unmeasured requirement remains **unverified**, even when every unit test passes.

For an evaluated release, use a weighted geometric score across measured
correctness (30%), usefulness (25%), reliability (20%), performance (15%) and
accessibility (10%): `Q = 100 × product(metric ^ weight)`, with each metric in
`[0,1]`. This is a proposed acceptance policy, not a calibrated production model.
Use the lower confidence bound of a representative success rate, not a small
sample's point estimate. Report the rubric, sample size, population, build and
time window beside every result. Latency percentiles need at least 60 valid
samples; that floor alone does not certify statistical precision.

Award A++ only when Q >= 98, no dimension is below 95, and all mandatory gates
pass: current authorization, privacy/consent, accurate provenance and freshness,
safe actions, no silent data loss, no unresolved critical or major defect, and
representative journey/device evaluation. Unknown evidence prevents a grade;
one excellent system cannot offset another system's failed gate.

## This code pass

| Surface | Changes and regression coverage |
| --- | --- |
| Compass | Existing continuity, constraint-aware tools, action deduplication and bounded reasoning checks retained in the full suite. |
| Sensing | Existing consent, revocation, independent cohort support and consecutive dwell checks retained. |
| Community information | Independence, provenance and outcome replay checks retained. |
| Media | Real-media preference, capture-time freshness, signed private media and unavailable-image recovery checks retained. |
| Discovery | Venue IANA timezone/DST, weekday ranges, overnight and split shifts; unsupported schedules remain unknown. Cached opening status is recalculated. Unknown hours/ratings fail explicit filters. |
| Input | Four-second server suggestion deadline, disconnect cancellation, no late served answer. Opt-in writing gets a 2.5-second model budget and no SDK retries. |
| Wall | Auth/header/body deadline, viewer-scope checks, malformed-feed refusal, explicit degraded lanes. |
| Map | Bounded projection reads; malformed data is a failure rather than an explicit feature-off or empty map. Existing privacy and temporal projection checks included. |
| Trips | Bounded list/detail/member-role/invite reads, preserving unreadable versus absent. Existing readiness and private-anchor checks included. |
| Events | Bounded shared API calls and total nearby-page walk, unreadable lists/details/actions cannot claim success. Nearby and waitlist-capacity regressions included. |
| Highlights | Bounded creation and principal read/mutation paths; malformed lists cannot erase the visible collection. Shared-reference authorization and lifecycle checks included. |
| Moments | Subject/time validation, expired/future filtering, mounted expiry and foreground refresh, retry action, stale-request and unmount guards. |
| Stamps | Bounded API calls, confirmed mutation state, unknown count stays unknown, malformed lists/progress refused, same-render double taps coalesced, old-card results withheld. Presence/revocation checks included. |
| Passport/profile | User avatar menu identity, account-switch and profile-change checks retained. Profile tools, about/travel details and stamp collection collapse by default and mount on demand. Highlights and posts precede stamps in the default order; saved custom orders remain intact. The Stamps tab suppresses the duplicate collection. Disclosure interactions and content access are covered. |

All request failures preserve the existing error contracts. No automatic mutation
retry was added: a lost response cannot establish whether the server committed.
The shared request wrapper budgets token acquisition, response headers and JSON,
including transports that ignore cancellation. Direct database reads can outlive
an Input response deadline; late results are not served. This does not claim
database query cancellation or an end-to-end latency guarantee before authentication.

Run `pnpm test:system-quality` for reference formulas, the server cross-system
suite and the mobile component suite. Run runtime type checks and existing test
type baselines separately. These checks use local fixtures; they are not live
model accuracy, city coverage, accessibility-on-device or playback measurements.

Verified on 2026-11-13: 1,579 server tests, 314 client tests across 51 suites and
14 reference-formula tests passed. Both runtime type checks passed. Existing test
type baselines remain unchanged (client: 144 diagnostics in 54 files; server:
860 in 113). Mock integrity, test registration, orphan-test and diff checks passed.
The opening-hours tests also passed after bounding its formatter cache and input
length. The embedded PostgreSQL monitor assertions passed separately.
ESLint completed on the fifteen files in the final reliability/Passport pass:
zero errors, 77 warnings. This is not a claim that the repository is warning-free.

Passport's changes are verified through component interactions and code review.
The available public web page was an install landing page, so no live Passport
screen or iPhone visual validation was possible. No iPhone build was run.

## Production evidence and remaining gates

The private whole-system monitor captures 13 aggregate snapshots per hour with
90-day retention. Feature flags and source data are unchanged. It stores no
prompts, user identifiers, coordinates or media. Its 17 query cells are verified.
The first scheduled execution succeeded at 2026-11-13 12:07 UTC (07:07 Eastern).
The same-hour manual snapshot was already present, so the scheduled invocation
correctly reused it instead of duplicating rows.

Production currently has insufficient outcome/timing evidence for an A++ grade.
Sensing publication remains disabled. Several added surfaces have no activity in
the current observation window. Personal-memory creation counts do not establish
live Wall-transition quality. Asset readiness does not establish playback quality.
The project security advisor also reports existing public-schema function and
extension findings outside the monitor; their intended exposure requires review
before a whole-application security gate can be certified. The monitor's own
deny-by-default privilege checks passed.

Application fixes are local and uncommitted; they have not been deployed. Only
the explicitly authorized production database monitor and dashboard are live.
Release evaluation still needs representative, consent-respecting live outcomes,
device accessibility/performance checks and deployment of the reviewed code.
