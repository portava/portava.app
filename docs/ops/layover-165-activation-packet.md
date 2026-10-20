# Layover 165 — activation and recovery packet

Updated 2026-10-19. **Preparation only; not approved for execution.** The implementation is still changing. Final commit, migration hashes, PostgreSQL CI, staging evidence and device results must be recorded before this becomes an executable release packet. No hosted migration, feature activation, credential creation or paid provider request was performed by this continuation.

The unchanged acceptance baseline is [layover-built-but-wrong-20261018.md](layover-built-but-wrong-20261018.md). Current row evidence is in [the tracker](layover-165-remediation-progress.md) and [verification ledger](layover-165-final-verification.md). A green local test does not establish production activation.

## Release authority and prerequisites

The existing owner packet is `/Users/areyouok/portava-sandbox/prod-apply-packet-20261017/README.md`, with `packet-full/` and its subsequent addenda. It records the activation freeze D-OWNER1004-10 and held migrations3601/3602 under D-OWNER1004-14. The current directive authorizes implementation and release preparation; the production press remains the owner's explicit action.2481 remains excluded because Sensing uses Option B. Do not apply an unreviewed numeric range or equate backfill ledger presence with an applied migration.

Before release, reconcile this branch against the existing packet's pinned commit and re-read the target's actual catalog, migration checksums, flags and grants. Preserve its recovery snapshots and owner holds. The old packet's296-file count is historical and does not include this entire continuation.

Use the existing [beta runtime workflow](beta-runtime-runbook.md) and [beta database runbook](../supabase-beta-runbook.md) for staging. Their project-binding, invite-only configuration, no-reset default and readback checks remain mandatory. An unknown or failed prior bootstrap is not permission to reset a database. Production must carry `PORTAVA_DEPLOYMENT_ENV=production` before a deployment containing the runtime environment guard.

## Measured beta state, 2026-10-19

Read-only checks confirmed the existing `portava-beta` project `emfpckykpzfturllshly` is ACTIVE_HEALTHY on PostgreSQL17.11. Its migration ledger, flags, Layover sessions and certified computations exist; `layover_objective_facts` is absent. This is an existing partial schema, so a fresh bootstrap cannot be assumed safe.

