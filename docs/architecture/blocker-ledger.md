# Live blocker ledger

**Updated 2026-09-08.** Every row measured, not inferred. Types: `CODE` ·
`MANUAL_SQL` · `OPS_DATA` · `OWNER` · `EXTERNAL` · `HOLD`.

"Buildable now?" means: can engineering finish it without owner action, without
production SQL, and without data that does not exist.

## P1 — production security defects

| Surface | Blocker | Type | Owner | Buildable now? | Fix / action | Commit | Production impact |
|---|---|---|---|---|---|---|---|
| Layover | `layover_recs_owner` was `FOR ALL` with `with_check` NULL, so a session owner could write their own `safety_rating`, `return_buffer_min` and `hard_return_time` | MANUAL_SQL | owner | No — **applied** | `2335`, then `2510` to verify | `2335` (earlier), `2510` (`c3471867`); applied `20260908104231` / `20260908104255` | **CLOSED 2026-09-08.** The defect was proven by EXECUTION on production before the fix, not read off the catalog: acting as `authenticated` with the session owner's `sub`, a self-assigning UPDATE of `safety_rating` was ADMITTED and rewrote 1 row — inside a block that then raised, so nothing persisted (30 rows, all `source='ai'`, before and after). `2510` — verify-only — was run against production BEFORE the fix and RAISED, naming the exact defect, which is how its assertions were shown not to be decorative. After: `layover_recs_owner` is FOR SELECT only, `authenticated` holds SELECT and nothing else, `anon` holds nothing, `service_role` keeps SELECT/INSERT/UPDATE/DELETE and loses TRUNCATE. The same write is now refused **42501** while the owner READ still returns the row — the write door shut without shutting the read door. `2510` re-run after: passes. Section 2 of `2335` (TRUNCATE on the four sibling tables) was already a NO-OP: `2490` revoked those on 2026-09-08 and the migration's header, written a day earlier, overstates the surviving grant set |
| Telegraph | `messages_hide_blocked_sender` PERMISSIVE with a predicate true for `anon`; `msg_select` a tautology | MANUAL_SQL | owner | No — **applied** | `2401` → `2402` | applied | **Closed.** Verified empirically: anon sees 0 of 29 messages, no recursion |
| Meetups | length-two policy cycle `meetups → meetup_invites → meetups`; `mi_own` bound only `user_id` | MANUAL_SQL | owner | No — **applied** | `2460` (inert defuse) → `2461` (repair) → `2462` (vote boundary) | `469c3232`, `296b8c24`; applied `20260907181058` / `183518` / `183707` | **CLOSED.** Re-read on production 2026-09-08: `mi_own` now states a `WITH CHECK`. The row above said "still unrepaired in either" database for a day after all three had landed |
| Highlights | `highlights_select_active` trip_only branch admitted pending invitees and removed members | MANUAL_SQL | owner | No — **applied** | `2530` | `04871c46`; applied `20260907223359` | **CLOSED.** Re-read on production 2026-09-08: the `tm1 JOIN tm2` self-join shape is gone. The ordering hazard stands — PR #461's `2313` restores the self-join byte-for-byte, so merging it would reopen this |
| Trip crew | `crew_session_owner_select` admitted any stranger listed in `allowed_member_ids` | MANUAL_SQL | owner | No — **applied** | `2531` | `6fe2a7af`; applied `20260907190129` | **CLOSED.** Re-read on production 2026-09-08: no policy of that name references `allowed_member_ids` |
| Trip crew | 32 policies hand-rolled trip membership; three had `USING (auth.uid() IS NOT NULL)` as their entire predicate | MANUAL_SQL | owner | No — **applied** | `2334` → `2337` | applied `20260907184258` / `185750` | **Applied** (ledger re-read 2026-09-08). The convergence itself was not re-verified here — only that both migrations are recorded — so this row says applied, not closed |
| Schema-wide | 374 of 417 public tables granted TRUNCATE to `anon` | MANUAL_SQL | owner | No — **applied** | `2490` | `9e7cae7a`, `31071e8d`; applied `20260908011416` | **CLOSED for application tables.** Re-read on production 2026-09-08: **3** tables still grant it, and all three are PostGIS extension objects — `spatial_ref_sys` plus the `geometry_columns` / `geography_columns` views. They hold no user data and revoking on extension-owned objects is fragile, so their exclusion is deliberate. It was never reachable through PostgREST verbs |
| Trips | `can_see_trip` had no status test; two `FOR ALL` checklist policies used it as their write check, so any viewer of a public trip could write checklist rows | CODE + MANUAL_SQL | Auth/RLS lane | No — **applied** | `2534` | applied `20260907223139` | **CLOSED.** Re-read on production 2026-09-08: **zero** write policies anywhere in `public` still gate on `can_see_trip`. Its repair of `trip_reminders_insert` was decorative until `2535` landed — see the row below |
| Trips | `public.shares_trip_with(uuid)` was a membership oracle callable by anon/authenticated over PostgREST | CODE + MANUAL_SQL | Auth/RLS lane | No — **applied** | `2533` | applied `20260907222934` | **CLOSED.** Re-read on production 2026-09-08: no function of that name exists in `public` |
| Trips | `trip_reminders_own` was `FOR ALL` with no `WITH CHECK`; being PERMISSIVE it ORed over `trip_reminders_insert` and removed its trip-gate requirement entirely | MANUAL_SQL | owner | No — **applied** | `2535` | applied `20260908103147` | **CLOSED 2026-09-08.** Rehearsed on portava-ci, rollback run and proven to restore the exact prior state, both postconditions proven to RAISE against that state. Production now: 4 policies, 0 `FOR ALL`, 0 write policy without an explicit `WITH CHECK`, 0 gating on the read predicate. Live smoke: a non-crew authenticated INSERT is refused **42501** (RLS); the same INSERT under the pre-migration policy reached the foreign key (**23503**), which is how it was proven the gate now bites rather than merely being spelled correctly. 0 rows before and after |
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
| `STORY_HIGHLIGHT_VISIBILITY` | *nothing in this band* | OWNER | n/a | **Restated 2026-09-08 and it is not the flag.** `2339` gates feed bounding only, behind a FALSE flag. The unbound decision is what save-to-highlight does with the Story audiences a Highlight cannot represent — see below |
| Layover L50 — what BLOCKED means on screen | — | OWNER | No | Whether an unsafe recommendation is hidden, greyed, or shown with a warning |
| `EVENT_START_TRANSITION` | `2600` (**not applied to production**) | **OWNER** | Yes, safely | Classified 2026-09-08 — see below |
| `MAP_CANCELLED_TRIP_VISIBILITY` | *nothing* | **OWNER** | Yes, safely | Classified 2026-09-08 — see below |
| `PASSPORT_CREW_PRESENCE_AUDIENCE` | *nothing* | **OWNER** | Already fail-closed | **NEW 2026-09-08.** Two specs disagree and the code takes neither side — see below |
| `GEM_MODERATION_AUDIT_ORDERING` | *nothing* | **OWNER** | Already loud | **NEW 2026-09-08.** Whether moderation blocks on an unwritable audit table — see below |
| `SAVE_COUNT_UNSAVE_ASYMMETRY` | *needs an RPC* | **OWNER** | Partly | **NEW 2026-09-08.** `save_count` drifts upward for ever; the correct fix needs a schema change — see below |
| `RAB_EARNINGS_LEDGER_VOIDING` | *nothing* | **OWNER** | Yes, safely | **NEW 2026-09-08.** Declined, expired and cancelled bookings still show estimated earnings — see below |
| `TRUST_OVERRIDE_PIN_OR_CAP` | *nothing* | **OWNER** | Nothing live turns on it | **NEW 2026-09-08.** The last open row in census-trust, and the only thing between Trust and 100 % — see below |
| `MESSAGING_DEGRADED_READ_POSTURE` | *nothing* | **OWNER** | Yes, safely | **NEW 2026-09-08.** 43 enrichment reads across ~15 endpoints: 503 or degrade visibly — see below |
| `TRIP_CREW_SIGNAL_ROLE_COVERAGE` | *nothing* | **OWNER** | Yes, but it WIDENS a gate | **NEW 2026-09-08.** `lib/tripMembership.ts` omits `co_host` and `viewer` while claiming to mirror `getMemberRole` — see below |
| `LAYOVER_RETURN_REMINDER_DELIVERY` | *nothing* | **OWNER** | Yes, safely | **NEW 2026-09-08.** The server-side push path for the return deadline is dead code — see below |
| `MODERATION_TARGET_NULLABILITY` | *needs a schema change* | **OWNER** | No | **NEW 2026-09-08.** `moderation_actions.target_user_id` is NOT NULL, which is what forces the skip-vs-fabricate dilemma — see below |
| `INTERACTION_COOLDOWN_READ_DIRECTION` | *nothing* | **OWNER** | Yes, safely | **NEW 2026-09-08.** A measured fail-open; flipping it blocks legitimate pairs during an outage across 15+ routes — see below |

