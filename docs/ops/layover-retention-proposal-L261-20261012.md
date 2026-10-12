# Layover retention: proposal for L261 (OD-1012-LAY-3)

**Status: PROPOSAL. The owner has not approved it.** Written 2026-10-12 by wave W, lane `lay-retention`, from `origin/main`
`9ded8e9cd`. Nothing was built, applied, flipped or deleted to write it. No migration, flag or code changed. census-layover
L261 stays `N` (see census-layover §67).

The owner's instruction, verbatim (OD-1012-LAY-3, `docs/ops/owner-decisions-20261012.md`):

> Propose an explicit L261 retention policy covering snapshot contents, deletion, saved records and minimized audit
> evidence. Do not borrow another feature's retention period.

The register's Part 2 adds: *"Neither OD-TRIP-4's 30 days nor OD-MAP-4's 12-month audit period may be borrowed."*

**No period here is borrowed.** Each period below comes from a layover fact (how long a layover lasts, when a missed
connection is known, what each table is read for). Three periods already in the code were borrowed, or match another
feature's number. §1.3 lists them, and this proposal would replace all three.

---

## 0. The decision, on one page

Every clock below starts at **layover end (E)**. E is the session's `departure_time` as last certified. A replan moves the
departure, so E moves with it. E is not when the traveller ended the session, and not when the expiry sweep ran.

| Data | Recommended period | Options for the owner |
| --- | --- | --- |
| Live operational data: presence, crews, checkpoints, scheduled alerts | Deleted when its own `expires_at` passes, with no grace period. | none. The read path already hides the row at that point. |
| **Snapshot contents, full detail.** Every certified record plus its time budget, return plan and constraints. | Kept until **E + 48 h**. | A: E + 24 h · **B: E + 48 h** · C: E + 7 d |
| **Snapshot contents, minimised.** One record per layover. | Kept until **E + 21 d**, then deleted. | A: E + 14 d · **B: E + 21 d** · C: E + 45 d |
| Session row, plan stops, recommendations, outcome | Deleted at **E + 21 d**, together with the minimised snapshot. One cascade. | Follows the snapshot option. |
| **Minimised audit evidence** (`layover_events`) | Named until **E + 48 h**. Then pseudonymised, with an allow-list of fields. Deleted at **E + 60 d**. A named incident hold can extend specific rows. | A: E + 21 d · **B: E + 60 d** · C: E + 120 d |
| **User deletes one layover** (no such action exists today) | Session and snapshots erased immediately. Its audit events minimised immediately, on the same E + 60 d clock. | A: **minimise** · B: delete the events as well |
| **Account deletion** | As for one layover, for every session. Replaces today's 365-day `retain_until`. | Same options as above |
| **Saved records**: stamp, Memory, postcard, trip timeline row | Kept until the user deletes them, under that feature's own rules. They never depend on the session row surviving. | A: **only these four** · B: also add a "keep this layover" summary |
| Device caches (deadline, plan, alert ids) | Removed at E + 48 h on the next app open, and on sign-out. | none |
| Community airport observations (no user link) | Raw rows deleted at `expires_at` + 48 h. A k-anonymous hourly aggregate may stay. | A: **+48 h** · B: delete at `expires_at` |
| External flight/airport events | Deleted 48 h after `processed_at`. If never processed, 48 h after `received_at`. | none |

The questions that are genuinely the owner's are listed in §5.

---

## 1. What exists today (measured on `origin/main` `9ded8e9cd`)

"In production" means listed in `artifacts/api-server/src/lib/capability/production-applied-migrations.json`. 0127 belongs to
the pre-cutover baseline. 2741, 2860, 2982, 2984 and 2985 are in the manifest. 2700, 2992, 3466, 3620–3624 and 3900 are not.

### 1.1 Inventory

