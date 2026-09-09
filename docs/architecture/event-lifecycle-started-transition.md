# Event lifecycle — the transition into `started`

**Measured 2026-09-07** on production (`ajrurzioarfkagpuxfnb`, read-only) and
rehearsed on portava-ci (`hwokxgbmezheskbzskfr`) inside transactions that ended
in `ROLLBACK`. Nothing in this lane applied anything to either database.

Companion code: `artifacts/api-server/src/lib/eventLifecycle.ts`,
`src/test/eventLifecycle.test.ts`, migration `2600_event_start_transition_flag.sql`,
rollback `db/rollback/2026-09-07-2600-event-start-transition-flag-rollback.sql`.

---

## 0. The owner decision this lane does NOT take — `EVENT_START_TRANSITION`

`events.state` has a `started` member, three routes require it, and nothing has
ever written it. Two designs close the gap and they are different products:

| | (a) **derived** | (b) **host-initiated** |
|---|---|---|
| Rule | `started` once `now() >= starts_at` | the host presses "start" |
| Event nobody showed up to | becomes `started` anyway; host can still complete or cancel it | never `started`; stays `open` forever |
| Host forgets | nothing is blocked | the event can never be completed; no-shows can never be marked; the host's `event_hosted` and attendees' `event_attended` never accrue |
| Who acts | a scheduler, uniformly | 3 hosts today, each event individually |
| Reversible | flag OFF stops further transitions; rows already moved stay (audit row per row) | a route can be removed; nothing already moved |

**What ships:** (a), behind `event_start_transition_enabled`, **seeded FALSE by
2600**, so the running system is byte-for-byte unchanged until an owner flips
it. **What does not ship:** (b), and any auto-`completed` after `ends_at` (§4).
The transition rule is a pure function (`decideEventStart`) so (b) is a caller
of the same rule, not a rework.

**The decision to record:** *Should an event become `started` because its start
time has passed (a), or only because its host said so (b), or both (b as a
manual override on top of a)?* Flipping the flag chooses (a). Not flipping it
leaves production as it is today: **no event can ever be completed through the
API** (§1).

---

## 1. The defect, measured — and how the 7 `completed` events got there

| state | count | past `starts_at` | `starts_at` NULL | `ends_at` NULL | past `ends_at` |
|---|---|---|---|---|---|
| `open` | 97 | 96 | **1** | **3** | 94 |
| `completed` | 7 | 7 | 0 | 0 | 7 |
| `started` | **0** | — | — | — | — |

- Of the 96 past-start `open` events: **2** are inside their window right now,
  **3 distinct hosts**, **16 `going` RSVPs** on them, **0** `event_attendee_states` rows.
- `event_activity_log` has **zero rows for any event on production.** No event
  there has ever passed through a transitioning route (`logEventActivity` writes
  one row per publish/cancel/postpone/complete/archive).
- `pg_trigger` on `public.events`: none (non-internal). No `public` function
  `UPDATE public.events SET …`. `pg_cron` not installed. So there is no
  database-side writer either.

**The 7 `completed` rows were inserted as `completed`, never transitioned.**
Every one has `created_at == updated_at` to the microsecond, no activity row, a
version-5 (deterministic) UUID, creation timestamps exactly two days apart at
the identical clock second `14:03:16.91`, and `starts_at` = creation + 0…6 days.
That is `artifacts/api-server/src/scripts/seed-demo-profile.ts` `seedEvents()`:

```ts
const isPast = i < 7;
…
const state = isPast ? "completed" : isSoon ? "open" : "open";   // :639
const createdAt = isPast ? dateDaysAgo(20 + i * 2) : dateDaysAgo(2);
```

`i < 7` → exactly seven `completed` rows, ids `uuidv5("event:<profileId>:<i>", SEED_NS)`.
They are demo fixtures. **They are not evidence that completion works.**

### The second writer — a defect in its own right, reported not changed

`PATCH /events/:id` (`routes/events.ts:2235`) accepts `state` from the body
(`UpdateEventSchema`, `:602`, enum `draft|open|started|completed|cancelled|archived`)
and writes it **with no transition guard** (`:2288`, `patch.state = b.state`).
It is host-only (SEC-04, `:2255`). Through it a host can today:

- write `started` directly — so the brief's "no `update({ state: "started" })` in
  any file" is literally true and materially misleading; the census in
  `trust-unproduced-vocabulary.md` §5.3 ("no writer of `state='started'` exists")
  missed this path too;
- write `completed` directly, **bypassing** `POST /complete`'s trust events,
  stamps and review pushes (only the PATCH-side review-prompt push at `:2332`
  fires), and bypassing the `started` gate entirely;
- write `open` from `cancelled`/`archived`/`completed` (reopen), or `draft` from
  anything, without the postpone/cancel notifications.