### `PASSPORT_CREW_PRESENCE_AUDIENCE` — surfaced while separating Safe Return from Locate Friends

Passport spec §5 lists **"With Crew"** as a projected Passport state. Migration
`2219`'s header states that every read of the locate-friends tables **resolves
the caller's membership first** — "the API resolves the caller's membership per
request before returning anything."

**Those two do not agree** for a viewer who is *not* in the session: §5 implies
the state is projectable to a permitted audience, 2219 implies only participants
may learn anything from that storage.

**Not decided.** The code implements the **tighter** of the two readings — the
owner's own view, or a viewer who already clears the §23 / TABLE 24 location
gate — so **neither eventual answer can be reached by accident**, and whichever
the owner picks is a widening or a no-op rather than a correction. Recorded in
the `LOCATE_FRIENDS_CREW_PRESENCE` registry entry's doc comment as well, so it
is visible at the code that depends on it.

### `EVENT_START_TRANSITION` — classified OWNER, and why it is not ENGINEERING

The engineering question ("how does a row reach `started`?") has a settled
answer: `decideEventStart` is a pure function and `2600` seeds
`event_start_transition_enabled` FALSE. What is unsettled is a **product** rule
with different outcomes for real people:

| | (a) derived | (b) host-initiated |
|---|---|---|
| An event nobody attended | becomes `started` anyway | stays `open` forever |
| The host forgets | nothing is blocked | the event can never be completed; no-shows never marked; `event_hosted` / `event_attended` never accrue |

