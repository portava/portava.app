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

### `VOTE_BALLOT_VISIBILITY` — can a crew see who voted which way?

**An OWNER decision, defaulted to the narrower answer and shipped, because
defaulting to the wider one is not reversible.**

§9.3 gives a proposal a `decisionRule` of HOST | MAJORITY | UNANIMOUS | ANYONE,
and migration 2774 built `trip_proposal_votes` — one row per crew member per
proposal, carrying `yes | no | abstain`. The spec says who DECIDES. It never
says who may SEE how each person decided.

### What was shipped

`GET /trips/:tripId/decisions` serves, per proposal:

- the aggregate tally from `trip_proposal_tally` — counts, electorate size, and
  whether each rule is met; and
- **the caller's OWN ballot**, as `myVote`, or `null` for "has not voted".

**No other crew member's ballot appears anywhere in the response**, and a test
asserts that by scanning the whole serialised body for another user's id.

### Why the caller's own vote is not part of the question

Without it the feature is unusable: a crew member cannot tell whether they have
already voted, and would be sent to vote twice — which the kernel then refuses,
so the failure surfaces as a confusing error rather than as the missing
information it is. It is also the one ballot whose disclosure needs nobody's
consent.

`null` is deliberately NOT rendered as `abstain`. Migration 2774's own column
comment draws the line: *"ABSTAIN IS NOT ABSENCE: it is a recorded decision not
to decide, and it counts toward a unanimous rule being SATISFIED but not toward
it being MET… A crew member who has not voted at all has a different meaning
and no row."* The unanimous rule turns on exactly that difference, so a client
showing both as "no vote" erases the thing the rule is about.

### The question that is actually open

Whether a crew member may see **another** crew member's ballot. Three defensible
answers, and this is product policy rather than engineering:

1. **Visible to the crew.** A trip decision is a group decision made among
   people who know each other; hiding it is the surprising choice, and with a
   three-person crew the tally nearly determines the ballots anyway.
2. **Visible to the proposer and the owner only.** They are the ones who have
   to act on it.
3. **Never visible.** Vote secrecy protects a member from being pressured by a
   dominant traveller, which is a real dynamic in a small group.

### Why it shipped narrow rather than waiting

Widening later is a one-line change to one route. Narrowing after people have
seen each other's ballots is not — the disclosure has already happened, and no
migration undoes it. This is the same asymmetry that governs a privacy default
anywhere: the reversible direction is the one to be wrong in.

Note that answer 1 is arguably ALREADY partly true through the tally, which is
served: on a three-person crew, `yes: 2, no: 1` plus your own ballot tells you
the other two. That is an argument for answer 1 being the honest end state, and
it is not an argument for shipping it without being asked.

### `API_TOKEN_SIGNED_OUT_VS_UNREADABLE` — one null for two different facts, app-wide

**Engineering, not an owner decision. Recorded rather than half-fixed, because
the fix is not Trips-shaped.**

`travel-buddy-standalone/src/services/apiToken.ts` `freshToken()` returns
`string | null`, and `null` means BOTH of these:

- the user is signed out (no session, and no refresh is possible), and
- the session refresh FAILED (network, an auth outage, a 5xx from Supabase).

```ts
if (needsRefresh) {
  const { data: refreshed } = await _client.auth.refreshSession();
  return refreshed?.session?.access_token || null;   // both facts, one value
}
...
} catch { return null; }                              // and again here
```

Every service module in the app is built on it, and each one turns that null
into a confident answer about the user's data: `if (!token) return []` in
`services/trips.ts`, `services/tripDestinations.ts` and their siblings. So an
auth-refresh outage is presented to a signed-in user as "you have no trips" —
the same sentence a genuinely empty account gets.

**Why the Trips pass did not fix it.** The 2026-09-09 fail-closed pass made the
Trips reads refuse instead of answering: `listMyTrips`, `getPendingTripInvites`,
`getInviteLinks`, `listDestinations` and `fetchPlanEditableTrips` now throw
`TripsReadUnavailableError` when the REQUEST fails. They deliberately keep the
existing signed-out behaviour for `!token`, because changing it means changing
`freshToken`'s return type, and that type is read by every service module in
`src/services/` — not by Trips. Fixing it inside Trips would leave the app with
two contradictory conventions for the same helper, which is worse than one
honest record of the defect.

**What the fix is.** `freshToken` returns a three-state — a token, `signed_out`,
or `unavailable` — and each caller decides which of the two nulls it was
treating as which. It is one mechanical change across many files, and it is
engineering work, not a decision.

**What is bounded, and what is not.** The blast radius is display honesty, not
authorization: a null token produces a request WITHOUT an Authorization header,
which the server rejects. Nothing is granted. What is wrong is only ever what
the user is TOLD — which is the same class of defect as the rest of this pass,
at a layer below it.

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
| `services/passport/PassportConsumerProjections.ts` | canonical | **a FIFTH copy, added by the fix above** | **fixed** — see below |
| `routes/discoverySearch.ts:624` | canonical | `p.name` ALONE, and `display_name` was not even in the SELECT | **fixed** — adopts `presentedName`; a user with a display name was shown the other one |
| `routes/compass.ts:3672` | canonical | `display_name ?? name ?? username` inline | **NOT fixed — see below** |
| `services/passport/PassportProjectionService.ts` | canonical | canonical | fine |

### The fifth copy, written by the commit that removed the first

Worth recording because it is the whole argument for a choke point, demonstrated
against the person making it. `buildMapPresenceProjections` — added specifically
so the map would stop rebuilding identity — resolved the name with
`prof.display_name ?? prof.name` INLINE, inside `services/passport/`, two commits
after the Discovery fix and one after this ledger entry was written.

It was caught by `passportProjectionNameVisibility.test.ts`, which forbids
exactly that read in exactly that directory, and it was caught at branch
certification rather than by review. Fixed by routing through `presentedName`.

The lesson is not "be more careful". It is that the rule survives because a guard
enforces it in the one directory where it matters most, and the remaining
divergences below are the ones NO guard covers.

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
`services/passport/PassportProjectionService.ts:683#buildOwnerCapabilities`:

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

---

## `CLIENT_NODE_SUITE_CANNOT_RUN` — 262 tests the branch certification cannot see

