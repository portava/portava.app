# Journey Controlled Shadow Rollout — Evidence Handoff

**Date:** 2026-08-21  
**Scope:** Internal-only, explicitly consented Journey observation collection and deterministic shadow analysis.  
**Product influence boundary:** Shadow evidence is not available to product consumers and cannot change recommendations, ranking, notifications, Autopilot, itineraries, social matching, analytics, training, or any user-facing response.

## Executive decision

**Privacy and rollout controls:** Ready for an owner-approved internal shadow stage.

**Managed schema deployment:** **PASS.** Migrations `2103` and `2123` were
applied and verified on 2026-08-21 without activating collection.

**Current collection:** **OFF.** No stage or cohort has been approved, and no
Journey capability flag was enabled as part of this work.

**Shadow-quality rating:** **INSUFFICIENT — ZERO AUTHORIZED SAMPLES.**

**Broader collection:** **BLOCKED** until an owner explicitly approves a finite
stage and account cohort, QA supplies deliberate truth records, the resulting
aggregate evidence is reviewed, and retention remains fresh and healthy.

**Behavior/pattern inference: no.** This rollout does not implement or authorize
behavioral inference, latent-needs inference, traveler-rhythm models,
personalization, social trajectory, or product decisions.

## Latest preflight — evidence window remains blocked

On 2026-08-21, a fresh read-only preflight of the configured internal QA
account confirmed that it is not currently eligible for Journey collection:
current versioned Journey consent is not enabled and its location mode is not
authorizing. The three Journey capability flags remain off, the global location
emergency stop remains off, and there are no active stages, cohort assignments,
or issued Journey sessions. Retention was fresh and `HEALTHY`.

No account setting, consent record, location mode, capability flag, stage,
cohort, session, observation, derived row, or truth record was changed by this
check. The owner chose to keep the evidence window blocked until a named
internal tester independently opts in and the owner later approves finite
rollout controls.

## Controlled rollout boundary

- Three service-controlled stages exist: `internal`, `qa`, and `consented`.
- Stages are finite (maximum 30 days), carry server-verified admin approval, and
  have non-overridable active-account caps:
  - internal: 10 accounts;
  - QA: 25 accounts;
  - consented: 50 accounts.
- Cohort assignments are finite, cannot outlive their stage, and a revoked
  assignment is never reactivated.
- Observation sessions are issued only by the service through an admin-only
  path, are tied to one active assignment, and expire within 24 hours.
- The global stop disables every Journey capability flag, stops stages, revokes
  cohorts and issuances, ends sessions, and erases raw observations, segment
  revisions, and supplied truth data.
- All capability flags remain default-off. The rollout migration seeds the
  segmentation-shadow flag as `false` and never enables any flag.

## Single authorization authority

`journey_shadow_authorize_v1` is the uncached SQL authority used by:

1. observation ingestion;
2. raw observation reads for shadow segmentation and authorized QA;
3. derived segment writes.

Every decision re-reads and fails closed on:

- missing or disabled master, ingestion, or shadow flags;
- the global location emergency stop;
- missing, stale, failed, degraded, lagging, or retrying retention health;
- absent, revoked, or wrong-version consent;
- disabled preferences, pause, or a non-authorizing location mode;
- absent, inactive, expired, or unapproved stage/cohort state;
- wrong session owner, purpose, type, assignment, issuance, time window, or expiry;
- invalid operation, source, or observation time.

Direct service-role inserts into raw, derived, stage, cohort, issuance, truth,
and report tables are prohibited. Legacy v1 ingestion and segment-append RPCs
are not executable by the service role.

## Deterministic shadow analysis

- Each accepted input carries a versioned deterministic quality score, quality
  class, and sorted reason codes.
- Stale, future-dated, highly inaccurate, or impossible-speed inputs receive an
  `unusable` quality class. They are persisted as raw evidence so that QA and
  report aggregate paths can measure these failure-mode distributions, but they
  are explicitly excluded from GPS segmentation at read time.
- Segmentation is deterministic and revision-safe, with explicit movement,
  candidate-stop, dwell, departed, and discarded states.
- Timing uncertainty, quality summaries, confidence, reason codes, and
  provenance are stored without exact coordinates or raw observation IDs.
- Place/category resolution requires repeated consistent canonical evidence.
  Insufficient or ambiguous evidence remains explicitly `unknown`; coordinates
  are never used to invent a place.
- Replaying identical evidence is idempotent. A new algorithm version creates
  attributable revisions rather than mutating history.

## Lifecycle protection

- Raw observations expire after 24 hours.
- Derived segment revisions and deliberate truth records have finite expiry.
- One five-minute retention cycle purges raw observations, segment revisions,
  and truth records and publishes separate deletion counts plus aggregate health.
- Authorization requires the unified retention row to be fresh and exactly
  `HEALTHY`, with no expired backlog, lag, retry, or consecutive failure.
- Consent/pause/mode revocation acquires the Journey advisory lock, revokes
  cohort/session authority, ends issued sessions, and erases sensitive data.
