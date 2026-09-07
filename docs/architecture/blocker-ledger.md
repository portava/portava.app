# Live blocker ledger

**Updated 2026-09-07.** Every row measured, not inferred. Types: `CODE` ·
`MANUAL_SQL` · `OPS_DATA` · `OWNER` · `EXTERNAL` · `HOLD`.

"Buildable now?" means: can engineering finish it without owner action, without
production SQL, and without data that does not exist.

## P1 — production security defects

| Surface | Blocker | Type | Owner | Buildable now? | Fix / action | Commit | Production impact |
|---|---|---|---|---|---|---|---|
| Layover | `layover_recs_owner` is `FOR ALL` with `with_check` NULL and `authenticated` holds all 8 privileges — a session owner can write their own `safety_rating`, `return_buffer_min`, `hard_return_time` | MANUAL_SQL | owner | **No** — fix is written | apply `2335`, then `2510` to verify | `2335` (earlier), `2510` (`c3471867`) | **Live now.** Certified safety fields are client-writable on the surface that tells a traveller whether it is safe to leave an airport |
| Telegraph | `messages_hide_blocked_sender` PERMISSIVE with a predicate true for `anon`; `msg_select` a tautology | MANUAL_SQL | owner | No — **applied** | `2401` → `2402` | applied | **Closed.** Verified empirically: anon sees 0 of 29 messages, no recursion |
| Meetups | length-two policy cycle `meetups → meetup_invites → meetups`; `mi_own` binds only `user_id` | MANUAL_SQL | owner | No — fix is written | `2460` (inert defuse) → `2461` (repair) → `2462` (vote boundary) | `469c3232`, `296b8c24` | **Live now.** Re-swept today on both databases: still the only cycle, still unrepaired in either |
| Highlights | `highlights_select_active` trip_only branch admits pending invitees and removed members | MANUAL_SQL | owner | No — fix is written | `2530` | `04871c46` | **Live now.** Plus an ordering hazard: PR #461's `2313` restores the self-join byte-for-byte |
| Trip crew | `crew_session_owner_select` admits any stranger listed in `allowed_member_ids` | MANUAL_SQL | owner | No — fix is written | `2531` | `6fe2a7af` | **Live now** |
| Trip crew | 32 policies hand-roll trip membership; three had `USING (auth.uid() IS NOT NULL)` as their entire predicate | MANUAL_SQL | owner | No — fix is written | `2334` → `2337` | earlier | **Live now** |
| Schema-wide | 374 of 417 public tables grant TRUNCATE to `anon`; 312 of them carry RLS policies, which never police TRUNCATE | MANUAL_SQL | owner | No — fix is written | `2490` | `9e7cae7a`, `31071e8d` | **Live now.** Not reachable through PostgREST verbs, so a boundary defect rather than an open door |
| Trips | `can_see_trip` has no status test; two `FOR ALL` checklist policies use it as their write check, so any viewer of a public trip can write checklist rows | CODE + MANUAL_SQL | Auth/RLS lane | **In flight** | migration + explicit `WITH CHECK` | in progress | **Live now** |
| Trips | `public.shares_trip_with(uuid)` is a membership oracle callable by anon/authenticated over PostgREST | CODE + MANUAL_SQL | Auth/RLS lane | **In flight** | REVOKE or DROP; zero app callers verified | in progress | **Live now** |
| Trips | `trip_reminders_own` is `FOR ALL` with no `WITH CHECK`; being PERMISSIVE it ORs over `trip_reminders_insert` and removes its `can_see_trip` requirement entirely | MANUAL_SQL | owner | No — fix is written | `2535` | this commit | **Live now**, but bounded: a write-boundary defect, not a disclosure. A user can insert a reminder naming any `trip_id`; they cannot read anyone else's rows, `tripReminderScheduler` does not read this table, and it holds 0 rows. Without it `2534`'s repair of `trip_reminders_insert` is decorative |
| Layover | admin "hide" did not suppress a recommendation from its owner, on two read paths | CODE | — | — | filter both reads on status | `214ac7e6` | **Fixed in code.** Ships on next deploy; needs no SQL |

## P2 — producer exists, consumer missing

| Surface | Blocker | Type | Owner | Buildable now? | Fix / action | Commit | Production impact |
|---|---|---|---|---|---|---|---|
| Map | `trip_outbox` projection worker has **no reader**; `routes/mapProjection.ts` still builds from canonical `trips` | CODE | Map | Partly — needs `2420` for input | find/define the consumer contract | `6e2c3128` | None. Closes **zero** Map census rows |
| Discovery | Discovery authors its own `trips` reads instead of consuming the Trip-owned projection | CODE | Discovery lane | **In flight** | flag-gated consumer, legacy as off-state | in progress | None until `2420` applies — the reader selects `trips.version`, absent in production |
| Intel | `promoteLiveScope` / `withdrawLiveScope` have no caller | CODE | Intel Ops lane | **In flight** | admin surface over the existing library | in progress | None — see OPS_DATA row |

## P2.5 — a state machine with an unreachable state

| Surface | Blocker | Type | Owner | Buildable now? | Fix / action | Production impact |
|---|---|---|---|---|---|---|
| Events | `events.state` includes `started`, and **nothing in the tree ever writes it** — no `/start` route, no `update({state:"started"})` anywhere | CODE + OWNER | Events lane | **In flight** | derived transition, flag-gated FALSE; the derived-vs-host-initiated choice is the owner decision `EVENT_START_TRANSITION` | **Live now**, and larger than it looks |

Measured on production 2026-09-07:

| state | count | already past `starts_at` |
|---|---|---|
| `open` | 97 | **96** |
| `completed` | 7 | 7 |
| `started` | **0** | — |

