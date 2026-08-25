# Intelligence Gathering — Phase-1 production rollout runbook (Da Nang pilot)

Durable, step-by-step handoff for turning Phase-1 Intelligence Gathering from
built-and-shadowed into **enabled** in production, for the Da Nang pilot city.
Execute top-to-bottom; do not skip the ordering. Companion to
`intelligence-gathering-buildout.md` (what's built) and
`intelligence-gathering-completion-plan.md` (the burn-down).

**Who runs this:** the prod-connected / Replit data workstream (has prod
`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`). Every step marked **[WRITE]**
mutates production and is owner-pressed; steps marked **[READ]** are safe
verifications you can run any time.

**The code:** api-server `liveClaims` read path — PR #138
(`claude/ig-05-live-claims-read-20260825`); mobile capture UI — PR #139
(`claude/ig-03-mobile-capture-ui-20260825`). Both target `main`, both ship inert
behind flags.

---

## 0. Current production pre-state (verified 2026-08-25, project `ajrurzioarfkagpuxfnb` = travel-buddy/prod)

| Fact | Value | Consequence |
|---|---|---|
| `public.places` rows | **0** | capture/read have no subjects yet — the primary blocker |
| `public.discovery_places` rows | 184 | OSM only, no coordinates → **not** a backfill source |
| `intel_observations` / `intel_state_snapshots` / `intel_claims` tables | **absent** | the intel schema is not deployed to prod |
| intel `feature_flags` rows | **absent** | flags cannot be flipped until the seed migrations create them |
| `external_places_enabled` | **true** | FSQ backfill precondition already met ✓ |
| `live_places_enabled` | **false** | `/places/:id/living` is disabled → the place card renders nothing until this is on |

Re-run this exact **[READ]** to reconfirm the pre-state before starting:

```sql
select
  (select count(*) from public.places)            as places_count,
  (select count(*) from public.discovery_places)  as discovery_places_count,
  to_regclass('public.intel_observations')    is not null as has_intel_observations,
  to_regclass('public.intel_state_snapshots') is not null as has_intel_snapshots,
  to_regclass('public.intel_claims')          is not null as has_intel_claims,
  (select coalesce(jsonb_object_agg(flag, enabled), '{}'::jsonb)
     from public.feature_flags
     where flag like 'intel_%'
        or flag in ('external_places_enabled','live_places_enabled','disable_intel_live_labels')
  ) as flags;
```

---

## 1. Code prerequisites — merge + deploy

1. **[WRITE]** Merge **#138** (api-server `liveClaims`) then **#139** (mobile). Both are additive and independently mergeable; #138 first keeps the mobile chips fed with real bands/source/time on day one.
2. **[WRITE]** Deploy the merged api-server and ship the mobile build. Confirm the deployed api-server exposes `liveClaims` on `GET /api/places/:id/living` (it will be `[]` until flags + data land — that is correct).

## 2. Deploy the intel schema to prod (migration order)

Apply these migrations to prod **in ascending order** (they create the tables,
append-only enforcement, retention, and **seed every intel flag OFF** with its
reader). Nothing user-facing changes — the flags are off.

```
2128_intel_contracts_seed.sql          # claim-type registry + vocab seed
2130_intel_storage.sql                 # intel_observations / _claims / _evidence / _confirmations / _state_snapshots (+ RLS, grants, append-only)
2131_intel_live_label_flag.sql         # seeds intel_live_label_crowd (off)
2132_intel_projection_flag.sql         # seeds intel_claim_projection_crowd (off)
2133_intel_retention.sql               # retention scheduler wiring
2137_intel_stmt_trigger_removal.sql
2165_intel_capture_quick_signal_flag.sql   # seeds intel_capture_quick_signal (off)
2166_intel_trail_followup_flag.sql         # seeds intel_trail_followup (off)
2167_intel_mission_candidates.sql
2168_intel_limited_live_flags.sql          # seeds intel_limited_live (off) + disable_intel_live_labels kill switch
2169_intel_compass_rhythm_actor_gate_flag.sql
```

**[READ]** Verify after applying — the four core tables now exist and all intel flags read `false`:

```sql
select to_regclass('public.intel_observations')    is not null as obs,
       to_regclass('public.intel_claims')           is not null as claims,
       to_regclass('public.intel_state_snapshots')  is not null as snaps,
       (select jsonb_object_agg(flag, enabled) from public.feature_flags where flag like 'intel_%') as intel_flags;
```

⚠️ IG-07 note: `intel_compass_rhythm_actor_gate` touches a **live** Compass serving path (the destination-rhythm line leaks at k=1 while off; the gate suppresses it entirely until above K). After deploy, run `rebuildIntelligenceGraph` per the completion plan. Flag this for explicit owner review before enabling that specific flag — it is **not** part of the Phase-1 capture enable set below.

## 3. Baseline metric snapshot — run **after §2, before §4** (the clean zero-state)

This is the "before" operational baseline. Run it once the intel tables exist
and **before** any ingest/capture — every count is expected to be zero.

**[READ]** DB-derivable baselines:
```sql
select 'observations'      src, coalesce(claim_type,'(none)') k, count(*) n from public.intel_observations   group by 2
union all select 'claims',             claim_type, count(*) from public.intel_claims           group by 2
union all select 'claims_by_status',   status,     count(*) from public.intel_claims           group by 2
union all select 'snapshots',          claim_type, count(*) from public.intel_state_snapshots  group by 2
union all select 'snapshots_eligible', (privacy_eligible)::text, count(*) from public.intel_state_snapshots group by 2
order by 1,2;
```

Capture from **app logs / metrics** (request-time, not persisted; baseline = zero while capture is off):
- claim counts by type, **rejection reasons** (the capture route returns `invalid_payload` / `invalid_value` / `feature_disabled` codes),
- **`unknown_subject` / `not_found` rate**,
- **`liveClaims` hit rate** (share of `/living` responses with a non-empty `liveClaims`),
- **throttle denials** (from `intelThrottle`).

Record the snapshot (timestamp + values) somewhere durable so the post-enable numbers have a reference.

## 4. Populate `public.places` for Da Nang (FSQ ingest → canonical backfill)

`external_places_enabled` is already **true**. The canonical backfill reads
`fsq_places` (has coordinates + a stable provider id) — OSM `discovery_places`
is intentionally not a source.

1. **[WRITE]** **FSQ Da Nang ingest** — populate `public.fsq_places` with Da Nang venues via the team's FSQ ingestion pipeline (the loader that fills `fsq_places`; confirm the exact entrypoint with the data workstream). Cover the pilot categories below.
2. **[WRITE]** **Canonical backfill** — turn provider rows into deduplicated canonical `places` (idempotent; keyed on `(provider, provider_place_id)`, dedups by proximity, so re-running never duplicates):
   ```bash
   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
     node --import tsx/esm src/scripts/backfill-canonical-places.ts
   ```

**Minimum acceptance set (gate before any flag flip)** — Da Nang must have **at
least one valid canonical place in each** pilot category, so the first E2E pass
isn't accidentally proving only one venue type:

- nightlife • restaurant • hotel • attraction • beach/landmark • transit/transport

**[READ]** Verify counts + category coverage + that subject ids exist:
```sql
select count(*) as places_total from public.places;
select category, count(*) from public.places group by 1 order by 2 desc;
-- Spot-check one usable subject_id per pilot category before enabling.
select id, name, category, latitude, longitude from public.places
where category is not null order by category limit 50;
```
Do **not** proceed while `places_total = 0` or a pilot category has no row.

## 5. Enable the Living Places capability

**[WRITE]** Turn on `live_places_enabled` — otherwise `/places/:id/living` returns `feature_disabled` and the card shows nothing regardless of intel flags.
```sql
-- owner-pressed:
-- update public.feature_flags set enabled = true where flag = 'live_places_enabled';
select flag, enabled from public.feature_flags where flag = 'live_places_enabled';
```

## 6. Flag activation chain — the full set, in dependency order

⚠️ **Flipping only the three UI-facing flags is insufficient and will look
broken.** The projection produces the snapshots the read path serves, and the
IG-09 pilot scope gates the live read. Enable in this order so each flag's
dependencies are already satisfied:

| Order | Flag | Why it's required |
|---|---|---|
| 1 | `intel_capture_quick_signal` | capture writes observations (root of the chain) |
| 2 | `intel_claim_projection_crowd` | observations → claims → **`intel_state_snapshots`** (the read is empty without it) |
| 3 | `intel_live_label_crowd` | the read/label gate for `crowdLevel` + `liveClaims` |
| 4 | `intel_limited_live` | IG-09 pilot-scope promotion — the live read returns `[]` until a scope is promoted |
| 5 | `intel_trail_followup` | the Trail "where next?" + exit path |

Plus two **states**, not toggles-to-on:
- `disable_intel_live_labels` (IG-09 kill switch) must be **false** — and note the read fails **closed** (treats a DB error as engaged), so the row must be present and readable.
- `live_places_enabled` = **true** (from §5).

Dependency contract (from `lib/intelContracts.ts INTEL_FLAG_DEPENDENCIES`):
`intel_claim_projection_crowd → intel_capture_quick_signal`;
`intel_live_label_crowd → intel_claim_projection_crowd`;
`intel_trail_followup → intel_capture_quick_signal`.

**[READ]** Confirm the whole activation state before declaring enabled:
```sql
select flag, enabled from public.feature_flags
where flag in ('intel_capture_quick_signal','intel_claim_projection_crowd',
               'intel_live_label_crowd','intel_limited_live','intel_trail_followup',
               'disable_intel_live_labels','live_places_enabled')
order by flag;
-- expect: the five intel flags + live_places_enabled = true; disable_intel_live_labels = false.
```

## 7. Production-safe end-to-end proof (run once §4–§6 are done)

Prove the full loop on a **real Da Nang place**, ideally one per pilot category:

1. **Capture** — submit a Quick Signal from the app against the place → the row lands in `intel_observations`.
2. **Projection** — a canonical claim is produced (`intel_claims`) and a snapshot appears (`intel_state_snapshots`) with `privacy_eligible` set only after the privacy gate passes.
3. **Read** — `GET /api/places/:id/living` returns the claim inside `liveClaims`, ordered best/current first.
4. **Consistency** — `crowdLevel` matches the crowd value inside `liveClaims` (one projection, two reads).
5. **Card** — the place card renders the decision-exposure chip with band + source + observed time + "why" + Live state.
6. **Trail** — a Trail exit capture writes.
7. **Safety** — while a Safe Return session is active, prompts are suppressed (the capture surfaces show the suppression notice, not prompts).
8. **Privacy** — the client `/living` payload contains **no** contributor ids, coordinates, raw GPS, `distinct_actors`, or visibility fields. (The server-side half of this contract is already covered by the `liveClaimRead` + `placeLiving` tests; this step confirms it end-to-end on real data.)

**[READ]** Quick DB confirmation the loop produced data + eligible snapshots:
```sql
select
  (select count(*) from public.intel_observations)                          as observations,
  (select count(*) from public.intel_claims where status = 'active')        as active_claims,
  (select count(*) from public.intel_state_snapshots where privacy_eligible) as eligible_snapshots;
```

## 8. Post-enable verification (baseline delta)

Re-run the §3 DB baseline + the log-based metrics and compare against the
recorded zero-state: claim counts by type should be non-zero, `liveClaims` hit
rate should climb, and rejection / `unknown_subject` / throttle rates should be
low and explainable. This before/after delta is the operational read on
whether Phase-1 is healthy — capture it in the same place as the §3 baseline.

At this point Phase-1 IG is **enabled**, not shadowed.

## 9. Rollback / stop conditions

Everything below is reversible without data loss — the tables are append-only;
disabling a flag stops new effects, it does not delete anything.

- **Immediate kill:** set `disable_intel_live_labels = true` (the IG-09 emergency stop) — suppresses every Live label instantly without touching records. This is the fastest single lever if live intelligence looks wrong in the wild.
- **Stop capture:** set `intel_capture_quick_signal = false` — the capture surfaces go inert (no entry points, no writes); the whole dependent chain (projection, labels, trail) fails closed with it.
- **Narrow rollback:** turn off only the offending flag (e.g. `intel_trail_followup`) and leave the rest.
- **Stop before enable if any of these hold:** `places_total = 0`; a pilot category has no canonical place; the E2E proof fails any assertion in §7 (especially the §7.8 privacy check); rejection or `unknown_subject` rate is anomalously high in the baseline; or the IG-07 compass-rhythm review (see §2) has not cleared — do not enable `intel_compass_rhythm_actor_gate` on the Phase-1 flip.
- **Data reset (rare):** intel rows are erased only via the `SECURITY DEFINER` `erase_intel_for_actor(uuid)` path (append-only tables refuse ordinary DELETE) — see `intelligence-gathering-buildout.md`.

---

_Do not enable any flag until §4 (places populated, category coverage met) and
§7 (E2E proof) pass. The gate is genuine dependency-readiness, not user
exposure._