- Session revocation synchronously erases session-scoped raw and derived rows.
- Cohort revocation erases raw, derived, and truth data while retaining a
  revoked control-history row.
- Account deletion ends issued sessions; erases raw, derived, and truth data;
  physically removes assignments and issuance records; and remains compatible
  with the retained-profile-tombstone account-deletion contract.
- Public/authenticated table access is denied by grants plus forced RLS.

## Internal QA evidence

The admin-only QA workflow:

- scopes evidence to exact service-issued session IDs, never to all activity by
  a cohort user;
- re-authorizes each raw read before transient processing;
- compares deliberate ground truth with current shadow revisions;
- calculates aggregate arrival, departure, dwell, place/category, false-stop,
  false-dwell, confidence-calibration, sampling-gap, jitter-distance, and
  impossible-speed evidence;
- persists and returns aggregates only.

Precise coordinates are used transiently only after authorization to calculate
distance aggregates. Coordinates, raw rows, user IDs, session IDs, assignment
IDs, and per-case values are not persisted in QA reports, returned by the report
API, or written to operational logs.

## Automated privacy-regression evidence

The registered Journey suites cover:

- quality determinism; unusable inputs accepted for distribution measurement but excluded from segmentation;
- movement smoothing, stop/dwell thresholds, sparse sampling, uncertainty,
  place ambiguity, replay, and revision attribution;
- single-authority denial for flags, consent, cohort, issuance, ownership,
  preferences, pause/mode, source/time windows, and retention;
- concurrent/idempotent ingestion and append-only derived writes;
- retention lease ownership and per-table purge evidence;
- consent, cohort, session, global-stop, and account-deletion erasure;
- SQL permissions and forced-RLS boundaries;
- aggregate-only QA and session-scoped evidence;
- static negative scans across Compass, Discovery/City Pulse, notifications,
  Autopilot, plans/itineraries, social/matching, analytics/telemetry, model
  training, and every public/user-facing GET route.

No test or migration enables a Journey capability flag.

## Rollout census and measured distributions

This report records the truthful zero-collection baseline. No synthetic
observation was committed to the managed database for this handoff.

| Evidence | Actual |
|---|---:|
| Owner-approved stages | 0 |
| Active cohort assignments | 0 |
| Active issued Journey sessions | 0 |
| Accepted observations | 0 |
| Shadow segment revisions | 0 |
| Ground-truth samples | 0 |
| QA reports | 0 |
| Quality distribution | No samples |
| Arrival/departure/dwell distributions | No samples |
| Place/category unknown rate | No samples |
| False-stop/false-dwell rate | No samples |
| Confidence calibration | No samples |
| Jitter/impossible-speed/sampling-gap distributions | No samples |

The final post-migration retention census was `HEALTHY`, with zero pending
retries, zero consecutive failures, no expired backlog, no deletion lag, and
zero raw, segment, or truth deletions. Direct service-role table privileges on
raw observations and derived segment revisions were absent.

## Known failure modes and blockers

1. **No owner approval:** without a finite approved stage and assignment,
   authorization denies collection.
2. **No quality evidence yet:** zero samples means shadow quality cannot be
   rated as promising or ready.
3. **Retention degradation:** any stale heartbeat, lease overlap, failure,
   backlog, retry, or lag blocks collection and shadow processing.
4. **Sparse or low-quality sampling:** stale, inaccurate, impossible-speed, or
   large-gap evidence is excluded and may prevent a stop/dwell claim.
5. **Place ambiguity:** absent or inconsistent canonical references stay unknown.
6. **Stage caps:** concurrent assignment is serialized and denied at the
   service-controlled cap.
7. **Revocation:** pause, mode change, consent withdrawal, session end, cohort
   stop, global stop, or account deletion immediately removes authorization and
   erases applicable sensitive rows.
8. **Grant-cutover ordering:** one pre-restart worker cycle failed closed after
   the migration revoked its legacy direct-table access. With every capability
   flag off and zero Journey rows, no data was accepted or stranded. The first
   cycle after restarting onto the RPC-only worker returned durable health to
   `HEALTHY` with zero retries or backlog.

## Readiness rating

| Boundary | Rating | Reason |
|---|---|---|
| Privacy foundation | Ready | Fail-closed consent, session, retention, revocation, deletion, RLS, and emergency-stop controls are implemented and tested. |
| Controlled internal shadow | Ready for explicit owner approval | A finite, capped, reversible internal stage can be issued without enabling product consumers. |
| Shadow quality | Insufficient | There are zero approved observations and zero deliberate truth samples. |
| Larger consented shadow | Blocked | Requires evidence from earlier explicitly approved stages and a new owner approval. |
| User-facing Journey features | Out of scope / blocked | No public read or product-consumer path exists. |
| Behavior/pattern inference | **No** | Not implemented, not evaluated, not authorized. |

## Required next owner action

If the owner chooses to begin measurement, approve only an `internal` stage
with named internal accounts, keep all three Journey capability flags off until
the stage/cohort/session records and consent are verified, then enable only for
the approved measurement window. Review the aggregate QA report and retention
health before any later stage. No stage transition is automatic.