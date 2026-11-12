# Trust completion evidence — 2026-11-05

Status: independent engineering prepared in the shared launch checkout; **not deployed or provider-certified**. No production write, feature activation, paid-provider request or policy approval was performed. The canonical census remains 90 C / 15 W / 1 N / 2 X, total 108 (83.3% correct); this report does not turn local tests into production evidence.

## Implemented in this pass

- Added report-linked content actions for posts, comments, messages, Buddy listings, canonical media and events. Reviews retain the existing 3994 command; user sanctions retain their existing report-aware routes. The admin queue now opens the new preview/reason/confirmation flow for all six additional content types.
- Migration **4004_reported_content_audited_removal.sql** rechecks admin, target ownership, current report, and confirmed content/report hashes under locks. A removal and its audit/receipt commit together. An exact retry returns the original receipt; a changed intent is refused. It neither closes the report nor adds an account sanction/Trust penalty. The client retains an uncertain operation for the same session across navigation, and reuses the original operation ID/body.
- Event removal uses the shared event lifecycle decision, archives the event and records the previous state and visibility in `event_activity_log` for the existing appeal/restore authority. The SQL command admits exactly the non-archived states that the lifecycle permits to archive; native tests compare against the authority. Activity, archive, report-linked audit and receipt are atomic. It does not cancel bookings or delete attendance history.
- Media removal makes the canonical asset `removed`, advances its version against in-flight classifier writes, and rejects matching legacy `post_media` aliases in the same transaction. A narrow trigger refuses later legacy publication of terminally removed canonical media even where client RLS hides the canonical row. The API re-drives derived Passport cover/count reconciliation on receipt retry; a failed reconciliation is not reported as completion. No storage object is erased.
- Added direct-client guards against restoring/recreating tombstoned content, lifting a Buddy moderation hold, or widening/reopening archived events. Canonical service-role moderation and account deletion remain possible. No retention period or deletion FK was changed.
- Corrected the legacy post hide endpoint to write `posts.status='hidden'`; `posts.post_status='removed'` is not a valid delayed-publication enum value.
- Added community guidelines, linked them from the Safety hub and Buddy application screens, and made Safety profile-read failures retryable. Existing SOS remains available without guessed country/location. Copy does not promise safety-team monitoring or verified-person safety.
- Added a **public** Account access & appeals route reachable from sign-in errors, plus Safety links. A GoTrue-locked account can open an owner-configured external review destination without authenticating. Authenticated users can reach existing restriction appeals and local-device sign-out. Missing configuration and failed link/sign-out operations are stated honestly.
- Prepared optional HTTPS policy/provider-policy/privacy-contact links on the existing privacy disclosure screen. Configuring a link is an owner release step, not legal approval by this implementation. Without reviewed destinations, the screen continues to say the policy/contact is unavailable; no company, address or legal wording was invented.
- Closed the Wall author-eligibility fail-open: missing/null/unreadable status never defaults to `active`. Affected source lanes report degradation and Following does not claim caught up. The projection gate independently requires active status; quick-media failures and missing moment-participant eligibility are handled too. Server ownership then returned to the Wall agent for its remaining work.

The canonical `place` report has no accountable person. Its governance action belongs to Discovery; the existing `/admin/venues/:id/status` writes `discovery_places` and must not be treated as a canonical `places` action. This mapping was handed to the root Discovery owner.

## Local verification

- **102/102** API/event-lifecycle/native-PostgreSQL cases passed across `reportedContentRemoval`, its native suite, `adminPhase12`, and `eventStateTransitionAuthority`.
- **22/22** of those cases use real disposable PostgreSQL 17.11, with actual enum constraints and roles. They include all six content types, audit rollback, concurrent identical operations, concurrent report closure, stale confirmation, revoked admin, subject mismatch, client privilege refusal, terminal-media resurrection refusal with RLS-hidden assets, event lifecycle parity, event audit rollback, and host direct-write refusal.
- **40/40** native client cases passed: current admin/session confirmation and recovery, privacy links/unavailable states, signed-out account access, failed contact/sign-out handling, Safety links/retry, and the removal service’s unchanged-intent recovery.
- **76/76** focused Wall cases passed before handing the files back to the Wall agent.
- **244/244** broader Trust/emission/maintenance/vocabulary/migration-inventory cases passed. The earlier sandbox-only run could not bind local HTTP; the bounded rerun with localhost allowed passed.
- **121/121** native-runner controls passed after adding the required `content` manifest and CI step. PostgreSQL-native execution is registered in the API package and the existing required native CI job; hosted CI has not been observed.
- Source TypeScript passed in both packages. Existing test-type baselines were not inflated (native 151 diagnostics/58 files, API 860/113 at the initial verification). Shared-checkout changes from other agents can affect later aggregate runs; their current results should be recorded separately.