Neither follows from any existing contract — the two produce different products
— so this is OWNER, not ENGINEERING. **Re-measured on production 2026-09-08 and
the doc's numbers still hold exactly:** `started` **0**, `completed` **7**,
`open` **97**, `event_activity_log` **0 rows**. `2600` is **not applied**, so
the flag has no row and the transition cannot be enabled even by mistake.

Consequence of not deciding, stated plainly: **no event can be completed through
the API.** That is today's behaviour, not a regression this pass introduced.

### `MAP_CANCELLED_TRIP_VISIBILITY` — classified OWNER; nothing was changed

This decision was named in direction but **existed nowhere in the tree** — no
code, no migration, no doc mentioned it. Written down here so it can be decided
rather than drifted into.

**Measured behaviour today.** `trip_map_projection_body` (2520) writes
`'stage', t.status::text` — the trip's status verbatim, cancellation included —
and `readTripStopLayer` passes it through as `status` with **no filtering**
(`mapProjectionTripContract.ts:339`). So a cancelled trip keeps its pin and the
pin carries `status: "cancelled"`. That is the current product behaviour and it
was **left exactly as it is**.

Note the contrast that makes this a real choice rather than an oversight: the
meeting-point producer *does* drop cancelled items
(`meetingPointProducer.ts:153`, `:287`, `:331`). So the codebase already
contains both answers, applied to different surfaces. Which one a **trip** should
follow is a product judgement:

- **drop the pin** — the Map is a "what is happening" surface and a cancelled
  trip is noise;
- **keep it, marked cancelled** — crew who saw the pin yesterday learn *why* it
  is gone instead of watching it vanish.

**Zero user impact either way today**, which is why deciding it now is cheap:
production has **0 cancelled trips**, **0 rows** in `trip_map_projections`, and
`map_trip_projection_read_enabled` is **FALSE**.

### `GEM_MODERATION_AUDIT_ORDERING` — act-then-record, or record-then-act

`recordGuideVerification` / `recordAdminVerification` in
`services/hiddenGems/HiddenGemVerificationService.ts` write the audit row and
then flip the gem's status **regardless of whether the row landed**. Measured
2026-09-08: the audit write's error was discarded entirely, so a lost audit row
was invisible.

**Half of it is fixed and not a decision:** the hole is now loud
(`ERROR`, `code: "verification_audit_row_lost"`). The ORDERING is the decision,
and it is a genuine trade rather than an oversight:

- **record-then-act** — refuse to moderate while `hidden_gem_verifications` is
  unwritable. Every moderation action is then provably audited, and reported
  content stays LIVE during the outage.
- **act-then-record** (today) — moderation always works; an outage can lose the
  record of who did it and why.

Not decided here. Both answers are defensible and the choice is about which
failure a moderator should be exposed to, which is a product call.

### `SAVE_COUNT_UNSAVE_ASYMMETRY` — a counter that only goes up

`unsaveGem` deletes the `hidden_gem_saves` row and does **not** decrement
`hidden_gems.save_count`. Save → unsave → save therefore counts 2 for one save,
and the drift is monotonic and permanent — nothing recomputes `save_count` from
the rows.

It is not cosmetic. `save_count` is a threshold input to `deriveHiddenGemState`
(`lib/hiddenGemState.ts`): at `NO_LONGER_HIDDEN_SAVE_THRESHOLD` together with the
visit threshold the gem becomes `no_longer_hidden`, which is the state that stops
the system pushing a small real place that has already been discovered. Drift in
this direction SUPPRESSES a gem on saves that no longer exist.