The established beta status command reported the latest bootstrap run38057476281 failed, configuration run38699847556 failed, Supabase Auth currently has `disable_signup=false`, and the expected beta API returns404 (“This app isn't live yet”). Six of its seven read-only smoke checks fail. The configuration workflow has not established the protected-profile gate, and no tester creation or native distribution evidence was found. The source logs are `beta-status-readonly.log` and `beta-catalog-readonly.json` under the continuation evidence directory.

The bootstrap failed at the dry-run step because its shell exited on the two expected refused-by-shape files2182/2190. The current workflow already contains the explicit error-capture repair and an APPLY-PENDING-BETA mode that never resets and defaults to a read-only dry run. The configuration failure names157 policy flags absent from the partial database; it is not evidence that the configuration was applied. Before hosted journey validation, reconcile the partial catalog through that incremental workflow on the pinned code. If an actual schema reset remains necessary, it is a separate destructive owner decision; this continuation has not requested or executed one. Close beta sign-up through the established beta configuration workflow, pass its profile boundary gate, and deploy the isolated beta API before inviting testers. Existing test failures are not permission to create users, reset a database or bypass release checks.

## New and extended migration families

Every new capability seed is FALSE. Apply forward files using the repository's declared dependency order and retain checksum/transaction evidence. Complete the underlying canonical, lifecycle, constraints, Safe Return, identity, payment, presence and observation prerequisites in the original owner packet before enabling their dependants.

| Family | Files | Activation dependency |
| --- | --- | --- |
| Flight connections |3826,3827,3828 | Trips flight segments, connection detection and canonical snapshot storage; licensed feed separately required for automatic observations |
| Recommendation history and canonical state |3871,3873,3896 | Stable recommendation IDs, persisted decisions and constraints/lifecycle gates |
| Airport curation |3874,3880 | Authorized provenance/expiry publication and actual calibration evidence |
| Crew plans and consent |3872,3875,3996 | Explicit pair consent, sharing policy, expiration worker and tested location permissions |
| Sourced timing and activity |3881,3907 | Work in progress; validated source distributions/activity commitments;3907 follows3899 |
| Service audit |3890 | Apply all protected Layover schema first; audit identity wrapper and worker scopes must be deployed before activation |
| Safe Return and specialist booking |3893,3894 | Canonical safety/time contract; existing verification/trust/payment/availability gates; no unverified production services |
| Route watches |3895 | Stable canonical/status gates and private HMAC key; durable fanout3908 must complete before the final route-event activation |
| Compass execution |3897 | Explicit user approval, owned current snapshot/revision and retained execution result |
| Executable experience lifecycle |3898 | Owned immutable plan versions, exact selected contract and client cache readiness |
| Objective evidence |3899 | Authorized immutable source facts and private traveller preferences; empty evidence stays UNKNOWN |
| Durable route fanout |3908 | Work in progress; leased, bounded, atomic per-session settlement and completion only after all work settles |

3890 installs audit triggers on tables present at activation. After any subsequent Layover schema addition, repeat the supported activation/install step and verify exact trigger coverage before traffic. Trigger installation and the flag change must commit atomically. Leaving the audit switch OFF does not stop deletion of already-expired audit evidence. Retention health must disclose backlog; outages can delay physical deletion beyond its30-day deadline.

## Provider and runtime configuration

Store actual secrets only in the established server/build secret stores. The following are names and obligations, not fabricated credentials.

| Integration | Required configuration and proof |
| --- | --- |
| Google Routes | Existing approved Google project, enabled Routes API, restricted `GOOGLE_MAPS_API_KEY`, explicit `LAYOVER_ROUTED_CORRIDOR_ENABLED`, database routed capability and existing price/quota/request/session/person budgets. Verify successful and refused requests on staging without changing those budgets. |
| Continuous walking coverage | Separately enabled Isochrones API, account/preview eligibility, `GOOGLE_ISOCHRONES_API_KEY`, explicit `LAYOVER_GOOGLE_ISOCHRONES_ENABLED=true`. WALK contours use the shared budget. Future-departure DRIVE coverage is unavailable in the implemented provider contract. |
| Maps | Restricted build keys `GOOGLE_MAPS_IOS_API_KEY` and `GOOGLE_MAPS_ANDROID_API_KEY`, corresponding Maps SDKs and rebuilt native app. Web requires restricted `EXPO_PUBLIC_GOOGLE_MAPS_WEB_API_KEY` and Maps JavaScript API. Missing native managers or keys must show the named fallback. |
| Route-event identity | Stable private random `LAYOVER_ROUTE_SUBJECT_HMAC_SECRET` of at least32 characters. Never expose it to the client. Rotation changes route identities and needs controlled regeneration of active watches before new producer events use that key. |
| External airport/flight events | Approved/licensed actual feed, deployed authenticated producer and `LAYOVER_EVENT_PRODUCER_SECRET`; source identity, timestamps, expiry, conflict and deduplication checks. A traveller report is supporting evidence, not authoritative safety clearance. |
| Metrics | Existing logs and configured Sentry remain usable. Optional `METRICS_PUSHGATEWAY_URL` must receive replacement gauges for the current window. `LAYOVER_METRICS_INTERVAL_SECONDS` accepts60–86400, default300. Test collection failure, missing inputs, alert cooldown and export failure. |
| iOS notifications | Approved Time Sensitive entitlement, signed physical-device build and `PUSH_IOS_TIME_SENSITIVE_ENTITLED` only after actual entitlement verification. |
| Language review | Qualified reviewers must sign the per-language packet; current templates have no native-speaker review claim. |
| Airport sources | Curators must publish actual terminal/gate/checkpoint coordinates, topology, timing, restrictions and expiry evidence. No real-airport geometry or operational source facts were invented to populate empty stores. |

### Route retention remains an activation blocker

The map change removes raw Google route/contour geometry from persistent recommendations, audit metadata and client cache envelopes. That is a tested geometry boundary, not a determination that every retained scalar is permitted. Google's [Routes policies](https://developers.google.com/maps/documentation/routes/policies) restrict caching; its [service-specific terms](https://cloud.google.com/maps-platform/terms/maps-service-terms) identify specific exceptions. The applicable agreement and billing region must be reviewed before enabling retained provider-derived fields.

Concrete remaining paths: the cross-request memo in `googleRoutesCorridorProvider.ts`; persisted `plan_json.routing` in `LayoverRecommendationStatus.ts`; compiled experience versions written by `LayoverExperiencePlans.ts`; client scalar/abort caches in `layoverPlanCache.ts`; and compiled timing/return fields in `layoverExperienceCache.ts`. Obtain an applicable retention permission or implement a compatible provider/retention design across all of these paths. Do not treat geometry exclusion as approval for duration, conveyance or derived-timetable retention. This also constrains completion of offline navigation; exact cached timetable readiness alone does not prove full offline turn-by-turn navigation.

## Required evidence before the owner press

1. Pin the reviewed commit and every forward/rollback file hash after all active lanes finish. Verify both ordinary order and installation after3999 on the exact bytes.
2. Run all repository gates and the full suite; run the actual PostgreSQL database job with zero skipped tests. The earlier flight commit's CI failed and is not release evidence.
3. Apply to the isolated staging target through the established pipeline, certify actual catalog/constraints/grants/RLS/flags, refresh the production-readiness snapshots only from measured data, and retain query/inventory checks.
4. Exercise the full traveller journey: session and flight connection, entry refusal and eligibility, window, recommendations and blocked cards, selection/cache/start, changed/delayed/cancelled flights, stale recovery, offline restore, crew consent/expiry, conflicting reports, Safe Return, airport re-entry and closure. Include foreign-owner, failure and concurrent-update cases.
5. Verify actual provider and device integrations and obtain human language review. Observe metric exports, audit actor separation, retention backlog, event leases/retries, account erasure and rollback refusal controls.
6. Record the exact flag diff for the intended cohort, with dependencies enabled before dependants and independently read back. No blanket enablement. Obtain the owner's production approval for that pinned packet and use the established production safeguards.

## Recovery

Disable the affected capability through the audited control path and retain evidence. Do not delete feature-flag history to make a rollback pass. Pause new work before changing event consumers or route-identity keys; let leases settle or use the reviewed recovery procedure once3908 is complete.

The rollback companions under `db/rollback/` refuse active flags, retained feature data/audit history, partial installations and changed owned catalog objects. Their refusal is intentional. After production use, roll forward or restore through the reviewed recovery plan; do not force a destructive schema rollback or add CASCADE. Empty isolated roundtrips prove reversibility before use, not permission to erase a used feature.

The final verification ledger must separately record implementation, staging, production activation and external evidence. Until all original criteria are proven, the status remains incomplete.
