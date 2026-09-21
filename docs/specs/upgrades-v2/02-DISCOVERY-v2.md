# Discovery architecture upgrade v2

Extend the existing Discovery engine with shared World and Experience Intelligence while preserving entity search, privacy, ranking ownership, behavior telemetry, and existing surfaces. Read 00-START-HERE.md and every file in sources/discovery-v1. This upgrade retains the original package's broader Trails, trends, graphs, integrity, economic attribution, API and rollout scope.

## Existing foundation and pipeline

Inspect existing retrieval routes, candidate caches, ranking services, feature flags, rank_events writers, place/event identities, Hidden Gem review, and recommendation clients before changing them. The baseline reports past cache and telemetry defects; reproduce against the current head instead of assuming they still exist. Reuse their owners rather than building a second ranker or behavior store.

Authorized context → canonical candidate retrieval → eligibility → shared intelligence features → existing surface-specific ranking → diversity/exploration/integrity → server projection → delivery and exposure → permitted outcomes.

Search answers which entities match. Recommendation answers what is worth considering now or soon. A quiet venue remains searchable. Private or blocked entities remain ineligible regardless of ranking benefit. Chronological Wall stays chronological; Discovery does not take ownership of it.

DiscoveryCandidate is a logical extension of the current projection. Preserve canonical subject reference, candidate source, why-now, why-for-user, truth metadata, validity, model/feature version, ranking time and recommendation/exposure reference. Do not persist transient crowd or vibe as durable place identity attributes.

## Upgrade requirements and acceptance

| ID | Required behavior | Evidence required | Basis |
|---|---|---|---|
| DSV2-01 | Extend current retrieval and ranking; maintain search/entity truth independently. | Exact entity retrieval remains valid when live activity is quiet, stale or unknown; real search and recommendation routes are both exercised. | SENSE 8, 15; DISCOVERY 01 |
| DSV2-02 | Incorporate ExperienceState, forecast, travel time, friction, compatibility, freshness, safety and opportunity through shared owners. | Feature lineage is traceable; unknown inputs remain unknown; missing world state cannot become a favorable score by default. | SENSE 8; engineering acceptance |
| DSV2-03 | Support Right Now, Tonight, Explore, Quiet, Social, High Energy, Nearby and Trip intent through the same intelligence. | Each intent reaches the actual ranking path and preserves user constraints; UI selection is not merely decorative. | SENSE 8 |
| DSV2-04 | Preserve why-now, why-for-user and truth metadata through API and client. | Observed and predicted recommendations render distinctly; expired why-now claims disappear or become explicitly stale. | SENSE 5.1, 8 |
| DSV2-05 | Shared candidate caching must not bypass per-user ranking or eligibility. | Two users with different interests/blocks cannot receive another user's authorized final order from a shared cache; cache-hit paths are tested. | DISCOVERY 01 §7, 06 |
| DSV2-06 | Bound final caches by authorized context, version and freshness. | Changes in permission, trip context or evidence validity invalidate/revalidate affected results; feature and model provenance survives cache reuse. | DISCOVERY 06; SENSE 18.4; engineering acceptance |
| DSV2-07 | Preserve evidence-integrity telemetry using existing rank_events and recommendation owners. | Allowed surfaces actually write; rejected writes are observable; retry deduplicates; exposures have denominators and actual outcomes stay distinct from predictions. | DISCOVERY 01 §6 |
| DSV2-08 | Use behavioral evidence to create Hidden Gem candidates, never automatic canonical approvals. | Correlated activity cannot become independent confirmation; privacy/disclosure and existing review still govern visibility and approval. | SENSE 4.4, 8, 14 |
| DSV2-09 | Keep world anomalies and density separate from safety assertions. | High-energy/crowded candidates do not acquire an unsafe label automatically; authorized safety restrictions override opportunity promotion. | SENSE 2, 7, 16 |
| DSV2-10 | Preserve relevant exploration, diversity, integrity and cold-start behavior. | Low-history creators are not automatically excluded; repetition/concentration controls and manipulation fixtures exercise real ranking code. | DISCOVERY 06 |
| DSV2-11 | Keep OFF inert and SHADOW free of user-facing side effects. | Same authorized baseline inputs yield unchanged OFF output; SHADOW does not notify, cancel, book, mutate plans or alter presented order. | DISCOVERY 01 §8 |
| DSV2-12 | Measure real utility and calibration, not engagement alone. | Trace served recommendation→exposure→permitted outcome with versions and coverage; no synthetic production visits, conversions or Trust awards. | DISCOVERY 01 §12; SENSE 5.4 |

## Privacy, degradation and integration

Never use private message contents or infer sensitive personal attributes as ranking inputs. Anonymous contributors cannot become discoverable people. Public explanations must not disclose private social context, block reasons, sensitive locations or restricted evidence. Searchers cannot gain unauthorized trip data through recommendation joins or cached projections.

When live state is unavailable, retain permitted baseline retrieval and recommendations with honest limitations. Do not label absence as Quiet. Apply destination/time windows and distinguish forecast horizons from current observation. Temporary world objects retain their own valid identity instead of borrowing an arbitrary venue ID.

Test real route→service→projection→client wiring; include cache hits, expiry, permission changes, sparse coverage, empty candidates, dependency failure and retry. Rehearse schema changes on a disposable database using committed bytes and compare unchanged baseline journeys before rollout.

## Open policy and release gates

Existing Ranker and Event Truth holds are not lifted by this specification. Confirm current holds before activation. Reuse approved weights, exploration budgets, sensitive-location policy, freshness and thresholds. Ask for missing policies rather than choosing silent production defaults. Provider-backed route time remains unverified until its configured integration passes; a distance estimate is not measured travel time.
