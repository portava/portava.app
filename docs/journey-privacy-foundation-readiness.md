# Journey Privacy Foundation — Implementation and Gate Report

> **Controlled-rollout supplement (2026-08-21):** The later shadow-only rollout
> controls, deterministic analysis, unified retention, QA evidence path, and
> current zero-collection decision are documented in
> [`journey-shadow-controlled-rollout-report.md`](journey-shadow-controlled-rollout-report.md).
> That supplement supersedes this foundation report where it discusses the
> absence of segmentation or a controlled session-issuance path. It does not
> change the explicit rule that collection remains off without separate owner
> approval.

**Date:** 2026-08-21  
**Scope:** Minimum consent, session-purpose, retention, revocation, account-deletion, monitoring, and rollback foundation for future Journey observations.

## Executive decision

**Live database migration deployment:** PASS. Foundation migrations `2119`
through `2122` and controlled-shadow migrations `2103` and `2123` were applied
through the Supabase Management API on 2026-08-21.

**Five-control-gate foundation decision:** **GO.**

**Operational collection decision:** **NO-GO.**

Consent, retention, revocation/deletion, and monitoring passed controlled live
verification. Account deletion now also passed a full live synthetic execution:
Journey/location rows were erased, Auth was removed, the request was finalized
as `executed`, and a comprehensively scrubbed tombstone remained hidden by RLS.

Both Journey flags remain `false`; there are zero enabled Journey consents, zero
active Journey-purpose sessions, and zero observations. No collector, product
consumer, inference, movement-derived behavior, notification, or Autopilot path
was enabled. Collection still requires separate owner authorization.

## Delivered foundation

### Database and authority

- `2119_journey_observation_foundation.sql` remains intact as the restricted storage foundation.
- `2120_journey_privacy_foundation.sql` adds the privacy controls without activating the feature.
- `2121_account_deletion_tombstone_contract.sql` preserves a minimal profile tombstone without retaining the Auth user.
- `2122_account_deletion_journey_revocation_compat.sql` installs only the deletion RPC and optional-table-safe revocation behavior required by the live schema; it does not create segmentation tables or activate Journey.
- `2103_journey_segment_shadow.sql` and successor `2123_journey_shadow_controlled_rollout.sql` now install the default-off shadow segment, staged rollout, centralized authorization, sealed access, and aggregate QA foundation described in the controlled-rollout supplement.
- `ingest_journey_observation_v1` is the only observation writer:
  - direct `service_role` INSERT on `journey_observations` is revoked;
  - the RPC is `SECURITY DEFINER` and service-only;
  - all three feature-control rows must exist and be in the safe state;
  - explicit, active, versioned `journey_observation_v1` consent is required;
  - the observation timestamp must not predate the consent grant;
  - sharing must not be paused or off;
  - the session must be owned, active, finite, and explicitly created for `journey_observation_v1`;
  - retention state must be fresh and exactly `HEALTHY`, with no retry or deletion lag.
- Accepted rows receive an exact 24-hour expiry. The existing schema hard cap remains 72 hours.

### Consent and session lifecycle

- Journey consent records scope, version, grant time, and revocation time.
- The location-preferences route uses `set_journey_observation_consent_v1`; it no longer writes the Journey consent boolean directly.
- Existing and generic location sessions default to `legacy_location_share`.
- Legacy sessions cannot authorize Journey writes.
- A Journey-purpose session must have a finite expiry.
- Consent revocation, sharing pause/off, preference deletion, session end/expiry/deletion, or Journey-purpose removal immediately makes future writes ineligible.

### Revocation and physical deletion

- Revocation creates durable `journey_revocation_jobs` records in the same database transaction as consent/session state changes.
- Queue claims use `FOR UPDATE SKIP LOCKED`, a bounded lease, and a fresh per-claim token.
- Completion and failure transitions use guarded service-only RPCs that require the current, unexpired claim token.
- Direct service-role queue INSERT and UPDATE are revoked. The service role retains only SELECT and account-deletion DELETE access.
- Deletion retries are bounded to become visible within the five-minute retention cadence.