| Store (migration) | What it holds, especially location or precise data | Who can read it | What ends it today | Account deletion | Personal? |
| --- | --- | --- | --- | --- | --- |
| `layover_sessions` (0127; in production) | Arrival, departure and boarding instants at a named airport, plus trip id, manual city/country/IATA, bags, lounge, comfort, vibe chips, `return_reminder_at` and `share_city_status`. This is an **itinerary**: where the traveller was, to the minute. | The owner, through the API (0127 owner policy). The service role. | **Nothing.** `expireOldSessions` only sets `status='expired'` (`artifacts/api-server/src/services/airport/LayoverSessionService.ts:567#export async function expireOldSessions(`). `DELETE /airport/sessions/:id` *ends* a session and erases nothing (`artifacts/api-server/src/routes/airport.ts:4001#router.delete("/airport/sessions/:id"`). | Deleted (`artifacts/api-server/src/services/accountDeletion/AccountDeletionService.ts:1432#"delete_layover_sessions"`). | Yes |
| `layover_plan_stops` (0127; in production) | Stop title, duration and **venue lat/lng** (`artifacts/api-server/src/migrations/0127_layover_system.sql:164#lat`). The venue is reference data, but choosing it reveals where the traveller planned to go. | Owner, service role | The user removes a stop. Otherwise never. | Session cascade | Yes, linked to the session |
| `layover_recommendations` (0127; in production) | Card title, city, neighbourhood, location label, hard-return instant | Owner (read), service role | Deleted and re-inserted on regeneration. The last set lives forever. | Session cascade | Yes, linked |
| `layover_certified_computations`, i.e. the **snapshot** (2700 + 2992 + 3623; **not** in production) | `inputs` JSON holds the session instants, the airport, the plan probe title, and `entry.corridor.passportCountry`, which is **nationality** (`artifacts/api-server/src/services/airport/layoverEntryGate.ts:67#passportCountry`), plus declared constraints such as mobility profile. Also verdict, deadline, buffers, engine version, input hash, version. | The owner can SELECT their own rows (2700 policy). The service role. | Compaction (`artifacts/api-server/src/services/layover/LayoverDecisionService.ts:104#SNAPSHOT_RETENTION_POLICY`) behind `layover_snapshot_compaction_enabled`, which is seeded FALSE (`artifacts/api-server/src/migrations/3624_layover_snapshot_compaction_flag.sql:33#'layover_snapshot_compaction_enabled'`). The newest record per session is never compacted. | Session cascade | Yes, including nationality |
| `layover_time_budgets`, `layover_return_plans` (2992; not in production) | Per-snapshot minute terms, hard and recommended return instants | Service role only | Compacted with their parent, behind the same flag. UPDATE is blocked by trigger. DELETE is allowed on purpose (`artifacts/api-server/src/migrations/2992_layover_decision_record_and_operational_tables.sql:116#DELETE IS NOT BLOCKED`). | Session cascade | Yes, linked |
| `layover_constraints` (2992; not in production) | Terminals, immigration/customs, baggage mode, `entry_permission_state`, `mobility_profile`, and a `snapshot_id` TEXT. That id dangles once compaction runs (§61). | Service role only | **Nothing.** Compaction does not touch it. | Session cascade | Yes. Mobility can be health-adjacent. |
| `layover_checkpoints` (2992; not in production) | A place *kind* (SECURITY … BOARDING) and its observed time. No coordinates, by construction. | Service role only | Hidden by `expires_at` (departure + 6 h, `artifacts/api-server/src/services/layover/LayoverCheckpointStore.ts:68#CHECKPOINT_VISIBLE_AFTER_DEPARTURE_MIN`). **No job deletes it.** | Session cascade | Yes. It is a movement trace at place-kind level. |
| `layover_outcomes` (2992; not in production) | Boarded or missed, left the airport, actual return instant, comfort, free-text reason, `anonymization_state` | Service role only | **Nothing.** No code moves `anonymization_state` (`artifacts/api-server/src/migrations/2992_layover_decision_record_and_operational_tables.sql:718#anonymization_state`). | Session cascade | Yes |
| `layover_presence` (3900; not in production) | Intents, availability window, max travel minutes. `precise_location_enabled` is CHECK-forced FALSE (`artifacts/api-server/src/migrations/3900_layover_presence.sql:80#precise_location_enabled`). | Service role, through owner/aggregate reads | Hidden after `expires_at`. Deleted only when the user clears it (`artifacts/api-server/src/services/layover/LayoverPresenceStore.ts:153#export async function clearPresenceIntents(`). **No sweep.** | Session cascade | Yes |
| `layover_crews`, `layover_crew_members` (2984; in production) | City, airport, title, meeting-point label: who met whom, where, when | Members, through the service | **Deleted at expiry** by `layoverCrewExpiryScheduler` with no grace period (`artifacts/api-server/src/lib/layoverCrewExpiryScheduler.ts:300#const del = await db.from(CREW_TABLE)`). Expiry is the founder's hard return or the TTL, whichever is sooner (`artifacts/api-server/src/routes/airport.ts:3036#function crewExpiryFor(`). | Memberships deleted, then session cascade | Yes |
| `layover_events`, the **decision ledger** (0127 + 3621 + 3622; 3621/3622 not in production) | Event type plus metadata. Metadata can include the hard-return instant, reminder instant, city, crew title, Telegraph thread id, airport-observation value, stop ids. | The owner can SELECT named rows. A pseudonymised row is service-role only. | 3622: pseudonymise at **departure + 30 days**, behind a flag seeded FALSE. 3621: delete pseudonymised rows at `retain_until` = **+365 days** (`artifacts/api-server/src/lib/layoverAuditRetentionScheduler.ts:101#const del = await db.from("layover_events")`). Named rows that are never pseudonymised live forever. | Pseudonymised: user, session and metadata are emptied, `retain_until` + 365 d (`artifacts/api-server/src/lib/layoverEventPseudonymisation.ts:90#export function layoverEventPseudonymPatch(`) | Named rows: yes. Pseudonymised: pseudonymous. |
| `layover_event_pseudonymisation_dead_letters` (3622; not in production) | Session id, failure text, times | Service role | Cascade with the session | Session cascade | Indirectly |
| `airport_fact_observations` (2860 + 2982; in production) | Airport, fact type and value. `observer_id` is an HMAC over (user, airport), and a CHECK forbids a raw profile id (`artifacts/api-server/src/migrations/2860_layover_airport_truth_and_events.sql:205#airport_fact_observations_community_not_a_profile`). | Service role | Hidden after `expires_at` (TRAVELER_OBSERVATION class: 45 min). **No job deletes it.** | Not user-keyed, so it is outside the deletion denominator | Pseudonymous, and stable per airport |
| `layover_external_events` (2860; in production) | Flight/airport/mobility events. `subject_refs` and `payload` can name sessions and flights. | Service role | **Nothing.** | Not user-keyed | It can be, through `subject_refs` |
| `layover_place_dwell` (3466) | Curated per-venue minutes; `stated_by` is an admin | Service role | Admin delete | n/a | No. This is reference data, out of scope. |
| Return alerts (client) | Scheduled local-notification ids per session (`travel-buddy-standalone/src/components/layover/layoverReturnAlerts.ts:255#layover.returnAlerts.v1`) | The device | Removed when re-planned or cancelled | Not reached | Yes, on the device |
| Deadline and plan caches (client) | Certified deadline, plan stops, airport lat/lng, phrases (`travel-buddy-standalone/src/components/layover/layoverDeadlineCache.ts:52#layover.deadline.v1`, `travel-buddy-standalone/src/lib/layoverPlanCache.ts:66#layover.plan.v1`) | The device | **Nothing.** These keys are not in the sign-out wipe list (`travel-buddy-standalone/src/context/SessionContext.tsx:51#const PRIVATE_ASYNC_KEYS`). | Not reached | Yes, on the device |
| Server notifications | Templates `airport.layover_mode` / `traveler_nearby` / `lounge_tip` exist. **No emitter on main.** | none | none | none | none |
| Buddy/gate decisions | Computed per request (`LayoverBuddyGate`). **Nothing layover-specific is stored.** Bookings live in Rent-a-Buddy's own tables under its own rules. | none | none | none | none |
| **Saved records** (elective): Passport stamp, layover Memory, layover postcard, trip timeline mirror (`trip_plan_items`, `source_type='layover_session'`) | City and country only for stamp, Memory and postcard. The trip row carries the airport name plus a plain-TEXT `source_id` (no FK). | Owner, under each feature's visibility | The user deletes them, under each feature's rules | Each feature's own disposition | Yes, and the user chose to keep them |