**Why it is not simply fixed:** `increment_counter(table, column, row_id)` takes
no delta, so a correct decrement needs either a schema change or a non-atomic
read-modify-write carrying the same lost-update race the current fallback has.
The migration that would settle it is written and **NOT APPLIED** — an
`adjust_counter(table, column, row_id, delta)` with a `GREATEST(0, …)` floor,
recorded in the discovery lane's report. Applying a function nothing calls would
be applying a migration merely because it exists; it goes in when the caller
does, under the usual gate.

### `RAB_EARNINGS_LEDGER_VOIDING` — a money screen that counts bookings that did not happen

Rent-a-Buddy earnings-ledger rows are written at booking CREATION and no
terminal transition removes or marks them. `GET /me/earnings/ledger` reads every
row for the buddy with no join to booking status, so **declined, expired and
cancelled bookings still show estimated earnings**.

Buildable either way — a join filter on the read, or a settlement writer on the
terminal transitions — but the two produce different numbers on a screen about
money, and picking one is a product decision rather than an engineering one.

Two smaller asymmetries recorded with it, both measured 2026-09-08, neither
fixed: `POST /safety/end-early` reaches the same terminal states as `/complete`
and never increments `completed_count`, so an ended-early session counts 0 while
an identical completion counts 1; and
`completed_pending_traveler_confirmation` falls into no bucket of the earnings
summary at all, so a finished session vanishes from the buddy's dashboard until
the traveller confirms.

### `MESSAGING_DEGRADED_READ_POSTURE` — 43 reads that render an outage as an empty thread

`routes/messaging.ts` had 53 reads discarding `.error`; 10 were permission- or
confidentiality-relevant and are fixed. The remaining **43 are display
enrichment** — 10 `profiles` reads for names and avatars, 5 `messages` reads for
previews and quotes, 3 `message_translations`, and unread counts. Each was read
individually and every one fails CLOSED in the sense that matters: none of them
can grant access.

What they do instead is render a nameless or empty thread, which is a wrong
answer about a person but not a permission failure. Fixing them means deciding,
per endpoint across roughly fifteen of them, whether a degraded read should 503
or degrade visibly — and that is a product call about what a user should see
when half the page is unavailable. Classified OWNER-priority rather than FIX NOW
for that reason, not because the work is hard.

### `MAP_CANCELLED_TRIP_VISIBILITY` — two surfaces already disagree

Measured 2026-09-08. `lib/mapProjectionTripRead.ts:195` filters trips only on
`.not("status","is",null)`, so a CANCELLED trip is projected onto the map (scoped
to trips the viewer is an accepted member of). `TRIP_DISCOVERY_EXCLUDED_STATUSES`
in `lib/tripDiscoveryProjection.ts:93` excludes `draft`, `cancelled` and
`archived` from discovery.

So the decision is not hypothetical and it is not "what should we do one day":
the two surfaces take DIFFERENT answers today, from the same status column. Both
lanes that touched this stopped at the boundary rather than making them agree,
which is right — making them agree in either direction IS the decision.

### `TRIP_REMINDER_DELIVERY` — a store with a field that promises delivery

**NEW 2026-09-08.** `trip_reminders.remind_at` and `is_sent` have no deliverer
anywhere in the tree. `is_sent` is only ever READ. `lib/tripReminderScheduler.ts`
is a different mechanism — it drives "your trip starts tomorrow" from
`trips.reminder_sent_at` and does not read this table at all.

So the group is a write-only store whose column names promise something nothing
performs. Closing it needs a new scheduler AND its registration in
`src/index.ts`, and possibly a `sent_at` column; a scheduler nobody starts is
the defect this pass keeps finding, so none was written.

Worth reading together with the `2535` row in P1: the write boundary on that
table was closed on 2026-09-08, and the reason the defect was bounded rather
than an open door is exactly this — nothing consumes what is written there.

### `PLAN_EDITORS_ATOMICITY` — a two-call replace with no transaction

**NEW 2026-09-08.** `PATCH /trips/:tripId/settings` replaces the `plan_editors`
set with a DELETE followed by an INSERT, as two separate PostgREST calls. A
landed delete with a failed insert leaves an EMPTY editor list under
`plan_edit_permission: 'specific_members'` — nobody can edit the plan, and no
error was visible before this pass because neither write was bound.

Both writes are now bound, so it fails loudly instead of answering 200. Making
it ATOMIC needs a database function, which is a migration:

```sql
CREATE OR REPLACE FUNCTION public.replace_plan_editors(p_trip_id uuid, p_user_ids uuid[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM plan_editors WHERE trip_id = p_trip_id;
  INSERT INTO plan_editors (trip_id, user_id) SELECT p_trip_id, unnest(p_user_ids);
END $$;
```

