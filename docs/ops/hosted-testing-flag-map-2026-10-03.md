# Every switch in Portava, what it gates, and what turning it on would need

**Measured 2026-10-03 against `main` at `db657b73` and against production
(`ajrurzioarfkagpuxfnb`) read-only. No flag was created, deleted or toggled; no
production write was attempted.**

Purpose: Chelsi's goal is full functionality of the app in a **hosted testing**
deployment — not a public launch. Several threads had each found features
switched off in their own area and nobody had the whole picture. This is the
whole picture: every feature flag and kill switch in the code, what each gates,
its production value, why it is off where anything says so, and which of five
things turning it on would need.

- `FLAG FLIP ONLY` — nothing but the flip, after the deploy.
- `MIGRATION` — a migration must be applied first. **A flag with no row cannot
  be flipped at all** (§9), so every row-absent flag is in this class.
- `CONFIG` — only Chelsi can supply it (an env var, a secret, a provider key).
- `CODE` — it does not work yet, whatever the flag says.
- `DECISION` — somebody must choose. Each one below carries a recommended
  default and its reason.

## Scope and ownership

This thread owns the flag map. It does **not** own, and has not touched:
production applies, the deploy or post-deploy checks (rollout thread, which also
owns migrations 3502/2975, unsend and the Replit inspection); the scheduler,
background jobs, PR #561, story purge and media cleanup (story-retention
thread); the creator ledger and its identity-verification route (C-11 thread);
backlog items A1-A11 and B1-B13. Where a flag falls in one of those, it is
placed here and the owning thread is named, not re-decided.

**Not changed, by instruction:** `MEDIA_UPLOAD_VIDEO_ENABLED` and every
video-upload code path. The Replit workspace Chelsi publishes from may hold
video-upload code that is not on GitHub; that question is open and the
rollout thread's inspection request is pending. Its state is reported, nothing
is proposed.

**Settled rulings are kept, not revisited.** Where a flag is off because of one,
the ruling is named: `product-decisions-2026-09-22.md` settles #467, #472, #463,
#454 and #461.

## The five things worth knowing first

1. **Production's flag state cannot be rebuilt from this repository.** 72 flags
   are ON that every migration seeds OFF, and the audit log holds three rows in
   its entire history. A hosted database provisioned or restored from migrations
   comes up with those 72 off, silently — a much smaller app than production,
   with no error. §0.
2. **Nothing in the app is ranked today.** `ACTIVITY_DISCOVERY_BOOST_ENABLED` is
   false, which puts `rankItems` in shadow mode, and shadow mode returns items
   in input order (`DiscoveryRankingService.ts:1031`, `:1261-1270`). That is the
   centralised ranker for Pulse, Compass, Discovery, Search, Nearby, Stories,
   Events, Trips and Profiles. `MEDIA_RANKING_ENABLED` false does the same for
   the media feed. §3, §1.
3. **The media tab needs one flip.** `MEDIA_TAB_ENABLED` is read client-side
   only (`portavaRoutes.ts:160,974`); every mode and feed gate behind it is
   already on. Nine of the "off" `MEDIA_*` flags turn out to gate nothing at
   all, and likes and saves already work. §1.
4. **No Live intel label reaches anybody.** `intel_live_scope_promotion_enabled`
   is the only writer of the allowlist that `liveClaimRead.ts:358-359` reads, and
   an empty allowlist serves nothing — so four flags that are already ON serve
   nothing. §5.
5. **Phone verification cannot work as deployed**, by configuration or flag:
   `smsProvider.ts:112` implements only `mock`, and `mock` throws when
   `NODE_ENV=production`. That one needs a code change or a non-production
   `NODE_ENV`. §8.
## 0. The production flag table, measured, and why the repo cannot rebuild it

**Capture:** one read-only `SELECT` against project `ajrurzioarfkagpuxfnb`,
2026-10-03. No flag was created, deleted or toggled. `public.feature_flags`
holds **201 rows, 106 enabled**. The full `flag=0/1` list is reproduced in
Appendix A.

### The repo's own table is stale, not wrong

`docs/ops/flag-disposition.md` is the authoritative KEEP/DROP audit and it is
good work — but its live values were read **2026-08-12** against 168 rows.
Production now has 201. It answers "does anything read this flag"; it does not
answer "what would turning it on need", which is what hosted testing needs. This
write-up extends it rather than replacing it.

### Four populations, repo seeds vs production

Every `INSERT INTO feature_flags` tuple in `artifacts/api-server/src/migrations/*.sql`
and `migrations/*.sql` — 305 distinct seeded names — against the capture:

| Population | Count |
|---|---|
| seeded FALSE in the repo, **TRUE in production** | **72** |
| seeded TRUE in the repo, FALSE in production | 1 — `COMPASS_FALLBACK_MODE_ENABLED` |
| seeded in a migration, **no production row** | 107 |
| production row, **no seed in any migration** | 3 |

### What those numbers mean

**1. Production's enabled set is not in the repository, and nothing records why.**
Only two things in the tree change an existing `enabled` value:
`2077_enable_media_gem_uploads.sql` (the three upload/gem flags, with its reason
in the header) and five `on conflict do update` migrations (0085, 0090, 0127,
2210, 2960). Everything else in that 72 was turned on by a direct `UPDATE`.
`public.feature_flag_audit_log` holds **three rows in its entire history**, all
for `media_canonical_enabled` on 2026-09-25, all with `changed_by_user_id` NULL.
So for most of the 106 enabled flags, "why is this on" has no answer in the repo,
the ledger or the audit log — only in whoever typed the UPDATE.

**2. A fresh hosted database comes up much less functional than production, silently.**
Seeded state is the migrations' state. Provision or restore a database from
migrations and those 72 flags come up FALSE, with no error and no warning. That
includes `events_enabled`, `events_chat_enabled`, `passport_stamps_enabled`,
`passport_map_enabled`, `safe_return_enabled`, `trip_crew_live_share_enabled`,
`external_places_enabled`, `live_places_enabled`, `map_search_enabled`,
`trust_engine_enabled`, `fsq_places_enabled` and the whole stamp family. The
2026-10-03 capture is the **only** record of the intended state.

→ This is the single largest risk to "full functionality in hosted testing", and
it is not a flag being off. It is that nobody can state what on looks like
without reading production. See item PR-1 in §9.

**3. Three rows exist that no migration seeds.**
`COMPASS_JOURNEY_ENGINE_ENABLED`, `COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED`
and `COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED` — all false, all carrying
metadata, none seeded anywhere in this tree. Same class as the two unnamed media
migrations production ran on 2026-09-25. Only whoever authored that work can say
what they gate; this session cannot, and does not guess.

### Method note, for whoever re-runs this

A naive seed scan **reproduces a known defect** and must not be trusted.
`docs/ops/flag-disposition.md` records that `check-flag-polarity.mjs` and
`src/test/flagPolaritySeedScan.test.ts` both ended an INSERT at
`rest.indexOf(";")`, so a semicolon inside a quoted `description` truncated the
statement and hid 23 seeded flags. A first pass here hit it too, missing 32
names — every `RENT_BUDDY_*` mode flag, `invite_only_beta`, `disable_posting`,
`disable_signups`, `disable_messaging`, `compass_ai_enabled` and the
`shared_moments_*` children. The numbers above come from a parser that walks
forward respecting `''`-escaped quotes and `--` comments.
## A. The post-deploy flip list — handed to the production rollout thread

These are flips, not applies: the row exists in production, the schema behind it
is present, and nothing but the flag stands between a hosted tester and the
feature. **This thread does not flip anything.** Flag changes on production are
Chelsi's, and the rollout thread owns the order relative to the deploy.

Every row here was measured 2026-10-03. Each section below carries the evidence.

### A1. Flip after the deploy — no decision needed, nothing else required

| Flag | Now | What it turns on | §|
|---|---|---|---|
| `MEDIA_TAB_ENABLED` | false | the media tab itself; client-only gate, everything behind it is already on | §1 |
| `trip_kernel_enabled` | false | Compass trip proposals, trip closeout steps, offline-queue replay; schema fully applied | §2 |
| `trip_operational_projections_enabled` | false | trip operational projections; all 13 required tables present | §2 |
| `trip_map_projection_worker_enabled` | false | the map trip-projection worker | §2 |
| `map_trip_projection_read_enabled` | false | trips on the map (read side) | §2, §5 |
| `discovery_trip_projection_enabled` | false | trip projections into Discovery | §2 |
| `memory_projection` | false | the memory SQL projection (main path) | §2 |
| `memory_public_feed_projection_enabled` | false | the public memories feed projection | §2 |
| `memory_location_precision_enabled` | false | per-memory location precision | §2 |
| `telegraph_history_bound_enabled` | false | bounded group history; schema applied | §2 |
| `intel_live_scope_promotion_enabled` | false | **any Live intel label reaching anyone at all** | §5 |
| `intel_presence_verification_enabled` | false | presence verification | §5 |
| `layover_safe_return_status_enabled` | false | Safe Return status inside a layover | §5, §6 |
| `layover_discovery_mode_enabled` | false | Layover-narrowed Discovery serves | §5 |
| `passport_travel_dna_enabled` | false | Travel DNA — **and while off, users' Hide choices are ignored** | §7 |
| `ai_visual_admin_review_enabled` | false | the AI-visual review path | §7 |
| `highlights_feed_bounded_enabled` | false | a bounded highlights feed; 2339 applied, constants exist | §1, §2 |

### A2. Flip after the deploy, but each needs an answer first

| Flag | Now | The question | Recommended | §|
|---|---|---|---|---|
| `ACTIVITY_DISCOVERY_BOOST_ENABLED` | false | rank the feeds, or keep input order? | **on** — nothing is ranked today, and three dependent boosts are untestable | §3 |
| `rent_buddy_enabled` | false | accept Rent-a-Buddy reachable before 2210's readiness list? | **on** — synthetic accounts; the C-11 thread records the same decision | §3 |
| `media_canonical_enabled` | false | turn the canonical media writer back on? | **on** — the schema is ready and the tree records no reason for the 2026-09-25 flip | §1 |
| `compass_decision_enabled` | false | show the seven-verdict decision surface? | **on** — migration applied, read-only, degrades to WAIT | §4 |
| `opportunity_engine_enabled` | false | open `/api/intel/opportunities`? | **on** — read-only, no new tables | §4 |
| `COMPASS_FALLBACK_MODE_ENABLED` | false | keep the degraded-feed path available? | **on** — it is the degradation path | §4 |
| `layover_stable_recommendation_ids_enabled` | false | accept the 2410 cutover without the full measurement run? | **on** — "Add to plan" is gated on `rec.id`, which this suppresses, so layover plans are untestable end to end | §5 |
| `presence_cleanup_enabled` | false | flip the flag, or keep driving the ungated cleanup endpoint? | **flip** | §6 |
| `trip_retention_sweep_enabled` | false | may the server delete trip evidence and forget pasted booking text? | **on** — 2789 + 2791 applied | §6 |
| `trip_absence_guard_enabled` | false | stop public previews announcing future trip dates? | **on** — additive and reversible | §6 |
| `wall_enabled` | false | expose the Wall? | **on, with 2308 applied** and the children staged one at a time | §7 |
| `DISCOVERY_ENGINE_MODE` | metadata | legacy / shadow / pde? | **shadow** — comparison data, served order unchanged | §4 |

### A3. Deliberately left OFF — recommended, with the reason

| Flag | Why it stays off |
|---|---|
| `MEDIA_UPLOAD_VIDEO_ENABLED` | the open Replit question; not ours to decide or change |
| `layover_maturity_gate_enabled` | ON is the restrictive direction — every airport classifies L0 and testers lose all landside Layover (2977: 0 of 3,206 airport_profiles verified) |
| `map_telemetry_enabled` | 2202 states off-by-default as a privacy contract; the client queues locally and loses nothing |
| `intel_contribution_retention_enabled` | irreversible 180-day contributor deletion; a young corpus means it deletes nothing while adding an irreversible job |
| `account_deletion_worker_enabled` | metadata marks it `irreversible`; stay manual for hosted testing |
| `media_pending_upload_sweep_enabled` | a destructive deletion job, and 3400 and 3467 disagree on its threshold |
| `media_canonical_schema_fallback_enabled` | it is the fallback for a MISSING schema; the schema is present, so enabling it now would be wrong |
| `discovery_circle_candidates_enabled` | its own migration says "APPROVAL REQUIRED (D-W10-R3-4)" — consent |
| `discovery_dwell_telemetry_enabled` | its own migration says it waits on the owner's consent (B-1, D-W10-O-9) |
| the 5 ranking boosts + creator fatigue | census-media MD2 treats them off as the desired state |
| `invite_only_beta` | false means signup is open, which is what hosted testing wants |
| every `disable_*` kill switch | all 13 are disengaged, which is correct; they are stops, not features |

### A4. Needs a migration applied before any flip

107 flags have **no production row**, and `PATCH /api/admin/feature-flags`
answers 404 for a flag with no row — it never inserts (§9). The ones that matter
for hosted-testing functionality, by the migration they wait on:

| Migration | Flag(s) it seeds | What it unblocks |
|---|---|---|
| 2308 | — (table only) | Wall analytics: 13 of 15 §32 events are discarded behind a 200 without it |
| 2801 | `wall_moments_enabled` | `/api/wall/moments` |
| 2294 | `passport_event_share_enabled` | sharing a passport from an event |
| 2810 + 2811 | `telegraph_message_kernel_enabled` | unsend, reactions, sequencing, the durable outbox (**rollout thread owns 2810**) |
| 2993 + 3001 | — | the Highlight half of the memory kernel; without them flipping `memory_kernel_enabled` 503s every Highlight pin/unpin |
| 2129 | `location_snapshot_purge_enabled` | the location-snapshot purge |
| 2990 | `nearby_reachable_enabled` | nearby-reachable |
| 2922 | `creator_attribution_enabled` | the creator ledger (**C-11 thread owns this**) |
| 2981 / 2977 | layover ingest / maturity gate | the second layover write path |
| 2300 | `PORTAVA_PUBLISHER_BOOST_ENABLED`, `PORTAVA_FEATURED_BOOST_ENABLED` | those two boosts |
| 3002 | — | `intel_contributor_token()`, which two already-ON intel flags call |
| 2892 + 3484 | — | **apply before flipping any §85 or `discovery_trend_*` flag** |
| the 3xxx block (3366-3500) | ~39 `discovery_*` pipeline flags | the Discovery pipeline lanes; `production-applied-migrations.json` contains no 3xxx entry at all |

**Caveat stated rather than buried:** `production-applied-migrations.json` is
known to LAG production — production ran two media migrations on 2026-09-25 that
exist in no file in this repository. "Not in the record" is therefore not the
same as "not applied". Where a verdict above rests on the record alone, the
section says so; where it was confirmed against production's own catalogue, it
says that instead.
## B. What only Chelsi can supply

No flag turns these on. Each is an environment variable or a provider
credential on the hosted deployment, and a feature whose key is missing fails
quietly rather than loudly in most cases.

### B1. The server will not start without these
`PORT`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SESSION_SECRET`
(`envValidation.ts:9-14`).

### B2. Background work that does nothing until the variable is set
| Variable | Set it to | Without it |
|---|---|---|
| `STAMP_WORKER_ENABLED` | `true` | no stamp is ever generated (`index.ts:261`) |
| `FX_REFRESH_ENABLED` | `true` | FX rates go stale (`index.ts:275`) |
| `PLACE_COLLECTIONS_WORKER_ENABLED` | `true` | the place-collections worker never runs (`placeCollectionsWorker.ts:683`) |

### B3. Providers
| Variable | What it unlocks | Without it |
|---|---|---|
| `AI_INTEGRATIONS_OPENAI_API_KEY` (+ `_BASE_URL`) | Telegraph recommendations, stamp artwork, AI visuals, real translation | placeholder SVGs, no AI writing; `compass_ai_writing_enabled` on + no key fails silently |
| `GOOGLE_MAPS_API_KEY` | place photos, Google Routes travel times | straight-line travel estimates only |
| `FSQ_API_KEY_DEV` (prefer DEV so testing does not burn production quota) | venue search | silently disabled; `replit.md:53` records the current key being 401'd |
| `TICKETMASTER_API_KEY` | City Pulse events | silently empty |
| `MAPBOX_TOKEN` | server-side geocoding | no geocoding |
| `TRANSLATION_PROVIDER=openai` | real translation | **defaults to `mock` while translation is ON** — fake translations that look real (`translation.ts:51,164`) |
| `IDENTITY_PROVIDER` + a sandbox key + `IDENTITY_WEBHOOK_SECRET` | identity verification, and with it Rent-a-Buddy booking creation | `mock` throws on a hosted deployment (`providers.ts:149-153`). **The C-11 thread owns this route.** |
| `LAYOVER_EVENT_PRODUCER_SECRET` | the layover event producer endpoint | refused regardless of the flag (`layoverEvents.ts:113`) |
| `LAYOVER_ROUTED_CORRIDOR_ENABLED` + `GOOGLE_MAPS_API_KEY` | real landside travel times | straight-line estimates |

### B4. Secrets whose absence makes a write throw
| Variable | Without it |
|---|---|
| `SENSING_CONTRIBUTOR_PEPPER` (≥32 chars) | sensing writes throw (`sensingAnonStore.ts:157`) |
| `INTEL_EVIDENCE_REFERENCE_KEY` (≥32 chars) | no evidence is stored (`intelEvidenceCapture.ts:400`) |
| `INTEL_GROUP_KEY_SECRET`, `LAYOVER_OBSERVER_PEPPER`, `TRIP_OFFLINE_BUNDLE_SECRET` | they fall back to `SESSION_SECRET`; set dedicated ones so rotation is independent |
| `ALLOWED_ORIGINS` | browser clients break unless the hosted web origin is listed (`app.ts:34`) |

### B5. Mobile, build-time — these need an EAS rebuild, not a flag flip
`EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY`: absent, the
release build shows "App not configured" (`app/index.tsx:28`). All three EAS
profiles point at the same backend, so **the hosted test app shares
production's flag table** — there is no separate testing flag state to set.

### B6. Risks in the other direction — ON unless you turn them off
| Variable | Why it matters |
|---|---|
| `TRANSLATION_ENABLED` | on by default; with the mock provider that means fake translations presented as real |
| `STAMP_COUNTRY_SWEEP_ENABLED` | only the literal `"false"` stops a sweeper that merges catalog rows (`xxCatalogRepair.ts:474`) |
| `NOTIFICATION_MAINTENANCE_DISABLED` | the maintenance pass runs unless you opt out |
| `startVisualGenerationWorker()` | **has no switch at all** (`index.ts:270`) and spends OpenAI credits |
| `PAYMENTS_ALLOW_LIVE` | leave unset; it defaults safe-off and `paymentsMode.ts` refuses live keys without it |

### B7. One that configuration cannot fix
`SMS_PROVIDER` has **no working value**. `smsProvider.ts:112` sets
`IMPLEMENTED_PROVIDERS = new Set(["mock"])`, `mock` throws when
`NODE_ENV=production`, and both the `twilio` and `messagebird` adapters are
stubs whose `send` throws (`:170-181`). Phone verification therefore cannot work
on a hosted deployment as configured. Two ways out, and this is a DECISION:
implement one adapter against a sandbox (a code change, the same shape as the
identity-provider route the C-11 thread is taking), or run the hosted server
with `NODE_ENV` set to something other than `production` and accept `mock`.
**Recommended: run with a non-production `NODE_ENV` for hosted testing**, because
it costs nothing, keeps the sandbox transcript out of the critical path, and
phone verification is not the subject under test.

## C. How long a flip takes to reach a tester

Server-side, immediately: `isFlagEnabled` is an uncached per-request read
(`lib/featureFlags.ts:14`). On the device, the app fetches `GET /api/feature-flags`
on mount and on every return to the foreground (`FeatureFlagsContext.tsx:72-84`)
with no polling and no TTL, so the worst case for a running app is **the next
time the tester backgrounds and reopens it**. No rebuild is needed. Two flags
lag a further five minutes behind a module-level cache: `rent_buddy_enabled`
(`useRentABuddyFlag.ts:13`, with a "Check again" reset at `:209`) and
`find_your_circle_enabled` (`useCircleFlag.ts:14`, no in-app reset).

The client receives **resolved** values — `resolveFeatureFlags` applies the Live
Places parent hierarchy server-side (`routes/featureFlags.ts:60`) and the client
re-applies it. So **flipping a Live Places child alone does nothing**; the
`external_places → live_places → place_days → shared_moments` chain has to be on
first. It is, today, in full.

Five mobile gates are hardcoded and no flag flip can move them: the two E2EE UI
gates (`src/lib/e2ee/verificationGate.ts:29,68`), the resumable upload transport
(`src/services/media/uploadTransportFlag.ts:19`), device video compression
(`src/services/media/videoCompression.ts:61` — adjacent to the open video
question, nothing proposed) and account-scoped storage
(`src/config/accountScopedStorageFlag.ts:17`).
## D. The decisions, collected

Every `DECISION` from every section, in one place, each with the recommendation
this thread would act on if nobody says otherwise. The ones in §A2 are the
flips; these are the rest.

| # | The question | Recommended |
|---|---|---|
| D1 | Phone verification: implement an SMS adapter, or run hosted testing with a non-production `NODE_ENV`? | non-production `NODE_ENV` — it is not the subject under test |
| D2 | `MEDIA_LIKES_ENABLED` / `MEDIA_SAVES_ENABLED`: wire them or retire them? | neither — the features already work without them |
| D3 | Nine flags gate nothing yet reach both the admin UI and the mobile client (6 `events_*`, `passport_contribution_enabled`, `stamp_admin_award_enabled`, `ai_visual_regeneration_enabled`) | drop the rows, as `2080_retire_inert_seeded_flags.sql` did for the previous ten |
| D4 | Collapse the `find_your_circle_enabled` / `find_your_circle_disabled` pair? | no — they gate different doors and the current pair is the working one |
| D5 | `MEDIA_TAB_WORLD_DEFAULT_ENABLED`, and the three `MEDIA_WATCH_*` | off for now; they are owner F1/F2 calls and need 3340-3343 applied first |
| D6 | The 11 `COMPASS_<TYPE>_SAFETY_BLOCK` rows are seeded by no migration, so the per-content-type emergency stop **cannot be engaged at all** (`compass/flags.ts:35-37` calls this a latent defect) | seed all 11 `false` in a migration, so the stop exists and is reachable from the audited toggle path. Worth doing **before** hosted testers start generating content |
| D7 | Accept an undrained `telegraph_outbox` / `memory_event_outbox` during testing? | yes; truncate before launch |
| D8 | Run `telegraph_backfill_message_sequences`? | no — no reader uses `sequence` |
| D9 | Moderation-evidence `retention_until` | leave NULL, apply 2812, flip on |
| D10 | `discovery_candidate_projection_enabled` — §6 D9 truth-class labels are unratified | on for hosted testing only |
| D11 | `discovery_for_you_pde_enabled` + `discovery_cache_a_ranked_enabled` after 3455/3456 | leave off on the first pass |
| D12 | `safe_return_enabled` is ON — does Safe Return need sub-minute escalation? | yes, which means an always-on host; the fallback is a code change (internal HTTP trigger + `job_health`) |
| D13 | `plan_geofence_full_enabled` is TRUE with zero read sites repo-wide | treat it as stale; do not list it as an enabled feature |

### Three things nobody can answer from here

1. **Why 72 flags are on.** There is no audit row and no migration for them. If
   any of those values was deliberate for a reason that still holds, only
   Chelsi knows it. §0.
2. **What `COMPASS_JOURNEY_ENGINE_ENABLED`,
   `COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED` and
   `COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED` gate.** They exist in
   production with metadata and no migration in this repository seeds them.
   Same class as the two unnamed media migrations. §0.
3. **Whether the Replit deployment is autoscale or a Reserved VM.** Every
   "does this background job actually run" question turns on it, and only
   Chelsi can read it. The story-retention thread owns the consequences.
## E. The code-side blockers, and what this thread did about them

### E1. Fixed on this branch — three emergency stops that disengaged when they were most needed

All three are the same class, and the class is the subject of
`src/lib/telegraphThreadWrite.ts`'s own header: a guard whose failure mode is
silent, that reads as safe to a reviewer.

1. **`CREATE_COORDINATION_SESSION` was a second, weaker door into `messages`.**
   One writer, two callers. `routes/telegraphCoordination.ts:335` applies
   `guardTelegraphThreadWrite` — the kill switch, ACTIVE membership, the 1:1
   block guard and the E2EE refusal. `server/telegraph/commandRoute.ts` applied
   only membership, and `coordinationSessions.ts:151-157` recorded that
   asymmetry as a fact without noticing it was a hole. So three gates were
   reachable past by posting the command to `/api/telegraph/commands`:
   `disable_messaging` ENGAGED and the row still landed; a 1:1 thread where the
   other person had blocked the caller; and an **E2EE thread**, into which the
   command writes a `JSON.stringify`d plaintext envelope. This matters now
   rather than later because `CREATE_COORDINATION_SESSION` is deliberately
   outside `SCHEMA_GATED_COMMANDS` and goes live the moment anyone deploys
   `main`. Fixed by routing the write through the shared guard. Five tests;
   S1/S2/S3 each assert what the `messages` table holds afterwards, not the
   status code, and all three go red without the fix.
2. **The Discovery stop disengaged when there was no service client.**
   `lib/discoveryStopGate.ts` read `disable_discovery_pde` through
   `sc ? await isKillSwitchEngaged(sc, …) : false`. Both halves of that are one
   fact — the stop's state could not be established — and they were treated
   oppositely: an unreadable `feature_flags` ENGAGED the stop, an absent client
   lifted it. `lib/discoveryEngineMode.ts:257` already takes the other decision
   for the engine mode this gate was extracted to generalise. Now returns
   `no_client`, which halts. **Latent, not live, and the code says so:** no
   present caller can reach it, because `routes/discoveryOutputKinds.ts:59`
   refuses a null client first and every other reader derives its `flagOn` from
   the same client. The shape is what is fixed.
3. **The ratchet that was supposed to catch (2) was blind to its spelling.**
   `src/test/verifyFailOpenStopReads.test.ts` exists precisely as a class-level
   ratchet on this defect, and its pattern matched only
   `x && await isKillSwitchEngaged(x`. The ternary form is the same bug with the
   else branch written out — `: false` is the defect stated as a literal — and
   it sailed through. This is the live finding of the three: a class ratchet
   that knows one spelling of its class is a list of known sites wearing a
   regex. Widened, with a fixture that transcribes the line that escaped and
   asserts the old pattern could not have seen it, so the commit cannot pass by
   changing nothing.

### E2. Code-side items found and NOT fixed here, with the reason

Each is real and each is small; none is on the critical path to hosted
functionality, and bundling them would have made one reviewable change into
five.

| Item | Where | Why not here |
|---|---|---|
| `DISCOVERY_TRIP_PROJECTION` is unregistered in `lib/capability/registry.ts`, so the capability reads `latent` and is invisible to `checkFlagSchemaPrerequisites` | registry | changes a check's output; belongs in its own diff |
| `lib/discoveryStopGate.ts`-class ternary elsewhere: none found after the widened ratchet ran clean | — | nothing to fix |
| `MEDIA_DEFAULT_VIEW_MODE` never reaches the client — `/api/feature-flags` selects only `flag, enabled, description`, and that flag's behaviour is in `metadata` | `routes/featureFlags.ts` | a contract change to a public endpoint |
| `media_canonical_read_enabled`'s loader has no caller; the wiring line is missing in `MediaProjectionService.projectCandidatesProtected` | media | the flag is row-absent anyway, so it is behind a migration first |
| `disable_location_sharing` covers only 3 read sites and does **not** reach trip-crew live share, §12 positions or Safe Return live share, contrary to `0065:86`'s own description of it | `routes/location.ts` and 2 others | a safety stop whose scope is a decision, not a typo — raised as D-adjacent rather than silently widened |
| `safeReturnScheduler` writes no `job_health` row and has no `/healthz/schedulers` entry, so its silence is unobservable | scheduler | the story-retention thread owns scheduler health and PR #561 |
| `circle_presence.expires_at` is nullable, and null-expiry rows are skipped by both delete passes **and** never hit the guard's hard-expiry branch, so they are served forever; flipping `presence_cleanup_enabled` does not fix it | circle presence | a data-retention defect in the story-retention thread's area |
| Nine inert `MEDIA_*` flags gate nothing (likes, saves, grid/gems ranking, processing pipeline, four gem CTAs, provenance labels, admin review) | media | D2/D3 decide whether to wire or retire |
| Six stale code comments each assert a production state that has since changed: `lib/mapTripProjectionWorker.ts:42-46`, `domain/trips/policies/tripOperationalProjections.ts:8-10`, `lib/discoveryTripProjectionConsumer.ts:138`, `lib/discoveryCandidate.ts:120-126`, `capability/registry.ts:160-162` and `:232-237`, `lib/compassRhythmGate.ts:19-22` | various | each would move line numbers that doc citations anchor to; they want one careful sweep with `check:doc-citations` re-measured, not a scatter |
| `2068_live_places_rollout_flags.sql:32` calls `live_places_enabled` a "master kill switch" in its description when the code reads it as a fail-closed CAPABILITY flag | migration text | a migration already applied to production cannot be edited; the correction belongs in a new one |
## 01 — MEDIA AND STORIES flags

Domain: every `MEDIA_*` / `media_*` flag, plus `stories_enabled`,
`highlights_feed_bounded_enabled`, `passport_memories_enabled`.
**55 flag keys covered** (37 `MEDIA_*`/`media_*` with code readers or prod rows,
15 lowercase `media_*`, 3 stories/highlights/memories). One candidate name was
verified NOT to be a flag and is dropped (see §0.3).

All production values are from the 2026-10-03 read-only capture
(`prod-sorted.txt`). "row absent" = no row at all; `isFlagEnabled` returns false
either way, but the operator cannot flip it without a migration first.

Migration-applied status is taken from
`artifacts/api-server/src/lib/capability/production-applied-migrations.json`.
That file's own `$comment` says it is **a staleness tripwire, not an inventory**
— it records what *we* applied, and hand-applies through the Supabase dashboard
write no row. Of every migration in this section only **2339**, **2256** and
**2470** appear in it (lines 195, 255, 275). Where I say "production does not
have it per the ledger", that is what the ledger says, not proof of absence; for
the row-absent flags the production flag capture independently confirms the seed
never landed.

---

### 0. Headline answers

#### 0.1 Does the hosted test app have a working Media tab? No — and one flip fixes it.

`MEDIA_TAB_ENABLED` is **false** in production. It is read client-side only, as
the `featureFlag` of the `tab-media` route
(`travel-buddy-standalone/src/navigation/portavaRoutes.ts:160`) and of
`media/add-gem` (`:974`). With it false there is no Media tab in the nav bar at
all; `app/(tabs)/media.tsx` stays registered so deep links still resolve
(`docs/architecture/census-media.md:235,248`).

**Everything behind the tab is already on.** The three mode flags the tab filters
its mode list by (`app/(tabs)/media.tsx:54-57,72`) are all **true** in
production, and so is the server gate each mode's feed hits:

| Mode | Client mode flag | Server feed gate | Prod |
| --- | --- | --- | --- |
| Watch | `MEDIA_VIEW_MODE_FULLSCREEN_ENABLED` = true | `MEDIA_FOR_YOU_ENABLED` at `routes/mediaFeed.ts:1285-1288` = **true** | works |
| Grid | `MEDIA_VIEW_MODE_GRID_ENABLED` = true | `MEDIA_VIEW_MODE_GRID_ENABLED` at `routes/mediaFeed.ts:588-590` = true | works |
| Gems | `MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED` = true | `MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED` at `routes/mediaFeed.ts:813-815` = true | works |

The store's default mode is `watch`, so the tab opens on Watch
(`src/stores/mediaStore.ts:104,145`, recorded at census-media:248-253).

> **MINIMUM FLIP SET FOR A WORKING MEDIA TAB: exactly one flag —
> `MEDIA_TAB_ENABLED` = true.** `FLAG FLIP ONLY`. No migration (the row exists,
> seeded by `2037_media_tab_flags.sql:7`), no code, no config. The flag is served
> by `GET /api/feature-flags` and the app re-fetches on foreground
> (`src/context/FeatureFlagsContext.tsx:52-84`), so no new client build is
> needed — the shipped bundle already contains the tab, the three feeds and the
> quick-create sheet.

What that one flip does **not** give you, each needing its own flip (detail in
§1):

- **Following tab in Watch** — `MEDIA_FOLLOWING_ENABLED` false ⇒
  `GET /api/media/feed?feedType=following` answers `feature_disabled`
  (`routes/mediaFeed.ts:1285-1288`).
- **"Near Me" in Gems** — `MEDIA_HIDDEN_GEMS_NEARBY_ENABLED` has **no row**
  ⇒ `routes/mediaFeed.ts:827-829` refuses and the chip is hidden. Needs
  migration 2300 first.
- **View counting** — `MEDIA_RANKING_ENABLED` false ⇒ `POST /media/:id/view`
  answers `{ counted: false }` (`routes/mediaFeed.ts:1988-1991`). Note this is a
  graceful no-op, **not** an error: the feed still renders.
- **Comments / Shares** — `MEDIA_COMMENTS_ENABLED` and `MEDIA_SHARES_ENABLED`
  false ⇒ `routes/mediaFeed.ts:2473-2476` and `:2431-2432` refuse.
- **Ranking** — `MEDIA_RANKING_ENABLED` false ⇒ the feed is reverse-chronological
  (census-media:15884-15887).
- **The World shell** — `MEDIA_WORLD_SHELL_ENABLED` has no row; `/media-world` is
  registered and reachable from nothing (census-media:233).

#### 0.2 The "big block of false MEDIA_* flags" — nine of them are INERT

This is the most load-bearing finding in my domain. **Nine of the off `MEDIA_*`
flags have no code reader anywhere.** Flipping them changes nothing. Verified by
a repo-wide grep (excluding `node_modules`) for each literal in `*.ts/*.tsx/*.js`
across `artifacts/api-server`, `travel-buddy-standalone` and the rest of the
tree: every hit was either `src/migrations/*.sql`, a prose comment, or
`src/test/mediaAdminFlags.test.ts`.

| Flag | Prod | Only appearances |
| --- | --- | --- |
| `MEDIA_LIKES_ENABLED` | false | seed `2038:41`; a prose mention at `routes/mediaFeed.ts:2427` |
| `MEDIA_SAVES_ENABLED` | false | seed `2038:45`; prose at `routes/mediaFeed.ts:2427` |
| `MEDIA_GRID_RANKING_ENABLED` | false | seed `2038:25` |
| `MEDIA_GEMS_RANKING_ENABLED` | false | seed `2038:27` |
| `MEDIA_PROCESSING_PIPELINE_ENABLED` | false | seed `2038:33` |
| `MEDIA_GEMS_SUBMIT_ENABLED` | **true** | seed `2038:51`, flipped on by `2077_enable_media_gem_uploads.sql:15` |
| `MEDIA_GEMS_WRONG_PLACE_REPORT_ENABLED` | false | seed `2038:53` |
| `MEDIA_GEMS_ADD_TO_TRIP_ENABLED` | false | seed `2038:55` |
| `MEDIA_GEMS_DIRECTIONS_ENABLED` | false | seed `2038:57` |
| `MEDIA_AI_PROVENANCE_LABELS_ENABLED` | false | seed `2038:61` |
| `MEDIA_ADMIN_REVIEW_ENABLED` | false | seed `2038:69` |

(Eleven rows; nine distinct "off and inert" plus `MEDIA_GEMS_SUBMIT_ENABLED`
which is on and inert, and `MEDIA_ADMIN_REVIEW_ENABLED`.)

**The consequence for likes and saves is the opposite of what the flag names
suggest: liking and saving ALREADY WORK in production.** `POST /media/:id/like`
(`routes/mediaFeed.ts:2226`), `DELETE .../like` (`:2308`), `POST .../save`
(`:2324`) and `DELETE .../save` (`:2373`) read **no** feature flag. They check
auth, `verifyMediaAccess`, and a self-like guard, then write. Share (`:2408`) and
comments (`:2462`) *are* gated; like and save are not. So "likes and saves are
off in production" is false — the rows say off, the code never asks.

`admin.ts:780-784` refuses to toggle a flag in its `HIDDEN_INERT_FLAGS` set
(`:662`), but none of these eleven names is in that set — so the admin UI will
happily toggle them and nothing will happen.

#### 0.3 `MEDIA_SHARING_ENABLED` is not a flag — dropped

It is a **misspelling**, documented as such at
`2300_phantom_feature_flag_rows.sql:78` and `routes/mediaFeed.ts:2422-2430`: the
share route read `"MEDIA_SHARING_ENABLED"` until 2300, no such row ever existed
in any migration or either live database, so `isFlagEnabled` returned false
unconditionally and no operator action could change it. The literal was corrected
to `MEDIA_SHARES_ENABLED`. The only surviving occurrences of the misspelling are
the explanatory comments and a stale doc comment at
`travel-buddy-standalone/src/components/media/MediaMoreMenu.tsx:7`. **Not a flag
key; no row; nothing to flip.** `MEDIA_ALBUM` (in `telegraphKinds.test.ts`) is a
telegraph message kind, and `media_assets` / `media_attachments` /
`media_intent_signals` / `media_view_requests` / `media_dedup_groups` /
`media_events` / `media_url` / `media_type` / `media_route` / `media_trip_add` /
`media_place_open` / `media_does_not_match_place` are table names, column names,
telemetry event names and an intent code — all excluded.

---

### 1. `MEDIA_*` flags with a production row

All rows in this section exist, so every one is at worst a flag flip plus
whatever the "to turn on" column names. All are **capability** flags (fail-closed
via `isFlagEnabled`); none is a kill switch.

#### `MEDIA_TAB_ENABLED` — capability
- **Gates**: UI only. The Media tab's presence in the nav bar, and the
  `media/add-gem` route. `travel-buddy-standalone/src/navigation/portavaRoutes.ts:160`
  and `:974`. No server read.
- **Production**: `false`.
- **Why off**: `2038_media_admin_flags.sql:7-9` — *"Replace the centre Plus/create
  button with a persistent Media tab (Watch · Grid · Gems). false restores the
  original create button."* `2037_media_tab_flags.sql:2` — *"MEDIA_TAB_ENABLED
  gates the entire tab"*. Conservative seed; no blocker recorded.
- **To turn on**: `FLAG FLIP ONLY`.
- **Depends on**: nothing. (It is itself the prerequisite for every other Media
  surface flag — `3340:33` states *"MEDIA_TAB_ENABLED (2037) must be ON, or there
  is no Media tab in the nav bar"*.)

#### `MEDIA_VIEW_MODE_FULLSCREEN_ENABLED` — capability
- **Gates**: UI only. Listing "Watch" in the mode selector
  (`app/(tabs)/media.tsx:55`). No server gate — the Watch feed's own gate is
  `MEDIA_FOR_YOU_ENABLED`.
- **Production**: `true`. **Why off**: not off. Seeded true at `2038:11`.
- **To turn on**: already on.

#### `MEDIA_VIEW_MODE_GRID_ENABLED` — capability
- **Gates**: a READ **and** UI. Server: `handleGridFeed` at
  `routes/mediaFeed.ts:588-590` answers `feature_disabled` ("Grid feed is not
  available") for `GET /api/media/feed?mode=grid`. Client: `app/(tabs)/media.tsx:56`.
- **Production**: `true`. Seeded true at `2038:13`. **To turn on**: already on.

#### `MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED` — capability
- **Gates**: a READ **and** UI. Server: `routes/mediaFeed.ts:813-815`
  (`GET /api/media/gems-feed`, "Gems mode is not available"). Client:
  `app/(tabs)/media.tsx:57`.
- **Production**: `true`. Seeded true at `2038:15`. **To turn on**: already on.

#### `MEDIA_FOR_YOU_ENABLED` — capability
- **Gates**: a READ. The default (`for_you`) branch of `GET /api/media/feed` —
  i.e. the **Watch feed itself**. `routes/mediaFeed.ts:1285-1288`.
- **Production**: `true`. Seeded `false` at `2038:19`; somebody flipped it on.
  The tree records no reason for the flip.
- **To turn on**: already on. This is why one flip is enough for a working tab.

#### `MEDIA_FOLLOWING_ENABLED` — capability
- **Gates**: a READ. The `following` branch of `GET /api/media/feed`;
  `feature_disabled` "following feed is not available".
  `routes/mediaFeed.ts:1285-1288`.
- **Production**: `false`.
- **Why off**: `2038:21` — *"Enable the Following feed tab in Watch mode."*
  Conservative seed; no stated blocker.
- **To turn on**: `FLAG FLIP ONLY`. The handler's follow lookup is in the same
  file and needs nothing extra.
- **Depends on**: `MEDIA_TAB_ENABLED` for the surface to be reachable.

#### `MEDIA_RANKING_ENABLED` — capability
- **Gates**: a WRITE. `POST /api/media/:id/view` — `routes/mediaFeed.ts:1988-1991`
  answers `{ counted: false }` and records nothing. Also the ranking fallback:
  census-media:15884 records that with it false `rankMediaFeed` returns
  chronological order with no scoring.
- **Production**: `false`. **Why off**: `2038:23` — *"Enable server-side Compass
  ranking for the media feed (falls back to recency when disabled)."*
- **To turn on**: `FLAG FLIP ONLY` for view counting and for scoring to run. Note
  that with all five boost flags off (below) the scorer applies no
  creator-identity term (census-media:15884-15896).
- **Depends on**: nothing. The four creator boosts and creator fatigue are
  independent sub-terms, not prerequisites.

#### `MEDIA_COMMENTS_ENABLED` — capability
- **Gates**: a READ. `GET /api/media/:id/comments` —
  `routes/mediaFeed.ts:2473-2476`, "Comments are not available". Client-side the
  comment sheet renders *fail-open* on an unknown flag
  (`src/components/media/MediaCommentSheet.tsx:9` — *"only when
  MEDIA_COMMENTS_ENABLED is true (or unknown — fail-open on mobile)"*), so with
  the flag false the sheet opens and the server refuses. That mismatch is worth
  knowing when testing.
- **Production**: `false`. **Why off**: `2038:43` — *"Enable comment interactions
  on media items."*
- **To turn on**: `FLAG FLIP ONLY`. The route delegates to the existing
  `posts_comments` table (`:2459`, `:2492`); gems return an empty list by design
  (`:2482-2484`).

#### `MEDIA_SHARES_ENABLED` — capability
- **Gates**: a WRITE. `POST /api/media/:id/share` —
  `routes/mediaFeed.ts:2431-2432`, "Media sharing is not available".
- **Production**: `false`. **Why off**: `2038:47`. Note the gate was *unreachable
  by any operator action* until 2300, because the literal read was misspelled —
  `routes/mediaFeed.ts:2419-2430`.
- **To turn on**: `FLAG FLIP ONLY`.

#### `MEDIA_LIKES_ENABLED`, `MEDIA_SAVES_ENABLED` — capability, **INERT**
- **Gates**: nothing. No reader. `POST/DELETE /media/:id/like`
  (`routes/mediaFeed.ts:2226`, `:2308`) and `POST/DELETE /media/:id/save`
  (`:2324`, `:2373`) read no flag — **both already work in production.**
- **Production**: `false` (both). **Why off**: seeds `2038:41,45`.
- **To turn on**: `DECISION` — *should the like/save routes be wired to the flags
  they were seeded for, or should the two rows be retired as inert?*
  **RECOMMENDED default for hosted testing: retire nothing and flip nothing.**
  The behaviour Chelsi wants (likes and saves working) is already the behaviour;
  wiring the gate now could only take a working feature away, and
  `2080_retire_inert_seeded_flags.sql` is the established path for the cleanup if
  someone wants the rows gone later. Flipping them true is harmless but also
  pointless, and it would make the flag list lie in the other direction.

#### `MEDIA_ANALYTICS_ENABLED` — capability
- **Gates**: a WRITE (background, fire-and-forget). `recordMediaEvent` at
  `lib/mediaAnalytics.ts:180` — with it false nothing is written to
  `media_events`. Callers are `routes/mediaFeed.ts:2253`,
  `routes/mediaAnalyticsBatch.ts`, `routes/routePlan.ts:292` and the mobile
  `src/services/mediaInteractions.ts:154`. Never user-visible; the header at
  `lib/mediaAnalytics.ts:12` says it *"fails open = does nothing"*.
- **Production**: `false`. **Why off**: `2038:65`; `2039_media_events.sql:4` —
  *"Write is fire-and-forget and gated by MEDIA_ANALYTICS_ENABLED."*
- **To turn on**: `FLAG FLIP ONLY`. Recommended ON for hosted testing — it is the
  only way to see whether the Media surfaces are being exercised.

#### `MEDIA_UPLOAD_ENABLED` / `MEDIA_UPLOAD_PHOTO_ENABLED` — capability
- **Gates**: UI only, and only in one component. `AddGemForm.tsx:110-111` computes
  `imageEnabled = isEnabled('MEDIA_UPLOAD_ENABLED') && isEnabled('MEDIA_UPLOAD_PHOTO_ENABLED')`.
  `src/lib/contentMediaPolicy.ts:213` records that the policy is *"gated at runtime
  by MEDIA_UPLOAD_PHOTO_ENABLED / MEDIA_UPLOAD_VIDEO_ENABLED flags."*
  **There is no server-side read of either flag.** `POST /media/upload`
  (`routes/posts.ts:84-110`) gates on auth, `admitUploadBeforeBody`,
  `guardUploadRequest` (the `disable_media_uploads` kill switch) and byte
  verification — no `MEDIA_UPLOAD_*` flag appears in the handler.
- **Production**: both `true` (flipped on together by
  `2077_enable_media_gem_uploads.sql:13-14`; seeded false at `2038:31,37`).
- **To turn on**: already on.

#### `MEDIA_UPLOAD_VIDEO_ENABLED` — capability — **OPEN QUESTION, REPORT ONLY**
- **State**: production `false`. Seeded false at `2038:35-36`, described as
  *"Allow video uploads specifically (requires MEDIA_UPLOAD_ENABLED)."*
  `2077_enable_media_gem_uploads.sql` flipped `MEDIA_UPLOAD_ENABLED` and
  `MEDIA_UPLOAD_PHOTO_ENABLED` on and deliberately left this one alone.
- **Gates**: UI only, one site — `AddGemForm.tsx:113`
  (`videoEnabled = isEnabled('MEDIA_UPLOAD_ENABLED') && isEnabled('MEDIA_UPLOAD_VIDEO_ENABLED')`).
  No server gate.
- **The open question** (BRIEF §"Settled rulings"): the Replit workspace may hold
  video-upload code that is not on GitHub, so this repository may not be the whole
  implementation. Until that is resolved, nobody can say what flipping this flag
  would actually enable.
- **Per the brief I propose no code change here.** I note only the facts above and
  that the flip is *not* obviously `FLAG FLIP ONLY`, because the three video stages
  that would process an uploaded clip (`media_transcoder_enabled`,
  `media_captions_enabled`, `media_moderation_classifier_enabled`) all have no row
  and no implemented adapter (§2).

#### `MEDIA_DEFAULT_VIEW_MODE` — capability-shaped, but a **metadata carrier**
- **Gates**: nothing through its boolean. `2038:73-76` is explicit: *"metadata.mode
  holds the actual value (watch | grid | gems); the enabled boolean is unused for
  this flag — mode lives in metadata."* The only code mention is a doc comment at
  `travel-buddy-standalone/src/stores/mediaStore.ts:129` describing a
  *"Server-configured default mode (from MEDIA_DEFAULT_VIEW_MODE flag)"*. I could
  not find any code that reads the metadata: `GET /api/feature-flags` selects only
  `flag, enabled, description` (`routes/featureFlags.ts:21`) and so **cannot carry
  the mode to the app at all.**
- **Production**: `false` (row present).
- **To turn on**: `CODE` — the metadata is unreachable by the client. Making a
  server-configured default mode work needs either `GET /api/feature-flags` to
  project `metadata` (it deliberately does not today) or a dedicated field on a
  media endpoint, plus a client read in `mediaStore`. Precise shape: extend the
  select at `routes/featureFlags.ts:21` or add the resolved mode to the media feed
  response, then have `mediaStore`'s `defaultMode` prefer it over the hardcoded
  `'watch'` (`src/stores/mediaStore.ts:104,145`). **Not needed for hosted
  testing** — the tab opens on Watch, which is the intended default anyway.

#### `MEDIA_HIDDEN_GEMS_CREATE_ENABLED` — capability
- **Gates**: UI only. The "Add a Gem" entry in the Media tab's quick-create sheet
  when in Gems mode — `src/components/media/MediaQuickCreateSheet.tsx:128`.
- **Production**: `true`. Codified by `2084_codify_live_read_flags.sql:58`, whose
  header (`:12,:33,:38`) explains it as the precedent case of a flag reading true
  in the live database with no migration having seeded it.
- **To turn on**: already on. **Depends on**: `MEDIA_TAB_ENABLED` (the sheet lives
  in the tab) and `MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED`.

#### The five ranking sub-flags — capability
`MEDIA_ACTIVE_CREATOR_BOOST_ENABLED`, `MEDIA_NEW_CREATOR_BOOST_ENABLED`,
`MEDIA_RETURNING_CREATOR_BOOST_ENABLED`, `MEDIA_UNDEREXPOSED_BOOST_ENABLED`,
`MEDIA_CREATOR_FATIGUE_ENABLED`
- **Gates**: a READ's ordering. All five are bulk-loaded by
  `loadMediaRankingFlags` and mapped to scorer terms at
  `services/ranking/MediaFeedRankingService.ts:890-906` (one line per flag,
  `:902`–`:906`). Each switches off one boost/penalty term; the feed still
  returns, just without that term.
- **Production**: all `false`. Rows seeded by `2040_media_ranking_boost_flags.sql:7,9,11,13,15`
  and re-converged by `2085_converge_absent_seeded_flags.sql:58-66` — whose header
  (`:6-10`) names each flag with the exact reader line, i.e. these were flags the
  code read with **no row at all** until 2085 created them.
- **Why off**: conservative seeds. census-media:15884-15896 records that with all
  five off *"on production no ordering carries a creator-identity boost today"*,
  which is the first half of requirement MD2's closing condition — i.e. being off
  is currently a **desired** property, not a defect.
- **To turn on**: `DECISION` — *should hosted testing turn on creator-identity
  boosts, given census-media MD2 ("World-first, not creator-first") treats their
  being off as half of that requirement's satisfaction?*
  **RECOMMENDED default: leave all five OFF.** Testing full functionality of the
  Media tab does not require a creator boost, and turning them on contradicts a
  recorded product requirement. `MEDIA_RANKING_ENABLED` can be on without them.
- **Depends on**: `MEDIA_RANKING_ENABLED` — the scorer only runs when it is on.
  (Related but out of my domain: `PORTAVA_PUBLISHER_BOOST_ENABLED` and
  `PORTAVA_FEATURED_BOOST_ENABLED`, loaded by the same function, have **no row**;
  2300 seeds them.)

#### `MEDIA_GRID_RANKING_ENABLED`, `MEDIA_GEMS_RANKING_ENABLED`, `MEDIA_PROCESSING_PIPELINE_ENABLED`, `MEDIA_GEMS_SUBMIT_ENABLED`, `MEDIA_GEMS_WRONG_PLACE_REPORT_ENABLED`, `MEDIA_GEMS_ADD_TO_TRIP_ENABLED`, `MEDIA_GEMS_DIRECTIONS_ENABLED`, `MEDIA_AI_PROVENANCE_LABELS_ENABLED`, `MEDIA_ADMIN_REVIEW_ENABLED` — capability, **INERT**
- **Gates**: nothing. No reader anywhere (§0.2). The grid handler is explicit that
  *"No ranking is applied — items are returned in reverse-chronological order"*
  (`routes/mediaFeed.ts:571`), with no flag consulted; the gem CTAs, provenance
  badges and the `/admin/media` queue are described in the seeds but not gated in
  code.
- **Production**: all `false` except `MEDIA_GEMS_SUBMIT_ENABLED` = `true`.
- **Why off**: seeds `2038:25,27,33,51,53,55,57,61,69`.
- **To turn on**: `CODE` for each, if the described behaviour is actually wanted —
  the gate does not exist, so the flag cannot deliver it. Concretely: Grid ranking
  needs `handleGridFeed` (`routes/mediaFeed.ts:574`) to call the ranking service
  instead of its chronological order; the four Gems CTA flags need reads in the
  gems item components; `MEDIA_AI_PROVENANCE_LABELS_ENABLED` needs a read where the
  badge would render; `MEDIA_ADMIN_REVIEW_ENABLED` needs an `/admin/media` route
  that does not exist. **None of this is needed for a working Media tab**, and I
  do not recommend building any of it for hosted testing — the honest statement is
  "these eleven toggles are decorative today".

---

### 2. `MEDIA_*` and `media_*` flags with NO production row

Every flag in this section is `row absent` in the 2026-10-03 capture, and in each
case the migration that seeds it is **not** in
`production-applied-migrations.json`. So each is at minimum `MIGRATION`, because
an operator cannot flip a row that does not exist — `2300`'s header makes the
point directly (`:36-44`): *"the entire Media v2 surface was un-flippable without
a migration."*

#### `MEDIA_WORLD_SHELL_ENABLED` — capability
- **Gates**: UI **and** two WRITEs. Client: the World entry pill
  (`app/(tabs)/media.tsx:190`), the media viewer's World affordances, and
  `resolveMediaSurfaceDecisions` (`src/features/media/state/mediaSurfaceFlags.ts:64`).
  Server: `routes/mediaActions.ts:518-521` (`eventLinkPreamble` — every
  media→event link action answers `feature_disabled`) and
  `services/media/MediaActionResolver.ts:1115`. census-media:233 lists the full
  blast radius: the §3–§5 six-lens shell, the §15 action rail
  (`app/media-viewer/[id].tsx:568`), the §44/§45 north-star emitter, the §32
  viewer affordances; `/media-world` is a registered route reachable from no UI.
- **Production**: `row absent`.
- **Why off**: `2300_phantom_feature_flag_rows.sql:113-116` seeds it false —
  *"OFF (the seed): the Media tab behaves exactly as it does today … Until this
  row existed the surface could not be enabled at all."* 2300's postcondition
  (`:160-166`) refuses a seed that finds any of its five rows ON.
- **To turn on**: `MIGRATION` — apply `2300_phantom_feature_flag_rows.sql`
  (production does not have it per the ledger; the flag capture confirms the row
  is absent), then flip. After that it is a flag flip; no code or config.
- **Depends on**: `MEDIA_TAB_ENABLED` for the pill to be reachable.

#### `MEDIA_HIDDEN_GEMS_NEARBY_ENABLED` — capability
- **Gates**: a READ and UI. Server: `routes/mediaFeed.ts:827-829` —
  `areaMode === "near_me"` answers `feature_disabled` "Near Me mode is not
  available". Client: `GemsFeed`'s `nearMeEnabled` prop
  (`app/(tabs)/media.tsx:117`, `src/components/media/GemsFilterBar.tsx:66`).
- **Production**: `row absent`.
- **Why off**: `2300:118-121` — *"Location-adjacent, so it stays off until
  deliberately enabled."*
- **To turn on**: `MIGRATION` (2300) then flip. The server ranks by viewer-supplied
  `X-User-Lat`/`X-User-Lng` headers, so no provider config is needed.
- **Depends on**: `MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED` (true), `MEDIA_TAB_ENABLED`.

#### `MEDIA_TAB_WORLD_DEFAULT_ENABLED` — capability
- **Gates**: UI only. Whether the Media tab lists World first and opens on it —
  `src/features/media/state/mediaSurfaceFlags.ts:64`, `app/(tabs)/media.tsx:54,72`.
- **Production**: `row absent` (3340 not applied).
- **Why off**: `3340_media_tab_world_default_flag.sql:76-78` — the postcondition
  **raises** if the flag is ON: *"making the World shell the Media tab's default is
  the owner's F1 decision and this must ship OFF"*. `:70` emits a notice that
  *"flipping 3340 ON changes nothing a user sees unless both are ON"*.
- **To turn on**: `DECISION` — *should the Media tab open on the World shell
  instead of Watch (owner decision F1)?* **RECOMMENDED default: leave it off for
  hosted testing.** The Watch/Grid/Gems surface is the one that is proven to work
  end-to-end today; World is reachable from no UI and its own shell flag also needs
  a migration. Turning F1 on would change the first screen of the tab before the
  tab itself has been exercised. After the decision it is `MIGRATION` (3340 **and**
  2300) plus two flips. census-media:11939 lists the full activation checklist
  including a `mobile-reachability-ledger` entry.
- **Depends on**: `MEDIA_WORLD_SHELL_ENABLED` (hard requirement — `mediaSurfaceFlags.ts:64`
  ANDs them, and `3340:32` says without the shell this flag has no effect) and
  `MEDIA_TAB_ENABLED`.

#### `MEDIA_WATCH_CONTEXT_OVERLAY_ENABLED` — capability
- **Gates**: UI only, mobile. The Watch action rail leads with Ask Compass; Stamp /
  comment / save keep their controls and lose their counts; the place leads the
  left column. Read at `src/features/media/state/mediaSurfaceFlags.ts:65`, consumed
  by `src/components/media/WatchItemOverlay.tsx` through
  `src/features/media/hooks/useMediaSurfaceDecisions.ts`
  (`3341_media_watch_context_overlay_flag.sql:9-16`).
- **Production**: `row absent` (3341 not applied).
- **Why off**: `3341:2-3` — the overlay half of **owner surface decision F2**,
  seeded OFF.
- **To turn on**: `DECISION` (half of F2) — *should the Watch overlay lead with
  Compass and drop engagement counts?* **RECOMMENDED default: off.** Same reason as
  F1: it changes the surface under test. Then `MIGRATION` (3341) plus a flip.
- **Depends on**: `MEDIA_TAB_ENABLED`, `MEDIA_VIEW_MODE_FULLSCREEN_ENABLED`.

#### `MEDIA_WATCH_TAP_TO_PLAY_ENABLED` — capability
- **Gates**: UI only, mobile. A cell scrolling into view is paused with a "Tap to
  play" mark; the playback manager stops calling `playAsync` on viewability.
  `src/features/media/state/mediaSurfaceFlags.ts:66`, for
  `src/components/media/WatchFeedList.tsx` and `src/hooks/useWatchPlayback.ts`
  (`3342_media_watch_tap_to_play_flag.sql:10-17`).
- **Production**: `row absent` (3342 not applied).
- **Why off**: `3342:2-3` — the autoplay half of owner decision F2, seeded OFF.
- **To turn on**: `DECISION` (half of F2) — *should Watch stop autoplaying?*
  **RECOMMENDED default: off**, so hosted testing exercises the shipped autoplay
  behaviour. Then `MIGRATION` (3342) plus a flip.

#### `MEDIA_WATCH_STAGE24_RANKING_ENABLED` — capability
- **Gates**: a READ's ordering, **server-side**. `GET /api/media/feed` (the Watch
  feed) orders by `MediaRankingService.rankCandidatesForViewer` instead of
  `MediaFeedRankingService`. Read at
  `services/media/WatchStage24Ranking.ts:51` via `isFlagEnabled`
  (`3343_media_watch_stage24_ranking_flag.sql:10-18`).
- **Production**: `row absent` (3343 not applied).
- **Why off**: `3343:2-3` — the ranker half of owner decision F2, seeded OFF.
- **To turn on**: `DECISION` (half of F2) — *should Watch be ordered by the §24
  stage (which reads no like, stamp, view, watch-time or completion signal)
  instead of the legacy ranker?* **RECOMMENDED default: off for hosted testing**,
  because with `MEDIA_RANKING_ENABLED` also off the feed is chronological and
  that is the simplest thing to reason about while verifying the tab. Then
  `MIGRATION` (3343) plus a flip.

#### `media_canonical_read_enabled` — capability
- **Gates**: a READ. `lib/media/mediaCanonicalRead.attachCanonicalMedia`
  (`lib/media/mediaCanonicalRead.ts:206`, flag constant at `:162`) loads
  `media_attachments → media_assets` for a page of candidates so
  `lib/media/mediaProjection` can prefer the canonical store and fall back to
  `post_media` then `posts.media_urls`.
- **Production**: `row absent` (2336 not applied).
- **Why off**: `2336_media_canonical_control_flags.sql:84-102` — *"SEEDED FALSE,
  and it would be inert even if it were true: media_attachments holds ZERO rows in
  both databases, so the join returns nothing."* And: *"the loader has no caller
  yet. Its one wiring line belongs in
  services/media/MediaProjectionService.projectCandidatesProtected and was
  deliberately left to that file's owner."*
- **To turn on**: `CODE` — the loader has no caller. Add the single wiring call in
  `MediaProjectionService.projectCandidatesProtected`; then `MIGRATION` (2336) and
  a flip. Even then it is inert until `media_attachments` is backfilled
  (preconditions B1–B5 in the header of `lib/media/mediaCanonicalRead.ts`); 2336's
  row description warns that only 1 of 6 ready `post_media` rows in production has
  a canonical counterpart, so partial coverage would mix capture-clock sources
  across surfaces. **Not needed for hosted testing.**
- **Depends on**: `media_canonical_enabled` (so there is anything to read).

#### `media_canonical_schema_fallback_enabled` — capability
- See §3 — this is the canonical-write fallback and is answered there.

#### `media_evidence_enabled` — capability
- **Gates**: a READ and a WRITE. `lib/media/mediaEvidenceLink.ts:130` (the write
  adapter for the media→intel evidence seam) and
  `lib/intelProjectionAggregator.ts:465` (`hasEvidence`).
- **Production**: `row absent` (2255 not applied).
- **Why off**: `2255_media_evidence_seam.sql:10-18` — the MASTER gate for the §9/§35
  seam, *"seeded FALSE"*, *"all dark until an admin flips the flag"*; the migration's
  postcondition raises if it is seeded ON.
- **To turn on**: `MIGRATION` (2255) then flip. **But** it also depends on the
  canonical columns: `mediaEvidenceLink` selects `provenance, captured_at` and
  returns false on error, which `lib/mediaAssets.ts:167-187` lists as one of the
  four paths broken wherever 2250's columns are missing. Those columns **are**
  present in production now (2470 applied, §3), so that part is satisfied.
- **Depends on**: `media_canonical_enabled` in practice — evidence links point at
  `media_assets` rows, and with the writer off no new asset rows exist.

#### `media_request_a_view_enabled` — capability
- **Gates**: a READ, a WRITE and UI. Server: `services/media/MediaViewRequestService.ts:96`
  (flag constant `:48`). Client: `src/features/media/components/RequestAViewPrompt.tsx:65`,
  `ContributorTrustChips.tsx:38`, `ContributorViewOptInToggle.tsx:35`,
  `src/features/media/services/viewRequest.ts:197-199`.
- **Production**: `row absent` (2257 not applied).
- **Why off**: `2257_media_view_requests.sql:15-19` — the master gate, *"seeded
  FALSE"*, *"all dark until an admin flips the flag"*.
- **To turn on**: `MIGRATION` — and this one is more than a flag row. 2257 also
  creates the storage: census-media:239-243 records that **`media_view_requests`
  and `media_view_request_optins` are absent from production**
  (`baseline/20260907_production_tables.txt`;
  `scripts/checkProductionDrift.ts:173-176` classifies each *"In portava-ci, absent
  from production"*). So: apply 2257 (tables + flag row), then flip.
- **Depends on**: the §19 flow also references `intel_mission_candidates` (2167) by
  FK (`2257:7-11`), so that table must exist first.

#### `media_find_busier_enabled` — capability
- **Gates**: a READ. `GET /media/:id/actions` offers `find_busier`, and the §32
  Compass media context reports a `busier` comparator axis.
  `services/media/MediaActionResolver.ts:1223` (constant `:1219`).
- **Production**: `row absent` (3351 not applied).
- **Why off**: `3351_media_find_busier_flag.sql:3` — one capability flag, seeded OFF.
- **To turn on**: `MIGRATION` (3351) then flip. `3351:11` records the extra runtime
  conditions it inherits from its siblings: *"Compass on, and a canonical place the
  location/gem choke point lets this viewer be told about."*
- **Depends on**: the Compass master gate (another agent's domain) and a canonical
  place on the item.

#### `media_neighborhood_only_mode_enabled` — capability
- **Gates**: a WRITE and every Media READ's location ceiling.
  `lib/media/neighborhoodOnlyMode.ts:42` (constant `:28`), read in the app at
  `src/features/media/screens/MediaContributionScreen.tsx:155`. OFF: `POST /posts`
  refuses a `neighborhood_only` vantage.
- **Production**: `row absent` (3350 not applied).
- **Why off**: `3350_media_neighborhood_only_location_mode.sql:3` — one new owner
  location mode and one capability flag, seeded OFF.
- **To turn on**: `MIGRATION` — 3350 is **not just a flag row**: it adds the fifth
  value `neighborhood_only` to the DB enum `post_location_privacy_mode`
  (`3350:8-12`). The enum value must exist before the flag can mean anything.
  Then flip.

#### `media_perspective_vantage_enabled` — capability
- **Gates**: a WRITE. `lib/media/perspectiveVantage.ts:115` (constant `:52`), read
  in the app at `src/features/media/screens/MediaContributionScreen.tsx:155`. OFF:
  `POST /posts` refuses a declared vantage.
- **Production**: `row absent` (3352 not applied).
- **Why off**: `3352_media_perspective_vantage.sql:3` — seeded FALSE.
- **To turn on**: `MIGRATION` — 3352 adds `posts.perspective_vantage text NULL`
  with a CHECK over the §12 union of vantage words (`3352:16-19`), plus the flag
  row. Column first, then flip.

#### `media_processing_worker_enabled` — capability
- **Gates**: a background JOB and a WRITE. `services/media/MediaLifecycleService.ts:429`
  (constant `:421`) and `lib/media/mediaProcessingWorker.ts`. The worker is started
  unconditionally at `index.ts:302` and reads the flag once a minute; with it off
  every pass does nothing. The **same** flag gates `POST /media/:id/retry`, which
  while off *"refuses (404 feature_disabled) and writes nothing, because a failed
  asset re-queued with no worker to claim it would be parked in `queued` … for
  good"* (`3338_media_processing_worker_flag.sql:18-21`).
- **Production**: `row absent` (3338 not applied).
- **Why off**: `3338:2-3` — seeded OFF.
- **To turn on**: `MIGRATION` (3338) then flip.
- **Depends on**: `media_canonical_enabled` — the worker claims `media_assets`
  rows (`3338:11-16`), and with the canonical writer off there are no new ones. So
  flipping the worker on while the writer is off gives a worker with nothing to do.

#### `media_pending_upload_sweep_enabled` — capability, **destructive**
- **Gates**: a background JOB that DELETES. `lib/media/pendingUploadSweepScheduler.ts:100`
  reads it at the top of every hourly pass (`:130`), running
  `services/media/PendingUploadSweep.ts`. Started at `index.ts:302`. ON: every
  `post_media` row still `pending` past its activity window has its **unstripped
  original**, feed variant, resumable parts and poster removed, then the row
  deleted — oldest first, 200 a pass. OFF/absent: nothing runs. **Unreadable:
  nothing runs and the pass records a FAILURE, never a clean idle tick** —
  *"a deletion job must not run on a guess"* (`3400:19-22`).
- **Production**: `row absent` (3400 not applied; 3467 only rewrites its
  description and is also not applied — `3467_cross_architecture_flags.sql:24,57`).
- **Why off**: `3400_media_pending_upload_sweep_flag.sql:3` — seeded OFF; `3467:57`
  — *"Turning it ON deletes never-completed uploads; that is an owner decision."*
- **To turn on**: `DECISION` — *should hosted testing run a job that permanently
  deletes abandoned uploads and their unstripped originals?* **RECOMMENDED
  default: leave it OFF.** Hosted testing wants to be able to inspect what happened
  to a half-finished upload, and the only cost of leaving it off is storage. Note
  also that 3400 and 3467 disagree about the threshold (one hour vs 2 h 30), and
  3467 exists to correct 3400's description — applying 3400 alone would install
  text 3467 then refuses (`3467:76-78`). If it is ever turned on, apply **both**.

#### `media_vision_provider_enabled`, `media_moderation_classifier_enabled`, `media_transcoder_enabled`, `media_captions_enabled` — capability (the four vendor stages)
- **Gates**: all four are read in `lib/media/vendors/mediaVendorStages.ts` —
  `:60` vision, `:63` moderation, `:66` transcode, `:69` captions (constants
  `:54-57`). Each gates a stage of `POST /media/upload`'s ingestion
  (`runMediaVendorIngest`), i.e. a WRITE-path side effect:
  - **vision** (`3355`): also gates `GET /media/search` with `looksSocial=true` or
    `lookLike=<id>`. OFF: empty result with `visual.state = stage_off`. ON with no
    adapter: `visual.state = no_provider`, empty (`3355:14-19`).
  - **moderation** (`3356`): `decidePreDistribution` — the decision between upload
    and distribution. OFF: `/postcards/:id/media/:mediaId/complete` writes
    `moderation_status = 'approved'`, exactly as before the stage existed. ON:
    approve → `approved`, restrict/hold → `flagged`, block → `rejected`; on
    `media_assets` it maps approve→active, hold→limited, block→rejected, *"where
    the §36 CHECK exists (2250/2470; the service refuses the schema otherwise and
    says so)"* (`3356:10-22`).
  - **transcode** (`3357`): each new video's canonical asset goes to the configured
    transcoder. *"Nothing is served from this stage yet"* (`3357:10-16`).
  - **captions** (`3358`): asks the configured caption source for a WebVTT track,
    stored at `<storage_path>.captions.vtt`. *"A stored track is not yet served to
    anyone"* (`3358:9-17`).
- **Production**: all four `row absent` (3355–3358 not applied).
- **Why off**: each migration's header, *"seeded OFF"*, with the postcondition
  refusing a seed that finds it ON.
- **To turn on**: `CONFIG` for all four — **Chelsi must supply a provider.** Each
  seam is a typed adapter interface with a **refusing default and no implemented
  adapter**; choosing the vendor is explicitly the owner's decision
  (`3355:9-11`). The env vars named in the headers are:
  - `MEDIA_VISION_PROVIDER` (`3355:21-22`)
  - `MEDIA_TRANSCODER` (`3357:11`)
  - `MEDIA_CAPTION_SOURCE` (`3358:10`)
  - moderation: `lib/media/vendors/mediaModerationClassifier` — the header names no
    env var, so **I could not establish the moderation classifier's configuration
    variable from the code I read.** Do not assume one.
  Order of operations: pick a vendor → set its variable → `MIGRATION` (3355 /
  3356 / 3357 / 3358 as applicable) → flip. Flipping without an adapter is
  **safe but useless**: ON answers `not_configured`, logs, and sends nothing
  (`3357:13`, `3358:14-15`). `3358:20-21` flags the captions one as a
  data-protection decision about users' speech, and `3357:19` flags the
  transcoder as a cost decision.
- **Depends on**: `media_canonical_enabled` for the moderation stage's
  `media_assets` write, and on 2250/2470's columns (present — §3).
- **Interaction with video upload**: these are the three stages that would process
  an uploaded clip. Per the brief I propose nothing about
  `MEDIA_UPLOAD_VIDEO_ENABLED`; I only record that two of its three downstream
  processing stages have no implemented adapter.

#### `media_private_buckets_enabled` — capability, **gate retired**
- **Gates**: nothing at runtime any more. `routes/mediaFile.ts:9-12` is explicit:
  *"Both buckets (post-media, profile-media) are PRIVATE. The feature flag
  `media_private_buckets_enabled` that previously gated the signed-URL path **has
  been retired** — signed URLs are always issued. Authorization runs before signing
  in both routes."* The only surviving readers are two operational scripts:
  `scripts/set-media-buckets-private.ts:31` (which **refuses** to run while the flag
  is OFF — `:36`) and the read-only `scripts/check-media-bucket-privacy.ts:29`.
  `lib/mediaAccess.ts:993` mentions it in prose only.
- **Production**: `true`.
- **To turn on**: already on. Leave it on — turning it off would block the
  bucket-privacy script and change nothing else. Not a hosted-testing lever.

---

### 3. `media_canonical_enabled` — does false BREAK or BYPASS the canonical write path?

**It BYPASSES it, cleanly, and the fallback flag is not the fallback.** This was
the question I was asked to settle; here is the chain.

#### The gate
`media_canonical_enabled` is a lowercase capability flag read by `isFlagEnabled`
(fail-closed). It is the **first line** of every canonical write entry point in
`lib/mediaAssets.ts`:

- `:321` `recordMediaAssetDetailed` — returns `NONE` with
  `outcome: "skipped_flag_off"` (the `NONE` literal is built at `:309-315`).
- `:628` — returns `null`.
- `:763` — returns `null`.
- `:826` — returns `NONE`.
- `:1078` `recordEntityMedia`'s batch caller — returns `0`.

Every caller is fire-and-forget (`void recordMediaAsset(...)`), and the file's own
header states the design: *"Writes here are DUAL-WRITE, flag-gated
(`media_canonical_enabled`) and fail-soft: legacy bare-URL columns keep working
untouched; when the flag is off (or an insert fails) callers proceed exactly as
before"* (`lib/mediaAssets.ts:7-10`). `:209` labels the off state
*"`media_canonical_enabled` is off — no DB contact beyond the flag read."*

**So: false = the dual-write's canonical half is skipped. The legacy stores
(`post_media`, `posts.media_urls`) remain authoritative and keep working. No
upload fails, no user-visible behaviour changes.** `docs/ops/sensing-production-approval-request.md:177`
states the inverse the same way: set `false` and *"writes stop and the legacy
stores stay authoritative."*

#### What false does cost you
`media_assets` gets no new rows, and three read paths that consult it therefore
see nothing new (enumerated at `lib/mediaAssets.ts:285-300`, re-stated at
`2336:46-52`):
- `services/wall/WallCandidateLoaders.loadQuickMediaItems` — the §18 Stories /
  Quick Media row (assets from the last 24 h);
- `services/media/MediaProjectionService` ~line 746 — the §30 My World "Uploads"
  bucket count, reached through a **variable** table name, which is the blind spot
  `src/scripts/checkWriterlessReads.ts` warns about;
- `lib/mediaAccess.ts:238` — owner attribution before the bytes are served, i.e.
  **an authorization input, not a display one.**

And one request path hard-fails: `routes/sharedMoments.ts:230` gates a
contribution on `media_assets` holding a row the caller owns ("You can only
contribute your own media"), so *"with the writer dead that request path cannot
succeed for any media uploaded since 2026-08-16"* (`lib/mediaAssets.ts:26-30`).
Note that is a **downstream** consequence of an empty table, not the gate
breaking.

#### Is the schema a problem? No — not any more.
The schema-capability guard runs **after** the flag read and **before** any
payload is built (`lib/mediaAssets.ts:263-272`, `:325-350`): `probeCanonicalAssetSchema`
checks for the four columns migration 2250 adds
(`CANONICAL_ASSET_COLUMNS_ADDED_BY_2250` at `:189-194` — `captured_at`,
`location_visibility`, `provenance`, `intelligence_eligibility`). A `missing` or
`unknown` verdict ⇒ `outcome: "refused_schema"`, logged at **error**, zero upserts.

**Those columns are present in production.** `2470_media_asset_canonical_columns_flag_agnostic.sql`
— 2250's DDL re-issued without 2250's postcondition that the flag be FALSE — **is
applied to production**, recorded at `production-applied-migrations.json:275` and
in its `$comment` for 2026-09-16 17:37–17:42: *"2470 completes MEDIA_CANONICAL
(ORDER B: the flag was already TRUE and is untouched)."* The code confirms it:
`lib/mediaAssets.ts:13` — *"[SUPERSEDED. Re-measured read-only 2026-09-26:
production reads FALSE (set 2026-09-25 15:39 UTC) and 2470's four columns are
present, so the writer is off BY THE FLAG, not refused by the schema; census-media
§23.2.]"*; `docs/architecture/census-media.md:4615` and `:4876` say the same.

> **Verdict: `media_canonical_enabled = false` BYPASSES the canonical write path.
> It does not break it. Flipping it true resumes canonical writes on the next
> probe cycle (≤ 30 s, `lib/media/mediaSchemaCapability`) with no code change and
> no migration — `2470:48-50` states exactly that for ORDER B.**

#### The fallback — and why it is now the wrong tool
`media_canonical_schema_fallback_enabled` (`lib/mediaAssets.ts:332`, `:437`) is
**not** the fallback for the flag being off. It is the fallback for the **schema**
being absent: when the verdict is `missing` **and** this flag is on, the writer
drops **all four** 2250 columns up front and records a degraded row instead of
refusing (`:437-466`; it drops all four rather than the one PostgREST named,
because PostgREST reports only the first unknown column — `:304-307`).

- **Production**: `row absent` (2336 not applied per the ledger; the flag capture
  confirms no row). `isFlagEnabled` ⇒ false either way, so **the branch is
  unreachable** (`lib/mediaAssets.ts:277-284`).
- **Why off**: `2336:75-80` — *"SEEDED FALSE because it is a workaround, not the
  fix. The fix is to apply 2250 to production."*
- **To turn on**: **do not.** `CONFIG`/`MIGRATION` are both the wrong answer here;
  the correct label is `DECISION` and the recommended decision is **never enable
  it**, because the condition it exists for no longer holds — 2470 is applied and
  the columns are present. Enabling it now could only cause a *degraded* write
  (four columns silently dropped) where a full write is available. Its own row
  description says *"Apply 2250 first"*; 2470 already did the equivalent.

#### What to do for hosted testing
`DECISION` — *should `media_canonical_enabled` be turned back on?* This is the open
half of blocker `MEDIA_CANONICAL_FLAG` (`docs/architecture/blocker-ledger.md:121`:
*"What remains the owner's: whether to turn the canonical writer back ON — which
3321 requires before it will run on production"*; same in
`docs/architecture/migration-disposition-ledger.md:154`). **The tree records no
reason for the 2026-09-25 15:39 UTC flip to false** — census-media:4615 and the
blocker ledger both say so explicitly, and I could not find one either. That
unexplained flip is the only reason this is a decision and not a flip.

**RECOMMENDED default: turn it ON for hosted testing** — because without it the
§18 Quick Media row, the §30 Uploads count and `routes/sharedMoments.ts:230`'s
contribution path cannot work for anything uploaded after 2026-08-16, which is
squarely inside "full functionality". It is `FLAG FLIP ONLY` mechanically (row
present, columns present, no code change), and reversible by flipping back.
`docs/ops/sensing-production-approval-request.md:177` already offers a verification
recipe: *"one upload writes one media_assets row (read-only count before and
after)"*, with rollback *"set false; writes stop and the legacy stores stay
authoritative."* Two cautions: the flip lights up three user-facing reads as a
side effect (`lib/mediaAssets.ts:285-300`), and `3321_media_moderation_canonical_state.sql`
is stated to require the writer ON before it will run on production.

---

### 4. Stories, Highlights and Passport Memories

#### `stories_enabled` — capability (with a fail-OPEN quirk)
- **Gates**: every Stories route. `routes/stories.ts:43` —
  `return isFlagEnabled(sc, "stories_enabled").catch(() => true);` — wrapping the
  shared helper in a `storiesEnabled()` local. Routes covered by the file header
  (`:1-14`): `POST /stories`, `GET /stories/feed`, `GET /stories/:id`,
  `DELETE /stories/:id`, `POST /stories/:id/react`, `.../reply`, `.../viewers`,
  `.../save-to-highlight`. So it gates READs, WRITEs and UI state alike.
- **Polarity note**: the `.catch(() => true)` is **fail-open**, which is the
  opposite of the house convention. In practice it is near-dead code —
  `isFlagEnabled` already swallows its own errors and returns `false` on an error
  or absent row (`lib/featureFlags.ts:14-26`), so the `.catch` only fires if the
  promise rejects for some other reason. Worth flagging for the cross-cutting
  polarity review; it is not a problem while the flag is true.
- **Production**: `true`, since 2026-06-30 (`/mnt/project-files/story-retention-proposal-2026-09-22.md:215`;
  seeded by `0068_stories.sql` per `docs/migrations.md:636`).
- **To turn on**: already on.

**What else a working Stories feature needs besides the flag.** Three things, and
the flag is not the constraint:

1. **Storage — present.** `0068_stories.sql` created `stories`, `story_views`,
   `story_reactions`, `story_replies`, `close_friends`, both enums and their RLS,
   and was *"Applied via Supabase Management API"* on 2026-06-30
   (`docs/migrations.md:636`). Nothing to do.
2. **Reachability — present, and recently so.** `travel-buddy-standalone/app/stories.tsx:1-16`
   records the gap it closed: *"StoriesStrip, StoryViewer and StoryComposer were
   built and nothing under app/ mounted any of them: no story could be opened, so
   none could be reacted to, replied to or saved to a highlight. This is where
   they live."* The `/stories` route carries **no** `featureFlag` in
   `portavaRoutes.ts` (only `requiresAuth: true`), and the one in-app entry point
   is `src/components/create/CreateHubSheet.tsx:66` (`route: '/stories'`). So for
   hosted testing: the route is reachable **only** from the create hub. If Chelsi
   expects a stories strip at the top of a feed, that mount does not exist — that
   would be `CODE`, and it is not a flag.
3. **Uploads — gated by someone else's kill switch.** `StoryComposer` posts media
   through `POST /media/upload`, which is guarded by `disable_media_uploads` (§5).
   Stories cannot be created while that stop is engaged, whatever `stories_enabled`
   says.

**Expiry / purge — another thread's, noted not designed.** `sweepExpiredStories`
(`routes/stories.ts:973`) is the expiry job; it is invoked from
`routes/health.ts:170` via an endpoint that exists specifically because the sweep
had no scheduler (`routes/health.ts:124-139`). Its successor is
`lib/storyRetentionScheduler.ts` and `services/stories/storyRetention.ts`, which
writes `story_purge_queue` (migration **2998**, which is **not** in
`production-applied-migrations.json` — zero hits). I found **no feature flag**
gating either the retention scheduler or `storyRetention.ts` (grep for
`isFlagEnabled` / `_enabled` / `FLAG` in that file returns nothing), so there is
no flag in my domain to report for it.

Overlap to respect: this is the territory of
`/mnt/project-files/story-retention-proposal-2026-09-22.md`,
`story-retention-rollout-2026-09-23.md` and
`story-retention-scheduling-and-purge-2026-10-02.md`, and of **settled decision
##461** (`/mnt/project-files/product-decisions-2026-09-22.md:242-302`): *"remove
deletion triggered solely by expiry; expiry must still end audience access"*, with
the reasoning that `post-media` is private (`:257`) and
`lib/mediaAccess.ts` branch 3d already requires `state ∈ (active, saved)` so
expired media is owner-only (`:260-261`). That doc also records that **#461's
retention work is another thread's (#524)** (`:52-53`). **I design nothing here
and propose no change to it.**

#### `highlights_feed_bounded_enabled` — capability
- **Gates**: a READ's shape, not its availability. `routes/highlights.ts:2696`
  decides whether `GET /highlights/following-feed` applies a limit and cursor
  (`:2697-2701`). OFF: the unbounded query it has always been. ON: capped and
  paginated. `isFlagEnabled` is false-on-error, *"so an unreadable flag leaves the
  feed unbounded rather than silently truncating it"* (`routes/highlights.ts:2694-2695`).
- **Production**: `false`.
- **Why off**: `2339_highlights_feed_bound.sql:9-19` — Highlights/Memories spec §12
  (*"Highlights should remain finite and contextual. Do not turn the surface into an
  endless feed."*) against a route with *"NO `.limit()` and no pagination"*. Seeded
  FALSE because *"Capping a feed that is uncapped today can only REMOVE highlights
  from somebody's screen, and how many is finite-enough is a product decision §12
  does not make"* (`routes/highlights.ts:2690-2693`).
- **To turn on**: `DECISION` — *what page size should the following-feed be capped
  at, given that capping it removes highlights from someone's screen?*
  **RECOMMENDED default: turn it ON for hosted testing** and accept the code's
  existing `FOLLOWING_FEED_DEFAULT_LIMIT` / `FOLLOWING_FEED_MAX_LIMIT`
  (`routes/highlights.ts:2697-2699`) — hosted testing is exactly where you want to
  exercise the paginated path, and the unbounded query is a latent
  denial-of-service against any account following many users. I deliberately do
  **not** state a number: the constants are in the code and I did not read their
  values, so quoting one would be a guess.
- **Production has the migration**: 2339 **is** in
  `production-applied-migrations.json:195`, so the row exists and this is a flag
  flip once the question is answered. `MIGRATION` not needed.

#### `passport_memories_enabled` — capability
- **Gates**: READs and WRITEs across the Passport memory routes, through a **local**
  helper (`routes/passportStamps.ts:56` — `async function isFlagEnabled(flag: string)`,
  deliberately fail-CLOSED *"to match the shared lib/featureFlags isFlagEnabled"*,
  `:65`). Seven gate sites: `:239` (`GET /me/passport/memories` — "Passport memories
  are not enabled"), `:280`, `:328`, `:373`, `:413`, `:446`, `:660`.
- **Production**: `true`.
- **To turn on**: already on.
- **Note**: the single-argument calls are **not** a bug — the local wrapper at
  `:56` takes only the flag name and resolves its own client. I checked this
  because the shared helper's signature is `(sc, flag)`.

---

### 5. Kill switches and cross-domain interactions

#### `disable_media_uploads` — **another agent's flag; recorded here for the interaction**
Not mine, but it is the single most consequential switch over my domain, so the
interaction must be on the record:

- **Polarity**: kill switch. Read through `isKillSwitchEngaged`
  (`lib/featureFlags.ts:57-68`), so an **error engages the stop** and an absent row
  does not.
- **Gate sites I found**: `lib/mediaPipeline.ts:112` inside `guardUploadRequest`
  — *"Gate that must pass before ANY upload is accepted or any signed upload URL is
  minted"* (`:102-106`) — whose callers are `routes/postcards.ts:412`,
  `routes/mediaVideoPoster.ts:57` and `routes/telegraphVoice.ts:145`; plus direct
  reads at `routes/events.ts:5930`, `routes/messaging.ts:3253`,
  `routes/postcardMediaTransport.ts:116`, and `routes/profile.ts:1171` and `:1244`.
  `POST /media/upload` consumes the same verdict, decided before the body is read
  (`routes/posts.ts:102-103`, `admitUploadBeforeBody`).
- **Interaction**: while this stop is engaged, **nothing in my domain that writes
  media can work** — no gem photo, no story media, no postcard media, no video
  poster — regardless of `MEDIA_UPLOAD_ENABLED`, `MEDIA_TAB_ENABLED` or
  `stories_enabled`. It also fails *shut* if the service client is absent:
  `killSwitchStateUnknown` (`lib/featureFlags.ts:136-147`) exists because callers
  used to skip the switch entirely when `SUPABASE_SERVICE_ROLE_KEY` was missing and
  let the write through with a 2xx. **Whoever owns that flag must confirm it is not
  engaged and that the service-role key is present**, or every media test will fail
  for a reason that looks like my domain and is not.

#### Other cross-domain dependencies named by my flags
- `hidden_gems_enabled` — read at `services/media/MediaActionResolver.ts:1067`
  alongside the Media action resolution. Not a `MEDIA_*` flag; another agent's.
- `PORTAVA_PUBLISHER_BOOST_ENABLED`, `PORTAVA_FEATURED_BOOST_ENABLED` — loaded by
  `MediaFeedRankingService.loadMediaRankingFlags` with the five `MEDIA_*` boosts,
  both `row absent`, both seeded by 2300 (`2300:131-141`). They sit in the media
  ranking path but are not `MEDIA_*`-named; flagging the overlap.
- Compass — `media_find_busier_enabled` and the §32 media context require the
  Compass gate to be on.
- Intel / Sensing — `media_evidence_enabled` is the media half of a seam whose other
  half is `lib/intelProjectionAggregator`. `docs/ops/sensing-production-approval-request.md:142,177`
  treats `media_canonical_enabled` as one of its own approval items (H1), so a
  decision on §3 touches that lane too.
- Wall — `WallCandidateLoaders.loadQuickMediaItems` is the §18 Quick Media row and
  is one of the three reads that `media_canonical_enabled` lights up.

---

### 6. Summary of labels

| Label | Flags |
| --- | --- |
| **FLAG FLIP ONLY** | `MEDIA_TAB_ENABLED` ⟵ *the one flip for a working Media tab*; `MEDIA_FOLLOWING_ENABLED`; `MEDIA_RANKING_ENABLED`; `MEDIA_COMMENTS_ENABLED`; `MEDIA_SHARES_ENABLED`; `MEDIA_ANALYTICS_ENABLED`; `media_canonical_enabled` (mechanically — but see DECISION) |
| **MIGRATION** | `MEDIA_WORLD_SHELL_ENABLED` (2300); `MEDIA_HIDDEN_GEMS_NEARBY_ENABLED` (2300); `media_evidence_enabled` (2255); `media_request_a_view_enabled` (2257 — **also creates two tables absent from production**); `media_find_busier_enabled` (3351); `media_neighborhood_only_mode_enabled` (3350 — **also adds an enum value**); `media_perspective_vantage_enabled` (3352 — **also adds a column**); `media_processing_worker_enabled` (3338) |
| **CONFIG** | `media_vision_provider_enabled` (`MEDIA_VISION_PROVIDER`); `media_transcoder_enabled` (`MEDIA_TRANSCODER`); `media_captions_enabled` (`MEDIA_CAPTION_SOURCE`); `media_moderation_classifier_enabled` (**provider variable not established from the code I read**) — each also needs its migration (3355/3356/3357/3358) |
| **CODE** | `MEDIA_DEFAULT_VIEW_MODE` (metadata never reaches the client); `media_canonical_read_enabled` (loader has no caller); the nine inert `MEDIA_*` flags (no gate exists) — **none of these is needed for a working Media tab** |
| **DECISION** | `media_canonical_enabled` (turn the writer back on? → **yes**); `MEDIA_UPLOAD_VIDEO_ENABLED` (**open question — report only, no change proposed**); `MEDIA_TAB_WORLD_DEFAULT_ENABLED` (F1 → **off**); `MEDIA_WATCH_CONTEXT_OVERLAY_ENABLED` / `MEDIA_WATCH_TAP_TO_PLAY_ENABLED` / `MEDIA_WATCH_STAGE24_RANKING_ENABLED` (F2 → **off**); the five ranking boosts (→ **off**, per MD2); `media_pending_upload_sweep_enabled` (destructive → **off**); `media_canonical_schema_fallback_enabled` (→ **never enable**); `MEDIA_LIKES_ENABLED` / `MEDIA_SAVES_ENABLED` (wire or retire → **neither**); `highlights_feed_bounded_enabled` (page size → **on**, using the existing constants) |
| **Already on** | `MEDIA_VIEW_MODE_FULLSCREEN_ENABLED`, `MEDIA_VIEW_MODE_GRID_ENABLED`, `MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED`, `MEDIA_FOR_YOU_ENABLED`, `MEDIA_UPLOAD_ENABLED`, `MEDIA_UPLOAD_PHOTO_ENABLED`, `MEDIA_HIDDEN_GEMS_CREATE_ENABLED`, `MEDIA_GEMS_SUBMIT_ENABLED` (inert), `media_private_buckets_enabled` (gate retired), `stories_enabled`, `passport_memories_enabled` |
| **Not a flag — dropped** | `MEDIA_SHARING_ENABLED` (a misspelling; `2300:78`) |

### 7. What I could not establish
- The **reason** `media_canonical_enabled` was flipped true then false on
  2026-09-25 15:39 UTC. census-media:4615 and `blocker-ledger.md:121` both say
  *"the tree records no reason"*, and I found none either. This is why §3 is a
  DECISION and not a flip.
- The **env var for the moderation classifier** (`media_moderation_classifier_enabled`).
  The sibling three name theirs in their migration headers; 3356 does not, and I did
  not read `lib/media/vendors/mediaModerationClassifier` itself.
- Whether `MEDIA_GEMS_SUBMIT_ENABLED` being flipped true by 2077 was intentional
  given it has no reader. 2077's header treats it as a real gate
  (*"gem submission gate (was false)"*, `2077:6`); the code disagrees.
- **Negative proof of absence for any row.** `production-applied-migrations.json`
  is self-described as a tripwire, not an inventory, and hand-applies through the
  Supabase dashboard write no row. Where I say a migration is unapplied, the
  2026-10-03 flag capture showing no row is the stronger evidence; the ledger is
  corroboration.
## 02 — Telegraph (messaging), Memory Kernel, Trip Kernel

Domain: every `telegraph_*` flag, every `memory_*` flag, `trip_kernel_enabled`,
`experience_session_enabled`, `trip_operational_projections_enabled`,
`trip_map_projection_worker_enabled`, `map_trip_projection_read_enabled`,
`discovery_trip_projection_enabled`, `highlights_feed_bounded_enabled`, and the
two messaging kill switches *only* where they interact with the above.

All paths are relative to `/home/user/portava.app` unless absolute.
`api/` below abbreviates `artifacts/api-server/src/`.

### Evidence base

Three independent sources were used, and where they disagree it is called out:

1. **Production flag capture** (`scratchpad/flags/prod-sorted.txt`, 201 rows).
2. **`api/lib/capability/production-applied-migrations.json`** — the repo's
   record of migrations *we* applied to production (129 entries). Its own
   `$comment` states it is "a staleness tripwire, not an inventory".
3. **`api/lib/capability/snapshots/20260922-production-schema.json`** —
   a capture of production's own catalogue (watermark `20260922155706`), with
   `tables`, `functions` and a `flags` subset. This is the stronger source
   because it reads production rather than the ledger, and it is what I used to
   confirm every "schema absent / schema present" claim below.

### Flag-state summary

| flag | polarity | production | schema applied? |
|---|---|---|---|
| `telegraph_message_kernel_enabled` | capability | **row absent** | NO (2810/2811 unapplied, snapshot-confirmed) |
| `telegraph_history_bound_enabled` | capability | `false` | YES (2400 + 2966) |
| `telegraph_live_references_enabled` | capability | **row absent** | n/a — 2802 seeds the flag only; unapplied |
| `telegraph_report_evidence_enabled` | capability | **row absent** | NO (2812 unapplied) |
| `telegraph_request_origin_enabled` | capability | **row absent** | NO (2813 unapplied) |
| `telegraph_discovery_actions_enabled` | capability | **row absent** | n/a — 3467 seeds the flag only; unapplied |
| `telegraph_suggestions_enabled` | retired | **row absent** | n/a — no reader exists |
| `memory_kernel_enabled` | capability | `false` | PARTLY — Memory half yes (2710/2711), Highlight half NO (2993/3001) |
| `memory_projection` | capability | `false` | YES (2183–2200 family, 2963/2965) — except 3314 |
| `memory_public_feed_projection_enabled` | capability | `false` | YES (`memory_public_feed()` present) |
| `memory_location_precision_enabled` | capability | `false` | YES (2338; `memories.location_precision` present) |
| `highlights_feed_bounded_enabled` | capability | `false` | YES (2339) |
| `trip_kernel_enabled` | capability | `false` | YES (2420/2450/2500/2590 + families) |
| `trip_operational_projections_enabled` | capability | `false` | YES — whole 2760–2794 closure verified present |
| `trip_map_projection_worker_enabled` | capability | `false` | YES (2520; `trip_map_projection_drain` present) |
| `map_trip_projection_read_enabled` | capability | `false` | YES (2520 + 2610) |
| `discovery_trip_projection_enabled` | capability | `false` | YES (`trips.version` present) |
| `experience_session_enabled` | capability | **row absent** | n/a — 2841 seeds the flag only; unapplied |

Every one of these is read through `isFlagEnabled`
(`api/lib/featureFlags.ts:14-25`), which is fail-closed: absent row, error or
throw all mean **off**. So a `row absent` flag behaves exactly like `false` at
every gate below — the difference is operational, not behavioural: an absent row
**cannot be flipped from the admin UI**, and the audited toggle path
(`toggle_feature_flag_with_audit`) has no row to update. That is why each
`row absent` entry is a `MIGRATION`, never a `FLAG FLIP ONLY`.

---

## 1. `telegraph_message_kernel_enabled` — the headline

### 1.1 Production state, established three ways

- **No row at all** in the 201-row capture.
- 2810 is the only file that seeds it:
  `api/migrations/2810_telegraph_message_kernel.sql:418-422`
  (`INSERT ... ('telegraph_message_kernel_enabled', false, ...) ON CONFLICT DO NOTHING`),
  with postconditions at `:456-461` that refuse to commit unless the row exists
  **and reads FALSE**.
- 2810 is **not** in `production-applied-migrations.json`, and the schema
  snapshot proves it independently: production's `messages` columns are
  `id, thread_id, sender_id, body, sender_original_language, translated_body_json,
  created_at, edited_at, deleted_at, original_language, language_detection_source,
  msg_type, subtype, reply_to_id, media_url, media_type, media_thumbnail_url,
  media_duration_seconds, ciphertext` — **no `sequence`, no `unsent_at`, no
  `lifecycle_state`, no `client_message_id`, no `idempotency_key`, no
  `content_ref`**. `telegraph_outbox`, `message_reactions`, `message_edits`,
  `message_attachments` and `conversation_action_refs` are all **absent** from
  production's table list.

So the state is self-consistent: no row, no schema, nothing allocated.

### 1.2 What the flag actually gates

**Gate A — the §13.1 command endpoint (WRITE).**
`api/server/telegraph/commandRoute.ts:155`:

```
if (SCHEMA_GATED_COMMANDS.has(type) && !(await messageKernelEnabled(sc))) {
  sendError(res, "feature_disabled", "Telegraph message commands are not enabled on this deployment.");
```

The gate is **per command**, not per endpoint (`:147-154` says so explicitly).
`SCHEMA_GATED_COMMANDS` is exactly three names
(`api/domain/telegraph/commands/telegraphCommands.ts:108-112`):

- `UNSEND_MESSAGE` — needs `messages.unsent_at` / `messages.lifecycle_state` (2810)
- `ADD_REACTION` — needs `public.message_reactions` (2811)
- `REMOVE_REACTION` — same table

`ISSUABLE_COMMANDS` (`telegraphCommands.ts:76-100`) holds a **fourth** command,
`CREATE_COORDINATION_SESSION`, which is **deliberately not in the gated set**
and is documented at `:85-96` as the one command needing no unapplied schema —
it writes a `messages` row through columns every deployment already has.

**Gate B — §21 search exclusion (READ).**
`api/services/telegraphSearch.ts:222` reads the flag and
`applyLifecycleExclusion` (`api/services/telegraphMessageKernel.ts:95-98`) adds
`.is("unsent_at", null)` to the search query only when it is on. Off, the query
never names the column — `kernelColumns` returns the caller's original column
list unchanged (`telegraphMessageKernel.ts:68-70`), which is the whole reason
this module exists (header, `:1-20`): PostgREST answers an unknown column with
42703 and fails the *whole* statement.

**Gate C — in-database triggers (WRITE).** 2810's two triggers read the flag in
plpgsql and return early when it is false:
`2810_...sql:257` (`telegraph_assign_message_sequence`) and `:310`
(`telegraph_outbox_from_message`). Comments at `:289` and `:361` state the
no-op explicitly.

### 1.3 EXACTLY what does not work in production today

**DOES NOT WORK (messaging features dark because the row is absent):**

1. **`UNSEND_MESSAGE` via `POST /api/telegraph/commands`** — answers
   `feature_disabled` ("Telegraph message commands are not enabled on this
   deployment"). `commandRoute.ts:155`.
2. **`ADD_REACTION` / `REMOVE_REACTION` via the same endpoint** — same refusal.
   There is **no other reaction surface anywhere**: `message_reactions` has no
   route, no UI and no table. `api/scripts/checkProductionDrift.ts:596-604`
   records that its *consumer* predates it — a `telegraph.reaction`
   notification template ("reacted to your message") exists with nothing to fire
   it. So **message reactions are entirely non-functional in production**, and
   this is the single largest messaging gap in my domain.
3. **Message sequencing / resumable streams (§17.1, §17.2)** — `messages.sequence`
   does not exist, so "reconnect resumes from last acknowledged sequence" is
   unavailable; every reader orders and paginates by `created_at`
   (`2810_...sql:43-48`). `parseSequenceCursor` exists but no cursor can ever be
   non-null (`sequenceOf` returns null when the flag is off,
   `telegraphMessageKernel.ts:100-106`).
4. **The transactional event outbox (§13.3)** — `telegraph_outbox` does not exist
   in production, so no durable `message.sent` / `message.unsent` /
   `message.deleted` event is written. `routes/telegraphLifecycle.ts:296-300`
   states this in place: *"2810 is applied to no database, so on every deployment
   that exists there is no trigger to fire"*. Realtime nudges still publish
   (`publishToThread`), so the user-visible effect is "no durable event log", not
   "no live update".
5. **Versioned edits, multi-attachment messages, revocable shared cards** —
   `message_edits`, `message_attachments`, `conversation_action_refs` (2811) are
   all absent. The edit route still overwrites `messages.body` in place and
   `messages.media_url` is still the live single-attachment path
   (`checkProductionDrift.ts:588-625`).

**ALREADY WORKS (not blocked by this flag):**

6. **`CREATE_COORDINATION_SESSION` via `POST /api/telegraph/commands`** — issuable
   today, ungated, writes a `messages` row. Handled before the switch at
   `commandRoute.ts:191-205`. Its failure vocabulary includes a 400 for a
   missing idempotency key, which is why it is handled separately.
7. **All sixteen other §13.1 commands** — they have real homes and are untouched
   by this flag: `SEND_MESSAGE` (`POST /api/threads/:id/messages`),
   `EDIT_MESSAGE`, `DELETE_MESSAGE`, `ACCEPT_REQUEST`, `DECLINE_REQUEST`,
   `CREATE_DECISION`, `CAST_VOTE`, `SET_COORDINATION_STATUS`, `SHARE_LOCATION`,
   `STOP_LOCATION_SHARE`, `SET_AVAILABILITY`, `STOP_AVAILABILITY`, `BLOCK_USER`,
   `MUTE_THREAD`, `REPORT_MESSAGE` — see `LEGACY_PATH_COMMANDS`
   (`telegraphCommands.ts:126-166`). Sending any of them to the command endpoint
   gets a **409 `wrong_endpoint`** naming the real route
   (`commandRoute.ts:124-133`) — that is by design, not a defect.
8. `UNIMPLEMENTED_COMMANDS` is **empty** today and is derived, not hand-written
   (`telegraphCommands.ts:168-226`), so the 501 branch at
   `commandRoute.ts:134-140` is currently unreachable.

### 1.4 Unsend — settled ruling #472, and a live production defect

`/mnt/project-files/product-decisions-2026-09-22.md:116-131` (ruling **#472**)
settles which unsend implementation is authoritative: **the transactional
under-lock RPC**, with the duplicate route registration removed and the
published response contract preserved through an adapter. Line `:52-53` of that
doc records *"#472 is still to be implemented"* as of its writing.

The tree now implements the ruling. `api/services/telegraph/unsend.ts:345-381`
is the single path, and it does exactly one thing:
`sc.rpc("telegraph_unsend_message_before_seen", {...})`. The compensation scheme
is deleted (`unsend.ts:46-66`). Both doors call it:
`routes/telegraphLifecycle.ts:249` (the HTTP route) and the command route.

**The ruling is honoured in code and broken in production, and this is a
finding, not a plan.** The RPC lives in migration 2325 (amended by 3000), and
**neither is applied to production**: the schema snapshot's 164-function list
contains **no function matching `unsend`** at all. So today:

- `POST /api/threads/:threadId/messages/:messageId/unsend` — the route is
  reachable (it is not flag-gated at all), membership is checked, then the RPC
  fails, `unsendBeforeSeen` returns `null` (`unsend.ts:362-371`), and the route
  answers **`db_error` "Could not unsend that message"**
  (`telegraphLifecycle.ts:253-261`). Every unsend attempt in production fails
  this way. It is fail-closed and nothing is written, but the person is given a
  generic database error rather than a readable refusal.
- `UNSEND_MESSAGE` through the command route never reaches the RPC — the kernel
  flag refuses it first with a clean `feature_disabled`.

Migrations 2325 / 2810 / 3000 are **owned by the production rollout thread**;
this section reports their state and does not plan their apply.

### 1.5 Labels for `telegraph_message_kernel_enabled`

**`MIGRATION`** — and it is a chain, not one file, with an owner decision inside it.

- `api/migrations/2810_telegraph_message_kernel.sql` seeds the row and adds the
  `messages` columns. **Not applied to production.**
- `api/migrations/2811_telegraph_message_side_tables.sql` adds
  `message_reactions` (and `message_edits`, `message_attachments`,
  `conversation_action_refs`). **Not applied.** 2811 shares 2810's flag
  deliberately — `checkProductionDrift.ts:570-575`: *"two switches for one
  capability is how a half-on state gets created by accident."* So reactions
  cannot be turned on without 2810 also being on.
- `api/migrations/2325_telegraph_unsend_before_seen.sql` and
  `api/migrations/3000_telegraph_unsend_authoritative.sql` create and complete
  the unsend RPC. **Neither applied.** 3000's header (`:26-40`) explains that
  2325 called as-is would leave a row carrying `unsent_at` **and**
  `lifecycle_state = 'sent'`, so **3000 must be applied with or after 2325 —
  never 2325 alone.**
- Order matters in the other direction too: 3000 sets `lifecycle_state`, a column
  **2810** adds, so the only safe order is **2810 → 2811 → 2325 → 3000**.

**`DECISION`** — *Do we accept an unbounded `telegraph_outbox` for the duration of
hosted testing?* 2810's own header (`:65-69`) and
`checkProductionDrift.ts:555-568` both state that **nothing drains it**: turning
the flag on makes the trigger write one row per message lifecycle transition,
`published_at` stays NULL forever, and the table only grows.
`telegraphMessageKernel.ts:29-34` confirms no drainer is shipped on purpose.
**Recommended default: accept it for hosted testing.** Reason: the growth is
proportional to test traffic (a handful of testers, not 43 production trips'
worth of users), it is a table nobody reads so it cannot produce a wrong answer,
and the alternative — leaving unsend and reactions dark — is the thing hosted
testing is meant to exercise. Pair it with a note to truncate
`telegraph_outbox` before any real launch.

**`DECISION`** — *Do we run the sequence backfill?*
`public.telegraph_backfill_message_sequences(uuid)` is one conversation per call
and is **called by no migration and no application code**
(`2810_...sql:410-411`). Until it is run, `sequence IS NULL` means "predates the
kernel". **Recommended default: do not run it.** Reason: no shipped reader
consults `sequence` for ordering (every reader still uses `created_at`), so the
backfill buys nothing for hosted testing, and it is an unbounded UPDATE on the
hottest table in the product.

**Depends on**: nothing upstream. It is a root capability. Note that it does
**not** depend on, and is not gated by, `disable_messaging` — see §6.

---

## 2. Other `telegraph_*` flags

### 2.1 `telegraph_history_bound_enabled` — capability, `false`, schema APPLIED

**Gates (READ).** The §14.3 rule "new members do not automatically receive
pre-membership history." `api/services/groupChatHistoryBound.ts` is the only
place a reader decides whether to honour it
(`:64` `HISTORY_BOUND_FLAG`, `:74-76` `historyBoundEnabled`). Off:
`membershipSelect` returns the caller's original column list, `visibleFromOf`
returns null, `withinWindow` is always true (`:18-28`). Seventeen read paths
call `applyHistoryWindow`; the affected surfaces are named at `:12-16`:
`GET /threads/:id/messages`, `GET /me/threads`, `GET /me/unread-counts`,
`GET /me/saved-messages`, plus §21 search. `routes/messaging.ts:2270` notes the
same.

**Production value.** `false` — **but the schema is applied**, which makes this
the only telegraph flag in my domain that is a pure flip.
`2400_telegraph_history_bound` and `2966_telegraph_history_bound_close` are both
in `production-applied-migrations.json` at version `20260922054229`, and the
snapshot confirms `message_thread_members.visible_from_at` exists. The ledger's
`$comment` records this as a **backfill entry** — they were applied at 05:42:29
UTC by someone else and only recorded later — and adds **"2966 MUST NEVER BE
REVERTED."**

**Why off.** Seeded FALSE by 2400. The stated reason is the direction of harm:
`groupChatHistoryBound.ts:30-34` — an unreadable flag must leave history "exactly
as unbounded as it is today, rather than silently hiding messages from every
member."

**To turn on: `DECISION`.** *Should hosted testers see pre-membership group
history?* Turning this on can only **remove** messages from somebody's screen,
and `visible_from_at` is **NULL for every row that predates 2400** (2400
backfills nothing), and NULL means **unbounded even when the flag is on**
(`groupChatHistoryBound.ts:36-39`). **Recommended default: turn it ON.** Reason:
it is the spec-conformant and more private behaviour (§26 "New member reads
pre-membership history without policy → DENY"), the schema is already there, the
one approved carve-out (Q6, own-message rejoin) is implemented, and because old
rows are NULL the practical effect is limited to memberships created after 2400
landed — i.e. exactly the test traffic hosted testing will generate.

**Depends on**: nothing.

### 2.2 `telegraph_live_references_enabled` — capability, **row absent**

**Gates (READ + WRITE, two routes).** `api/routes/telegraphLiveReferences.ts:110`
gates `POST /api/telegraph/threads/:threadId/live-references` (writes a `card`
message of subtype `live_reference`) and `:198` gates
`GET /api/telegraph/live-references/:messageId` (resolves a shared reference
against current state with `changedSinceShare`). Both answer the flag's refusal
before anything is read or written. The router is mounted behind the flag's own
file per `routes/index.ts:377`.

**Production value.** Row absent. Seeded FALSE by
`api/migrations/2802_telegraph_live_references_flag.sql`, **not applied**.

**Why off.** `routes/telegraphLiveReferences.ts:24-26`: gated by the flag,
"migration 2802, seeded FALSE, read fail-closed".

**To turn on: `MIGRATION`** — apply `2802_telegraph_live_references_flag.sql`
(flag seed only, no DDL), then flip. **Depends on**: the Sensing live-claim read
path (`lib/liveClaimRead.ts` / `liveLabelsServable`), which is another agent's
domain (`disable_intel_live_labels` is `0`, i.e. not engaged). If live claims are
unservable the route produces named refusals rather than cards.

### 2.3 `telegraph_report_evidence_enabled` — capability, **row absent**

**Gates (WRITE, best-effort).** `api/services/telegraphReportEvidence.ts:77-78`,
checked at `:94` (`captureMessageEvidence`) and `:160`
(`captureThreadEvidence`), both called from `routes/messaging.ts:37` on
`POST /api/messages/:id/report` and `POST /api/threads/:id/report`. Off, both
return `NOT_ATTEMPTED` and the table is never named — the reason given at
`:44-49` is that PostgREST answers a missing relation with 42P01, so a database
without 2812 would log an error on every report.

**Critically: this never gates the report itself.** `:38-43` — the report is
already written and already answered 201 before capture runs. So **reporting
works in production today; the evidence snapshot does not.**

**Production value.** Row absent. Seeded by
`api/migrations/2812_telegraph_report_evidence.sql`, **not applied**;
`telegraph_report_evidence` is absent from production's table list.

**Why off / what it costs.** `checkProductionDrift.ts:628-648` calls this
*"the one table in this lane whose ABSENCE is a live harm rather than a missing
feature"*: a reported message deleted by its sender is **destroyed**, because
deletion blanks `messages.body` in place and nothing copied it first
(census T283/T284).

**To turn on: `MIGRATION`** — apply 2812, then flip. The migration ships RLS
ENABLED with FORCE and **no policy at all** (service-role read only), with a
postcondition that raises if any policy is ever added.
**`DECISION` rider:** `retention_until` is NULL and **nothing purges**
(`checkProductionDrift.ts:644-647`): a deletion schedule for moderation evidence
is an owner decision, and the migration deliberately invented no number.
**Recommended default: apply 2812 and turn the flag ON for hosted testing, and
leave `retention_until` NULL.** Reason: it closes a live data-destruction harm;
a retention number nobody chose would be worse than none, and hosted-testing
volume makes unpurged evidence a non-issue.

**Depends on**: nothing.

### 2.4 `telegraph_request_origin_enabled` — capability, **row absent**

**Gates (READ + WRITE on the message-request path).**
`api/domain/telegraph/policies/requestOrigin.ts:51`, `:78-80`
(`requestOriginEnabled`), consumed at `routes/messaging.ts:768` and `:817`.
Off, the select list and the insert never name `origin_type` / `origin_id` /
`origin_verified`, so the message-request list and creation are byte-identical
to pre-2813 (`requestOrigin.ts:42-47`).

**What is lost.** §22's "requests carry contextual origin: Event, Trip, Nearby,
Bump, Buddy, profile." The recipient of a stranger's message request is told
nothing about why. `requestOrigin.ts:12-16` calls this *"a safety harm, not a
convenience one"*. Note only **one** of the six is server-verifiable (`trip`,
via `isAcceptedTripMember`); the other five are stored as **claims** with
`verified: false` (`:22-40`).

**Production value.** Row absent. Seeded by
`api/migrations/2813_telegraph_request_origin.sql`, **not applied**.

**To turn on: `MIGRATION`** — apply 2813, then flip. `FLAG FLIP ONLY` after that.
**Depends on**: nothing (the `trip` verification reads `trip_members`, which
production has).

### 2.5 `telegraph_discovery_actions_enabled` — capability, **row absent**

**Gates (WRITE, via a confirm-action flow).**
`api/routes/telegraphCommands.ts:607` gates
`POST /api/telegraph/commands/discovery-card` with
`feature_disabled "Saving places from a conversation is not enabled."`
The flag is re-read **three times**: at the propose, inside
`authorizeDiscoverySave` at confirmation, and again at the post-write recheck —
so switching it off between tap and confirm refuses **and undoes a save this
action created** (`api/services/telegraph/actionRegistry.ts:334-358`).

**What is lost.** Tapping *Save* on a Discovery card shared into a conversation.
The execute path calls Discovery's own
`services/discovery/DiscoveryWishlistSave.ts` — the same function
`POST /api/wishlist` calls — so saving a place from Discovery itself still works;
only the in-conversation tap is dark.

**Production value.** Row absent. Seeded FALSE by
`api/migrations/3467_cross_architecture_flags.sql`, **not applied**.

**To turn on: `MIGRATION`** — apply 3467 (note: 3467 is a *cross-architecture*
flag file and likely seeds rows outside my domain; the production rollout thread
should confirm what else it carries before applying), then `FLAG FLIP ONLY`.
**Depends on**: Discovery's own gates (`disable_discovery_pde` is `0`, not
engaged) — another agent's domain.

### 2.6 `telegraph_suggestions_enabled` — RETIRED, **row absent**

Not a live gate. **No TypeScript or TSX file in the tree reads it** (verified by
repo-wide grep; the only hits are SQL). `api/migrations/0037_feature_flags.sql:29`
records that it was originally seeded TRUE, and
`api/migrations/2086_retire_unread_flags.sql:123, 170, 213` **deletes** it as one
of 33 retired rows, with a precondition that refuses if any
`feature_flag_audit_log` row references it and a postcondition that none may
survive. 2086 is not in the applied list, so either the 0037 seed never reached
production or the row was removed by hand; either way the absent row matches the
intended end state.

**To turn on: nothing to do.** `FLAG FLIP ONLY` is the wrong label — there is no
feature behind it. Report it as retired and move on.

---

## 3. `memory_kernel_enabled` — capability, `false`, schema PARTLY applied

### 3.1 What the memory kernel is

The command boundary for canonical Memory and Highlight writes, per
`docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt`
§17/§19/§23/§24. The TypeScript half is `api/lib/memoryCommandBus.ts`; the
database half is two SQL functions, one per aggregate:
`public.memory_kernel_execute` (migration 2711) and
`public.highlight_kernel_execute` (migration 2993). Either applies **one**
command and writes, in the **same transaction**, into the same four tables:

- `memory_domain_events` — immutable domain events (§17's fourteen names)
- `memory_event_outbox` — the transactional outbox
- `memory_command_receipts` — idempotency receipts (§19)
- `memory_command_audit` — one row per command **attempt** (§24)

`memoryCommandBus.ts:25-39` explains why it must be one SQL function:
supabase-js has no transactions, so "state + event + outbox + receipt + audit"
cannot be made atomic from Node.

### 3.2 Gates and what is lost with it off

**Gate (WRITE).** `api/lib/memoryCommandBus.ts:114` `MEMORY_KERNEL_FLAG`,
`:118-120` `isMemoryKernelEnabled`, `:125-131` `memoryKernelClient` — which
returns the service client when the flag is TRUE and **null** otherwise, and
"null means run the pre-kernel direct write exactly as before". Consumed at
`routes/memories.ts:2611` and `routes/highlights.ts:1425`.

**What the app loses with it off (`memoryCommandBus.ts:48-56`,
`routes/highlights.ts:1425-1431`):**

- **No domain events.** None of §17's fourteen event names is emitted by any
  Memory or Highlight write path.
- **No outbox rows**, therefore **no downstream projection rebuilds**, **no §21
  revocation propagation** and **no search de-index** driven by a write.
- **No idempotency receipts.** A retried Memory write has no server-side
  idempotency (§19).
- **No per-attempt audit row** (§24's `memoryId / commandId / eventId / reason
  code / projection name / failure class`). The flag-off path *does* still write
  the §24 audit **log line** with `durable:false` — the log says which
  (`highlights.ts:1429-1431`).
- **Event replay / divergence detection is inert.**
  `services/memoryProjections/highlightEventReplay.ts` exists and makes the
  divergence executable, but with no events there is nothing to replay. The
  concrete bug it was written for: `DELETE /highlights/:id/archive` did a bare
  `.update({ archived_at: null })` emitting nothing, leaving the log's last word
  `highlight.hidden` while the row was visible, so a §18 rebuild withheld a
  Highlight its owner had restored (`memoryCommandBus.ts:87-101`).

**What still works.** Every Memory and Highlight write itself. The flag-off path
is **byte-identical on the wire** to the pre-kernel direct write, moved verbatim,
including its PGRST204 `feature_disabled` answer and its one-answer 404
(`highlights.ts:1425-1431`; `memoryCommandBus.ts:49-52`). And the §5 lifecycle
guard `assertLifecycleTransition` is **not** gated — it runs on every PATCH
regardless (`memoryCommandBus.ts:53-56`).

So: **nothing user-facing is dark because of this flag.** What is missing is the
audit, event and idempotency substrate.

### 3.3 Is its schema applied? Half of it — and this is the trap

- **Memory half: YES.** `2710_memory_command_kernel_tables` and
  `2711_memory_kernel_execute` are both in
  `production-applied-migrations.json`, and the snapshot confirms all four
  tables (`memory_domain_events`, `memory_event_outbox`,
  `memory_command_receipts`, `memory_command_audit`) **and** the function
  `memory_kernel_execute` are present in production.
  `checkProductionDrift.ts:514-529` records the 2711 apply in detail, including
  that `sha256(stored_text || "\n")` matched the file, and that two of its
  postconditions were specifically *"a client role cannot EXECUTE it, and
  `memory_kernel_enabled` is still FALSE"*. Its summary: *"the four kernel
  tables now have a writer in production that nothing calls."*
- **Highlight half: NO.** `highlight_kernel_execute` is **absent** from
  production's 164-function list. Migrations `2993_highlight_command_boundary`
  and `3001_highlight_kernel_admits_unhide` are **not applied**.

**This is the finding that matters.** `memoryCommandBus.ts:623` picks the
function from the command's subject (`const fn = highlight ? HIGHLIGHT_KERNEL_FN
: MEMORY_KERNEL_FN`), and `:648-664` turns any RPC error into
`MEMORY_KERNEL_UNAVAILABLE`, which `sendMemoryCommandRejection` renders as a
**503**. It **never falls back to a direct write**, on purpose
(`memoryCommandBus.ts:41-47`): answering 201 from the unaudited path would be
reporting success for a command the system did not record.

**Therefore: flipping `memory_kernel_enabled` to TRUE in production today would
take every Highlight canonical write — pin, unpin, hide, archive-undo — to a
hard 503, while Memory writes correctly became kernel-backed.** One flag, two
aggregates, one of which has no function behind it.

### 3.4 Labels for `memory_kernel_enabled`

**`MIGRATION`** — apply `api/migrations/2993_highlight_command_boundary.sql`
**and** `api/migrations/3001_highlight_kernel_admits_unhide.sql` before the flip.
Neither is in `production-applied-migrations.json`. 3001 `CREATE OR REPLACE`s
2993's function to admit `UNHIDE_HIGHLIGHT`
(`scripts/checkMemoryTableOwnership.ts:164`), so the order is **2993 → 3001**,
and 2993 alone would refuse `UNHIDE_HIGHLIGHT` as
`MEMORY_COMMAND_UNKNOWN_TYPE` — audited, not silent, but still a refused
archive-undo (`memoryCommandBus.ts:87-101`).

**`DECISION`** — *Do we accept an undrained `memory_event_outbox`?*
`checkProductionDrift.ts:511-518`: *"memory_event_outbox STILL HAS NO
CONSUMER … nothing writes to it while the kernel flag is FALSE, and no worker
drains it."* A drainer **is** now wired —
`api/services/memoryProjections/outboxDrainRunner.ts`, started from
`api/index.ts:192`, not flag-gated because the **producer** is
(`outboxDrainRunner.ts:45`, `:172` logs "drains zero rows until
memory_kernel_enabled is on") — and `HIGHLIGHT_EVENT_PROJECTIONS` maps the five
`highlight.*` names to §18's profile row (`memoryCommandBus.ts:103-107`). So the
outbox would be drained, unlike Telegraph's. **Recommended default: turn it ON
for hosted testing, after 2993 + 3001.** Reason: the drainer exists, the audit
and idempotency substrate is exactly what hosted testing should exercise, and the
flag-off path's missing audit rows are a silent gap that testing would otherwise
not reveal.

**Not in scope of the flip, stated so it is not assumed**
(`memoryCommandBus.ts:71-86`): `MERGE_MEMORY` and `SPLIT_MEMORY` are **not
declared** (`memory_relations`, migration 2994, is unapplied everywhere and is
recorded `unapplied` at `checkProductionDrift.ts:228-243`);
`PUBLISH_HIGHLIGHT` is **not declared** (`highlights` has no `published_at` and
`lifecycle_state`'s value space has no `PUBLISHED`); `SET_RESURFACING_POLICY` is
**not declared**. Turning the flag on does not make any of these appear.

**Depends on**: nothing upstream. It is independent of `memory_projection`.

---

## 4. `trip_kernel_enabled` — capability, `false`, schema APPLIED

### 4.1 What it is

The command boundary for canonical Trip writes, per
`docs/specs/Portava_Trips_Development_Architecture_Spec_v4.txt` §4.1/§4.3/§6.1/
§18.3/§18.4/§22.4. TypeScript half: `api/domain/trips/commands/tripKernel.ts`.
Database half: `public.trip_kernel_execute` — contract v1 from 2420 (plan
family), v2 from 2450 (adds trip, participant, admin and system families), with
2500 and 2590 additive on top. It applies one command and writes the domain
event, the outbox row, the idempotency receipt and the `trips.version` bump in
one transaction (`tripKernel.ts:15-23`).

### 4.2 Gates and what is lost with it off

**Gate (WRITE).** `tripKernel.ts:88` `TRIP_KERNEL_FLAG`, `:92-94`
`isTripKernelEnabled`, then a service-client-or-null gate of the same shape as
Memory's (`:99-101`). `tripKernel.ts:34-40`: *"Every route that can reach
`executeTripCommand` first awaits `isTripKernelEnabled()` … so the pre-kernel
direct write is what runs unless an operator flips the row."*
`src/test/tripKernel.test.ts` proves the flag-off path never calls the function
and never touches `trips.version`.

**What is lost with it off** — and unlike Memory, several of these are
**user-observable degradations that name themselves**:

- **No trip domain events, no outbox rows, no idempotency receipts, no aggregate
  version bump.** Optimistic concurrency (§18.3/§18.4) is inert.
- **Compass cannot propose trip changes.** `api/compass/CompassTools.ts:1469`
  returns, verbatim: *"Proposals go through the Trip Kernel, which is not enabled
  for this deployment (trip_kernel_enabled is false). Describe the change to the
  user instead."* This is a visible assistant capability loss.
- **Trip closeout cannot finish its steps.**
  `api/domain/trips/services/TripCloseoutService.ts:144-145, 171-172, 226-227`
  each push a `deferred` step naming the command it could not issue:
  `DISSOLVE_SUBGROUP`, `UPDATE_DECISION_TASK` / `UPDATE_RISK`, `RECORD_OUTCOME`.
  So closing a trip leaves active subgroups, pending tasks, open risks and
  done-plans-without-outcomes behind, and says so.
- **Proposal and derived-event projections report skipped.**
  `api/server/trips/readRoutes/tripProjections.ts:533` and `:629`,
  `api/domain/trips/projections/TripOpportunityProjection.ts:424`, and
  `api/domain/trips/events/tripDerivedEvents.ts:57` all set
  `skipped = "trip_kernel_enabled is false"` on the response.
- **The offline queue will not replay.**
  `api/domain/trips/services/TripOfflineQueue.ts:143` — a queued offline-safe
  operation is replayed "only while trip_kernel_enabled is on".
- **Media handoff.** `api/services/media/MediaActionResolver.ts:810` —
  `create_proposal` is the governed handoff and sits behind this flag.

**What still works.** All the ordinary trip writes, through their pre-kernel
direct paths, with route-level authorization unchanged — authorization is **not**
in the kernel (`tripKernel.ts:25-31`).

### 4.3 Is its schema applied? YES

`production-applied-migrations.json` lists `2420_trip_kernel_foundation`,
`2450_trip_kernel_trip_and_participant_families`,
`2500_trip_kernel_join_via_link_and_host`,
`2590_trip_kernel_add_plan_attachment_columns`, plus 2764/2765/2766/2768/2769/
2772/2775/2777/2779/2786/2795 — the whole 2026-09-16 "TRIPS CHAIN" (41 entries,
each a manual apply through `execute_sql` inside BEGIN/COMMIT with its own
pre/postconditions). The snapshot confirms independently: `trips.version`,
`trip_events`, `trip_outbox`, `trip_command_receipts` are all present, and
`trip_kernel_execute` is in the function list.

So production is at **contract v2 + 2500 + 2590**, matching
`TRIP_KERNEL_CONTRACT_VERSION = 2` (`tripKernel.ts:90`). A v2 command sent to a
v1 function would be refused as `TRIP_COMMAND_UNKNOWN_TYPE` (`:50-54`) — not a
risk here.

### 4.4 Labels for `trip_kernel_enabled`

**`FLAG FLIP ONLY`** — the schema closure is applied and the function is at the
contract version the code speaks. Nothing else is needed after deploy.

**`DECISION` rider** — *Do we accept that nothing consumes `trip_outbox`?*
`tripKernel.ts:80`: *"No outbox consumer and no projection worker (§4.4,
§19.4)"*, and `:81` *"The metric is an in-process counter with no exporter;
nothing scrapes it."* That is **not quite the whole truth and the gap is in our
favour**: `trip_map_projection_drain` **is** a consumer and **is** in production
(see §5.3). But it only consumes the map projection's slice.
**Recommended default: flip it ON.** Reason: it is the highest-value flip in my
domain — it restores Compass trip proposals, trip closeout, offline replay and
the proposal/derived-event projections, all of which currently announce
themselves as disabled to the user; the schema is fully applied; and
`trip_outbox` growth is bounded by test traffic.

**Depends on**: nothing upstream. `trip_operational_projections_enabled`,
`trip_map_projection_worker_enabled` and `map_trip_projection_read_enabled` all
depend on **it** (or on its schema), not the reverse.

---

## 5. Trip projection and experience flags

### 5.1 `trip_operational_projections_enabled` — capability, `false`, schema APPLIED

**Gates (READ, through a flag + schema-probe capability).**
`api/domain/trips/policies/tripOperationalProjections.ts:29` declares the flag,
`:94-112` is `tripOperationalProjectionsGate` — the capability contract
`FLAG_ENABLED && SCHEMA_CAPABILITY_READY`, with a 30-second cache. It is
registered at `api/lib/capability/registry.ts:216`.

Consumers (verified by grep): `server/trips/readRoutes/tripProjections.ts:141`
and `:684`, `server/trips/readRoutes/tripMapProjection.ts:233` and `:420`,
`compass/CompassTools.ts:1371`, `domain/trips/services/TripCloseoutService.ts:68`,
`TripImpactState.ts:18`, `TripCrewLocationService.ts:428`,
`TripDecisionLedger.ts:134` and `:155`,
`domain/trips/projections/TripOpportunityProjection.ts` (via `refusalForGate`).

**What is lost with it off.** §7.3 freedom windows, §17.1 trip health, §11.1
"today", the §21.2 decision ledger's durable rows, subgroup-scoped live shares,
and the closeout's `trip_outcomes` / `trip_subgroups` / `trip_decision_tasks` /
`trip_decisions` steps. Concretely, `GET /trips/:tripId/timeline` renders every
item in the trip's single zone instead of per-stage zones
(`tripProjections.ts:139-156`), and `TripCloseout.ts:114, 129, 137, 150` each
return a `deferred` step naming the kernel-era table it did not read. The
refusal is honest and self-describing: `describeOperationalGate`
(`tripOperationalProjections.ts:130-137`) names the migrations to apply, and
`refusalForGate` (`:118-120`) distinguishes `FEATURE_DISABLED` (flag off or
schema missing — a stable answer) from `TRIP_PROJECTION_UNAVAILABLE` (probe could
not answer — retryable), *"because conflating the two would tell a client to stop
asking when the truth is 'ask again'."*

**Production value.** `false` (row exists; 2778 is applied).

**Why off.** `tripOperationalProjections.ts:8-18` states the reason, and **the
reason is now stale**: *"Production does not have 2420/2760-2762."* It does.
The flag exists because of a measured defect class — `COMPASS_ENABLED` was ON in
production and Compass's `get_freedom_windows` reached `trip_commitments`, a
table production lacked, so a tool reported enabled and failed. The flag gives
that schema its own capability closure.

**To turn on: `FLAG FLIP ONLY`.** I verified the **entire** declared requirement
(`tripOperationalProjections.ts:45-67` — 13 tables and every named column)
against the 2026-09-22 production snapshot: **all satisfied, zero gaps.** The
providedBy chain 2420 / 2760 / 2761 / 2762 / 2778 / 2780 / 2781 / 2784 / 2785 /
2794 is fully present in `production-applied-migrations.json`. The schema probe
will answer `ready`.

**Depends on**: `trip_kernel_enabled` only for the *writes* that fill these
tables (closeout's `RECORD_OUTCOME` etc.). The **reads** need only the schema, so
this can be flipped independently — it will just read empty tables for anything
the kernel would have written.

### 5.2 `map_trip_projection_read_enabled` — capability, `false`, schema APPLIED

**Gates (READ).** `api/lib/mapProjectionTripContract.ts:99` declares it;
`:141` is `MAP_TRIP_PROJECTION_CAPABILITY`; the consumer is
`api/lib/mapProjectionTripRead.ts:310` (`resolveCapability`), with the
refusal/missing-schema paths at `:241-281`. `:78-82` states the stake plainly:
the canonical path stays as the not-ready branch, because an empty projection
would be *"indistinguishable from 'you have no trips': 43 real production trips
would vanish from the map the moment an operator flipped a switch."*

**Production value.** `false` (row exists; 2610 applied). Seeded FALSE by 2610 —
`:96-98` *"a flag no migration seeds is a wall, not a gate"*.

**To turn on: `FLAG FLIP ONLY` for the schema** — `trip_map_projections` is
present with every column the reader selects (`trip_id, source_trip_version,
projection_schema_version, map_contract_version, generated_at, destination_lat,
destination_lng, body`), verified against the snapshot — **but see the dependency,
which makes a bare flip actively harmful.**

**Depends on**: `trip_map_projection_worker_enabled` (which fills the table) and,
through it, `trip_kernel_enabled` (which fills `trip_outbox`). The reader also
refuses any row below `MAP_TRIP_CONTRACT_VERSION = 2`
(`mapProjectionTripContract.ts:107-115`) and any
`projection_schema_version != 1` (`:102-105`), *"because a row without an anchor
silently drops a pin and a partly-drawn trip layer is indistinguishable from a
smaller one."*

**`DECISION`** — *What order do the three map flags go on in?* Reading before the
worker has populated the table is the exact failure `:78-82` describes.
**Recommended default: `trip_kernel_enabled` → `trip_map_projection_worker_enabled`
→ wait for the worker to drain → `map_trip_projection_read_enabled`.** Reason:
the reader refuses an incomplete layer rather than drawing a wrong one, so the
only cost of this order is latency, whereas the reverse order risks a map that
looks like "you have no trips".

### 5.3 `trip_map_projection_worker_enabled` — capability, `false`, schema APPLIED

**Gates (BACKGROUND JOB).** `api/lib/mapTripProjectionWorker.ts:52` declares it;
`:89` is the gate — `if (!(await isFlagEnabled(db, TRIP_MAP_PROJECTION_FLAG)))
return { ...EMPTY, reason: "disabled" }`. Registered in the trip outbox worker at
`api/server/trips/outboxWorker.ts:37`. The flag is re-checked **inside** the SQL
function via `p_enforce_flag` (`mapTripProjectionWorker.ts:30-31`). Gated off, a
tick is exactly one `feature_flags` read — i.e. the cost of leaving it off is one
query per minute, nothing else.

**Production value.** `false`.

**Why off — and the stated reason is STALE.**
`mapTripProjectionWorker.ts:42-46`: *"IN PRODUCTION THIS HAS NO INPUT. Production
has no trips.version, no trip_events, no trip_outbox (2334/2337/2420/2450 are
unapplied), and 2520's precondition block refuses to apply there until they are."*
**Every clause of that is now false.** All four of 2334 / 2337 / 2420 / 2450 are
in `production-applied-migrations.json`, and the snapshot shows `trips.version`,
`trip_events` and `trip_outbox` all present. 2520 itself is applied
(`20260908010109`) and `trip_map_projection_drain` is in production's function
list.

**To turn on: `FLAG FLIP ONLY`.** Schema and RPC both present.
**Depends on**: `trip_kernel_enabled` — the worker consumes
`CONSUMED_TRIP_EVENT_TYPES = TRIP_EVENT_TYPES`
(`mapTripProjectionWorker.ts:58`), i.e. exactly what the kernel publishes. With
the kernel off, `trip_outbox` receives nothing, so the worker runs and projects
zero rows. **Turn the kernel on first or this flip is a no-op.**

### 5.4 `discovery_trip_projection_enabled` — capability, `false`, schema APPLIED

**Gates (READ).** `api/lib/discoveryTripProjectionConsumer.ts:96` declares it;
`:203-230` is `discoveryTripProjectionGate`, with the flag read at `:207`;
`:243` is `useProjection`. Consumers: `routes/discoverySearch.ts` at both
surfaces, and `lib/inputAssistance/searchCandidates.ts:72`. Four read sites
resolve (`:127-129`).

**What changes when it goes ON — stated, because it is user-visible and it is a
behaviour *change*, not a feature add** (`:64-74`): the projection is built on
`toPrivateTripPreview`, so the owner's `show_exact_dates` /
`show_destination_city` / `show_header_publicly` toggles start applying to a
Discovery searcher. **Today Discovery ignores them** and shows the true
`start_date`, city and cover of every discoverable trip. The measurement
recorded in place: production 2026-09-07 had 12 discoverable trips, 0 with any
toggle off — so the change is unobservable today and real the moment an owner
sets one. This is the **more private** direction.

**Production value.** `false`. The row exists — 2550 **is** applied
(`20260908...` era, in the ledger), which contradicts the module's own comment at
`:138` (*"2550 unapplied there, measured 2026-09-07"*) — **another stale
comment**, and the prod capture showing `discovery_trip_projection_enabled=0`
(a row, not an absence) is the proof.

**To turn on: `FLAG FLIP ONLY`.** The declared requirement is only `trips` plus
`DISCOVERY_TRIP_PROJECTION_COLUMNS` (`:115-117`, derived from
`TRIP_DISCOVERY_SOURCE_COLUMNS` at
`api/domain/trips/contracts/tripDiscoveryProjection.ts:136-139`). Every column
including `version` is present in the snapshot. The one column the comment says
production lacks — `version` — it now has.

**`CODE` (small, optional, and not a blocker).** The capability is **not
registered** in `api/lib/capability/registry.ts`, deliberately, because that file
is owned by another lane (`discoveryTripProjectionConsumer.ts:118-139`). The
module states the consequence: the ratchet classifies the capability `latent`
rather than `guarded`, and *"the refusal is invisible to
checkFlagSchemaPrerequisites."* The handover is a one-liner the file spells out
itself. Registering it before the flip would make the prerequisite checker able
to see this gate; leaving it is safe but strictly worse.

**Depends on**: nothing (it reads `trips` directly, not a projection table —
`discovery_trip_projections` does not exist and is not required).

### 5.5 `experience_session_enabled` — capability, **row absent**

**Gates (READ + WRITE, three routes, one shared gate).**
`api/routes/experienceSessions.ts:104` declares it; `:162` is the gate, inside a
shared `gate()` helper (`:154-170`) that every route calls first, answering
`feature_disabled "Experience sessions are not enabled"`. The three routes:
`GET /intel/experience-sessions/open`, open-against-an-opportunity, and
close-with-an-outcome (`api/migrations/2841_experience_session_flag.sql:19-23`).

**Production value.** Row absent.

**Why off.** `2841_experience_session_flag.sql:25-30`: *"Seeded FALSE … Enabling
is an owner decision — it opens a surface that WRITES canonical events for a
person — and the postcondition below refuses to commit this file if the row reads
TRUE."*

**To turn on: `MIGRATION`** — apply
`api/migrations/2841_experience_session_flag.sql`. **Not applied to production.**
This is the cheapest migration in my domain: `:31-32` — *"Additive: one
INSERT ... ON CONFLICT DO NOTHING. No DDL, no other row."* **It adds no table at
all**, on purpose (`:7-17`): an ExperienceSession is two rows on the existing
`canonical_events` spine, and the only platform change the bridge needed was one
allow-listed payload key (`experience_session`) in `lib/canonicalEvents.ts`,
which is application code already in the tree. After applying, `FLAG FLIP ONLY`.

**Depends on**: `memory_projection`, but only for the **memory** half of the
bridge — see §6.4. The three routes themselves work without it.

---

## 6. Remaining memory/highlight projection flags

### 6.1 `memory_projection` — capability, `false`, schema APPLIED (with one gap)

Note the name: **no `_enabled` suffix**, unlike every other flag here. It is
still a capability flag read fail-closed through `isFlagEnabled`.

**Gates (BACKGROUND JOB + READ + WRITE), five sites:**

- **Job.** `api/lib/memoryProjectionScheduler.ts:54` — the driver that "makes
  the memory system run" (§22): on a 6-hour cadence it calls
  `project_all_memory()` (projects canonical facts + the Experience Graph
  `compass_graph_edges` into `memory_events` / `memory_projections`) and
  `memory_sweep_expired()` (§18 retention). Both are service-role SQL functions
  that **also self-check the flag**; gated here too, fail-closed, so off is an
  inert no-op (`:1-17`).
- **Write.** `api/services/memoryProjections/sessionMemoryStore.ts:112` —
  `persistSessionMemory` refuses with `memory_projection_off`.
- **Read.** `api/compass/ProjectedMemoryPrompt.ts:35` — Compass's projected-memory
  prompt.
- **Map producer.** `api/lib/mapProducers/memoryProducer.ts:186` — returns
  `{ ok: false, reason: "flag_off" }`.
- **Place bridge.** `api/lib/placeIdBridge.ts:59`.

**What is lost with it off.** The memory system does not run at all: no canonical
facts or Experience Graph edges are projected into `memory_projections`, no
retention sweep, no memory layer on the map, and Compass has no projected memory
to draw on. This is the flag that makes "the app remembers things about you"
true or false.

**Production value.** `false`. Confirmed in both the capture and the snapshot's
`flags` dict.

**To turn on: `FLAG FLIP ONLY` for the main path.** The projector family is
applied: `project_all_memory`, `project_user_memory`,
`project_user_memory_with_retraction`, `memory_sweep_expired`, `memory_retrieve`,
`memory_rediscover`, `record_intent_memory` are all in production's function
list, and `memory_projections` exists with the columns the projector writes.
`2963_memory_projector_place_lane_union` and
`2965_memory_projector_canon_saves_delete_guard` are both applied.

**`MIGRATION` for one sub-path** — `api/migrations/3314_memory_projection_claim_refs.sql`
is **not applied**, and the snapshot confirms `memory_projections` has **no
`claim_refs` column**. `sessionMemoryStore.ts:157` writes `claim_refs: refs`, and
`:162` catches the resulting 42703/PGRST204 and returns the named refusal
`claim_refs_unavailable` — *"deliberately NOT a retry without the column"*
(`:38`). So with `memory_projection` and `experience_session_enabled` both on,
the **session → memory bridge still writes nothing** in production, cleanly and
by name. `:16` explains why the column matters: the lineage is what lets the
revocation reach and account erasure find that memory later. Apply 3314 if the
session bridge is meant to work.

**Depends on**: nothing upstream. `experience_session_enabled` depends on it.

### 6.2 `memory_public_feed_projection_enabled` — capability, `false`, schema APPLIED

**Gates (READ, a swap not a disable).** `api/routes/memories.ts:647` —
`const useProjection = await isFlagEnabled(sc, "memory_public_feed_projection_enabled")`.
ON, the public memories feed is served by the SQL function
`memory_public_feed(p_viewer, p_limit, p_cursor)` (`:650-662`). OFF, it is served
by the inline `sc.from("memories").select(...)` query at `:664+` with
`state = published`, `visibility = public` and the MEM·M1 hidden-viewer filter.

**So nothing is dark here — the feed works either way.** The flag chooses the
implementation.

**Production value.** `false`. Seeded by
`api/migrations/2338_memory_location_precision.sql`, which **is** applied, and
the function `memory_public_feed` **is** in production's function list.

**To turn on: `FLAG FLIP ONLY`.** **Recommended: leave it OFF for hosted
testing** unless the feed is specifically under test. Reason: the off path is the
one production has been serving, and swapping a feed's implementation is a
behaviour change with no feature gain — if the two disagree, hosted testing would
be measuring the swap rather than the product.

**Depends on**: nothing.

### 6.3 `memory_location_precision_enabled` — capability, `false`, schema APPLIED

**Gates (READ + WRITE column naming, seven sites).** `api/routes/memories.ts:473,
599, 1472, 1625, 2706, 2984, 3289` each read the flag into `precisionEnabled` and
use it to choose between `MEMORY_SELECT_WITH_PRECISION` and `MEMORY_SELECT`, and
to decide whether `locationPrecision` reaches the insert.

**Why the gate is shaped this way** (`memories.ts:475-486`): *"A client may not
name a column this database does not have: PostgREST fails the WHOLE insert on an
unknown key (PGRST204), so an accepted-but-unwritable field would take Memory
creation to 100% failure."* With the flag off a client-sent `locationPrecision` is
**silently dropped**, and the comment records that this was measured against the
installed supabase-js: an `undefined` property is dropped from the request
entirely, so the insert is byte-identical on the wire to the pre-2338 one.

**What is lost.** Per-memory location precision (the owner's choice of how
precisely a memory's place is recorded/shown).

**Production value.** `false` — but **`memories.location_precision` exists in
production** (snapshot-confirmed; 2338 applied `20260915080240`).

**To turn on: `FLAG FLIP ONLY`.**
**`DECISION` rider** — `2721`'s header names an open owner decision,
`LOCATION_PRECISION_DEFAULT` (cited at `checkProductionDrift.ts:499-501`), which
this flag's flip does not settle. **Recommended default: flip it ON and leave the
default at whatever 2338 set.** Reason: the column is there, the feature is
additive and more private (it lets an owner be *less* precise), and the open
decision is about the default value rather than about whether the capability may
exist.

**Depends on**: nothing.

### 6.4 `highlights_feed_bounded_enabled` — capability, `false`, schema APPLIED

**Gates (READ, pagination only).** `api/routes/highlights.ts:2696` —
`const bounded = await isFlagEnabled(sc, "highlights_feed_bounded_enabled")`.
ON, the following-feed query is capped and paginated (`feedLimit`, `feedCursor`,
with an over-fetch to survive the post-query visibility filter). OFF, it is the
unbounded query it has always been.

**Why off.** `highlights.ts:2683-2695`, quoted: the feed *"is bounded only by the
24-hour expiry. Every sibling read is bounded — /highlights/active caps at 100,
the memories discovery feed caps at 100 — so the omission is an oversight, not a
design. Capping a feed that is uncapped today can only REMOVE highlights from
somebody's screen, and how many is finite-enough is a product decision §12 does
not make."* `isFlagEnabled` being false-on-error leaves the feed unbounded rather
than silently truncating it.

**Production value.** `false`. Seeded FALSE by
`api/migrations/2339_highlights_feed_bound.sql`, which **is** applied
(`20260915080308`).

**To turn on: `DECISION`.** *What is "finite enough" for the following feed, and
do we accept that capping removes highlights from a screen?* The constants
`FOLLOWING_FEED_DEFAULT_LIMIT` / `FOLLOWING_FEED_MAX_LIMIT` already exist in
`routes/highlights.ts`, so no number needs inventing. **Recommended default: flip
it ON for hosted testing.** Reason: every sibling feed is already bounded, an
uncapped feed is the kind of thing that only hurts at scale (so testing will not
reveal the problem it causes), and pagination is what a real client needs.
`checkProductionDrift.ts:502-507` records this flag as one of four under a
settled ruling that *"every capability is still seeded FALSE … and no
user-visible behaviour changed by this ruling: the code already refused, and the
ruling makes the refusal intended rather than provisional."* So flipping it is a
product choice, not an overturn of that ruling.

**Depends on**: nothing.

---

## 7. Kill-switch interaction (`disable_messaging`, `disable_unknown_message_requests`)

Both are **kill switches**, both read through `isKillSwitchEngaged`
(`api/lib/featureFlags.ts:54-66`), and both are `0` in production — i.e. **not
engaged**, messaging is not stopped. Another agent owns them; I report only the
interaction with my domain.

Where they are honoured
(`api/lib/telegraphThreadWrite.ts:88`, `api/routes/messaging.ts:663, 2704, 3249`,
`api/routes/telegraphVoice.ts:31`,
`api/domain/telegraph/policies/shareAuthorizationPolicy.ts:223`):
thread creation, message send, the message-request path and voice.

**`CODE` — the §13.1 command route and the unsend route do not honour
`disable_messaging`.** I grepped every occurrence of both switch names across the
tree: neither `api/server/telegraph/commandRoute.ts` nor
`api/routes/telegraphLifecycle.ts` reads either one. So if an operator engages
`disable_messaging`:

- `POST /api/threads/:threadId/messages/:messageId/unsend` still runs
  (today it fails on the absent RPC, so the gap is latent, not live);
- `POST /api/telegraph/commands` still issues `CREATE_COORDINATION_SESSION`,
  which **writes a `messages` row** — the one issuable command that needs no
  unapplied schema. That is a message write surviving the messaging stop;
- `UNSEND_MESSAGE` / `ADD_REACTION` / `REMOVE_REACTION` would also survive the
  stop **once `telegraph_message_kernel_enabled` is turned on**.

This is latent today and becomes live the moment the kernel flag is flipped, so
it belongs in the same change. The fix is the shape
`api/lib/featureFlags.ts:131-141` prescribes verbatim:
`killSwitchStateUnknown(flagSc)` → `degraded_unavailable`, then
`isKillSwitchEngaged(flagSc!, 'disable_messaging')` → refuse. Note the subtlety
that comment records: both operands of the old `&&` are the same fact, and an
**absent** service client (the shape a deployment takes when
`SUPABASE_SERVICE_ROLE_KEY` is missing) used to skip the switch entirely and let
the write through with a 2xx. `api/src/test/verifyFailOpenStopReads.test.ts` is
the ratchet that keeps the old shape from coming back — which suggests these two
routes are simply not in its scope yet.

`disable_unknown_message_requests` interacts with
`telegraph_request_origin_enabled` only in the sense that both touch
`POST /api/message-requests`: the stop is checked first
(`messaging.ts:662-663`), the origin columns later (`:768`, `:817`). No conflict.

---

## 8. Consolidated action list

### `MIGRATION` (production has not applied these)

| flag | migration(s) | note |
|---|---|---|
| `telegraph_message_kernel_enabled` | 2810 → 2811 → 2325 → 3000 | order matters; **owned by the production rollout thread** |
| `telegraph_live_references_enabled` | 2802 | flag seed only |
| `telegraph_report_evidence_enabled` | 2812 | creates the evidence table; closes a live data-destruction harm |
| `telegraph_request_origin_enabled` | 2813 | adds origin columns to `message_requests` |
| `telegraph_discovery_actions_enabled` | 3467 | cross-architecture file — confirm what else it seeds |
| `memory_kernel_enabled` | 2993 → 3001 | **required before the flip**, else Highlight writes 503 |
| `experience_session_enabled` | 2841 | one INSERT, no DDL — the cheapest in this domain |
| `memory_projection` (session-bridge sub-path only) | 3314 | without it the bridge refuses `claim_refs_unavailable` |

### `FLAG FLIP ONLY`

`trip_kernel_enabled`, `trip_operational_projections_enabled`,
`trip_map_projection_worker_enabled`, `map_trip_projection_read_enabled`
(order-sensitive — §5.2), `discovery_trip_projection_enabled`,
`memory_projection` (main path), `memory_public_feed_projection_enabled`,
`memory_location_precision_enabled`.

### `DECISION`

1. Accept an undrained `telegraph_outbox` during hosted testing? → **yes**, truncate before launch.
2. Run `telegraph_backfill_message_sequences`? → **no**, no reader uses `sequence`.
3. Bound group history (`telegraph_history_bound_enabled`)? → **yes**, ON.
4. Moderation-evidence retention schedule (`retention_until`)? → leave **NULL**, apply 2812 and flip ON.
5. Accept an undrained `memory_event_outbox`? → **yes** — a drainer is wired and started.
6. Order of the three map flags? → kernel → worker → drain → read.
7. Cap the highlights following feed? → **yes**, ON; constants already exist.
8. Swap the public memories feed to the SQL projection? → **leave OFF** unless that feed is under test.
9. `LOCATION_PRECISION_DEFAULT` (open, pre-existing, not settled by any flip) → flip the flag ON, leave 2338's default.

### `CODE`

1. **`api/server/telegraph/commandRoute.ts` and `api/routes/telegraphLifecycle.ts`
   do not honour `disable_messaging`.** Add the
   `killSwitchStateUnknown` → `degraded_unavailable`, then
   `isKillSwitchEngaged('disable_messaging')` pair that
   `api/lib/featureFlags.ts:131-141` prescribes. Latent today; live the moment
   `telegraph_message_kernel_enabled` goes on.
2. **`DISCOVERY_TRIP_PROJECTION` is unregistered** in
   `api/lib/capability/registry.ts`. The one-line handover is written out at
   `api/lib/discoveryTripProjectionConsumer.ts:133-134`. Without it the
   capability is `latent` and invisible to `checkFlagSchemaPrerequisites`.
   Safe today, strictly worse.

### `CONFIG`

**None.** No flag in this domain needs an env var, secret or third-party
provider. Every one is a migration, a flag row, or a decision. (The nearest thing
is `SUPABASE_SERVICE_ROLE_KEY`, which must be present for the kernels to work at
all — `memoryKernelClient` and `tripKernel`'s gate both return null without it,
and `commandRoute.ts:143` answers `server_not_configured` — but that is existing
deployment configuration, not a new value Chelsi must supply.)

### Stale documentation found (not blockers, but they will mislead the next reader)

1. `api/lib/mapTripProjectionWorker.ts:42-46` — *"Production has no trips.version,
   no trip_events, no trip_outbox (2334/2337/2420/2450 are unapplied)"*. All four
   are applied and all three objects exist.
2. `api/domain/trips/policies/tripOperationalProjections.ts:8-10` — *"Production
   does not have 2420/2760-2762"*. It has all of them, and the full 13-table
   requirement is satisfied.
3. `api/lib/discoveryTripProjectionConsumer.ts:138` — *"2550 unapplied there,
   measured 2026-09-07"*. 2550 is applied; the flag has a row reading `false`.

All three were accurate when written (2026-09-07) and were overtaken by the
2026-09-16 trips chain. They matter because each one argues *"the flag is off
because the schema is absent"*, and for these three that is no longer the reason.

### Checks I could not complete

- I did **not** run `scripts/checkFlagSchemaPrerequisites.ts`, so the "schema
  satisfied" conclusions above are my own comparison of each
  `CapabilityDefinition`'s declared `requires` against the 2026-09-22 production
  snapshot, not the checker's verdict. They agree with the ledger in every case.
  The snapshot's watermark is `20260922155706`, so **any change to production
  after 2026-09-22 is outside what I can see** — and the ledger's own `$comment`
  documents that it has lagged reality twice before (2026-09-20 and 2026-09-22
  backfills), so a flag row or object could have appeared since without either
  source recording it.
- The snapshot's `flags` dict is a **subset** (9 of my 18 flags appear in it). For
  the rest I relied on `prod-sorted.txt`, which the brief designates as
  authoritative. Where both exist they agree.
- `3467_cross_architecture_flags.sql` seeds more than
  `telegraph_discovery_actions_enabled`; I read only the entry for my flag and
  cannot say what else applying it would turn on.
## Section 03 — Rent-a-Buddy, creator attribution, trust, and the ranking/boost flags

Scope owner: this thread. Written 2026-10-03. Read-only; nothing in the repo was
edited and no SQL was run.

**Overlap handling.** `/mnt/project-files/hosted-creator-ledger-testing-2026-10-03.md`
(the "C-11" thread) owns the creator ledger, its migration set (2901, 2920, 2921,
2922, 3386, 3387, 3510), the erasure-policy decision and the identity-verification
route. Nothing below contradicts it; where a flag is theirs it is marked
**OWNED BY C-11** and only placed in the map, not re-decided.

---

### 0. Ownership table — read this first

| flag | owner |
|---|---|
| `creator_attribution_enabled` | **OWNED BY C-11** (§5 of their doc). Placed here, not re-decided. |
| `rent_buddy_allow_bookings_without_kyc` | **OWNED BY C-11** (their §6, Route A / Route B). Not in my brief; listed only as a dependency. |
| `rent_buddy_enabled` | **shared** — C-11 records it as an owner decision (`testing-mode-flows.md:567`); the *reachability* analysis below (what 403s/404s, which gate) is mine. |
| `disable_rent_buddy_booking`, `disable_rab_bookings` | **mine** (C-11 only states "leave false"; the duplicate-vs-distinct question is answered here). |
| `RENT_BUDDY_MVP_MODE`, `_ADMIN_ONLY_MODE`, `_BETA_ONLY_MODE`, `_GROUP_BOOKINGS_ENABLED`, `_NIGHTLIFE_ENABLED`, `_OFFERS_ENABLED`, `_PACKAGES_ENABLED` | **mine** — nobody had mapped these. |
| `ACTIVITY_DISCOVERY_BOOST_ENABLED`, `NEW_CONTRIBUTOR_BOOST_ENABLED`, `RETURNING_USER_BOOST_ENABLED`, `UNDEREXPOSED_CONTENT_BOOST_ENABLED`, `RANKING_EXPERIMENT_ENABLED`, `CREATOR_FATIGUE_ENABLED` | **mine** |
| `MEDIA_ACTIVE_CREATOR_BOOST_ENABLED`, `MEDIA_NEW_CREATOR_BOOST_ENABLED`, `MEDIA_RETURNING_CREATOR_BOOST_ENABLED`, `MEDIA_UNDEREXPOSED_BOOST_ENABLED`, `MEDIA_CREATOR_FATIGUE_ENABLED`, `PORTAVA_PUBLISHER_BOOST_ENABLED`, `PORTAVA_FEATURED_BOOST_ENABLED` | **mine** (`MEDIA_RANKING_ENABLED`, their parent, belongs to the media/ranking domain — flagged as a dependency only) |
| `trust_engine_enabled`, `trust_gaming_detection_enabled`, `events_trust_gates_enabled` | **mine** |

**Schema-capability note.** I checked
`artifacts/api-server/src/scripts/checkFlagSchemaPrerequisites.ts` — its exported
`KNOWN` map contains only two live entries (`intel_capture_quick_signal:401`,
`intel_trail_followup:407`). **No flag in my domain has a schema-prerequisite
entry**, and `trust_engine_enabled`'s former entry was struck when 2371 landed
(`checkFlagSchemaPrerequisites.ts:264`); `2371_trust_profiles_evidence` is present
in `lib/capability/production-applied-migrations.json`. So none of my flags is a
"reads TRUE but schema unapplied" case — except the creator-ledger family, which
is C-11's and is exactly that case.

**Limit of the applied-migrations record.** `production-applied-migrations.json`
holds 129 entries spanning `2460_…` to `2971_…` only. It therefore **cannot**
confirm or deny any migration numbered below 2460 or above 2971. Where I needed
an answer for those I used the production flag capture (`prod-sorted.txt`) as the
evidence instead, and say so.

---

### 1. The master switch: `rent_buddy_enabled`

* **Polarity**: capability flag.
* **Production value**: `false`.
* **Why off**: stated, and it is an owner decision, not an accident —
  `src/migrations/2210_rent_buddy_default_off.sql:3-6`: *"Owner decision,
  2026-08-31: Rent a Buddy must remain UNAVAILABLE by default … until an
  administrator explicitly enables it, and only after KYC, payments, safety
  controls, moderation, and SOS flows are launch-ready."* 2210 supersedes
  `0090_rent_buddy_rollout_tables.sql:187-192`, which forced the row TRUE on
  every restore, and `0117_beta_feature_flags.sql:33` (inert, `DO NOTHING`).

#### What is actually unreachable with it false — cited gates

Two distinct gates, two distinct status codes:

1. **`requireRentBuddyEnabled`** — `routes/rentABuddy.ts:299-306`. Responds
   **403** `{ error: "feature_disabled", gate: "rent_buddy_enabled" }`
   (`rentABuddy.ts:302`). Fail-closed by construction:
   `checkRentBuddyEnabled` is `!!data && !!data.enabled`
   (`rentABuddy.ts:243-251`), so a missing row, a null client and a failed read
   all deny. Call-site counts I measured by grep:
   `rentABuddy.ts` 76, `rentABuddyMarketplace.ts` 20, `rentABuddySpec.ts` 19,
   `rentABuddyRollout.ts` **0**.
2. **`checkRentBuddyAccess` step 1** — `routes/rentABuddyRollout.ts:241-244`.
   Returns **403** `feature_disabled` with **no `gate` field**; the app
   attributes a gate-less `feature_disabled` to the master switch
   (`travel-buddy-standalone/src/services/rentABuddyGates.ts:26-29`, and the
   message it shows is "Rent a Buddy is switched off",
   `rentABuddyGates.ts:50-57`).

**Admin and moderation are deliberately exempt.** `rentABuddy.ts:289-298` states
the rule: admin/moderation handlers take no master-flag gate, because "an admin
queue that hides its rows cannot moderate them" and "the flag is administered
THROUGH admin endpoints". Consequence: all 20 `/api/admin/rent-buddy/*` routes in
`rentABuddyRollout.ts:573-1258` work today with the master flag off.

**Three user-facing reads are NOT gated and remain reachable with the master off**
— I verified each handler body:
* `GET /api/rent-buddy/launch-status` (`rentABuddyRollout.ts:1286`) — reads
  `rent_buddy_city_rollouts` and counts `rent_buddy_profiles` with
  `available_now = true` (`:1329-1336`). No master-flag read anywhere in the
  handler.
* `GET /api/rent-buddy/me/beta-status` (`rentABuddyRollout.ts:1457`) — no
  master-flag read.
* `GET /api/rent-a-buddy/cities/:city/available` (`rentABuddy.ts:898`) **does**
  read it (`:902-903`) and answers `{available:false, code:"feature_disabled"}`.

So "the master flag is off" means: no user can create or mutate any
`rent_buddy_*` row, but the launch-status/beta-status reads still answer, and
admin surfaces are fully live.

Background jobs and other consumers that go dark with it off (all fail-closed):
`lib/rentBuddyRequestSweeper.ts:57` (`RAB_MASTER_FLAG`), `lib/buddyMapRead.ts:203`
(returns `{ok:true, pins:[]}` — an empty map, not an error),
`lib/rentBuddyFeeSchedule.ts:231`, `routes/airport.ts:3426` (layover buddy),
`services/wall/wallRabGate.ts:49` and `:64` (Wall RAB strip; needs
`wall_rab_integration_enabled` **and** the master — that flag is `false` in
production and belongs to the Wall domain).

* **To turn on for hosted testing**: `DECISION`.
  *Question*: does Chelsi accept Rent-a-Buddy being reachable in the hosted
  deployment before the 2210 readiness list (KYC, payments, safety, moderation,
  SOS) is complete?
  *Recommended default*: **yes, turn it on**, because the deployment is synthetic
  accounts only, `testing-mode-flows.md:547/567` plans the TM-RAB lane and marks
  this exact flip as the awaited owner decision, and the C-11 doc shows the
  ledger flows cannot be exercised at all without it. Note this is the *same*
  decision C-11's §5 records — one decision, not two.
* **Depends on**: nothing above it. But booking *creation* additionally needs the
  KYC gate cleared — `lib/rentBuddyKycGate.ts:63-85`, **OWNED BY C-11**.

---

### 2. Do the four TRUE `RENT_BUDDY_*` sub-flags do anything while the master is off?

**No — none of them. Answer established by control flow, not inference.**

Every sub-flag read sits *after* the master-flag return in the same function:
master at `rentABuddyRollout.ts:241-244`, then `ADMIN_ONLY` at `:247`,
`MVP_MODE` at `:311`, `GROUP_BOOKINGS` at `:323`, `PACKAGES` at `:336`,
`OFFERS` at `:349`, `NIGHTLIFE` at `:381`, `BETA_ONLY` at `:487`. Step 1 returns
`{allowed:false}` before any of them is read. And `rentABuddyRollout.ts` has
**zero** `requireRentBuddyEnabled` call sites, so `checkRentBuddyAccess` is the
*only* place any of the seven is read — grep over the whole tree found no other
non-test reader of any of them. Therefore with `rent_buddy_enabled = false` all
seven are inert, and the four that read TRUE change nothing for anybody.

**A second, stronger constraint on three of them.** Even with the master ON,
`GROUP_BOOKINGS`, `PACKAGES` and `OFFERS` are read **only inside
`if (mvpMode && …)`** (`:321-332`, `:334-345`, `:347-357`). `RENT_BUDDY_MVP_MODE`
is `false` in production, so those three branches are unreachable even after the
master flip. `NIGHTLIFE` is the exception: its gate at `:379-388` is guarded by
`category === "nightlife"` only, independent of MVP mode, so it is the one
sub-flag that becomes live the moment the master is on.

**Seeded FALSE, live TRUE — nobody wrote down why.**
`0090_rent_buddy_rollout_tables.sql:220-228` seeds all seven `FALSE` with
`ON CONFLICT DO NOTHING`. Production holds `GROUP_BOOKINGS`, `NIGHTLIFE`,
`OFFERS`, `PACKAGES` = `1`. Those four TRUEs came from an operator toggle or
console write; **no stated reason found** in any migration or doc. I did not
find, and do not assert, when or by whom.

#### Per-flag rows

| flag | polarity | reader / gate | gates what | prod | why off/on | to enable for testing |
|---|---|---|---|---|---|---|
| `RENT_BUDDY_MVP_MODE` | **restriction** (`isKillSwitchEngaged`, `:311`) | `rentABuddyRollout.ts:310-318` | WRITE + READ paths via `checkRentBuddyAccess`. TRUE restricts categories to city/language/arrival/shopping/content (403 `category_not_available`), and additionally arms the group/package/offer sub-gates and an ID-verification requirement for `action:"book"` (`:360-376`, 403 `verification_required`) | `false` | seeded FALSE at `0090:221`; no stated reason to change | `FLAG FLIP ONLY` — **leave false**. Turning it on would *add* restrictions, including an ID-verification requirement on every booking, which is the opposite of what hosted testing needs. |
| `RENT_BUDDY_ADMIN_ONLY_MODE` | **restriction** (`isKillSwitchEngaged`, `:247`) | `rentABuddyRollout.ts:247-258` | all non-`isTestUser` access: 401 `unauthenticated` or 403 `admin_only`. Admin check is `isAdmin(sc, userId, ["admin","owner"])` (`:255`) | `false` | seeded FALSE at `0090:222` | `FLAG FLIP ONLY` — **leave false**, unless the hosted deployment should be admin-only; then `DECISION` (see note below). |
| `RENT_BUDDY_BETA_ONLY_MODE` | **restriction** (`isKillSwitchEngaged`, `:487`) | `rentABuddyRollout.ts:486-506` | every non-`read` action for users without an `active` row in `rent_buddy_beta_access` → 403 `beta_access_required` | `false` | seeded FALSE at `0090:223` | `FLAG FLIP ONLY` — **leave false**; turning it on would require seeding `rent_buddy_beta_access` rows for every synthetic tester. |
| `RENT_BUDDY_GROUP_BOOKINGS_ENABLED` | capability (`isFlagEnabled`, `:323`) | `rentABuddyRollout.ts:321-332` | WRITE only, and **only when MVP_MODE is on**: `action:"book"` with `category === "group"` or `groupSize > 4` → 403 `group_bookings_unavailable` | **`true`** | seeded FALSE at `0090:225`, flipped TRUE in production — **no stated reason found** | `FLAG FLIP ONLY` (already true). Inert today; stays inert while MVP_MODE is false. |
| `RENT_BUDDY_PACKAGES_ENABLED` | capability (`isFlagEnabled`, `:336`) | `rentABuddyRollout.ts:334-345` | WRITE only, MVP-gated: `action:"package-book"` → 403 `packages_unavailable`. The caller that passes that action is `POST /rent-a-buddy/packages/:packageId/book` (`rentABuddyMarketplace.ts:1515`, wiring noted at `:1527-1530`) | **`true`** | seeded FALSE at `0090:226`; **no stated reason found** for the TRUE | `FLAG FLIP ONLY` (already true). Note `rent_buddy_packages_v2_enabled` is a different, unread row — `docs/ops/unseeded-flag-inventory.md:112` records that only v1 is wired. |
| `RENT_BUDDY_OFFERS_ENABLED` | capability (`isFlagEnabled`, `:349`) | `rentABuddyRollout.ts:347-357` | WRITE only, MVP-gated: `action:"offer-accept"` → 403 `offers_unavailable`. Caller: `POST /rent-a-buddy/offers/:offerId/accept` (`rentABuddyMarketplace.ts:1190`, wiring noted at `:1201-1204`) | **`true`** | seeded FALSE at `0090:227`; **no stated reason found** | `FLAG FLIP ONLY` (already true). |
| `RENT_BUDDY_NIGHTLIFE_ENABLED` | capability (`isFlagEnabled`, `:381`) | `rentABuddyRollout.ts:379-388` | READ + WRITE, **not** MVP-gated: any request with `category === "nightlife"` → 403 `nightlife_disabled`. Also refused when `rent_buddy_global_controls.nightlife_paused` is set (`:382`) | **`true`** | seeded FALSE at `0090:224`; **no stated reason found** | `FLAG FLIP ONLY` (already true). **The only sub-flag that becomes live on the master flip.** Nightlife bookings will then be permitted unless an admin sets `nightlife_paused`. |

**Admin-only-mode note (`CONFIG`-adjacent, not a flag).** `rentABuddyRollout.ts:214-223`
records that no `owner` row can exist, because `profiles_role_check` is
`CHECK (role = ANY (ARRAY['user','admin']))`. So `ROLLOUT_ADMIN_ROLES` admits
exactly `admin`. If admin-only mode is ever used for hosted testing, testers need
`profiles.role = 'admin'`.

---

### 3. `disable_rab_bookings` vs `disable_rent_buddy_booking` — duplicates or not?

**They gate the same five paths and nothing distinguishes them. They are
functional duplicates by construction, not by accident.**

Evidence. Every read is the pair, OR'd, in one `if`, and I read all five:

| route | handler decl | gate lines |
|---|---|---|
| `POST /rent-a-buddy/bookings` | `rentABuddy.ts:1987` | `rentABuddy.ts:2003-2004` |
| `POST /rent-a-buddy/bookings/:bookingId/rebook` | `rentABuddy.ts:7983` | via `enforceBookingCreationGates(..., applyKillSwitch:true)` at `rentABuddy.ts:8058`, gate body at `rentABuddy.ts:1767-1773` |
| `POST /rent-a-buddy/buddies/:buddyId/request` | `rentABuddySpec.ts:397` | `rentABuddySpec.ts:419-420` |
| `POST /rent-a-buddy/offers/:offerId/accept` | `rentABuddyMarketplace.ts:1190` | `rentABuddyMarketplace.ts:1204-1205` |
| `POST /rent-a-buddy/packages/:packageId/book` | `rentABuddyMarketplace.ts:1515` | `rentABuddyMarketplace.ts:1527-1528` |

There is **no route that reads one and not the other**. Grep over the whole tree
found no other non-test reader of either name. The pairing is deliberate and
documented: `lib/featureFlags.ts:163-177` — *"Two flag names stop Rent-a-Buddy
booking creation (FL-06: both are honoured)"* — and
`rentABuddy.ts:2001-2002` records why: `disable_rab_bookings` *"was an orphan with
no reader, so that admin toggle was a silent no-op"*, i.e. the duplicate exists
because an admin-visible row had to be made to work rather than deleted.

Only one asymmetry exists, and it is cosmetic: `engagedRabBookingKillSwitch`
(`featureFlags.ts:179-184`) iterates the pair **in order** and returns the first
engaged name for the response's `gate` field, falling back to the collective
`"rab_booking_kill_switch"`. So if both are engaged the body names
`disable_rent_buddy_booking`, never the other. Behaviourally identical; only the
error label differs.

* **Polarity**: both are kill switches, read through `isKillSwitchEngaged`, so
  an unreadable row counts as **engaged** (`BRIEF.md` semantics; restated at
  `featureFlags.ts:172-175`).
* **Response**: **404** `{ error:"feature_disabled", gate:<name> }` — note this
  is a 404, distinct from the master flag's 403. The gate field is what lets the
  app tell "emergency stop" from "not launched"
  (`travel-buddy-standalone/src/services/rentABuddyGates.ts:24-29`).
* **Production value**: both `false` (not engaged). Row for
  `disable_rab_bookings` is seeded by
  `src/migrations/0065_phase7_safety.sql:84` ("Emergency: freeze all new
  rent-a-buddy booking requests").
* **Why off**: they are emergency stops; off is the normal state. No stated
  reason needed, and none found.
* **To turn on for hosted testing**: `FLAG FLIP ONLY` — **leave both false**,
  which matches C-11's §5 ("already not engaged"). Nothing to change.
* **Also recorded**: `lib/rentBuddyKycGate.ts:13-22` notes these switches
  "default to allowing bookings" and that the rebook path once skipped them
  entirely. That hole is closed — `rentABuddy.ts:8058` now passes
  `applyKillSwitch: true` — so no booking-creation path bypasses the pair.

---

### 4. Creator attribution

#### `creator_attribution_enabled` — **OWNED BY C-11**

Placed, not re-decided. Polarity: capability. Production: **row absent entirely**
(confirmed independently — the name does not appear in `prod-sorted.txt`), because
`2922_creator_attribution_flag.sql` is unapplied. Single reader:
`creatorLedgerEnabled()` at
`services/creators/CreatorAttributionService.ts:107-109`, which delegates to
`isFlagEnabled` (fail-closed), with `CREATOR_ATTRIBUTION_FLAG` declared at `:99`.
Downstream fail-closed consumers all cite it in their headers:
`CreatorLedgerOperations.ts:26`, `CreatorAttributionProducers.ts:52`,
`CreatorLedgerReader.ts:27`, `routes/creatorEconomy.ts:25`,
`routes/adminCreatorLedger.ts:22`, and the hourly background job
`lib/creatorAttributionScheduler.ts:9` (one flag read per tick, nothing else —
`index.ts:293`). Label: **`MIGRATION`** — 2922 plus the rest of C-11's ordered
set; see their §3 for the order and §4 for why 3510 must not be dropped. Their
§6a rehearsal findings (missing rollbacks for 2920/2922, the empty-`profiles`
self-proof skip, 2920 not re-runnable after 3386) stand as written and I did not
re-check them.

#### `CREATOR_FATIGUE_ENABLED` — mine

* **Polarity**: capability flag, but with a **custom reader, not `isFlagEnabled`**.
* **Gates**: a WRITE, fire-and-forget. `lib/rankLog.ts:33-45` — when on,
  impression batches upsert into `viewer_creator_fatigue` via the
  `increment_creator_fatigue_batch` RPC (`rankLog.ts:47-66`). Off, no fatigue
  rows are ever written, so the fatigue penalty in ranking has no data.
* **Failure direction is unusual and worth recording**: the reader has a 60 s TTL
  cache (`rankLog.ts:28-30`) and on a read error it **keeps the last known value
  and does not cache** (`rankLog.ts:38`, reported at `:588-591`, DV-01). That is
  neither fail-open nor fail-closed — it is "hold last known", and on a cold
  process the initial `_fatigueFlagEnabled = false` means a first-read failure
  behaves closed.
* **Production value**: `false`.
* **Why off**: no stated reason found. `src/migrations/2084_codify_live_read_flags.sql:28-31`
  is explicit that its seeded values are *"the value production held on
  2026-08-12"* — a reconciliation of repo to production, **not** a statement of
  intent — and `2084:56` describes the flag but not why it is off.
* **To turn on**: `FLAG FLIP ONLY` for the write itself. But see §5: with
  `ACTIVITY_DISCOVERY_BOOST_ENABLED` false the ranking core does not reorder
  anything, so fatigue rows would be written and have no visible effect.
  Recommend flipping it **with** the boost master, not alone.
* **Depends on**: effectively `ACTIVITY_DISCOVERY_BOOST_ENABLED` for any
  observable outcome. Note this is a *separate* flag from
  `MEDIA_CREATOR_FATIGUE_ENABLED` (§6) — different reader, different table,
  different feed.

---

### 5. The discovery ranking flags — the single most consequential finding here

All five are loaded in one query, `loadRankingFlags`,
`services/ranking/DiscoveryRankingService.ts:509-529`. That loader is **not**
`isFlagEnabled`: it is a direct `.in([...])` select wrapped in try/catch
returning `{}` on error (`:526-528`), so an error and an absent row both resolve
to `undefined` → falsy. Fail-closed in effect.

**Shadow mode.** `DiscoveryRankingService.ts:1031`:
`const shadowMode = !flags["ACTIVITY_DISCOVERY_BOOST_ENABLED"];`
and at `:1265-1270`:

> in shadow mode "preserve original input order for eligible items" — eligible
> items are returned in **input order**, only ineligible items are moved to the end.

`rankItems` is the centralised ranking core for *every* feed surface — the
module header lists Pulse, Compass, Discovery, Search, Nearby, Stories, Events,
Trips, Profiles (`:3-5`). So **on production today the centralised ranking core
computes scores and then discards the ordering**: it reorders nothing, and the
four new boosts are zeroed (`:1154-1169`). Eligibility filtering still applies.
This is the designed state, not a defect — `:12-14` and `:973-976` describe it —
but it means "the boost flags are off" understates it: ranking itself is inert.

| flag | polarity | gates | prod | why off | to turn on |
|---|---|---|---|---|---|
| `ACTIVITY_DISCOVERY_BOOST_ENABLED` | capability | **(a)** the shadow-mode switch — off ⇒ `rankItems` returns input order and zeroes the activity boost (`DiscoveryRankingService.ts:1031`, `:1154-1157`, `:1265-1270`), and suppresses the `ACTIVITY_BOOST_APPLIED/CAPPED` analytics writes (`:1235-1246`). **(b)** a background job: `lib/creatorActivityScoreScheduler.ts:95-121` is a no-op per tick when off, so `creator_activity_scores` is never populated. READ-ordering + background job. | `false` | no stated reason found. Seeded by `2084:55` as a repo↔production reconciliation (`2084:28-31`), not a decision. The code calls the flip *"B3, gated, and not this code's to propose"* (`DiscoveryRankingService.ts:381`) — i.e. an owner decision exists upstream but its text is not in this repo. | `DECISION`. *Question*: should the hosted deployment rank feeds, or keep chronological/caller order? *Recommended default*: **turn it on**, because leaving it off means every feed in the testing deployment is unranked and the three dependent boost flags cannot be tested at all. Caveat to state plainly: `creator_activity_scores` starts empty, so the activity boost is 0 for every creator until the scheduler has run — the cold-start history is at `creatorActivityScoreScheduler.ts:20-30`. |
| `NEW_CONTRIBUTOR_BOOST_ENABLED` | capability | score component only: `!shadowMode && flag` (`:1033`), applied at `:1159-1161` | `false` | no stated reason found (`2084:59` describes, does not justify) | `FLAG FLIP ONLY`, **but inert unless `ACTIVITY_DISCOVERY_BOOST_ENABLED` is also on** |
| `RETURNING_USER_BOOST_ENABLED` | capability | `:1034`, applied `:1163-1165` | `false` | no stated reason found (`2084:62`) | `FLAG FLIP ONLY`; same dependency |
| `UNDEREXPOSED_CONTENT_BOOST_ENABLED` | capability | `:1035`, applied `:1167-1169`; also gates whether the underexposure status map is loaded at all (`:1050`) | `false` | no stated reason found (`2084:63`) | `FLAG FLIP ONLY`; same dependency |
| `RANKING_EXPERIMENT_ENABLED` | capability | a WRITE, and the **only one of the five not shadow-gated**: `:1032`, used at `:1257-1259` to write sampled score breakdowns to `ranking_debug_samples`. Also read by the admin surface `routes/adminRankingMetrics.ts:344` / `:415` to report its state. | `false` | no stated reason found (`2084:61`) | `MIGRATION` — see below. |

**`RANKING_EXPERIMENT_ENABLED` is the one with a schema question.** Its sink table
comes from `src/migrations/2060_ranking_debug_samples.sql`, and
`src/migrations/3421_ranking_debug_samples_content_id_nullable.sql` relaxes a
NOT NULL on `content_id`. 2060 is below the applied-record's 2460 floor and 3421
is above its 2971 ceiling, so **`production-applied-migrations.json` cannot
answer whether either is applied, and I could not establish it from the
repository.** 3421 being on `main` and after the record's newest entry is
consistent with "not applied", but I am not asserting it. **This check could not
establish its result and must be run against production before the flag is
flipped** — a `content_id`-NOT-NULL table would make `writeSampleAsync` fail for
every sample with a null content id. Dependency: useful only with
`ACTIVITY_DISCOVERY_BOOST_ENABLED` on, since in shadow mode the sampled scores
describe an ordering nothing uses.

**Depends on (all five)**: `ranking_config` weights/penalties/activity params are
read per call (`:1037-1049`) with hardcoded fallbacks, so no flag depends on that
table existing.

---

### 6. The media-feed boost flags

All eight are loaded by `loadMediaRankingFlags`,
`services/ranking/MediaFeedRankingService.ts:869-911` — again a direct
`.in([...])` select, `catch { }` returning all-false defaults (`:874-881`,
`:909`). Fail-closed.

**Parent flag.** `MEDIA_RANKING_ENABLED` is `false` in production and is the
master: `MediaFeedRankingService.ts:647-656` returns the candidates in
**chronological order with `finalScore: 0`** and `reasonCodes: ["recency"]` when
it is off. Every flag in this table is therefore inert today regardless of its own
value. `MEDIA_RANKING_ENABLED` itself is not in my domain — it belongs to the
media/ranking section — but **no flag below can be tested without it**, and that
is the single dependency to carry into the rollout.

| flag | polarity | gates (all READ-ordering, score components) | prod | why off | to turn on |
|---|---|---|---|---|---|
| `MEDIA_ACTIVE_CREATOR_BOOST_ENABLED` | capability | `MediaFeedRankingService.ts:722-728` — diminishing-returns boost from `creatorWeeklyPostCount` | `false` | stated, and it is a design default not a problem: `src/migrations/2040_media_ranking_boost_flags.sql:2-4` — *"all default false so the service runs in base-score-only mode until operators enable boosts. Gated independently so individual boosts can be A/B tested."* | `FLAG FLIP ONLY`; needs `MEDIA_RANKING_ENABLED` |
| `MEDIA_NEW_CREATOR_BOOST_ENABLED` | capability | `:731-743` | `false` | same (`2040:9-10`) | `FLAG FLIP ONLY`; same dependency |
| `MEDIA_RETURNING_CREATOR_BOOST_ENABLED` | capability | `:746-753`, needs `item.creatorLastPostAt` | `false` | same (`2040:11-12`) | `FLAG FLIP ONLY`; same dependency |
| `MEDIA_UNDEREXPOSED_BOOST_ENABLED` | capability | `:768-775` | `false` | same (`2040:13-14`) | `FLAG FLIP ONLY`; same dependency |
| `MEDIA_CREATOR_FATIGUE_ENABLED` | capability | `:705-718` — per-viewer per-session fatigue **penalty** from in-memory `sessionState.creatorImpressions`. Distinct from `CREATOR_FATIGUE_ENABLED` (§4), which writes a table. | `false` | same (`2040:15-16`); re-seeded by `2085_converge_absent_seeded_flags.sql:66` | `FLAG FLIP ONLY`; same dependency |
| `PORTAVA_PUBLISHER_BOOST_ENABLED` | capability | two readers: `MediaFeedRankingService.ts:667` (passed into `scoreCandidate` as the publisher-boost switch) and `:509` (exempts `isOfficialPublisher` items from per-creator frequency caps); plus `routes/pulse.ts:566` via `isFlagEnabled` | **row absent** | `src/migrations/2300_phantom_feature_flag_rows.sql:49-58` states it: a seed exists only in `artifacts/api-server/supabase/migrations/20260809_portava_publisher_boost_flag.sql`, which is a **frozen, never-applied archival tree** (`src/scripts/frozenMigrationRoots.ts`) — *"A seed in a directory nothing runs is not a seed."* | **`MIGRATION`** — `2300_phantom_feature_flag_rows.sql`. Not in `production-applied-migrations.json`; and because `prod-sorted.txt` shows no row for either PORTAVA flag, 2300 is demonstrably unapplied. 2300 seeds both **false** (postcondition at `2300:156-167` *fails* if any of its five rows is TRUE), so the apply creates the row and a second flag flip is then needed. |
| `PORTAVA_FEATURED_BOOST_ENABLED` | capability | `MediaFeedRankingService.ts:756-766` — 1.4× multiplier for 7 days after `featuredAt` (`FEATURED_BOOST_MULTIPLIER`/`_WINDOW_MS` at `:52-55`) | **row absent** | `2300:60-63`: *"Never seeded anywhere at all."* | **`MIGRATION`** — same file, same note |

---

### 7. The trust flags — all three already ON

| flag | polarity | gates | prod | why | to turn on |
|---|---|---|---|---|---|
| `trust_engine_enabled` | capability | `services/trust/TrustEventService.ts:89-109` (`isTrustEnabled`, exported so the scheduler uses the identical gate — `:82-88`). Off ⇒ every trust emitter returns `flag_off` and the trust ledger is silent. Also gates `lib/trustMaintenanceScheduler.ts:37` (background job, fail-closed), `services/location/LocationSafetyService.ts:8`, `lib/intelScopedTrustApply.ts:199`, `index.ts:327`. Custom reader, **not** `isFlagEnabled`: a read error logs and returns false (`:101-105`) — fail-closed but never silent. | **`true`** | already on. Schema prerequisite 2371 is applied (`checkFlagSchemaPrerequisites.ts:264`; `2371_trust_profiles_evidence` present in `production-applied-migrations.json`) | `FLAG FLIP ONLY` — **nothing to do**. One thing to expect, stated by the code: `services/trust/TrustScoreService.ts:575` and `TrustEventService.ts:522` describe backfill behaviour on a *first* enable; that already happened, so hosted testing inherits a live engine. |
| `trust_gaming_detection_enabled` | capability | `services/trust/TrustGamingDetectionService.ts:55-66` (`isGamingDetectionEnabled`). Off ⇒ no `trust_reviews` rows of type `gaming_suspected` are created (`:68-85`) and `trustMaintenanceScheduler.ts:763` self-skips its scan. A WRITE plus a background job. Custom reader; read error ⇒ treated as disabled (`:62-65`), i.e. fail-closed. | **`true`** | already on | `FLAG FLIP ONLY` — **nothing to do**. Worth flagging to Chelsi only as an expectation: synthetic accounts doing scripted check-ins can trip the cluster/rapid-jump heuristics (defaults at `TrustGamingDetectionService.ts:46-47`: cluster limit 5, mutual-rate 0.80, rapid-jump 20 points, overridable per-row in `trust_settings`), producing open gaming reviews during testing. Those are admin-visible rows, not blocks. |
| `events_trust_gates_enabled` | **capability by name, inverted by failure semantics** — and this is the subtlety | `routes/events.ts:6969-6972` (`eventTrustGatesRun`). Reads **three-state** via `readFlagState`, not `isFlagEnabled`, and returns true for `"on"` **and** `"unreadable"`. The reason is documented at `events.ts:6956-6968`: read through `isFlagEnabled`, a *failed read* answered false, which means "skip the gates", and *"a failed flag read listed 18+ events to verified minors, seated them on waitlists and let them RSVP."* So `off` and `absent` skip the gates exactly as before; `unreadable` now **runs** them. Gates the verified/trust/age viewer checks on event listing, waitlist seating and RSVP (`checkEventEligibility`, used by `eligibleWaitlisted` at `events.ts:6996-7006`). READ + WRITE. | **`true`** | already on | `FLAG FLIP ONLY` — **nothing to do, and do not turn it off.** Turning it off in a testing deployment would disable age and trust gating on events, which is the exact failure `events.ts:6961-6963` records. If a synthetic tester is blocked from an event, the fix is the test account's verification level, not this flag. |

Note on duplicate trees: `files/artifacts/api-server/src/routes/events.ts` and
`portava-stamp-wave2-files/artifacts/api-server/src/routes/events.ts` also contain
`events_trust_gates_enabled` reads (at `:380`, `:723`, `:2445`/`:2476`) through the
**old** `isFlagEnabled` form. Those are not the shipping tree — the shipping
reader is `artifacts/api-server/src/routes/events.ts:6971`. I note them only so a
later grep does not mistake them for live gates.

---

### 8. Consolidated labels

| item | label |
|---|---|
| `rent_buddy_enabled` → true | **DECISION** (same decision as C-11 §5; one flip, not two) |
| `creator_attribution_enabled` | **MIGRATION** — C-11's ordered set, **OWNED BY C-11** |
| `rent_buddy_allow_bookings_without_kyc` / Stripe Identity sandbox | **CONFIG** + **DECISION**, **OWNED BY C-11** (their §6 Route A/B) |
| `RENT_BUDDY_MVP_MODE`, `_ADMIN_ONLY_MODE`, `_BETA_ONLY_MODE` | FLAG FLIP ONLY — leave false |
| `RENT_BUDDY_GROUP_BOOKINGS/_PACKAGES/_OFFERS/_NIGHTLIFE_ENABLED` | FLAG FLIP ONLY — already true; first three inert while MVP_MODE is false |
| `disable_rent_buddy_booking`, `disable_rab_bookings` | FLAG FLIP ONLY — leave both false |
| `ACTIVITY_DISCOVERY_BOOST_ENABLED` → true | **DECISION** |
| `NEW_CONTRIBUTOR_BOOST_ENABLED`, `RETURNING_USER_BOOST_ENABLED`, `UNDEREXPOSED_CONTENT_BOOST_ENABLED`, `CREATOR_FATIGUE_ENABLED` | FLAG FLIP ONLY, inert without the boost master |
| `RANKING_EXPERIMENT_ENABLED` | **MIGRATION** (2060 / 3421 state unverifiable offline — must be checked against production) |
| the five `MEDIA_*` boost/fatigue flags | FLAG FLIP ONLY, inert without `MEDIA_RANKING_ENABLED` (other domain) |
| `PORTAVA_PUBLISHER_BOOST_ENABLED`, `PORTAVA_FEATURED_BOOST_ENABLED` | **MIGRATION** — `2300_phantom_feature_flag_rows.sql`, unapplied; seeds both false, so a flip follows |
| `trust_engine_enabled`, `trust_gaming_detection_enabled`, `events_trust_gates_enabled` | FLAG FLIP ONLY — already true, nothing to do |

### 9. What I could not establish

* Whether `2060_ranking_debug_samples.sql` and
  `3421_ranking_debug_samples_content_id_nullable.sql` are applied to production.
  `production-applied-migrations.json` covers only `2460_…`–`2971_…`. Not guessed.
* When, by whom, or why the four `RENT_BUDDY_*` sub-flags were toggled TRUE in
  production against their `0090` seed of FALSE. No record found in migrations or
  `docs/`.
* Any stated reason for the six discovery/fatigue ranking flags being false.
  `2084` is explicitly a reconciliation of the repository to production's existing
  values, not a decision record, and the one pointer the code gives
  (`DiscoveryRankingService.ts:381`, "B3") names a document not in this repo.
## 04 — Discovery & Compass

Domain: every flag named `discovery_*` / `DISCOVERY_*` / `compass_*` / `COMPASS_*`,
plus `disable_discovery_pde`, `opportunity_engine_enabled`,
`hidden_gems_compass_enabled`, `wall_compass_handoff_enabled`,
`map_compass_commands_enabled`, `neighborhood_match_enabled`,
`nl_trip_creation_enabled`.

Production values are from `prod-sorted.txt` (capture 2026-10-03). A name not in
that file has **no row at all**, which `isFlagEnabled` treats as false
(fail-closed) and `isKillSwitchEngaged` treats as *not engaged*.

### 0. Headline counts

| | count |
|---|---|
| Boolean flags in domain, **row present** in production | 26 |
| Boolean flags in domain, **row absent** (never seeded into prod) | 39 |
| Boolean flags **formally retired** by migration 2080 (row deleted, no reader) | 6 |
| Boolean flags **read in code but never seeded by any migration** | 4 + the `COMPASS_<TYPE>_SAFETY_BLOCK` family (11 names) |
| Non-boolean config values (table `metadata` or env var) | 11 |

The 39 absent rows are almost entirely the §78/§79/§81/§84/§85/§86/§91/§94/§95
Discovery pipeline lanes, migrations **3366–3500**. The repository's own record of
what has been applied to production
(`artifacts/api-server/src/lib/capability/production-applied-migrations.json`)
ends at `2971_layover_discovery_mode_flag` (version `20260922155706`) and
contains **no migration numbered 3xxx**. So every one of those flags needs its
migration applied before it can even be flipped.

---

### 1. What a hosted tester can actually reach today

#### Discovery/Compass surfaces that are LIVE in production

| surface | gate flags (all true in prod) |
|---|---|
| Compass feed / recommendations | `COMPASS_ENABLED=1`, `COMPASS_FEED_ENABLED=1` |
| Compass ordering of the Discovery `for_you` tab | `COMPASS_V1_RULE_BASED_ENABLED=1` |
| Compass diversity reordering within sections | `COMPASS_DIVERSITY_ENABLED=1` |
| Fair-exposure boost for new verified users/buddies | `COMPASS_FAIR_EXPOSURE_ENABLED=1` |
| Compass hidden-gem context + location context | `hidden_gems_compass_enabled=1`, `compass_location_context_enabled=1` |
| Map Compass commands (`/api/map/search` command mode) | `map_compass_commands_enabled=1` |
| Neighborhood match | `neighborhood_match_enabled=1` |
| Natural-language trip draft creation | `nl_trip_creation_enabled=1` |
| Discovery serve-log telemetry (writes `rank_events` / `recommendations`) | `discovery_serve_log_enabled=1` |

#### Discovery/Compass surfaces that are DARK in production

| surface | flag | prod |
|---|---|---|
| `GET /api/compass/decision` (GO NOW / WAIT / SWITCH / …) | `compass_decision_enabled` | false |
| `GET /api/intel/opportunities` (Opportunity engine) | `opportunity_engine_enabled` | false |
| Ask-Compass handoff on Wall objects | `wall_compass_handoff_enabled` | false (and parent `wall_enabled=0`) |
| AI-assisted writing / Compass prompt continuation | `compass_ai_writing_enabled` | false |
| `GET /v1/discovery/recommendations/{trails,shared_moments,emerging_discoveries}` | `discovery_output_kinds_enabled` | **row absent** |
| `GET /api/discovery/trending` + trend lists | `discovery_trending_api_enabled`, `discovery_trend_lists_enabled` | **row absent** |
| PDE-ordered `for_you` page (the new ranking pipeline) | `discovery_for_you_pde_enabled` + `DISCOVERY_ENGINE_MODE` | absent / false |
| Live-rank "why now" grades on discovery rows | `discovery_live_rank_enabled` | **row absent** |
| Discovery candidate projection on the map | `discovery_candidate_projection_enabled` | false |
| Trail exploration / health-ordered Trails | `discovery_trail_exploration_enabled`, `discovery_trail_health_order_enabled` | **row absent** |
| Dwell telemetry (client measurement + write) | `discovery_dwell_telemetry_enabled` | **row absent** |
| Compass Journey engine (shadow) | `COMPASS_JOURNEY_*` (3 flags) | false |
| Compass degraded/fallback feed | `COMPASS_FALLBACK_MODE_ENABLED` | false |
| Creator/topic diversity caps across the ranked feed | `DISCOVERY_DIVERSITY_ENABLED` | false |

**Short answer for Chelsi:** the Compass feed, Compass AI recommendations,
hidden-gem context, map commands, neighborhood match and NL trip drafts are all
reachable today. Everything built in the Discovery "census" lanes (the new PDE
ranking pipeline, trending, trail exploration, output-kind recommendation
routes, dwell telemetry) is dark and **cannot be reached by a flag flip** —
those flags have no row because their migrations are not applied.

---

### 2. User-visible surfaces — full detail

#### 2.1 `compass_decision_enabled` — capability

**Gates** a READ-only route. `routes/compassDecision.ts:63` —
`if (!(await isFlagEnabled(sc, "compass_decision_enabled")))` → `feature_disabled`.
Engine is `lib/compassDecisionAssembly.ts:29` / `lib/compassDecision.ts`. With it
off there is no GO NOW / GO SOON / WAIT / STAY / SWITCH / SKIP / RETURN answer for
a place anywhere in the app.

**Production value:** `false` (row present).

**Why off:** `src/migrations/2800_compass_decision_flag.sql:18-22` —
*"Seeded FALSE. … Enabling is an owner decision — it opens a new user-facing
surface — and the postcondition below refuses to commit this file if the row
reads TRUE."* Same file :10-16 notes it reads only baseline tables already in
production.

**To turn on for hosted testing:** `DECISION` — *should a hosted tester see the
seven-verdict Compass decision surface, given its verdicts are derived from live
claims that the Live gates may refuse?* **Recommended: yes, turn it on.** The
migration is applied, the row exists, all its tables are in production, and the
route is read-only; with the Live gates closed it degrades to `WAIT` with a
stated reason rather than inventing a `GO` (2800:14-16). The only thing standing
in the way is that the migration's author deliberately left the choice to the
owner.

**Depends on:** nothing hard. Quality of answer depends on the Live Places
flag hierarchy (`live_places_enabled=1`, `intel_limited_live=1` in prod).

---

#### 2.2 `opportunity_engine_enabled` — capability

**Gates** a READ-only route: `routes/opportunities.ts:116` → `feature_disabled`.
Flag constant at `routes/opportunities.ts:63`. Also consulted as a *platform*
flag inside Compass Ask: `routes/compass.ts:1824` —
`if (askKernel && (await isPlatformFlagEnabled(sc, "opportunity_engine_enabled")))`,
so with it off the Compass Ask kernel does not run the Opportunity stage either.

**Production value:** `false` (row present; migration 2840 applied
`20260920195237`).

**Why off:** `src/migrations/2840_opportunity_engine_flag.sql:26-29` —
*"Seeded FALSE. Read fail-closed … Enabling is an owner decision — it opens a new
user-facing surface — and the postcondition below refuses to commit this file if
the row reads TRUE."* The same header (:11-18) records that it writes nothing and
reads only tables already present in production.

**To turn on for hosted testing:** `DECISION` — *does hosted testing want the
`/api/intel/opportunities` surface and the Compass-Ask Opportunity stage?*
**Recommended: yes.** Read-only, no new tables, no new provider; with the Live
gates closed every subject is refused `live_intelligence_unavailable` rather than
fabricated (2840:14-18).

**Depends on:** the Live gates for useful output (not for the route to answer
200).

---

#### 2.3 `compass_ai_writing_enabled` — capability

**Gates** the AI suggestion arm of the input-assistance gateway. Chokepoint:
`lib/inputAssistance/aiWriting.ts:88` (`isCompassAiWritingEnabled`), consumed at
`lib/inputAssistance/gateway.ts:721-737`. OFF ⇒ no `ai_suggestion` row is added
for caption / event title / event description / trip title / plan title /
`compass_prompt`; the deterministic assistance is unaffected
(`gateway.ts:710-717` "degrade-to-no-AI"). UI-visible, no write.

**Production value:** `false` (row present; migration 2221 applied
`20260921105203`).

**Why off:** `src/migrations/2221_compass_ai_writing_default_off.sql:18-27` —
*"the capability itself must be opt-in and OFF until an administrator turns it on
(the standing 'independent-purpose gate for a safety-sensitive feature'
policy)."*

**To turn on for hosted testing:** `CONFIG` — the gateway comment at
`lib/inputAssistance/gateway.ts:712` states the path requires *"an available
model"* via `getOpenAI → gpt-5-mini`, and `lib/openai.ts:4` reads
`process.env.AI_INTEGRATIONS_OPENAI_API_KEY`. Chelsi must supply that secret in
the hosted deployment; with the flag on and the key missing the arm silently
yields no suggestions (`.catch(() => [])` at `gateway.ts:723`).

**Depends on:** not `compass_ai_enabled` — 2221:9-16 deliberately keeps the two
independent.

---

#### 2.4 `wall_compass_handoff_enabled` — capability

**Gates** the Ask-Compass action on a place-linked Wall object.
`routes/wall.ts:982` reads it; `services/wall/WallProjectionService.buildActions`
is the consumer, and `services/wall/ContextThreadService.ts:261` gates the
Compass candidate reader behind the same name. UI only (it adds an action), plus
the Context-Thread Compass candidate READ.

**Production value:** `false`.

**Why off:** `src/migrations/2270_wall_feature_flags.sql:67` —
*"OFF: no Ask-Compass action on Wall objects."* Header :26-30 —
*"RUNTIME EFFECT: NONE. With wall_enabled = false the /wall routes short-circuit
… Nothing is served to any user until the owner presses wall_enabled."*

**To turn on for hosted testing:** `FLAG FLIP ONLY` **after its parent** — but it
is inert on its own.

**Depends on:** `wall_enabled` (prod `0`). This belongs to the Wall domain's
decision, not Discovery's.

---

#### 2.5 `discovery_output_kinds_enabled` — capability

**Gates** three READ routes: `GET /v1/discovery/recommendations/trails`,
`/shared_moments`, `/emerging_discoveries`.
`routes/discoveryOutputKinds.ts:65-67` → `feature_disabled` (404), and
`:69` applies the Discovery stop separately so an engaged stop produces exactly
the flag-off 404. The flag is also one of the eight §85 pipeline flags
(`lib/discoveryCandidates/pipelineFlags.ts:39`). Also enables a serve-log write
(serve point 13) when on.

**Production value:** **row absent**.

**Why off:** `src/migrations/3483_discovery_pipeline_stages_flags.sql` seeds it
FALSE; `lib/discoveryCandidates/pipelineFlags.ts:4-6` — *"Eight NEW flags, each
seeded FALSE by a migration in 3480–3484, each read fail-closed. With all eight
off `rankForViewer`'s output is byte-identical to the tree before §85."*

**To turn on for hosted testing:** `MIGRATION` — apply
`3483_discovery_pipeline_stages_flags.sql`. **Production does not have it**
(no 3xxx entry in `production-applied-migrations.json`). Note `routes/discoveryOutputKinds.ts:22-26`
says the serve-log widening needs **3491** too, and `3476`/`3487`/`3488` back the
Trail and moment reads. This is a migration *train*, not one file.

**Depends on:** `discovery_serve_log_enabled` (on, for the impression write);
the Discovery stop (`disable_discovery_pde` not engaged, and no §12 stop
condition tripped — `lib/discoveryStopGate.ts:72-95`).

---

#### 2.6 `discovery_trending_api_enabled` + `discovery_trend_lists_enabled` — capabilities

**Gates** the trend-explanation READ API. `routes/discoveryTrending.ts:53`
gates the single-place endpoint; `:99` gates the list endpoint behind **both**
flags. Constants: `lib/discoveryTrendExplanation.ts:62` and `:394`.

**Production value:** both **row absent**.

**Why off:** `routes/discoveryTrending.ts:23` — *"Behind
`discovery_trending_api_enabled` (3410, seeded FALSE; read per request…)"*.
`discovery_trend_lists_enabled` is seeded FALSE by
`3475_discovery_trend_v2_flags.sql`.

**To turn on for hosted testing:** `MIGRATION` — apply `3410` and `3475`;
neither is in `production-applied-migrations.json`. The list endpoint is further
empty without the v2 trend model, which needs `3475` + `3476` + `3477` (see the
internal table below) — and `checkProductionDrift.ts:908` classifies
`area_momentum` (3476) as **unapplied**, *"Rehearsed on the local PostgreSQL
harness only; applied to no Supabase project."*

**Depends on:** `discovery_trend_normalised_enabled` and
`discovery_trend_rebuild_scheduler_enabled` for non-empty lists.

---

#### 2.7 `discovery_for_you_pde_enabled` + `discovery_cache_a_ranked_enabled` — capabilities

**Gates** which engine orders what a signed-in user sees on `GET /discovery`.
`lib/discoveryOnePipeline.ts:55-58` (`forYouPdeEnabled`) and `:60+`
(`cacheARankedEnabled`). ON, a `for_you` page is ordered by
`lib/discoveryPde.rankForViewer` and Compass only decides eligibility; OFF, serve
points 4/5 are the Compass order replayed from Cache B
(`lib/discoveryOnePipeline.ts:4-23`). This is a READ that changes the order of a
real user's feed.

**Production value:** both **row absent**.

**Why off:** `lib/discoveryOnePipeline.ts:25-30` — *"Turning either on changes
the order a real user is served, so that is the owner's decision (Phase F gate 2;
register entry D-W10R4-2). Nothing here turns anything on."*

**To turn on for hosted testing:** `MIGRATION` then `DECISION`. Apply `3455`
and `3456` (neither in `production-applied-migrations.json`); then the owner
decision is *do we want hosted testers to see the PDE order rather than the
Compass order on `for_you`?* **Recommended default: leave OFF for the first
hosted pass.** The brief's goal is "full functionality reachable", and `for_you`
already renders under `COMPASS_V1_RULE_BASED_ENABLED=1`; flipping the ranker
changes the content of a working surface rather than opening a closed one, and
its own designers made it a gated owner call.

**Depends on:** `DISCOVERY_ENGINE_MODE` is *not* required for
`discovery_for_you_pde_enabled` (it governs the serve path above the cache fork
independently), but the Discovery stop gate applies to both
(`discoveryOnePipeline.ts:31`, `discoveryStopGate.ts:97-100`).

---

#### 2.8 `DISCOVERY_ENGINE_MODE` — capability flag **carrying a config value**

**Gates** which discovery execution path handles a request, resolved above the
Cache A fork. Resolver `lib/discoveryEngineMode.ts:247-369`
(`resolveDiscoveryEngineMode` / `resolveUncached`); flag name constant at
`:67`. `enabled` is the master switch, `metadata.mode` selects
`legacy | shadow | pde` (aliases `off`/`on` accepted —
`lib/discoveryEngineMode.ts:128-134`). Every failure resolves to `legacy`
(`:219-221`, `:363-368`).

**Production value:** `false`. Row present (seeded by
`2091_discovery_engine_mode_flags.sql:70-73` with
`metadata = {"mode":"legacy", …}`). I could not read production's current
`metadata` — `prod-sorted.txt` carries only `enabled` — but with `enabled=false`
the resolver returns `LEGACY("flag_disabled")` at `:265` before metadata is
read, so the mode value is moot today.

**Why off:** `2091:34-36` — *"⚠ `shadow` computes a second result per request and
writes observations; it changes nothing a user receives. `pde` CHANGES WHAT USERS
ARE SERVED and is the owner's call, not the operator's."* `2091:61-68`:
*"NEITHER ROW CHANGES BEHAVIOUR."*

**To turn on for hosted testing:** `DECISION` — *for hosted testing, do we leave
discovery on `legacy`, move it to `shadow`/`compare` (observation only), or to
`pde`/`partial` (changes what testers see)?* **Recommended: `shadow`.** It is the
only setting that produces the old-vs-new comparison data the flag exists for
while leaving every served order byte-identical, and the row + migration are
already in production so it costs one UPDATE. `pde` additionally needs the
3xxx migrations for anything new to be in the ranker.

**Depends on:** `pde` additionally requires `disable_discovery_pde` not engaged
(`discoveryEngineMode.ts:284-291`) and no tripped §12 stop condition (`:320-330`).
`partial` is **refused** over `cohort.kind="all"` (`:349-356`).

---

#### 2.9 `disable_discovery_pde` — **KILL SWITCH** (inverted polarity)

**Gates** the PDE path and, via `lib/discoveryStopGate.ts:83`, every §78/§79/§85
rollout flag: when engaged, a flag that reads ON is served as OFF
(`discoveryStopGate.ts:88-95`; `pipelineFlags.ts:113-115`;
`discoveryRankFlags.ts:98-100`; `discoveryOnePipeline.ts:57`).

**Production value:** `false` — **not engaged** (row present).

**Why off / why that is correct:** `2091:39-45` — *"Read through
isKillSwitchEngaged … whose FAILURE polarity is inverted on purpose: a genuine
error ENGAGES the stop. A switch that disengages precisely when the database is
unhealthy is not a kill switch."*

**To turn on for hosted testing:** `FLAG FLIP ONLY` — and the correct action is
to **leave it false**. It must stay disengaged for any PDE work to run. Engaging
it is the rollback lever, `2091:58`:
`UPDATE feature_flags SET enabled = true WHERE flag = 'disable_discovery_pde';`

**Depends on:** consulted only when `DISCOVERY_ENGINE_MODE` resolves to `pde`
(mode path) or when a rollout flag reads ON (stop-gate path).

---

#### 2.10 `discovery_candidate_projection_enabled` — capability

**Gates** the Discovery candidate projection served on the map:
`routes/mapProjection.ts:1376` (`candidateFlagOn = await isFlagEnabled(sc,
"discovery_candidate_projection_enabled")`), name pinned at `:1503`; builder
constant `lib/discoveryCandidate.ts:139`. A READ that adds `whyNow` /
`whyForUser` / truth-class fields to map rows.

**Production value:** `false` (row present).

**Why off:** `lib/discoveryCandidate.ts:120-126` states the historical reason and
is now **stale**: *"measured read-only against production on 2026-09-15, the flag
row `discovery_candidate_projection_enabled` DOES NOT EXIST there at all … Migration
2361 is applied to no production database, so this projection is dark for every
real user, and §6 D9's mapping defaults are still unratified."* Both halves have
since changed: `production-applied-migrations.json` lists
`2361_discovery_candidate_projection_flag` at version `20260915082108`, and the
2026-10-03 capture shows the row present at `false`.

**To turn on for hosted testing:** `DECISION` — *are §6 D9's truth-class mapping
defaults ratified enough to show `whyNow` labels to hosted testers?* The code
comment says they were not as of 2026-09-15 and I found no later ratification.
**Recommended: turn it on for hosted testing but not beyond**, since hosted
testing is precisely the setting where an unratified label can be reviewed
before any public user sees it. `CODE` cleanup is also owed: the comment block
at `discoveryCandidate.ts:120-126` now asserts a false fact about production and
should be corrected.

**Depends on:** `discovery_live_rank_enabled` for the `whyNow` grades to be
non-null (`lib/discoveryLiveRankRead.ts:45`) — and that flag has **no row**.

---

#### 2.11 `discovery_trip_projection_enabled` — capability + **schema** gate

**Gates** Discovery's consumer of the Trip-owned discovery projection.
Constant `lib/discoveryTripProjectionConsumer.ts:96`. The gate is
`FLAG_ENABLED && SCHEMA_CAPABILITY_READY` (same file, header lines 28-30), probed
through `lib/capability/schemaCapability.probeSchemaReadiness`.

**Production value:** `false` (row present; 2550 applied `20260908023317`).

**Why off:** `lib/discoveryTripProjectionConsumer.ts:15-28` — the projection
names `trips.version` (migration 2420) and *"Production
(ajrurzioarfkagpuxfnb), measured 2026-09-07: trips.version does NOT exist (2420
unapplied) … With a bare flag, 2420 turns every trips and plans search into `[]`."*
That measurement is now out of date: `production-applied-migrations.json` lists
`2420_trip_kernel_foundation`, so the schema prerequisite should now be
satisfied. **I verified this from the repository's record only, not from the live
database.**

**To turn on for hosted testing:** `FLAG FLIP ONLY`, conditional — flip it and
then confirm the capability probe reports ready. If the probe refuses, it is
`MIGRATION` (2420). Because the capability contract fails closed to the legacy
`trips` read, a flip that finds the schema missing degrades rather than emptying
the search.

**Depends on:** `trips.version` (migration 2420).

---

#### 2.12 `hidden_gems_compass_enabled` — capability (LIVE)

**Gates** the hidden-gem READ inside Compass context.
`services/hiddenGems/CompassHiddenGemService.ts:50` and
`services/location/CompassLocationContext.ts:101` each read the row directly
(`.eq("flag", "hidden_gems_compass_enabled")`). Both fail closed via a value
initialised *before* the try —
`check-flag-polarity.mjs:1315-1316` records this:
*"fail-closed via the `empty` context object built before the try"* /
*"fail-closed via `hiddenGems` initialized to [] before the try."*

**Production value:** `true`. Seeded by `0043_hidden_gems.sql` /
`0166_feature_flags_reconcile.sql`.

**Why off:** not off. **To turn on:** already on. **Depends on:**
`hidden_gems_enabled=1` (on).

---

#### 2.13 `compass_location_context_enabled` — capability (LIVE)

**Gates** the Compass location context attached to Telegraph.
`routes/telegraph.ts:107` reads the row directly.
`check-flag-polarity.mjs:1314`: *"Read directly, error branch … catch is
`/* non-fatal */`. Fail-closed comes from `compassCtx` initialized null before
the try — degrades to no location context."*

**Production value:** `true` (seeded `0037_feature_flags.sql` /
`0166_feature_flags_reconcile.sql`). Already on.

---

#### 2.14 `map_compass_commands_enabled`, `neighborhood_match_enabled`, `nl_trip_creation_enabled` — capabilities (all LIVE)

| flag | gate site | prod | note |
|---|---|---|---|
| `map_compass_commands_enabled` | `routes/mapSearch.ts:304` → route answers `{ enabled: false }` when off (`travel-buddy-standalone/src/services/mapCompassCommands.ts:19`). READ. | `true` | seeded `0188_map_search_flags.sql`. Depends on `map_search_enabled=1` (on). |
| `neighborhood_match_enabled` | `routes/neighborhoods.ts:33` (`const FLAG = …`). READ. | `true` | seeded `0173_neighborhood_areas.sql`. |
| `nl_trip_creation_enabled` | `routes/tripDraft.ts:75`. READ (extracts a trip DRAFT from free text). | `true` | seeded `0172_trip_reservations.sql`. |

All three: `FLAG FLIP ONLY`, already flipped. Nothing to do.

---

#### 2.15 `compass_ai_enabled` — capability (LIVE, but **inert**)

**Production value:** `true` (seeded `0117_beta_feature_flags.sql:27`, per
`check-flag-polarity.mjs:931` `kind: 'CAPABILITY'`).

**Gates:** nothing I could find. A repo-wide grep for the literal
`compass_ai_enabled` outside tests and scripts returns exactly one hit, a
*comment* at `lib/inputAssistance/aiWriting.ts:52` —
*"from `compass_ai_enabled` (the recommendation-engine capability, left
untouched)"*. The only other references are
`scripts/src/verify-db-beta-flags.mjs:37` (a beta-flag presence check) and
`check-flag-polarity.mjs:931`. 2221's header calls it the flag that
*"nominally gates"* the Compass AI recommendation engine — "nominally" is doing
real work in that sentence.

**To turn on for hosted testing:** nothing to turn on. `CODE` — this is the same
class of defect `2080_retire_inert_seeded_flags.sql:16-17` exists to remove
(*"keep a flag only on evidence of a LIVE READ"*). Either give the Compass
recommendation engine a real read of it or retire the row; an operator reading
the admin list today sees a control over Compass AI that gates nothing. I did
**not** verify whether the mobile app reads it through the public
`routes/featureFlags.ts` endpoint, so this should be confirmed before retiring.

---

### 3. Internal ranking / telemetry-only flags

These change no surface's existence — they change an order, a stage, or whether a
row is written. **Every one with "absent" below needs its migration applied
first**; none of the 3xxx migrations appear in
`production-applied-migrations.json`.

#### 3.1 Rows present in production

| flag | gates | prod | to turn on |
|---|---|---|---|
| `discovery_serve_log_enabled` | every WRITE in `lib/discoveryServeLog.ts` (`:58`; "Feature flag gating every write in this module. Absent row ⇒ disabled"). Feeds the §12 stop conditions via `recordServeLogOutcome`. | **true** | already on |
| `DISCOVERY_DIVERSITY_ENABLED` | creator/topic diversity caps across the ranked feed — `compass/CompassFeedBuilder.ts:522`, `:631`, `routes/pulse.ts:781`. Also read in the mobile tree (`2084:40-47` records an `APP_TREE_READS` entry). | false | `FLAG FLIP ONLY` (2084 applied; row present). No stated reason beyond 2084's "codify" purpose — *no stated reason found* for keeping it false. |
| `COMPASS_FALLBACK_MODE_ENABLED` | the degraded Compass feed — `compass/CompassFallbackFeedBuilder.ts:85` (direct row read). Seeded by `0051_compass_foundation.sql:167`. | false | `DECISION` — *do we want the degraded fallback feed available during hosted testing?* **Recommended: on.** It is the graceful-degradation path; with it off a Compass outage produces no feed at all. |
| `COMPASS_DIVERSITY_ENABLED` | Compass diversity reordering within sections (`0053_compass_feed_intelligence.sql:198`) | **true** | already on |
| `COMPASS_FAIR_EXPOSURE_ENABLED` | fair-exposure boost for new verified users/buddies (`0053:199`) | **true** | already on |
| `COMPASS_ACTIVE_REWARDS_ENABLED` | the active-user reward engine (`0053:200`) | **true** | already on — but see §5 on the singular/plural name split |
| `COMPASS_JOURNEY_ENGINE_ENABLED` | Journey engine | false | `DECISION` (Journey domain) |
| `COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED` | Journey observation ingest (telemetry WRITE) | false | `DECISION` (Journey domain) |
| `COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED` | Journey segmentation shadow computation | false | `DECISION` (Journey domain) |

The three Journey flags share one documented reason: all three are force-disabled
together by the global stop procedure in
`src/migrations/2976_journey_shadow_global_stop_delete_scope.sql:331-340`
(`UPDATE public.feature_flags SET enabled = false WHERE flag IN (…three…)`), which
also deactivates stages, revokes cohort assignments and deletes observations. I
found **no stated reason** for the current false state beyond that the stop exists
and the flags were never turned on; whether the stop was *invoked* in production
is not something the repository records.

#### 3.2 Rows absent — the §78 ranking designs (migrations 3450–3454)

Read together by `lib/discoveryRankFlags.ts:78-95` (`loadRankDesignFlags`), one
`getFlagRow` each, fail-closed, 30 s cache, and every one forced OFF while the
Discovery stop is engaged (`:98-100`).

| flag | gates | prod | to turn on |
|---|---|---|---|
| `discovery_surface_objectives_enabled` | DV-09 per-surface family weights (`discoveryRankFlags.ts:24`) | absent | `MIGRATION` 3450 |
| `discovery_engagement_integrity_enabled` | DV-12 `03` §12 detector on save evidence (`:25`) | absent | `MIGRATION` 3451 |
| `discovery_feature_families_enabled` | DC-13 `negative_feedback` + `exploration_value` terms; makes DRS negative-feedback inputs real (`:26`; consumer `services/ranking/DiscoveryRankingService.ts:1572-1573`) | absent | `MIGRATION` 3452 |
| `discovery_intent_term_enabled` | A18 explicit current intent above interests (`:27`) | absent | `MIGRATION` 3453 |
| `discovery_trip_match_enabled` | DV-18 the `trip_match` producer (`:28`) | absent | `MIGRATION` 3453 |
| `discovery_diversity_axes_enabled` | DV-54 place / geography / Trail / history axes (`:29`) | absent | `MIGRATION` 3454 |

#### 3.3 Rows absent — the §85 pipeline stages (migrations 3480–3484)

Read together in one query by `lib/discoveryCandidates/pipelineFlags.ts:80-108`.
Header (`:4-14`): *"Eight NEW flags, each seeded FALSE by a migration in
3480–3484, each read fail-closed. With all eight off `rankForViewer`'s output is
byte-identical to the tree before §85."*

| flag | gates | prod | to turn on |
|---|---|---|---|
| `discovery_candidate_sources_enabled` | DC-12 / DV-49 per-viewer retrievals (`pipelineFlags.ts:17`) | absent | `MIGRATION` 3480 |
| `discovery_circle_candidates_enabled` | circle mates' PUBLIC experiences as candidates (`:23`) | absent | `MIGRATION` 3480, then `DECISION`. The flag's own comment: *"A consent question the lane may not decide: seeded FALSE, and its register entry is APPROVAL REQUIRED (D-W10-R3-4)."* **Recommended: leave OFF.** It puts one tester's experiences in another's candidate set; consent is not a hosted-testing shortcut. |
| `discovery_exploration_inventory_enabled` | DV-53 / DC-11 reserved exploration inventory (`:25`) | absent | `MIGRATION` 3481 |
| `discovery_cold_start_enabled` | DV-55 cold start for a new viewer (`:27`) | absent | `MIGRATION` 3482. Worth noting for hosted testing: every hosted tester **is** a new viewer. |
| `discovery_integrity_stage_enabled` | DC-11 integrity checks, calls DV-12's detector (`:29`) | absent | `MIGRATION` 3483 |
| `discovery_outcome_learning_enabled` | DC-11 learn from outcomes (`:31`) | absent | `MIGRATION` 3483 |
| `discovery_output_kinds_enabled` | see §2.5 — user-visible | absent | `MIGRATION` 3483 |
| `compass_city_confidence_windowed_reads_enabled` | H-P21-4, the Compass city-confidence producer's windowed reads; PDE reads it to decide whether to look for provenance columns (`:37`, `compass/cityConfidenceWindowedReads.ts:44`) | absent | `MIGRATION` 3484 |

#### 3.4 Rows absent — everything else

| flag | gates | prod | to turn on |
|---|---|---|---|
| `discovery_ranking_modifiers_enabled` | the §7/§8 ranking modifiers: momentum, city confidence, Trail affinity, exploration governor — `lib/discoveryModifiers.ts:67`, consumed `lib/discoveryPde.ts:535`, `services/ranking/FeedSlotAllocator.ts:351`, `services/trails/TrailService.ts:1089`. OFF the module returns an inert record and *"logImpression writes the feature vector verbatim into `rank_events.features` against the viewer's user_id, so an OFF flag was still shaping per-user rows in production. The OFF path now stamps nothing"* (`discoveryModifiers.ts:49-56`). | absent | `MIGRATION` 2289 — and **2289 is not applied**: the row would exist otherwise, since 2084/2090/2091 rows from the same era do. |
| `discovery_live_rank_enabled` | live "why now" grades attached to the outgoing slice, never persisted — `lib/discoveryLiveRankRead.ts:45`; mobile mirror `travel-buddy-standalone/src/services/discovery.ts:267` | absent | `MIGRATION` 2850 (not applied — no row) |
| `discovery_buddy_launch_gate_enabled` | closes the Rent-a-Buddy launch leg in traveler search — `lib/inputAssistance/searchCandidates.ts:450`. Gate OFF ⇒ legacy, buddies unchanged; ON + `rent_buddy_enabled` false or unreadable ⇒ buddies withheld (`:435-442`) | absent | `MIGRATION` 2360 (not applied). Then `DECISION` with `rent_buddy_enabled`. |
| `discovery_cache_a_ranked_enabled` | see §2.7 | absent | `MIGRATION` 3456 |
| `discovery_search_protected_zones_enabled` | protected-zone classification in discovery search — `lib/discoverySearchProtection.ts:74`, cited at `routes/discoverySearch.ts:650` | absent | `MIGRATION` 3366 + `3460_discovery_search_protection_scope.sql` |
| `discovery_dwell_telemetry_enabled` | every dwell WRITE — `lib/discoveryDwell.ts:100`, client `travel-buddy-standalone/src/hooks/useDiscoveryDwell.ts:9` and `src/services/discoveryDwell.ts:44` | absent | `MIGRATION` 3395, then `DECISION`. `lib/discoveryDwellSkip.ts:57` states the blocker: *"dwell is collected only when discovery_dwell_telemetry_enabled (3395) is on, which waits on the owner's consent (B-1, register D-W10-O-9)."* **Recommended: leave OFF** unless hosted testers are told dwell is measured. |
| `discovery_stop_enforcement_enabled` | arms the §12 stop conditions — `lib/discoveryStopConditions.ts:558`. Arming additionally requires `metadata.values_version === "stop-values-2026-09-28.1"` (`:561-568`), so a bare `enabled: true` arms nothing | absent | `MIGRATION` 3470, then `CONFIG` of the metadata string (see §4) |
| `discovery_platform_graph_provenance_enabled` | provenance only — the bounded platform-coverage window on a graph reading (`lib/discoveryPlatformGraphProvenance.ts:57`). OFF ⇒ `{status:"platform_producer"}`, no snapshot read. *"Provenance only: nothing here is read back into a score or an order"* (`:48-49`) | absent | `MIGRATION` 3490 |
| `discovery_community_byline_canonical_enabled` | the canonical community byline on community discovery items — `routes/discovery.ts:3072` (read once per request, only when a byline will be built). UI text only | absent | `MIGRATION` 3490 |
| `discovery_trip_viewer_projections_enabled` | Discovery's two Trip-owned viewer projections: plan-item search and next-trip city — `lib/discoveryTripViewerConsumer.ts:31`. OFF each site takes its legacy arm *byte-identical*; ON the next-trip city can change because Trips counts joined trips (`:22-25`) | absent | `MIGRATION` 3467, then `DECISION` — the §57.10 Q3 decision is *the reason for the flag* (`:25`) |
| `discovery_place_cooccurrence_enabled` | the Trail-derived place co-occurrence projection, both its rebuild and its read — `lib/discoveryPlaceCooccurrence.ts:40`, `:111` | absent | `MIGRATION` 3495 (table) + 3496 (flag). `checkProductionDrift.ts:908` classifies `place_cooccurrence` **unapplied**: *"Harness only; applied to no Supabase project."* |
| `discovery_trend_normalised_enabled` | the v2 trend model — `lib/discoveryTrendState.ts:338`, `lib/discoveryLocalMomentum.ts:240` | absent | `MIGRATION` 3475 + 3476 (`area_momentum`, classified **unapplied**) + 3477 |
| `discovery_trend_rebuild_scheduler_enabled` | the background rebuild tick — `lib/discoveryTrendRebuildScheduler.ts:70` → `{status:"skipped", reason:"disabled"}`. BACKGROUND JOB | absent | `MIGRATION` 3475 + 3477 |
| `discovery_trend_snapshot_retention_enabled` | the retention prune inside that tick — `lib/discoveryTrendRebuildScheduler.ts:80-91`. BACKGROUND JOB; also carries a config value (§4) | absent | `MIGRATION` 3475, then `CONFIG` of `metadata.keep_days` |
| `discovery_trend_rediscovery_retest_enabled` | the §9-step-5 rediscovery retest slot — `lib/discoveryTrendRediscovery.ts:110` | absent | `MIGRATION` 3475 |
| `discovery_trend_post_convergence_enabled` | the post-after-visit convergence leg — `lib/discoveryTrendPostConvergence.ts:53`, read at `lib/discoveryLocalMomentum.ts:457` | absent | `MIGRATION` 3496 + 3497 |
| `discovery_trend_lists_enabled` | see §2.6 | absent | `MIGRATION` 3475 |
| `discovery_trail_exploration_enabled` | DV-22/DV-21/DC-04 Trail exploration machinery — `services/trails/trailExploration.ts:58`, both read fail-closed in `readTrailRankingFlags` (`:64-70`) | absent | `MIGRATION` 3485 + 3487 (`trail_member_exposures`, *"Read and written only behind discovery_trail_exploration_enabled (3485, FALSE). Harness only"* — `checkProductionDrift.ts:908`) |
| `discovery_trail_health_order_enabled` | DC-05's health order for Trails — `services/trails/trailExploration.ts:60` | absent | `MIGRATION` 3485 |
| `discovery_trail_objective_rank_enabled` | per-surface objective rank, Trail surface — `lib/discoverySurfaceObjectiveRank.ts:73`, `:80` | absent | `MIGRATION` 3500 |
| `discovery_trending_objective_rank_enabled` | same, trending surface — `:74`, `:81` | absent | `MIGRATION` 3500 |
| `discovery_trip_planning_objective_rank_enabled` | same, trip-planning surface — `:75`, `:82` | absent | `MIGRATION` 3500 |
| `compass_graph_decay_enabled` | Compass graph edge decay — `compass/CompassGraphEngine.ts:2787` | absent | `MIGRATION` 3469 |

---

### 4. Config values — NOT boolean flags

The task brief framed these as "numeric or string config values read from the
same table". That is **true for three of them and false for the rest**, and the
distinction matters because Chelsi sets them in two completely different places.

#### 4.1 Read from `feature_flags.metadata` (the table)

| name | what it tunes | where it is read | prod value | default when absent |
|---|---|---|---|---|
| `DISCOVERY_ENGINE_MODE` → `metadata.mode` | which discovery execution path serves a request: `legacy`\|`shadow`\|`pde`, with `off`/`compare`/`partial`/`on` aliases | `lib/discoveryEngineMode.ts:267`, parsed `:128-170` | row exists, `enabled=false`; the metadata value is **not in the capture** and is moot while disabled | seeded `{"mode":"legacy",…}` by `2091:73`; an absent/null/unparseable mode resolves `legacy` (`:268-277`) |
| `DISCOVERY_ENGINE_MODE` → `metadata.cohort` | WHO a non-legacy mode applies to | `lib/discoveryEngineMode.ts:331`, parser `lib/discoveryCohort.ts` | not in the capture | an absent or unusable cohort includes **NOBODY** (`:332-339`); `partial` over `kind:"all"` is refused to legacy (`:349-356`) |
| `discovery_stop_enforcement_enabled` → `metadata.values_version` | which approved set of §12 stop thresholds is armed | `lib/discoveryStopConditions.ts:561-568` | **row absent** | must equal exactly `"stop-values-2026-09-28.1"` (`:568`); anything else, including a bare `enabled:true`, arms nothing |
| `discovery_trend_snapshot_retention_enabled` → `metadata.keep_days` | days of `place_momentum` / `area_momentum` snapshots retained | `lib/discoveryTrendRebuildScheduler.ts:58-61`, used `:81-84` | **row absent** | **no default** — `keepDaysOf` returns `null` for anything that is not a positive integer, and the tick then reports `pruned: "keep_days_unset"` and deletes nothing (`:82`) |

#### 4.2 Read from **environment variables**, with no `feature_flags` row at all

`lib/compassPolicy.ts:29-32` is explicit: *"It is also NOT a feature flag. These
are numeric policy values, not capability gates, and they have no `feature_flags`
row and no polarity — a missing, empty or unparseable variable means 'the owner
has set nothing', and resolves to the shipped default rather than to zero."*

| env var | what it tunes | where read | validation | default |
|---|---|---|---|---|
| `COMPASS_AWARE_DAILY_CAP` | Sense: daily nudge ceiling at "aware" presence | `lib/compassPolicy.ts:80`, resolved `:144` | non-negative integer ≤ 100 (`readCap`, `:95-102`) | **3** (`:69`) |
| `COMPASS_ACTIVE_DAILY_CAP` | Sense: daily nudge ceiling at "active" presence | `:81`, resolved `:145` | same | **6** (`:70`) |
| `COMPASS_SWITCHING_COST` | Decision: how much better (0..1) a candidate must be before SWITCH | `:82`, resolved `:146` | finite fraction 0..1 (`readFraction`, `:124-131`) | **0.25** (`:71`) |
| `COMPASS_QUEUE_TOLERANCE_MINUTES` | Decision: queue wait past which a live candidate is WAIT, not GO | `:83`, resolved `:147-148` | integer minutes, min **0** (zero is a legitimate ruling), max 1440 (`:114-121`) | **30** (`:72`) |
| `COMPASS_DWELL_FULL_WEIGHT_MINUTES` | Decision: dwell at which revealed preference reaches full weight | `:84`, resolved `:149-150` | integer minutes, min **1** (it is a divisor — zero makes every dwell instantly full-weight, `:104-113`), max 1440 | **60** (`:73`) |
| `COMPASS_INTENT_CONFLICT_FLOOR` | Decision: intent-relative value at or below which a candidate is a conflict | `:85`, resolved `:151-152` | fraction 0..1 | **0.2** (`:74`) |
| `COMPASS_RETURN_FAVOURABLE_VALUE` | Decision: value at or above which a left-earlier place is favourable again | `:86`, resolved `:153-154` | fraction 0..1 | **0.5** (`:75`) |
| `COMPASS_LIVE_CONSTRAINTS_ENABLED` | **boolean**, but an env var not a flag row: the Compass live-constraints gate | `compass/CompassLiveConstraints.ts:76`, `liveConstraintsEnabled` `:79-81` | must be literally `"true"`, case-insensitive; anything else is OFF | **OFF** (`:75` — *"Env-guarded constant (no migration lane ⇒ no feature_flags row). Default OFF."*) |

**To turn any of §4.2 on for hosted testing: `CONFIG`** — Chelsi sets the
environment variable on the hosted API server. Nothing in the `feature_flags`
table affects them, and an admin flag flip will not reach them. Note
`compassPolicy.ts:23-27`: *"Every default below is the value the tree already
shipped, byte for byte … Nothing here approves a number"* — so changing one of
these seven is also a `DECISION`, because the shipped number is the only one
anybody has signed off on.

#### 4.3 Compile-time constants, not configurable at all

Listed so nobody looks for a row or a variable:

| name | value | where |
|---|---|---|
| `COMPASS_RHYTHM_K` | `5` (k-anonymity floor for the Compass rhythm gate) | `lib/compassRhythmGate.ts:34` |
| `DISCOVERY_MODEL_VERSION` | `"compass-discovery-2026-09"` | `lib/discoveryRankProvenance.ts:73` |
| `DISCOVERY_PDE_MODEL_VERSION` | `"portava-rank-pde-2026-09"` | `lib/discoveryRankProvenance.ts:383` |
| `PLATFORM_COVERAGE_READ_CAP` | `2000` | `lib/discoveryPlatformGraphProvenance.ts:64` |
| `STOP_ENFORCEMENT_VALUES_VERSION` | `"stop-values-2026-09-28.1"` | `lib/discoveryStopConditions.ts:568` |

#### 4.4 `MEDIA_DEFAULT_VIEW_MODE` — out of this domain, noted because the brief named it

A `feature_flags` row whose `enabled` field is **unused**; the value lives in
`metadata.mode` (`watch` | `grid` | `gems`). Seeded `false` by
`src/migrations/2038_media_admin_flags.sql:75`; production value in the capture is
`MEDIA_DEFAULT_VIEW_MODE=0`, which for this row means nothing about the mode.
I did **not** find the production `metadata.mode` value, and the description text
is quoted in `src/test/mediaAdminFlags.test.ts:50`. It belongs to the MEDIA
domain section, not here.

---

### 5. Flags read in code with no row and no seeding migration

These are not "off"; they are *unseeded*. Each is read live, so each is a real
gate that nothing can currently turn on through the admin surface.

| flag | read at | state |
|---|---|---|
| `COMPASS_TELEGRAPH` | `routes/compass.ts:4695` — `await isEnabled(sc, "COMPASS_TELEGRAPH").catch(() => false)` | row absent in prod. `2300_phantom_feature_flag_rows.sql:135,152` concerns this name; prod has no row, so Telegraph's Compass leg is off. |
| `COMPASS_LAUNCH_CONTROL_ENABLED` | `compass/CompassSafetyFilter.ts:131` — `if (preloadedFlags["COMPASS_LAUNCH_CONTROL_ENABLED"] && item.country)` | row absent ⇒ no launch containment applied |
| `COMPASS_COUNTRY_LAUNCH_REQUIRED` | `compass/CompassEligibilityEngine.ts:75` | row absent |
| `COMPASS_CITY_LAUNCH_REQUIRED` | `compass/CompassEligibilityEngine.ts:84` | row absent |
| `COMPASS_<TYPE>_SAFETY_BLOCK` × 11 (`event`, `post`, `user`, `buddy`, `trip`, `stamp`, `notification`, `suggestion`, `place`, `hidden_gem`, `traveler`) | `compass/CompassSafetyFilter.ts` rule 15 via `preloadedFlags[typeBlockFlag]`; fail-safe map built at `compass/flags.ts:80-84` | **no row is seeded by any migration today** — stated as such at `compass/flags.ts:35-37`: *"It is a latent defect rather than a live one — no `_SAFETY_BLOCK` row is seeded by any migration today — but 'the switch works only while the database is healthy' is not a property to leave undocumented until the day it matters."* |

**To make the `_SAFETY_BLOCK` stops usable: `MIGRATION`** — eleven rows, seeded
`false` (they are STOP polarity, so `false` = not engaged). No migration currently
creates them, so the per-content-type emergency stop an operator would reach for
during hosted testing does not exist as an admin control. I would call this the
single highest-value cheap addition in this domain if hosted testers will be
generating content.

#### 5.1 The singular/plural split — a real naming defect

Production carries `COMPASS_ACTIVE_REWARDS_ENABLED=1`, seeded plural by
`src/migrations/0053_compass_feed_intelligence.sql:200`
(`'COMPASS_ACTIVE_REWARDS_ENABLED', true, 'Active user reward engine'`).

The **singular** `COMPASS_ACTIVE_REWARD_ENABLED` is a different string, and it
appears in `routes/admin.ts:698` and `routes/featureFlags.ts:43` — the admin
filter list and the public endpoint filter — and in
`2080_retire_inert_seeded_flags.sql:117,141,162` as one of the six retired names.
`2080:72-83` explains why the filters stay after the row is deleted. So the
singular name is correctly handled as retired, and the plural name is the live
one. **`CODE` (low severity):** the two names differ by one letter and sit in the
same files; a reader of `routes/admin.ts:698` can reasonably conclude the live
reward engine flag is filtered out of the admin list when it is not. A comment
distinguishing them would prevent that.

#### 5.2 The six COMPASS flags retired by migration 2080

`COMPASS_FRONTLOAD_ENABLED`, `COMPASS_ACTIVE_REWARD_ENABLED`,
`COMPASS_EXPLAIN_WHY_ENABLED`, `COMPASS_ADMIN_CONTROLS_ENABLED`,
`COMPASS_ABUSE_DEFENSE_ENABLED`, `COMPASS_NOTIFICATION_INTELLIGENCE_ENABLED`.

**Production value:** row absent for all six (consistent with 2080 having run, or
with the seeds having been removed from 0051 — 2080 does both).

**Why off:** `src/migrations/2080_retire_inert_seeded_flags.sql:16-26` —
*"The disposition rule was: keep a flag only on evidence of a LIVE READ … For the
six COMPASS_*, the near-miss is worth stating because it looks like a reader and
is not. compass/flags.ts loadFlags() runs `.select("flag, enabled").like("flag",
"COMPASS_%")` … so all six ARE loaded into memory on every Compass request. No
caller then asks isEnabled() for these six names. … Being loaded is not being
read."* And `:38-42`: *"Deleting it does not remove a capability; it removes a
claim."*

**To turn on for hosted testing:** nothing. There is no capability behind them.
They remain filtered from `GET /admin/feature-flags` and from the public endpoint
the mobile app fetches (`routes/admin.ts:697-702`, `routes/featureFlags.ts:42-47`),
which is deliberate (`2080:72-83`). `COMPASS_FRONTLOAD_ENABLED` is worth one
note: `compass/CompassFrontLoadEngine.ts` still exists and still calls the shared
`fetchCompassFlags`, but the flag that would have gated it was retired as unread.

---

### 6. Fail-safe behaviour you must know before flipping anything

#### 6.1 The three Compass flag loaders are now one

`compass/flags.ts:7-14` — the `LIKE 'COMPASS_%'` query lived in three places
(`flags.ts`, `CompassPipeline`, `CompassFrontLoadEngine`), *"each with its own
copy of the query and its own idea of what an unreadable table means. All three
ignored `.error` (supabase RESOLVES on a database error, so their `try/catch`
blocks were dead code)"*. `fetchCompassFlags` (`:113-155`) is now the single
loader.

#### 6.2 `COMPASS_%` is MIXED POLARITY and a read failure is not "all off"

`compass/flags.ts:16-47`. On a resolved `.error`, `FAILSAFE_COMPASS_FLAGS`
(`:80-84`) is returned: every `COMPASS_<TYPE>_SAFETY_BLOCK` **engaged**, every
capability absent-and-therefore-falsy. Deliberately *not* engaged on failure:
`COMPASS_LAUNCH_CONTROL_ENABLED`, `COMPASS_COUNTRY_LAUNCH_REQUIRED`,
`COMPASS_CITY_LAUNCH_REQUIRED` — *"engaging them without the readable per-region
allowlist they depend on would deny every item with a country, turning one
unreadable table into a total discovery blackout"* (`:39-47`).

A **throw** (as opposed to a resolved error) is answered with the empty map, not
the fail-safe map, and the reasoning is measured rather than assumed
(`compass/flags.ts:133-154`, against `@supabase/supabase-js 2.108.2`).

A failed load is **never cached** (`:164-171`), so a recovered database is picked
up on the next request rather than 30 s later.

#### 6.3 `DISCOVERY_`-prefixed names must never be read through `compass/flags.ts`

`lib/discoveryEngineMode.ts:27-34` (ruling D1=B): that module's
`LIKE 'COMPASS_%'` loader would answer a `DISCOVERY_` name *"false with no error,
no warning and no log line — and its 30-second cache would hold that false."*
`DISCOVERY_ENGINE_MODE` and `DISCOVERY_DIVERSITY_ENABLED` are read through
`lib/featureFlags.ts` instead. Anyone adding a `DISCOVERY_*` flag must follow
this.

#### 6.4 One stop gate overrides every Discovery rollout flag

`lib/discoveryStopGate.ts:72-95`. A flag that reads ON is served OFF when either
the §12 stop conditions have tripped or `disable_discovery_pde` is engaged, and
*"anything unexpected is a halt, because a halt only returns the flag-off output
users already had"* (`:68-70`). Applied at `pipelineFlags.ts:113-115`,
`discoveryRankFlags.ts:98-100`, `discoveryOnePipeline.ts:57`,
`routes/discoveryOutputKinds.ts:69`. So flipping a Discovery flag on in hosted
testing and seeing no change is a legitimate outcome — check the stop first.

---

### 7. Named cross-domain neighbours (NOT in this section)

These contain `discovery` or `compass` in the name but do not start with the
domain prefixes, so they belong to other sections. Production values from the
same capture, given so nothing falls between sections:

`ACTIVITY_DISCOVERY_BOOST_ENABLED=0` (ranking) ·
`MEDIA_GEMS_*` / `MEDIA_HIDDEN_GEMS_CREATE_ENABLED=1` /
`MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED=1` / `MEDIA_DEFAULT_VIEW_MODE=0` (media) ·
`hidden_gem_verification_enabled=1`, `hidden_gems_enabled=1`,
`hidden_gems_layover_enabled=1`, `hidden_gems_passport_enabled=1`,
`hidden_gems_pulse_enabled=1` (hidden gems) ·
`intel_compass_rhythm_actor_gate=0` (intel; seeded
`2169_intel_compass_rhythm_actor_gate_flag.sql`) ·
`layover_compass_enabled=1`, `layover_discovery_mode_enabled=0` (layover;
`2971` applied) · `shared_moments_compass_suggestions_enabled=1` (shared moments) ·
`wall_discovery_insertions_enabled=0`, `wall_enabled=0` (wall) ·
`telegraph_discovery_actions_enabled` (telegraph; **row absent**).

---

### 8. Checks I could not establish

Stated rather than guessed:

1. **The live `metadata` of `DISCOVERY_ENGINE_MODE` in production.** The capture
   carries only `enabled`. Moot while `enabled=false`, but it must be read before
   anyone flips that row to `true`, or the mode served is unknown.
2. **Whether `2976`'s global Journey stop was actually invoked in production**, as
   opposed to the three flags simply never having been turned on. The repository
   records the procedure, not its invocation.
3. **Whether the mobile app reads `compass_ai_enabled` through
   `routes/featureFlags.ts`.** I grepped the whole repo for the literal and found
   only a comment, a verification script and the polarity script — but
   `routes/featureFlags.ts` serves a *list*, and a client could read the name from
   a response without the literal appearing in the mobile tree. Confirm before
   retiring the row.
4. **Live schema readiness for `discovery_trip_projection_enabled`.** The code
   comment says `trips.version` is absent from production (measured 2026-09-07);
   `production-applied-migrations.json` lists `2420_trip_kernel_foundation` as
   applied. I trusted neither over the other — the capability probe must answer
   this at runtime, and I ran no SQL.
5. **Whether any `COMPASS_<TYPE>_SAFETY_BLOCK` row exists in production.** The
   capture shows none and `compass/flags.ts:35-37` says no migration seeds one,
   which agree — but a row created by hand through the Supabase dashboard would
   appear in neither source. Low risk, stated for completeness.
## Section 05 — LAYOVER / AIRPORT, MAP, INTEL

Scope: every verified feature-flag key beginning `layover_` / `LAYOVER_`, `airport_`,
`map_`, `intel_`, `sensing_`, plus `disable_intel_live_labels`,
`hidden_gems_layover_enabled` and `place_provenance_stamping_enabled`.
All paths are relative to `/home/user/portava.app`. Production values are from
`scratchpad/flags/prod-sorted.txt` (201 rows); "row absent" means the name is not in
that file. Schema facts are from
`artifacts/api-server/src/lib/capability/snapshots/20260922-production-schema.json`
(the capture named by `snapshots/current.ts:104`) and
`artifacts/api-server/src/lib/capability/production-applied-migrations.json`.

Every name below was verified to reach `isFlagEnabled` / `isKillSwitchEngaged` /
`getFlagRow` / a literal `.eq("flag", …)`. Names I rejected are listed in
**§5 Not flags** at the end.

---

### 0. The four questions put to this section — answers first

#### Q1. `airport_mode_enabled` is the ONLY gate on the traveller crowd-report write path — CONFIRMED

- Production value: **true** (`prod-sorted.txt:65`).
- `requireOwnedSession` is at `artifacts/api-server/src/routes/airport.ts:2358`; its
  flag read is the single line `artifacts/api-server/src/routes/airport.ts:2364`
  (`isFlagEnabled(sc, "airport_mode_enabled")`). It otherwise only does
  `requireUser` + `getServiceClient` + `ownedSessionOr` (ownership).
- The write endpoint is `POST /api/airport/sessions/:id/observations`,
  `artifacts/api-server/src/routes/airport.ts:2773`, whose first statement is
  `requireOwnedSession` (`:2774`). The read sibling is
  `GET …/observations` at `:2736`–`:2737`.
- I grepped the writer and the reconciler for any further flag read and found
  **none**: `artifacts/api-server/src/services/layover/LayoverObservationService.ts`
  contains no `isFlagEnabled`, no `isKillSwitchEngaged`, no `feature_flags`.
  There is no second gate in the handler either — the remaining refusals are
  schema validation (`observationSubmitSchema`, `airport.ts:2688`),
  the fact-type allowlist (`isTravellerSubmittableFactType`, `:2782`), the
  airport-ref requirement (`:2797`) and the service's own rate limit / plausibility
  screen (`:2816`–`:2843`).
- Schema is in place: `airport_fact_observations` is present in the production
  snapshot, and both `2982_layover_traveller_observation_submissions` (the
  idempotency key the route requires) and `2983_layover_events_observation_reported`
  (the audit `event_type`) are listed in `production-applied-migrations.json`.

**So: the traveller crowd-report write path is LIVE in production today, and the
only switch that can stop it is the one that stops the entire Layover router.**

**Overlap with backlog B5 (owned by another thread — reported, not designed):**
`docs/BUILD-BACKLOG.md:14` is exactly this item, in its own words — "the traveller
observation surface has no dedicated kill switch; it is gated only by
`airport_mode_enabled`, which gates the entire layover router. Turning the report
channel off in an incident therefore means turning all of Layover off. A dedicated
`layover_crowd_reports_enabled` flag was considered and not added: seeding a
brand-new write surface TRUE is an owner decision, and seeding it FALSE would have
shipped the feature dark … Owner decision either way." I make no proposal here.
For hosted testing nothing is needed: **FLAG FLIP ONLY — already on**.

#### Q2. `layover_event_ingest_enabled` / `layover_maturity_gate_enabled` — VERIFIED, with one correction

Both have **row absent** (neither appears in `prod-sorted.txt`), and neither
migration is applied: `production-applied-migrations.json` jumps
`2976_journey_shadow_global_stop_delete_scope` → `2982_…`, so **2977 and 2981 are
absent from the applied list** (2971 *is* applied, which is why
`layover_discovery_mode_enabled` has a row and these two do not).

- `layover_event_ingest_enabled` — **fails closed, correctly described.**
  Gate: `artifacts/api-server/src/routes/layoverEvents.ts:134` refuses
  `POST /api/layover/events` with `degraded_unavailable` / "Event ingest is not
  open." Second gate on the consumer:
  `artifacts/api-server/src/lib/layoverExternalEventScheduler.ts:113`. Flag constant
  `artifacts/api-server/src/services/layover/LayoverExternalEventService.ts:126`.
  Migration header says why:
  `artifacts/api-server/src/migrations/2981_layover_event_ingest_flag.sql:46`–`:60`
  — "Turning this on opens a WRITE PATH FOR NON-TRAVELLER DATA … A producer that can
  publish one can move a traveller's return deadline", with two prerequisites the
  migration cannot satisfy: producer authentication by shared secret, and a consumer
  that actually runs.

- `layover_maturity_gate_enabled` — **CORRECTION: this one is not a write path and
  OFF is the PERMISSIVE direction, not fail-closed.**
  Gate: `artifacts/api-server/src/services/airport/layoverMaturityGate.ts:207`
  inside `landsideMaturityDecision`; with the flag off it returns a decision built
  from `decide(…, false, null, true)` at `:212`–`:218` and reads no corpus. The
  consumer is `LayoverRecommendationService.generateRecommendations`
  (`artifacts/api-server/src/services/airport/LayoverRecommendationService.ts:491`).
  Turning it ON is the restrictive move: the migration header states it plainly at
  `artifacts/api-server/src/migrations/2977_layover_maturity_gate_flag.sql:30`–`:36`
  — "Production holds 3,206 `airport_profiles` rows. ZERO are verified and ZERO carry
  `terminal_info` … So with this flag ON, EVERY airport on earth classifies
  `L0_GENERIC` and the landside half of the Layover product is withdrawn: no
  Discovery candidates, no city-escape card."
  **For hosted testing, leave this flag off / absent.** Turning it on would delete
  the landside half of Layover from the tester's app.

#### Q3. What a hosted tester sees on the map today

Seven `map_*` names have **row absent** (verified against `prod-sorted.txt`):
`map_projection_enabled`, `map_contributions_enabled`, `map_crowd_flow_enabled`,
`map_display_resolver_enabled`, `map_experience_state_enabled`,
`map_world_intelligence_enabled`, `map_world_moments_enabled`.

**A hosted tester still gets a working map.** The gateway is *fail-soft by design*,
not fail-blank. `artifacts/api-server/src/routes/mapProjection.ts:472` answers an
explicit `{ enabled: false, objects: [], … }` envelope rather than an error, and
`travel-buddy-standalone/src/hooks/useMapEntities.ts:786` treats `enabled: false` as
"fall back, do NOT treat it as an empty world" and runs the original per-layer
fetchers at `:813`–`:829`. The hook's own header says it at
`useMapEntities.ts:47`–`:52`: "switching the flag off is a real rollback rather than
a blank map."

**Reachable today (no flag change needed):**
- Pins/entity layers via the legacy per-layer path: **events, gems, buddies, trips,
  friends** (`useMapEntities.ts:814`–`:829`).
- Travelers layer, which never used the gateway at all
  (`useMapEntities.ts:38`–`:43`, `useMapTravelers`).
- **Map search** — `map_search_enabled=1`, gate
  `artifacts/api-server/src/routes/mapSearch.ts:154`.
- **Compass map commands** — `map_compass_commands_enabled=1`, gate
  `artifacts/api-server/src/routes/mapSearch.ts:304`.
- Trip crew map (`trip_crew_map_enabled=1`) and passport map
  (`passport_map_enabled=1`) — those two belong to other sections but they are the
  reason the map screens are not empty.

**NOT reachable today, and why:**

| Flag | Row | Needed for a usable map, or internal projection? | What a tester loses |
|---|---|---|---|
| `map_projection_enabled` | absent | **Not required** — it is a *unification* of layers the legacy path already serves. | One batched gateway call instead of five; plus it is the parent that unlocks every row below it. |
| `map_contributions_enabled` | absent | **Needed** — it is the only WRITE on the map. | Long-press / LivePlaceSheet "report what you see" does nothing. Gates `ingestMapContribution` at `artifacts/api-server/src/routes/mapObservations.ts:738`; the client reads the same name at `travel-buddy-standalone/src/components/map/LivePlaceSheet.tsx:183` and `travel-buddy-standalone/src/features/map/interaction/longPress.ts:357`. |
| `map_crowd_flow_enabled` | absent | **Needed if "crowd" is part of the test** — it is a visible layer. | No crowd-flow arrows / time-machine layer. Gates `artifacts/api-server/src/routes/mapProjection.ts:878` and `artifacts/api-server/src/routes/mapProjectionTemporal.ts:221`; producer constant `artifacts/api-server/src/lib/crowdFlowProducer.ts:265`. |
| `map_world_intelligence_enabled` | absent | **Internal projection** (city model + personal city overlays). | City-model and personal-city overlays absent. Gates `artifacts/api-server/src/lib/mapProducers/cityModelProducer.ts:395` and `artifacts/api-server/src/lib/mapProducers/personalCityProducer.ts:265`. |
| `map_world_moments_enabled` | absent | **Internal projection** (SX-03 world-change moments over `world_pulse` cells). | No world-moment badges. Gate `artifacts/api-server/src/routes/mapProjection.ts:540`. |
| `map_experience_state_enabled` | absent | **Internal projection** (SX-02/SX-07 ExperienceState fold, truthClass/coverage stamping). | No truth-class/coverage stamps on map objects. Gates `mapProjection.ts:539`, `mapProjectionTemporal.ts:659`. |
| `map_display_resolver_enabled` | absent | **Internal projection** (SX-08/SX-09 clutter budget + safety precedence). | Markers are not de-cluttered or safety-ordered. Gate `mapProjection.ts:541`; module `artifacts/api-server/src/lib/mapDisplayResolver.ts:49`. |

**The decisive constraint is schema, not flags.** Three of those layers read tables
that **do not exist in production**. Checked against the 20260922 snapshot:
`map_observations` **absent**, `crowd_flow` **absent**, `world_pulse_cells`
**absent**, `map_world_moments` **absent**, `map_crowd_flow` **absent**,
`intel_historical_patterns` **absent**, `sources` **absent**. Correspondingly none of
`2201_map_projection_flag`, `2216_map_observations`, `2218_crowd_flow`,
`2295_map_world_intelligence_flag`, `2350_map_sensing_projection_flags` appears in
`production-applied-migrations.json`.
(`map_telemetry_events`, `map_pins`, `trip_map_projections`, `compass_city_models`,
`geo_zones`, `compass_graph_edges` and `place_living_cache` **are** present.)

**Recommended hosted-testing order for the map:** apply 2201 (flag row) and 2216
(`map_observations` + `map_contributions_enabled`) and turn those two on — that
restores the one genuinely missing *user action* on the map. Treat crowd flow
(2218), world intelligence (2295) and the 2350 trio as a second phase; they are
projections over corpora a fresh test deployment will not have.

#### Q4. What each of the five false intel flags costs

| Flag | Value | What being false costs | Gate |
|---|---|---|---|
| `intel_presence_verification_enabled` | false | Nothing is blocked — this is the **only** thing that can *raise* a stored presence level above the unattested clamp. With it off, every live-grade claim is clamped by `resolvePresenceAttestation` and the P2/P3/P4 rungs (geofence+dwell, receipt, mission nonce) never run, so no contribution can ever be marked server-verified. The header says the path is "byte-identical to before this unit landed". | `artifacts/api-server/src/services/intel/IntelCaptureService.ts:307`; verifier `artifacts/api-server/src/services/intel/PresenceVerifier.ts:15`; route note `artifacts/api-server/src/routes/intel.ts:230` |
| `intel_contribution_retention_enabled` | false | A **background job** only. The 180-day identifiable-retention sweep never runs, so actor-linked rows in `intel_evidence` / `intel_confirmations` / `intel_observations` are kept past the ruled retention. No user-visible feature is lost; this is a compliance debt, and it is deliberately a separate switch because the deletion is irreversible. | `artifacts/api-server/src/lib/intelRetentionScheduler.ts:395`; pass registered at `:583` |
| `intel_compass_rhythm_actor_gate` | false | A **READ / prose line**. The time-sliced "Destination rhythm — <city> (<slice>): typically active around … " line is suppressed entirely and Compass falls back to the city-wide non-time-sliced summary (`CompassGraphEngine.ts:1797`–`:1800`). Cost is a less specific Compass answer, never a wrong one. | `artifacts/api-server/src/compass/CompassGraphEngine.ts:1789`–`:1790`; policy `artifacts/api-server/src/lib/compassRhythmGate.ts:41` |
| `intel_coverage` | false | A **background job**, and it is load-bearing beyond itself. `intelCoverageScheduler` is an inert no-op: no coverage cells, no coverage snapshots, and — because mission generation happens *inside* the coverage pass — **no missions are ever generated even though `intel_missions=1`**. The admin gap dashboard reads empty. | `artifacts/api-server/src/lib/intelCoverageScheduler.ts:29`; mission generation `artifacts/api-server/src/services/intel/CoverageService.ts:58` |
| `intel_live_scope_promotion_enabled` | false | **This is the single most consequential false flag in the domain.** It is the only writer of `intel_live_promoted_scopes`, and `readLiveClaims` refuses on an empty allowlist: `artifacts/api-server/src/lib/liveClaimRead.ts:358`–`:359` (`if (promotedScopes.size === 0) return [];`), with the per-snapshot check again at `:397`. So **no Live/Emerging intel label is ever served to anyone**, even though `intel_limited_live=1`, `intel_live_label_crowd=1`, `intel_claim_projection_crowd=1`, `intel_capture_quick_signal=1` and the kill switch `disable_intel_live_labels=0`. Those four "on" flags are serving nothing. | writer `artifacts/api-server/src/lib/intelLiveScopePromotion.ts:49`,`:62`; expiry pass `artifacts/api-server/src/lib/intelPromotionScheduler.ts:115`; read gate `artifacts/api-server/src/lib/liveClaimRead.ts:358` |

Note on the fifth row: the only other way to promote a scope is the admin surface,
and `intel_live_scope_admin_surface_enabled` has **row absent** — the admin gate
even says so in its own refusal message
(`artifacts/api-server/src/routes/admin.ts:3313`: "has no row (or could not be read)
— migration 2570 seeds it"). `2570` is not in the applied list. So today there is
*no* path, automated or manual, to put a scope on the Live allowlist.

---

### 1. LAYOVER / AIRPORT

| flag | polarity | prod | gates (R/W/job/UI) | why off | to turn on |
|---|---|---|---|---|---|
| `airport_mode_enabled` | capability | **true** | Master gate on the whole Layover router — 16 direct reads plus `requireOwnedSession`. READ **and** WRITE. `artifacts/api-server/src/routes/airport.ts:504, 552, 772, 993, 1046, 1170, 1236, 1351, 1447, 1638, 1694, 2111, 2150, 2207, 2364, 3609, 3811` | n/a, on | **FLAG FLIP ONLY — already on** |
| `airport_pulse_enabled` | capability | **true** | READ. `GET /api/airport/pulse` returns `{posts:[],featureEnabled:false,reason:"airport_pulse_not_enabled"}` when off. `artifacts/api-server/src/routes/airport.ts:3612` | n/a, on | **FLAG FLIP ONLY — already on** |
| `layover_plans_enabled` | capability | **true** | WRITE. `POST /airport/sessions/:id/stops` refuses "Layover plans are not yet enabled". `artifacts/api-server/src/routes/airport.ts:2396` | n/a, on | **FLAG FLIP ONLY — already on**, but see `layover_stable_recommendation_ids_enabled` below: the plan *entry point* is still unreachable |
| `layover_compass_enabled` | capability | **true** | READ/LLM. `artifacts/api-server/src/routes/airport.ts:1175` | n/a, on | **FLAG FLIP ONLY — already on** |
| `layover_safety_engine_enabled` | capability | **true** | READ. Forces regeneration of recommendations and gates `GET …/safety` (`featureEnabled:false` when off). `artifacts/api-server/src/routes/airport.ts:1008, 1050` | n/a, on | **FLAG FLIP ONLY — already on** |
| `hidden_gems_layover_enabled` | capability | **true** | READ. `GET /api/hidden-gems/layover-safe`. `artifacts/api-server/src/routes/hiddenGems.ts:613` (parent `hidden_gems_enabled` at `:610`, also true) | n/a, on | **FLAG FLIP ONLY — already on**. Depends on: `hidden_gems_enabled` |
| `layover_stable_recommendation_ids_enabled` | capability | **false** | READ, but with a UI consequence. Off ⇒ the legacy regenerate path deletes and re-inserts every recommendation card and returns them **without ids**, and the comment at `artifacts/api-server/src/routes/airport.ts:1011`–`:1012` states the effect: "the client's 'Add to plan' control (gated on `rec.id`) never renders". Gate `artifacts/api-server/src/routes/airport.ts:1013`; cutover constant `artifacts/api-server/src/scripts/lib/layoverCutoverEvaluate.ts:52` | seeded FALSE by 2410 (which **is** applied) pending the cutover measurement in `src/lib/capability/layover-cutover-measurement.json` | **DECISION** — Q: do we accept the 2410 cutover for hosted testing without the full measurement run, so testers can add a layover recommendation to a plan? RECOMMENDED: **yes, flip it on**. Reason: `layover_plans_enabled` is already true but the only control that reaches it is suppressed by this flag, so the layover plan feature is currently untestable end-to-end, and 2410's schema is applied. |
| `layover_safe_return_status_enabled` | capability | **false** | WRITE (one column). Off ⇒ `POST …/return-now` still cancels landside stops and still writes the decision ledger; only the `status='returning'` write is skipped. `artifacts/api-server/src/routes/airport.ts:1376`–`:1378`, conjoined with the build constant `LAYOVER_RETURNING_READERS_WIDENED` (`artifacts/api-server/src/services/airport/LayoverSessionService.ts:69`, currently `true`) | `artifacts/api-server/src/routes/airport.ts:1322`–`:1332`: a flag flipped on a deployment whose readers still filter `status='active'` "would mark the session returning and then hide it from GET /sessions/active, setReturnReminder and endSession — the traveller loses the countdown at the exact moment they are running for a plane." Migration 2741 is applied; the build constant is now `true` | **FLAG FLIP ONLY**. Both independent prerequisites are satisfied: 2741 is in `production-applied-migrations.json` and `LAYOVER_RETURNING_READERS_WIDENED === true`. |
| `layover_discovery_mode_enabled` | capability | **false** | READ. Discovery lanes may not enter Layover mode; `artifacts/api-server/src/lib/discoveryLayoverMode.ts:242` reads it, flag constant `artifacts/api-server/src/services/airport/LayoverSnapshot.ts:147`. Also consumed by the Discovery section — coordinate there. | `artifacts/api-server/src/migrations/2971_layover_discovery_mode_flag.sql:3` seeds it FALSE; 2971 **is** applied, which is why this one has a row | **FLAG FLIP ONLY** (row exists, schema applied). Cross-check with the Discovery section before flipping. |
| `layover_event_ingest_enabled` | capability | **row absent** | WRITE + background job. See §0 Q2. `artifacts/api-server/src/routes/layoverEvents.ts:134`, `artifacts/api-server/src/lib/layoverExternalEventScheduler.ts:113` | `migrations/2981_layover_event_ingest_flag.sql:46`–`:60` | **MIGRATION** then **CONFIG**: apply `2981_layover_event_ingest_flag.sql` (NOT in `production-applied-migrations.json`; its prerequisite 2860 **is**, and `layover_external_events` is in the snapshot), then Chelsi must supply env var **`LAYOVER_EVENT_PRODUCER_SECRET`** (`artifacts/api-server/src/routes/layoverEvents.ts:113`) — the route refuses without it regardless of the flag. |
| `layover_maturity_gate_enabled` | capability | **row absent** | READ. Enabling it **withdraws** landside Layover. See §0 Q2. `artifacts/api-server/src/services/airport/layoverMaturityGate.ts:207` | `migrations/2977_layover_maturity_gate_flag.sql:30`–`:36` | **DECISION** — Q: should hosted testing enforce the §22 maturity gate? RECOMMENDED: **no — leave it absent**. Reason: zero of 3,206 production `airport_profiles` are verified or carry `terminal_info`, so every airport would classify L0 and testers would see no Discovery candidates and no city-escape card. 2977 is also unapplied. |
| `layover_live_intersection_enabled` | capability | **row absent** | READ. Live-intersection input to recommendations. `artifacts/api-server/src/services/airport/LayoverRecommendationService.ts:64`; seed `migrations/2851_layover_live_intersection_flag.sql:2` | seeded FALSE by 2851 | **MIGRATION** — `2851_layover_live_intersection_flag.sql` is not in `production-applied-migrations.json`. **Depends on**: it feeds off Live claims, which are currently un-servable (see `intel_live_scope_promotion_enabled`), so flipping it alone changes nothing. |
| `layover_place_dwell_enabled` | capability | **row absent** | WRITE. Dwell rows for layover places. `artifacts/api-server/src/services/airport/LayoverPlaceDwell.ts:57`; route note `artifacts/api-server/src/routes/airport.ts:4213`; seed `migrations/3465_layover_consumer_flags.sql:52` | seeded OFF by 3465 | **MIGRATION** — needs `3465_layover_consumer_flags.sql` **and** `3466_layover_place_dwell.sql`; neither is in the applied list and `layover_place_dwell` is **absent** from the production snapshot. |
| `layover_snapshot_consumers_enabled` | capability | **row absent** | READ. Lets other lanes consume the certified layover snapshot. `artifacts/api-server/src/services/airport/LayoverSnapshot.ts:740`; seed `migrations/3465_layover_consumer_flags.sql:47` | seeded OFF by 3465 | **MIGRATION** — `3465_layover_consumer_flags.sql`, not applied. |
| `layover_decision_persistence_enabled` | capability | **row absent** | WRITE. The §20 decision ledger. `artifacts/api-server/src/services/layover/LayoverDecisionStore.ts:144`; seed `migrations/2992_layover_decision_record_and_operational_tables.sql:752` | 2992 sets an explicit 5-step order and says "ONLY THEN flip `layover_decision_persistence_enabled` to TRUE" (`migrations/2992_…sql:265`) | **MIGRATION** — `2992_layover_decision_record_and_operational_tables.sql` is not applied, and the snapshot confirms `layover_decisions`, `layover_time_budgets`, `layover_return_plans`, `layover_certified_computations`, `layover_checkpoints` and `layover_constraints` are all **absent** from production. This is the largest unapplied block in the domain. |
| `layover_presence_ladder_enabled` | capability | **row absent** | READ. Presence ladder in the Layover people section. `artifacts/api-server/src/routes/airport.ts:2235, 3381`; seed `migrations/2740_layover_presence_ladder_flag.sql:10` | seeded FALSE by 2740 | **MIGRATION** — `2740_layover_presence_ladder_flag.sql` is not in the applied list. |

#### `LAYOVER_ROUTED_CORRIDOR_ENABLED` — an env var, not a flag row

Verified: it is read from the environment, not from `feature_flags`.
`artifacts/api-server/src/lib/providers/googleRoutesCorridorProvider.ts:100`
(`export const ENABLEMENT_ENV = "LAYOVER_ROUTED_CORRIDOR_ENABLED"`), with the
two-gate contract described at
`artifacts/api-server/src/lib/providers/corridorTravelTimeAdapter.ts:85` and
consumers at `artifacts/api-server/src/services/airport/LayoverTravelTime.ts:77` and
`LayoverReturnCorridor.ts:38`.

**CONFIG** — Chelsi must supply **`LAYOVER_ROUTED_CORRIDOR_ENABLED`** *and*
**`GOOGLE_MAPS_API_KEY`**; the provider refuses unless both are present. Without it
every landside travel time is a straight-line estimate
(`straightLineTravelTimeProvider`), which is also why 2977's L1 rung is unreachable.

---

### 2. MAP

| flag | polarity | prod | gates | why off | to turn on |
|---|---|---|---|---|---|
| `map_search_enabled` | capability | **true** | READ. `artifacts/api-server/src/routes/mapSearch.ts:154` | n/a | **FLAG FLIP ONLY — already on** |
| `map_compass_commands_enabled` | capability | **true** | READ. `artifacts/api-server/src/routes/mapSearch.ts:304` | n/a | **FLAG FLIP ONLY — already on** |
| `map_telemetry_retention_enabled` | capability | **true** | Background job (retention sweep over `map_telemetry_events`). `artifacts/api-server/src/lib/intelRetentionScheduler.ts:147`, pass at `:585` | n/a | **FLAG FLIP ONLY — already on** |
| `map_telemetry_enabled` | capability | **false** | WRITE (analytics only). Off ⇒ `POST /api/map/telemetry` answers `{ok:true,accepted:0,enabled:false}` and the client keeps queueing locally; nothing is collected and, per the long comment, nothing is written to `map_telemetry_drops` either. `artifacts/api-server/src/routes/mapTelemetry.ts:167` | the contract from `2202_map_telemetry.sql`, quoted in place at `artifacts/api-server/src/routes/mapTelemetry.ts:184`–`:187`: "OFF by default: the route answers `{ ok: true, accepted: 0, enabled: false }` … Nothing is collected until switched on." | **DECISION** — Q: do we want map interaction telemetry collected from hosted testers? RECOMMENDED: **leave off**. Reason: it collects no product capability, the client loses nothing (it queues locally), and 2202 states "off by default" as a privacy contract rather than a rollout step. `map_telemetry_events`, `map_telemetry_drops` and `map_telemetry_disabled_discards` are all present in the snapshot, so it is a pure flip if the answer is yes. |
| `map_trip_projection_read_enabled` | capability | **false** | READ. The trip read-model on the map. Flag constant `artifacts/api-server/src/lib/mapProjectionTripContract.ts:99`; reader `artifacts/api-server/src/lib/mapProjectionTripRead.ts:12`; reached through the capability definition, not a literal read site (see `artifacts/api-server/src/lib/capability/registry.ts:224`–`:239`) | `migrations/2610_map_trip_projection_anchor.sql:182` seeds it FALSE | **FLAG FLIP ONLY**, with one note. `2610_map_trip_projection_anchor` **is** in `production-applied-migrations.json` and `trip_map_projections` **is** in the snapshot. ⚠ `registry.ts:236`–`:238` says "production has no row for `map_trip_projection_read_enabled` and no `trip_map_projections` table" — **that comment is now stale on both counts** (`prod-sorted.txt:138` has the row at 0; the snapshot has the table). **Depends on**: `trip_map_projection_worker_enabled` (=0, another section's) must be on or the projection table will be empty. |
| `map_projection_enabled` | capability | **row absent** | READ gateway. Fail-soft: answers `enabled:false`, client falls back. `artifacts/api-server/src/routes/mapProjection.ts:472`; temporal twin `artifacts/api-server/src/routes/mapProjectionTemporal.ts:429`; client `travel-buddy-standalone/src/hooks/useMapEntities.ts:786` | seeded FALSE by `migrations/2201_map_projection_flag.sql:17` | **MIGRATION** — `2201_map_projection_flag.sql` is not in the applied list. It is the parent of the six rows below. |
| `map_contributions_enabled` | capability | **row absent** | WRITE. `artifacts/api-server/src/routes/mapObservations.ts:738`; client `travel-buddy-standalone/src/components/map/LivePlaceSheet.tsx:183`, `travel-buddy-standalone/src/features/map/interaction/longPress.ts:357` | seeded FALSE by `migrations/2216_map_observations.sql:86` | **MIGRATION** — `2216_map_observations.sql` not applied; `map_observations` is **absent** from the snapshot. **Depends on**: `intel_capture_quick_signal` (=1, satisfied) — the client requires both. |
| `map_crowd_flow_enabled` | capability | **row absent** | READ layer. `artifacts/api-server/src/routes/mapProjection.ts:878`, `artifacts/api-server/src/routes/mapProjectionTemporal.ts:221`; producer `artifacts/api-server/src/lib/crowdFlowProducer.ts:265` | `migrations/2218_crowd_flow.sql:58` seeds FALSE; `artifacts/api-server/src/lib/crowdFlowProducer.ts:234` lists it as reason 1 of why nothing flows | **MIGRATION** — `2218_crowd_flow.sql` not applied; `crowd_flow` **absent** from the snapshot. The producer itself derives from `intel_observations` + `route_plans`/`route_stops`/`route_legs`, which all exist, so the corpus is not the blocker — the output table is. **Depends on**: `map_projection_enabled`. |
| `map_display_resolver_enabled` | capability | **row absent** | READ (ordering/clutter). `artifacts/api-server/src/routes/mapProjection.ts:541`; module `artifacts/api-server/src/lib/mapDisplayResolver.ts:49` | seeded OFF by `migrations/2350_map_sensing_projection_flags.sql:86` | **MIGRATION** — `2350_map_sensing_projection_flags.sql` not applied. **Depends on**: `map_projection_enabled`. |
| `map_experience_state_enabled` | capability | **row absent** | READ (fold + stamping). `artifacts/api-server/src/routes/mapProjection.ts:539`, `artifacts/api-server/src/routes/mapProjectionTemporal.ts:659`; `artifacts/api-server/src/lib/mapProjection.ts:689` | seeded OFF by `migrations/2350_…:76` | **MIGRATION** — 2350. **Depends on**: `map_projection_enabled`; and its content comes from Live claims, which are un-servable today. |
| `map_world_moments_enabled` | capability | **row absent** | READ. `artifacts/api-server/src/routes/mapProjection.ts:540`; producer `artifacts/api-server/src/lib/mapProducers/worldMomentProducer.ts:54` | seeded OFF by `migrations/2350_…:81` | **MIGRATION** — 2350; also `world_pulse_cells` and `map_world_moments` are **absent** from the snapshot. **Depends on**: `map_projection_enabled`. |
| `map_world_intelligence_enabled` | capability | **row absent** | READ. `artifacts/api-server/src/lib/mapProducers/cityModelProducer.ts:395`, `artifacts/api-server/src/lib/mapProducers/personalCityProducer.ts:265` | seeded FALSE by `migrations/2295_map_world_intelligence_flag.sql:77` | **MIGRATION** — `2295_map_world_intelligence_flag.sql` not applied. Its two source tables (`compass_city_models`, `passport_stamps`) **are** in the snapshot, so this one is only a flag-row + schema-flag migration away. **Depends on**: `map_projection_enabled`. |

---

### 3. INTEL / SENSING

| flag | polarity | prod | gates | why off | to turn on |
|---|---|---|---|---|---|
| `intel_capture_quick_signal` | capability | **true** | WRITE. Root of `INTEL_FLAG_DEPENDENCIES` (`artifacts/api-server/src/lib/intelContracts.ts:764`); read by `liveClaimRead.liveLabelsServable` at `artifacts/api-server/src/lib/liveClaimRead.ts:314` and by the map contribution client | n/a | **FLAG FLIP ONLY — already on** |
| `intel_claim_projection_crowd` | capability | **true** | Background job (projection). `artifacts/api-server/src/lib/liveClaimRead.ts:313`; scheduler `artifacts/api-server/src/lib/intelPromotionScheduler.ts:115` | n/a | already on. **Depends on**: `intel_capture_quick_signal` (satisfied) |
| `intel_live_label_crowd` | capability | **true** | READ. `artifacts/api-server/src/lib/liveClaimRead.ts:312` | n/a | already on — **but serving nothing**, see `intel_live_scope_promotion_enabled` |
| `intel_limited_live` | capability | **true** | READ (IG-09 pilot master switch). `artifacts/api-server/src/lib/liveClaimRead.ts:316` | n/a | already on — **but serving nothing**, same reason |
| `disable_intel_live_labels` | **KILL SWITCH** | **false** (not engaged) | READ. Global emergency stop over Live labels, read with inverted failure polarity so a DB error ENGAGES it. `artifacts/api-server/src/lib/liveClaimRead.ts:315`, `artifacts/api-server/src/routes/intelApi.ts:36` | n/a — correct resting state | **nothing to do**. ⚠ Do not "turn it on" for testing: enabled=true means STOP. Row seeded by `migrations/2168_intel_limited_live_flags.sql:53`. |
| `intel_trail_followup` | capability | **true** | WRITE/prompt. `artifacts/api-server/src/lib/intelContracts.ts:746`; dependency `intel_capture_quick_signal` | n/a | already on |
| `intel_missions` | capability | **true** | WRITE (mission generation). `artifacts/api-server/src/services/intel/CoverageService.ts:27, 58` | n/a | already on, **but dark**: generation only runs inside the `intel_coverage` pass, which is off. **Depends on**: `intel_coverage`. |
| `intel_rewards` | capability | **true** | WRITE (reward ledger + reversals). `artifacts/api-server/src/services/intel/RewardService.ts:17`, `artifacts/api-server/src/services/ledger/RewardReversal.ts:59` | n/a | already on. **Registered schema capability** — `artifacts/api-server/src/lib/capability/registry.ts:179`–`:191` requires `2900_intel_reward_ledger_reversals.sql`, which **is** in the applied list, and `intel_reward_ledger` is in the snapshot. Safe. |
| `intel_retention_sweep_enabled` | capability | **true** | Background job (expired-snapshot purge). `artifacts/api-server/src/lib/intelRetentionScheduler.ts:350`, pass at `:582` | n/a | already on |
| `intel_coverage` | capability | **false** | Background job. See §0 Q4. `artifacts/api-server/src/lib/intelCoverageScheduler.ts:29` | `migrations/2181_intel_coverage_snapshots.sql:75` seeds FALSE; "SHADOW: no client-facing surface; snapshots are admin-only" (`intelCoverageScheduler.ts:16`) | **MIGRATION** — `intel_coverage_cells` is **absent** from the production snapshot (`intel_coverage_snapshots` is present), so `2181_intel_coverage_snapshots.sql` is at best partially applied there; it is not in `production-applied-migrations.json`. Flipping the flag against a missing table would make the pass error every 10 minutes. |
| `intel_presence_verification_enabled` | capability | **false** | WRITE-quality. See §0 Q4. `artifacts/api-server/src/services/intel/IntelCaptureService.ts:307` | `artifacts/api-server/src/services/intel/IntelCaptureService.ts:265`–`:267`: off ⇒ "the capture path is byte-identical to before this unit landed"; no stated owner reason beyond caution | **FLAG FLIP ONLY**. `2276_intel_presence_verification` **is** in the applied list and `intel_presence_verifications` **is** in the snapshot. Worth turning on for hosted testing: it is the only way a tester's contribution can earn a verified presence rung, and it can only ever *lower* a claim. **Depends on**: `intel_capture_quick_signal` (satisfied). |
| `intel_contribution_retention_enabled` | capability | **false** | Background job, irreversible deletion. See §0 Q4. `artifacts/api-server/src/lib/intelRetentionScheduler.ts:395` | `artifacts/api-server/src/lib/intelRetentionScheduler.ts:382`–`:386`: "Separate flag from the snapshot sweep … because this is IRREVERSIBLE deletion of contributor data, not recomputable hygiene" | **DECISION** — Q: should a hosted-testing deployment irreversibly delete actor-linked intel contributions older than 180 days? RECOMMENDED: **leave off for hosted testing**. Reason: a test corpus is young, so the sweep would delete nothing while adding an irreversible-deletion job to a deployment people are poking at; turn it on with the real launch. (It also calls `purge_intel_contributions_older_than`, an RPC I did not verify exists in production.) |
| `intel_compass_rhythm_actor_gate` | capability | **false** | READ (Compass prose). See §0 Q4. `artifacts/api-server/src/compass/CompassGraphEngine.ts:1789` | `artifacts/api-server/src/lib/compassRhythmGate.ts:19`–`:22`: "Deploying this SUPPRESSES it until (a) the graph build records a per-slice distinct-actor count and (b) an owner enables `intel_compass_rhythm_actor_gate`" | **FLAG FLIP ONLY** — prerequisite (a) is now **satisfied**: `buildCityWorldModels` records `distinctActors` per slice at `artifacts/api-server/src/compass/CompassGraphEngine.ts:1158` (assembled at `:1077`–`:1090`), and `compass_city_models` / `compass_graph_edges` are both in the production snapshot. That header sentence is stale. Caveat: the line still needs ≥ `COMPASS_RHYTHM_K` = 5 distinct contributors per slice (`artifacts/api-server/src/lib/compassRhythmGate.ts:34`), which a small hosted test will not reach — so flipping it is safe but may change nothing visible. |
| `intel_live_scope_promotion_enabled` | capability | **false** | WRITE (the Live allowlist) — and therefore the real gate on every Live READ. See §0 Q4. `artifacts/api-server/src/lib/intelLiveScopePromotion.ts:62`; expiry `artifacts/api-server/src/lib/intelPromotionScheduler.ts:115`; state machines `artifacts/api-server/src/lib/stateMachines/registry.ts:727, 742, 758` | seeded FALSE by `migrations/2430_intel_live_scope_promotion_writer.sql:353` | **FLAG FLIP ONLY** — `2430_intel_live_scope_promotion_writer` **is** in `production-applied-migrations.json` and `intel_live_promoted_scopes` **is** in the snapshot, so the three SECURITY DEFINER writers exist. **This is the highest-value single flip in the whole domain**: it is what makes `intel_limited_live`, `intel_live_label_crowd`, `intel_claim_projection_crowd` and `intel_capture_quick_signal` — four flags already on — actually produce a Live label. |
| `intel_live_scope_admin_surface_enabled` | capability | **row absent** | READ/WRITE (admin). `artifacts/api-server/src/routes/admin.ts:3279, 3307`; the refusal names the missing row at `:3313`; client `travel-buddy-standalone/app/admin/live-scopes.tsx:13` | seeded FALSE by `migrations/2570_intel_live_scope_admin_surface_flag.sql:107` | **MIGRATION** — `2570_intel_live_scope_admin_surface_flag.sql` is not applied. Worth doing alongside the flip above if you want to promote scopes *by hand* rather than wait for the scheduler. |
| `intel_outcome_attribution_enabled` | capability | **row absent** | Background job (attribution of outcomes to contributions; feeds honest reward reversal). `artifacts/api-server/src/lib/intelAttributionScheduler.ts:38`; consumer check `artifacts/api-server/src/lib/intelRewardScheduler.ts:268`; note at `artifacts/api-server/src/services/ledger/RewardReversal.ts:23` | seeded FALSE by `migrations/2277_intel_outcomes_attribution.sql:259` | **MIGRATION** — `2277_intel_outcomes_attribution.sql` not applied; `intel_outcomes` and `intel_attributions` are **absent** from the production snapshot. |
| `intel_safety_candidates_enabled` | capability | **row absent** | READ/WRITE (admin safety-candidate surface). `artifacts/api-server/src/routes/adminSafetyCandidates.ts:76, 104, 184` | seeded FALSE by `migrations/2803_intel_safety_candidates_flag.sql:71` | **MIGRATION** — `2803_intel_safety_candidates_flag.sql` not applied. |
| `sensing_presence_context_enabled` | capability | **row absent** | READ. Compass sensing-presence context. `artifacts/api-server/src/compass/CompassSensingPresence.ts:115`; route note `artifacts/api-server/src/routes/compass.ts:1127` | seeded FALSE by `migrations/3004_sensing_presence_context_flag.sql:71`; `CompassSensingPresenceProducer.ts:38` adds that the flag "MUST NOT be able to" change the privacy posture | **MIGRATION** — `3004_sensing_presence_context_flag.sql` not applied. |
| `sensing_publication_enabled` | capability | **row absent** | Background job (publishes sensing aggregates). `artifacts/api-server/src/lib/sensingPublicationScheduler.ts:62`, gate at `:32` | seeded FALSE by `migrations/3313_sensing_publication_flag.sql:43` | **MIGRATION** — `3313_sensing_publication_flag.sql` not applied, and `sensing_published_aggregates` is **absent** from the production snapshot. |
| `place_provenance_stamping_enabled` | capability | **row absent** | WRITE (adds `source_id` to place rows at insert). `artifacts/api-server/src/lib/placeProvenance.ts:27, 41`; callers `artifacts/api-server/src/lib/places/placeResolve.ts:19`, `artifacts/api-server/src/routes/wishlist.ts:2`, `artifacts/api-server/src/routes/discovery.ts:22` | `artifacts/api-server/src/lib/placeProvenance.ts:16`–`:18`: off "is also the only safe state on any database where 2101's `source_id` column does not yet exist: stamping a column that is not there would fail the write. Flip the flag only after 2101 has been applied" | **MIGRATION** — the `sources` table is **absent** from the production snapshot, so 2101 is not applied there and this flag must stay off. Turning it on would break place writes in Wishlist and Discovery. |

---

### 4. The three things I could not establish

1. Whether the RPCs `purge_intel_contributions_older_than` and
   `purge_expired_intel_snapshots` exist in production. The snapshot has a
   `functions` section I did not enumerate; I am not asserting either way.
2. Whether `2181_intel_coverage_snapshots.sql` was partially applied by hand. The
   snapshot has `intel_coverage_snapshots` but not `intel_coverage_cells`, and
   `production-applied-migrations.json`'s own `$comment` warns it is "a staleness
   tripwire, not an inventory" and that dashboard applies write no row. So "2181 not
   applied" is my reading of two incomplete records, not a measurement.
3. What the mobile app's *default* enabled map layers are. I established the
   fallback mechanism (`useMapEntities.ts:813`–`:829`) but did not read the
   layer-preference default (`map_layer_prefs_v1`), so I cannot say which of
   events/gems/buddies/trips/friends a tester sees on first open without changing a
   toggle.

---

### 5. Not flags — names I checked and rejected (so nobody re-checks them)

**Table names matching `intel_*` / `layover_*` / `map_*` / `sensing_*` / `airport_*`**
(these are `public.<table>` identifiers, never `feature_flags.flag` values):
`intel_claims`, `intel_observations`, `intel_evidence`, `intel_state_snapshots`,
`intel_state_snapshot_versions`, `intel_confirmations`, `intel_attributions`,
`intel_outcomes`, `intel_coverage_cells`, `intel_coverage_snapshots`,
`intel_mission_candidates`, `intel_claim_reviews`, `intel_reward_ledger`,
`intel_presence_verifications`, `intel_historical_patterns`,
`intel_live_promoted_scopes`, `intel_expertise_scopes`,
`intel_contribution_consent`, `intel_consented_contributor_tokens`,
`intel_sensing_credentials`, `intel_sensing_device_eligibility`,
`intel_qiu_cash_pool`, `layover_sessions`, `layover_events`,
`layover_external_events`, `layover_recommendations`, `layover_plan_stops`,
`layover_crews`, `layover_crew_members`, `layover_certified_computations`,
`layover_checkpoints`, `layover_constraints`, `layover_time_budgets`,
`layover_return_plans`, `layover_place_dwell`, `layover_outcomes`,
`map_observations`, `map_pins`, `map_telemetry_events`, `map_telemetry_drops`,
`map_telemetry_disabled_discards`, `airport_profiles`,
`airport_fact_observations`, `sensing_anon_contributions`,
`sensing_contribution_sessions`, `sensing_published_aggregates`,
`crowd_flow`.

**Constraint / index / policy / FK names** (all end up in `pg_constraint` or
`pg_class`, not `feature_flags`): everything of the shape
`*_fkey`, `*_check`, `*_uidx`, `*_idx`, `*_pkey`, `*_no_update_delete`,
`*_stmt`, `*_owner`, `*_read`, `*_unreadable` — e.g.
`intel_claims_observation_id_fkey`, `intel_claims_one_live_per_subject_zone_type`,
`intel_evidence_kind_check`, `intel_reward_ledger_sign_by_role`,
`layover_sessions_airport_id_fkey`, `layover_recs_session_key_uidx`,
`airport_fact_obs_submission_token_uidx`,
`map_telemetry_disabled_discards_bucket_is_hour_check`,
`sensing_anon_features_enums`.

**Event-type / enum / telemetry-name string literals** (vocabulary values written
*into* columns, not flag keys): `airport_observation_reported`,
`airport_country_unknown`, `airport_pulse_not_enabled`, `airport_reentry`,
`airport_only`, `layover_activity`, `layover_suggestion`, `layover_completed`,
`layover_gate_failed`, `layover_replan`, `layover_safe`, `layover_meetup`,
`layover_food`, `layover_session`, `layover_sessions_detected`,
`layover_sessions_evaluated`, `layover_flag_unreadable`,
`layover_timing_unreadable`, `layover_snapshot_unreadable`, `map_open`,
`map_opened`, `map_zoomed`, `map_pin`, `map_entry`, `map_link`, `map_preview`,
`map_public`, `map_failed`, `map_fallback`, `map_disabled`, `map_action_row`,
`map_contract_version`, `map_contribution`, `map_space`, `map_travelers`,
`map_thumbnails`, `map_social_presence`, `map_projection_temporal`,
`map_entity_layers_v1`, `map_layer_prefs_v1`, `crowd_busy`, `crowd_quiet`,
`crowd_rising`, `crowd_level`, `crowd_shift`, `crowd_direction`,
`crowd_trajectory`, `crowd_flow_forecast`, `crowd_mix_music`,
`crowd_unsafe_density`, `crowd_claim_without_observation`,
`sensing_vibe`, `sensing_vibe_v1`, `sensing_live_v1`, `sensing_presence`,
`sensing_anon`, `sensing_anonymous`, `sensing_issuer`,
`sensing_acoustic_permission_v1`, `sensing_session_issue`,
`sensing_session_consume`, `sensing_session_cleanup`,
`sensing_credential_cleanup`, `sensing_revocation_reach`,
`intel_prompt_pause_v1`, `intel_prompt_throttle_v1`, `intel_contributions_v0`,
`intel_contributions_v1`, `sensing_contributions_v2`, `intel_append_only`,
`intel_attribution`, `intel_calibration_daily`, `intel_calibration_report`,
`intel_capture_quick_signal` (**this one IS a flag — listed here only to say it is
not one of the rejects**), `intel_contributor_token`, `intel_scoped_trust`,
`intel_pattern_learning`, `intel_movement_prediction` and `intel_external_api`
(declared in `INTEL_FLAGS` at `artifacts/api-server/src/lib/intelContracts.ts:747`,
`:752` but with **no read site** I could find and **no production row** — treat as
declared-but-unwired, not as a live gate), `intel_outcome_success`,
`intel_materially_incorrect_confident`, `intel_retention_sweep` /
`map_telemetry_retention` / `intel_contribution_retention` (these three are
`RETENTION_PASSES[].name` values at
`artifacts/api-server/src/lib/intelRetentionScheduler.ts:581`–`:588`, **not** the
flags — the flags are the `_enabled` siblings).

**Env vars, not flag rows:** `LAYOVER_ROUTED_CORRIDOR_ENABLED`,
`LAYOVER_EVENT_PRODUCER_SECRET`, `LAYOVER_CREW_EXPIRY_BATCH_SIZE`,
`LAYOVER_CREW_EXPIRY_SWEEP_INTERVAL_SECONDS`, and the `LAYOVER_CUTOVER_*` family
(`_APPLIED`, `_COTOUCHERS`, `_MEASUREMENT`, `_MIGRATION_DIR`, `_ROLLBACK_DIR`,
`_SNAPSHOT`, `_SRC`) — all cutover-script inputs in
`artifacts/api-server/src/scripts/lib/`.

**Retired flags with no readers** (deleted by
`artifacts/api-server/src/migrations/2962_retire_unread_sensing_flags.sql`, and
suppressed from both the admin surface and the mobile flag payload —
`artifacts/api-server/src/routes/admin.ts:669`–`:670`,
`artifacts/api-server/src/routes/featureFlags.ts:41`):
`intel_sensing_credentials_enabled`, `intel_sensing_device_enrollment_enabled`.
Do not wire these: 2962's header (`:16`–`:31`) rules that
`lib/sensingAuthPosture.ts` forbids any runtime flag from flipping the sensing
posture, and that the enrollment route would create an identity-to-device link at
rest. **Settled — do not reopen.**

**`airport_buddies_enabled`** — rejected. Its only occurrence in the tree is a
fixture string at `artifacts/api-server/src/test/blockGateFailClosedRoutes.test.ts:168`.
No read site, no production row. Not a live flag.

**Rejected: 147 of the 198 domain-prefixed string literals I harvested from the
tree.** Breakdown: 47 table names, 28 constraint/index/policy names, 56
vocabulary / telemetry-event / version-tag literals, 11 env vars, 2 retired
flags, 1 test-only fixture, and 2 declared-but-unwired names
(`intel_movement_prediction`, `intel_external_api`). **51 names survived as real
flag keys**, and those are the ones tabulated in §1-§3.

One more declared-but-unwired name, for completeness: **`intel_qiu_cash_pool`**
is declared in `INTEL_FLAGS` (`artifacts/api-server/src/lib/intelContracts.ts:755`)
with `intel_missions` as its dependency (`:771`) but has **no read site outside
that declaration and no production row**. It is the cash half of the rewards
system; treat it as not built rather than as an off gate, and do not seed it.
## 06 — Safety, location sharing, trip crew, background jobs & retention

Read-only. Every line/path cited was opened in this session. Paths are relative to
`artifacts/api-server/` unless stated. Production values are from
`scratchpad/flags/prod-sorted.txt` (capture 2026-10-03). "Row absent" means the flag
has **no row at all** in production, which `isFlagEnabled` reads as off
(`src/lib/featureFlags.ts:14-25`) but which is a *different state* from an explicit
`false`.

---

### 0. Overlap and ownership — read this first

**Owned by the story-retention thread**, per
`/mnt/project-files/background-jobs-what-breaks-when-the-host-sleeps-2026-10-03.md`:

- The scheduler-health disclosure, `GET /healthz/schedulers`, `job_health`, the
  2026-09-30 → 2026-10-02 54-hour stoppage of all 58 timers, branch
  `claude/project-thread-3gbh92`, draft **PR #561**.
- The story retention scheduler, story purge, media cleanup.
- The classification of the 46 unreported jobs, the eight lossy ones, and the
  window-shape fixes.
- **The two privacy sweeps already reported there as switched off are
  `media_pending_upload_sweep_enabled` (row absent) and
  `location_snapshot_purge_enabled` (row absent)** — that document, §4, first
  bullet. I do not re-derive them; `location_snapshot_purge_enabled` falls inside
  my domain too, so §5.2 below adds only what that document does not cover (what
  accumulates, and a stale claim in the scheduler's own header).

**Owned by another agent — not covered here:**

- `intel_retention_sweep_enabled` (**TRUE** in production). The layover/intel agent
  owns every `intel_*` flag. **Overlap noted and skipped.** For the record only: it
  is read at `src/lib/intelRetentionScheduler.ts` alongside my two sweeps in the same
  scheduler's pass table (`:584-586`), so the three share one timer.
- `memory_location_precision_enabled` — skipped, another agent's.

**Not feature flags at all** (see §7): `hotel_blur_enabled`, `ghost_mode_enabled`,
`age_restriction_enabled`, `open_to_plans_enabled`.

**Retired rows** (see §6): `notifications_enabled`, `notification_digests_enabled`,
`realtime_activity_enabled`, `safety_notifications_enabled`.

---

### 1. The headline answer: does friend location sharing work in production today?

**Partly — and there is no single master flag, because there are three unrelated
location-sharing features with three separate flag families and three separate
storages.** The brief's premise ("`locate_friends_enabled` is FALSE while
`trip_crew_*` and `safe_return_live_share_enabled` are TRUE") is not a
contradiction: those flags do not gate the same feature.

`src/lib/locateFriendsSession.ts:40-61` states this explicitly — "Two
temporary-location-share implementations already ship in this server and **NEITHER
is reusable here**".

| Feature | Scope | Flags (prod) | Works today? |
|---|---|---|---|
| **Trip Crew location** | Trip-scoped, standing crew relationship, per-trip preference row | `trip_crew_map_enabled`=TRUE, `trip_crew_live_share_enabled`=TRUE, `trip_crew_ghost_mode_enabled`=TRUE | **YES** |
| **Locate My Friends** (Map §12) | Ad-hoc group (trip/circle/event/plan), ≤12h, opt-in | `locate_friends_enabled`=**FALSE** | **NO** (except LEAVE) |
| **Safe Return live share** | 1:N, one sharer → named emergency contacts | `safe_return_enabled`=TRUE, `safe_return_live_share_enabled`=TRUE | Routes open; see §3 on the escalation job |

#### The real master of each, with the gates

**Trip Crew — the master is `trip_crew_map_enabled`, not the live-share flag.**
It is read at six non-test sites and every crew *read* goes through one of them:

- `src/routes/tripCrewLocation.ts:295` — `GET /api/trips/:tripId/crew/map`
  (READ; off ⇒ `{featureEnabled:false, members:[], totalCount:0}`)
- `src/domain/trips/projections/TripMapCrewPresence.ts:30,39` — Trip Map crew layer (READ)
- `src/domain/trips/projections/TripPulseCrewPresence.ts:39-40` (READ)
- `src/domain/trips/projections/TripTodayProjection.ts:195,212` (READ)
- `src/domain/trips/services/TripReplanService.ts:86-87` (READ)
- `src/compass/CompassTools.ts:1596-1597` (READ, via `isKernelFlagEnabled`)
- `src/server/trips/readRoutes/tripProjections.ts:763-766` (READ)

`trip_crew_live_share_enabled` is read at **exactly one site** —
`src/routes/tripCrewLocation.ts:453`, `POST .../crew/live-share/start` (WRITE).
It gates *starting* a share, nothing else. `GET .../crew/live-shares` and the
`exactCoords` consumption in `TripCrewLocationService.getCrewMap` sit behind
`trip_crew_map_enabled` only. So turning `trip_crew_live_share_enabled` off would
stop new grants and leave existing ones serving exact coordinates.

`trip_crew_ghost_mode_enabled` is read at `src/routes/tripCrewLocation.ts:381`
(and the matching disable handler) — WRITE only, the ghost-mode toggle.

**Locate My Friends — `locate_friends_enabled` masters only the §12 feature.**
Three of its four endpoints refuse while it is FALSE:

- `src/routes/locateFriends.ts:521` — `POST /api/locate-friends/sessions` (WRITE)
- `src/routes/locateFriends.ts:576` — `POST .../sessions/:id/position` (WRITE)
- `src/routes/locateFriends.ts:623` — `GET .../sessions/:id` (READ)
- `src/routes/locateFriends.ts:656` — `DELETE .../membership` is **deliberately
  ungated**: "a capability switch that can strand an opted-in member inside a
  session they cannot leave is worse than the feature being on"
  (`src/routes/locateFriends.ts:41-47`, `src/lib/locateFriendsSession.ts:105-110`,
  `src/migrations/2219_locate_friends_sessions.sql:306-308`).

Refusals are **fail-soft** — an explicitly-disabled envelope, not an error
(`src/lib/locateFriendsSession.ts:100-104`). The router is mounted
(`src/routes/index.ts:143,322`), so the endpoints exist and answer "off".

There is a second, independent consumer: the Passport §5 `with_crew` signal, gated
by **three** gates in order, all fail-closed
(`src/services/passport/PassportProjectionService.ts:1840-1861`): consumer contract →
viewer's §23/TABLE 24 location gate → `capability = locate_friends_enabled ON &&
2219 schema ready` (`:1878-1903`, registry entry
`src/lib/capability/registry.ts:120-139`). **2219 IS applied to production**
(`src/lib/capability/production-applied-migrations.json`, version `20260908013420`),
so this capability is off purely on the flag, not on schema.

**Cross-cutting kill switch — `disable_location_sharing`, FALSE (not engaged).**

#### CODE — `disable_location_sharing` does not cover the live-share paths its own description claims

Seeded by `src/migrations/0065_phase7_safety.sql:86` as *"Emergency: freeze location
sharing **and live-share updates**"*. It is read, correctly through
`isKillSwitchEngaged` (error ⇒ engaged), at **three sites and only three**:

- `src/routes/location.ts:169` — `POST /api/me/location-state` (WRITE; and
  `:165-168` treats an absent service client as `unknown` ⇒ 503)
- `src/lib/circleLocationsRead.ts:125` — circle locations (READ)
- `src/services/telegraph/reachablePeopleQuery.ts:255` — reachable-people serve
  path (READ; answers `viewerInvisible + degraded`, never a plain empty list)

It is **not** read by `src/routes/tripCrewLocation.ts`, `src/routes/locateFriends.ts`,
or the Safe Return live-share handlers. Engaging it today would **not** freeze trip-crew
live share, the crew map, §12 position publishing, or Safe Return live share. The fix
is three or four added `isKillSwitchEngaged` calls at the live-share/position write
and serve sites. This is a gap between a kill switch's stated blast radius and its
real one, which matters most at the moment somebody reaches for it.

#### One stale document to be aware of

`docs/architecture/on-and-dead-flag-matrix.md:78-85` records an open **class-B**
defect: `routes/safeReturn.ts` reaching `PassportProjectionService`'s locate-friends
read "**without gating on `locate_friends_enabled`**". **That has since been fixed in
the tree** — Safe Return now declares `crewSignal: "excluded"` so the read never
happens on its path at any flag value
(`src/services/passport/PassportProjectionService.ts:1843-1849`, `:2065-2075`;
pinned by `src/test/safeReturnLocateFriendsBoundary.test.ts:20-36`). The matrix is
dated 2026-09-08 and says so itself (`:11`). **No action; do not re-open it.**

---

### 2. Safe Return flags

| flag | polarity | prod |
|---|---|---|
| `safe_return_enabled` | capability (master) | **true** |
| `safe_return_live_share_enabled` | capability (child) | **true** |
| `safe_return_trusted_circle_alerts_enabled` | capability (child) | **true** |
| `safe_return_admin_logs_enabled` | capability (admin surface) | **true** |
| `layover_safe_return_status_enabled` | capability | **false** |

**`safe_return_enabled`** — master. Gates every user-facing route in
`src/routes/safeReturn.ts` (suggest `:171`, create `:320`, start `:463`, active
`:494`, extend `:524`, confirm `:560`, cancel `:670`, trigger-missed `:704`,
live-share start `:819` / stop `:916`, contact passport `:950`, history) — READS and
WRITES — and the escalation job at `src/lib/safeReturnScheduler.ts:79`. This route
file uses a **three-state** flag read: `on` / `off` / `unknown`, with `unknown`
answering a retryable degraded error instead of "feature does not exist"
(`src/routes/safeReturn.ts:124`, `:171-172`).
**Why off: n/a — it is ON.** Both seeding migrations seed it FALSE
(`src/migrations/0037_feature_flags.sql:46`,
`src/migrations/0166_feature_flags_reconcile.sql:16`) and an operator later enabled
it; `src/lib/stateMachines/registry.ts:1533-1546` is explicit that the seeded default
is not production's value. **To turn on: already on — `FLAG FLIP ONLY` (nothing).**

**`safe_return_live_share_enabled`** — child. Gates `POST .../live-share/start`
(`:824`, WRITE) and `GET .../contacts/:userId/live-location` (`:955`, READ). Note
`.../live-share/stop` (`:916`) gates on the **master only**, deliberately: stopping a
share must work when the child flag is switched off. **Depends on:**
`safe_return_enabled`. **To turn on: already on.**

**`safe_return_trusted_circle_alerts_enabled`** — child. Gates the trusted-circle
escalation fan-out, at `src/routes/safeReturn.ts:763` (manual trigger-missed) and
`src/lib/safeReturnScheduler.ts:107` (the job). Off ⇒ a missed check-in escalates but
no trusted contact is notified. **To turn on: already on.**

**`safe_return_admin_logs_enabled`** — admin-only surface. Gates
`GET /admin/safe-return/logs` and two siblings
(`src/routes/admin.ts:1023-1032` helper, used at `:1043`, `:1070`, `:1102`) — READS.
Note this helper is a **shadow reader**: it is a local `isFlagEnabled` that is *not*
the shared one, and it does not distinguish `unknown` (`:1032` `catch { return false }`).
Off/unreadable ⇒ an admin investigating a live safety incident is told the logs
feature is not enabled. Lower stakes than the serve paths, but the same shape the
rest of this file documents as a defect. **To turn on: already on.**

**`layover_safe_return_status_enabled`** — FALSE; seeded FALSE by 2741 per
`src/services/airport/LayoverSafeReturnService.ts:272`. Layover-domain; flagged here
only because of the name. Likely the layover agent's; I did not trace its readers.

---

### 3. `safe_return_enabled` is TRUE — does its scheduler actually run? **CANNOT ESTABLISH.**

**What I can establish from the code.**

- `startSafeReturnScheduler()` is called **unconditionally** at
  `src/index.ts:119`, inside the `app.listen` callback. It is not flag-gated at the
  start site; the flag is read per tick.
- It is a plain in-process `setInterval` at 60 s plus a one-off boot tick after 5 s
  (`src/lib/safeReturnScheduler.ts:287-298`, `POLL_INTERVAL_MS = 60_000` at `:31`).
- Each tick runs `processExpiredSessions()` and `processExpiredLiveShares()` under
  `Promise.allSettled` (`:279-284`).
- Its flag read is three-state and **escalates on `unknown`** rather than standing
  down — `src/lib/safeReturnScheduler.ts:36-44`, `:79`, `:88`: *"safe_return_enabled
  unreadable — escalating anyway rather than silently standing down"*. That is the
  right polarity for a safety job and worth knowing before anyone "fixes" it.
- The session predicate is **fully absolute**, so a gap self-heals: the
  story-retention thread verified this at `SafeReturnService.ts:653-658` and I did not
  re-derive it.

**What I cannot establish, and why.**

Nothing in the repository proves the process is alive in the hosted deployment:

1. The scheduler writes **no `job_health` row** and has **no `/healthz/schedulers`
   entry** — `grep job_health|healthz src/lib/safeReturnScheduler.ts` returns nothing,
   and `src/test/healthSchedulers.test.ts:2` describes that endpoint as covering "ten
   background" schedulers, which do not include this one. There is therefore no
   durable artefact that could distinguish "ticking" from "stopped".
2. There is **no `pg_cron`** and **no HTTP trigger endpoint** for it. Account deletion
   has one (`POST /internal/deletion-requests/execute-due`,
   `src/routes/profile.ts:1913`) and circle presence has one
   (`POST /circle/internal/cleanup-presence`, `src/routes/circle.ts:2198`); Safe
   Return has neither. If the Node process is not running, nothing else does this work.
3. The story-retention thread's document establishes that **all 58 timers in this
   process stopped together on 2026-09-30 15:30 UTC and nothing reported it for 54
   hours**, and that the host is Replit autoscale which suspends after 15 idle
   minutes. So the empirically known state of this scheduler is "it has already been
   silently dead for 54 hours once". That document also notes the three flags
   involved were all TRUE throughout, and that it was harmless only because there
   were 0 sessions and 0 trusted contacts.

**So: `safe_return_enabled` is a flag that is on over a process that may or may not
be running, with no way to tell from inside the system.** For hosted testing, where
section 1 of that document says every count goes above zero on day one, that is the
single highest-consequence item in my domain: what arrives late here is the alert to
an emergency contact that a traveller did not come back.

**Evidence that would settle it** (none of it available to me read-only):

- `GET /api/healthz/schedulers` against the live deployment — would settle whether
  the *process* is up, but **not** whether this scheduler ticks, because it is not
  listed. Adding it, or a `job_health` row, is the fix. → **CODE**.
- The deployment's log stream: a `"SafeReturnScheduler: starting"` line at boot
  (`:289`) and the absence of a long gap in subsequent tick logs. Note a healthy tick
  that finds nothing logs nothing, so silence is ambiguous — which is the defect.
- The Replit deployment type (autoscale vs Reserved VM) from the Replit dashboard.
  Chelsi can read this; I cannot. → **CONFIG**.

**To turn on for hosted testing: `DECISION`.** The flag is already TRUE, so no flip
is needed. The question is: *does Safe Return need sub-minute escalation in hosted
testing, or will minutes do?* **Recommended default: treat sub-minute as required and
put Safe Return on an always-on host** (the story-retention thread's Option A) — a
check-in escalation is the one job in this domain whose value is destroyed by
lateness rather than merely degraded, and it is also the only one with no external
trigger path to fall back on. If that spend is refused, the cheaper second-best is
**CODE**: add an internal HTTP trigger for `tick()` mirroring
`src/routes/profile.ts:1913`, plus a `job_health` row so its silence becomes visible.
This is the same decision the story-retention thread put to Chelsi in its §5; I am
not re-opening it, only confirming that nothing in my domain changes the answer.

---

### 4. `account_deletion_worker_enabled` — FALSE, with metadata

**Polarity:** capability flag, fail-closed. **Production: `false`** — the row exists,
with metadata, so migration 2073 ran.

**The metadata and what it means.** `src/migrations/2073_account_deletion_worker_flag.sql:27-34`:

```
INSERT INTO feature_flags (flag, enabled, description, metadata) VALUES
  ('account_deletion_worker_enabled', false,
   'Scheduled worker that executes due user_deletion_requests. Irreversible; fails closed when off.',
   '{"rollout":"audit-p1-7","irreversible":true}')
```

- `"rollout":"audit-p1-7"` — this flag belongs to **item 7 of the production audit's
  P1 list**. The migration header names the defect it closes
  (`:5-9`): *"a user could request deletion, watch the app count down to their
  scheduled date, and nothing would ever happen unless an admin manually pressed a
  button — the gap the production audit flagged (P1 item 7)"*
  (restated at `src/lib/accountDeletionScheduler.ts:4-9`).
- `"irreversible":true` — declares the gated work unrecoverable. The header spells
  out the cascade (`:6-10`): posts and their media (DB rows **and** Storage objects),
  message ciphertext, identity-verification rows, the auth user (the email address),
  then the profile anonymised to a "Deleted User" tombstone. *"Nothing about that is
  recoverable."*

**Gates — what is not happening.** Both execution paths fail closed:

- `src/lib/accountDeletionScheduler.ts:31` (`FEATURE_FLAG`), checked at `:60`;
  `POLL_INTERVAL_MS` 15 min, `BATCH_LIMIT` 25 (`:29-30`). Its own local
  `isFlagEnabled` (`:33-44`) returns false on error — fail-closed, correct polarity
  here. The scheduler **is** started: `src/index.ts:44,235`.
- `POST /internal/deletion-requests/execute-due` — `src/routes/profile.ts:1923`,
  answering `503 {ok:false, skipped:true, error:"feature_disabled"}`. Gated behind
  `INTERNAL_API_SECRET` (`:1899-1910`, constant-time compare).

So: **rows in `user_deletion_requests` with `status='pending'` whose `scheduled_at`
has passed are never executed.** The user sees the countdown reach zero and nothing
happens. The only working path is the manual admin endpoint
`POST /admin/deletion-requests/:id/execute`, which shares the same cascade
(`2073:14-17`), so enabling the flag "cannot introduce behaviour the manual path has
not already exercised".

A nuance against the story-retention thread's document: it classes account deletion
among the "**late but complete**" jobs (§3, last paragraph) — "a deletion due in the
gap is still carried out". That is true of the job's *query shape*, which is what that
document was assessing. It is not true of the deployment: with the flag FALSE the
deletion is not carried out late, it is not carried out at all. Both statements are
correct about their own subject; a reader of that paragraph alone would get the wrong
impression of production.

**Why off:** `2073:5-9` — "Starts DISABLED on purpose. The worker executes
irreversible deletions with no human in the loop."

**To turn on for hosted testing: `DECISION`.** The migration states the three
preconditions itself (`2073:20-25`): (1) execute one real request through the admin
endpoint and confirm the returned `steps` array is all `ok:true`; (2) confirm the auth
user is gone — `auth.admin.listUsers` must not find the email, "this is the GDPR claim
the privacy policy makes"; (3) then flip. **The question:** do we rehearse one real
deletion through the admin endpoint in hosted testing before enabling the unattended
worker, or stay on the manual path for the whole test? **Recommended default: stay on
the manual admin path for hosted testing and leave the flag FALSE.** Hosted testing
is where a mistaken deletion is most likely and least recoverable, the manual endpoint
already covers the functionality under test, and the only thing the flag adds is
*removing the human*. If Chelsi specifically wants to test the countdown-to-deletion
experience end to end, do the migration's step 1 and 2 first on a throwaway account.
**Depends on:** nothing. **Note:** `location_snapshots` is **not** in the deletion
cascade at all (§5.2) — so even the manual path leaves a coordinate trail behind.

---

### 5. Retention / background-job flags

#### 5.1 `presence_cleanup_enabled` — FALSE

**Polarity:** capability flag, fail-closed. **Production: `false`** (row present).
**Gates a background job**: `runPresenceCleanup` at
`src/lib/intelRetentionScheduler.ts:264`, registered in that scheduler's pass table at
`:586`. Off ⇒ the pass returns `{skipped:true, reason:"disabled"}` and neither of its
two actions runs: marking rows `is_stale` (`:309`) and deleting rows past `expires_at`
(`:318`).

**Why off:** `src/migrations/2957_presence_cleanup_flag.sql:35` — *"disabled by
default until scheduler rollout is verified"*. The code restates it and asks not to be
overridden: `src/lib/intelRetentionScheduler.ts:252-256` — *"GATED ON
presence_cleanup_enabled, WHICH IS FALSE IN BOTH LIVE DATABASES … this pass DELETEs,
so it stays inert until an owner turns it on. Do not change the seeded default to make
the sweep visible."* 2957 is itself a record of a migration applied out of band by a
second writer (`2957:1-30`); its absence from `production-applied-migrations.json` is
not evidence it never ran, and the flag row's presence in production is evidence it did.

**What personal data accumulates.** `circle_presence`
(`src/migrations/0108_circle_schema_tracked.sql:147-166`) holds, one row per user per
trip/event: `status` (including `needs_help`), `status_label`, `approximate_label`,
`venue_label`, `checked_in`, `needs_help`, `last_seen_at`, `stale_after_secs`,
`expires_at`, `is_stale`. `0108:144` states *"No GPS coordinates stored in V1"*, and I
found no coordinate column — so what accumulates is **coarse location labels plus a
safety flag, not coordinates**: an unbounded record of which trips and events a person
was present at, the venue/area label they published, and whether they pressed
"need help".

**It is a retention breach, not a disclosure one — for rows that have an expiry.** The
read path enforces hard expiry independently of the sweep:
`src/lib/circleAccessGuard.ts:337-340` returns `{allowed:false, reason:"presence_expired"}`
when `expires_at` has passed, before anything is served. So an un-swept expired row
costs disk and retention, not exposure.

#### CODE — a `circle_presence` row with `expires_at IS NULL` is never deleted and stays visible forever

`expires_at` is **nullable** (`0108:161`, no default) and the upsert writes it only
when the client supplies one: `src/routes/circle.ts:1137` — `if (expiresAt !== null)
upsertPayload["expires_at"] = expiresAt;`. Both delete passes then skip such rows:
`src/lib/intelRetentionScheduler.ts:300-303` only collects `expired` where
`Number.isFinite(Date.parse(row.expires_at))`, and the internal route's pass filters
`.not("expires_at","is",null)` (`src/routes/circle.ts:2238-2241`). Meanwhile
`circleAccessGuard.ts:337` never fires for a null expiry, so the row falls through to
the **soft** staleness branch — `:342-353`, *"Staleness (soft — still visible, but
flagged)"* — and is still served, indefinitely. The result: a presence row published
without a TTL is both undeletable by any sweep and permanently readable by anyone who
clears the access guard. Flipping `presence_cleanup_enabled` does **not** fix it. The
fix is either a `NOT NULL DEFAULT now() + interval` on the column, or a server-side
default in the upsert, plus an age-based arm in the sweep for legacy nulls.

**An ungated path already exists.** `POST /circle/internal/cleanup-presence`
(`src/routes/circle.ts:2198`) performs the *same* two passes — mark stale `:2217-2234`,
delete expired `:2236-2256` — and consults **no feature flag**, only
`INTERNAL_API_SECRET` with a constant-time compare (`:2200-2208`). It additionally
revokes the fused-store copy of each deleted row (`:2252-2255`, "Owner decision A").
So the retention bound can be enforced in hosted testing today by an external
scheduled caller without flipping the flag — the story-retention thread's "Option B"
pattern, already built here.

**To turn on for hosted testing: `DECISION`.** The question: *do we flip the flag, or
call the existing internal endpoint on a schedule?* **Recommended default: flip the
flag** — it is one UPDATE, the in-process pass is keyset-paginated and capped
(`:273-291`) where the route's version fetches unbounded, and 2957's stated reason for
FALSE ("until scheduler rollout is verified") is satisfied by hosted testing being
exactly that verification. Deletion is irreversible but removes only rows the read
path already refuses. **Depends on:** nothing (it shares a timer with
`intel_retention_sweep_enabled`, already TRUE, so the scheduler is already ticking).

#### 5.2 `location_snapshot_purge_enabled` — ROW ABSENT

**Polarity:** capability flag, fail-closed. **Production: row absent.**
**Already reported by the story-retention thread** (§4, first bullet, which quotes
2129's "Off means raw coordinates are retained indefinitely (the pre-existing
defect)"). Not re-derived. What follows is what that document does not cover.

**Row absent is the finding, not merely "off".** 2129 seeds the row unconditionally
with a postcondition that *fails the migration* if it is missing
(`src/migrations/2129_location_snapshot_purge_flag.sql:60-71`). The row's absence from
production is therefore strong evidence **2129 was never applied there** — and it is
absent from `src/lib/capability/production-applied-migrations.json`. (That file is a
staleness tripwire, not an inventory, per its own `$comment`; but here the missing
flag row is the independent evidence.)

**What personal data accumulates.** `src/services/location/LocationSafetyService.ts:165-172`
INSERTs **raw `lat`, `lng`, `source:"gps"`, `captured_at`** on every location update
and geofence check-in, with `expires_at` defaulting to `now() + 24 hours`. Nothing
deletes them: `purgeExpiredSnapshots` (`:295-307`) has exactly one caller,
`src/lib/locationSnapshotPurgeScheduler.ts:76`, which returns `{purged:0,
skipped:true}` on the absent flag. The scheduler **is** started
(`src/index.ts:139`, with the comment at `:134-138`). The result, in the scheduler's
own words (`:12-18`): *"a permanent, per-user, timestamped precise-coordinate trail
that was invisible to the code that created it (every reader filters it out) and
invisible to account deletion (`location_snapshots` is not in the deletion
cascade)"*. The second half compounds §4: with `account_deletion_worker_enabled` FALSE
*and* this table outside the cascade, a deleted account's coordinate trail survives
both.

#### CODE — the purge scheduler's header understates the table's readers

`src/lib/locationSnapshotPurgeScheduler.ts:20-25` claims *"public.location_snapshots
has exactly three touch points, all in LocationSafetyService.ts"*, and 2129's header
repeats it (`2129:24-31`). **There is a fourth and fifth**:
`src/services/intel/PresenceVerifier.ts:247-256` (`loadDevicePosition`) and
`:274-282` (`checkDwell`) both SELECT `lat, lng, accuracy_meters, captured_at` from
`location_snapshots` with **no `expires_at` filter at all** — they bound on
`captured_at` instead.

**This is a documentation defect, not a live one**, and I checked rather than assumed:
those windows are `POSITION_SLACK_MS = 2 * 60_000` and `DWELL_WINDOW_MS = 3 * 60 *
60_000` (`PresenceVerifier.ts:71,76`) — two minutes and three hours, both well inside
the 24-hour expiry — so no expired row is reachable by either read, and enabling the
purge still changes no result. But the claim as written ("the only reader filters on
`expires_at`") is the justification offered for calling the purge behaviourally
invisible, and it is now false. Anyone widening `DWELL_WINDOW_MS` past 24 h would
silently turn the purge into a behaviour change. Worth correcting the two comments and
adding the `expires_at` filter to both PresenceVerifier reads.

**To turn on for hosted testing: `MIGRATION`.** Apply
`src/migrations/2129_location_snapshot_purge_flag.sql` (production does **not** have
it), then flip the flag. 2129 is additive, idempotent (`ON CONFLICT DO NOTHING`, so a
re-apply cannot switch an owner's TRUE back off, `:51-52`), and has "RUNTIME EFFECT OF
THIS MIGRATION: NONE" (`:37-38`). The first enable deletes the whole accumulated
backlog irreversibly; 2129 supplies the count query to run first (`:35-36`).
**Depends on:** nothing.

#### 5.3 `trip_retention_sweep_enabled` — FALSE

**Polarity:** capability flag, fail-closed. **Production: `false`** (row present; 2792
is in `production-applied-migrations.json`). **Gates a background job**:
`src/server/trips/projectionWorkers/tripRetentionScheduler.ts:27` (`TRIP_RETENTION_FLAG`),
started via `startTripProjectionWorkers()` at `src/index.ts:120` (see the comment at
`:205`). Interval 6 h, startup delay 9 min (`:31-34`). Off ⇒ `{skipped:true,
reason:"disabled"}` and neither RPC is called.

Two documented retention policies go unenforced while it is off:

- `trip_activity_log_prune()` (migration 2789) — trip evidence past `retain_until`.
- `trip_reservations_forget_raw_text()` (migration 2791) — **pasted booking text**
  past `raw_text_retain_until`. This is the one with real personal content in it:
  raw reservation text a traveller pasted in, retained past its declared policy.

Both are service_role-only SQL functions and `src/migrations/2792_trip_retention_sweep_flag.sql:5-8`
states *"NOTHING IN THE DATABASE CALLS THEM: a documented retention nothing enforces
is the defect lib/intelRetentionScheduler.ts records for location_snapshots."*

**Why off:** `2792:36-38` — *"Irreversible deletion of evidence past its policy — the
owner turns it on."* **Both prerequisites are applied to production**
(`2789_trip_activity_log_retention`, `2791_trip_reservation_raw_text_retention` are
both in `production-applied-migrations.json`), which is exactly what 2792's own
precondition block requires (`:27-33`).

**To turn on for hosted testing: `DECISION`.** The question: *may the server start
irreversibly deleting trip evidence and forgetting pasted reservation text on its own
policy clock during hosted testing?* **Recommended default: turn it ON.** The policy
is already declared to users, the prerequisites are applied, and leaving it off means
hosted testing accumulates exactly the raw booking text the policy says it does not
keep. The counter-argument is that hosted-test data is also your debugging record —
if Chelsi wants that record kept, leave it off and accept that the retention promise
is unenforced in the test environment only. **Depends on:** nothing.
*(Minor doc drift: 2792's header and the scheduler's header both cite the file as
`lib/tripRetentionScheduler.ts`; it actually lives at
`src/server/trips/projectionWorkers/tripRetentionScheduler.ts`.)*

#### 5.4 `map_telemetry_retention_enabled` — TRUE

**Polarity:** capability flag — but note its polarity is *inverted in consequence*:
off means data is **retained**, not withheld. **Production: `true`.**
**Gates a background job**: `runMapTelemetryRetentionSweep`,
`src/lib/intelRetentionScheduler.ts:147`, pass table `:585`. It calls
`purge_expired_map_telemetry()` (`:152`), which deletes `map_telemetry_events` and
`map_telemetry_drops` rows past `expires_at` and returns the combined count
(`src/migrations/2960_map_telemetry_retention.sql:143-145`).

**This is the only flag in my domain seeded TRUE on purpose, and the reasoning is
worth quoting** — `src/lib/intelRetentionScheduler.ts:127-138`: *"The usual house
instinct — ship an irreversible DELETE switched off — is the wrong polarity for a
RETENTION control … A collection flag shipped off withholds a capability; a retention
flag shipped off declares a 90-day privacy promise and then does not keep it."*
2960 seeds it `TRUE` with `ON CONFLICT DO UPDATE SET enabled = TRUE` (`:146-153`) and
a postcondition asserting it is present and TRUE (`:177-182`). 2960 **is** applied to
production. Collection (`map_telemetry_enabled`) is FALSE and both tables held 0 rows
in both environments at the time of that note (`:119-124`), so the purger deletes
nothing today and is already enforcing on the day collection is switched on.

**To turn on for hosted testing: `FLAG FLIP ONLY` (nothing needed — already on).**
**Depends on:** nothing. Flag it as the reference precedent if anyone proposes seeding
another retention control FALSE.

---

### 6. Trip, plan and availability flags

| flag | polarity | prod | gate type |
|---|---|---|---|
| `trip_crew_map_enabled` | capability | **true** | READ (7 sites, §1) |
| `trip_crew_live_share_enabled` | capability | **true** | WRITE (1 site, §1) |
| `trip_crew_ghost_mode_enabled` | capability | **true** | WRITE (§1) |
| `trip_absence_guard_enabled` | capability (privacy guard) | **false** | READ shaping |
| `trip_readiness_enabled` | capability | **true** | READ/WRITE |
| `trip_retention_sweep_enabled` | capability | **false** | background job (§5.3) |
| `plan_geofence_enabled` | capability | **true** | READ+WRITE |
| `plan_geofence_full_enabled` | capability | **true** | **nothing — no readers** |
| `open_to_plans_windows_enabled` | capability | **false** | READ+WRITE |
| `open_to_plans_enabled` | **not a flag** | row absent | — |
| `nearby_reachable_enabled` | capability | **row absent** | READ |

**`trip_absence_guard_enabled` — FALSE.** Gates `src/lib/privacy/absenceDisclosure.ts:23`
(`ABSENCE_GUARD_FLAG`); the function returns `withholdDates:false` immediately when
off (`:41-43`). It shapes a READ: the §6.3 public trip preview. **What is happening
while it is off:** a public trip's preview carries `startDate`/`endDate` to anyone,
and `trips.show_exact_dates` defaults TRUE (0077) with the client sending `true` when
unset — so *"by default a public trip announced, to anyone, the dates its owner would
be away from home"* (`absenceDisclosure.ts:5-10`). That is census-trips **TR119**,
quoted in `src/migrations/2790_trip_absence_guard_flag.sql:3-8`. With the guard on, a
*future* trip withholds both dates from non-members whatever the toggle says, and says
so on the wire (`datesWithheld: "future_absence"` / `TRIP_PRIVACY_FUTURE_ABSENCE`);
past and current trips keep following the toggle (`:50-57`). **Why off:** `2790:19-21`
— *"with the flag FALSE the preview is byte-for-byte what it was. Turning it on is the
owner's call."* 2790 is applied to production.
**To turn on: `DECISION`.** *Should a public trip preview stop showing a future trip's
dates to non-members, even for hosts whose `show_exact_dates` is true?* **Recommended
default: turn it ON for hosted testing.** The toggle cannot distinguish "opted in"
from "never asked" (the migration's own argument), the disclosure is "this person's
home is empty on these dates", and the change is additive and reversible — unlike
every other item in this section, nothing is deleted. The cost is that testers see
fewer dates on public previews, which is the behaviour under test.
**Depends on:** nothing.

**`trip_readiness_enabled` — TRUE.** `src/domain/trips/services/tripReadiness.ts:21`
(`READINESS_FLAG`), read at `src/routes/tripReadiness.ts:274` and `:330` — READ and
the recompute WRITE into `trip_readiness_items`. Seeded FALSE by
`src/migrations/0170_trip_readiness.sql:76`; an operator enabled it. The engine is
defensively written for partial schema — several source tables "may not exist yet in a
given environment … absence degrades to 'no data' instead of an error"
(`tripReadiness.ts:14-18`) — so on hosted testing it will return thin results rather
than fail. **To turn on: `FLAG FLIP ONLY` (already on).**

**`plan_geofence_enabled` — TRUE.** `src/routes/geofence.ts:93`, inside a local
three-state reader (`readFeatureFlag`, `:86-104`, with `isFeatureEnabled` at `:106`).
Gates plan-item geofence check-ins — READ and WRITE. The three-state shape exists for
a named reason (`:76-84`): an unreadable `feature_flags` used to answer FALSE and every
caller rendered that as 404 "Plan geofencing is not enabled", so *"a member standing at
the meetup trying to check in was told the feature does not exist, when a retry would
have worked."* **To turn on: `FLAG FLIP ONLY` (already on).**

#### CODE (or DECISION) — `plan_geofence_full_enabled` is TRUE and read by nothing

A repo-wide search for the literal `plan_geofence_full_enabled` (all file types,
excluding `node_modules`) finds it only in: two seeding migrations
(`src/migrations/0037_feature_flags.sql:48`,
`src/migrations/0166_feature_flags_reconcile.sql:21`), `docs/feature-flags.md:52`, and
the production schema snapshots. **There is no read site in the tree.** It is TRUE in
production and gates nothing: an "on and dead" flag in the inverse sense of
`docs/architecture/on-and-dead-flag-matrix.md` (on, with no code behind it rather than
no schema). The migration that named it points at `0039_plan_geofence_full.sql`
(arrival detection), whose table `plan_attendance_events` is still referenced
(`src/lib/crowdFlowProducer.ts:362`) — so the schema exists and the gate does not.
**To turn on for hosted testing: `DECISION`.** *Is the "full geofence pipeline /
arrival detection" a feature we expect in hosted testing, or is this flag stale?*
**Recommended default: treat it as stale and ignore it** — flipping it changes nothing
observable, and nothing in the tree would start working. If arrival detection is
wanted, that is a `CODE` item (find or write the pipeline) and a question for whoever
owns `0039`, not a flag flip. Either way it should not appear on a "turn these on"
list, because it would create the impression something was enabled.

**`open_to_plans_windows_enabled` — FALSE.** Read at four sites in
`src/routes/availability.ts` (`:44` constant; `:712`, `:730`, `:774`, `:803`) plus
`src/routes/telegraphSharedContext.ts:52,244` and
`src/services/passport/PassportProjectionService.ts:80`. Gates Passport §8
Open-to-Plans / Temporary Intent: `AvailabilityWindow` CRUD — READS and WRITES. Off ⇒
an explicitly-disabled envelope (`{ok:true, enabled:false}` / `{windows:[],
enabled:false}`) and **nothing is stored**
(`src/migrations/2260_availability_windows.sql:240-244`). The §6 weekly grid and
quick-status routes are **not** gated by it and keep working. **Why off:** 2260 seeds
it FALSE with no further stated reason beyond "OFF by default"; schema-wise 2260 did
apply (the flag row exists in production). **To turn on: `FLAG FLIP ONLY`** — the
table, its RLS and the §7 "inferred windows stay private" CHECK constraint all ship in
2260, which production has. **Depends on:** nothing (it composes with, but does not
require, `nearby_reachable_enabled`).

**`open_to_plans_enabled` — NOT A FEATURE FLAG.** Row absent, and correctly so: this
string is a **Passport telemetry event type**, not a gate —
`src/migrations/2287_passport_telemetry_events.sql:73` lists it in the event-name CHECK
alongside `availability_set` / `availability_expired`, and `src/lib/passportTelemetry.ts:41`
carries it as an event name. Nothing reads a flag by that name. Report it as a
non-flag; the real gate for that surface is `open_to_plans_windows_enabled` above.

**`nearby_reachable_enabled` — ROW ABSENT.** Read at
`src/routes/nearbyReachable.ts:105` (router mounted at `src/routes/index.ts:405-406`).
Gates `GET /api/nearby/reachable` — a READ, answering an explicitly-disabled envelope
while off. The row is absent because
`src/migrations/2990_nearby_reachable_flag.sql` has not been applied to production
(it is absent from `production-applied-migrations.json`, and 2990's `INSERT` is its
only effect — "It creates no table, no column, no policy and no grant", `:11-14`).
2990's header is unusually good on what enabling exposes (`:31-50`): for the caller's
circle members and accepted trip crew only, a proximity **bucket** (narrowest rung
5 km, *"the projection's precision field is the literal type `bucket` and cannot hold
a coordinate"*), an affirmatively-published availability state, and a relationship
tier — no coordinate, no distance, no ETA, no viewport, and a person in invisible
mode is absent entirely. It also notes the row exists not for its default but because
`scripts/check-flag-polarity.mjs` refuses a **phantom flag** — one read by code and
created by no migration (`:21-29`).
**To turn on for hosted testing: `MIGRATION`.** Apply 2990 (production does not have
it), then flip. It is a pure flag seed, idempotent, with no DDL. **Depends on:**
nothing; the underlying tables already exist. Composes with
`open_to_plans_windows_enabled` for the availability half of the projection, and with
`disable_location_sharing`, which this surface **does** honour
(`src/services/telegraph/reachablePeopleQuery.ts:255`) — one of only three places that
do.

---

### 7. Notification flags, and four names that are not flags

**`push_notifications_enabled` — TRUE.** Capability flag, and the one flag in the
notification family that genuinely gates delivery. Read at
`src/services/notifications/NotificationRouter.ts:183` and
`src/services/passport/StampAwardEngine.ts:683` — gates Expo push delivery via
`notification_devices`. Seeded TRUE by `src/migrations/0117_beta_feature_flags.sql:38`
and `src/migrations/0062_notifications_schema.sql:345`.
`src/migrations/2080_retire_inert_seeded_flags.sql:178-196` asserts its **survival**
as a postcondition, specifically because it shares a prefix with two retired names and
*"a retirement that removed it would silently disable the push kill switch"*.
**Depends on:** nothing. It is a prerequisite for Safe Return escalation reaching a
phone. **To turn on: `FLAG FLIP ONLY` (already on).**

**`notifications_enabled`, `notification_digests_enabled`, `realtime_activity_enabled`,
`safety_notifications_enabled` — ROW ABSENT, deliberately deleted.**
`src/migrations/2080_retire_inert_seeded_flags.sql:136-150` **DELETEs** all four from
`feature_flags`, with a pre-check that refuses if any `feature_flag_audit_log` row
references them (`:106-134`) and a postcondition that none survives (`:152-176`). They
were seeded-but-inert: no reader anywhere. They remain in two allow-lists so the
behaviour is identical on a database where 2080 has not run —
`src/routes/admin.ts:703-706` (`HIDDEN_INERT_FLAGS`, so a PATCH says "this control
does not exist" rather than "wrong URL") and `src/routes/featureFlags.ts:48-51`
(`INERT_FLAGS`, filtered out of what the mobile app's `FeatureFlagsContext` fetches,
because *"an inert name reaching the client is a toggle a future screen could gate on,
believing it works"*).
**To turn on for hosted testing: nothing to do — these gate nothing.** Do not create
rows for them; the admin UI and the client both filter them out by name, so a row
would be invisible and still inert. In particular **`safety_notifications_enabled` is
not a safety control** — the safety notification path is
`safe_return_trusted_circle_alerts_enabled` + `push_notifications_enabled`, both TRUE
(§2).

**`hotel_blur_enabled` — NOT A FLAG.** It is a **column** on `location_preferences`,
`boolean NOT NULL DEFAULT true` (`src/migrations/0032_location_preferences.sql:20`) —
a per-user privacy preference, on by default. Read at
`src/domain/trips/services/TripCrewLocationService.ts:361` and filtered at `:380`
(*"FAIL CLOSED AT THE FIELD, don't refuse the request"*, `:363`), and at
`src/routes/passportStamps.ts:488`. It is what suppresses exact coordinates near a
hotel/home on the crew map (`TripMapCrewPresence.ts:18-21`). No flag row; nothing to
flip.

**`ghost_mode_enabled` — NOT A FLAG.** A **column** on the trip crew location
preferences row, read at
`src/domain/trips/services/TripCrewLocationService.ts:327,487,558,570` and written at
`:597`; also a column read by `src/services/airport/LayoverPrivacyGuard.ts:300`. The
*flag* is `trip_crew_ghost_mode_enabled` (TRUE, §1), which gates the toggle endpoint
`POST .../crew/ghost-mode/enable` at `src/routes/tripCrewLocation.ts:381`.

**`age_restriction_enabled` — NOT A FLAG.** A **column** on `posts`,
`boolean NOT NULL DEFAULT false` (`src/migrations/0063_interaction_foundation.sql:179`;
see also `src/migrations/20260813_posts_restrictions.sql:3-14` — "When true,
`age_min`/`age_max` are enforced"). Read at
`src/services/passport/PassportConsumerAccess.ts:69`,
`src/domain/telegraph/policies/conversationCapabilityPolicy.ts:190`,
`src/lib/inputAssistance/searchCandidates.ts:415`. Per-post, author-set. No flag row.

---

### 8. Summary of labels

| Flag | Prod | Label | One line |
|---|---|---|---|
| `safe_return_enabled` | true | **DECISION** | Does Safe Return need sub-minute escalation in hosted testing? Flag is on; the *process* behind it cannot be shown to run (§3). |
| `safe_return_live_share_enabled` | true | FLAG FLIP ONLY (on) | — |
| `safe_return_trusted_circle_alerts_enabled` | true | FLAG FLIP ONLY (on) | — |
| `safe_return_admin_logs_enabled` | true | FLAG FLIP ONLY (on) | — |
| Safe Return job health | — | **CODE** | No `job_health` row and no `/healthz/schedulers` entry for `safeReturnScheduler`; its silence is unobservable. |
| Replit deployment type | — | **CONFIG** | Only Chelsi can read whether the deployment is autoscale (15-min idle suspend) or Reserved VM. |
| `locate_friends_enabled` | false | FLAG FLIP ONLY | 2219 is applied to production; flag-only. Fail-soft; LEAVE already ungated. |
| `disable_location_sharing` | false (not engaged) | **CODE** | Read at only 3 sites; does **not** cover trip-crew live share, §12 positions, or Safe Return live share, contrary to its description. |
| `trip_crew_map_enabled` | true | FLAG FLIP ONLY (on) | The real master of crew location reads. |
| `trip_crew_live_share_enabled` | true | FLAG FLIP ONLY (on) | One read site; gates share *start* only. |
| `trip_crew_ghost_mode_enabled` | true | FLAG FLIP ONLY (on) | — |
| `trip_absence_guard_enabled` | false | **DECISION** | Stop public previews announcing a future trip's dates? Recommend ON (additive, reversible). |
| `trip_readiness_enabled` | true | FLAG FLIP ONLY (on) | — |
| `trip_retention_sweep_enabled` | false | **DECISION** | May the server delete trip evidence and forget pasted booking text on its policy clock? Recommend ON; 2789+2791 applied. |
| `plan_geofence_enabled` | true | FLAG FLIP ONLY (on) | — |
| `plan_geofence_full_enabled` | true | **DECISION** | TRUE with **zero read sites** — stale flag; recommend ignoring it rather than listing it as enabled. |
| `open_to_plans_windows_enabled` | false | FLAG FLIP ONLY | 2260 applied; table + CHECKs present. |
| `open_to_plans_enabled` | row absent | — | Not a flag: a Passport telemetry event name. |
| `nearby_reachable_enabled` | row absent | **MIGRATION** | Apply 2990 (flag seed only, no DDL), then flip. |
| `presence_cleanup_enabled` | false | **DECISION** | Flip the flag, or drive the existing ungated `POST /circle/internal/cleanup-presence`? Recommend flipping. |
| `circle_presence.expires_at` nullable | — | **CODE** | Null-expiry rows are deleted by no sweep **and** stay served forever; flipping the flag does not fix it. |
| `location_snapshot_purge_enabled` | row absent | **MIGRATION** | *Owned/reported by the story-retention thread.* 2129 never applied; raw lat/lng retained indefinitely and outside the deletion cascade. |
| `location_snapshots` readers | — | **CODE** | `PresenceVerifier.ts:247-256,274-282` read it with no `expires_at` filter; the purge scheduler's and 2129's "only three touch points" claim is stale (currently harmless: 2 min / 3 h windows). |
| `map_telemetry_retention_enabled` | true | FLAG FLIP ONLY (on) | The reference precedent: a retention control correctly seeded TRUE. |
| `account_deletion_worker_enabled` | false (+metadata) | **DECISION** | Rehearse one real deletion then enable, or stay manual? Recommend staying manual for hosted testing. |
| `push_notifications_enabled` | true | FLAG FLIP ONLY (on) | Prerequisite for Safe Return alerts reaching a phone. |
| `notifications_enabled` / `notification_digests_enabled` / `realtime_activity_enabled` / `safety_notifications_enabled` | row absent | — | Deliberately DELETEd by 2080; inert, no readers. Nothing to do. |
| `hotel_blur_enabled` / `ghost_mode_enabled` / `age_restriction_enabled` | row absent | — | Not flags: columns on `location_preferences`, trip-crew prefs, and `posts`. |
| `intel_retention_sweep_enabled` | true | — | **Another agent's** (`intel_*`). Overlap noted, skipped. |
| `memory_location_precision_enabled` | false | — | **Another agent's.** Skipped. |
## Section 07 — Every kill switch, plus the core product surfaces

Repo read-only at `/home/user/portava.app`. Production values from
`scratchpad/flags/prod-sorted.txt` (capture 2026-10-03). Schema facts from
`artifacts/api-server/src/lib/capability/snapshots/20260922-production-schema.json`
(watermark `20260922155706`, 497 tables) — **that snapshot is 11 days older than
the flag capture, so a table added to production after 2026-09-22 would not
appear in it.** Every "table absent" claim below is corroborated by an
independent fact (a seed row that is absent from the 2026-10-03 flag capture).

All paths below are relative to `artifacts/api-server/` unless stated.

---

### HALF A — EVERY KILL SWITCH

#### A.0 Headline: the wrong-helper check, answered mechanically

**No kill switch in this domain is read through `isFlagEnabled`.** I verified
this two ways.

1. Exhaustive grep of every `disable_*` / `*_disabled` literal reaching a flag
   reader across `src/` and `travel-buddy-standalone/`. Every one goes through
   `isKillSwitchEngaged`. The only `isFlagEnabled` read of a stop-shaped name
   anywhere outside tests is `routes/auth.ts:160` for `invite_only_beta`, which
   is **deliberate** (see A.15).
2. I ran the repo's own enforcement script (read-only, no DB):
   `node scripts/check-flag-polarity.mjs` → exit 0,
   `253 flags classified (17 STOP, 234 CAPABILITY, 2 CONFIG) across 1308 files`,
   `494 flag reads`. Its **rule R2**
   (`scripts/check-flag-polarity.mjs:2122-2134`) fails the build if any flag
   classified `STOP` is read through anything but `isKillSwitchEngaged`:

   > `STOP READ THROUGH THE WRONG READER: "<flag>" is classified STOP but is read via <reader> at <file>:<line>.`

   The 17 STOP flags are the 14 convention-named ones (13 `disable_*` +
   `find_your_circle_disabled`) plus three CLASSIFIED entries
   (`RENT_BUDDY_ADMIN_ONLY_MODE`, `RENT_BUDDY_MVP_MODE`,
   `RENT_BUDDY_BETA_ONLY_MODE` — another agent's). I checked the script's
   waiver lists (`DIRECT_READS` `covers`, `UNRESOLVABLE`, `SHADOW_READERS`,
   `scripts/check-flag-polarity.mjs:1089/1171/1281`): **none of my kill switches
   is waived**, so R2 genuinely verifies each of them rather than accepting a
   human's note.

So the "latent bug" the brief asks about does not exist today. What exists
instead are two narrower gaps, both reported as CODE items below: a kill-switch
read that is skipped when the service client is absent (A.1 CODE-1), and a
ratchet regex that cannot see the spelling that read uses (A.1 CODE-2).

#### A.0b Do the named tests cover every switch? — No.

| test | what it actually covers |
|---|---|
| `src/test/flagKillSwitchAudit.test.ts` (115 lines) | **Not a polarity audit of the switches at all.** It is FLAG-1/FLAG-2 for `PUT /admin/notification-defaults`: that flipping `push_notifications_enabled` goes through `toggle_feature_flag_with_audit` and writes an audit row, and that an RPC failure does not answer `ok:true`. One flag, one admin route. **12 of my 13 `disable_*` switches and `find_your_circle_disabled` do not appear in it.** The brief's hypothesis that this is the per-switch audit is wrong; the name is misleading. |
| `src/test/flagPolaritySeedScan.test.ts` (310 lines) | The real coverage, indirectly. It `execFileSync("node", [SCRIPT])` at `:126` — i.e. it **runs `check-flag-polarity.mjs` inside the test suite**, so R2 (and R6/R9) execute in CI. Its own assertions are about the seed scanner's `INSERT INTO [public.]feature_flags` matcher and its statement terminator, re-derived with a deliberately broader independent matcher. |
| `src/test/airportFlagPolarity.test.ts` (215 lines) | Airport/Layover routes only, red-proof for a shadow `isFlagEnabled` in `routes/airport.ts` that returned **true** on error. Behavioural, through the real routes. Covers no `disable_*` switch. |
| `src/test/notificationRouterPushKillSwitch.test.ts` (182 lines) | `push_notifications_enabled` at the `NotificationRouter.sendPush()` call site only: OFF ⇒ one `suppressed` delivery row; DB error ⇒ fails closed. Covers no `disable_*` switch. |
| `src/test/verifyFailOpenStopReads.test.ts` (120 lines) | The class ratchet for the `client && await isKillSwitchEngaged(client, …)` fail-open, across all of `src/routes` and `src/lib`. Source assertion, not behavioural (it says so at `:20-39`). Its own header records it going red on `routes/meetups.ts`, `routes/location.ts` and `routes/posts.ts`. |

**Verdict:** every switch is covered, but by `check-flag-polarity.mjs` R2
(executed via `flagPolaritySeedScan.test.ts`), **not** by
`flagKillSwitchAudit.test.ts`. If anyone reads the audit test's name as the
coverage, they are relying on a test that checks one unrelated flag.

#### A.1 CODE items

**CODE-1 — `lib/discoveryStopGate.ts:83` skips the stop when the service client is absent.**

```
s.kill = { value: sc ? await isKillSwitchEngaged(sc, "disable_discovery_pde") : false, at: nowMs };
```

`sc` falsy ⇒ `false` ⇒ **not engaged**. That is exactly the defect
`killSwitchStateUnknown` (`lib/featureFlags.ts:152`) and
`messagingStopUnknownRefusal` (`lib/telegraphThreadWrite.ts:71`) were written to
close: an absent `SUPABASE_SERVICE_ROLE_KEY` disengages the stop. Mitigating
facts, stated so this is not overrated: a halt here only makes a rollout flag
read as OFF, the module's own header says "a halt only returns the flag-off
output users already had", and a caller with no client would also fail its
`isFlagEnabled` read fail-closed one line earlier. So the blast radius is
"`disable_discovery_pde` cannot halt PDE on a key-less deployment", not a write
getting through. Fix: use `killSwitchStateUnknown(sc)` and halt on unknown.
Domain detail for Discovery/PDE belongs to the Discovery section.

**CODE-2 — the ratchet's regex cannot see CODE-1's spelling.**
`src/test/verifyFailOpenStopReads.test.ts:70`:

```js
const FAIL_OPEN = /\b(\w+)\s*&&\s*await\s+isKillSwitchEngaged\s*\(\s*\1\b/;
```

It matches only the `x && await isKillSwitchEngaged(x` spelling. The ternary at
`lib/discoveryStopGate.ts:83` is the same defect in a different shape and passes
the ratchet silently — in `src/lib`, which the test's second case explicitly
scans. Fix: widen to also match `(\w+)\s*\?\s*await\s+isKillSwitchEngaged\s*\(\s*\1`
(and `!x ? … :` / `x == null ? …`), or better, assert that every
`isKillSwitchEngaged` call site in `routes/`+`lib/` is preceded by a
`killSwitchStateUnknown` / `messagingStopUnknownRefusal` guard in the same
function.

#### A.2 — A.14 The switches, one row each

All fourteen are **DISENGAGED (`false`) in production**, all have a row (none
absent), all read through `isKillSwitchEngaged`, and all are therefore
**`FLAG FLIP ONLY`** for hosted testing — meaning *nothing needs doing*: they
are already in the "feature works" position. The hosted-testing risk is the
opposite one — that someone engages one by accident — so each row names what
goes dark.

Polarity for all fourteen: **kill switch** (`true` = STOP). Failure polarity
inverted: DB **error ⇒ engaged**; **absent row ⇒ not engaged**
(`lib/featureFlags.ts:55-67`).

| # | flag | prod | gate sites (file:line) | kind of gate | what stops |
|---|---|---|---|---|---|
| A.2 | `disable_signups` | `false` | `routes/auth.ts:159` (GET `/auth/signup-status`), `routes/auth.ts:205` (POST `/auth/signup`) | WRITE + the status READ the app pre-flights | New account creation. 403 `feature_disabled`. The status route's no-client branch answers `503 {signupsEnabled:false}` (`routes/auth.ts:154`) so the app never renders a form guaranteed to 403. |
| A.3 | `disable_posting` | `false` | `routes/posts.ts:556` (POST `/posts`, guarded by `killSwitchStateUnknown` at `:552`), `routes/postcards.ts:261` (POST postcard — "the postcard shell is a post row by another name") | WRITE | Both composers. Postcards were added after the audit found they bypassed the stop. |
| A.4 | `disable_messaging` | `false` | `routes/messaging.ts:2704` (text send), `routes/messaging.ts:3249` (media send), `lib/telegraphThreadWrite.ts:88` (`guardTelegraphThreadWrite` — shared by the §5 share route, the §6.2 typed-kind route and `routes/telegraphVoice.ts`) | WRITE | Every write into `messages`. All three sites use `messagingStopUnknownRefusal` first, answering `degraded_unavailable`, not `feature_disabled`, when the client is absent. |
| A.5 | `disable_tagging` | `false` | `routes/tags.ts:73` | WRITE | Creating a tag. The in-file comment at `:67-72` is the canonical explanation of why this is not `isFlagEnabled`. |
| A.6 | `disable_media_uploads` | `false` | `lib/mediaPipeline.ts:112` (`guardUploadRequest` — the gate before any upload or signed URL), `routes/messaging.ts:3253`, `routes/profile.ts:1171` (avatar), `routes/profile.ts:1244`, `routes/events.ts:5930` (event media — "audit: this path previously ignored it"), `routes/postcardMediaTransport.ts:116` (every postcard transport route) | WRITE | All media ingest, including signed-URL minting. Six doors; the shared one is `mediaPipeline`. |
| A.7 | `disable_new_event_creation` | `false` | `routes/meetups.ts:147` (guarded by `killSwitchStateUnknown` at `:143`), `services/media/MediaActionResolver.ts:551` (`.catch(() => true)` — fail-closed) | WRITE + UI affordance | Creating meetups; the "meet here" action on media is suppressed. Note it gates **meetups**, not `POST /events` (which is gated by `events_enabled`, B.1). |
| A.8 | `disable_profile_search` | `false` | `routes/follows.ts:690` | READ | `GET /users/search`. Soft stop: answers **200** with `{users:[]}` plus a `discoveryRefusal("feature_disabled","profile_search_stopped")` body so the client can say nothing was searched. |
| A.9 | `disable_unknown_message_requests` | `false` | `routes/messaging.ts:663` | WRITE | First-contact message requests from non-connections. Ordinary thread sends are unaffected (that is A.4). |
| A.10 | `disable_location_sharing` | `false` | `routes/location.ts:169` (POST `/me/location-state`, write; `killSwitchStateUnknown` at `:166`), `lib/circleLocationsRead.ts:125` (the serve path — returns `{ok:true, locations:[]}`), `services/telegraph/reachablePeopleQuery.ts:255` | WRITE **and** READ | Both halves, deliberately. `circleLocationsRead.ts:20-30` documents all five gates in order. **Domain detail: the Circles / location-sharing section.** |
| A.11 | `disable_discovery_pde` | `false` | `lib/discoveryEngineMode.ts` (`DISCOVERY_PDE_KILL_SWITCH`, :68; `pde` mode additionally requires the stop be clear — ruling D3=B), `lib/discoveryStopGate.ts:83` (**CODE-1**) | READ-path mode resolution | Forces the Discovery engine to `legacy`, and makes rollout flags 3455/3456/§78/§85 serve their flag-off output. Not a latch. **Domain detail: the Discovery / PDE section.** |
| A.12 | `disable_intel_live_labels` | `false` | `lib/liveClaimRead.ts:315` (inside `liveLabelsServable`, the one global answer), `routes/intelApi.ts:36` (internal redistributable view → `{fields:[]}`), inherited by `lib/mapProducers/safetyNoticeProducer.ts` and `routes/intelReadModels.ts` | READ | Suppresses every live-label / live-state serving path without deleting records. **Domain detail: the Intel / live-labels section.** |
| A.13 | `disable_rab_bookings` | `false` | `routes/rentABuddy.ts:1769,2004`, `routes/rentABuddyMarketplace.ts:1205,1528`, `routes/rentABuddySpec.ts:420`; named on the refusal path by `engagedRabBookingKillSwitch` (`lib/featureFlags.ts:179`) | WRITE | One of the two RAB booking stops; tested as `A \|\| B` at five creation paths. **Domain detail: the Rent-a-Buddy section.** |
| A.14 | `disable_rent_buddy_booking` | `false` | `routes/rentABuddy.ts:1768,2003`, `routes/rentABuddyMarketplace.ts:1204,1527`, `routes/rentABuddySpec.ts:419` | WRITE | The other RAB booking stop. `lib/featureFlags.ts:160-177` explains why both are honoured and why the refusal body now names which one. **Domain detail: the Rent-a-Buddy section.** |

Why off / seeding, for the record: `src/migrations/0065_phase7_safety.sql:79-88`
seeds `disable_unknown_message_requests`, `disable_new_event_creation`,
`disable_rab_bookings`, `disable_tagging`, `disable_location_sharing`,
`disable_profile_search`, `disable_media_uploads`;
`0117_beta_feature_flags.sql:40-43` seeds `disable_signups`, `disable_posting`,
`disable_messaging`, `disable_rent_buddy_booking`;
`2091_discovery_engine_mode_flags.sql:39` seeds `disable_discovery_pde`;
`2168_intel_limited_live_flags.sql:14` seeds `disable_intel_live_labels`. All
seeded FALSE because an emergency stop ships disengaged — that is the intended
resting state, not a suppressed feature. **No "why off" question arises for any
kill switch.**

Mobile side: `travel-buddy-standalone/src/constants/killSwitches.ts` carries only
human-readable labels for five of them (`disable_posting`, `disable_messaging`,
`disable_signups`, `disable_rent_buddy_booking`, `invite_only_beta`). The app
reads no kill switch itself; enforcement is server-side
(`travel-buddy-standalone/src/services/auth.ts:58` says so explicitly). So
there is no second, divergent polarity to audit in the mobile tree.

#### A.15 `invite_only_beta` — capability, not a stop

- **Polarity: CAPABILITY.** `true` = narrow signup to invitees. `false` = signup
  open to everyone. Read through **`isFlagEnabled`** at `routes/auth.ts:160`,
  and that is **correct, not a bug.** `check-flag-polarity.mjs:278-287`:

  > `RESTRICTION SEMANTICS, DELIBERATELY NOT A STOP. true narrows signup to invitees; it does not stop signups. False-on-error opens signup to everyone, which is a rollout decision, not an outage — the opposite call from disable_signups, which sits two lines away in routes/auth.ts and IS a stop.`

- **Gates:** the `inviteOnly` field of `GET /api/auth/signup-status` only
  (`routes/auth.ts:165`). **UI only.** I found **no server-side enforcement
  anywhere**: `POST /auth/signup` (`routes/auth.ts:186-209`) checks
  `disable_signups` and nothing else before calling
  `auth.admin.createUser`. The flag reports an intention to the client; it does
  not refuse a signup.
- **Production value: `false`.**
- **Confirmed: signup is open on the hosted app.** `false` ⇒
  `signupsEnabled: true, inviteOnly: false`, and `POST /auth/signup` creates the
  account. The two flags fail in opposite directions on purpose
  (`routes/auth.ts:149-153`).
- **What it would gate if `true`:** on the evidence, **only the client's
  messaging** — the app would show an invite-code / "invite only" state instead
  of an open form. There is no invite-code table, no redemption route and no
  server check behind it. So flipping it `true` today would not actually
  restrict anyone who posts to `POST /api/auth/signup` directly.
- **To turn on for hosted testing: leave it `false`.** If anyone *wants* it
  enforced: **CODE** — a server-side invite check in `POST /auth/signup` plus an
  invite store; the flag alone does nothing.
- **Depends on:** nothing. Read independently of `disable_signups`.
- Behavioural tests exist for both directions:
  `src/test/authSignupStatusFailClosed.test.ts`,
  `src/test/authSignupStatusNoClient.test.ts`.

#### A.16 `find_your_circle_disabled` vs `find_your_circle_enabled` — which one gates?

**Both do, at different doors. This is a real split, not a redundancy.**

| flag | polarity | prod | read via | sites | gates |
|---|---|---|---|---|---|
| `find_your_circle_enabled` | CAPABILITY (`true` = available) | `true` | `isFlagEnabled` | `routes/circle.ts:88` (`requireFeatureEnabled`, applied per route), `routes/pulse.ts:1126` (`.catch(() => false)`) | **The HTTP surface.** `false` ⇒ `feature_disabled` "Find Your Circle is not available yet". |
| `find_your_circle_disabled` | KILL SWITCH (`true` = STOP) | `false` | `isKillSwitchEngaged` | `lib/circleAccessGuard.ts:169`, `:408`, `:716` | **The presence/visibility authorization guard**, three entry points. Engaged ⇒ `{allowed:false, reason:"kill_switch"}`. Also admin-togglable via `routes/circle.ts:2174` (`toggle_feature_flag_with_audit`). |

The double negative is real but **the current combination is unambiguous and is
the "on" combination**: `find_your_circle_enabled = true` (surface available)
AND `find_your_circle_disabled = false` (stop disengaged) ⇒ **Find Your Circle
works.** There is no polarity trap in production today.

The risk the brief is pointing at is live, though: the two are read by different
helpers in different layers, and the comment at `routes/circle.ts:86` ("NOT the
kill-switch") exists precisely because someone will conflate them.
`check-flag-polarity.mjs:383-389` classifies `find_your_circle_enabled`
CAPABILITY *despite* it matching the `*_enabled` convention, for exactly this
reason:

> `Listed despite matching the *_enabled convention because a STOP of the SAME SUBJECT exists — find_your_circle_disabled — and the two mean opposite things. A reader who sees only one of them will guess wrong.`

**DECISION-1:** should the pair be collapsed to one flag before hosted testing?
**Recommended default: no — leave both, change nothing.** They are not
duplicates: one answers "has this shipped" fail-closed, the other answers "has
an operator halted it" fail-closed-to-STOP, and collapsing them would force one
of those two failure directions onto the other's question. Both are in the
correct position today; the cost of the double negative is reader confusion,
which the classification file already absorbs.

---

### HALF B — CORE PRODUCT SURFACES

Shared facts for this half: every flag below is a **CAPABILITY** flag — `true` =
available, and the failure polarity is **fail-closed** (`false` on error, `false`
on absent row). Mobile reads the same values via `GET /api/feature-flags`
(`routes/featureFlags.ts:14-60`) through `FeatureFlagsContext`
(`travel-buddy-standalone/src/context/FeatureFlagsContext.tsx:37,61`), which is
also fail-closed (default `isEnabled: () => false`, fetch `catch` leaves `{}`).

One structural note worth having: `routes/featureFlags.ts:59` returns
`resolveFeatureFlags(flags)`, so **the Live Places parent hierarchy is applied
server-side before the client ever sees it** — which is why
`FeatureFlagsContext.tsx:101` can safely alias
`isLivePlacesEnabled: isEnabled`. The client does not re-derive the hierarchy
and cannot get it wrong.

#### B.1 `events_*` — the surface is live, but six of the ten flags gate nothing

| flag | prod | read via | gate site(s) | gates |
|---|---|---|---|---|
| `events_enabled` | `true` | `isFlagEnabled` | `routes/events.ts:878` (POST `/events`), `routes/events.ts:2082` | **WRITE.** Master gate: event creation and draft publishing. `false` ⇒ `feature_disabled` "Events are not enabled". |
| `events_chat_enabled` | `true` | `isFlagEnabled` | `routes/events.ts:4369` (`createEventChatThread`) | **WRITE, side effect.** `false` ⇒ `return null`, no chat thread is created for a new event. Existing threads are untouched. |
| `events_waitlist_enabled` | `true` | `isFlagEnabled` | `routes/events.ts:3011`, `:3141`, `:5180` | **WRITE + READ.** Waitlist join / bump / promote flow for full events. |
| `events_trust_gates_enabled` | `true` | **`readFlagState`** (four-valued) | `routes/events.ts:6971` (`eventTrustGatesRun`) | **READ + WRITE authorization.** Runs the verified / trust-score / age gates on listing, RSVP, waitlist seating. |
| `events_cohosts_enabled` | `true` | — | **none** | nothing |
| `events_invites_enabled` | `true` | — | **none** | nothing |
| `events_join_leave_enabled` | `true` | — | **none** | nothing |
| `events_reminders_enabled` | `true` | — | **none** | nothing |
| `events_reports_enabled` | `true` | — | **none** | nothing |
| `events_share_links_enabled` | `true` | — | **none** | nothing |

`events_trust_gates_enabled` deserves its own note because it is the one flag in
this half whose failure polarity was deliberately changed. `routes/events.ts:6957-6974`:

> `events_trust_gates_enabled was read through isFlagEnabled, which answers false for an off flag, an absent row AND a read that failed. For a capability flag that is the closed answer; for THIS flag it is the open one: false means "skip the gates", so a failed flag read listed 18+ events to verified minors, seated them on waitlists and let them RSVP.`

It now reads three-state: `on` or `unreadable` ⇒ gates run; `off` / `absent` ⇒
skipped as before. **This is the correct pattern for any `*_enabled` flag whose
off-state is permissive**, and it is the only instance of it in my domain.

**Why off / seeded:** `src/migrations/20260805_events_core_flags.sql:22-25` seeds
`events_enabled`, `events_trust_gates_enabled`, `events_waitlist_enabled` (and
siblings) **FALSE**; `src/migrations/0080_events_extension.sql:420-428` seeds the
six inert ones **TRUE** as "Event invite system", "Event co-host system", "Event
reporting", "Event reminders", "Event shareable links", "Convenience join/leave
shortcuts". **Production has all ten `true`**, so the four that matter were
turned on by hand after the seed. Events work on the hosted app today.

**The six inert ones are declared inert in
`scripts/check-flag-polarity.mjs` (`INERT_SEEDED_FLAGS`), disposition
`owner-decision`**, each with this reason:

> `No reader: the capability is unconditionally ON in code, and the flag records an intention rather than a gate. Because it is seeded TRUE the admin list agrees with observed behaviour today, which is exactly why this has gone unnoticed — the disagreement only appears the first time someone toggles it OFF during an incident and nothing changes.`

**To turn on for hosted testing:** `events_enabled`, `events_chat_enabled`,
`events_waitlist_enabled`, `events_trust_gates_enabled` — **`FLAG FLIP ONLY`,
already flipped.** Nothing to do.

**DECISION-2** (the six inert flags): wire a reader, or drop the rows? **Recommended
default: drop the rows** (one migration deleting the six), because the
capabilities are unconditionally on and nobody has asked for them to be
switchable, and a toggle that does nothing is worse than no toggle during an
incident. Not blocking for hosted testing — the features all work. **Note these
six are *not* in `routes/admin.ts:662` `HIDDEN_INERT_FLAGS` nor in
`routes/featureFlags.ts:38` `INERT_FLAGS`**, so unlike the retired freeze /
sensing / COMPASS flags they **do** appear on the admin toggle surface and
**are** shipped to the mobile client — the exact outcome those two lists exist to
prevent. Same applies to `passport_contribution_enabled` (B.2),
`stamp_admin_award_enabled` (B.3) and `ai_visual_regeneration_enabled` (B.9).

**Depends on:** nothing above `events_enabled`. Note `disable_new_event_creation`
(A.7) gates **meetups**, a different write path, so it is not a parent of these.

#### B.2 `passport_*`

| flag | prod | read via | gate site(s) | gates |
|---|---|---|---|---|
| `passport_stamps_enabled` | `true` | local shadow `isFlagEnabled` (`routes/passportStamps.ts:56-74`), shared helper elsewhere | `routes/passportStamps.ts:131,208`, `routes/airport.ts:3732`, `services/passport/StampAwardEngine.ts:200` (direct), `routes/safeReturn.ts:587` (direct), `routes/geofence.ts:828` (direct) | READ + WRITE + the award engine |
| `passport_memories_enabled` | `true` | same | `routes/passportStamps.ts:239,280,328`, `routes/safeReturn.ts:615`, `routes/geofence.ts:857`, `routes/hiddenGems.ts:1010` (all direct) | READ + WRITE |
| `passport_map_enabled` | `true` | local shadow | `routes/passportStamps.ts:472` | READ (the passport map) |
| `passport_contribution_events_enabled` | `true` | `isFlagEnabled` | `services/passport/PassportContributionService.ts:113`, `routes/passportStamps.ts:311` | WRITE (contribution event emission) |
| `passport_entry_intelligence_enabled` | `true` | `isFlagEnabled` via `ENTRY_FLAG` (`lib/entryRequirements.ts:18`) | `routes/entryRequirements.ts`, `services/airport/layoverEntryGate.ts:116` (both declared in `DIRECT_READS` `covers`) | READ |
| `passport_travel_dna_enabled` | **`false`** | `isFlagEnabled` | `services/passport/PassportTravelIdentityService.ts:532` (`TRAVEL_DNA_FLAG`, `:38`) | READ |
| `passport_contribution_enabled` | `true` | — | **none (inert)** | nothing |
| `passport_event_share_enabled` | **ROW ABSENT** | `isFlagEnabled` | `services/passport/EventPassportService.ts:221,306,386`, `routes/passport.ts:1961`, mobile route `travel-buddy-standalone/src/navigation/portavaRoutes.ts:629` | READ + WRITE |

The **local shadow** `isFlagEnabled` in `routes/passportStamps.ts:56-74` is a
one-argument function that fetches its own service client. It **is** fail-closed
and says so (`:65-67`: "FL-05: fail-CLOSED to match the shared lib/featureFlags
isFlagEnabled (this local copy previously failed OPEN, an inconsistency)"). It is
declared in the polarity script's `SHADOW_READERS`, so R4 accounts for it. No
action.

**`passport_travel_dna_enabled = false` — the one passport capability that is
off.** Why: `src/migrations/2261_passport_travel_dna_prefs.sql:22-24` —

> `Behind flag passport_travel_dna_enabled (CAPABILITY, OFF): while OFF the service reads no prefs and every dimension shows as the default ("shown"), so shipping this migration changes nothing until the flag is turned on.`

Migration **is** applied (the row exists at `false`, and
`passport_travel_dna_prefs` is in the production table list). Turning it on makes
the service read the user's per-dimension Show / Hide / Not-Me choices instead of
defaulting every dimension to "shown". **`FLAG FLIP ONLY`** — but see
DECISION-3: **note that turning it ON makes the surface *more* private, not less**
(OFF means every inferred DNA dimension displays regardless of the user's stored
preference, because there is no PATCH endpoint yet to set one — `2261`'s header
calls the client write grant "intentional (a future PATCH endpoint)").
**Recommended default: turn it ON for hosted testing**, since a tester's
Hide choice being ignored is the worse failure.

**`passport_event_share_enabled` — ROW ABSENT in production.** Absent ⇒
`isFlagEnabled` ⇒ `false` ⇒ `EventPassportService` refuses `"disabled"` and the
mobile route at `portavaRoutes.ts:629` is hidden. Seeded **FALSE** by
`src/migrations/2294_event_passport_shares.sql:170`, whose postcondition
(`:208-210`) refuses to commit if the row is TRUE: "it must ship OFF". The row's
absence plus `event_passport_shares` being absent from the production table list
is consistent, mutually corroborating evidence that **2294 has not been applied
to production**. ⇒ **MIGRATION**: apply
`src/migrations/2294_event_passport_shares.sql`, then flip the flag.
(`production-applied-migrations.json` does not list 2294, but that file is a
staleness tripwire and not an inventory — its own `$comment` says so — so the
absent row and absent table are the load-bearing evidence, not the omission.)

#### B.3 `stamp_*`

All eight are **`true` in production** and all are fail-closed capability flags.

| flag | prod | read via | gate site(s) | gates |
|---|---|---|---|---|
| `stamp_system_v2_enabled` | `true` | direct read | `routes/stamps.ts:61`, `services/passport/StampAwardEngine.ts:166` | READ + the award engine. The v2 master. |
| `stamp_criteria_engine_enabled` | `true` | `isFlagEnabled` via `CRITERIA_FLAG` (`lib/stamps/criteria/index.ts:23`) | criteria evaluation | background evaluation |
| `stamp_unified_view_enabled` | `true` | `isFlagEnabled` via `UNIFIED_FLAG` (`services/passport/UnifiedStampService.ts:30`) | the unified stamp projection | READ |
| `stamp_showcase_enabled` | `true` | `isFlagEnabled` via `FLAG` (`routes/stampShowcase.ts:27`); mobile `StampsTab.tsx:391,495`, `app/passport/[username].tsx:527`, `portavaRoutes.ts:612` | READ + WRITE + UI | the showcase shelf |
| `stamp_admire_enabled` | `true` | `isFlagEnabled` via `FLAG` (`routes/stampAdmire.ts:27`); mobile `app/stamp/[stampId].tsx:159` | WRITE + UI | admiring a stamp |
| `stamp_premium_rendering_enabled` | `true` | direct read | `lib/stamps/generationWorker.ts:727` | background job (artwork generation path) |
| `stamp_auto_approve_artwork` | `true` | direct read | `lib/stamps/generationWorker.ts:615` | background job |
| `stamp_admin_award_enabled` | `true` | — | **none (inert)** | nothing |

`stamp_auto_approve_artwork` is the one name in my domain with **no suffix at
all**, and it is CLASSIFIED for that reason
(`check-flag-polarity.mjs:391-397`): "`true` auto-approves generated stamp
artwork; false routes it to human review. False-on-error means artwork goes to
review, which is the conservative direction." In production it is **`true`**, so
**generated stamp artwork is auto-approved with no human review on the hosted
app.** Not a defect — it is the recorded intent — but it is a thing a tester
should know.

`stamp_admin_award_enabled` is inert
(`check-flag-polarity.mjs` `INERT_SEEDED_FLAGS`): "Manual admin award exists in
the admin stamp routes but is gated by `requireAdmin` rather than by this flag.
OWNER DECISION: most likely remove-from-seed, since the authorization check is
the real gate." Folded into **DECISION-2**.

**To turn on:** all **`FLAG FLIP ONLY`, already flipped.** Every stamp table the
engine needs is in the production snapshot (`stamp_definitions`,
`stamp_generation_queue`, `stamp_artwork_definitions`, `stamp_artwork_versions`,
`stamp_admires`, `user_stamp_showcase`, `stamp_progress`, `stamp_milestones`,
`universal_stamp_catalog`, `stamp_award_events`, …). **But see CONFIG-1**: the
artwork generator needs `AI_INTEGRATIONS_OPENAI_API_KEY` or it emits placeholder
SVGs — `lib/stamps/generationWorker.ts:1417` logs exactly that
("all recent artwork generations produced placeholder SVGs; configure
`AI_INTEGRATIONS_OPENAI_API_KEY` / `STAMP_IMAGE_MODEL` so artwork renders
correctly on device"), key read at `lib/stamps/imageProvider.ts:153`.

**Depends on:** `passport_stamps_enabled` (B.2) is the passport-side parent of the
stamp surfaces in practice (the award engine reads both
`stamp_system_v2_enabled` at `:166` and `passport_stamps_enabled` at `:200`);
there is no declared hierarchy constant for stamps the way there is for Live
Places.

#### B.4 `hidden_gems_*` (mine: `_enabled`, `_passport_enabled`, `_pulse_enabled`)

`hidden_gems_layover_enabled` and `hidden_gems_compass_enabled` are **not mine**.

| flag | prod | read via | gate site(s) | gates |
|---|---|---|---|---|
| `hidden_gems_enabled` | `true` | `isFlagEnabled` | `routes/hiddenGems.ts:275, 412, 586, 610` (and more in that file), `services/media/MediaActionResolver.ts:1067` (`.catch(() => false)`) | READ + WRITE. The master gate for the whole Hidden Gems surface. |
| `hidden_gems_passport_enabled` | `true` | **direct read**, `routes/hiddenGems.ts:967` | fire-and-forget side effect after a verified non-suspicious GPS check-in: `createStamp` + `createSuggestedMemory`. `.enabled` falsy (incl. error/absent) ⇒ `return`. | WRITE, side effect |
| `hidden_gems_pulse_enabled` | `true` | **direct read**, `routes/hiddenGems.ts:1035` | fire-and-forget: insert a Pulse post tagged to the gem's city, no exact coords. Same falsy-⇒-return. | WRITE, side effect |

Both direct reads are inside `void (async () => { … })()` blocks, so a failure is
invisible to the caller by design: the check-in succeeds, the stamp or the Pulse
post simply does not happen. The code comments say so at `:1043-1050`
("the traveller checked in, the response said the check-in succeeded (it did),
and the post they expect to see on Pulse simply never exists"). Both are declared
to the polarity script via `DIRECT_READS`, so R3 covers them.

**Why off:** not off. Seeded **TRUE** from the start —
`src/migrations/0037_feature_flags.sql:47`,
`src/migrations/0043_hidden_gems.sql:229`,
`src/migrations/0117_beta_feature_flags.sql:37`. **To turn on: `FLAG FLIP ONLY`,
already on.** **Depends on:** `hidden_gems_enabled` for the other two in
practice (both side effects only fire from a check-in route already behind it).

#### B.5 Live Places family — the parent hierarchy, and it is fully satisfied

`LIVE_PLACES_REQUIREMENTS` (`lib/featureFlags.ts:98-107`) is the declared
hierarchy. Reads go through `isLivePlacesCapabilityEnabled`
(`lib/featureFlags.ts:119-124`), which requires the capability **and every
ancestor**, each via fail-closed `isFlagEnabled`.

```
external_places_enabled                              (root, independent)
└── live_places_enabled                              (master for experiential surfaces)
    └── place_days_enabled
        ├── shared_moments_enabled
        │   ├── shared_moments_compass_suggestions_enabled
        │   ├── shared_moments_clustering_enabled
        │   ├── shared_moments_chat_enabled
        │   └── moment_recaps_enabled
        └── place_recaps_enabled
```

| flag | prod | gate site | gates | depends on |
|---|---|---|---|---|
| `external_places_enabled` | `true` | `lib/places/placeResolve.ts:556` (`return null` when off) | READ — canonical external place resolution | — |
| `live_places_enabled` | `true` | via the hierarchy in every child read | master | `external_places_enabled` |
| `place_days_enabled` | `true` | `lib/places/placeDays.ts:93` | READ + WRITE | + `live_places_enabled` |
| `shared_moments_enabled` | `true` | `lib/places/sharedMoments.ts:6` | READ + WRITE | + `place_days_enabled` |
| `shared_moments_compass_suggestions_enabled` | `true` | `routes/sharedMoments.ts:94` | READ | + `shared_moments_enabled` |
| `shared_moments_clustering_enabled` | `true` | `routes/sharedMoments.ts:95` | READ | + `shared_moments_enabled` |
| `shared_moments_chat_enabled` | `true` | `routes/sharedMoments.ts:110` | READ + WRITE | + `shared_moments_enabled` |
| `place_recaps_enabled` | `true` | `lib/places/recaps.ts:17` (declared in `DIRECT_READS` `covers` with `moment_recaps_enabled`); mobile `app/place/[id].tsx:424`, `app/place/[id]/day.tsx:28`, `portavaRoutes.ts:890` | READ | + `place_days_enabled` |
| `moment_recaps_enabled` | `true` | `lib/places/recaps.ts:17` | READ | + `shared_moments_enabled` |

**All nine are `true` in production**, so **the whole hierarchy resolves ON** and
every child's ancestor requirement is satisfied. Schema is present: `place_days`,
`shared_moments`, `shared_moment_memberships`, `shared_moment_contributions`,
`shared_moment_suggestions`, `shared_moment_audit_events`, `live_place_recaps`,
`live_place_recap_versions`, `live_place_recap_chapters`,
`live_place_recap_snapshots`, `live_place_recap_sources` are all in the
production table list. **To turn on: `FLAG FLIP ONLY`, already flipped.**

**Why off (historically):** all seeded FALSE —
`src/migrations/2028_canonical_places.sql:85` (`external_places_enabled`),
`src/migrations/2068_live_places_rollout_flags.sql:32` (`live_places_enabled`,
described there as "Master kill switch for Live Places experiential surfaces;
requires external_places_enabled", with
`metadata = {"requires":["external_places_enabled"],"rollout":"phase4"}`),
`src/migrations/2063_place_days_foundation.sql:29`,
`src/migrations/2064_shared_moments_foundation.sql:93`. All have since been
turned on in production.

One naming trap worth recording: `2068`'s own description calls
`live_places_enabled` a "**master kill switch**". It is **not** a kill switch —
it is a `*_enabled` CAPABILITY flag read fail-closed through `isFlagEnabled`, and
`true` means *available*, not *stopped*. Anyone acting on the migration
description's wording would invert it. No code is wrong; the description is.

#### B.6 `local_guides_enabled`

- **CAPABILITY**, `isFlagEnabled`, prod **`true`**.
- **Gates:** `routes/hiddenGems.ts:1382` and `:1405` — the Local Guide profile
  and contribution routes. **READ + WRITE.**
- **Why off:** not off. Seeded **TRUE** at
  `src/migrations/0043_hidden_gems.sql:231` ("Local Guide profile and
  contributions").
- Schema present: `local_guide_profiles`, `local_guide_contributions`.
- **`FLAG FLIP ONLY`, already on.** **Depends on:** nothing declared; in practice
  the routes live in the Hidden Gems router.

#### B.7 `find_your_circle_enabled`

Covered in **A.16** alongside its kill-switch twin, because the double negative
is the whole point. Summary: CAPABILITY, `isFlagEnabled`, prod **`true`**, gates
the Circle HTTP surface at `routes/circle.ts:88` and the Pulse integration at
`routes/pulse.ts:1126`. **`FLAG FLIP ONLY`, already on.** Depends on nothing;
`find_your_circle_disabled` must stay `false` (it is).

#### B.8 Budget, country essentials, reservations

| flag | prod | gate site | gates | seeded |
|---|---|---|---|---|
| `budget_intelligence_enabled` | `true` | `routes/tripBudgetIntel.ts:56` | READ. Trip cost estimates + budget sandbox. | FALSE, `src/migrations/0171_price_baselines.sql:70` |
| `budget_fx_conversion_enabled` | `true` | `routes/tripBudgetIntel.ts:158` | READ, **nested inside** the `budget_intelligence_enabled` gate. FX conversion of the estimate. | FALSE, `src/migrations/0183_budget_fx_conversion.sql:16` |
| `country_essentials_enabled` | `true` | `routes/countryEssentials.ts` via `FLAG` (`:27`) | READ | FALSE, `src/migrations/0182_country_essentials.sql:100` |
| `reservation_import_enabled` | `true` | `routes/tripReservations.ts:73` | WRITE. Paste-to-import reservations with confirm-before-commit. | FALSE, `src/migrations/0172_trip_reservations.sql:112` |

All four seeded FALSE and **all four are `true` in production** — turned on by
hand. Schema present for all four (`price_baselines`, `trip_budget`,
`country_essentials`, `country_metadata`, `trip_reservations`). All
**`FLAG FLIP ONLY`, already flipped.**

**Depends on:** `budget_fx_conversion_enabled` requires
`budget_intelligence_enabled` — enforced by **code nesting at
`routes/tripBudgetIntel.ts:56` then `:158`**, not by a `LIVE_PLACES_REQUIREMENTS`
entry. Both are on, so the nesting is satisfied. Worth noting because the
hierarchy is invisible to `resolveFeatureFlags`: a client that reads
`budget_fx_conversion_enabled = true` while `budget_intelligence_enabled` were
false would be wrong, and nothing would correct it. Not a live problem today.

**CONFIG (unverified, flagged honestly):** `budget_fx_conversion_enabled` names an
FX conversion. **I did not establish whether it calls an external FX provider
needing a key, or converts from a locally seeded rate table.** I did not read
`routes/tripBudgetIntel.ts` past the two gate lines, and
`src/migrations/0185_seed_price_baselines.sql` suggests seeded data. **This check
cannot establish its result and must not be reported as clean** — someone should
confirm the FX source before relying on conversion in hosted testing.

#### B.9 `ai_*`

| flag | prod | read via | gate site(s) | gates |
|---|---|---|---|---|
| `ai_visual_provider_enabled` | `true` | `isFlagEnabled` | `lib/visuals/service.ts:188` (request), `:403` (worker) | **Chooses the provider.** `pickProvider` (`:105-107`): `true` ⇒ `OpenAIImageProvider` (**the paid API**); `false` ⇒ `CategoryFallbackProvider`. Provider off is "not an error" — a category fallback record is still produced (`:190-191`). |
| `ai_event_headers_enabled` | `true` | `isFlagEnabled` via `purposeFlag("event_header")` (`lib/visuals/service.ts:99`) | `:189` | per-purpose gate, AI event header images |
| `ai_place_headers_enabled` | `true` | same, `:100` | `:189` | AI place header images |
| `ai_trip_covers_enabled` | `true` | same, `:101` | `:189` | AI trip cover images |
| `ai_event_auto_suggest_enabled` | `true` | mobile `isEnabled` | `travel-buddy-standalone/src/components/EventComposerSheet.tsx:256` | **UI only**, client-side. Auto-suggestion in the event composer. |
| `ai_visual_admin_review_enabled` | **`false`** | `isFlagEnabled` | `routes/adminVisuals.ts:53` (every route in that file, plus `requireAdmin`) | READ + WRITE. The admin review/regeneration queue for generated visuals. |
| `ai_visual_regeneration_enabled` | `true` | — | **none (inert)** | nothing |

`lib/visuals/service.ts:188-199` reads **both** `ai_visual_provider_enabled` and
the purpose flag, and only applies the daily usage limits
(`USER_DAILY_LIMIT` / `GLOBAL_DAILY_LIMIT`) when **both** are true — i.e. only
when the paid API would actually be called. The three `purposeFlag` reads are
declared to the polarity script in `UNRESOLVABLE` `covers`
(`lib/visuals/service.ts`, covering `ai_event_headers_enabled`,
`ai_place_headers_enabled`, `ai_trip_covers_enabled`), because the flag name
comes from a parameter — the script's own note records that
`ai_trip_covers_enabled` was once reported seeded-but-never-read for exactly
this reason.

**CONFIG-1 applies here too:** with `ai_visual_provider_enabled = true` in
production, the Wall/event/place/trip header path **will** call
`OpenAIImageProvider`, which reads `AI_INTEGRATIONS_OPENAI_API_KEY`
(`lib/visuals/providers/openaiImageProvider.ts:92`; also in
`lib/envValidation.ts:19`). Without the key the paid call fails and the surface
degrades. Same key covers stamp artwork (B.3).

`ai_visual_admin_review_enabled = false` is the only `ai_*` capability that is
off. **No stated reason found** in `src/migrations/0194_generated_visuals.sql` for
leaving it off beyond its being seeded FALSE. It gates an **admin-only** queue
behind `requireAdmin`, so it is not a user-facing surface.
**DECISION-4:** turn it on for hosted testing? **Recommended default: yes, turn it
on** — with `stamp_auto_approve_artwork = true` and
`ai_visual_provider_enabled = true`, generated imagery reaches testers with no
review path at all, and this flag is the only route to one. It is
admin-gated, so the exposure is nil. **`FLAG FLIP ONLY`** (the
`generated_visuals` table is already read by the live request path, so no
migration is implied).

`ai_visual_regeneration_enabled` is inert
(`check-flag-polarity.mjs` `INERT_SEEDED_FLAGS`): "Seeded false by 0194, no
reader. Admin regeneration exists in `routes/adminVisuals.ts` but gates on
`ai_visual_admin_review_enabled` instead, so this row is a duplicate intention
that was never wired. OWNER DECISION: most likely remove-from-seed." Note it is
seeded FALSE but reads **`true`** in production — somebody has toggled a flag
that gates nothing, which is precisely the failure mode the inert-flag rule
exists to surface. Folded into **DECISION-2**.

#### B.10 `fsq_places_enabled` — and the Foursquare 401

**The 401 and this flag are two different things, and conflating them would send
Chelsi after the wrong fix.**

- **`fsq_places_enabled`**: CAPABILITY, prod **`true`**. Read through a
  **declared direct read** `fsqEnabled` (`lib/fsq/fsqPlaces.ts:130-139`) —
  fail-closed (`if (error) return false`, `=== true` on the value, `catch` ⇒
  `false`). Gate site `routes/fsqPlaces.ts:25` (`GET /api/cities/:cityKey/places`).
  **READ only.** Off ⇒ `200 { places: [], enabled: false, attribution }`.
- **What it reads is a local table, not the API.** `getCityPlaces`
  (`lib/fsq/fsqPlaces.ts:150-176`) selects from `fsq_places`, the **per-city
  pre-ingested** layer created by `src/migrations/0184_fsq_places.sql:17`
  ("Populated per-city (NOT whole-world) by `scripts/load-fsq-city.mjs`, which
  uses DuckDB to extract only a city's bounding box from the FSQ parquet").
  `fsq_places` **is present in the production table list**, and the flag row
  exists, so 0184 is applied. **No API key is needed to serve this endpoint.**
  It is also fail-soft: any query error ⇒ `{ places: [] }`.
- **The 401 is on a different path.** `replit.md:53`:

  > `/api/places/search` fans out Nominatim + Foursquare in parallel and merges/dedupes; `type=city` restricts to settlements. Foursquare venue search silently no-ops until a valid `FOURSQUARE_API_KEY` is set (current key is rejected with 401 by both v3 and current-gen Foursquare APIs).

  That is `lib/foursquarePlaces.ts` → `searchFoursquare`, which is **not gated by
  `fsq_places_enabled` at all**.

- **How the code behaves when the key is missing or rejected — verified:**
  - **Missing:** `lib/foursquarePlaces.ts:37-44` — `getFoursquareApiKey()` returns
    nothing ⇒ logs once (`"FOURSQUARE_API_KEY not set — venue search disabled"`)
    and `return []`.
  - **Rejected (401/403):** `:58-68` — logs once at `warn`, raises a Sentry
    message at `level: "error"` with
    `hint: "Check FOURSQUARE_API_KEY is set and valid"`, and `return []`.
  - **429:** `:73-80` — named explicitly as "account has no API credits
    remaining", once per process, then `return []`.
  - So **fail-soft everywhere**: `/api/places/search` silently drops the
    Foursquare half of its fan-out and serves Nominatim results only. No error
    reaches the user; the search simply returns no venues, only settlements and
    OSM features.
  - Key resolution is environment-aware: `lib/foursquareApiKey.ts:53-59` prefers
    `FSQ_API_KEY_PROD` in production / `FSQ_API_KEY_DEV` otherwise, falling back
    to `FOURSQUARE_API_KEY` ("deliberate backward compatibility: until
    `FSQ_API_KEY_DEV` / `FSQ_API_KEY_PROD` are actually provisioned as Replit
    secrets").

- **`fsq_places_enabled` itself: `FLAG FLIP ONLY`, already on.** Seeded FALSE at
  `src/migrations/0184_fsq_places.sql:76`, turned on in production.
- **CONFIG-2 (two parts, both Chelsi's):**
  1. **The 401 is still real on the evidence available to me.** I verified the
     code paths and the documented claim; **I did not and must not call the
     Foursquare API or read the secret**, so I cannot confirm the key is *still*
     rejected today — only that `replit.md` says it is and the code's response to
     a 401 is to silently disable venue search. Chelsi needs to supply a valid
     key as `FSQ_API_KEY_PROD` (preferred) or `FOURSQUARE_API_KEY` for venue
     search in `/api/places/search` to return anything.
  2. **Separately, `fsq_places` must actually contain the test cities.** The flag
     is on and the table exists, but `GET /api/cities/:cityKey/places` answers
     `{ places: [], enabled: true }` for any `city_key` nobody has ingested —
     indistinguishable from "this city has no venues". Running
     `scripts/load-fsq-city.mjs` per test city needs the Foursquare parquet
     dataset (and DuckDB), which is Chelsi's to provide. **I could not establish
     which `city_key` values, if any, are already loaded in production** —
     that requires a row count I am not permitted to run.
- **Depends on:** nothing. Note the attribution obligation travels with the data:
  `FSQ_ATTRIBUTION = "Powered by Foursquare"` (`lib/fsq/fsqPlaces.ts:12`) is
  returned by the route and "**Caller must render attribution**"
  (`:148`) — a license condition, not a nicety, and a hosted testing build that
  displays FSQ places without it is out of compliance.

#### B.11 `wall_*` — a whole product surface that is dark

**Every Wall flag is `false` in production, and one has no row at all.** This is
the single largest dark surface in my domain, so it gets the fullest treatment.

| flag | prod | read via | gate site(s) | gates |
|---|---|---|---|---|
| `wall_enabled` | **`false`** | `isFlagEnabled` | `routes/wall.ts:964` (GET `/wall`), `:1268` (GET `/wall/live`), `:1337`, `:1376`, `:1394`, `:1445`, `:1486`, `:1571` (session-intent / impression / action / revalidate), `routes/wallMoments.ts:104`, `routes/wallTelemetry.ts:282` | **READ + WRITE, every route.** The master. Off ⇒ every route short-circuits "before any canonical read". |
| `wall_live_for_you_enabled` | **`false`** | `isFlagEnabled` | `routes/wall.ts:981`, `:1272` | READ. The bounded 2–4 item Live For You strip. Off ⇒ empty strip, no live strip in the feed. |
| `wall_discovery_insertions_enabled` | **`false`** | `isFlagEnabled` | `routes/wall.ts:980` | READ. Off ⇒ For You stays inside eligible fetched content; on ⇒ explainable discovery objects may be inserted, always visually identifiable. |
| `wall_input_intelligence_enabled` | **`false`** | `isFlagEnabled` | `routes/wall.ts:979`, `:1341` | READ + WRITE. Typed/voice session intent parsed into a temporary session-scoped `StructuredIntent`. Off ⇒ typed intent ignored. |
| `wall_compass_handoff_enabled` | **`false`** | `isFlagEnabled` | `routes/wall.ts:982`, consumed in `services/wall/WallProjectionService` `buildActions` | READ. Off ⇒ no Ask-Compass action on Wall objects. Mobile: `travel-buddy-standalone/src/features/wall/components/objects/wallItemShared.tsx:381`. |
| `wall_context_threads_enabled` | **`false`** | `isFlagEnabled` | `services/wall/WallProjectionService.ts:536`, `services/wall/ContextThreadService.ts:1120` | READ. Off ⇒ no object ever carries a `contextThread`. Read **once** per projection. |
| `wall_rab_integration_enabled` | **`false`** | `isFlagEnabled` | `services/wall/wallRabGate.ts:48` | READ. **Necessary but not sufficient** — `wallRabGate` requires it **and** `rent_buddy_enabled` (`:49`), both fail-closed. Off ⇒ no buddy Context Thread is ever built. |
| `wall_moments_enabled` | **ROW ABSENT** | `isFlagEnabled` | `routes/wallMoments.ts:108` (`WALL_MOMENTS_FLAG`, `:43`) | READ. `GET /api/wall/moments` — server-built WallMoments routed through the Attention Engine. Absent ⇒ `feature_disabled`. |

Mobile is wired and waiting: `travel-buddy-standalone/app/(tabs)/_layout.tsx:70`,
`:126`, `:291`, `:463` and
`travel-buddy-standalone/src/navigation/portavaRoutes.ts:219` all gate the Wall
tab on `wall_enabled`. With the flag false the **tab does not appear at all**, so
a hosted tester currently has no way in.

**Why off — this is a deliberate, documented, staged rollout, not neglect.**
`src/migrations/2270_wall_feature_flags.sql:6-30`:

> `Seeds the Wall's capability flags, ALL OFF. wall_enabled is the master gate. […] ONLY the flags with a LIVE reader are seeded here, per the check-flag-polarity rule "a flag arrives with the unit that reads it" […] RUNTIME EFFECT: NONE. With wall_enabled = false the /wall routes short-circuit to a disabled response before any projection/ranking/live read runs. […] Nothing is served to any user until the owner presses wall_enabled.`

Its postcondition (`:79-85`) **refuses to commit if any `wall_%` flag is TRUE**:
"the Wall must ship OFF". `2272_wall_context_thread_flags.sql:20-33` adds the
other two, also OFF, and records that the Feed Diversity Controller (§15) is
deliberately **not** flag-gated — "a quality/safety pass applied whenever the
Wall is on". `2801_wall_moments_flag.sql:21-25` seeds `wall_moments_enabled`
FALSE with a postcondition that refuses a TRUE row: "Enabling is an owner
decision — it opens a new user-facing surface".

**Migration state in production, established from evidence:**
- `2270` and `2272` **are applied** — their seven flag rows exist in the
  2026-10-03 capture at `false`.
- `2271_wall_session_intents` **is applied** — `wall_session_intents` is in the
  production table list.
- `2801` is **not** applied — `wall_moments_enabled` has **no row**, which is the
  one state the migration's postcondition makes impossible if it ran.
- `2308_wall_telemetry_events` is **not** applied —
  **`wall_telemetry_events` is absent from the production table list**, while
  every other table I checked from the same snapshot that should be there is
  there.

##### What `wall_enabled` turning on would need

**Label: `DECISION`** (DECISION-5), with one `MIGRATION` rider and one `CODE`
rider. It is explicitly **not** `FLAG FLIP ONLY`, and the reason is not technical
risk — the routes degrade correctly — but that the migrations say in two places
that this is an owner's decision to open a new user-facing surface.

The question in one sentence: **does Chelsi want the Wall — a brand-new social
feed surface with its own tab — exposed in hosted testing, and if so at what
depth?**

**My recommended default: turn on `wall_enabled` alone, and nothing else.**
Reason: it is the only flag that makes the surface reachable at all, the routes
are built to serve a plain social feed with every intelligence subsystem absent
(`routes/wall.ts:21-25`: "GRACEFUL DEGRADATION IS LOAD-BEARING […] if ranking,
live, compass, place resolution or RAB is unavailable, a SAFE social feed still
returns"), and each of the six children adds an independent new behaviour that
is better evaluated one at a time than all at once.

In order, what each step needs:

1. **`wall_enabled = true`.** Flag flip. The feed assembles For You / Following
   from canonical objects (posts, postcards, video media, shared moments —
   `services/wall/WallCandidateLoaders.ts`) through the existing
   eligibility / privacy / block gates in `WallProjectionService`. No migration
   needed for the feed itself. **Mobile:** the tab appears on next
   `GET /api/feature-flags` fetch; no app release required, since the gate is a
   server flag the client reads.
2. **`wall_telemetry_events` — MIGRATION-1, and it should land *with* step 1.**
   `routes/wallTelemetry.ts` is the server home for **thirteen of §32's fifteen
   analytics events** (its header at `:1-18`: before this route existed, the
   client's fire-and-forget transport "POSTs each one to `/api/wall/telemetry`"
   and "every one of those POSTs 404'd silently"). With `wall_enabled` on and
   `2308` unapplied, `routes/wallTelemetry.ts:329` inserts into a missing table,
   logs `req.log.warn("wall/telemetry: event write failed")` and **still answers
   200** (`:331-334`: "a permanent write failure must not make the client retry
   the same batch forever"). So the Wall works and **every Wall analytics event
   is silently discarded** — which is the worst possible state for a *testing*
   deployment, whose whole purpose is to learn what testers did. Apply
   `src/migrations/2308_wall_telemetry_events.sql`. It is not listed in
   `production-applied-migrations.json`, and that file is a staleness tripwire
   rather than an inventory — the load-bearing evidence is the absent table.
3. **`wall_live_for_you_enabled`** — flag flip, but it inherits the Intel live
   gate chain: `lib/liveClaimRead.liveLabelsServable` requires
   `intel_live_label_crowd`, `intel_claim_projection_crowd`,
   `intel_capture_quick_signal`, `intel_limited_live` **and**
   `disable_intel_live_labels` disengaged (A.12). Those four are the Intel
   section's. 2270's description is explicit that this flag is "Independent of
   the underlying intel live-label gates, which still apply" — so turning it on
   while the Intel chain is off yields an **empty strip**, not an error, and not
   a fabricated label ("The one thing that never degrades to 'make something up'
   is a live label", `routes/wall.ts:24-25`). **Depends on: the Intel chain.**
4. **`wall_input_intelligence_enabled`** — flag flip. `wall_session_intents`
   exists in production, so the store is ready.
5. **`wall_discovery_insertions_enabled`** — flag flip.
6. **`wall_compass_handoff_enabled`** — flag flip. Opt-in per object; Compass
   never occupies a permanent panel (2270's description).
7. **`wall_context_threads_enabled`** — flag flip.
8. **`wall_rab_integration_enabled`** — flag flip **plus** `rent_buddy_enabled`
   must be on (`services/wall/wallRabGate.ts:48-49` requires both, fail-closed on
   each). `rent_buddy_enabled` and the RAB `*_MODE` restrictions are the
   Rent-a-Buddy section's; I did not evaluate them. **Depends on: the RAB
   section.**
9. **`wall_moments_enabled` — MIGRATION-2.** Apply
   `src/migrations/2801_wall_moments_flag.sql` to create the row, then flip it.
   It also needs `wall_enabled` (2801's header: "It sits behind the Wall's master
   `wall_enabled` (2270) as well") and
   `intel_state_snapshot_versions` — **which is present** in production, so
   2801's `RAISE NOTICE` branch about `versions_unavailable` does not apply here.
   The route is read-only and "writes nothing and sends nothing".

**CODE rider (CODE-3):** nothing in the Wall code is wrong, but the Wall is the
one surface in my domain whose flags are **all** false, so it is the only place
where nobody has ever observed the flag-on path in production. Before step 1 I
would run the Wall's own test suite rather than relying on the flag flip — but
per the brief I did not run long suites, so **I cannot report the Wall's flag-on
path as verified**. Stated as a gap, not a finding.

---

### Item index

| id | label | one line |
|---|---|---|
| CODE-1 | CODE | `lib/discoveryStopGate.ts:83` — `sc ? await isKillSwitchEngaged(sc,"disable_discovery_pde") : false` disengages the stop when the service client is absent; use `killSwitchStateUnknown`. |
| CODE-2 | CODE | `src/test/verifyFailOpenStopReads.test.ts:70` — the `FAIL_OPEN` regex matches only the `x && await` spelling, so CODE-1's ternary passes the ratchet silently. |
| CODE-3 | CODE | The Wall's flag-on path has never run in production and I did not run its tests; flag-on behaviour is unverified, not verified-good. |
| MIGRATION-1 | MIGRATION | `src/migrations/2308_wall_telemetry_events.sql` not applied — `wall_telemetry_events` absent from production; with `wall_enabled` on, 13 of 15 §32 Wall analytics events are silently discarded behind a 200. |
| MIGRATION-2 | MIGRATION | `src/migrations/2801_wall_moments_flag.sql` not applied — `wall_moments_enabled` has no row; `GET /api/wall/moments` answers `feature_disabled`. |
| MIGRATION-3 | MIGRATION | `src/migrations/2294_event_passport_shares.sql` not applied — `passport_event_share_enabled` row absent and `event_passport_shares` table absent; event passport sharing is dead. |
| CONFIG-1 | CONFIG | `AI_INTEGRATIONS_OPENAI_API_KEY` (+ `STAMP_IMAGE_MODEL`) — required by `ai_visual_provider_enabled=true` (`openaiImageProvider.ts:92`) and by stamp artwork (`imageProvider.ts:153`); without it stamps render placeholder SVGs (`generationWorker.ts:1417`). |
| CONFIG-2a | CONFIG | Valid Foursquare key as `FSQ_API_KEY_PROD` (or `FOURSQUARE_API_KEY`) — `replit.md:53` says the current key 401s; `lib/foursquarePlaces.ts:58-68` then silently disables venue search in `/api/places/search`. I could not re-verify the 401 without calling the API. |
| CONFIG-2b | CONFIG | `fsq_places` must be ingested per test city via `scripts/load-fsq-city.mjs` (needs the FSQ parquet + DuckDB); otherwise `GET /api/cities/:cityKey/places` answers `{places:[], enabled:true}`. I could not establish which `city_key`s are loaded. |
| CONFIG-3 | CONFIG (unverified) | `budget_fx_conversion_enabled` — I did **not** establish whether FX conversion calls an external provider needing a key or uses seeded rates. Must be confirmed, not assumed clean. |
| DECISION-1 | DECISION | Collapse `find_your_circle_enabled` / `find_your_circle_disabled` into one flag? **Recommend no** — they answer different questions with different required failure directions, and both are correct today. |
| DECISION-2 | DECISION | Nine inert flags (6 `events_*`, `passport_contribution_enabled`, `stamp_admin_award_enabled`, `ai_visual_regeneration_enabled`) gate nothing yet appear on the admin toggle surface and in the mobile payload. **Recommend drop the rows.** |
| DECISION-3 | DECISION | Turn on `passport_travel_dna_enabled` (prod `false`)? **Recommend yes** — OFF means every inferred DNA dimension shows regardless of the user's stored Hide choice. |
| DECISION-4 | DECISION | Turn on `ai_visual_admin_review_enabled` (prod `false`)? **Recommend yes** — admin-gated, and with auto-approve on it is the only review path for generated imagery. |
| DECISION-5 | DECISION | Expose the Wall in hosted testing, and at what depth? **Recommend `wall_enabled` alone + MIGRATION-1**, then the six children one at a time. |

### Things I could not establish

Stated rather than guessed, per the brief.

1. Whether the Foursquare key is **still** 401-rejected today (CONFIG-2a) — I may
   not call the API or read the secret.
2. Which `city_key` values are loaded in `fsq_places` in production
   (CONFIG-2b) — needs a row count.
3. Whether `budget_fx_conversion_enabled` requires an external FX provider
   (CONFIG-3) — I did not read `routes/tripBudgetIntel.ts` past its gates.
4. The Wall's behaviour with `wall_enabled = true` (CODE-3) — no test run.
5. Any production table created **after 2026-09-22**, the snapshot watermark.
   Every absent-table claim here is corroborated by an absent flag row in the
   2026-10-03 capture, which is why MIGRATION-1/2/3 stand; but a table added in
   that window and not accompanied by a flag row would be invisible to me.
## 08 — The MECHANISM: how a flag reaches the app, schema capability gates, and env-var gates

Domain: the switching mechanism itself, not one feature area. Three parts.
All line numbers were read in this session. Paths are relative to
`/home/user/portava.app`.

---

### PART 1 — How the mobile app learns about flags

#### 1.1 The one wire

The mobile tree (`travel-buddy-standalone`, the only mobile tree) learns flag
values from exactly one public endpoint:

* **Server**: `artifacts/api-server/src/routes/featureFlags.ts:14` —
  `GET /api/feature-flags`, mounted at
  `artifacts/api-server/src/routes/index.ts:241` (imported :75). It selects
  `flag, enabled, description` from `feature_flags` (:19-22), filters a
  hardcoded `INERT_FLAGS` set (:38-53), and returns
  `{ flags: resolveFeatureFlags(flags) }` (:60).
* **Client**: `travel-buddy-standalone/src/context/FeatureFlagsContext.tsx:55`
  fetches it; the provider is mounted once at the app root,
  `travel-buddy-standalone/app/_layout.tsx:378` (import :52, closes :443).
* **Two extra, independent clients for two single flags**:
  `src/hooks/useRentABuddyFlag.ts:46` / `:114` / `:174` (`rent_buddy_enabled`)
  and `src/hooks/useCircleFlag.ts:27` (`find_your_circle_enabled`). Each hits
  the same endpoint with its **own module-level cache** (below).
* The mobile tree's `server/` directory (`serve.js` + templates) contains no
  flag path — checked.
* `travel-buddy-standalone/src/services/adminVisuals.ts:179` and
  `app/admin/feature-flags.tsx:268/288` use the **admin** endpoints
  (`/api/admin/feature-flags`, PATCH per flag). Those are the write path, not
  the app's read path.

#### 1.2 Resolved or raw? — RESOLVED, twice

The question matters because of the Live Places parent hierarchy.

* Server: `resolveFeatureFlags` is applied **before the response is written**
  (`routes/featureFlags.ts:60`), and it is defined at
  `artifacts/api-server/src/lib/featureFlags.ts:109-117`: for every flag named
  in `LIVE_PLACES_REQUIREMENTS` (`:98-107`) that is present in the raw map, the
  value becomes `raw[flag] === true && every parent === true`.
* Client: `FeatureFlagsContext.tsx:86-98` re-applies the **same** hierarchy from
  its own inline copy of the table (`:87-96`).

**So the mobile client gets RESOLVED values, and the resolution is enforced
twice.** Consequence for hosted testing: flipping a Live Places child flag
alone does **nothing** — the server zeroes it on the way out and the client
would zero it again. `external_places_enabled` → `live_places_enabled` →
`place_days_enabled` → `shared_moments_enabled` must be turned on, in that
chain, before any of `shared_moments_compass_suggestions_enabled`,
`shared_moments_clustering_enabled`, `place_recaps_enabled`,
`moment_recaps_enabled`, `shared_moments_chat_enabled` can read anything but
`false` on the device. (A `false` the client sees is indistinguishable from the
child being off — there is no "blocked by parent" signal on the wire.)

Note the duplication risk: the client's copy of the table at
`FeatureFlagsContext.tsx:87-96` is a hand copy of
`lib/featureFlags.ts:98-107`. They agree today (compared key by key). Nothing
in the build checks that they stay in agreement. Because the server resolves
first, a client copy that drifted could only make a flag *more* dark, never
less.

#### 1.3 Client-side cache — YES, three of them, and one server-side filter

**(a) `FeatureFlagsContext` — no TTL, but refresh only on two events.**
`FeatureFlagsContext.tsx:72-74` fetches on mount; `:77-84` re-fetches on
`AppState` transition to `'active'`. There is **no polling and no timer**. On a
failed fetch it keeps the previous map (`:56` returns early on `!res.ok`, `:61`
swallows network errors) — fail-soft, so a stale map can persist indefinitely
across outages. Initial default is `{}` and `isEnabled` answers `false` for an
unknown key (`:97`), i.e. fail-closed for an unread flag, which is also the
context default outside the provider (`:36-40`, relied on at
`src/features/media/hooks/useMediaSurfaceDecisions.ts:7-9`).

**(b) `useRentABuddyFlag` — module-level cache, TTL 5 minutes.**
`src/hooks/useRentABuddyFlag.ts:13` `CACHE_TTL_MS = 5 * 60 * 1000`. The cache
is module scope (`:12-13`), so it is shared by every mount and lives for the
life of the JS context; it is **not** invalidated on foreground. Read sites:
`:109-111`, `:131`, `:169`, `:196`. Mitigation that exists: the tri-state gate
`useRentABuddyGate` (`:187-210`) exposes `retry()` which resets the cache
(`:209`), so the "Check again" button on the OFF screen sees an admin's flip
without waiting out the TTL. An `unknown` (failed read) is deliberately never
cached (`:174-176`).

**(c) `useCircleFlag` — the same pattern, TTL 5 minutes, NO retry seam.**
`src/hooks/useCircleFlag.ts:14` `CACHE_TTL_MS = 5 * 60 * 1000`, module cache
`:12-13`, read `:22` and `:44`. `_resetCircleFlagCache` (`:16`) exists but is
documented and used as a test seam; no UI calls it. So
`find_your_circle_enabled` is the slowest flag on the device.

**(d) A server-side hardcoded filter that can keep a feature dark regardless of
the DB.** `routes/featureFlags.ts:38-53` `INERT_FLAGS` — 16 flag names that are
**stripped from the response** whatever the `feature_flags` row says:
`freeze_city`, `freeze_event`, `freeze_circle`, `freeze_booking`,
`intel_sensing_credentials_enabled`,
`intel_sensing_device_enrollment_enabled`, `COMPASS_FRONTLOAD_ENABLED`,
`COMPASS_ACTIVE_REWARD_ENABLED`, `COMPASS_EXPLAIN_WHY_ENABLED`,
`COMPASS_ADMIN_CONTROLS_ENABLED`, `COMPASS_ABUSE_DEFENSE_ENABLED`,
`COMPASS_NOTIFICATION_INTELLIGENCE_ENABLED`, `notifications_enabled`,
`notification_digests_enabled`, `realtime_activity_enabled`,
`safety_notifications_enabled`. This is a **code filter, not a flag**: setting
any of these to `true` in production would have no effect on the app and would
require a `CODE` change to the filter. It is harmless today — all 16 have
**row absent** in the 2026-10-03 production capture — but it is a trap if
anyone seeds those rows for hosted testing and expects the app to see them.

**(e) No HTTP caching.** `routes/featureFlags.ts` sets no `Cache-Control`, and
`app.ts`, `middlewares/` and `lib/http.ts` set none either (grepped). So no
proxy-level staleness is introduced by this repo. If the hosting layer (the
Replit deployment / any CDN in front of it) caches a keyless public GET, that
would be an additional, unmeasured delay this repo cannot see — I cannot
establish the hosting layer's behaviour from the tree, and I do not claim it.

#### 1.4 How long until a flipped flag reaches a running app

Measured from the code, not estimated:

| Reader | What triggers a re-read | Worst case for a *running* app |
| --- | --- | --- |
| `FeatureFlagsContext` (almost all flags) | mount, and every `AppState → 'active'` (`:77-84`) | **the next time the app is backgrounded and foregrounded, or relaunched.** An app left in the foreground never re-reads. |
| `useRentABuddyFlag` / `useRentABuddyGate` | hook mount, if the 5-minute module cache is stale (`:13`, `:196`); or `retry()` (`:209`) | **5 minutes after the next mount**, or immediately via "Check again" |
| `useCircleFlag` | hook mount, if the 5-minute module cache is stale (`:14`, `:44`) | **5 minutes after the next mount**; no in-app reset |
| API server (`isFlagEnabled`, `lib/featureFlags.ts:14`) | every call — an uncached `maybeSingle()` per read | **immediate** |
| Capability schema probes (`lib/capability/schemaCapability.ts:63-64`) | `READY_TTL_MS = 5 min` for `ready`, `ABSENT_TTL_MS = 30 s` for `missing`/`unknown`, per client object | up to 5 min to notice a *regression*; up to 30 s to notice a freshly applied migration |

**Practical answer for Chelsi**: a flag flip is live on the server instantly,
and reaches a device on the next foreground (background → foreground is enough;
no reinstall or rebuild). Rent-a-Buddy and Find-Your-Circle can lag a further
5 minutes. There is **no** build-time flag constant that would require a new
EAS build for any *server* flag.

#### 1.5 Flags hardcoded in the mobile tree (independent of the database)

Every one found, with file:line. These are the switches a flag flip in the DB
cannot move.

| Constant | File:line | What it gates | Value | Why off (quoted/cited) | To turn on |
| --- | --- | --- | --- | --- | --- |
| `E2EE_VERIFICATION_UI_ENABLED` | `travel-buddy-standalone/src/lib/e2ee/verificationGate.ts:29` | the safety-number / E2EE verification UI (UI only) | `false` | ":22-24 FLIP THIS ONLY AFTER: an EAS build produces a working native module AND the two-device runbook (docs/security/e2ee-verification-runbook.md) passes, including step 9"; ":26-28 This is a source constant, not a server feature flag" | **CODE** (+ an EAS build and the runbook) |
| `E2EE_CLAIM_UI_ENABLED` | `travel-buddy-standalone/src/lib/e2ee/verificationGate.ts:68` | whether the UI may render the padlock / claim a thread is E2E encrypted (UI only) | `false` | ":47-54 two conditions are unmet — FFI bar 2 unproven (issue #3556) and the client E2EE UX gap open in `app/messages/[id].tsx`" | **CODE** |
| `DEFAULT_ENABLED` (`isResumableMediaUploadEnabled`) | `travel-buddy-standalone/src/services/media/uploadTransportFlag.ts:19` (read `:28-31`) | the §37 upload transport: persisted upload queue, resumable parts, OS background transfer (WRITE path) | `false` | ":6-9 SHIPS OFF, and that is the point of it … they have never run on a device, and an upload transport that misbehaves on a real network loses users' posts"; ":12-14 Deliberately NOT a server feature flag: the resume half has to decide what to do at APP LAUNCH, before any network" | **CODE** + the two device proofs named at `:15-17` |
| `DEFAULT_ENABLED` (`isDeviceVideoCompressionEnabled`) | `travel-buddy-standalone/src/services/media/videoCompression.ts:61` (read `:70-72`) | on-device video compression before upload (WRITE path) | `false` | `:46-49` "SHIPS OFF. `DEFAULT_ENABLED` is false and stays false until a device run has shown a compressed clip upload, play back at the right orientation, and keep its duration — even after a build that contains the module." | **CODE** — and note the native module `PortavaVideoCompressor` (`:52`) does not exist in the tree; this is adjacent to the OPEN video-upload question in the brief, so **no change is proposed here** |
| `DEFAULT_ENABLED` (`isAccountScopedStorageEnabled`) | `travel-buddy-standalone/src/config/accountScopedStorageFlag.ts:17` (read `:30-33`) | per-account scoping of four local stores (reminders, discoveryBookmarks, TelegraphSuggestionTray cache, checkpointArrivalTask queue) — local storage, cross-account leakage fix | `false` | ":13-14 Ships OFF. Flip DEFAULT_ENABLED to true (or use the test seam) once the migration has been validated against a real device"; ":7-11 Deliberately NOT wired to FeatureFlagsContext … must be readable synchronously from anywhere, including outside any component tree" | **CODE** + a device validation |

`__DEV__` branches that change *feature behaviour* (Metro inlines `__DEV__` to
`false` in every production bundle, so each of these is OFF in any EAS build —
including a `preview`/`development` *distribution* built in release mode):

| Site | Effect |
| --- | --- |
| `travel-buddy-standalone/src/components/AgeGate.tsx:103` (explained `:16-18`, `:55-58`, `:100-102`) | the age gate is **bypassed** in dev builds. In a hosted test build the DOB gate is live. |
| `travel-buddy-standalone/src/hooks/useCityPulse.ts:83`, `:99`, `:113` | City Pulse falls back to `mockEvents` in dev only. In a hosted build an empty/failed `/api/events` shows a real empty state — so Ticketmaster config (Part 3) actually matters. |
| `travel-buddy-standalone/app/gems/share-icon-preview.tsx:56/61`, `app/gems/bookmark-preview.tsx:142/147` | whole dev-only preview screens; return `null` in a release build. |
| `travel-buddy-standalone/src/services/verification.ts:156` | a mock-complete verification call documented as "Should only be called from the mock-complete screen (gated by `__DEV__`)". |
| `travel-buddy-standalone/app/_layout.tsx:20`, `:28` | Sentry enabled only when `!__DEV__`, and `:28` warns when a release build has no `EXPO_PUBLIC_SENTRY_DSN`. |
| `travel-buddy-standalone/app/index.tsx:28` | a release build with no backend config renders "App not configured" instead of the mock-data app. |

`app.json` / `eas.json` — **no feature flags found**. Checked in full:
* `travel-buddy-standalone/app.json` holds name/version/permissions/plugins and
  one policy block, `extra.sensingPermissions.acousticEnergy`
  (`app.json:151-164`), whose `"defaultGranted": false` and
  `"requiresExplicitOptIn": true` are a **permission** declaration, not a
  feature flag — enforced at `src/lib/sensing/acousticPermission.ts` per the
  comment at `app.json:150`. It is per-user consent, not an operator switch.
* `travel-buddy-standalone/eas.json` sets only `EXPO_PUBLIC_API_BASE_URL` and
  `EXPO_PUBLIC_WEB_ORIGIN`, both `https://portava.replit.app`, identically for
  `development` (`:9-12`), `preview` (`:19-22`) and `production` (`:29-32`). No
  flag-shaped env var. **All three profiles point at the same backend**, so a
  hosted test build will read the same `feature_flags` table as production —
  worth stating plainly: there is no separate staging flag set.
* `travel-buddy-standalone/src/constants/killSwitches.ts:1-7` is a label map
  only (`disable_posting`, `disable_messaging`, `disable_signups`,
  `disable_rent_buddy_booking`, `invite_only_beta`) — display strings, no gate.

One more build-time constant worth naming because it *looks* like an env gate
and is not: `travel-buddy-standalone/src/constants/mapStyle.ts:25` hardcodes
OpenFreeMap as the map style and `:12-16` records that
`EXPO_PUBLIC_MAPTILER_KEY` is **no longer read** by `getMapStyleUrl` ("the key
consistently returned HTTP 403 on the /styles endpoint"). Setting that key
changes nothing for the main maps; it is still read at
`src/components/media/RouteItPlaceSheet.tsx:26`.

---

### PART 2 — Flags that are ON but dead because their SCHEMA is unapplied

#### 2.1 The mechanism, in short

`capability = FLAG_ENABLED && SCHEMA_CAPABILITY_READY`
(`artifacts/api-server/src/lib/capability/schemaRequirement.ts:4`). A flag row
`enabled = true` is "a STATEMENT OF INTENT. It is not evidence that the code
behind the flag can run" (`:6-8`). The founding case is quoted in that same
header (`:11-13`): "`media_canonical_enabled` was TRUE in production for three
weeks while `media_assets` lacked the four columns migration 2250 adds; every
write was rejected with PGRST204 and every rejection was swallowed by
`if (error) return null`. Enabled, dead, silent."

The fix has three parts.
1. **Declaration.** `lib/capability/registry.ts` is the single place a flag's
   schema requirement lives (`schemaRequirement.ts:20-32` says why: a registry
   can be enumerated by CI without executing runtime modules). Each
   `CapabilityDefinition` (`schemaRequirement.ts:67-85`) names the `flag`, the
   `providedBy` migration files, the `requires` tables/columns/functions, and
   the `consumers` that must consult it.
2. **Runtime probe.** `lib/capability/schemaCapability.ts` SELECTs exactly the
   required columns pinned to a sentinel id that cannot exist
   (`schemaRequirement.ts:36`), so PostgREST answers `null` when every column
   exists, PGRST204/42703 for a missing column, PGRST205/42P01 for a missing
   table (`schemaCapability.ts:16-20`, classifiers `:77-108`). Three verdicts,
   **two of which refuse**: `ready`, `missing`, `unknown` — and `unknown`
   refuses too, "A guard that lets a write through because it could not check
   is not a guard" (`:36-38`). Memoised per client: 5 min for `ready`, 30 s for
   the others (`:63-64`), so a freshly applied migration is picked up without a
   restart. Flag `off`/`absent`/`unreadable` all give `enabled: false`
   (`:39-41`). `requireCapability` throws a 503 `degraded_unavailable` rather
   than letting a route answer an empty 200 (`:48-50`).
   `functions` are **statically checked only, never probed** — "a probe that
   can execute the writer it is checking for is not a probe"
   (`schemaRequirement.ts:56-62`).
3. **Offline ratchet.** `lib/capability/prerequisitesCore.ts` + `src/scripts/`
   `checkFlagSchemaPrerequisites.ts` answer, without touching production: "For
   every feature flag the tree reads: does the code behind it name schema that
   PRODUCTION does not have, and is the flag ON there?"
   (`prerequisitesCore.ts:6-10`). It walks the TypeScript AST from each flag
   read through the enclosing function's call closure
   (`prerequisitesCore.ts:26-40`), compares the schema it names against a dated
   capture in `lib/capability/snapshots/`, and classifies each as `unguarded`
   (ON + absent object + no registry entry → "The code runs and fails"),
   `guarded` (same state but declared and refused), or `latent` (flag off or no
   row — "One `UPDATE feature_flags` away from `unguarded`")
   (`prerequisitesCore.ts:48-58`). Kill switches are excluded by design
   (`:44-46`). It is a **floor**, not a census: "A payload built in another
   module, a column reached through a variable, a table named dynamically —
   none of these are seen" (`:42-44`).

Two files carry the evidence, and they are different things:
* `lib/capability/production-applied-migrations.json` — a record of what *we*
  applied. Its own header calls it "a staleness tripwire, not an inventory"
  and is explicit that hand-applies through the Supabase dashboard write no row.
* `lib/capability/snapshots/<date>-production-schema.json` — a capture of
  production's actual `information_schema` / `pg_proc` / `feature_flags`. The
  current one is named at `lib/capability/snapshots/current.ts:104`:
  `20260922-production-schema.json`, `capturedAt` `2026-09-22T16:07:23Z`, 497
  tables.

#### 2.2 THE CAVEAT, stated before the table

**"Not in `production-applied-migrations.json`" is NOT the same as "not applied
in production."** The file's own header records three separate occasions where
it LAGGED production (the 2026-09-20 five-migration backfill, the 2026-09-22
2400/2966 backfill, and `dead_check_vocabularies_2298` / `stamp_definitions.
evidences_presence` from 2970 which it deliberately refuses to list at all),
and explains why the tripwire cannot catch that direction: "the tripwire only
fires when this file is AHEAD of the snapshot, so a file that LAGS reality is
invisible to it." The brief's own example is corroborated inside the tree:
`artifacts/api-server/src/services/stories/storyRetention.ts:197` — production
holds HLS/subtitle objects "written by code that exists in no branch of this
repository (two migrations applied to production on 2026-09-25 whose files are
not here)."

So, for every verdict below I have graded against the **snapshot** (which reads
production's own catalogue) wherever the snapshot covers the object, and I say
where a conclusion rests on the migrations *record* instead. The snapshot is
itself 11 days old as of 2026-10-03 and post-dates nothing applied after
2026-09-22 — including those two September-25 media migrations. **Every "MISSING"
verdict below is therefore a statement about 2026-09-22, not about today, and
any of them may have been quietly resolved since.** A "READY" verdict is more
durable: objects are not usually removed.

#### 2.3 Every capability in the registry

`CAPABILITIES` is frozen at `lib/capability/registry.ts:193-238` and has **six**
entries. A seventh definition exists and is deliberately *not* registered
(`:221-237`). Flag values are the 2026-10-03 production capture
(`scratchpad/flags/prod-sorted.txt`).

| Capability (definition site) | Flag (polarity) | Requires (migrations) | Applied per `production-applied-migrations.json` | Present in snapshot `20260922` (verified column by column) | Prod flag 2026-10-03 | **Real state** |
| --- | --- | --- | --- | --- | --- | --- |
| `INTEL_REWARD_REVERSAL` — `registry.ts:179-191` | `intel_rewards` (capability) | `2900_intel_reward_ledger_reversals.sql` → `intel_reward_ledger.reverses_entry_id` | **YES**, `20260914193020` | **READY** | `true` | **LIVE.** Flag ON, schema ready. Note `registry.ts:160-162` says "2900 appears NOWHERE in production-applied-migrations.json" — that comment is **stale**: 2900 is listed, applied 2026-09-14, and the column is in the capture. |
| `MEDIA_CANONICAL` — `registry.ts:55-70` | `media_canonical_enabled` (capability) | `2250_media_asset_canonical_model.sql`, or `2470_..._flag_agnostic.sql` → `media_assets.captured_at / location_visibility / provenance / intelligence_eligibility` | 2250 **NO**; **2470 YES**, `20260916173740` | **READY** (all four columns) | **`false`** | **Schema ready, flag OFF.** The founding case has inverted: the columns exist and the flag is now off. `registry.ts:52-54` still records the owner decision as open (`MEDIA_CANONICAL_FLAG`); the 2026-09-16 note at `src/scripts/checkFlagSchemaPrerequisites.ts:355-357` says ORDER B was taken and "the flag was already TRUE and is untouched". **Somebody turned it off between 2026-09-16 and 2026-10-03 and I can find no record of why in the tree.** → `FLAG FLIP ONLY`, but with a `DECISION` attached: who turned it off and why. |
| `LOCATE_FRIENDS_CREW_PRESENCE` — `registry.ts:120-139` | `locate_friends_enabled` (capability) | `2219_locate_friends_sessions.sql` → `locate_friends_members(session_id,user_id,left_at)`, `locate_friends_sessions(id,started_at,expires_at,ended_at)` | **YES**, `20260908013420` | **READY** | `false` | **Schema ready, flag OFF.** Turning it on also turns on a Passport `with_crew` read whose audience is an **open owner decision** (`registry.ts:111-118`, `PASSPORT_CREW_PRESENCE_AUDIENCE`). → `DECISION` then `FLAG FLIP ONLY`. |
| `DISCOVERY_TRIP_PROJECTION` — `lib/discoveryTripProjectionConsumer.ts:141-166` | `discovery_trip_projection_enabled` (capability) | `2420_trip_kernel_foundation.sql` (adds `trips.version`), `2550_discovery_trip_projection_consumer_flag.sql` (seeds FALSE) | **YES**: 2420 `20260908005403`, 2550 `20260908023317` | **READY** (all 20 columns of `TRIP_DISCOVERY_SOURCE_COLUMNS`, `domain/trips/contracts/tripDiscoveryProjection.ts:136-139`, present on `trips`) | `false` | **Schema ready, flag OFF.** Refusal falls back to the legacy pre-2420 read, so OFF is a correct answer, not a degraded one (`discoveryTripProjectionConsumer.ts:40-50`). Turning it on makes owners' `show_exact_dates` / `show_destination_city` / `show_header_publicly` toggles apply to Discovery searchers (`:64-73`) — a behaviour change, in the more-private direction. → `FLAG FLIP ONLY`. |
| `TRIP_OPERATIONAL_PROJECTIONS` — `domain/trips/policies/tripOperationalProjections.ts:31-77` | `trip_operational_projections_enabled` (capability) | 2420, 2760, 2761, 2762, 2778 (seeds FALSE), 2780, 2781, 2784, 2785, 2794 | **YES, all ten** (2760 `20260916201420` … 2794 `20260916210038`; plus the 2796 privilege repair `20260917031001`) | **READY** — all 13 tables and every named column present | `false` | **Schema ready, flag OFF.** This is the single highest-leverage flip in the mechanism: `checkFlagSchemaPrerequisites.ts:144-149` records that Safe Return's subgroup branch is behind this gate and "`POST /me/safe-return/sessions` still refuses `feature_disabled` before either table is read". → `FLAG FLIP ONLY`. |
| `COMPASS_CONVERSATION_PHASE1` — `services/compass/CompassConversationService.ts:40-58` | `COMPASS_ENABLED` (capability) | `2996_compass_conversations_phase1_schema.sql`, `2997_compass_recommendation_lineage.sql` → `compass_conversations(trip_id,status)`, `compass_served_recommendations(revoked_at,revocation_reason)`, `compass_outcome_events(weight_nudge)` | **YES**: 2996 `20260920194626`, 2997 `20260920194928` | **READY** | `true` | **LIVE.** Flag ON, schema ready. The former `KNOWN.COMPASS_ENABLED` exemption was struck for exactly this reason (`checkFlagSchemaPrerequisites.ts:293-310`). Caveat carried from that note (`:299-303`): "2910 created all six tables EMPTY, so a Trail plan compiles over no rows … **Applied is not enabled.**" |
| `MAP_TRIP_PROJECTION_CAPABILITY` — `lib/mapProjectionTripContract.ts:141-161` — **deliberately NOT in `CAPABILITIES`** (`registry.ts:221-237`) | `map_trip_projection_read_enabled` (capability) | 2420, 2520, 2610 → `trip_map_projections` + its columns | **YES**: 2520 `20260908010109`, 2610 `20260908010501` | **READY** (all 11 columns) | `false` (**the registry comment at `:232-235` says "production has no row … and no trip_map_projections table" — both halves are now wrong**) | **Schema ready, flag OFF, and the registry's stated reason for leaving it unregistered is stale.** `resolveCapability` takes the definition directly so the Map reader is guarded either way (`:222-223`). `registry.ts:236-237` says "Register it when 2520 -> 2610 are applied and the flag has a row" — both conditions are met. → `FLAG FLIP ONLY` for the feature; a separate small `CODE` tidy-up to register the entry. |

#### 2.4 "Flag TRUE in production is not proof the feature works" — every case today

This is the headline finding and it is a short list, because the mechanism has
largely done its job.

**Case 1 and 2 — the two live `unguarded` entries. `intel_capture_quick_signal`
and `intel_trail_followup` are both TRUE in production over an absent database
function.**
`src/scripts/checkFlagSchemaPrerequisites.ts:393-404` (quick_signal) and
`:405-412` (trail_followup). Both charge the same single object,
`intel_contributor_token()`, to the same closure
(`services/intel/IntelCaptureService.findReplayedObservation`).
* Production flags (2026-10-03): `intel_capture_quick_signal=1`,
  `intel_trail_followup=1`.
* `3002_intel_contribution_identity.sql` **is in the tree**
  (`artifacts/api-server/src/migrations/3002_intel_contribution_identity.sql`)
  and appears **zero** times in `production-applied-migrations.json`.
* **Verified against the snapshot, not just the record**:
  `intel_contributor_token` is absent from the `20260922` capture's `functions`
  list, and no function whose name contains "contributor" is present. So this
  one does **not** depend on the record being complete.
* What it actually means, quoting the entry (`:397-404`): the function is
  "named on a branch production never executes" — `writeObservation`'s replay
  lookup filters on `actor_id` first, "the whole answer while 3002 is
  unapplied", and reaches the RPC "only when that finds nothing, which cannot
  happen before the apply"; and the call is wrapped so an unavailable RPC
  yields a retryable `db_error`. These are classed `unguarded` because no
  registry entry declares the requirement, not because a user-visible path is
  broken.
* **To turn on for hosted testing**: `MIGRATION` — apply
  `3002_intel_contribution_identity.sql` (not applied per the record **and**
  the function is absent in the capture) and record it. Until then the feature
  works on its pre-3002 branch. Note the entry's own instruction: strike the
  KNOWN entry when 3002 lands; the ratchet reports it STALE first.

**Case 3 — `COMPASS_V1_RULE_BASED_ENABLED` is TRUE over objects production
lacks, and the ratchet no longer charges it.**
* Production: `COMPASS_V1_RULE_BASED_ENABLED=1`.
* `checkFlagSchemaPrerequisites.ts:415-427` records that the Compass-gated
  `GET /discovery` handler reaches `rankForViewer`, whose §85 post-rank stages
  name `3484`'s three `compass_city_confidence` columns and `2892`'s
  `place_momentum`. Verified: `2892` and `3484` appear **zero** times in
  `production-applied-migrations.json`; in the `20260922` snapshot the table
  `place_momentum` is **absent**, and `compass_city_confidence` exists with
  only `city, depth_score, tier, signals, computed_at` — 3484's provenance
  columns are **not** there. Both halves confirmed against the capture, so this
  does not rest on the record.
* The entry was **STRUCK** (not resolved by an apply) because a refactor made
  `rankForViewer` "gated somewhere inside", so the scan's function-granular gate
  boundary now charges the same seven objects to
  `discovery_trend_rediscovery_retest_enabled` instead — which has **row
  absent** in production, so they classify `latent`.
* Why nothing breaks today, per `:421-424`: "with every §85 flag FALSE,
  pdePostRankStages returns before either read … absence degrades to
  `columns_absent` / a named failed read. Nothing reads them in production."
* **This is the sharpest instance of the Part-2 point for hosted testing**: if
  Chelsi turns on the §85 discovery flags to get "full functionality",
  `COMPASS_V1_RULE_BASED_ENABLED=1` stops being harmless and those reads start
  being attempted over absent schema. → `MIGRATION` (2892 and 3484) **before**
  any §85 / `discovery_trend_*` flip, not after.

**Case 4 — a general caution, not a specific defect.** The 2026-09-08 retirement
note at `checkFlagSchemaPrerequisites.ts:244-277` applies to a large set of
flags that are ON in production today — `trust_engine_enabled=1`,
`layover_plans_enabled=1`, `airport_mode_enabled=1`,
`layover_safety_engine_enabled=1`, `hidden_gems_enabled=1`,
`intel_limited_live=1`, `intel_live_label_crowd=1`,
`intel_claim_projection_crowd=1`, `safe_return_enabled=1`,
`safe_return_trusted_circle_alerts_enabled=1`. Their *schema* halves were
closed by applying migrations, and the note is explicit about what that does
and does not mean (`:273-277`): "It does NOT mean the features run. The branch
carrying their code is unmerged, and the layover upsert path is behind
`layover_stable_recommendation_ids_enabled`, seeded FALSE by 2410 — so nothing
a traveller sees has changed." Production confirms:
`layover_stable_recommendation_ids_enabled=0`. **A flag reading TRUE is not
proof the feature works, and for these ten the reason is now code and
downstream flags rather than schema.**

**What is NOT a case.** No entry in the six-entry registry is currently
ON-with-unready-schema. Every required object of all seven definitions
(including the unregistered Map one) is present in the `20260922` capture —
checked column by column, not inferred from the migrations record. The two ON
flags among them, `intel_rewards` and `COMPASS_ENABLED`, are both ready.

**Which conclusions depend on the record being complete:** none of the MISSING
verdicts above (Cases 1-3 were all confirmed against production's own
catalogue). What *does* depend on the record is the attribution — "2470 is why
the media columns are there", "2900 is why `reverses_entry_id` is there". If
the record is incomplete, the columns are still there; only the story of how is
uncertain. And every verdict in this section, READY or MISSING, is as of
`2026-09-22T16:07:23Z`; the 2026-09-25 media migrations that exist in no file
here are proof that production moved after that instant in ways this repository
cannot describe.

---

### PART 3 — Environment-variable gates (a separate switch class from the flag table)

Scope: vars that turn a **feature** on or off, plus credentials whose absence
disables a feature (a CONFIG item for Chelsi). Excluded: log levels, ports,
intervals/TTLs, batch sizes, rate limits, test/CI/golden-file harness vars
(`W146_*`, `P16_*`, `P33_*`, `P85_*`, `CENSUS_*`, `GUARD_*`, `*_LOCAL_DB_URL`,
`STATE_MACHINE_*`, `PROJECTION_*`, `UNCHECKED_READS_*`, `LAYOVER_CUTOVER_*`,
`FLAG_SCHEMA_*`, `SEED_*`, `*_GOLDEN*`, `ALLOW_TEST_MEDIA_SEED`,
`ALLOW_REMOTE_VERIFY`, `WALL_BENCH_DIAG`, `DEBUG_ROUTE_ERRORS`).

Boot-time contract: `artifacts/api-server/src/lib/envValidation.ts:9-14` —
`REQUIRED_KEYS` is `PORT`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`SESSION_SECRET`; missing any of them is `process.exit(1)`. `:17-45` is
`OPTIONAL_KEYS`, "missing values disable a feature but should not crash."

#### 3.1 True on/off switches (API server)

| Var | Gates | file:line | Default if unset | Set to, for hosted testing |
| --- | --- | --- | --- | --- |
| `STAMP_WORKER_ENABLED` | the stamp **generation worker** loop — no worker, no stamps are ever generated from queued jobs (background job) | `artifacts/api-server/src/index.ts:261`; also `lib/stamps/generationWorker.ts:1005`, `:1339` | **OFF** (strict `=== "true"`) | `STAMP_WORKER_ENABLED=true` — required for stamps to work at all |
| `FX_REFRESH_ENABLED` | the daily FX refresh loop that pulls ECB rates into `fx_rates`; without it budget conversions use whatever is already in the table (background job) | `artifacts/api-server/src/index.ts:275` | **OFF** | `FX_REFRESH_ENABLED=true` |
| `PLACE_COLLECTIONS_WORKER_ENABLED` | the place-collections worker (background job) | `artifacts/api-server/src/lib/places/placeCollectionsWorker.ts:683` (`!== "true"` → return) | **OFF** | `PLACE_COLLECTIONS_WORKER_ENABLED=true` |
| `STAMP_COUNTRY_SWEEP_ENABLED` | the periodic XX-catalog sweep that re-keys stamp catalog entries once a country becomes resolvable (background job) | `artifacts/api-server/src/lib/stamps/xxCatalogRepair.ts:474`; started unconditionally at `index.ts:282` | **⚠ ON** — only the exact string `"false"` disables it | leave unset |
| `TRANSLATION_ENABLED` | the whole translation feature (detect + translate) | `artifacts/api-server/src/lib/translation.ts:51` | **⚠ ON** — `(… ?? 'true') !== 'false'` | leave unset (on), **but see `TRANSLATION_PROVIDER`** |
| `TRANSLATION_PROVIDER` | which translation engine; `openai` is the only real one | `artifacts/api-server/src/lib/translation.ts:164` | **`mock`** | `TRANSLATION_PROVIDER=openai` **and** `AI_INTEGRATIONS_OPENAI_API_KEY` — otherwise translation is on and returns mock output |
| `IDENTITY_PROVIDER` | identity verification. **`mock` THROWS in production or any hosted deployment** | `artifacts/api-server/src/services/identityVerification/providers.ts:149-153`; guard `lib/paymentsMode.ts` via `providers.ts:167` | `mock` → **hard error on a hosted deployment** | `IDENTITY_PROVIDER=stripe` **or** `persona`, + that provider's key below. This is a **hard blocker** for ID verification in hosted testing, not a degradation |
| `SMS_PROVIDER` | phone verification SMS delivery. `mock` throws when `NODE_ENV=production`; `twilio` and `messagebird` **are stubs whose `send` throws** | `artifacts/api-server/src/services/phoneVerification/smsProvider.ts:170-181`; `IMPLEMENTED_PROVIDERS = new Set(["mock"])` at `:112`; `REQUIRED_ENV` at `:115-118` | `mock` | **There is no working setting.** With `NODE_ENV=production`, mock throws and both real adapters throw. → `CODE`: implement an adapter, or run the hosted test server with `NODE_ENV` not `production` and `SMS_PROVIDER` unset to use mock. Chelsi cannot configure her way out of this one |
| `PAYMENTS_ALLOW_LIVE` | permits a **live** (non-sandbox) Stripe/Persona key; `unknown`-prefix keys are refused regardless | `artifacts/api-server/src/lib/paymentsMode.ts:78-80` (rule `:24-27`) | **OFF** (exact `"true"` only) | leave unset — use `sk_test_` / `persona_sandbox_` keys |
| `NOTIFICATION_MAINTENANCE_DISABLED` | opt-out for the notification-digest maintenance pass (background job) | `artifacts/api-server/src/lib/notificationMaintenanceScheduler.ts:135-138` | **⚠ ON** (the pass runs unless set to `1`/`true`) | leave unset |

#### 3.2 Credentials whose absence disables a feature (CONFIG for Chelsi)

| Var | What dies without it | file:line | Behaviour when absent |
| --- | --- | --- | --- |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SESSION_SECRET`, `PORT` | everything — boot | `lib/envValidation.ts:9-14` | `process.exit(1)` |
| `AI_INTEGRATIONS_OPENAI_API_KEY` (+ `AI_INTEGRATIONS_OPENAI_BASE_URL`) | Telegraph recommendations, stamp image generation, AI visual generation, OpenAI translation | `lib/openai.ts:3-15`; `lib/stamps/imageProvider.ts:153`; `lib/visuals/providers/openaiImageProvider.ts:92` | `lib/openai.ts:6-9` warns "recommendations will be unavailable" and constructs the client with `apiKey: "not-configured"` — so calls fail at request time, not boot |
| `GOOGLE_MAPS_API_KEY` | Google place photos (returns `null` → category artwork), Google Routes travel times, place autocomplete | `lib/discoveryPlacePhotoStore.ts:118-119`; `domain/trips/contracts/GoogleRoutesTravelTimeProvider.ts:161` | "degrade honestly" — `:115-117`: "with no key the proxy could only 503, so callers are better served falling through to category artwork" |
| `FOURSQUARE_API_KEY` (or the env-specific `FSQ_API_KEY_PROD` / `FSQ_API_KEY_DEV`) | venue search, place photos, live open-now checks | `lib/foursquarePlaces.ts:41` logs "FOURSQUARE_API_KEY not set — venue search disabled"; precedence at `lib/foursquareApiKey.ts:16-24` | silently disabled. **Set `FSQ_API_KEY_DEV` for the hosted test server** so testing does not spend production's Foursquare quota (`foursquareApiKey.ts:3-8`) |
| `TICKETMASTER_API_KEY` | City Pulse / events context | `lib/eventsCache.ts:85-86` | `if (!apiKey) return null; // Integration inactive — skip silently`. Combined with the dev-only mock fallback at `travel-buddy-standalone/src/hooks/useCityPulse.ts:83`, a release build with no key shows a genuinely empty City Pulse |
| `MAPBOX_TOKEN` | server-side geocoding | `services/geocodingService.ts:42`, `:84`, `:111`; listed optional at `lib/envValidation.ts:21` | geocoding path skipped |
| `STRIPE_IDENTITY_SECRET_KEY` **or** `PERSONA_API_KEY` + `PERSONA_TEMPLATE_ID` | identity verification, paired with `IDENTITY_PROVIDER` | names at `lib/paymentsMode.ts:59-62`; reads at `services/identityVerification/stripeIdentity.ts:236`, `persona.ts:226`, `persona.ts:262` | `key_absent` refusal (`paymentsMode.ts:42`). Must be `sk_test_`/`rk_test_` or `persona_sandbox_` (`:53-56`) or it is refused as `unknown_key_prefix` |
| `IDENTITY_WEBHOOK_SECRET` | verification webhook signature checking | `services/identityVerification/providers.ts:63` | without it the webhook cannot be verified |
| `SENSING_CONTRIBUTOR_PEPPER` | writing or revoking any anonymous sensing contribution | `lib/sensingAnonStore.ts:157`; rationale `lib/envValidation.ts:22-44` | `sensingPepper()` **throws**; `lib/sensingAnonService` refuses unless this var specifically is set **and ≥32 chars** — the `SESSION_SECRET` fallback is explicitly not allowed to write, because rotating it "would make every prior row unrevokable" |
| `INTEL_EVIDENCE_REFERENCE_KEY` | sealing `intel_evidence.reference` — "no key, no evidence stored" | `lib/intelEvidenceCapture.ts:400-402`; min length 32 at `:385`; rationale `lib/envValidation.ts:44` | returns `null` → evidence not stored. **Must be ≥32 characters** |
| `INTEL_GROUP_KEY_SECRET` | intel group-key / mission-nonce stability | `lib/intelGroupKey.ts:69`, `lib/intelMissionNonce.ts:40`, `lib/sensingAnonStore.ts:158` | falls back to `SESSION_SECRET` (`intelGroupKey.ts:60-67`), so it works — but prefer the dedicated secret: "rotating it re-keys every group and would transiently split live crews" (`:41-45`) |
| `LAYOVER_OBSERVER_PEPPER` | layover observation pseudonymisation | `services/layover/LayoverObservationService.ts:188` | falls back to `SESSION_SECRET` |
| `TRIP_OFFLINE_BUNDLE_SECRET` | trip offline-bundle signing | `domain/trips/services/TripOfflineBundle.ts:127` | falls back to `SESSION_SECRET` |
| `LAYOVER_EVENT_PRODUCER_SECRET` | the layover-events producer endpoint's shared-secret auth | `routes/layoverEvents.ts:113` | the endpoint cannot be called |
| `COMPASS_TOKEN_SECRET` | Compass explanation-token signing | `compass/CompassExplanationEngine.ts:257` | has a constant fallback at that site — functional but not secret |
| `INTERNAL_API_SECRET` | server-to-server internal calls | listed optional at `lib/envValidation.ts:20` | internal calls unauthenticated/refused |
| `REDIS_URL` | distributed rate limiting and crash-report dedup; falls back to in-memory | `lib/rateLimit.ts:69`; `routes/crashReport.ts:27` | per-instance only — fine for single-instance hosted testing |
| `FX_REFRESH_URL` | FX source endpoint | `lib/fx.ts:123` | defaults to `https://api.frankfurter.dev/v1/latest?base=EUR` — no key needed |
| `ALLOWED_ORIGINS` | CORS. **If the hosted web origin is not listed, browser clients break** | `app.ts:34` | must include the hosted web origin |
| `APP_RETURN_BASE_URL` | the deep link users return to after identity verification | `routes/verification.ts:234` | defaults to `travelbuddy://profile/verification` |
| `GENERIC_COVER_URL` | fallback cover image | `routes/mediaFile.ts:36` | has a built-in default |
| `NODE_ENV` | **not a feature flag, but it moves three gates**: `mock` identity (`providers.ts:151`) and `mock` SMS (`smsProvider.ts:174`) are refused when it is `production`; Foursquare key selection branches on it (`lib/foursquareApiKey.ts:37-39`) | — | for hosted testing this is the single most consequential setting; see the `SMS_PROVIDER` row |

#### 3.3 Mobile (`EXPO_PUBLIC_*`, baked into the bundle at build time)

These are build-time, so changing one needs a **new EAS build** — unlike a
server flag flip.

| Var | Gates | file:line | Hosted-testing value |
| --- | --- | --- | --- |
| `EXPO_PUBLIC_API_BASE_URL` | **everything** — flags, auth, all data. Empty string means every fetch hits a relative path | `src/context/FeatureFlagsContext.tsx:44`; `src/hooks/useRentABuddyFlag.ts:11`; `src/hooks/useCircleFlag.ts:10` (353 references in the tree) | set in `eas.json:10/20/30` to `https://portava.replit.app` for all three profiles |
| `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY` | sign-in and all direct Supabase reads; absence drives `configured === false` → the "App not configured" screen in a release build | `app/index.tsx:28-40` | required; **not** set in `eas.json`, so they must come from EAS secrets |
| `EXPO_PUBLIC_WEB_ORIGIN` | passport/profile share links and canonical URLs | `src/hooks/usePassportShare.ts:13-14`; `src/constants/canonicalUrl.ts:26-40` | set in `eas.json`; must match `app.json`'s `associatedDomains`/`intentFilters` host (`portava.replit.app`) |
| `EXPO_PUBLIC_SENTRY_DSN` | crash reporting; a release build without it logs a warning | `app/_layout.tsx:28` | optional |
| `EXPO_PUBLIC_MAPTILER_KEY` | **almost nothing any more** — `src/constants/mapStyle.ts:12-16` records that `getMapStyleUrl` no longer reads it ("the key consistently returned HTTP 403"); still read at `src/components/media/RouteItPlaceSheet.tsx:26` | optional |
| `EXPO_PUBLIC_SENSING_SESSION_PATH`, `EXPO_PUBLIC_SENSING_INGEST_PATH` | the sensing capture transport's endpoint paths | `src/services/sensing/installSensingCapture.ts:108-109`; documented `src/services/sensing/sensingTransport.ts:47` | only needed if sensing is being tested |

#### 3.4 Defaults-to-ON risks (the other direction)

Four, and they are the ones to watch because nobody will think to check them:

1. **`TRANSLATION_ENABLED`** — `lib/translation.ts:51`,
   `(process.env.TRANSLATION_ENABLED ?? 'true').toLowerCase() !== 'false'`.
   Unset means **on**. Combined with `TRANSLATION_PROVIDER` defaulting to
   `mock` (`:164`), the hosted deployment will serve **mock translations as if
   they were real** unless both are configured. This is the worst of the four:
   the feature is on, looks like it works, and is lying.
2. **`STAMP_COUNTRY_SWEEP_ENABLED`** — `lib/stamps/xxCatalogRepair.ts:474`.
   Only the exact string `"false"` disables it; the sweeper is started
   unconditionally at `index.ts:282` and mutates the stamp catalog (it re-keys
   and **merges** entries). On in hosted testing by default.
3. **`NOTIFICATION_MAINTENANCE_DISABLED`** —
   `lib/notificationMaintenanceScheduler.ts:135-138`. The maintenance pass runs
   unless explicitly disabled. If hosted testing runs more than one instance,
   `:134` notes the opt-out exists precisely so one instance drives the digest.
4. **`startVisualGenerationWorker()`** — `index.ts:270` is gated by **no env
   var at all**: "Unconditionally started: it is a low-overhead poller; jobs are
   only created when generation is explicitly requested via the API." It will
   poll `generated_visuals` and, if a job exists, spend
   `AI_INTEGRATIONS_OPENAI_API_KEY` credits. Not a defect, but it is an
   always-on billable path with no switch, and `AI_VISUAL_DAILY_LIMIT` /
   `AI_VISUAL_USER_DAILY_LIMIT` / `AI_VISUAL_COST_PER_IMAGE` are the only
   brakes.

In the safe direction, for completeness: `PAYMENTS_ALLOW_LIVE`
(`lib/paymentsMode.ts:78-80`) defaults off and requires the exact string
`"true"`, and an unrecognised key prefix is refused even with it set
(`:24-27`). That one is built right.

### 9. How a flag actually gets flipped, and the one rule that follows from it

The audited path is `PATCH /api/admin/feature-flags/:flag` with
`{ "enabled": true }` (`artifacts/api-server/src/routes/admin.ts:775`), admin JWT
only. It calls the `toggle_feature_flag_with_audit` RPC (migration 0119), so the
`feature_flags` update and the `feature_flag_audit_log` row commit in one
transaction — which is why an audited flip always leaves a record and a direct
`UPDATE` in the SQL console leaves none.

**The rule: a flag with no row cannot be flipped at all.** The RPC raises
`Flag not found` and the handler returns 404
(`routes/admin.ts:821-826`); it never inserts. So for the 107 flags with no
production row, "turn it on" is never a flip — it is **apply the seeding
migration first**, then flip. That is why so many lines in the sections above
are labelled `MIGRATION` rather than `FLAG FLIP ONLY`.

Two smaller mechanics worth knowing:

- **17 flags are blocked from the admin surface on purpose.**
  `HIDDEN_INERT_FLAGS` (`routes/admin.ts:662-708`) hides and refuses them with
  `not_operational`, because they gate nothing and an operator reaching for one
  during an incident would get false confidence. They are the four `freeze_*`,
  six retired `COMPASS_*`, four notification flags, and the two
  `intel_sensing_*`. None of them is anything hosted testing needs — this is
  recorded so nobody files a bug when the toggle refuses.
- **Metadata is a separate call.** `PATCH /api/admin/feature-flags/:flag/metadata`
  (`routes/admin.ts:891`) replaces the whole metadata document, it does not
  patch it. Flags whose behaviour lives in metadata rather than in `enabled`
  (the Live Places `requires` lists, `DISCOVERY_ENGINE_MODE`,
  `account_deletion_worker_enabled`) need the full document sent.

---

## Appendix A — the production capture, 2026-10-03

One read-only `SELECT flag, enabled FROM public.feature_flags` against
`ajrurzioarfkagpuxfnb`. **201 rows, 106 enabled.** `1` is enabled, `0` is
disabled, and a flag that does not appear here has **no row**, which is a
different state from `0` and cannot be changed by a flag flip (§9).

This list is the only record of production's intended flag state: §0 shows it
cannot be derived from the repository, and `feature_flag_audit_log` holds three
rows in its entire history.

```
ACTIVITY_DISCOVERY_BOOST_ENABLED=0
COMPASS_ACTIVE_REWARDS_ENABLED=1
COMPASS_DIVERSITY_ENABLED=1
COMPASS_ENABLED=1
COMPASS_FAIR_EXPOSURE_ENABLED=1
COMPASS_FALLBACK_MODE_ENABLED=0
COMPASS_FEED_ENABLED=1
COMPASS_JOURNEY_ENGINE_ENABLED=0
COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED=0
COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED=0
COMPASS_V1_RULE_BASED_ENABLED=1
CREATOR_FATIGUE_ENABLED=0
DISCOVERY_DIVERSITY_ENABLED=0
DISCOVERY_ENGINE_MODE=0
MEDIA_ACTIVE_CREATOR_BOOST_ENABLED=0
MEDIA_ADMIN_REVIEW_ENABLED=0
MEDIA_AI_PROVENANCE_LABELS_ENABLED=0
MEDIA_ANALYTICS_ENABLED=0
MEDIA_COMMENTS_ENABLED=0
MEDIA_CREATOR_FATIGUE_ENABLED=0
MEDIA_DEFAULT_VIEW_MODE=0
MEDIA_FOLLOWING_ENABLED=0
MEDIA_FOR_YOU_ENABLED=1
MEDIA_GEMS_ADD_TO_TRIP_ENABLED=0
MEDIA_GEMS_DIRECTIONS_ENABLED=0
MEDIA_GEMS_RANKING_ENABLED=0
MEDIA_GEMS_SUBMIT_ENABLED=1
MEDIA_GEMS_WRONG_PLACE_REPORT_ENABLED=0
MEDIA_GRID_RANKING_ENABLED=0
MEDIA_HIDDEN_GEMS_CREATE_ENABLED=1
MEDIA_LIKES_ENABLED=0
MEDIA_NEW_CREATOR_BOOST_ENABLED=0
MEDIA_PROCESSING_PIPELINE_ENABLED=0
MEDIA_RANKING_ENABLED=0
MEDIA_RETURNING_CREATOR_BOOST_ENABLED=0
MEDIA_SAVES_ENABLED=0
MEDIA_SHARES_ENABLED=0
MEDIA_TAB_ENABLED=0
MEDIA_UNDEREXPOSED_BOOST_ENABLED=0
MEDIA_UPLOAD_ENABLED=1
MEDIA_UPLOAD_PHOTO_ENABLED=1
MEDIA_UPLOAD_VIDEO_ENABLED=0
MEDIA_VIEW_MODE_FULLSCREEN_ENABLED=1
MEDIA_VIEW_MODE_GRID_ENABLED=1
MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED=1
NEW_CONTRIBUTOR_BOOST_ENABLED=0
RANKING_EXPERIMENT_ENABLED=0
RENT_BUDDY_ADMIN_ONLY_MODE=0
RENT_BUDDY_BETA_ONLY_MODE=0
RENT_BUDDY_GROUP_BOOKINGS_ENABLED=1
RENT_BUDDY_MVP_MODE=0
RENT_BUDDY_NIGHTLIFE_ENABLED=1
RENT_BUDDY_OFFERS_ENABLED=1
RENT_BUDDY_PACKAGES_ENABLED=1
RETURNING_USER_BOOST_ENABLED=0
UNDEREXPOSED_CONTENT_BOOST_ENABLED=0
account_deletion_worker_enabled=0
ai_event_auto_suggest_enabled=1
ai_event_headers_enabled=1
ai_place_headers_enabled=1
ai_trip_covers_enabled=1
ai_visual_admin_review_enabled=0
ai_visual_provider_enabled=1
ai_visual_regeneration_enabled=1
airport_mode_enabled=1
airport_pulse_enabled=1
budget_fx_conversion_enabled=1
budget_intelligence_enabled=1
compass_ai_enabled=1
compass_ai_writing_enabled=0
compass_decision_enabled=0
compass_location_context_enabled=1
country_essentials_enabled=1
disable_discovery_pde=0
disable_intel_live_labels=0
disable_location_sharing=0
disable_media_uploads=0
disable_messaging=0
disable_new_event_creation=0
disable_posting=0
disable_profile_search=0
disable_rab_bookings=0
disable_rent_buddy_booking=0
disable_signups=0
disable_tagging=0
disable_unknown_message_requests=0
discovery_candidate_projection_enabled=0
discovery_serve_log_enabled=1
discovery_trip_projection_enabled=0
events_chat_enabled=1
events_cohosts_enabled=1
events_enabled=1
events_invites_enabled=1
events_join_leave_enabled=1
events_reminders_enabled=1
events_reports_enabled=1
events_share_links_enabled=1
events_trust_gates_enabled=1
events_waitlist_enabled=1
external_places_enabled=1
find_your_circle_disabled=0
find_your_circle_enabled=1
fsq_places_enabled=1
hidden_gem_verification_enabled=1
hidden_gems_compass_enabled=1
hidden_gems_enabled=1
hidden_gems_layover_enabled=1
hidden_gems_passport_enabled=1
hidden_gems_pulse_enabled=1
highlights_feed_bounded_enabled=0
intel_capture_quick_signal=1
intel_claim_projection_crowd=1
intel_compass_rhythm_actor_gate=0
intel_contribution_retention_enabled=0
intel_coverage=0
intel_limited_live=1
intel_live_label_crowd=1
intel_live_scope_promotion_enabled=0
intel_missions=1
intel_presence_verification_enabled=0
intel_retention_sweep_enabled=1
intel_rewards=1
intel_trail_followup=1
invite_only_beta=0
layover_compass_enabled=1
layover_discovery_mode_enabled=0
layover_plans_enabled=1
layover_safe_return_status_enabled=0
layover_safety_engine_enabled=1
layover_stable_recommendation_ids_enabled=0
live_places_enabled=1
local_guides_enabled=1
locate_friends_enabled=0
map_compass_commands_enabled=1
map_search_enabled=1
map_telemetry_enabled=0
map_telemetry_retention_enabled=1
map_trip_projection_read_enabled=0
media_canonical_enabled=0
media_private_buckets_enabled=1
memory_kernel_enabled=0
memory_location_precision_enabled=0
memory_projection=0
memory_public_feed_projection_enabled=0
moment_recaps_enabled=1
neighborhood_match_enabled=1
nl_trip_creation_enabled=1
open_to_plans_windows_enabled=0
opportunity_engine_enabled=0
passport_contribution_enabled=1
passport_contribution_events_enabled=1
passport_entry_intelligence_enabled=1
passport_map_enabled=1
passport_memories_enabled=1
passport_stamps_enabled=1
passport_travel_dna_enabled=0
place_days_enabled=1
place_recaps_enabled=1
plan_geofence_enabled=1
plan_geofence_full_enabled=1
presence_cleanup_enabled=0
push_notifications_enabled=1
rent_buddy_allow_bookings_without_kyc=0
rent_buddy_enabled=0
reservation_import_enabled=1
safe_return_admin_logs_enabled=1
safe_return_enabled=1
safe_return_live_share_enabled=1
safe_return_trusted_circle_alerts_enabled=1
shared_moments_chat_enabled=1
shared_moments_clustering_enabled=1
shared_moments_compass_suggestions_enabled=1
shared_moments_enabled=1
stamp_admin_award_enabled=1
stamp_admire_enabled=1
stamp_auto_approve_artwork=1
stamp_criteria_engine_enabled=1
stamp_premium_rendering_enabled=1
stamp_showcase_enabled=1
stamp_system_v2_enabled=1
stamp_unified_view_enabled=1
stories_enabled=1
telegraph_history_bound_enabled=0
trip_absence_guard_enabled=0
trip_crew_ghost_mode_enabled=1
trip_crew_live_share_enabled=1
trip_crew_map_enabled=1
trip_kernel_enabled=0
trip_map_projection_worker_enabled=0
trip_operational_projections_enabled=0
trip_readiness_enabled=1
trip_retention_sweep_enabled=0
trust_engine_enabled=1
trust_gaming_detection_enabled=1
wall_compass_handoff_enabled=0
wall_context_threads_enabled=0
wall_discovery_insertions_enabled=0
wall_enabled=0
wall_input_intelligence_enabled=0
wall_live_for_you_enabled=0
wall_rab_integration_enabled=0
```

## Appendix B — on the citations in this document

Roughly 300 `path/file.ts:LINE` citations here were read on `main` at
`db657b73` on 2026-10-03. The document is deliberately **not** added to the
`COVERED` registry in `artifacts/api-server/scripts/check-doc-citations.mjs`.
That registry is opt-in by design, and its own header gives the reason to be
careful: "a citation is a claim about a line number, and line numbers move
whenever anything above them is edited." Several threads are editing these files
concurrently. Adopting 300 citations into an enforced registry would make this
document a merge hazard for every one of them, and an anchor invented to satisfy
a checker is worse than no anchor.

So the honest statement is the one this appendix makes instead: **the citations
are accurate as of `db657b73` and nothing keeps them so.** Re-measure before
acting on a line number, and prefer the symbol name — which does not move — over
the line.

## Appendix C — what this document does not establish

Collected from every section, so nothing reads as settled that is not. Each
section carries its own longer version.

- Whether `2060`, `3421`, `2181` and several 3xxx migrations are applied to
  production. `production-applied-migrations.json` covers only part of the range
  and is known to lag; settling these needs a read of production's own catalogue.
- The production `metadata` of `DISCOVERY_ENGINE_MODE` and of the other
  metadata-carrying flags: the capture read `flag, enabled` only.
- Whether the Replit deployment is autoscale or a Reserved VM, which decides
  whether several already-ON schedulers actually run.
- Whether the Replit workspace holds video-upload code that is not on GitHub.
- Why any of the 72 unexplained enabled flags was turned on.
- What the three `COMPASS_JOURNEY_*` rows gate.
- Whether the current Foursquare key is still being refused; `replit.md:53` says
  it was, and that cannot be re-verified without calling the API.