### 1.2 What the inventory shows

1. **No layover is ever deleted except by account deletion.** Sessions, stops, recommendations, constraints, checkpoints,
   outcomes and presence rows outlive the layover indefinitely. An expired crew is the one exception.
2. **The traveller cannot delete a layover.** "End" is the only verb.
3. **Snapshot inputs carry nationality** (the entry corridor's passport country) and may carry a mobility profile. Once the
   layover is over, neither is needed to show the traveller what they were told.
4. **Snapshot immutability is mechanical.** UPDATE is blocked on the three 2992 snapshot-scoped tables, and the service
   asserts it for the parent. Minimisation must therefore write a separate minimised record and delete the full one. Rewriting
   in place would weaken a guard (§4).
5. **A pseudonymised ledger row keeps almost nothing.** Today's patch empties metadata entirely. It shows that "something
   happened" and cannot show *what the engine said*. That is too little to be safety evidence, so the minimisation
   needs an allow-list (§3.4), not an empty object.
6. **Device caches survive sign-out** and have no expiry.

### 1.3 Periods already in the code that this proposal replaces

| Constant | Value | Where it came from | Why it cannot stand |
| --- | --- | --- | --- |
| `LAYOVER_AUDIT_RETENTION_DAYS` (`artifacts/api-server/src/lib/layoverEventPseudonymisation.ts:67#LAYOVER_AUDIT_RETENTION_DAYS = 365`), plus 3621's `INTERVAL '12 months'` CHECK ceiling | 365 d | OD-MAP-4, adopted by lead ruling 2026-10-07 | OD-MAP-4's 12 months is named as not borrowable. |
| `LAYOVER_POST_SESSION_PSEUDONYMISE_AFTER_DAYS` (`artifacts/api-server/src/lib/layoverEventPseudonymisation.ts:70#LAYOVER_POST_SESSION_PSEUDONYMISE_AFTER_DAYS = 30`) | 30 d | PR-R-L163a | It is numerically OD-TRIP-4's 30 days, and no layover reason was given for it. |
| `SNAPSHOT_RETENTION_POLICY.retentionDays` (`artifacts/api-server/src/services/layover/LayoverDecisionService.ts:104#retentionDays: 90`) | 90 d | Proposed ruling L-DATA-L261 | It equals the orphaned-storage window in `docs/ops/retention-policy.md`, and no layover reason was given for it. |

All three sit behind flags seeded FALSE, or on migrations not applied in production. Nothing in production runs on them
today, so replacing them changes no live behaviour.

---

## 2. The reasoning that sets every period

- **A layover lasts hours.** The engine refuses windows under 90 minutes, and most last under a day. The data exists to get
  the traveller out and back before boarding. Once they board, that purpose is finished.
- **A missed connection is known the same day.** It shows up at the gate, and a rebooking normally lands within a day. The
  window in which the traveller, or support on their behalf, needs the *full* record is therefore the layover plus a rebooked
  departure: **48 hours**. The same reasoning is already in the code for one table: a checkpoint stays visible for 6 hours
  after departure. 48 hours widens that to cover a next-day rebooking.
- **"What did Portava tell me?" comes later, but not much later.** A traveller who missed a flight may contact support only
  once home. That evidence needs the final answer the traveller acted on, not every intermediate recomputation and not the
  traveller's nationality. **21 days** covers the rest of a typical trip plus time to write in. The number is a judgment, and
  §5 gives the owner the options around it.
- **Audit evidence answers a different question:** was the engine wrong, and for whom? A minimised, pseudonymous record of
  what the engine certified, under which engine version, at which airport, is what an incident review or an engine
  regression review needs. **60 days** lets an incident reported near the end of the 21-day window be investigated. It
  also spans more than one engine release. If an investigation needs a specific row longer, a person places a **named
  hold** on that row. The default does not grow.
- **What the user saved, the user keeps.** The stamp, Memory, postcard and trip row were each an explicit election. They
  carry city and country only, and none of them reads the session after it is created. They follow their own feature's
  rules and the user's own deletion. No layover period applies to them.

---

## 3. The proposed policy

### 3.1 Live operational data

Presence, crews and crew members, checkpoints and the device's scheduled alerts are **deleted when their own `expires_at`
passes, with no grace period**. This is the rule the crew sweeper already follows, extended to presence and checkpoints.
Each `expires_at` is already a layover-derived instant: the availability window, the founder's hard return, departure + 6 h.
Every read already filters on it, so deletion changes no answer any caller can get.

### 3.2 Snapshot contents

- **Up to E + 48 h, full detail.** Every certified record of the session stays, with its time budget, return plan and
  constraint version. That keeps replay (L191) and diff (L190) working through the layover and a rebooked departure. The
  per-session cap from §61 stays as a growth bound (at most 20 records, the newest always kept). It is a size limit, not a
  period.
- **At E + 48 h, minimise.** Keep exactly one record per session: the newest certified record, or, if the traveller set a
  return reminder, the record behind the last `return_deadline_set`. Write it as a **minimised summary** containing:
  - kept: engine and feasibility version, input hash, `snapshot_version`, `computed_at`, verdict, confidence, `cutoff_at`,
    `hard_return_time`, total buffer, usable minutes, per-term buffer minutes, reason codes, airport IATA;
  - dropped: the whole `inputs` JSON (nationality corridor, mobility and baggage constraints, plan probe title, session
    instants beyond the cutoff), `input_facts`, `source_refs`, and every superseded record with its budget, return plan and
    constraint versions.

  Replay is no longer possible after this point, by design. The input hash still lets anyone holding the inputs confirm that
  the summary matches them.
- **At E + 21 d, delete** the minimised summary together with the session (§3.3).

### 3.3 The session and its working data

The session row, plan stops, recommendations, outcome, presence remnants and dead letters are **deleted at E + 21 d** in
one statement: `DELETE FROM layover_sessions` cascades to every child. Before deletion, the outcome is folded into an
aggregate: counts of boarded, missed and left-airport by airport, ISO week and verdict. Any cell under k = 5 sessions is
suppressed. Only the aggregate remains (L161, *"may persist after de-identification/aggregation"*). The trip timeline row
keeps its own life. Its `source_id` is plain TEXT, and nothing reads through it after the mirror write.

### 3.4 Minimised audit evidence (`layover_events`)

- **Named until E + 48 h.** The only reader of a session's events is the live disruption ledger, and the owner's own
  history view during the layover.
- **At E + 48 h, pseudonymise with an allow-list**, replacing today's empty-metadata patch:
  - kept: `event_type`, `created_at` truncated to the hour, airport IATA, engine version, verdict, minutes-before for
    `return_deadline_set`, `involvesLeaving`/`answerMode` for Compass, and the reason codes;
  - dropped: user id, session id, every absolute instant (hard return, reminder), city, crew id and title, Telegraph thread
    id, stop and recommendation ids, observation values, and any free text;
  - a fresh pseudonym per session, so one layover's events stay consistent but cannot be joined to another layover.
- **Deleted at E + 60 d.** A named incident hold, recorded by a person with a reason and an end date, keeps only the rows it
  names. A hold never applies by default.

### 3.5 Deletion

- **User-initiated: "Delete this layover".** Not built today, and this proposal recommends building it. The session
  and its whole cascade are erased immediately, saved records excepted. Its events are pseudonymised immediately under
  §3.4's allow-list and keep the E + 60 d clock. Option B deletes the events as well; §5 Q4.
- **Account deletion.** The same treatment for every session. Today's step order is kept: pseudonymise events, delete crew
  memberships, delete sessions. Today's `retain_until` of +365 d is replaced by E + 60 d, bounded above by deletion
  time + 60 d, so a departed traveller's evidence is never kept longer than a current traveller's.
- **Device.** On sign-out, and on the first app open after E + 48 h, the client removes `layover.deadline.v1:*`,
  `layover.plan.v1:*` and `layover.returnAlerts.v1:*` for that session and cancels any alert still scheduled.

### 3.6 Saved records

The four elective artifacts (stamp, Memory, postcard, trip row) are **kept until the user deletes them**, under their own
features' rules. They must not block the layover's deletion and must not be deleted by it. None of them has an FK to
`layover_sessions` on main. That is already true and should stay true. Option B adds a "Keep this layover in my history"
election. It would keep a minimised session summary (airport, date, outcome) until the user deletes it. §5 Q5.

### 3.7 Data not linked to a traveller

- `airport_fact_observations`: community rows are deleted at `expires_at` + 48 h. That covers dedup of client retries and
  a diagnostic look at a bad reading. A per-airport, per-hour k-anonymous aggregate may stay. Feed and official rows follow
  the same rule unless an operator contract says otherwise.
- `layover_external_events`: deleted 48 h after `processed_at`, or 48 h after `received_at` if never processed. Their dedup
  only has to outlast a provider's redelivery.

---

## 4. Enforcement (described, not built)

One job, the existing hourly layover retention tick (`layoverAuditRetentionScheduler`), gains phases. Each destructive phase
gets its own flag, seeded FALSE, and turning one on is the owner's action. Each writes `job_health` and treats a failed read
as "nothing done", never as "nothing due". This is the pattern §61 established.

| Phase | Action | Needs |
| --- | --- | --- |
| P1 expiry | Delete presence and checkpoints past `expires_at`. Crews are already swept. | Code only |
| P2 snapshot minimise (E + 48 h) | Insert the summary into a new `layover_snapshot_summaries` table, then delete the session's full records children-first, as `compactSessionDecisions` already does. | A migration: the new table, RLS on, REVOKE from anon/authenticated/PUBLIC (rule 4), owner-read policy, FK to session `ON DELETE CASCADE`, rollback file. **No change to 2992's UPDATE triggers.** |
| P3 event minimise (E + 48 h) | Replace `LAYOVER_POST_SESSION_PSEUDONYMISE_AFTER_DAYS = 30` with an E + 48 h clock and the allow-list patch | Code. The 3622 flag is reused. |
| P4 session delete (E + 21 d) | Fold outcomes into the aggregate, then `DELETE layover_sessions` | A migration for the aggregate table. Saved records are unaffected because no FK points at the session. |
| P5 event delete (E + 60 d) | Replace `retain_until` +365 d with E + 60 d. Tighten 3621's CHECK from `12 months` to the approved ceiling. Add a `retention_hold` reference. | A migration: replace the CHECK constraint, after verifying no row exceeds the new bound, with a rollback |
| P6 observations / external events | Delete per §3.7 | Code |
| Client | Remove cache keys at E + 48 h and on sign-out | Client code plus a test |
| User delete | `POST /airport/sessions/:id/erase` (owner-only), then cascade and §3.4 | Route, client control, tests |

`SNAPSHOT_RETENTION_POLICY` (90 d / 20) becomes `{ fullDetailHours: 48, summaryDays: 21, maxPerSession: 20 }` or the
approved option. 3624's flag description changes with it.

---

## 5. Questions for the owner

| # | Question | Options | Recommended, and why |
| --- | --- | --- | --- |
| Q1 | How long does the **full** snapshot stay? | A: E + 24 h · B: E + 48 h · C: E + 7 d | **B.** It covers a rebooked next-day departure. A misses a late-evening rebooking. C keeps nationality and constraints for days with no use for them. |
| Q2 | How long does the **minimised** "what you were told" record stay, and with it the session? | A: E + 14 d · B: E + 21 d · C: E + 45 d | **B.** It covers the rest of a typical trip plus time to contact support. A is tight for long trips. C keeps an itinerary with no stated use. |
| Q3 | How long does **minimised audit evidence** stay? | A: E + 21 d (with the session) · B: E + 60 d · C: E + 120 d | **B.** An incident reported late in Q2's window can still be investigated, and longer needs go through a named hold. A gives an investigation no time. C is a default kept "just in case". |
| Q4 | When a user deletes one layover, or their account, what happens to its audit events? | A: minimise now, delete at E + 60 d · B: delete now | **A.** Safety evidence then does not depend on whether the person deletes, and what remains cannot be linked to them. B is the stricter privacy choice if the owner prefers it. |
| Q5 | Should there be a "keep this layover" election beyond the four existing artifacts? | A: no · B: yes, a minimised summary kept until the user deletes it | **A.** The stamp, Memory, postcard and trip row already let a traveller keep the layover. B adds a fifth kept record. |
| Q6 | Is "delete this layover" built? | yes / no | **Yes.** Without it, a traveller who wants one layover gone must delete their account. |
| Q7 | Who may place an incident hold, and is there a ceiling? | A: an admin, with reason and end date, up to E + 120 d, renewable only by the owner · B: no holds | **A.** Any hold is named and bounded. The ceiling is twice Q3's default, so one renewal-free investigation fits. |
| Q8 | Aggregate cohort floor for outcomes and observations | k = 5 / k = 10 | **k = 5.** At 0 verified airports today, a higher floor would publish nothing. |

**What this proposal does NOT decide:** any legal retention obligation in a particular country. Where one applies, it
overrides these defaults for the rows it covers and is recorded separately. It also does not decide enabling any flag in
beta or production, or applying any migration. Those remain the owner's actions.