Found 2026-09-08 while building Passport P68. ENGINEERING, and it is on this
ledger because it is invisible: the branch stays CERTIFIED: YES throughout.

### The measurement

`travel-buddy-standalone`'s node-test suite does not run in this environment.
`node scripts/run-node-tests.mjs` reports **262 tests, 3 pass, 259 fail**, and
every failure is the same one, before any assertion executes:

```
Error [ERR_REQUIRE_CYCLE_MODULE]: Cannot require() ES Module
  …/viewerActions.test.ts in a cycle. A cycle involving require(esm) is not
  allowed to maintain invariants mandated by the ECMAScript specification.
```

`viewerActions.test.ts` is untouched and predates this session (`a745ba11`), so
this is not a regression from any change here. Node is **v22.22.2** and the
runner invokes `--import tsx/esm --test`, which is what the failure is about; the
suite's own contents are not implicated.

### Why it matters more than "some tests are red"

**`scripts/certify-branch.mjs` runs the api-server suite and nothing else.** So a
whole client test suite can stop executing and every certification in this
session still says `CERTIFIED: YES — 33 passed, 0 failed`. It did.

That is not hypothetical damage. `check-test-mocks.mjs` — a client gate — refused
to start the runner because `WallPromotionDisclosure.component.test.tsx`, added
earlier the same day, carried its explanation without the literal word `NOTE`.
The branch certified green three times over that. It was found by hand, and only
because P68 happened to be a client row.

### What is buildable now, in this order

1. **Make the certification able to see it.** A `test:client` step in
   `certify-branch.mjs`, classified `liveonly`/`gate` as appropriate, so an
   unrunnable client suite reports CANNOT-RUN rather than nothing at all. This is
   the part that stops the class, and it is worth doing even while the suite is
   broken — CANNOT-RUN is a state this harness already models honestly.
2. **Then fix the runner.** Likely a tsx/Node-version interaction; the fix is
   the runner's invocation, not the tests.

Doing (2) without (1) fixes today's outage and leaves the blind spot that hid it.

### Not fixed here, deliberately

`certify-branch.mjs` is the instrument every claim in this session rests on.
Adding a step to it changes what "CERTIFIED" means, and doing that in the same
pass that discovered the gap — without the suite green to calibrate against —
would be measuring with an instrument altered mid-measurement. It is the next
unit of work, not a footnote to this one.

---

## `TRIP_KERNEL_NEVER_DEPLOYED` — three migrations that exist only in this repository

> **CORRECTED AND RESOLVED 2026-09-09. Read the correction at the foot of this
> entry before the entry: its measurement was a proxy and its conclusion was
> wrong, and the thing it called a blocker is a merge.**

Not an owner decision. A measurement, recorded here because it changes how every
Trips §4 verdict in `census-trips.md` should be read, and because acting on it
requires a deployment gate this session does not hold.

### The measurement

Read-only, 2026-09-09, against both databases:

| | repo | portava-ci (`hwokxgbmezheskbzskfr`) | production (`ajrurzioarfkagpuxfnb`) |
|---|---|---|---|
| `trip_kernel_execute` length | 44,343 ch | 11,314 ch | 11,976 ch |
| `SET_TRIP_COVER` | present | **absent** | **absent** |
| `CREATE_TRIP` | present | **absent** | **absent** |
| `JOIN_VIA_LINK` | present | **absent** | **absent** |

Both carry `2420_trip_kernel_foundation.sql`'s original plan-family-only kernel.
`portava-ci`'s `supabase_migrations.schema_migrations` lists 2420 and **none** of
2450, 2500 or 2590.

The three files' own headers say why: each records being rehearsed on portava-ci
**inside a transaction that ended in `ROLLBACK`**. That was the correct thing to
do at the time and nothing was left behind — which is precisely the point. A
rehearsal that rolls back leaves the database exactly where it was, and nothing
in the tree since has noticed that it was never followed by an apply.

### Why it matters more than "three migrations are pending"

`census-trips.md` §26 moved twelve §4 rows from N to C. Every one of those
verdicts is true of the repository and none of them is true of any database. The
programme's rule already covers this — BUILT ON BRANCH IS NOT MERGED, MERGED IS
NOT DEPLOYED — but until this measurement there was no number attached to it for
Trips, and the census read as though the kernel were live.

It also gates work. `2764_trip_kernel_stage_family.sql` is a transform of the
2590 body; it cannot be rehearsed on Supabase because no Supabase database has
that body. Every §5 command family after it — legs, commitments, goals,
decisions, risks, presence, proposals, snapshots, outcomes — is in the same
position, which is why `db/harness/run.sh` was built.

### What went right, and should be kept

2764's base assertion checks for `SET_TRIP_COVER` before touching anything. It
was pointed at portava-ci, found none, and raised. Without it the file would have
applied cleanly and produced a kernel carrying the stage family and missing three
migrations' worth of commands — a silent, plausible-looking wrong function.
**Every future kernel transform must carry the same assertion.**

### What is buildable now, in this order

1. **Apply `2450 → 2500 → 2590` to portava-ci and leave them applied.** All three
   are flag-gated (`trip_kernel_enabled` is false; the only caller checks it
   fail-closed), so the user-visible change is nothing. This is what makes
   portava-ci a rehearsal database again rather than a stale one.
2. **Then rehearse 2764 there**, and re-rehearse 2760–2763's rollbacks against a
   kernel that has the stage family.
3. **Then, and separately, the production question**, which is not step 3 of this
   list so much as a different list: production has none of 2334, 2337 or 2420
   either, so the chain there is six migrations, not three.

### Not done here, deliberately

Step 1 persists a change to a database. Every prior lane that touched these three
files chose to rehearse and roll back, and reversing that choice inside the pass
that discovered the gap — with no one asking for it — would be crossing a
standing decision on the strength of my own measurement. The measurement is the
deliverable; the apply is the owner's call.

---

## `PROPOSAL_DECISION_RULE` — §5.1 and §9.3 describe different proposals

**Not an owner decision. A spec inconsistency, resolved here, with the
resolution being built rather than deferred.**

### The inconsistency

The spec describes `TripProposal` twice and the two do not agree.

§5.1, the storage roster, line 133:
> `trip_proposals` — id, trip_id, proposal_type, payload_json, status,
> expires_at, affected_version

