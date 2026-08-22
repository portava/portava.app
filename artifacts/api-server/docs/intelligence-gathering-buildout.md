# Intelligence Gathering — buildout status (22 Aug 2026)

Implementation of the Intelligence Gathering Implementation Specification against
this codebase, following the Phase A0 reconnaissance. **Nothing here is applied to
any database.** Every flag is off; every unit is a runtime no-op until enabled.

## Built

| Unit | Code | Migration |
|---|---|---|
| IG-01 Contracts | `lib/intelContracts.ts` | `2128_intel_contracts_seed.sql` |
| IG-02 Storage | — | `2130_intel_storage.sql` |
| IG-04 Privacy gate | `lib/privacyGate.ts` | — |
| IG-04 Confidence | `lib/confidenceScore.ts` | — |
| IG-04 Projection | `lib/intelProjection.ts` | `2132_intel_projection_flag.sql` |
| IG-05 Read path | `lib/liveClaimRead.ts` | `2131_intel_live_label_flag.sql` |
| IG-08 prerequisite | `lib/dataRights.ts` + `check:data-rights` | — |
| Retention | `lib/intelRetentionScheduler.ts` | `2133_intel_retention.sql` |
| Deletion coverage | `lib/deletionDispositions.ts` + `check:deletion-coverage` | — |

188 tests; six CI gates green (`flag-polarity`, `test-registration`,
`guard-coverage`, `migration-prefixes`, `deletion-coverage`, `data-rights`).

## Decisions taken, and why

**Four spec tables were NOT created.** `intel_outcomes` would be the fifth outcome
store — `canonical_events` already carries arrival/completion/rejection/
satisfaction and `2123` files them as `family='outcome'`. Also skipped:
`intel_expertise_scopes` (sixth verification ladder), `intel_coverage_cells`
(third coverage model), `intel_missions` (dispatch exists in three pieces). This
is the spec's own "no duplicate truth store" rule applied to its own table list.

**Append-only governs correction, not retention.** UPDATE is refused
unconditionally on observations, evidence and confirmations. DELETE is permitted
only inside a transaction declaring `SET LOCAL portava.erasure_in_progress`,
reachable through one `SECURITY DEFINER` function `erase_intel_for_actor(uuid)`
because PostgREST cannot issue `SET LOCAL`. Without that the tables would be
undeletable in practice and would join the 229 that already survive account
deletion.

**Flag rows arrive with their readers.** `check:flag-polarity` rejects a flag
seeded but read by nothing. So `2128` seeds no flags, and `2131`/`2132`/`2133`
each seed one alongside the code that reads it.

**The writer and reader do not trust each other.** The projection sets
`privacy_eligible`; the read path filters on it in the `WHERE` clause. Either
side being wrong is survivable.

## Blocked — do not build past these

1. **D4 — lawful basis** for storing a per-person movement history. Blocks IG-03
   capture entirely, and therefore IG-06/07 and any surface having data to show.
   A legal determination, not an engineering one.
2. **`places` holds 0 rows in production** (`discovery_places` holds 184).
   `intel_observations.subject_id` FKs `places(id)`, so capture writes nothing
   until the backfill runs. Handed to the Replit workstream.
3. **D6 — deletion fate** for the 222-table backlog in `deletionDispositions.ts`.
4. **IG-08/IG-10** need per-field rights and QIU semantics decided; the registry
   makes the first concrete.

## Known gaps, recorded rather than implied

- **The k=1 Compass path is only half-closed.** `privacyGate` exists, but
  `compass_graph_edges` dedups on a key containing no `user_id`, so a
  distinct-actor count is not derivable from stored data. Closing it needs a
  schema change on a live serving path. See `UNROUTED_PUBLISHERS`.
- **`intel_observations` is not swept.** Its retention window is a policy
  decision — `docs/ops/retention-policy.md` says 90 days while the spec's pattern
  cohorts need 120–180 from derived aggregates.
- **`places.field_freshness`** is write-once yet surfaced as `fieldFreshness` in
  the canonical place DTO. Either wire it or deprecate it.
- **The journey_\* tables are live on production** with their migrations unpushed
  to git.
