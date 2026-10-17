# Discovery correction pass 2026-10-16

This pass repairs additional Discovery defects on top of the uncommitted October 15 work. It targets the main application only. The isolated checkout starts from main commit `324ed0dd2b61371afc6f20a5a843f89406b57cc8`. No beta work, production deployment, hosted migration, feature activation, payment operation, commit or push is included.

A fresh read of GitHub main on October 16 still returns that exact commit. At 05:19 UTC, a read-only request to the documented main origin's actual API health path, `https://portava.replit.app/api/healthz`, returns HTTP 404 with Replit's “This app isn't live yet” HTML, not a JSON application health response. This is distinct from the October 15 root-path observation and does not establish whether an unverified alternate origin is running.

## Implemented corrections

### Community identity and cache invalidation

The client previously retained community responses even when the server marked them `no-store`, retained mounted bylines after permission invalidation, and could display a response predating that invalidation. Pull-to-refresh also skipped this community read.

The client now respects response cache policy, bypasses the HTTP cache, clears stale community state, discards obsolete permission-scope responses, and refreshes the community rail. Canonical withheld names may be null; legacy names are not used to reconstruct a withheld identity. Existing flag behavior and approved byline presentation remain intact.

### Exposure replay identity

A replay after every recorded exposure advanced beyond `impression` could insert duplicate exposures: the existing `(recommendation_id, outcome)` uniqueness condition no longer collided. New provenance-bearing exposure rows use a deterministic, domain-separated UUID primary key derived from their existing recommendation token. The token itself, viewer/session binding, and event vocabulary are unchanged.

Known replay collisions do not repeat creator-fatigue writes. Unexpected primary-key failures remain errors rather than being mislabeled as successful replays. Historical random-ID rows and the legacy-schema fallback are outside the new guarantee. Recovering downstream counters after a lost acknowledgement still requires durable coordination; this change does not claim exactly-once processing of every side effect.

### Trail completeness and visibility

Exposure totals and health/report calculations now consume complete, ordered, bounded pages rather than treating PostgREST's first result page as the whole set. Archived Trails no longer supply followed-Trail ranking affinity.

The reader requests 500 rows per page, up to 20,000 rows and 100 requests. Changed/missing totals, malformed responses, premature completion, errors and exhausted budgets discard the partial result. Reads without totals need an empty terminal page. These are resource bounds, not new ranking or consent policy. Pagination is not a cross-request transactional snapshot; equal-count concurrent edits still require database-level validation.

Independent review found that a paginated list of denied relations could miss an unreviewed edge during equal-count membership changes. Relation navigation now reads candidates and their review state together: one complete exact-count query per direction, with a 500-row maximum. Modern declarations are navigable only when explicitly accepted; pending, rejected and unknown declarations also prevent parent-pointer fallback from admitting that pair. Incomplete or over-budget evidence withholds navigation. Legacy fallback is allowed only for a missing `review_state` column on the first outgoing query, never after a successful direction or an unrelated column error. This closes the demonstrated negative-list race without claiming a transactionally consistent snapshot across both directions.

### Database trend contribution filtering

Migration `3988_discovery_trend_protected_contributions.sql` filters canonical place context before aggregation, changes both normalized activity and post-convergence reads to require eligible context, and filters the legacy producer through the same context. This prevents protected and unlocatable contributions from entering place, area and peer calculations through those functions. Both suppressed and coarsened zones exclude crowd contributions. Missing/invalid positions and malformed supported zone definitions fail closed. Zone boundaries are excluded.

Stored feature versions gain `+protected-contributions-v1`; historical snapshots are not relabeled. Existing memory owner controls and latest-place-correction exclusions remain in place. All affected functions remain security-invoker and restricted to the service role. Failure to read protected-zone policy is an error, not an empty policy. No new user position, audience, collection permission, retention policy or flag is introduced.

Polygon validation rejects self-intersections, duplicate vertices, adjacent backtracking, zero area, polar vertices, antimeridian-spanning rings and over-budget geometry. The supported bound is 256 distinct vertices plus an optional closing vertex. Valid concave, clockwise and closed rings are tested. The migration fingerprints each entire function definition before and after replacement; an unexpected predecessor, comment-only spoof or security-mode drift aborts the transaction. PostgreSQL-version compatibility of those fingerprints must be checked before any real apply.

The empty migration was generated using the installed Supabase CLI in isolated staging, then adapted to this repository's numbered migration convention. Its full content was executed only in fresh in-memory PGlite PostgreSQL fixtures, using existing local tooling; nothing was installed or applied to a hosted database.

**Activation remains blocked.** The existing application-level guard still withholds the unfiltered in-process producer and scheduler whenever any active zone exists or policy cannot be read. The SQL filter does not clear the need for a policy-change/snapshot lifecycle protocol, consistent multi-statement rebuilds, canonical-location mutation validation, historical snapshot handling, full migration-chain certification, query-cost measurement, or an authorized release. It must not be used as permission to invoke a live rebuild or remove the conservative guard. Q16's refused people-derived uses remain refused, including where synthetic fixtures exercise disabled existing code.

A local adversarial simulation changed zone policy between place and area writes: a protected place snapshot survived, and a later filtered rebuild did not remove that old row. Consequently the new feature-version stamp is not proof of present-policy safety. Snapshot invalidation and an atomic publication protocol remain unresolved, not silently accepted limitations of an enabled feature.

### Creator attribution backlog progress