§9.3, the domain object:
> `TripProposal { type, proposedBy, affectedObjects[], rationale,
> impactSummary, decisionRule: HOST | MAJORITY | UNANIMOUS | ANYONE, status,
> expiresAt }`

`2763_trip_presence_proposals_snapshots_outcomes.sql` implemented §5.1 exactly.
So the table is right about §5.1 and missing five of §9.3's fields, `decisionRule`
among them — and `decisionRule` is the one that is not descriptive. It decides
who may accept.

### The resolution

Split the two lists by whether a field must be **enforceable** or merely
**readable**.

- `decision_rule` becomes a COLUMN. A governance rule stored inside
  `payload_json` cannot be relied on by the code that enforces it: an
  unconstrained jsonb key can hold any string, including one no branch handles,
  and the safest behaviour for an unknown governance rule is not something a
  `->>'decision_rule'` can express. It gets a CHECK with §9.3's four values.
- `proposed_by` becomes a COLUMN. MAJORITY and UNANIMOUS are computed over the
  crew, and a proposal whose author is unknown cannot be excluded from, or
  counted in, its own vote. It is also the attribution §9.3's "proposedBy"
  asks for.
- `affectedObjects[]`, `rationale` and `impactSummary` stay in `payload_json`
  under documented keys. Nothing enforces them, they vary by proposal type, and
  giving each a column would freeze a shape §9.3 does not fix.

§9.3 also implies a vote: MAJORITY and UNANIMOUS are not computable without
one, and §1's capability list already names "proposals, votes". So the
resolution includes `trip_proposal_votes` and a `VOTE_ON_PROPOSAL` command.

### What shipped first, and why it is not the resolution

`2768_trip_kernel_presence_proposal_outcome_families.sql` gates ACCEPT_PROPOSAL
and REJECT_PROPOSAL on `host`, unconditionally. That is an INTERIM choice and
the migration's header says so. It is the narrowest of §9.3's four rules, which
is the only safe direction to be wrong in: widening a capability later cannot
retroactively legitimise a decision a narrower rule refused, and narrowing one
later cannot un-make a decision a wider rule allowed.

Superseded by **`2774`** (the `decision_rule` and `proposed_by` columns, the
`trip_proposal_votes` table, and the `trip_proposal_electorate` /
`trip_proposal_tally` functions) and **`2775`** (the kernel: `VOTE_ON_PROPOSAL`,
the `proposal_rule` capability resolved per proposal, the tally check, and an
acceptance that APPLIES the proposal to canonical state instead of flipping a
status column).

*(An earlier draft of this entry said `2769`. That number went to the
participant-role and lifecycle corrections instead; the governance work landed
two lanes later. Corrected rather than quietly renumbered, because a ledger
entry pointing at the wrong migration is worse than one pointing at none.)*

**This entry stays in the ledger after 2775 lands**, because the inconsistency
is in the spec and the next reader of §5.1 will hit it again.


### Correction, same day: the measurement was a proxy and the blocker is a merge

Everything above rests on comparing `pg_get_functiondef` LENGTHS. Lengths count
comments. Comparing `md5(prosrc)` instead:

| | md5 of the installed body |
|---|---|
| repo `2420` | `d621c513ef2093054aea014702733649` |
| production | `d621c513ef2093054aea014702733649` |
| portava-ci | `ed202dc5664f7f46e3b27c7810fb1a2e` |

**Production's kernel is byte-identical to the repository's 2420.** portava-ci's
is the same file with its nine whole-line `--` comments stripped and nothing
else — proven by reproducing ci's md5 from the repo's body by deleting comment
lines. Same commands, same reasons, same branches. The "11,314 vs 11,976"
difference this entry leads with is comments, and the sentence "the trip family
... exist only in this repository" is true of both databases equally, which the
original framing obscured.

**And the reason the three are absent is not a rollback.**
`.github/workflows/live-db.yml` applies pending migrations to the sanctioned CI
project — each in one transaction carrying its ledger row, then
`certify:migrations` — when `github.ref == refs/heads/main`. None of 2420, 2450,
2500, 2590, 2750, 2760–2763 or 2767 is on main; this branch is 417 commits ahead
of it. The designed applier has never seen any of them. 2420 reached both
databases by hand, which portava-ci's ledger records in its own notes column,
and which is how it lost its comments.

So this is not a blocker. It is a merge, and the apply is what the merge
triggers.

**Hand-applying would be the wrong action, not merely an unnecessary one.** It
routes around the dry run, the one-transaction-with-ledger-row guarantee, the
certification pass and the sanctioned-project assertion — reproducing exactly
the mechanism that produced the drifted 2420. That assertion is in the execution
path, not a workflow step: `artifacts/api-server/src/lib/ciSupabaseGuard.mjs`
refused this session's attempt to run even the dry run, which is the control
working.

**Disclosure.** `2767_trip_presence_spec_vocabulary.sql` WAS hand-applied to
portava-ci in this session, before the designed path was understood, using the
same mechanism this entry now argues against. It is additive, the table held
zero rows, and its own preconditions and postconditions ran; leaving it is safer
than reverting, because portava-ci's `trip_presence` would otherwise carry a
vocabulary its writer refuses. It is recorded here rather than left for someone
to find in a ledger diff. `2760`–`2763` reached portava-ci the same way in an
earlier session.

**What replaced the hand-apply.** `db/harness/run.sh` now rehearses
2420 → 2450 → 2500 → 2590 as REAL migrations in order, on a bare PostgreSQL 16
cluster, with the base schema they assume and the authz functions sliced from
2334 and 2337 rather than stubbed — and prints the prosrc md5 after each step,
the first of which reproduces production exactly. Executing that ancestry found
two defects nothing had read out of it, both fixed in `2769`: no kernel command
could create a `co_host` even though 2500's `host` capability depends on one,
and `CANCEL_TRIP` succeeded on a completed trip.


---

## `APPEAL_RESTORE_SEMANTICS` — narrowed 2026-09-09: the source exists now

**Still an owner decision, and a smaller one.** This entry records what changed
so the next reader does not re-derive it.

### What the decision was blocked on

`services/appeals/adminRestoreParticipant.ts` keeps two allowlists, both empty,
and says why:

> `APPROVED_RESTORATION_SOURCES` — "Also EMPTY, and for the same reason: 'their
> role at removal' is only a valid source if something durably records it, and
> nothing does once the row is DELETEd."