### Retention and monitoring

- The retention cycle runs every five minutes and always runs independently of Journey feature flags.
- The global cycle is serialized across API instances by `begin_journey_retention_cycle_v1`.
- Beginning a cycle atomically marks durable health `DEGRADED`; ingestion therefore denies while work is in progress.
- `finish_journey_retention_cycle_v1` uses a cycle-token and unexpired-lease compare-and-set. A stale instance cannot publish `HEALTHY` or overwrite a newer failure.
- Missing health, query failure, `DEGRADED`, `FAILED`, `STALE`, pending retries, deletion lag, or a last success older than ten minutes denies ingestion.
- Empty cleanup is a successful zero-row cycle; query/delete/claim/finalization failure is not treated as an empty success.
- Direct service-role mutation of the health row is revoked; the service role has read-only table access and guarded transition RPCs.

### Account deletion

- Account deletion explicitly covers Journey observations, revocation jobs, location sessions/preferences/state/snapshots/trust events, and Trip Crew location tables.
- Observation rows are removed before sessions.
- Preferences and sessions may create revocation jobs through triggers, so revocation jobs are removed last.
- If any Journey/location cleanup step fails:
  - revocation jobs are retained;
  - the deletion result is false;
  - profile/auth deletion and request completion do not occur;
  - the centralized account-deletion execution claim expires for safe retry.
- `journey_retention_health` is not deleted per account because it is a global operator singleton without an owner ID.
- Requests are claimed atomically as `executing` with a random token and
  one-hour lease before destructive work. Cancellation is allowed only while
  `pending`; finalization requires the same token.
- Deleted profiles retain only the structural tombstone and opaque
  `deleted_` handle required by live integrity constraints. Profile PII,
  preferences, visibility, verification, location, and social fields are
  cleared or reset.
- Auth deletion cannot cascade into the tombstone, and deletion requests
  reference the tombstone with `ON DELETE RESTRICT`.
- Direct profile RLS reads exclude `account_status = 'deleted'`.
- A controlled live synthetic execution passed the full cascade, tombstone
  scrub, `executed` request, Auth removal, Journey/location zero-orphan census,
  anonymous RLS denial, and cleanup proof without changing non-synthetic row
  counts.

### Rollback containment

`docs/sql/rollback_2120_journey_privacy_foundation.sql` is an operational containment script, not a destructive schema rollback. It:

- disables both Journey flags;
- revokes active Journey consent;
- ends active Journey-purpose sessions;
- marks retention health `STALE`;
- retains consent history, revocation jobs, and monitoring evidence.

It deliberately does not drop privacy tables or erase pending deletion work.

## Verification evidence

### Automated checks

- API typecheck: PASS.
- Focused Journey privacy suite: **74 passed, 0 failed**.
- Account deletion cascade: **43 passed, 0 failed**.
- Trip Crew location regression: **35 passed, 0 failed**.
- Compass pipeline/privacy regression: **106 passed, 0 failed**.
- Test registration guard: PASS; the new suite is registered in the main API test command.
- `git diff --check`: PASS.
- Independent architecture/privacy review: PASS with no remaining critical, high, or medium finding after remediation.

### Disposable PostgreSQL rehearsal

A temporary local PostgreSQL cluster exercised:

1. minimal prerequisite schema;
2. migration 2119;
3. migration 2120;
4. migration 2120 a second time;
5. versioned consent grant;
6. legacy-session denial;
7. explicit Journey-purpose acceptance through the service-role RPC;
8. permission denial for direct service-role observation INSERT;
9. permission denial for direct service-role queue INSERT/UPDATE;
10. permission denial for direct service-role health UPDATE;
11. consent revocation, immediate session termination, and durable queue creation;
12. queue lease expiry, token rotation, stale-token denial, and current-token completion;
13. overlapping retention-cycle denial, generation rotation, stale-finalizer denial, and failed-cycle visibility;
14. containment rollback;
15. migration 2121 replay, claim/cancellation race behavior, restrictive tombstone FKs, and deleted-profile RLS denial;
16. migration 2122 replay with the optional segment table both absent and present, including atomic revocation, session closure, observation deletion, durable job creation, returned segment count, service-only grants, and flags-off refusal.