The Travel Partner producer previously restarted at the first 5,000 completed bookings every hour, so already-attributed rows could permanently hide later bookings. It now persists a UUID traversal cursor, revision and per-cycle upper UUID bound in a service-only singleton table from migration `3989_creator_attribution_scan_cursor.sql`. Pages remain bounded to 500 rows and passes to 5,000 rows. The cycle bound prevents newly arriving higher UUIDs from indefinitely postponing revisits to late-completing lower UUIDs. An empty bounded tail, not a short server-capped page, ends the cycle.

Compare-and-swap checkpoints reject stale workers; malformed/incomplete responses fail closed. Existing attribution uniqueness and beneficiary refusals remain, no Buddy earning is duplicated, and no payment I/O is added. OFF at entry performs no writes. Flag reads and checkpoint writes are not one transaction: a concurrent OFF after the final check can still allow that checkpoint. No stronger cancellation policy is claimed.

Migration 3989 was generated with the installed Supabase CLI 2.121.0 (`20261016044100_creator_attribution_scan_cursor.sql` in isolated temporary staging), then adapted to the numbered convention. In-transaction postconditions verify shape, singleton seed, bound constraint, RLS and restricted privileges. It remains unapplied to every hosted database. The producer refuses an uninstalled cursor rather than silently reverting to the starving scan. Local and independent verification cover a >5,000-row backlog, server caps, late completions, growing higher-ID arrivals, failures, CAS conflicts, OFF, reopen and SQL privileges; live PostgREST contention and abrupt-process crash recovery remain uncertified. This repair does not supply the separately undecided Local Expert value event or creator earning/provenance bridge.

### Identifiable API artifacts

The API build emits a manifest hashing generated `dist` file names and bytes, including bundles, workers and maps. At process startup the packaged API verifies that manifest against its files. `GET /api/healthz` preserves its existing `{status:"ok"}` body and adds `X-Portava-Build: sha256:…` plus `Cache-Control: no-store`. Development/unbuilt or invalid artifacts report `unavailable`; mutable runtime SHA variables cannot establish identity.

This is bounded release-evidence tooling, not deployment certification or continuous integrity monitoring. External dependencies, Node, configuration, database state and assets outside `dist` are not covered. No deployment or feature activation occurs. A real bundled fixture exercises the actual health route; a full application build is not claimed by that fixture.

## Validation scope

- Integrated client component tests: 31 pass in four suites. Separate byline and refusal-registry tests: 16 pass.
- Broad offline API regression run: 3,744 tests in 869 suites pass, with no failures or skips (265 seconds). The 207-file selection covers Discovery, Rent-a-Buddy and existing creator attribution; it excludes five explicitly live-DB-guarded files and two slow legacy sort suites. This run precedes integration of the separate creator scan-cursor repair.
- Focused Trail access, routes and exploration verification: 170 tests pass. Old test adapters were corrected to return exact counts before limiting rows and to distinguish explicitly accepted modern edges from legacy fixtures; production assertions were not weakened.
- Executed trend SQL: ten tests pass without skips. The fixture reproduces the old protected/unknown contribution defect, executes the full migration twice, and verifies filtered counts, both persisted producers, unchanged eligible-input arithmetic, feature provenance, owner controls, geometry, client-role denial and transactional rollback on incompatible definitions.
- Exposure replay verification: 26 tests pass, including three actual SQL fixtures exercising primary-key collisions, delayed duplicate inserts after outcomes advance, viewer isolation and unexpected-collision refusal. The PGlite adapter is single-connection; it is not a hosted multi-connection locking certificate.
- Creator cursor verification: 40 focused tests pass independently after the continuous-arrival regression repair. Artifact-identity verification: 15 focused tests pass. The final integrated creator/health family run passes 518 tests in 126 suites with zero failures or skips; this run overlaps the focused counts and is not added to them. Its loopback-only route tests required local server-binding permission; no hosted service was contacted.
- Server/client source and focused changed-test typechecks pass after cursor/identity integration. This is not a zero-error claim for the repository's entire historical test-type baseline.
- Census integrity, census freshness and generated Discovery ledger consistency pass; freshness is not evidence that verdicts are correct. Test registration and documentation citations are checked again after the final integration.

The entire repository suite was not run. PGlite fixtures are actual SQL execution but do not certify hosted PostgREST, multi-connection locking, the full production schema, deployed devices or production behavior. SQL fixtures use the existing local PGlite runtime through `DISCOVERY_PGLITE_MODULE`; they skip when that optional runtime is not supplied, so registration alone does not prove CI executed them.

## Remaining acceptance boundary

The original 85 correction rows are now **83 W**, after the separately evidenced DC-26 and DV-75 acceptances. This pass does not promote additional rows merely because their local tests pass. The current local Discovery ledger remains **103 C, 83 W, 2 N across 188 requirements: 54.8% accepted correct, 98.9% constructed**. The two N rows, DV-61 and DV-62, are separate commercial choices, not included in the 83 W.

The [83-row closure matrix](discovery-remaining-20261016.md) records exact requirements and acceptance gates. Its primary blocker labels are not an assertion that every underlying implementation is finished. Remaining work includes controlled release/migration evidence, approved collection and retention, creator earning/event decisions, unresolved raw and fiscal retention implementation, genuine Trail-open telemetry, runtime validation and mandated observation windows. Consent, legal clearance and real-world elapsed observation cannot be manufactured by tests or a broad instruction to finish the app.
