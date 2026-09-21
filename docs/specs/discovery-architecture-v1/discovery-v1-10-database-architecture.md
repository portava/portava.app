# 10 — Database Architecture

## 1. Principle

Extend existing canonical tables where appropriate. Avoid parallel systems.

## 2. Existing-table priority

Before creating a new table:
1. inspect current schema,
2. inspect production drift,
3. inspect migrations,
4. inspect RLS,
5. inspect code references.

The current repository has already shown that migration files and production can diverge materially.

## 3. Core tables / domains

### Behavior
Prefer extending/repairing `rank_events` rather than replacing it.

### Recommendations
`recommendations`
- id
- user_id
- session_id
- surface
- model_version
- context_hash
- created_at

`recommendation_items`
- recommendation_id
- source_type
- source_id
- rank_position
- candidate_source
- reason_codes
- feature_ref

### Trails
See Trails spec.

### Graph projections
- traveler_affinities
- place_cooccurrence
- trail_relations
- circle_momentum
- place_momentum

These are derived and rebuildable.

### Attribution
- conversion_events
- attribution_records
- attribution_participants

### Earnings
- ledger_accounts
- ledger_entries
- payout_holds
- payout_requests

## 4. Indexing

Every new query path must have:
- expected cardinality,
- index rationale,
- EXPLAIN verification where meaningful.

Current drift has already shown unapplied geo indexes can leave production on sequential scans.

## 5. RLS

Every user-visible table must explicitly define:
- read policy,
- insert policy,
- update policy,
- delete policy.

Pending/consent states must not be made public accidentally.

Do not rely only on API filtering.

## 6. SECURITY DEFINER

Use only when necessary.
Pin `search_path`.
Prefer explicit schema qualification.

## 7. Migration rules

- never edit an applied migration unless repository policy explicitly permits,
- new behavior gets a new migration,
- rehearse on `portava-ci`,
- drift audit must explain every object,
- production rollout only after CI rehearsal.

## 8. Drift terminal condition

Goal:
**zero unexplained drift**

An object may be:
- applied,
- intentionally retired,
- replaced,
- documented divergence.

Do not hide drift with broad skip lists.

## 9. Data lineage

Derived features must retain:
- source event window,
- feature version,
- model version,
- computation time.

## 10. Acceptance criteria

Database layer is ready when:
- migration-to-live drift is understood,
- RLS is explicit,
- event writes are reliable,
- derived tables are rebuildable,
- payment ledger is immutable.
