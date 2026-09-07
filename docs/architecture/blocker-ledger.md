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
| Layover | admin "hide" did not suppress a recommendation from its owner, on two read paths | CODE | — | — | filter both reads on status | `214ac7e6` | **Fixed in code.** Ships on next deploy; needs no SQL |

## P2 — producer exists, consumer missing

| Surface | Blocker | Type | Owner | Buildable now? | Fix / action | Commit | Production impact |
|---|---|---|---|---|---|---|---|
| Map | `trip_outbox` projection worker has **no reader**; `routes/mapProjection.ts` still builds from canonical `trips` | CODE | Map | Partly — needs `2420` for input | find/define the consumer contract | `6e2c3128` | None. Closes **zero** Map census rows |
| Discovery | Discovery authors its own `trips` reads instead of consuming the Trip-owned projection | CODE | Discovery lane | **In flight** | flag-gated consumer, legacy as off-state | in progress | None until `2420` applies — the reader selects `trips.version`, absent in production |
| Intel | `promoteLiveScope` / `withdrawLiveScope` have no caller | CODE | Intel Ops lane | **In flight** | admin surface over the existing library | in progress | None — see OPS_DATA row |

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