NOT WRITTEN AND NOT APPLIED. It is recorded here for the same reason the
`adjust_counter` function is: a database function with no caller is a migration
applied because it exists, and it goes in when the caller does.

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

## Fail-open reads — the ledger reached ZERO, and what that does and does not mean

`check-unchecked-supabase-reads`, 2026-09-08:

```
0 FAIL-OPEN / 217 FAIL-CLOSED / 16 UNCLASSIFIED   exit 0
```

Trajectory across the pass: **306 → 61 → 54 → 25 → 19 → 0.** Every entry was
removed only after the guard itself reported it stale, and every fix was proved
by hand-revert (the fix removed, the test observed failing, the fix restored,
the suite back to 0).

### Two things this number does NOT cover — stated so it is not read as more than it is

**1. `_awardStampCore` is outside the guard's scope.** The guard attributes a
read to its enclosing function name and gates on a set of patterns;
`_awardStampCore` matches none of them, so the WRITE path's copies of the
eligibility reads are not counted. One of them genuinely discards its error:

```ts
const { data: existingEvent } = await sc
  .from("stamp_award_events").select("id, status")
  .eq("idempotency_key", idemKey).maybeSingle();
```

An unreadable table therefore reads as "not yet awarded" and the code proceeds
toward awarding.

**The containment was verified against production rather than assumed**, because
"a constraint will catch it" is exactly the kind of claim that turns out to be
false:

| backstop | present | shape |
|---|---|---|
| `stamp_award_events_idempotency_key_key` | ✅ | `UNIQUE (idempotency_key)` |
| `user_stamps_live_award_unique` | ✅ | `UNIQUE (user_id, stamp_definition_id, coalesce(source_type,''), coalesce(source_id::text,'')) WHERE is_revoked = false` |

So a duplicate award cannot land: the database refuses it with `23505`. The
defect is real but **bounded by a constraint, not by the code** — which is worth
knowing, because deleting either index would silently un-bound it.

**2. The guard's scope rule is itself a false-green surface.** A read moved into
a function whose name does not match the gate patterns leaves the ledger without
being fixed. Widening the scope is the honest next step and is deliberately NOT
done here: it would surface a new population mid-pass and the burn-down would
stop meaning what it currently means. Recorded as engineering work, not closed.

### `STORY_HIGHLIGHT_VISIBILITY` — restated 2026-09-08, and it is NOT the feed-bounding flag

`2339` gates feed bounding, is seeded FALSE, and was left alone. The unbound
decision is narrower and sharper: **what should `POST /stories/:id/save-to-highlight`
do with the Story audiences a Highlight cannot represent?**

Measured against the committed production schema snapshot, not estimated:
`stories` carries `trip_id`, `allowed_user_ids`, `hidden_user_ids` and
`close_friends_only`. **`highlights` carries none of those four columns.**

| Story rung | Highlight target | Why |
|---|---|---|
| `public` | `public` | identical audience |
| `circle_only` | `circle_only` | identical predicate both sides |
| `close_friends` | **none** | no close-friends audience on Highlights |
| `friends_only` | **none** | no mutual-follow audience |
| `custom` | **none** | no `allowed_user_ids` / `hidden_user_ids` |
| `trip_crew` | **none** | looks like `trip_only` and is not |

So four of six rungs have literally nowhere to land, and three Highlight
visibilities (`travelers_nearby`, `trip_only`, `private`) are unreachable by
promotion at all. The `trip_crew` case is the one that must not be waved
through: a trip_crew Story admits the accepted crew of ONE trip
(`stories.trip_id`), while `sharesAcceptedTrip` resolves `trip_only` across
**every** trip the viewer is accepted crew of. Mapping one to the other is a
WIDENING, not a translation — from one crew to every crew the owner has ever
had.

Today the code refuses those four rungs with `409 not_promotable` and a stable
`reason`, leaving the Story untouched. The options and what each costs:

1. **Keep refusing.** Nothing widens. Four of six Story kinds can never become
   Highlights, permanently.
2. **Add matching Highlight audiences** (`close_friends`, `friends_only`, a
   `trip_id` column, an ACL). Faithful, and the only option that makes
   `trip_crew` promotable. Costs schema plus a new predicate in every highlight
   read path.
3. **Snapshot an explicit viewer ACL onto the Highlight at promotion time.**
   Faithful at the instant of promotion; the audience then stops tracking the
   owner's later list edits — a product statement, not a bug, and one that has
   to be chosen rather than inherited.

**Not decided here.** Everything that does not depend on the answer is built.

### `TRIP_CREW_SIGNAL_ROLE_COVERAGE` — a split the file's own header says must not happen

