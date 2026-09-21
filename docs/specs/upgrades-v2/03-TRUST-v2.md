# Trust architecture upgrade v2

Extend existing Trust, identity verification, moderation, restriction, appeal and privacy services for the Sensing integration. Read 00-START-HERE.md and sources/trust-verified-foundation-plan.md. That baseline covers verification and moderation; it is not a complete specification of the Trust scoring model. This document does not invent the missing scoring policy.

## Ownership and existing systems

Reuse canonical Trust events, score projection, caps, restrictions, admin actions, review queues, repair/scheduling and privacy guards. An older inspected checkout contains TrustScoreService, TrustPrivacyGuard, TrustAdminService, TrustCapService and TrustRecoveryService. Locate their current equivalents and actual consumers; their presence does not prove end-to-end functionality.

Keep these concepts separate: verified identity, person Trust/reputation, active eligibility restrictions, source reliability, signal reliability, world confidence, personal fit and venue quality. Never merge them into one score. Preserve current approved behavior while resolving specification gaps.

Authorized domain event → existing Trust ingestion and idempotency → policy/review where required → score/restriction projection → privacy-safe API → authorized consumer.

World observation/anomaly → safety candidate → existing safety authority and review → canonical safety assertion. World Sensing does not directly write person Trust consequences or turn anomaly into danger.

## Upgrade requirements and acceptance

| ID | Required behavior | Evidence required | Basis |
|---|---|---|---|
| TRV2-01 | Passive movement, normal-looking behavior and anonymous contribution do not award or penalize person Trust. | Sensor/aggregate fixtures generate zero person Trust effects; legitimate existing domain events still follow approved policy. | SENSE 16 |
| TRV2-02 | Source/signal reliability is distinct from person Trust. | Shared intelligence APIs cannot silently substitute a person score for evidence confidence; no reverse lookup of anonymous contributors. | SENSE 3, 16 |
| TRV2-03 | Anomalies create only policy-eligible safety candidates, not automatic canonical danger. | Crowd spike alone causes no safety assertion, suspension or reputation penalty; reviewed authorized evidence follows the existing path. | SENSE 16 |
| TRV2-04 | Reuse existing identity verification lifecycle and provider adapter boundaries. | Session→signed webhook→authorized transition→profile→badge works; duplicates and invalid signatures cannot create additional effects. | TRUST V-0–V-2; engineering acceptance |
| TRV2-05 | Preserve verification privacy. | No raw IDs, document numbers, selfies or dates of birth enter Portava storage/logs; only permitted references and derived age eligibility. Mock provider is refused in production. | TRUST privacy invariants |
| TRV2-06 | Domain consequences require the correct actor, subject, event and adjudication. | Disputed/unconfirmed reports cannot be treated as upheld; duplicate deliveries or crashes do not double-charge; admin action is not misattributed to another person. | Engineering acceptance for existing Trust policy |
| TRV2-07 | Retain durable event→projection→repair behavior and honest dependency errors. | Crash/retry/replay produces the approved result; failed reads do not become clean reputation or fabricated denial; scheduler wiring is demonstrated. | Engineering acceptance |
| TRV2-08 | Apply restrictions at actual consuming actions and preserve privacy-safe summaries. | Compass, Discovery, social and booking paths enforce applicable existing policy; public summaries do not reveal reporter identity or private evidence. | TRUST V-3–V-5; SENSE 16 |
| TRV2-09 | Keep admin actions authorized and auditable. | Unauthorized caller cannot override, lift, confirm or dismiss; approved changes record actor, reason and affected subject; concurrency does not lose active restrictions. | TRUST V-4; engineering acceptance |
| TRV2-10 | Preserve revocation, appeal and account-deletion lineage under approved policy. | Verification revocation reaches displays/eligibility; provider deletion is requested; derived effects follow the defined reversal/retention policy without erasing unrelated evidence. | TRUST V-4, V-7; SENSE 18.4 |
| TRV2-11 | Do not fabricate production events to make a measurement pass. | No historical stamp, inferred visit or passive contribution becomes a new award absent an explicitly approved backfill policy; test fixtures stay isolated. | Engineering acceptance |
| TRV2-12 | Keep identity, reputation and confidence presentation semantically accurate. | Verified badge reflects actual verification state; unknown reputation is not silently “established”; source reliability never appears as a person's badge. Exact wording follows owner policy. | TRUST V-2; SENSE 16; engineering acceptance |

## Scoring and policy specification gaps

Before changing scoring behavior, request the authoritative policy for event eligibility, category weights, decay, caps, thresholds, serious findings, recovery, reversals and appeals if it cannot be found in approved documents. Inventory existing behavior as implementation evidence; do not promote it to approved specification automatically.

The reported admin override ambiguity remains an explicit decision: does override pin a score, impose a ceiling, or have another defined meaning? Request the selected semantics, precedence with restrictions, expiry and removal behavior. Preserve existing behavior until resolved; do not silently convert ceiling into pin to close a census row.

Also request unresolved public labels/brand decisions, provider choice and credentials, and retention/reversal policy. The verified-foundation plan's retention values apply to the stated verification records, not automatically to all Trust evidence. Do not rewrite unrelated retention rules.

Missing scoring policy prevents claiming complete Trust specification or 100% correctness. It does not prevent implementing independently specified privacy, authorization, idempotency, wiring and Sensing separation requirements.

## Verification and release

Use isolated fixtures spanning caller/subject asymmetry, concurrent duplicate events, projection failure, stale evidence, invalid signatures, unauthorized admins, revoked verification and appeal outcomes. Test actual consuming routes and real database constraints/RLS where applicable. A mocked provider test certifies only the adapter contract; provider sandbox and production operational evidence remain separate.

Preserve report/block journeys, badges, age gates, Safety Center and existing authorized consumers. Do not enable providers, run historical backfills, alter scoring policy or activate production flags merely to close a requirement. Produce the concrete configuration/release steps and identify the exact remaining owner action.