No client in the repository sends it (`artifacts/` holds only api-server and
mockup-sandbox; the top-level app has no `/events` caller), and production's
empty activity log says nobody has. **Recommendation, for the Events owner:**
narrow the PATCH `state` enum to the states that have no dedicated route
(`draft`, `open`), or route it through `decideEventStart` / the dedicated
routes. Not done here: it changes an accepted API surface, which is a contract
decision, and it is orthogonal to the missing transition.

---

## 2. The rule, and why it is derived from repo truth rather than invented

```
from ∈ {open, full, waitlist}  ∧  starts_at IS NOT NULL  ∧  starts_at ≤ now   ⇒  started
```

| Clause | Where the repo already says it |
|---|---|
| `open / full / waitlist` are one phase | `recomputeEventState` (`routes/events.ts` ~`:380-404`) cycles an event among exactly these three by capacity and waitlist offers; nothing else enters or leaves that cycle. |
| …and that phase is "published, live, not yet begun" | migration `2033_rls_hardening.sql:269` `state IN ('open','full','waitlist','started','completed')`; `EventPassportService.ts:68` and `PassportProjectionService.ts:1300` `LIVE_EVENT_STATES = {open, full, waitlist, started}`; `BROWSE_STATES` `routes/events.ts:221`. In every one of these, `started` is the only "live" member that is *after* the start. |
| `started` means "during the event" | the complete route's own message: *"it must be active (started) first"* (`:4565`); the attendance and no-show gates: *"during or after the event"* (`:3491`, `:3552`). |
| `starts_at` is when "during" begins | it is the only start-time column on `events`; the create route already derives `open` vs `draft` from `publishNow`, not from time — there is no other clock. |
| NULL `starts_at` never starts | nullable column; 1 open production event has NULL. A start with no time is not due. |
| `draft`, `cancelled`, `archived`, `completed`, `started` never move | `draft` is what postpone writes (`:4520`); cancel/archive are terminal in every gate (`:4512`); `completed` is the end of the line; re-writing `started` would be a second audit row for one fact. |
| The UPDATE re-asserts `state IN (startable)` | a cancel that lands between the read and the write must win; the fake races it in the test and CI's second pass changed 0 rows. |
| `ends_at` is **not** consulted | §4 — that is the same owner decision's second half. |

The PostgREST read mirrors the rule (`in state`, `not starts_at is null`,
`lte starts_at now`) so the batch is the due set, but the rule is still applied
per row: the rule is the authority any future caller shares, the query is an
optimisation. A row the query returns that the rule refuses is counted
`refused`, never started (pinned).

---

## 3. What flipping the flag makes reachable — behaviour change, stated

`trust_engine_enabled` is **TRUE** on production. `trust_events` holds 5 rows
today (4 `pulse_post_created`, 1 `first_event_joined`). Once an event is
`started`, three routes that have never succeeded on production can:

| Route | Gate | What it emits once reachable | Owner of the emitter |
|---|---|---|---|
| `POST /events/:id/complete` (`:4564`) | `state === 'started'` | host **+5 `event_hosted`** (host_quality); each checked-in attendee **+5 `event_attended`** (plan_attendance); `event_host` / `event_participant` **stamps** via `StampAwardEngine.awardStamp`; review-prompt pushes; `passport.stamp_earned` notifications | Events emits; Trust/Passport adjudicate |
| `POST /events/:id/noshow/:userId` (`:3552`) | `state IN (started, completed)` | attendee **−5 `event_no_show`** (moderate, 48 h dedup) — the emitter `trust-unproduced-vocabulary.md` row 2 records as **unreachable**. It becomes reachable. The census's open items on it (declared name `event_attendee_no_show`, severity `minor`, 365 d dedup, 2540's index list, the appeal that does not reverse it) are **now live questions, not latent ones**. | Events emits; Trust owns the vocabulary |
| `POST /events/:id/attendance/:userId` (`:3491`) | `state IN (started, completed)` | `event_attendance_confirmed` bookkeeping in `event_attendee_states` | Events |
| cancel of a `started` event | `EVENT_HOST_CANCEL_TRIGGER_STATES = ["open","started"]` (`TrustEventService.ts:612`) | **no new behaviour**: `open` was already a trigger state; a host cancelling after the start is charged exactly as one cancelling before it | Trust |
| `pulse.ts:1224,1271,1757`, passport `LIVE_EVENT_STATES`, `BROWSE_STATES` | `open` and `started` both included | **no visible change**: every reader already treats them alike | — |

Trust files were not edited. **First enabled pass on production as measured:
96 events → `started`, 3 hosts, 16 going RSVPs.** After that, each of the three
hosts can complete their events at will and each completion is +5 to them.

---

## 4. The `completed` transition is equally missing — not built

