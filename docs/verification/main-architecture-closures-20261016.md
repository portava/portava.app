# Main application requirement closure pass 2026 10 16

This pass targets complete requirements rather than counting isolated helper repairs. It builds on the uncommitted main-app corrections at `324ed0dd2b61371afc6f20a5a843f89406b57cc8`. Beta, production activation, hosted database changes, payments and new infrastructure remain outside this pass.

## Life Chapters product decision

On October 16 the owner explicitly answered **“Yes—include Life Chapters”** to grouping existing memories across trips without duplicating their text or media. This resolves the product-desire question recorded for H105 in the Memories census §§E.5/J. It does not certify implementation, authorize deployment, or close H104's full compression hierarchy.

The client now has a private Life Chapters screen, reachable from the owner's timeline and owned-memory browse links. It reads the existing owner-derived graph, displays recurring place/companion groupings, and opens the original memories. It stores no copies of descriptions or media and introduces no persistent client cache. Returning to the screen reloads the projection; account changes and focus/unmount invalidate outstanding responses. Partial history and recorded-time dates are disclosed. Failed reads remain errors with retry, not empty-history claims.

Client source: `travel-buddy-standalone/src/services/memoryChapters.ts`, `travel-buddy-standalone/src/features/memories/LifeChaptersScreen.tsx`, and `travel-buddy-standalone/app/memory/chapters.tsx`. Route registration requires authentication and identifies the surface as owner-only. These controls supplement, not replace, server authorization.

## Read only prerequisite verification

The connected project inventory and the repository's production denylist independently identify `travel-buddy` (`ajrurzioarfkagpuxfnb`) as production. October 16 queries ran in explicitly read-only transactions and retrieved configuration, catalog metadata and migration filenames, not user content. No beta database was queried.

| Prerequisite | Observed state | Consequence |
|---|---|---|
| Life Chapters base columns | The graph's selected `memories` columns and `memory_tags.memory_id/tagged_user_id/status` exist | H105's existing legacy projection does not require the new graph-model tables merely to read this shape; this is not a served-endpoint or privilege certification |
| Graph-model migrations 3674–3676 | Absent from the selected production ledger result | Do not claim graph cutover or H104 completion |
| `memory_episodes`, `memory_evidence` | Absent from the public catalog | Episode/evidence-dependent requirements remain gated |
| `protected_zones` | Table exists; no active row exists | The old absent-table description is outdated, but actual protected-zone suppression remains unproved |
| `map_projection_enabled` | No flag row returned | No map gateway activation is assumed |
| Locate, Map telemetry, Memory projection, Trip kernel and Trip operational projections | All five queried flags are false | The corresponding activation-dependent rows cannot move merely from more offline tests |
| Selected migration history | 2217, 2710, 2711 and 2730 filenames exist in the ledger | A historical “unapplied” sentence needs per-row reconciliation, not a blanket promotion |

The exact queried flag names are `locate_friends_enabled`, `map_telemetry_enabled`, `memory_projection`, `trip_kernel_enabled` and `trip_operational_projections_enabled`. The query also returned no `memory_graph_shadow_read_enabled` row. Missing and false are distinguished; neither is permission to enable a feature.

## Acceptance rule

Only a requirement whose complete remaining predicates pass independent review may receive a new local documentary C verdict. A product approval alone, passing mocks, table presence, or a bounded erasure repair is insufficient. The starting local count is **2,506 / 3,518 = 71.23%**; committed-main and deployed-state correctness are separate measures.

## Life Chapters acceptance and evidence

Independent review accepts H105's narrow predicate on the existing legacy-links path. Census §BN records the owner approval, reachable reference-only consumer, privacy validation and limitations; H104 remains W. No new table, migration, external provider or flag activation is needed for this path.

The backend now checks source-row shape and ownership, companion consent, both block directions and read completeness. Deleted/removed memories and withdrawn or blocked participants do not enter rebuilt chapters. It refuses malformed or unreadable input and sends `private, no-store`. Graph-store cutover is not certified by these changes.

Parent validation passes **121 tests across three graph/model files** and **68 tests across six client suites**. The client run includes the new 28 Life Chapters cases, existing browse/detail consumers, and Telegraph attendance/rail neighbors; it is not 68 new tests or independent hosted execution. Independent review separately ran 148 overlapping backend cases and all 28 Life Chapters client cases. Source and focused new-client-test typechecks pass. Native/device behavior and multi-query transactional snapshots remain unmeasured.

H105 is the only accepted promotion at this point in this pass: **2,507 / 3,518 = 71.26%** local documentary C. The result remains uncommitted, unmerged and undeployed.

## Telegraph attendance and review followups

Shared event cards now list visible Going members of the conversation. The server uses canonical RSVP states and the existing event/profile authorization paths; it does not substitute arbitrary profile names. A failure to read attendance is unavailable, not a fabricated empty roster. Event denial removes the whole card, including its title, timing and actions. Review additionally found that private-trip access selected only membership role, omitting the status its predicate intended to check; the read now includes status and requires accepted membership.