`lib/tripMembership.ts` admits `owner` and `member`. `getMemberRole`, which its
header claims to mirror, admits `owner`, `co_host` and `member`. Measured: for a
trip with an owner and an ACCEPTED `co_host`, `isAcceptedTripMember(co_host)` is
**false**, `acceptedCrewSize` is **1**, and `isSharedCrewMember(owner)` is
**false**. Both people are on the trip; both fall back to solo intel groups.
That is a SPLIT, which the file's own header calls "the exact leak the crew
signal exists to prevent".

**Why this is an owner decision and not a bug fix.** The repair WIDENS who may
assert a crew token. Widening an authorization gate to make a header's claim
true is not a change engineering should make on its own reading, however
obviously the header intends it — and the lane that found it declined to,
correctly. What must be decided is whether the crew signal covers `co_host` and
`viewer`, or whether the header is wrong and should be narrowed to match the
code.

### `LAYOVER_RETURN_REMINDER_DELIVERY` — the "head back NOW" push has no sender

`sendReturnDeadlineReminder` (`src/services/airport/LayoverNotificationService.ts`)
has **zero references anywhere, including tests**. It is the function that
composes *"🚨 Head back to the airport NOW"* and *"You must be back at the
airport by X to board safely."* `POST /return-deadline` persists
`return_reminder_at`, and the route comment says the client reschedules local
notifications.

So either the server-side push is meant to exist and is dead, or the reminder is
client-only by design and the composer is vestigial. That is a product decision
about a SAFETY notification — the one class where "we thought the other side was
doing it" is least acceptable — and it is recorded rather than guessed.

### `MODERATION_TARGET_NULLABILITY` — the column shape is what forces the dilemma

`moderation_actions.target_user_id` is `NOT NULL REFERENCES profiles(id)`. When
the content owner cannot be resolved — because the lookup FAILED, not because
there is no owner — the moderation path has exactly two options: **skip the
audit row**, or **fabricate a target**. Both are bad, and the code currently
skips loudly (`skipped_owner_lookup_failed` at ERROR, with the outcome in the
response) rather than inventing one.

A nullable column, or a separate content-target column, would let those paths be
genuinely fail-closed instead of choosing the least-bad lie. That is a schema
change on an audit table and it is not engineering's call to make unilaterally.
Recorded with the constraint named, so the decision is about the column rather
than about the symptom.

### `INTERACTION_COOLDOWN_READ_DIRECTION` — a measured fail-open that is not safe to simply flip

`user_interaction_cooldowns` is a DENY table: a row means "this pair is in
cooldown". The read returns `false` on error, so an unreadable table lets a
previously-blocked viewer act again. Fail-open, measured, and left in direction
deliberately.

Flipping it is not obviously right. A cooldown is a *temporary* restriction, and
failing closed means every legitimate pair is blocked for the duration of any
outage, across 15+ routes that resolve interaction permissions. Choosing between
"a cooldown occasionally lapses during an outage" and "nobody can interact
during an outage" is a policy call about how much friction a degraded database
should impose. The read is now OBSERVED and logged either way, so whichever is
chosen can be implemented without further discovery.

### Two exposed SECURITY DEFINER functions inside HOLD workstreams

Not owner decisions and not engineering backlog — findings recorded so that
whoever unfreezes the relevant workstream inherits them rather than
rediscovering them. Both measured on production 2026-09-08; neither touched,
because both sit inside declared HOLD areas.

| Function | Live grants | What it answers | HOLD area |
|---|---|---|---|
| `event_is_in_state(uuid, event_state[])` | **anon AND authenticated** | for any event id, whether it exists and is in a named state — to a caller who has not signed in | Event Truth Phase-B; `EVENT_START_TRANSITION` is the paired owner decision |
| `purge_old_ranking_debug_samples()` | authenticated | DELETEs `ranking_debug_samples` older than seven days and returns the count | Ranker |

Neither is referenced by any of the 808 surviving RLS policies, by any function
body, view or trigger, or by any string literal in `src/`. `event_is_in_state`
is the wider exposure of the two; `purge_old_ranking_debug_samples` is bounded
to rows already past their intended retention, which is why it is recorded
rather than treated as urgent. In both cases **the grant is the part that is
wrong, not the function** — and for the same reason set out in
`src/scripts/checkSecurityDefinerOracles.ts`, the remedy is a REVOKE or a DROP
and never a blanket sweep: eleven sibling functions ARE policy-referenced, and
revoking EXECUTE on one of those makes the policy itself raise "permission
denied for function" for every end-user token.

The third member of that set, `increment_hashtag_usage_count`, was NOT inside a
HOLD area and was closed under the full migration gate — see `2551`.

---

## `TRUST_OVERRIDE_PIN_OR_CAP` — what an admin "override" of a trust score means

