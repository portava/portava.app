# Sensing completion audit — 5 November 2026

Server/privacy lead: `/root/trust_completion`. Client/Maps lead: `/root/wall_completion`.
Root owns Discovery integration; Telegraph lead owns message/live-reference consumption.
This report covers the current spec and indexes every canonical census row. It distinguishes
implemented and locally verified work from operator, policy and real-device evidence.
Nothing here certifies a deployment or enables collection/publication.

## Engineering completed in this pass

| Boundary | Concrete change | Proof |
|---|---|---|
| Session admission and abuse budget | Migration 4006 combines current session/flag checks, replay detection, insert and budget charge. Expiry is read after acquiring the lock. | Same credential races, cross-credential replay, last-budget replay, rollback, queued revocation and flag-off tests on disposable PostgreSQL 17.11. |
| Publication privacy | A compare-and-set publication command locks the cohort and checks the durable predecessor before inserting; conflicts reread and reevaluate the existing differencing policy, bounded to three attempts. | Two publishers cannot both publish adjacent counts against an empty history. No blind-insert fallback. |
| Recent erasure | POST `/api/v1/sensing/revoke` accepts recent epoch preimages and an optional opaque credential; removes matching rows and revokes that credential in one transaction. It remains usable with collection OFF and returns 204 without counts. | Proof-only HTTP route, malformed/identifying/oversized input, unknown database response, idempotency, in-flight ingestion and owner-isolation tests. |
| Location and independence | Ingest enforces the existing six-character spatial ceiling and consistent declared precision. Arbitrary device group labels are refused, because hashing a label does not establish independent evidence. | Fine/mismatched bucket and forged-group HTTP tests. Current client requires neither a group tag nor finer precision. |
| Read integrity | Cohort completeness requires an exact count matching the returned rows. Null/malformed publication reads refuse; malformed cohort listings refuse. Schema presence is cached per client. | Partial-count/malformed-response and distinct-database tests. |
| Client lifecycle | The other Sensing lead repaired background/account/withdrawal shutdown, transport aborts, late callbacks, acoustic source cleanup and secure secret persistence; explicit deletion preserves a durable pause until server confirmation and secret rotation succeed. | See the client lead's mounted/service proof; real hardware remains a separate release check. |

The current `collect`/`retain`/`aggregate` scope remains the minimum for storing into the
anonymous aggregate store. The current policy does **not** grant `surface`; publication
and presence flags remain OFF. No anonymous record receives a session hash, profile ID,
account FK or raw sensor stream. The existing social/personal location path is separate.

Erasure does not retroactively remove already published de-identified aggregates: the
existing lineage policy retains those only to their existing expiry. New aggregation no
longer counts deleted rows. Anonymous sensing still does not directly create a personal
ExperienceSession or Memory. The identified intel path retains its separate, canonical
erasure/recompute/session-reach contract.

## Validation

- 825/825 local Sensing, media-authorization and native-runner tests passed, with no skips.
  This includes 13 actual PostgreSQL admission/publication/erasure tests and all Sensing
  test files. Later documentation/postcondition work receives a final focused rerun.
- 234/234 additional world/experience, Vibe, Flow, Forecast, Opportunity, Attention and
  retention regression tests passed, with no skips.
- API source TypeScript passes. Test-type baseline remains 860 diagnostics in 113 files;
  no baseline was increased. Route-auth, migration prefix/session-state and
  SECURITY DEFINER oracle checks pass.
- The main API test script registers both new test files. `test:sensing-privacy-native`
  and a required CI step run the real PostgreSQL suite; the native runner rejects skips.
- Migration 4006 is prepared, not applied. No production writes, flags or provider
  activation were performed. Local DB fixtures are synthetic and socket-only.

Artifacts: `/tmp/portava-sensing-final.log`, `/tmp/portava-sensing-engines.log`,
`/tmp/portava-sensing-final-types.log`, `/tmp/portava-sensing-oracles.log`.

## Fresh operation facts

Root's Nov5 read-only production metadata confirms migrations 2277, 2278, 2315, 2340,
2480, 2841, 2956, 2962, 3002, 3003, 3004, 3110, 3310–3315 and 3703 applied. Migration
2481 remains intentionally absent under Option B. The custom schema ledger is the
source of these facts; old September missing-schema statements are stale.

