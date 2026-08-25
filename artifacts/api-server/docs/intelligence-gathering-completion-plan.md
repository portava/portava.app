# Intelligence Gathering — completion plan (25 Aug 2026)

Companion to `intelligence-gathering-buildout.md` (what's built) and the
Intelligence Gathering Implementation Specification (the target). This is the
**burn-down**: every remaining unit, classified in-house vs delegate, with the
concrete build slice. Produced from a per-unit reconciliation of the spec against
this codebase (6 reviewers). **Discipline unchanged:** every in-house slice ships
in SHADOW — one flag per family, seeded off with its reader, append-only tables,
migrations 2165+, CI gates green, nothing applied to any DB by the builder.

## The shape of what's left

Built already (shadow): IG-01 Contracts, IG-02 Storage, IG-04 Projection/privacy/
confidence, IG-05 read path, retention, D4 location purposes, deletion-coverage,
trust gain/lose. **IG-03 capture — the missing PRODUCER — and everything
downstream (IG-06…IG-10) is unbuilt.** Each unit is MIXED: a buildable api-server
shadow slice + delegated mobile UI + the shared Replit `places` backfill + one or
more owner decisions that gate *enabling* (not building).

## In-house build queue (api-server, shadow — I am working through these)

| Order | Unit | Slice | Migs | Effort | State |
|---|---|---|---|---|---|
| 1 | **IG-03 Capture** | `quickSignal.ts` contract + `IntelCaptureService` + `intelThrottle.ts` + `routes/intel.ts` + flag `intel_capture_quick_signal` | 2165 (flag seed only — 2130 already made the tables/RLS/grants) | L | **building** |
| 2 | **IG-06 Trail follow-up** | `trailFollowup.ts` (going-next = an `intel_observations` row; arrival/outcome = derivation over `canonical_event_families` family='outcome'); flag `intel_trail_followup`. No new table. | +1 flag seed | M | queued (rides IG-03's write path) |
| 3 | **IG-08 Coverage** | `coverageScore.ts` + `missionTrigger.ts` + `coverageScheduler.ts`; tables `intel_coverage_snapshots` (derived) + `intel_mission_candidates` (append-only, non-cash sim) | +2 | L | queued |
| 4 | **IG-09 Limited-Live gating** | `intelLiveScope.ts` (pilot cohort, off/nobody) + `intelDensityGate.ts` + `intelPilotMetrics.ts`; gate ahead of `liveClaimRead`; table `intel_pilot_density` (no actor FK) | +2 | M | queued |
| 5 | **IG-10 QIU/API shadow** | `qiuShadow.ts` (pure `computeQiu`) + `intelApiProjection.ts` (endpoint field-allowlists) + `check:api-redistribution`; flag `intel_external_api` | +1 | L (safe slice; full unit XL) | queued |
| 6 | **IG-07 Compass k=1** | emit distinct-contributor `active_in` edges in `CompassGraphEngine`; `slice_actors` rollup; publish rhythm lines only through `mayPublishAggregate` behind flag `intel_compass_rhythm_actor_gate` | +1 (+col) | L | queued — ⚠ see risk |

⚠ **IG-07 is not fully shadowable and carries a live-behavior change** (the
destination-rhythm line is already LIVE in prod and leaks at k=1; the fix
suppresses it entirely while the flag is off, then re-emits only above K). It
touches a live serving path and needs a graph rebuild after deploy. I will build
+ test it but flag it for explicit owner review before any prod enable.

## Delegate — not api-server in-house work

- **Replit (data/ingest):** populate `public.places` for the pilot city — the
  0-rows blocker. `places` is fed from `fsq_places` via `backfill-canonical-
  places.ts` (refuses unless `external_places_enabled` on; OSM `discovery_places`
  is *not* a source — no coordinates). Sequence: enable flag → FSQ-ingest pilot
  city → run the backfill (resumable, prod-connected env). Also: run
  `rebuildIntelligenceGraph` after any IG-07 deploy.
- **Mobile (`travel-buddy-standalone/`, Expo — cloud session w/ simulator):**
  Quick Signal composer + venue prompt sheets (Nightlife/Restaurant/Event/Transit/
  Hotel), Moment approve/confirm/correct screens, prompt-pause controls, Trail
  "where next?" + exit sheets + visibility picker, place-card decision-exposure
  chips, coverage/mission ops dashboards, contributor QIU (shadow, no-cash)
  screen, partner API console. The place card already renders `crowdLevel`, so
  IG-09 needs no new screen.
- **External services (IG-10):** API gateway + key-auth + rate-limit + scope
  enforcement; billing/metering for funded pilots; partner/legal redistribution
  contracts.

## Owner decisions (spec §30) — gate *enabling*, not building

| Decision | Recommended default | Gates |
|---|---|---|
| Presence method | session coarse geofence + dwell, off by default | IG-03 live |
| Crowd labels | dead/quiet/moderate/busy/packed; unsafe_density specialist-only | IG-01 mapping / IG-03 |
| `intel_claim` retention window | (only undecided retention in the registry) | enabling capture |
| Movement threshold | 15 actors / 5 groups / 30-min | IG-07 K, IG-09 |
| Pilot city / two zones | one city, two nightlife clusters + transit/food | IG-08, IG-09 |
| Initial rewards | stamps/credits, no cash | IG-08 |
| External API | private hotel pilot after public Live proves out | IG-10 |
| Historical legacy use | no backfill by default | pattern learning |
| `intel_observations` sweep window | 90d (ops) vs 120–180d (pattern cohorts) — reconcile | retention |

## Cross-cutting done this cycle
- `2164` deleteUser FK unblock (PR #129) — the D6 hard-failure sub-fix (CI-only; prod is owner-pressed). Broader D6 table-fate ruling still owner's.