**New 2026-09-08.** census-trust C22, and the last row standing between the Trust
surface and 100 %. Six of its eight open rows were closed by engineering on
2026-09-08; of the two left, A6 is a production measurement that needs a deploy,
and this one needs a sentence from an owner.

### The measurement

`TrustScoreService.adminOverrideScore` is described as overriding a category
score. It does not override it. It writes a **ceiling** into `trust_caps`, and
`recalculateTrustScore` then recomputes the score from events — so:

- an override **below** the event-derived score holds, because the ceiling clamps;
- an override **above** it does **not**, because the recomputation moves the
  score back up underneath a ceiling that is not binding;
- `trust_caps` has **no floor column**, so there is nowhere to store the other
  half even if the answer were "pin".

Nothing is wired to a route, so **no live behaviour turns on this today**. That
is why it is safe to leave open, and also why it is cheap to decide.

### The question

Does **override** mean:

| | Meaning | What an admin can do | What it needs |
|---|---|---|---|
| **PIN** | the admin's number wins until it is lifted | **grant** standing as well as withhold it — vouch for a user the events have not caught up with | a floor alongside the ceiling: a schema change to `trust_caps`, and a recompute that respects it |
| **CAP** | the admin sets a maximum; events move the score freely below it | only **withhold** standing — never grant it | nothing. This is what the code already does; the fix is to rename the function and say so |

These are different products, not two spellings of one. A pin lets a human put
their judgement above the ledger; a cap says the ledger is the only thing that
can raise a score and a human may only limit it. Both are defensible.

### Why engineering is not choosing

Building the floor takes the decision by making "pin" true. Renaming to
`adminCapScore` takes it by making "cap" true. There is no implementation that
leaves the question open — which is precisely the condition for an OWNER row.

**What is buildable now, either way:** nothing. The correct next commit depends
on the answer, and no code change improves the situation before it.

---

## `WALL_ACCENT_COLOUR` — the last open row in the Wall census, and it is a brand decision

Raised 2026-09-08 by the Wall recensus (`census-wall.md` §6). W166 is the **one**
remaining non-CANNOT-VERIFY row between the Wall and 205/205: 196 correct, 1
wrong, 0 not-built, 8 that need a device or a human judgement.

### The measurement

Wall spec §35: *"Portava purple is an interaction/accent colour, not a background
wash."* The rule has two halves and they have different answers.

- **Structural half — HOLDS.** No Wall card, sheet or strip uses the accent as a
  background wash. Accent is used for icons, state words and interaction
  affordances, which is exactly what the rule asks for. This was verified over
  the real tokens by the §38 contrast suite, which additionally proves the accent
  cannot carry small text on white and therefore is not being used as body
  colour anywhere.
- **Colour half — DOES NOT HOLD.** The Wall's accent tokens are
  `signal: '#FF4D2E'` (vermilion) and `deep: '#0A3D4A'` (teal-ink)
  (`travel-buddy-standalone/src/theme/tokens.ts:12#signal`). There is no purple.

So the Wall obeys the spec's *rule about how an accent may be used* and uses a
different accent than the spec names. That is the same family of divergence as
Passport §27, and it is not new: the vermilion/teal palette is the one the whole
client is built on, and the contrast suite's AA thresholds are computed against
it.

### The question

| | Meaning | What changes | Cost |
|---|---|---|---|
| **SPEC IS STALE** | the palette moved and the spec did not | one line in the spec; W166 becomes C with no code change | none |
| **PALETTE IS WRONG** | the Wall really should be purple | `theme/tokens.ts` accent values, and every AA pairing recomputed against them | the contrast suite re-runs across the whole client, not just the Wall; some pairings will fail and need new tokens |

### Why engineering is not choosing

Repainting a brand accent is a one-line change and an irreversible product
statement, and the two options are not "fix it" versus "leave it" — one of them
says the spec is out of date and the other says the app is. Nothing in the code
distinguishes them: both palettes satisfy §35's structural rule, and a checker
cannot tell which colour a brand *intends*.

**What is buildable now, either way: nothing.** If the answer is SPEC IS STALE
the change is a sentence in a document engineering does not own. If it is PALETTE
IS WRONG the first step is a design decision about which purple, and the contrast
consequences follow from that value. There is no commit that improves the
situation before the answer.

**Note on scope, so this is not read as bigger than it is:** W166 is worth 0.5 %
of one census. It is on this ledger because it is the LAST row, not because it is
urgent — and because a census that says "1 BUILT-BUT-WRONG" with no explanation
of who can fix it is the shape that quietly becomes permanent.

---

## `DISPLAY_NAME_RULE_LOCAL_COPIES` — one rule, four call sites, no single home

Raised 2026-09-08 while correcting `census-passport` P169. ENGINEERING, not an
owner decision — recorded here because it is the kind of finding that gets fixed
once in one place and left in the other three.