**Eight code paths depend on the state that is never reached**, and one of them
is a hard block: `routes/events.ts:4563-4565` refuses `POST .../complete` unless
`state === 'started'`, so **no event can be completed through the API at all**.
Production nonetheless holds 7 completed events, which means a second,
undocumented path put them there — itself worth establishing.

The others: two gates at `events.ts:3491,:3552` permanently closed;
`BROWSE_STATES`; `pulse.ts:1224,1271,1757`; Passport's `LIVE_EVENT_STATES` in
two services; and `TrustEventService.ts:612 EVENT_HOST_CANCEL_TRIGGER_STATES`.
Downstream, the Trust type `event_attendee_no_show` has an emitter that is
unreachable for exactly this reason — so it is not "unwired", it is wired to a
state the product never enters.

**Why this is not simply engineering's to close.** Two designs are both valid and
differ in what a user sees: derived (`now() >= starts_at` flips it) versus
host-initiated (an event nobody starts never starts). Does an event auto-start
when nobody showed? Does a host who forgets block completion forever? That is
product policy, recorded as **`EVENT_START_TRANSITION`**. The derived transition
is being built flag-gated and seeded FALSE, with the rule isolated in a pure
function so a host-initiated route can be added later without rework — building
the architecture around the decision without taking it.

## P3 — contract exists, producer missing

| Surface | Blocker | Type | Owner | Buildable now? | Fix / action | Commit | Production impact |
|---|---|---|---|---|---|---|---|
| Trust | 13 of 31 declared event types unproduced | CODE + OWNER | Trust lane | **In flight** | classify each; wire only real triggers | in progress | Trust scores move on 5 types only |
| Passport | `stamp_verified` helper exists; the call inside `awardStamp` is not made | CODE | Passport | **Yes** | one call in `StampAwardEngine.ts` | — | No stamp verification reaches Trust |

## P4 — blocked on data, not code

| Surface | Blocker | Type | Owner | Buildable now? | Fix / action | Commit | Production impact |
|---|---|---|---|---|---|---|---|
| Intel / Live | `geo_zones` 0 · `intel_observations` 0 · `intel_claims` 0 · `intel_live_promoted_scopes` 0, while three live flags are TRUE | OPS_DATA | owner | **No** | seed zones; let observations flow | — | Every `readLiveClaims` consumer returns `[]` — Wall Live-For-You, Map ExperienceState, Compass live constraints, Media, Trail. **An operator surface does not fix this** |
| Trust | `trust_events` has 5 rows ever; 56 of 58 users have no `trust_profiles` row | OPS_DATA | — | Partly | emitters now wired for 5 types | `ef2a8f3d` | Engine runs and is nearly silent |
| Layover | 5 sessions ever, 2 users, 0 active | OPS_DATA | — | — | — | — | Surface is effectively unexercised |

## P7 — geo_zones: determined, and deliberately not built

`geo_zones` holds **0 rows** in production, which starves the entire intel spine
and makes Map §10 Crowd Flow refuse with `no_zone_model`.

**The operator surface already exists and is complete.** `routes/admin.ts`
carries full CRUD plus `POST /admin/geo-zones/import`, a validated bulk-seed
endpoint backed by `lib/geoZoneSeed.validateGeoZoneSeed`, and
`db/seed/geo_zones_production_seed_template.sql` is the hand-run equivalent.
Both doors enforce the same four rules. This is **not** a missing-surface
problem, and an earlier draft of this ledger was wrong to imply it was.

**No valid seed definitions exist in the repository, and none were invented.**
The template consists of `__FILL_ME__` rows and states its own rule:

> Nothing in the repository invents production zones; this file is the shape the
> owner's curated list is poured into.

`src/test/fixtures/geo-zones.sample.json` is test data, not approved production
geography. Fabricating geofences to make Crowd Flow light up would be
manufacturing the exact kind of false intelligence this pass exists to prevent.

**Type: OPS_DATA. Blocked on the owner supplying curated zones — not on
engineering.** The fail-closed behaviour is correct and is preserved: with no
zone covering the viewport, Crowd Flow refuses rather than approximating.

## P5 — owner decisions

| Decision | Bound by | Type | Buildable now? | What it decides |
|---|---|---|---|---|
| `SENSING_AUTH_POSTURE` | `2481` | OWNER | No | Its CHECK constrains `issuance_class` to `authenticated_profile`. Under Option B the file is never run |
| `MEDIA_CANONICAL_FLAG` | `2470` | OWNER | No | `media_canonical_enabled` is TRUE in production while the columns are absent — the condition that caused three weeks of swallowed write loss |
| `LOCATION_PRECISION_DEFAULT` | *nothing* | OWNER | n/a | `2338` defaults to a no-op on purpose, so applying it does **not** pre-empt the product choice |
| `STORY_HIGHLIGHT_VISIBILITY` | *nothing in this band* | OWNER | n/a | `2339` gates feed bounding only, behind a FALSE flag |
| Layover L50 — what BLOCKED means on screen | — | OWNER | No | Whether an unsafe recommendation is hidden, greyed, or shown with a warning |

## P6 — explicit holds

| Item | Type | Status |
|---|---|---|
| Ranker | HOLD | Held. Not started, not planned in this pass |
| Phase F | HOLD | Frozen |
| Event Truth Phase-B | HOLD | Gated |
| SX-11 | HOLD | Must not start |

## The one structural blocker behind most of this table

**Of the 30 migrations in the 2330-2490 band, exactly one is applied to
production** (`2402`). portava-ci is eighteen ahead. Nine P1 security rows above
are fixed in code and live in production purely because the SQL is unapplied.
No amount of further engineering closes them.