These are synthetic local checks, not a physical iPhone interaction, a vendor sandbox run, a deployment, or a real moderation action against a person.

## Fresh production read-only evidence

Read on November 5 from project `ajrurzioarfkagpuxfnb`, using catalog/ledger/aggregate queries only:

- `schema_migration_ledger` records 2870, 3705, 3706, 3930, 3933 and 3994 as applied. Old census statements that those migrations are absent are historical, not current blockers. New 4004 remains unapplied.
- `identity_verified_badge_enabled=true`; `moderation_report_capture_enabled=false`. No `identity_verification_enabled` row was returned by the scoped query. No flag was changed.
- `moderation_actions.performed_by` and `report_id` use SET NULL; `target_user_id` still uses CASCADE. Report reporter/resolver/subject foreign keys use SET NULL.
- DOB columns still exist in both `profiles` and `rent_buddy_profiles`. No individual DOB was read.
- Aggregate counts returned zero `stamp_verified` and zero `identity_verified` Trust events, zero Sumsub verification rows, and zero live verified Sumsub rows. This is absence of operational evidence, not permission to fabricate an award or verification.
- The live post enums confirm the delayed-publication enum has no `removed`; Buddy accepts `suspended`. The canonical-media CHECK includes `removed`/`owner_deleted`; the legacy media CHECK uses `pending`/`approved`/`flagged`/`rejected`.

## Concrete owner/provider prerequisites

| Input or release prerequisite | Prepared work and remaining boundary |
|---|---|
| Sumsub account, sandbox credentials, configured ID and ID+selfie levels, webhook secret, and approved market coverage | The Sumsub adapter already exists. Supply secrets through deployment secret configuration, **not chat or a source file**: `IDENTITY_PROVIDER=sumsub`, `SUMSUB_APP_TOKEN`, `SUMSUB_SECRET_KEY`, `SUMSUB_LEVEL_NAME_ID`, `SUMSUB_LEVEL_NAME_ID_SELFIE`, `IDENTITY_WEBHOOK_SECRET`. A real isolated sandbox transcript must cover hosted creation, valid/invalid webhook signatures, status polling, duplicate delivery, market refusal, age refusal, and deletion before the readiness allowlist can change. `IMPLEMENTED_PROVIDERS` remains mock-only; there was no mock-based certification. |
| Reviewed legal policy and operating contact destinations | Configure `EXPO_PUBLIC_PRIVACY_POLICY_URL`, `EXPO_PUBLIC_IDENTITY_PROVIDER_PRIVACY_URL`, and `EXPO_PUBLIC_PRIVACY_CONTACT_URL` only after approval. The full policy still needs actual company identity/address, effective date, markets, age and retention statements. Existing factual disclosure is ready; it is not a substitute for that approval. |
| An operator-owned, externally reachable account-review channel | Configure `EXPO_PUBLIC_ACCOUNT_APPEAL_URL` and confirm who receives/reviews requests and restores an overturned account restriction. The screen works without login and does not send account data automatically. An API allowlist cannot bypass a token that GoTrue already rejects, and this work does not remove auth bans. |
| D-DOB and known-minor handling | Decide whether to remove profile/Buddy DOB collection and use derived adult eligibility, or explicitly approve the separate DOB collection and update the privacy promise. Also decide known-minor account handling and arbitrary event age-range semantics. A privacy-safe event eligibility-preview contract depends on this choice; currently silent event-list omission cannot be truthfully replaced with an invented eligibility claim. |
| D-38b/D-39 and D-REVERSAL | Specify captured-report evidence retention, moderation subject-link behavior on erasure, and reversal/retention for revoked verification, upheld appeals, and account deletion. Current subject CASCADE and retained identity Trust effects must not be silently ratified or changed by this pass. Capture remains disabled. |
| Trust scoring and compatibility ruling | Review `docs/trust/scoring-parameters-for-ratification.md` against current defaults. Twelve parameter families still lack ratification; the no-evidence nullable-score ruling is already implemented and is not reopened. Decide whether personal-fit compatibility may blend Trust (currently weight 8, fallback 50) or must present/rank it separately. No scoring value was changed. |
| Release and real evidence | Review/apply 4004 with target-schema/recovery checks, ship API and app changes, and run the approved device/operator flows. A6 requires a real eligible presence-evidencing stamp award and its Trust event; badge/provider rows require a real current qualifying verification. Those observations cannot be replaced by seeded production history. |