Result: PASS.

### Managed API workflow

- Build and restart: PASS.
- Server is running on its configured port.
- Before migration 2120, the worker reported the missing
  `begin_journey_retention_cycle_v1` function and failed closed without crashing.
- After migration 2120, a real empty cycle completed as `HEALTHY`.
- A committed synthetic expired observation was physically deleted on the next
  startup cycle. That cycle correctly reported `DEGRADED` while the newly
  created session-expiry job awaited the next claim timestamp.
- The following cycle completed that durable job in 58.4 seconds and restored
  `HEALTHY` with zero retries, zero lag, and no lease.
- Synthetic data was then removed. Final live state: both flags false, zero
  enabled Journey consents, zero active Journey sessions, zero observations,
  zero synthetic auth/profile/session/job rows, and healthy unleased retention.
- A second controlled synthetic account exercised the centralized account
  deletion service against migrations 2121/2122. It completed with no failed
  steps, retained a comprehensively scrubbed opaque-handle tombstone, finalized
  the request as `executed`, removed the Auth row and all Journey/location rows,
  hid the tombstone from anonymous profile RLS, left both flags false, preserved
  non-synthetic row counts, and removed all synthetic verification residue.

## Five-gate decision

| Gate | Live/deployment evidence | Decision |
|---|---|---|
| Consent | Rollback-only live tests proved missing consent, legacy sessions, paused/off sharing, unhealthy/missing retention, and revocation deny. Explicit versioned consent plus a finite Journey-purpose session was required. Actual direct service-role INSERT was permission-denied. | **GO** |
| Retention | Real worker cycles established `HEALTHY`, deleted one synthetic expired row, exposed its pre-delete age, reported the intervening pending retry as `DEGRADED`, and returned to zero retry/lag. | **GO** |
| Revocation/deletion | Revocation immediately denied writes, ended the Journey session, created durable work, and completed physical cleanup. Rollback-only lease tests proved stale-token denial and retry visibility. | **GO** |
| Account deletion | Live synthetic execution proved atomic claim ownership, comprehensive profile scrubbing, opaque tombstone integrity, Auth removal, `executed` finalization, Journey/location zero-orphan deletion, anonymous RLS denial, and complete fixture cleanup. | **GO** |
| Monitoring | Live and rollback-only checks distinguished `HEALTHY`, `DEGRADED`, `FAILED`, and initial `STALE`; proved atomic global cycle ownership, stale-finalizer denial, lag/retry visibility, and unleased recovery. | **GO** |

**OVERALL PRIVACY FOUNDATION GATE: GO.** Operational collection remains
**NO-GO** and disabled pending separate product authorization.

## Known limitations and explicit non-deliverables

- No client collection or background tracking.
- No API that creates Journey-purpose sessions for product use.
- No Journey segmentation, inference, recommendation, graph, social, notification, or Compass integration.
- No feature flag was enabled.
- The four foundation and account-deletion migrations were deployed to the live Supabase
  database; deployment did not activate collection.
- Focused tests, typecheck, registration, PostgreSQL rehearsal, managed API
  verification, and independent privacy review are green.

## Owner decisions required before any future activation

1. Confirm the 24-hour raw TTL, 72-hour hard maximum, five-minute retention cadence, and ten-minute stale threshold.
2. Separately review and authorize any future client collector and Journey-purpose session issuance.
3. Explicitly authorize feature-flag activation only after every control gate is
   GO.

Until those decisions are complete, the operational collection status remains
**NO-GO** even though the privacy foundation itself is **GO**.