### The rule

`lib/publicIdentity.ts:presentedName` is the canonical resolution of "what real
name may this viewer be shown": `display_name ?? name ?? full_name`, trimmed,
and only when `nameVisibilitySet` says the owner opted in. `nameVisibilitySet` is
used everywhere and is not the problem. The RESOLUTION is copied.

### The four sites, and how far each had drifted

| site | opt-in gate | name resolution | state |
| --- | --- | --- | --- |
| `lib/mapTravelers.ts` | canonical | was inline, order correct | **fixed** — now requests `buildMapPresenceProjections` (P98) |
| `routes/discoverySearch.ts:624` | canonical | `p.name` ALONE, and `display_name` was not even in the SELECT | **fixed** — adopts `presentedName`; a user with a display name was shown the other one |
| `routes/compass.ts:3672` | canonical | `display_name ?? name ?? username` inline | **NOT fixed — see below** |
| `services/passport/PassportProjectionService.ts` | canonical | canonical | fine |

### Why the Compass one was left, deliberately

Its order is already right, so the only divergence is the trim: a whitespace-only
`display_name` renders a blank title with no way to tell who the row is. Same
class as the Discovery bug, an order of magnitude smaller.

The change itself is three lines and was written, typechecked and reverted,
because **no test covers the traveler-recommendation title path**. The nearest
suite (`compass-social.test.ts`, 33 tests) exercises `get_whos_around`, a
different code path; `compassSurfaces.test.ts` (77 tests) does not reach it. The
title sits inside a nested conditional carrying a real privacy asymmetry — an
opted-in subject with no name shows their username even when private and
non-followed, because opting in is the owner's own choice — and rewriting that
without a test is how an asymmetry quietly becomes a leak.

**What is buildable now:** the harness. Build a test for the Compass
traveler-recommendation payload that pins the existing four-way title behaviour
(opted-in with a name / opted-in with none / not opted-in public / not opted-in
private-non-followed), THEN adopt `presentedName`. In that order. The value of
the fix is smaller than the value of that harness existing, which is the honest
reason to do it in that order rather than the reverse.

---

## `VISA_BUDDY_CAPABILITY` — the seventh capability, and the one the tree argues against

Raised 2026-09-08 by the Passport pass. `census-passport` P59 is the LAST
NOT-BUILT row in that census (150 C / 17 W / 1 N / 1 ?).

### The measurement

Passport spec §11 names seven capabilities derived from trust evidence + domain
policy. Six exist and are derived server-side in
`services/passport/PassportProjectionService.ts:659#buildOwnerCapabilities`:

```
canJoinPublicTrip · canHostTrip · canCreateLargePlan
canUseCrewLocation · canContributeLiveIntel · canBecomeBuddy
```

The seventh, `canProvideVisaBuddyService`, does not exist. A repo-wide search for
`canProvideVisaBuddyService`, `VisaBuddy` and `visa_buddy` returns nothing in
either tree.

### Why this is not "add a line to buildOwnerCapabilities"

**There is no visa product.** The six existing capabilities each gate something
that exists — trips, plans, crew location, live intel, RAB. A seventh boolean
would gate nothing, be read by nothing, and be exactly the producer-with-no-
consumer shape this ledger's P2 section exists to track.

**And the tree's only current posture on visas is the opposite one.** The three
places the word appears are Layover disclaimers:
`services/airport/LayoverSafetyEngine.ts:585` — *"Verify visa rules"* — and
`:619`, `:628`, whose comment states that entry is **never confirmed on this
tree**. A capability asserting that a user may PROVIDE visa assistance would be
the first thing in the product implying the platform stands behind that, and it
would do so as a derived boolean nobody decided to publish.

### The question

What evidence qualifies a person to provide visa assistance to another person?

That is not an engineering threshold like `rank >= 3`. It is a policy question
with a plausible regulatory dimension — immigration advice is a licensed activity
in several of the markets this product names — and picking a trust rank for it
would be inventing that policy in a formula, silently, in a file whose other six
lines are uncontroversial.

| | Meaning | What it needs |
|---|---|---|
| **DROP** | the spec line is aspirational; the product has no visa service and will not derive a capability for one | one sentence in the spec, and P59 becomes a scored-out row rather than a gap |
| **DEFINE** | there is to be a visa-assistance service | a product definition FIRST (what is offered, by whom, with what disclaimer), then the qualifying evidence, then the capability |

### Why engineering is not choosing

Adding the boolean takes the decision by making DEFINE true, and takes it with a
threshold nobody set. Leaving it takes nothing and costs one row in one census.

**What is buildable now, either way: nothing.** Under DROP there is no code. Under
DEFINE the capability is the last step, not the first.