Prior decisions that are **already settled** are not being asked again: Sumsub selection, current-state badge criteria, restriction reach, appeal visibility, safety product direction, and 2870 deployment direction. The input needed now is the configuration, narrower unresolved policy, release execution and authentic evidence described above.

## Release checks for 4004

1. Verify the target has the referenced tables/columns, `moderation_actions.report_id`, canonical-media version/state vocabulary, `event_activity_log`, and the required account/role guards. Inspect the actual 4004 diff and recovery plan; the local fixture is not a full hosted schema clone.
2. Apply through the established migration runner and observe CI/native gates. Do not enable report capture, a real verification provider, or earnings as an incidental part of deploying removal.
3. In an authorized test environment, preview and remove one fixture per type, force an uncertain response then retry the original operation, and verify a single linked receipt with the report still open. Verify media covers and event restoration use their existing authorities.
4. Exercise signed-out account review, privacy links, report confirmation, navigation/session change, and Safety on a physical device. Validate actual operator destinations before declaring those journeys operational.

Trust is not declared fully complete while these owner/provider/release prerequisites remain. The agent continues into Sensing server/privacy work rather than ending the overall assignment.


## Sensing handoff and moderated media follow-through

Independent Sensing engineering continued after the Trust pass; see
`docs/sensing/completion-20261105.md` for the complete 127-row index, the atomic
privacy commands, verification and precise operation prerequisites.

The hosted 4000 Memory source trigger was inspected read-only by the root: it
validates creation/reparenting; it does not withdraw existing Memory copies after
source moderation. `mediaAccess.ts` now checks canonical terminal removal before
owner access, including recorded derivatives. Removed/rejected/owner-deleted
canonical assets and tombstones cannot be served through a retained owner Memory
URL. Ordinary owner processing previews still work. The local media authorization
suite passes (124 cases including the new owner-derivative case in the combined run).
Existing signed URL lifetime still bounds bytes already delivered before removal.

This does not silently decide MD385-Q1: source-post soft deletion/hold and deletion
of an independently created personal Memory are distinct existing policies. The
owner must decide that source-copy lifecycle; no cascade or retention policy was
invented. Terminal canonical media removal itself is now consistently enforced.


## Root integration: community/provider aliases and Saved

Migration4009 now applies canonical holds to direct client reads of community places through a restrictive SELECT policy. The policy checks the canonical link, same-ID canonical shadow and OSM registry reference using the unfiltered registry; owners retain the access needed to retract their own listings. Positive review/vote/community-link writes and trend context use the same provider-alias check. The migration passed 15 real PostgreSQL17 tests, including client roles, owner retraction, provider-only aliases and concurrent moderation admission.

The API guard follows a community UUID through its OSM key even if canonical_location_id is absent. Collection previews now resolve canonical as well as community places, keep unavailable saved rows without title/cover, and key previews by entity type plus ID. The collection/moderation batch passed 101 checks. Other public consumers are still being reviewed; this is not a claim that Trust or deployment is complete.


## Current source-copy privacy follow-through (2026-11-05)

Saved post previews, exact post detail/comments and post-byte reads now recheck the source author's current canonical account restriction and private-account approved-follower audience. A stale public visibility field does not override a newly private account, and removing the approved follow withdraws the source. The batched author gate distinguishes unavailable reads when requested by derived consumers. Post tombstones are checked as well as status.

Post-reference Memory/Highlight admission in unreleased4007 applies the same private-author rule under the database transaction; rendering keeps reading the original source rather than copying its caption or media. New own-post Memory copies refuse terminally removed canonical media and rejected legacy media, including retained moderation-ledger verdicts. Legacy byte moderation now runs before the owner shortcut, including stored derivative references. A current approved attachment after an appeal remains authoritative over its historical ledger. Owner review of flagged media remains available; terminal rejection does not.

Local evidence: **367/367** API/HTTP/SQL-fixture cases passed across postAuthorAudience, memoryFromOwnMedia.pglite, mediaAccess, mediaAccessFailClosed, postVisibilityRead, collectionsPreviewPrivacy, postDestinations, mediaAccessTombstonedMessage and mediaVideoTransport. **12/12** real PostgreSQL17 post-destination tests passed (no skipped tests), including private source approval, revocation and refusal with no item written. API source typecheck passes; API test diagnostics remain860/113 without baseline inflation. The exact native runner count was updated to12. No production change or source-copy deletion policy was applied. MD385-Q1 remains the specific owner decision about soft-deleting an independently created personal Memory when its source post is later hidden or soft-deleted; terminal media removal and current audience restrictions are enforced independently of that decision.