So the decision was blocked on TWO things at once: **no source** for a removed
member's role, and **no policy** for what to restore them to. The first made the
second unanswerable — you cannot choose "restore their previous role" if nobody
knows what it was.

### The first half is no longer true

The kernel's `REMOVE_PARTICIPANT` branch has, since 2450, done this immediately
before deleting the row:

```sql
v_payload := v_payload || jsonb_build_object('role_at_removal', v_member.role::text);
```

and the resulting `trip.participant_removed` event lands in `trip_events`, which
2420 makes **append-only** with `trg_trip_events_append_only` — a trigger that
refuses every UPDATE. The role at removal is therefore durably recorded, by
construction, in a table nothing can rewrite. It was put there deliberately:
2450's own comment says "role at removal lets a consumer tell 'invite cancelled'
from 'member removed'."

`services/appeals/roleAtRemoval.ts` reads it. That module is the proof the
source exists — it returns the role — and `src/test/appealRoleAtRemoval.test.ts`
pins both halves: that the recovery works, and that every failure mode is named
and none of them yields a role.

### What is STILL the owner's, stated as three questions

None of these is inferable from the code, and each changes what a user is
entitled to:

1. **May a removed co_host be restored as co_host**, or does an upheld appeal
   return someone to plain membership? Restoring host authority by appeal is a
   different product than restoring access.
2. **Does the crew cap still apply?** `trips.max_members` refuses an insert past
   the cap. If a trip filled up after the removal, does the appeal override the
   cap, wait, or fail?
3. **Which removal, for someone removed twice?** `roleAtRemoval.ts` returns the
   MOST RECENT, on the reasoning that anything else silently reverses a role
   change the person consented to in between. That reasoning is stated in the
   module and is not the same as it being decided.

### What has NOT been done, deliberately

`APPROVED_RESTORATION_ROLES` and `APPROVED_RESTORATION_SOURCES` are **still
empty**, including for the source this work just proved exists. Adding a value
to either IS taking the decision, the file says so, and a test now fails if
either grows a member. `resolveAppeal.ts`'s `trip_membership` case is unchanged
and still defers.

**The decision is smaller than it was.** It was "we have no source and no
policy". It is now "we have a source; which policy?" — three questions with
concrete options, rather than an open-ended one.

---

## `CI_DB_HAND_APPLIED_FROM_UNMERGED_BRANCHES` — portava-ci carries schema no merged branch can show you

**Opened 2026-09-09.** Type: `OPS_DATA`. Owner: whoever owns the three open
branches named below. Buildable now? **No** — nothing in this repository can
close it, and the two obvious closures are both wrong.

### The measurement

The first two runs of the sanctioned applier that had anything to apply (main at
`42aeac38`, then at `d9ee61b2`) surfaced this. It is not a Trips finding; it is
about the shared CI database.

**Three ledger rows name a migration file that does not exist in this
repository**, and `check:migration-ledger` — stage 1 of `certify:migrations` —
fails on them by design:

| Ledger row on portava-ci | `applied_by` | Its own note says |
|---|---|---|
| `2311_intel_claim_reviews.sql` | `manual` | "Applied by hand 2026-09-07 … to unblock PRs #456/#457" |
| `2320_memory_episode_provenance_spine.sql` | `manual` | "Applied by hand 2026-09-07 to unblock PR #470" |
| `2325_telegraph_unsend_before_seen.sql` | `manual` | "Applied by hand 2026-09-07 to unblock PR #472" |

There is no `2311`, `2320` or `2325` anywhere in `src/migrations` — the whole
band holds one file, `2315_sensing_anon_contributions.sql`. The rows are
honest: they record something that really happened. What happened is that three
feature branches applied their own migrations to the SHARED CI database, and
none of those branches has merged. **PR #470 is still open and its own
description ends "DO NOT MERGE — for review."**

**Six more migrations were applied the same way and left no row at all.** The
applier proved it by dying on the collision: `2720_highlight_resurfacing_
preferences.sql` failed `42710: policy "highlight_resurfacing_select_own" for
table "highlight_resurfacing_preferences" already exists`, and a direct query
confirms the objects of `2720`, `2721`, `2722`, `2723`, `2724` and `2730` are
all present on portava-ci while every one of them was still in the applier's
pending list.

### Why it matters more than "one gate is red"

`certify:migrations` stage 1 is the gate that answers **"does this database
represent this branch?"** Three rows say no, and they will keep saying no
however much of `main` is applied. So the live-DB lane cannot reach a clean
verdict from work done on `main` alone — which is exactly the property the gate
exists to report, and it is reporting it correctly.

The deeper cost is that portava-ci is no longer a clean baseline for anyone.
Every other lane's `CI (live DB)` run reads a database carrying tables,
policies and a widened `erase_memory_for_user` that only three unmerged
branches declare. A guard that passes there is passing against a schema no
merged commit describes.

### The two wrong closures, named so nobody reaches for them

* **Deleting the three rows.** The checker's own message says why: deleting a
  row makes the gate ask for a re-apply of something that already ran. It also
  destroys the only record of who applied what and when, while leaving the
  objects in place — the database would then be silently, rather than loudly,
  misrepresented.
* **Merging #456/#457, #470 or #472 to make the rows legitimate.** #470 says DO
  NOT MERGE on its face. Merging someone else's branch to tidy a ledger is the
  same class of act as applying it by hand in the first place.

### What is actually available

1. **The owners of those three branches merge them, or run the rollback their
   own ledger notes name** (`db/rollback/2026-09-07-ci-migrations-rollback.sql`)
   and delete the rows in the same transaction that removes the objects. Either
   ends the state honestly; the choice is theirs, not this lane's.
2. **The six unrecorded ones are being closed properly**, not back-filled:
   `2720`–`2723` are now idempotent (`DROP POLICY IF EXISTS` / `DROP CONSTRAINT
   IF EXISTS` before each create, the convention `2335` already used), so the
   sanctioned applier can re-assert them and write a real sha256 ledger row.
   `2724` and `2730` were already idempotent and needed no change. That is the
   difference between a row that says "this file ran" and a row that proves it.

### Not done here, deliberately

