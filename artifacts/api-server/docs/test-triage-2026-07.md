# Out-of-list test triage — July 2026 (availability_blocks wave)

65 files in `src/test/` were absent from the curated `package.json` test list.
Each was run individually; 13 failed. Every failing file was root-caused and
**fixed** (none needed quarantine — no route behavior was changed except none;
all failures were stale tests or fake-client harness drift). All 13 fixed
files, plus `rentABuddyLifecycle`, `schemaDriftCheck`, and the new
`reconcileRunSummary`, are now in the curated test list.

## Per-file decisions

| File | Root cause | Decision |
|---|---|---|
| discoveryCommunityCoordinateBounds | Fake chain lacked `maybeSingle()` — `requireUser` now probes `profiles.account_status`, so every request 500'd before validation | test-fixed (fake) |
| discoveryCommunityCoords | Same `maybeSingle()` gap | test-fixed (fake) |
| discoveryCommunityRating | Same `maybeSingle()` gap | test-fixed (fake) |
| discoverySearchIntelligence | Same `maybeSingle()` gap in the generic fake builder | test-fixed (fake) |
| discoveryCommunitySortBy | Fake ignored `.order()`, so DB-side ordering was untested and order-sensitive; fake now implements `order()` (desc, nullsFirst:false) deterministically | test-fixed (fake) |
| discoveryCommunityPopularSort | Order-sensitive flake with the same cause; passes deterministically after the shared-fake ordering fix | covered by SortBy fix |
| adminPhase12 | Signup suite hit the in-process rate limiter (429) when run after other signups; limiter now reset in suite setup | test-fixed |
| blocks | `GET /me/blocks` applies the intentional @handle name-privacy contract; fixture lacked the opt-in privacy row | test-fixed |
| passportProfileAccess | Same privacy contract; fixture lacked `profile_privacy_settings` opt-in. Added both branches (opted-in shows name, non-opted-in shows null) | test-fixed |
| discoverySearch | Privacy contract filters real-name matches without opt-in; also fake lacked `gte`/`lt` so the events window threw | test-fixed |
| profileEnsure | `/profile/ensure` intentionally also upserts `location_preferences` defaults; test asserted a global count of 1 upsert | test-fixed |
| events-extension | Fake served legacy `circle_members`; routes read live `circle_memberships` (`user_id`=owner, `other_id`=member) | test-fixed (fake) |
| stampEarnedNotification | Award path is fail-closed on `feature_flags.stamp_system_v2_enabled`; fake returned no flag → 503. Fake now enables it by default; added a disabled-path suite | test-fixed |
| pulseRanking | Fake chain lacked `gte/lte/gt/contains/overlaps`; Compass ranking block threw and silently fell back to unranked order | test-fixed (fake) |

## Not added to the curated list

The remaining ~50 out-of-list files pass but were intentionally **not**
mass-added (out of scope for this triage — only files touched here join the
list). They remain candidates for a follow-up registration pass:
see `/tmp/outfiles.txt` snapshot of the run; all exited 0 except the 13 above.

## Recurring harness lesson

Most failures were fake-client drift: routes gained new query-builder calls
(`maybeSingle`, `gte`, `lte`, `order`) that hand-written fakes didn't
implement, turning validation tests into 500s. When adding builder methods to
a route, grep the out-of-list fakes for the table involved.