`sensing_consent_split_enabled`, `sensing_presence_context_enabled` and
`sensing_publication_enabled` are false. `experience_session_enabled`, `memory_projection`,
`discovery_candidate_projection_enabled`, `intel_coverage`, `intel_pattern_learning` and
`intel_retention_sweep_enabled` are true. `intel_contribution_retention_enabled` is false.

At 2026-11-05 08:30:16 UTC, a normal verified HTTPS request to
`https://rumazi.com/api/healthz` returned HTTP/2 200 and HSTS with includeSubDomains
(edge 63072000 seconds, application 31536000 seconds). This supplies the served TLS/HSTS
half of S17. It does not establish the project's encryption-at-rest controls.

## Required decisions, configuration and release evidence

1. Approve the concrete split capture/upload/surface disclosures in
   `docs/contracts/sensing-consent-split-v1.md`, including the explicit erasure copy.
   The UI remains separated and revocable. Do not silently broaden the current policy.
2. Supply a stable dedicated `SENSING_CONTRIBUTOR_PEPPER` via the secret manager, with
   evidence of configuration rather than exposing the value. Rotation must account for
   still-live old rows; unrelated session-secret rotation must not change these tokens.
3. Decide the public-surface policy and the source of attested independence. Existing
   anonymous device submissions earn zero group credit until genuine grouping evidence
   exists. Merely enabling flags, or letting devices pick group labels, is insufficient.
   Device attestation/unattested-device exposure remains the staged Option B decision.
4. Apply/review migration 4006 through the normal release path, then certify actual
   device contribution, retry, background/account switch, withdrawal, deletion and
   retention behavior before enabling any collection. Real-device location/motion/audio
   performance and permission behavior cannot be proved by synthetic fixtures.
5. OD-MAP-7 already approved a 180-day identified-contribution maximum. The remaining
   action is the authorized retention rollout and observed sweep evidence, not a new
   retention ruling. Anonymous retention remains 24 hours by default, capped at 72.
6. Capture an eligible cohort publication, a safety-precedence scenario, and a permitted
   ExperienceSession→outcome→Memory lineage with the relevant live controls on. Existing
   enabled projection flags remove old deployment blockers; flags alone are not proof.
7. Supply project-specific encrypted-at-rest evidence for S17 and the shadow-calibration
   artifacts required before aggressive forecast/Vibe surfacing.

These are concrete prerequisites. No percentage is raised merely from a local test or a
feature flag. The recorded census remains **113 C / 13 W / 1 X = 127** until reviewed
acceptance evidence changes the appropriate row. The matrix below is a coverage index,
not 127 new production certifications.

## Complete row coverage index