The client separates account/session, thread and mount scopes. Late fetches, storage reads and stale acknowledgements cannot populate another scope. Account storage operations are ordered so sign-out cleanup follows already-issued writes and rejects queued revoked writes. Review caught a navigation regression in the first fence: an acknowledgement accepted before unmount could be lost. The repaired write token outlives navigation, but not account revocation, and keeps its revocation listener until the accepted write settles.

**T264 remains W.** The canonical event policy withholds cancelled events from non-hosts. That removes the card from the rail, so an ordinary attendee does not receive the required cancellation promotion across absence. Restoring the denied event would weaken privacy. A separate minimal authorized cancellation/tombstone contract is required. Bounded participant windows, non-atomic authorization/source reads and failed native storage cleanup also remain explicit limitations.

## Memory erasure postconditions and durable retry repair

Both erasure orders now validate mutation responses and positively confirm that episodes are retired and scrubbed or absent, and that owner-scoped evidence is empty. A Memory link is retained until retirement and other evidence deletion are confirmed. Independent review then reproduced a deeper retry gap: deleting the last link could succeed while the confirmation failed, leaving a later attempt with nothing to discover.

The repair records versioned episode/token checkpoints in the existing deletion dead-letter detail field before losing the final link or retiring an unlinked Keep. It introduces **no new database schema**. Checkpoints contain identifiers, not descriptions or media. Capacity is bounded at 32 concurrent checkpoints within the existing 4,000-character limit; diagnostic truncation cannot remove checkpoint state. Conditional writes preserve other/newer checkpoints, failure recording retains them, and completion/moot closure refuses unconfirmed checkpoints. The Keep caller now passes its Memory identity rather than bypassing this recovery path.

Unreadable, missing or malformed checkpoint storage fails closed. The existing dead-letter table and appropriate worker deployment are activation prerequisites; no hosted migration was applied. Complete durable-state loss, writes arriving after final verification and genuine multi-connection database concurrency are not certified. Physical media erasure and other H52/H190 predicates remain open; neither row is promoted.

Independent review accepted the bounded repair after 15 targeted recovery/CAS checks; the worker's 260-test deletion/candidate/scheduler family passed. These are controlled synthetic tests, not evidence of a production deletion having run.

## Final combined validation

- **926 backend tests, 138 suites, 15 files: pass**, no failures, cancellations or skips. Includes graph, deletion/candidate/redrive, event access and Telegraph neighbors.
- **120 client tests, 9 suites: pass**, natural exit. Includes Life Chapters, browse/detail, attendance, scoped rail lifecycle, navigation acknowledgements and existing timing behavior.
- **78 census-guard tests, 19 suites: pass.** These check the documents' mechanical integrity, not the correctness of every historical verdict.
- Final documentary reconciliation passes integrity, freshness (zero stale entries), all 13 scope checks and citation anchors. The pre-existing citation-target debt remains at its unchanged 155/155 ceiling; a passing guard is not a claim that all historical citations or verdicts have been independently verified. The reconciliation worker separately passes 149 overlapping metadata tests across 37 suites without changing grades or guard thresholds.
- API/client source and focused changed-test typechecks pass. Client route registry, import/mock guards, API test registration, static schema-reference checks and whitespace checks pass.
- API build passes; all 31 required OpenTelemetry packages and 12 generated regular-file hashes verify. Existing Expo base-config resolution warnings remain in this symlinked workspace. Final artifact fingerprint: `sha256:1a2647e04ef395af8887d1e684ff6f0884db7713bbbffee5bcee33b94dca3d18`. The artifact was not started or deployed.

Review test totals above overlap earlier and worker runs; they must not be added into a single unique-coverage total. Tests use synthetic records, dummy credentials and local-only servers. No full hosted or real-device acceptance run occurred.

## Remaining gates and handoff

H105 alone moves W to C: **2,507 C / 893 W / 94 N / 24 X = 3,518**, or **71.26% local documentary correctness**, versus 71.23% before this pass. The inspected committed baseline remains 2,504 C / 71.18%; remote main was not refreshed or changed by this pass. The score is not production readiness or an independent re-audit of all 3,518 requirements.

Next exact work: define and test privacy-safe cancellation delivery for ordinary event attendees; distinguish unreadable canonical authorization from known denial in completeness signalling; then revisit complete T264 acceptance. Missing/null trip membership status now refuses rather than retaining the former accidental access. Full Memory erasure still needs its separate storage/media and operational predicates. Before releasing checkpoint changes, verify the existing table and deploy all cooperating cleanup/redrive writers together; mixed old/new writers and total durable-state loss are not certified.

All work remains local, uncommitted and unmerged. No beta work, hosted database write, migration application, flag activation, production deployment, account creation or paid provisioning occurred. Earlier dirty work and the separate Media integration checkout are preserved. The final board is [the architecture correction board](main-architecture-correction-board-20261016.md).