No row was written by hand, no row was deleted, and no branch was merged. §33 of
`census-trips.md` records the last time this lane back-filled ledger rows and
why those six carry `checksum='backfill'` rather than a hash; repeating that for
another six would trade a loud problem for a quiet one.

### Re-measured on merged `main` at `014a25d5` — this is now the ONLY thing red on main

`CI (live DB)` run `34430889373`, the push build of #481's squash:

```
✖  check:migration-ledger FAILED — this database does not represent this branch.
   3 ledger row(s) name a migration file that is not in src/migrations/.
     • 2311_intel_claim_reviews.sql              (applied_by=manual)
     • 2320_memory_episode_provenance_spine.sql  (applied_by=manual)
     • 2325_telegraph_unsend_before_seen.sql     (applied_by=manual)
   497 file(s) on disk, 500 ledger row(s) on hwokxgbmezheskbzskfr
```

`certify:migrations` fails at **stage 1**, so no later stage runs, `schema-drift`
fails, and `live DB · verdict` marks `live-db-security-suites` and
`post-media-revocation-rehearsal` as NOT EXECUTED. **Everything else in that job
passed**: `apply-migrations` had nothing to do (109 proven applied, 0 pending),
`audit:schema` reported *"Live schema contains every object claimed by the
migrations"* across 494 files and 5,748 objects, `check:media-objects` and
`audit:shadow-append-only` both passed.

**It is not the merge's doing, measured rather than assumed.**
`git diff --name-status 0edcb3eb 014a25d5 -- src/migrations/` is EMPTY — that
squash added and changed no migration at all — and all three rows are
`applied_by=manual`, written from branches that are still open. The count is
unchanged from the day this entry was opened.

### Why no pull request can catch this, which is worth knowing before the next green is believed

`db:apply-migrations` and `certify:migrations` are gated on
`github.ref == 'refs/heads/main'` (`live-db.yml:746` and `:757`). A PR's
`schema-drift` job runs the **dry run** and then skips both. So #481 was
truthfully 27 of 27 green and that green **never covered this gate** — the first
execution of `certify:migrations` against a change is the push build after it
merges. Any "fully certified" claim resting on PR checks alone is scoped
narrower than it sounds, and this is the gap.

### Still not done here, and the temptation is now stronger

Deleting three rows would turn `main` green in one commit. It would also erase
the only evidence that portava-ci ran schema no merged branch can show, which is
the entire finding. The closures in the section above are still the only honest
ones, and they belong to the owners of those branches.

---

## `CI_SUPABASE_TOKEN_401` — the sanctioned applier lost its credential mid-chain — **CLOSED 2026-09-10**

**Opened 2026-09-09 15:46 UTC.** Type: `EXTERNAL`. Owner: repository admin.
Buildable now? **No** — nothing in this repository can fix it, and no code change
is involved.

### The measurement

`SUPABASE_PROJECT_TOKEN` stopped being accepted by the Supabase Management API
between 14:45 and 15:20 UTC. Three runs, same secret, same project ref:

| Run (main) | Time (UTC) | First Management API call | Result |
|---|---|---|---|
| `34365037936` (`d9ee61b2`) | 14:41–14:45 | ledger read | OK — **46 migrations applied** |
| `34369375440` attempt 1 (`8d5b9e99`) | 15:22 | ledger read | **401 Unauthorized** |
| `34369375440` attempt 2 (re-run of failed jobs) | 15:37 | ledger read | **401 Unauthorized** |

Every DB-touching step fails identically — `db:apply-migrations:dry-run`,
`db:apply-migrations`, `check:migration-ledger`, `audit:schema`,
`check:media-objects`, `audit:shadow-append-only` — and each fails on its FIRST
call, before any query. `apply-migrations` refuses rather than guessing, and
says so in its own words:

> This is NOT the not-yet-bootstrapped case (that reports 42P01). The ledger is
> what makes this script idempotent and what makes an apply RECORDED, and we
> cannot currently read it — so we cannot say what has been applied. Refusing
> rather than guessing.

### It is the credential, not the project and not the code

* The project is **up**: an independent read path (Supabase MCP, different
  credential) queried `hwokxgbmezheskbzskfr` successfully at 15:46 and returned
  `schema_migration_ledger` = 479 rows, 69 of them `applied_by='ci'`, latest
  apply `2026-09-09 14:44:55`.
* The failure is `401`, not `429`. Throttling would not present as
  Unauthorized, and would not have let 46 consecutive applies through half an
  hour earlier and then refuse the first call twice.
* The re-run was a *re-run of the same jobs*, so the workflow, the code and the
  ref were byte-identical between the run that worked and the two that did not.

### What it blocks

The remaining **20 migrations**, which are all of Trips v4 from `2724` onward:
`2724`, `2730`, `2740`, `2741`, `2764`, `2765`, `2766`, `2768`, `2769`, `2770`,
`2771`, `2772`, `2773`, `2774`, `2775`, `2776`, `2777`. Nothing downstream of
those can be certified either — the §5 vertical slices, the feasibility and
governance proofs, and the whole live-DB verdict.

The 46 that DID land are intact and recorded (real sha256, `applied_by='ci'`).

### The exact action — CORRECTED 2026-09-09 16:55, the first version named the wrong place

**The value these jobs read is an ENVIRONMENT secret, not a repository secret.**

All four database-touching jobs in `live-db.yml` declare, at job level:

```yaml
    environment: ci-nonprod-supabase
    env:
      SUPABASE_PROJECT_TOKEN: ${{ secrets.SUPABASE_PROJECT_TOKEN }}
```

`api-server-check-all` (line 352), `schema-drift` (609),
`post-media-revocation-rehearsal` (860) and `live-db-security-suites` (1034).
Inside a job that names an `environment:`, GitHub resolves `secrets.X` as
**environment secret → repository secret → organization secret**, so an
environment secret of that name in `ci-nonprod-supabase` SHADOWS the repository
one. Rotating the repository secret changes nothing for these jobs.

That is consistent with every symptom: the "required secrets must be non-empty"
preflight passes (the stale environment secret is non-empty) and the first
Management API call is refused (it is the old token).

So the action is:

**Settings → Environments → `ci-nonprod-supabase` → Environment secrets →
`SUPABASE_PROJECT_TOKEN`**, set to a current Supabase **personal access token**
(`sbp_…`, from Account → Access Tokens) belonging to an account with access to
the organisation that owns `hwokxgbmezheskbzskfr`. Then re-run `CI (live DB)` on
`main` (it carries `workflow_dispatch`).