| Row | Recorded grade | Requirement | Validation/owner boundary |
|---|---|---|---|
| S1 | C | No second intelligence truth store or second lifecycle | Reused server contracts and controlled regression coverage |
| S2 | C | No second place identity | Reused server contracts and controlled regression coverage |
| S3 | C | No second social presence model | Reused server contracts and controlled regression coverage |
| S4 | C | Preserve null/unknown when canonical fact is unavailable | Reused server contracts and controlled regression coverage |
| S5 | C | Do not weaken existing privacy / authz / safety / GPS stripping | Reused server contracts and controlled regression coverage |
| S6 | C | Existing Map/Discovery/Wall/Compass keep functioning while new projections are partial or gated | Reused server contracts and controlled regression coverage |
| S7 | C | Busy ≠ good | Reused server contracts and controlled regression coverage |
| S8 | C | Crowded ≠ unsafe | Reused server contracts and controlled regression coverage |
| S9 | C | Rapid movement ≠ dancing | Reused server contracts and controlled regression coverage |
| S10 | C | Inference ≠ observation | Reused server contracts and controlled regression coverage |
| S11 | C | Prediction ≠ current truth | Reused server contracts and controlled regression coverage |
| S12 | C | No coverage ≠ quiet | Reused server contracts and controlled regression coverage |
| S13 | C | One device ≠ a crowd | Reused server contracts and controlled regression coverage |
| S14 | C | Promotional claim ≠ observed reality | Reused server contracts and controlled regression coverage |
| S15 | C | World anomaly ≠ safety incident | Reused server contracts and controlled regression coverage |
| S16 | C | User dislike ≠ bad venue | Reused server contracts and controlled regression coverage |
| S17 | X | TLS in transit and encrypted storage at rest | Public TLS/HSTS observed; project at-rest evidence required |
| S18 | W | Short-lived rotating contribution identifiers; no stable anonymous tracking id | Server privacy/lineage regression; rollout evidence remains where W |
| S19 | W | World-intelligence contribution records carry no permanent profiles.id / user FK | Reused server contracts and controlled regression coverage |
| S20 | C | Separate contribution eligibility from ingest; ingest receives an opaque short-lived credential | Server privacy/lineage regression; rollout evidence remains where W |
| S21 | C | Raw precise location reduced on-device or in a narrow trusted boundary as early as practical | Server privacy/lineage regression; rollout evidence remains where W |
| S22 | C | Sensitive-location and rare-path suppression | Client lead lifecycle/consent work; hardware proof required |
| S23 | C | Cohort thresholds and minimum independence requirements | Server privacy/lineage regression; rollout evidence remains where W |
| S24 | W | Anti-differencing controls and rare-path suppression | Server privacy/lineage regression; rollout evidence remains where W |
| S25 | C | Purpose-scoped authorization: collect / retain / aggregate / infer / personalize / surface / share are distinct permissions | Server privacy/lineage regression; rollout evidence remains where W |
| S26 | W | Raw contribution retention short; aggregate retention per explicit policy | Server privacy/lineage regression; rollout evidence remains where W |
| S27 | C | Social location never silently becomes anonymous crowd intelligence, and vice versa | Reused server contracts and controlled regression coverage |
| S28 | C | On-device feature extraction: spatial/temporal bucket, movement_state, motion_energy, periodicity, dwell_bucket, transitions, transport-mode, sensor health | Client lead lifecycle/consent work; hardware proof required |
| S29 | C | Coarse acoustic energy/rhythm only under separate explicit permission | Client lead lifecycle/consent work; hardware proof required |
| S30 | C | IntelligenceContributionSession: rotating credential, purpose_scopes, precision_ceiling, sampling_policy, retention_policy, privacy_budget, expiry, revocation | Server privacy/lineage regression; rollout evidence remains where W |
| S31 | C | Search for and extend existing consent/session/device-authorization structures rather than duplicating | Client lead lifecycle/consent work; hardware proof required |
| S32 | W | Signal Ingest API with schema validation | Server privacy/lineage regression; rollout evidence remains where W |
| S33 | C | Replay/idempotency protection and rate limiting per credential/device boundary | Server privacy/lineage regression; rollout evidence remains where W |
| S34 | C | Ingest fails explicitly; never returns a plausible empty world | Server privacy/lineage regression; rollout evidence remains where W |
| S35 | C | Reject impossible timestamps, malformed precision, invalid purpose scopes, stale credentials | Server privacy/lineage regression; rollout evidence remains where W |
| S36 | C | No precise GPS in canonical event payloads | Server privacy/lineage regression; rollout evidence remains where W |
| S37 | C | A crew / tour group / bus / duplicated devices are not independent confirmations | Server privacy/lineage regression; rollout evidence remains where W |
| S38 | C | Track coverage separately from estimated activity | Server privacy/lineage regression; rollout evidence remains where W |
| S39 | W | Presence engine → PresenceObservation + coverage; must not claim public person identity | Reused server contracts and controlled regression coverage |
| S40 | C | Crowd engine → CrowdState (density, momentum, arrival-departure balance); must not claim safety or quality | Reused server contracts and controlled regression coverage |
| S41 | C | Flow engine → FlowState/edges; must not claim individual trajectory | Reused server contracts and controlled regression coverage |
| S42 | C | Vibe engine → VibeState; must not claim literal behaviour without sufficient evidence | Reused server contracts and controlled regression coverage |
| S43 | C | Experience engine → ExperienceState; must not treat personal preference as world truth | Reused server contracts and controlled regression coverage |
| S44 | C | World Dynamics → WorldState/WorldMoment (change, anomalies, hotspots, rhythm); must not claim cause when unknown | Reused server contracts and controlled regression coverage |
| S45 | C | Forecast → ForecastState with calibration; must not be presented as observed current fact | Reused server contracts and controlled regression coverage |
| S46 | C | Opportunity → OpportunityProjection; must not claim canonical world truth | Reused server contracts and controlled regression coverage |
| S47 | C | Product surfaces consume projections; they do not reimplement engine logic | Reused server contracts and controlled regression coverage |
| S48 | C | Canonical truth classes: OBSERVED / CORROBORATED / INFERRED / PREDICTED / CONFLICTING / STALE / UNKNOWN | Reused server contracts and controlled regression coverage |
| S49 | W | Every server-built state consumed by Map/Discovery/Wall/Compass carries truth class, confidence, freshness and coverage | Reused server contracts and controlled regression coverage |
| S50 | C | Prediction never rendered indistinguishably from observation | Reused server contracts and controlled regression coverage |
| S51 | C | Vibe inferred from motion energy, periodicity, bounded movement, dwell, arrival/departure velocity, density, venue context | Reused server contracts and controlled regression coverage |
| S52 | C | VibeState carries energy, sociality, dance_likelihood, volatility, momentum + confidence/coverage/freshness/provenance | Reused server contracts and controlled regression coverage |
| S53 | C | ExperienceState composite: Crowd / Vibe / Behavior / Friction / Dynamics / Truth | Reused server contracts and controlled regression coverage |
| S54 | C | ExperienceSession bridges opportunity → action → outcome without being a tracking history | Reused server contracts and controlled regression coverage |
| S55 | C | Context Kernel assembling canonical entities + world/experience state + user/trip/social + safety/policy, with the nine §18.1 contexts | Reused server contracts and controlled regression coverage |
| S56 | C | Opportunity Engine downstream of the kernel, feeding feature-specific projections | Reused server contracts and controlled regression coverage |
| S57 | C | Feature clients and React components must not independently calculate crowd, vibe, safety, opportunity, experience value or world-change state | Reused server contracts and controlled regression coverage |
| S58 | C | Keep current layer census and fallback; do not rewrite the gateway | Map lead integration; server projection/precedence regressions |
| S59 | C | Add server-built ExperienceState to place/event projections rather than separate overlapping vibe pins | Map lead integration; server projection/precedence regressions |
| S60 | C | Promote world_pulse into transient world-change projections: heating up, forming, moving, clearing, unexpected activity, event spillover, traveler surge | Map lead integration; server projection/precedence regressions |
| S61 | C | Render crowd_flow / traveler_flow as privacy-safe directional geometry, not ordinary pins | Map lead integration; server projection/precedence regressions |
| S62 | C | TemporaryWorldObject only if no canonical contract exists; no fake permanent Place rows for transient clusters | Map lead integration; server projection/precedence regressions |
| S63 | C | Semantic zoom: city→neighborhood/world dynamics; district→hotspots/flows; place→vibe/crowd/queue | Map lead integration; server projection/precedence regressions |
| S64 | C | Truth/freshness/coverage metadata, and predicted visually distinguished from observed | Map lead integration; server projection/precedence regressions |
| S65 | C | Display resolver / clutter budget so safety, mode, zoom, user intent and relevance decide what renders | Map lead integration; server projection/precedence regressions |
| S66 | W | Safety constraints outrank opportunity/vibe; a dangerous place is never simultaneously promoted as "best move now" | Map lead integration; server projection/precedence regressions |
| S67 | C | Map remains a projection consumer, never an owner of world truth | Map lead integration; server projection/precedence regressions |
| S68 | C | Rank using live ExperienceState, forecast, travel time, friction, compatibility, freshness, safety and Opportunity value | Root Discovery integration; candidate regressions |
| S69 | C | Keep search/retrieval truth separate from recommendation ranking; a quiet venue still exists in search | Root Discovery integration; candidate regressions |
| S70 | C | Server-built DiscoveryCandidate with why-now, why-for-user, confidence, freshness and truth class | Root Discovery integration; candidate regressions |
| S71 | C | Strengthen Hidden Gems with behavioural evidence; create candidates, not automatic canonical gems | Root Discovery integration; candidate regressions |
| S72 | C | Intent modes — Right Now, Tonight, Explore, Quiet, Social, High Energy, Nearby, Trip — on the same shared intelligence | Root Discovery integration; candidate regressions |
| S73 | C | Wall consumes meaningful state transitions, not repeated snapshots of unchanged state | Wall lead integration; server transition regressions |
| S74 | C | Server-built WallMoment with subject, transition, occurred_at, relevance window, reason, truth class, freshness, expiry | Wall lead integration; server transition regressions |
| S75 | C | Preserve Wall as chronological/current-life architecture; do not turn it into an opaque engagement-maximizing ranking feed | Wall lead integration; server transition regressions |
| S76 | C | Live Now strip consumes current projections; chronological Wall records transitions/history; do not duplicate both | Wall lead integration; server transition regressions |
| S77 | C | Personalization controls whether a canonical world event matters to a user; it must not rewrite the world event | Wall lead integration; server transition regressions |
| S78 | C | Compass emits a decision: GO NOW · GO SOON · WAIT · STAY · SWITCH · SKIP · RETURN | Reused server contracts and controlled regression coverage |
| S79 | C | Compass must ground natural-language claims in structured truth (low-confidence dance_likelihood cannot become "everyone is dancing") | Reused server contracts and controlled regression coverage |
| S80 | C | Current Experience value introduces switching cost | Reused server contracts and controlled regression coverage |
| S81 | C | Home consumes a server-assembled UserNowProjection / equivalent rather than the client querying many domains | Reused server contracts and controlled regression coverage |
| S82 | C | Home answers "what matters right now"; Compass answers "what should I do about it" | Reused server contracts and controlled regression coverage |
| S83 | C | TripWorldContext projection: current world state, nearby opportunities, disruptions, ExperienceSessions, crew context | Reused server contracts and controlled regression coverage |
| S84 | C | World Intelligence may propose Trip changes but may not mutate canonical Trip plans; consequential changes pass through Trip Kernel | Reused server contracts and controlled regression coverage |
| S85 | C | Layover Temporal Freedom Engine intersects feasibility with live Experience value, forecast, friction and safe-return | Reused server contracts and controlled regression coverage |
| S86 | C | Peak interception: can the user reach the experience before its useful window decays? | Reused server contracts and controlled regression coverage |
| S87 | C | Share canonical references to ExperienceState / Opportunity / WorldMoment / SafetyNotice rather than copying stale prose | Telegraph lead integration; canonical-reference regressions |
| S88 | C | Shared live objects may indicate that state changed since sharing | Telegraph lead integration; canonical-reference regressions |
| S89 | C | Telegraph coordination consumes intelligence without exposing contributors | Telegraph lead integration; canonical-reference regressions |
| S90 | C | Nearby & Available remains separate from anonymous sensing | Telegraph lead integration; canonical-reference regressions |
| S91 | C | Raw passive sensing never automatically becomes Memory | Session/Memory bridge and revocation-reach regressions |
| S92 | W | Bridge through ExperienceSession and outcome/significance eligibility | Session/Memory bridge and revocation-reach regressions |
| S93 | C | Passport consumes meaningful visited/experienced outcomes, not raw movement logs | Session/Memory bridge and revocation-reach regressions |
| S94 | C | World Intelligence, personal Memory and social location remain separate retention/permission domains | Session/Memory bridge and revocation-reach regressions |
| S95 | C | Do not bloat durable places rows with current_vibe / current_crowd / current_energy; keep dynamic state in projections | Reused server contracts and controlled regression coverage |
| S96 | C | Events may expose runtime inferred/official phases, but source classes and truth classes remain distinct | Reused server contracts and controlled regression coverage |
| S97 | W | Temporary activity must not be forced onto the nearest place ID when ownership is unknown; never assign to the nearest place merely to satisfy a foreign key | Reused server contracts and controlled regression coverage |
| S98 | C | HiddenGemCandidate distinct from canonical Hidden Gem approval where the repo already separates candidates/review | Reused server contracts and controlled regression coverage |
| S99 | C | Search can use live state as ranking context while preserving lexical/entity correctness | Reused server contracts and controlled regression coverage |
| S100 | C | Autocomplete may surface live/inferred suggestions but must label them as current intelligence, not durable metadata | Reused server contracts and controlled regression coverage |
| S101 | C | Create content and structured intelligence observation must be separate commands; a post saying "dead" cannot mutate CrowdState | Reused server contracts and controlled regression coverage |
| S102 | C | Attention Engine is mandatory: world changes route through relevance, novelty, urgency, half-life, availability, interruption cost and attention budget before NOTIFY / WALL / SILENT / IGNORE | Reused server contracts and controlled regression coverage |
| S103 | C | World intelligence evidence/anomaly → SAFETY CANDIDATE → existing safety policy/review → canonical safety assertion | Reused server contracts and controlled regression coverage |
| S104 | C | Source reliability / signal reliability are not the same as person Trust Score | Reused server contracts and controlled regression coverage |
| S105 | C | Passive movement does not increase person Trust Score | Reused server contracts and controlled regression coverage |
| S106 | C | Shared platform Presence architecture keeping private device / aggregate intelligence / social / trip crew / buddy / public discovery classes distinct | Reused server contracts and controlled regression coverage |
| S107 | C | Reuse low-level sensor/proximity infrastructure where possible, not consent/policy semantics | Reused server contracts and controlled regression coverage |
| S108 | C | LMF may use identity/relay/checkpoints under group permissions; anonymous World Intelligence may not reverse-resolve contributors | Reused server contracts and controlled regression coverage |
| S109 | C | RAB may consume public/aggregate area intelligence and authorized Buddy presence, but never infer or expose individual anonymous contributors | Reused server contracts and controlled regression coverage |
| S110 | C | Shared temporal semantics: observed_at, effective_from, effective_until, expires_at, freshness, predicted_for | Reused server contracts and controlled regression coverage |
| S111 | W | Entity reconciliation: observed cluster → Place? Event? Temporary world object? Unknown? | Reused server contracts and controlled regression coverage |
| S112 | W | Revocation / lineage: define what revocation removes, expires, prevents and may retain as genuinely de-identified aggregate | Server privacy/lineage regression; rollout evidence remains where W |
| S113 | C | ExperienceOutcome: result / calibration / optional feedback | Reused server contracts and controlled regression coverage |
| S114 | C | Schema/permission/infrastructure failure ≠ no activity | Server privacy/lineage regression; rollout evidence remains where W |
| S115 | C | Expired/stale state ≠ current | Reused server contracts and controlled regression coverage |
| S116 | C | Inference confidence may only decrease through conflict unless new evidence supports an increase | Reused server contracts and controlled regression coverage |
| S117 | C | No product surface may fabricate world state to make UI look complete | Reused server contracts and controlled regression coverage |
| S118 | W | Anonymous intelligence may not be reverse-linked to a Portava account | Server privacy/lineage regression; rollout evidence remains where W |
| S119 | C | All consequential canonical mutations use existing command/service/RLS patterns, not client direct writes | Reused server contracts and controlled regression coverage |
| S120 | C | S0: produce a reuse map inventorying consent, contribution, device/session, map projections, intel storage, Wall, Discovery, Compass, schedulers, RLS, outbox and flags | Architecture/CI controls; live certification separate |
| S121 | C | S11: run forecast/vibe in shadow mode and calibrate before aggressive surfacing | Architecture/CI controls; live certification separate |
| S122 | C | Additive migrations with postconditions; no destructive migration unless separately reviewed | Architecture/CI controls; live certification separate |
| S123 | C | Every new server contract gets positive tests, RLS/authz negatives, stale/unknown cases and malformed input cases | Architecture/CI controls; live certification separate |
| S124 | C | Use static ratchets for forbidden direct writes, identity joins or bad literals | Architecture/CI controls; live certification separate |
| S125 | C | Mutation-prove: no permanent identity link, no single-device crowd, no prediction-as-observation, no anomaly-as-safety, no client-computed vibe | Architecture/CI controls; live certification separate |
| S126 | C | Feature flags allow shadow/read-only rollout; do not claim LIVE until gate, schema, policy, scheduler, data dependency and production path are satisfied | Architecture/CI controls; live certification separate |
| S127 | C | Location contribution and social live-location permissions are separate | Client lead lifecycle/consent work; hardware proof required |