Nothing auto-completes an event after `ends_at`; nothing in the tree assumes it
does (the only "auto-complete" in `src/lib` is Rent-a-Buddy's booking sweeper).
94 of the 97 open events are past `ends_at`; 3 have no `ends_at` at all. Under
(a) they become `started` and stay there until a host completes, cancels or
archives them. Whether they should instead auto-complete (and with what effect —
`POST /complete`'s trust and stamp awards, or none) is the second half of
`EVENT_START_TRANSITION` and is **recorded, not decided**. The scheduler
deliberately reads `ends_at` nowhere so that adding that step later is one more
rule in `eventLifecycle.ts`, not a change to this one.

---

## 5. What was built

- `lib/eventLifecycle.ts` — `decideEventStart` (pure), `runEventStartPass`
  (flag → read → rule per row → conditional UPDATE → audit row), scheduler
  (2 min startup, 60 s interval, house shape). Every supabase result's `.error`
  is checked; a failed due-events read is `reason: "error"`, never an empty
  pass. Each transition writes `event_activity_log (action='started',
  actor_id NULL, metadata.source/from_state/starts_at/at)` — the audit trail the
  seeded rows lack.
- `routes/events.ts` — one hunk: the complete route's UPDATE `.error` is checked
  (previously a failed write returned `{ok:true}` and fired trust events, stamps
  and pushes for a completion that had not happened).
- `index.ts` — one import, one call, after `startEventWaitlistSweeper()`.
- `2600` — seeds the flag FALSE; preconditions (`feature_flags`, `events`,
  enum has `started`, `starts_at`, `event_activity_log`); postcondition raises a
  NOTICE with the number of rows a flip would move on that database.

### Proof (node:test, judged by exit code)

`SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test src/test/eventLifecycle.test.ts`
→ **24 tests, `# fail 0`, EXIT 0.** Hand-reverts, each restoring the file afterwards:

| # | Guard broken | `# fail` |
|---|---|---|
| R1 | rule admits `completed` into the startable set | 5 |
| R2 | flag gate removed | 4 (FALSE, absent, error, throw) |
| R3 | due-events read `.error` unchecked | 1 |
| R4 | UPDATE no longer conditional on `state IN (startable)` | 1 (the race) |
| R5 | UPDATE `.error` unchecked | 1 |
| R6 | NULL `starts_at` treated as due | 1 |
| R7 | due comparison off by one (`>=`) | 1 |
| R8 | audit row not written | 5 |
| R9 | complete route UPDATE `.error` unchecked (`events.ts`) | 1 |
| R10 | complete route gate widened to `open` (`events.ts`) | 1 |
| R11 | 2600 seeds TRUE | 1 |
| — | restored | **0** (24/24) |

CI rehearsal (rolled back, both rounds): 10 fixture rows, one per state plus
`open`+NULL start and `open`+future start; the scheduler's exact UPDATE changed
**3** (`open`, `full`, `waitlist`), the second pass **0**, the other seven kept
their state, and after `ROLLBACK` 0 flag rows / 0 fixture rows persisted.

---

## 6. 2600 disposition

| Mig | Prod marker | CI marker | Dependency | Status | Reason |
|---|---|---|---|---|---|
| 2600 | `feature_flags.flag = 'event_start_transition_enabled'` — absent | absent | `0037` (feature_flags), `event_state` enum with `started` (present both) | `ready_for_manual_apply` | One seed row, FALSE. Applying changes nothing observable; **flipping** is `EVENT_START_TRANSITION`. Rehearsed on CI in a rolled-back transaction, preconditions all pass on CI; production has every precondition object. |

Suggested ledger row for `migration-disposition-ledger.md` (not edited here —
shared file).

---

## 7. What in the brief turned out wrong or incomplete

1. "`no update({ state: "started" })` in any file" — true of the literal, but
   `PATCH /events/:id` writes any enum value from the body, `started` and
   `completed` included, unguarded (§1). The brief's `:602` "settable enum" *is*
   the second writer; it is not merely a consumer.
2. The 7 `completed` events are seed fixtures, not a hidden completion path.
3. "Is `starts_at` reliably non-null?" — **no**: 1 of 97 open events. `ends_at`:
   3 NULL. The rule requires a non-null start; `ends_at` is unused.
4. `full` and `waitlist` are real enum members on both databases and real
   states in code (`recomputeEventState`), but the PATCH enum at `:602` omits
   them and the brief listed the enum as six members. The startable set is
   three states, not one.
5. The trust census's "no writer of `state='started'` exists" (`trust-unproduced-vocabulary.md`
   §5.3, row 2) has the same gap as item 1.
6. `check:test-registration` reports `src/test/eventLifecycle.test.ts` (and a
   sibling's `trustStampVerified.test.ts`) unregistered — `package.json` is the
   coordinator's; registration is requested, not done.