It must be a PAT, not a project API key: the endpoint is
`https://api.supabase.com/v1/projects/{ref}/database/query` with
`Authorization: Bearer`, which does not accept the `service_role` or `anon` JWT.
The repo stores a `SUPABASE_SERVICE_ROLE_KEY` secret too, which makes that
substitution an easy one to make by accident.

Nothing else is required: the two defects that stopped the applier before this
are fixed and merged (#477, #478), and the chain resumes at `2724` on its own.

**Evidence that the first remedy was tried and did not work.** Two runs were
dispatched on `main` after the repository secret was rotated —
`34377989819` (16:38) and `34378675033` (16:45) — and both returned
`401 Unauthorized` on the first Management API call, exactly as the two before
the rotation did. Five consecutive 401s across four runs, 15:22 to 16:48.

### Not done here, deliberately

No migration was hand-applied to work around the outage. That is the mechanism
`CI_DB_HAND_APPLIED_FROM_UNMERGED_BRANCHES` above exists to record, and doing it
again to route around an expired token would be the same mistake with a better
excuse.

### CLOSED — the credential works, measured rather than assumed

`SUPABASE_PROJECT_TOKEN` on the `ci-nonprod-supabase` **environment** — not the
repository secret the first remedy rotated — was replaced with a scoped Supabase
personal access token for portava-ci carrying Database and Migrations read-write.

**The evidence is a green job that cannot pass without it**, not a statement that
the secret was changed. On `ed168ed7`,
`schema drift · apply migrations, certify, then audit vs live (needs
credentials)` **succeeded**, and so did `live DB · RLS + role/is_official write
boundaries` and `api-server · check:all + live_pulse gate`. Each opens with a
Management API call against `hwokxgbmezheskbzskfr`; a 401 fails the job at that
first call, which is exactly how the five failures above presented. 27 of 27
check runs pass on that commit.

No migration was hand-applied at any point, before or after. The chain resumed
through the sanctioned applier.

---

## `TRIP_KERNEL_CREATE_TRIP_UNGUARDED_INSERT` — a malformed command reported as an outage

**Opened 2026-09-09.** Type: `CODE`. Owner: Trips. Buildable now? **Yes**, and
deliberately not built in the change that found it — see "Why it is open" below.

### The measurement

Executed against portava-ci inside a rolled-back transaction, through the real
`public.trip_kernel_execute` (`md5(prosrc) 5fd683a4…`, 103,400 chars):

```
CREATE_TRIP  payload {"title":"S"}          -- no destination_city
->  ERROR: 23502 null value in column "destination_city" of relation "trips"
    CONTEXT: PL/pgSQL function trip_kernel_execute(jsonb) line 165
```

The exception escapes the function. Every other command family wraps its INSERT:
2764's `ADD_STAGE` catches `check_violation` and `unique_violation` and returns
`TRIP_COMMAND_MALFORMED` with the constraint name. The trip family is older
(2450) and its `INSERT INTO public.trips` is unguarded — the only `BEGIN …
EXCEPTION` on that branch wraps the `owner_id` and date parsing above it.

### Why it matters, and exactly how much

`POST /trips` supports drafts. Its own comment says *"Trips without title/city are
saved as drafts"*, `computeTripStatus` is called with `destinationCity ?? null`,
and the command payload then carries `destination_city: destinationCity`
verbatim. So the payload above is not contrived: it is what the route sends for
a draft.

`executeTripCommand` sees a thrown RPC and returns `TRIP_KERNEL_UNAVAILABLE`,
whose meaning is *"the kernel could not be reached, try again"*. **A permanent,
malformed command is reported as a transient outage**, so a client that retries
on `unavailable` retries something that can never succeed.

Bounded honestly: nothing is corrupted and no row is half-written — the
transaction aborts. It is also **not a regression the kernel introduced**: the
flag-off legacy path inserts the same NULL against the same NOT NULL and returns
`db_error`. The kernel path is not worse at writing. It is worse at explaining,
and `TRIP_COMMAND_MALFORMED` is the answer the contract already has for this.

### Why it is open rather than fixed

The fix is a new verified-transform migration against `trip_kernel_execute`
(read `pg_get_functiondef`, assert the anchor occurs exactly once, wrap the
INSERT, postcondition-check) — that is, it widens the migration set that the
Trips certification measured at census-trips §35. It invalidates nothing there:
the twelve-command slice, the §22.4 idempotency receipt, the version conflict
and the replay equality are all unaffected. So it is recorded and left for its
own change rather than folded into a certification pass.

### What would close it

A migration that wraps the trip family's INSERT the way 2764 wraps the stage
family's, plus a case in the live suite the finding below asks for, asserting
that a `CREATE_TRIP` with no `destination_city` returns
`TRIP_COMMAND_MALFORMED` rather than raising.

---

## `TRIPS_HAS_NO_LIVE_KERNEL_SUITE` — the largest object in the architecture has no executable guard — **CLOSED 2026-09-09**

**Opened 2026-09-09.** Type: `TEST_COVERAGE`. Owner: Trips. Buildable now?
**Yes.**

### The measurement

`public.trip_kernel_execute` is 103,400 characters of PL/pgSQL, the largest
single object in this architecture. The 49 `trip*.test.ts` suites — **993 tests,
0 skipped, all passing** — run against doubles and against the TypeScript
around the RPC. They are worth having, and none of them executes the function.

Memory has the FILE Trips lacks — `src/test/memoryKernelTransactionLive.test.ts`,
with a `test:memory-kernel-transaction` script — and **it is invoked by nothing
under `.github/`**. Measured 2026-09-09: `run-live-suite.sh` is called for 26
suites in `live-db.yml` and that is not one of them, and the file sits on
`scripts/UNREGISTERED_TESTS_ALLOWLIST.json`, so the curated `npm test` does not
run it either. It is a script a human can run, not a guard.

**This corrects the first version of this entry**, which said Memory's suite was
"registered … scored by `run-live-suite.sh`". It is registered as a package
script and scored by nobody. The correction makes the gap bigger, not smaller:
Trips has neither the file nor the script, and the one precedent for what to
build is itself not wired in. See `MEMORY_LIVE_KERNEL_SUITE_NEVER_RUNS` below.

### Why it matters

census-trips §35 certifies the kernel end to end — thirteen commands, idempotency,
version conflict, presence freshness, and replay determinism proven equal at a
cut point. All of it was executed by hand through the management API. **It is a
snapshot, not a guard**: nothing in CI turns red if the kernel changes underneath
it, and the document would go on reporting a green that no longer holds. That is
precisely the BUILT-versus-CERTIFIED distinction this census draws everywhere
else, pointed at the certification itself.

### What closed it, and what has not

**Closed 2026-09-09** by `src/test/tripKernelLive.test.ts` — `ciSupabaseGuard.mjs`
imported first, `executeTripCommand` driven through the §35 slice, registered as
`test:trip-kernel-live` AND invoked from `live-db.yml` through
`run-live-suite.sh`. The script alone would not have closed it: that is exactly
what Memory had, and Memory's never ran.

**The half that was not closed until CI ran it — now closed.** When this entry
was written the suite had never executed: no service-role credential existed in
the environment it was written in, so the PostgREST path
(`sc.rpc("trip_kernel_execute", …)` as `service_role`) was asserted rather than
measured, and the sentence above said so.

**It has since run. 12 of 12 pass**, green on its first CI invocation and on
every run since, most recently on `ed168ed7`. The PostgREST path is measured, not
asserted, and this entry is closed on both halves. The statement it replaced —
"the suite has never executed" — was true when written and stopped being true the
same day; it is corrected here rather than left to be quoted.

---

## `MEMORY_LIVE_KERNEL_SUITE_NEVER_RUNS` — a live suite that exists and is invoked by nothing — **CLOSED 2026-09-09**

**Opened 2026-09-09**, found while looking for the precedent to copy for Trips.
Type: `CI`. Owner: Memory. Buildable now? **Yes** — one line in `live-db.yml`.

### The measurement

`src/test/memoryKernelTransactionLive.test.ts` is 562 lines and asserts §17's
central claim — canonical mutation and outbox insert in ONE transaction —
against the real `public.memory_kernel_execute` rather than against
`memoryCommandKernelFake.ts`. Its own header explains why the fake cannot prove
it: "the fake rolls back because it was written to roll back".

It is reachable by exactly one route: `npm run test:memory-kernel-transaction`,
by hand. `.github/workflows/live-db.yml` calls `run-live-suite.sh` for 26 suites
and this is not one of them; `scripts/UNREGISTERED_TESTS_ALLOWLIST.json` lists
the file, so the curated `npm test` skips it too. Nothing in CI executes it.

### Why it matters

The reason `run-live-suite.sh` scores on OUTPUT (pass > 0 AND skipped == 0)
rather than exit code is that a live suite which quietly does nothing is worse
than none — it reports green while asserting zero. A live suite that is never
INVOKED is the same failure one level up, and it is invisible to that guard
because the guard only sees suites somebody remembered to list.

### What closed it, and what is left

**Closed 2026-09-09**: `live-db.yml` now calls
`run-live-suite.sh memory-kernel-transaction …`, in the same change that wired
the Trips one, because the two failures are the same failure.

### And it found something on its first invocation

Run 34399941789, the first time any workflow ran this file:
`tests=17 pass=16 fail=1`, on
*"CONCURRENT commands sharing one key produce at most ONE domain effect"* —
`expected create + exactly one update event, got 1`.

**The defect is in the test, and the mechanism is worth writing down.**
`createMemory(label)` issues CREATE_MEMORY with `key(label)`, and that case
called `createMemory("idem-race")` and then raced eight UPDATE_MEMORY commands
on `key("idem-race")` — **the same key**. The create had already consumed it, so
all eight racers were refused `MEMORY_IDEMPOTENCY_KEY_REUSED`, which is exactly
the behaviour the test one line above pins. The two neighbouring cases use
distinct labels (`idem` / `idem-1`, `idem-reuse` / `idem-2`); this one did not.

What makes it worth a ledger entry rather than a one-line fix note is HOW it
passed for so long: `receipts.length === 1` and `accepted.length === 1` were
satisfied by the CREATE's own receipt and its own audit row. Two of the three
assertions were true by coincidence, and only the third — the event count —
could tell. A test asserting a race, never executed, with two assertions that
pass on the wrong evidence, is the strongest possible argument for the wiring
this entry exists to add. Fixed by giving the setup its own label; every other
label in the file was checked for the same collision and there is none.

**Left open as a separate ask**, and not built here: nothing PREVENTS the next
inert live suite. `assert-ci-scripts.mjs` verifies that every script CI invokes
exists; the inverse — that every live-shaped script in `package.json` is either
invoked by a workflow or carries a written reason — is the closed-set discipline
`check:guard-coverage` already applies to Supabase-reaching files, and it does
not exist for test scripts. Until it does, this entry closed one instance by
hand.

---

## `CENSUS_HEAD_COMMITS_UNREACHABLE_IN_CI` — six declarations that can only be checked on the machine that wrote them — **CLOSED 2026-09-10**

**Opened 2026-09-09.** Type: `CI`. Owner: shared — six censuses across five
lanes. Buildable now? **Yes, but not by one lane alone**; see "Why this is not
fixed here".

### The measurement

`check:census-freshness` fails inside `api-server-check-all` with six errors of
one shape:

```
fatal: Invalid revision range 7bca4b0d0e19d29ea0a96982f74b35d26402fa52..575ceb45
##[error]census-trust.md: git could not diff 7bca4b0d..HEAD — the declared
         head_commit may not exist in this clone.
```

…for `census-discovery`, `census-highlights-memories`, `census-layover`,
`census-trips`, `census-trust` and `census-wall` — **every checkable census
there is**. Measured locally: not one of the six declared commits is an ancestor
of `origin/main`, and `git branch -r --contains` returns nothing for any of them.
They are pre-squash working-tree commits. This repository squash-merges, so the
commit a census was measured at stops existing the moment its branch lands.

**The guard therefore cannot be green in CI, and has been passing locally for a
reason that is not a property of the repository**: this container's object store
still holds those commits from the branch work that produced them. A fresh clone
— which is what CI has, `fetch-depth: 0` and all, since the objects are on no
ref — cannot resolve any of them.

That is worse than a red check. `check:guard-reachability` prints
`checkCensusFreshness.ts  inspected  (not read — the guard is currently FAILING,
exit 1)`, so the one guard that would notice already knows and says so in
passing.

### Which of the six can be re-declared without lying, measured

All six last landed on main in the same squash, `42aeac38` (#476). Whether
moving a declaration there is honest is not a judgement — it is
`git diff --name-only <old> 42aeac38 -- <that census's scope>`, which says
whether the census aged in between:

| census | scoped paths | changed `old..42aeac38` | verdict |
| --- | ---: | ---: | --- |
| census-trips | 35 | **0** | provably neutral — **re-declared** |
| census-trust | 15 | **0** | provably neutral — **re-declared** |
| census-discovery | 10 | **0** | provably neutral — one line, not this lane's to take |
| census-highlights-memories | 10 | 4 | **not neutral** — see below |
| census-layover | 5 | 1 | **not neutral** — see below |
| census-wall | 7 | 1 | **not neutral** — see below |

`census-trips`, `census-trust` and `census-discovery` now declare `42aeac38`.

**Confirmed in CI, not just rehearsed.** On `2d25ead2`, `check:census-freshness`
reported `census-trips.md FRESH at 42aeac38 (0 counted files changed)` and the
same for `census-trust.md` — the first time either has been checkable anywhere
but a developer's clone — and the run went from **6 problems to 4**.

**Correcting a count stated earlier in this session:** four, not three, remained
at that point. The three that carry acknowledgements are the ones needing a
lane's judgement, but `census-discovery` was still failing alongside them for the
unreachable-commit reason alone. It is re-declared here on the same measured
grounds (0 scoped files changed), by the Trips lane rather than Discovery's,
because that neutrality is a fact rather than a call about Discovery's verdicts;
its own declaration row says so and invites a revert. **Three remain.**

### Why the other three are NOT re-declared

Those three carry live entries in `CENSUS_STALENESS_ACKNOWLEDGED.json`, and the
files their acknowledgements name changed BEFORE `42aeac38` — so moving the
declaration forward folds an acknowledged staleness into a measurement nobody
took. The guard refuses it rather than letting it pass, which is the right
answer:

```
::error::CENSUS_STALENESS_ACKNOWLEDGED for census-wall.md names since=9f8122ff,
         but that census now declares head_commit 42aeac38. The census was
         re-measured; the acknowledgement is spent. Delete it.
```

Deleting the acknowledgement to satisfy that message would be laundering. What
those three need is their lane's judgement: re-measure at `42aeac38` and let the
acknowledgement go because it is genuinely spent, or accept STALE, which is true.

### What would close it

The three above, by their owners, plus `census-discovery`'s one line. And so the
next one cannot happen silently, a rule in `checkCensusFreshness.ts` that a
declared `head_commit` must be an ANCESTOR of the default branch: an unreachable
declaration should fail as MALFORMED, the way `censusHeadCommit.ts` already fails
a botched row, rather than as "git could not diff" — a distinction that matters
because the first names the defect and the second reads like a clone problem.

### CLOSED 2026-09-10 — all six re-declared, and the guard now catches the next one locally

**Reproduced first, so the fix was aimed at a measurement rather than a
hypothesis.** A fresh `git clone --single-branch` of this branch — which is what
CI has — does not carry `cdfff599`, `743ae78f` or `9f8122ff` at all, and
`check:census-freshness` in that clone printed exactly the three errors the PR
was red on, against a clean pass in the working container. That is the whole of
the two failing check runs.

**The delta was re-measured, which is the thing the entry above said those three
needed.** The choice it named was "re-measure at `42aeac38` and let the
acknowledgement go because it is genuinely spent, or accept STALE". The first
was taken, and the work it takes is bounded and was done: six counted files
changed across the three censuses, each re-verified mechanically over
`<original>..42aeac38`:

| census | counted file(s) changed | what the re-verification found |
| --- | --- | --- |
| highlights-memories | `lib/memoryOutbox.ts` | 48 insertions, **0** lines surviving a not-comment-not-blank filter |
| highlights-memories | `memoryProjections/derivativeRegistry.ts` + `derivativeRegistryRead.ts` | a split: **identical 18-symbol export set** at both commits, **0** non-comment differing lines in the retained half, and the moved `readRegisteredPayload` inlines the body of the `readRegistration` it used to call — same table, columns, filters and error mapping |
| highlights-memories | `memoryRetrieval/searchMemories.ts` | **one** changed line, an import path |
| layover | `services/airport/LayoverPrivacyGuard.ts` | 7 insertions / 4 deletions, **0** surviving the same filter |
| wall | `wall/…/WallPromotionDisclosure.component.test.tsx` | 4 insertions / 3 deletions, **0** surviving the same filter |

**What that does and does not license, stated rather than implied.** It licenses
the freshness claim and nothing wider: no counted file changed behaviour between
where each census was measured and `42aeac38`, so no verdict can have moved. It
is NOT a re-reading of those censuses against the code — `check:census-freshness`
never was that, and §"DOES NOT COVER" in the script says so. Each of the three
declaration rows says this in the document itself, names the changed files, and
invites the owning lane to revert.

**The acknowledgements are retired, not deleted.** Moving `head_commit` makes
them spent by the checker's own rule, and deleting them to silence that message
is the laundering the entry above refused. They now sit in a `retired` array in
`CENSUS_STALENESS_ACKNOWLEDGED.json` that nothing reads, because the per-file
argument is the only thing that makes the re-declaration defensible and it should
outlive the entry that carried it.

**The recurrence guard, which is the half that matters.** `checkCensusFreshness.ts`
now rejects a declared `head_commit` that does not resolve, and separately one
that resolves but is **not an ancestor of HEAD** — the orphan case, which is what
all six of these were. Ancestor-of-HEAD rather than ancestor-of-the-default-branch
on purpose: a census measured on a branch and declared at that branch's commit is
legitimate and must keep working. Mutation-tested both ways on 2026-09-10:
declaring `cdfff599` (present in this container, on no line of history) is caught
as an orphan, and declaring a hash that exists nowhere is caught as unreachable —
each with an error that names the defect instead of the previous
`git could not diff`, which read like a checkout problem. The failure mode this
blocker is made of — green locally, red in CI — is now red in both.
