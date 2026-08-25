# Intelligence Gathering — buildout status (23 Aug 2026)

Implementation of the Intelligence Gathering Implementation Specification against
this codebase, following the Phase A0 reconnaissance. **Nothing here is applied to
any database.** Every flag is off; every unit is a runtime no-op until enabled.

## Built

| Unit | Code | Migration |
|---|---|---|
| IG-01 Contracts | `lib/intelContracts.ts` | `2128_intel_contracts_seed.sql` |
| IG-02 Storage | — | `2130_intel_storage.sql` |
| **IG-03 Capture** (shadow) | `lib/quickSignal.ts` + `services/intel/IntelCaptureService.ts` + `lib/intelThrottle.ts` + `routes/intel.ts` | `2165_intel_capture_quick_signal_flag.sql` |
| **IG-06 Trail follow-up** (shadow) | `lib/trailFollowup.ts` + `services/intel/IntelCaptureService.ts` (parameterised `trail` surface) + `routes/intel.ts` | `2166_intel_trail_followup_flag.sql` |
| **IG-08 Coverage** (shadow) | `lib/coverageScore.ts` + `lib/missionGeneration.ts` + `services/intel/CoverageService.ts` + `routes/intelCoverage.ts` (internal, requireAdmin) | `2167_intel_mission_candidates.sql` |
| **IG-09 Limited-Live** (shadow) | `lib/intelLiveScope.ts` + `lib/intelPilotMetrics.ts` + `lib/liveClaimRead.ts` (kill switch + pilot gate) | `2168_intel_limited_live_flags.sql` |
| **IG-07 Compass k=1** (⚠ live-path) | `lib/compassRhythmGate.ts` + `compass/CompassGraphEngine.ts` (rhythm line k-anon gate) | `2169_intel_compass_rhythm_actor_gate_flag.sql` |
| **IG-10 internal** (shadow) | `lib/qiuShadow.ts` + `lib/intelApiProjection.ts` + `routes/intelApi.ts` (internal, requireAdmin) | — (no external surface; reuses `lib/dataRights.ts`) |
| IG-04 Privacy gate | `lib/privacyGate.ts` | — |
| IG-04 Confidence | `lib/confidenceScore.ts` | — |
| IG-04 Projection | `lib/intelProjection.ts` | `2132_intel_projection_flag.sql` |
| IG-05 Read path | `lib/liveClaimRead.ts` | `2131_intel_live_label_flag.sql` |
| IG-08 prerequisite | `lib/dataRights.ts` + `check:data-rights` | — |
| Retention | `lib/intelRetentionScheduler.ts` | `2133_intel_retention.sql` |
| Deletion coverage | `lib/deletionDispositions.ts` + `check:deletion-coverage` | — |
| D4 location purposes | `lib/locationPurposes.ts` + `check:location-purposes` | — |

218 tests; eight CI gates green (`flag-polarity`, `test-registration`,
`guard-coverage`, `migration-prefixes`, `deletion-coverage`, `data-rights`,
`location-purposes`, `not-null-writes`) — counted by running them, not by
counting the list above.

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

1. ~~**D4 — lawful basis**~~ **RULED 2026-08-23.** Portava minimises persistent raw
   movement history; precise location is processed only for defined purposes, each
   with a documented lawful basis, retention policy, visibility policy and deletion
   behaviour. Implemented as `lib/locationPurposes.ts` (11 purposes) plus the
   `check:location-purposes` gate, which fails if a coordinate-holding table is
   claimed by no purpose. **What is still open is one window, not the basis:**
   `intel_claim` carries `retentionBound: "open_decision"` and is the only
   undecided retention in the registry. IG-03 capture is unblocked in principle
   and blocked in practice by item 2 below.
2. **`places` holds 0 rows in production** (`discovery_places` holds 184).
   `intel_observations.subject_id` FKs `places(id)`, so capture writes nothing
   until the backfill runs. Handed to the Replit workstream.
3. **D6 — deletion fate.** A full evidence-backed triage of all 260 user-keyed
   tables was delivered to the owner on 2026-08-23 and awaits ruling. Two findings
   from it change how the rest of this document should be read:
   * On PRODUCTION `public.profiles` has **no foreign key to `auth.users`**. The
     deletion service anonymises the profile row rather than deleting it, so every
     `-> profiles ON DELETE CASCADE` edge — 168 of them — never fires. **181 of 260
     tables keep the user's real uuid after deletion.** A cascade to `profiles`
     looks protective in a schema diagram and does nothing.
   * Four foreign keys to `auth.users` are `ON DELETE NO ACTION`, which *rejects*
     the parent delete: `event_cohosts.added_by`, `moderation_reports.resolver_id`,
     `post_edits.user_id`, `trip_plan_items.creator_id`. None is cleared by the
     deletion service, so `auth.admin.deleteUser` fails and the retry fails
     identically forever. **FIX STAGED — `2164_deleteuser_unblock_fk_actions.sql`
     (2026-08-25):** the three nullable actor references become `ON DELETE SET NULL`
     (row retained, personal reference forgotten); `post_edits.user_id` (NOT NULL,
     the user's own edit) becomes `ON DELETE CASCADE`. Applied to CI (which had
     already drifted to SET NULL/CASCADE — so on CI it is a confirming no-op);
     **on PROD it is the real fix** (prod verified still `NO ACTION` on all four,
     2026-08-25 — deletion is hard-broken there). CI-only; owner presses prod. This
     unblocks the hard failure only; the broader table-fate (retain-vs-erase of the
     ~229 surviving tables) stays with D6.
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
- **The journey_\* tables are live on production.** Their migrations were unpushed
  to git until 2026-08-23, when they were renumbered 2120-2123 → 2124-2127 and
  pushed. The numbers 2124-2127 had been reserved for them in `2128`'s header
  precisely so this could happen without a fourth renumber.
- **`passport_stamps` survives account deletion while `passport_stamps_gps` does
  not** — the stamp's FK is to `profiles` (tombstone survives), its coordinates'
  FK is to `auth.users` (cascade fires). The content outlives the account; the
  location does not. Recorded here because it is the inverse of what the file
  previously claimed.
