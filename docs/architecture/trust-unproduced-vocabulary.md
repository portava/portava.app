# Trust — the 13 declared event types nothing emits, classified with evidence

**Measured 2026-09-07 against `58918524` (api-server), production `ajrurzioarfkagpuxfnb` read-only.**
Companion to [census-trust.md](census-trust.md) §2.C C32 and `src/test/trustEventCoverage.test.ts`,
whose AST walk is the source of the "unproduced" set. Line numbers are as of that commit; a sibling
lane appended to `routes/admin.ts` while this was written, so admin.ts numbers are HEAD's, not the
working tree's.

## 0. What this corrects

The previous Trust lane wired five emitters and reported that **nine** of the remaining thirteen
have "no triggering action anywhere in the tree". That was tested here rather than inherited, by
opening every handler a grep pointed at. It is **wrong for three, partly wrong for four, right for
two**:

| Claim: "no triggering action" | Measured |
|---|---|
| `plan_no_show` | **FALSE.** The trip owner adjudicates a member as `no_show` at `routes/geofence.ts:809-897` (branch `:872`). Nothing emits. |
| `host_positive_review` / `host_negative_review` | **FALSE.** `routes/reviews.ts:199-258` writes attendance-gated reviews of a trip's host; only the reviewer is credited (`:247`). |
| `responded_promptly`, `travel_circle_join`, `fake_gps_confirmed`, `mutual_report` | **Partly.** A raw signal is produced for each; nothing adjudicates it into the event's meaning (verdict c below). |
| `event_host_no_show`, `plan_late_cancel` | **TRUE.** Nothing in the product produces the situation. |

The distinction that decides every row: **a raw signal is not an adjudicated event.** A
`plan_checkins` row does not mean anyone determined a no-show; a `reports` row does not mean anyone
found the report founded. Verdicts:

- **(a)** nothing produces the situation → `reserved_future_event`
- **(b)** the situation is produced *and adjudicated*, nothing emits → `missing_real_emitter` (or a
  naming decision when it is emitted under another string)
- **(c)** a raw signal exists, nothing adjudicates it → `owner_decision` on the rule, or
  `unsafe_to_emit` when every plausible rule is harmful

## 1. Production ground truth for these thirteen

Every count below is **zero rows either way** unless stated. A classification here is a statement
about the code, not confirmed by data — the data cannot confirm or refute any of them.

| Fact | Value |
|---|---|
| `trust_engine_enabled` / `plan_geofence_enabled` / `events_enabled` / `passport_stamps_enabled` | TRUE |
| `rent_buddy_enabled` | **FALSE** — every Rent-a-Buddy signal below is on a disabled surface |
| `trust_events` | 5 rows: 4 `pulse_post_created`, 1 `first_event_joined` (neither `appeal_approved` nor `appeal_approved_reversal`; neither `event_no_show` nor `event_attendee_no_show`) |
| `event_attendee_states`, `plan_geofences`, `plan_checkins`, `plan_attendance_events`, `circle_invites`, `circle_memberships`, `appeals`, `reviews`, `event_reviews`, `reports`, `rent_buddy_bookings`, `location_trust_events`, `trust_reviews`, `trust_caps` | 0 |
| `user_stamps` live (not revoked) | **47** — against 0 `stamp_verified` events |
| `events` by state | open 97 (**96 past `starts_at`**), completed 7; no row has ever been `started` through the API — see row 2 |
| `rent_buddy_profiles.response_time_h` | 6 of 6 set, with 0 bookings — seed values, not responses |

## 2. The thirteen

| # | Type (declared) | Classification | Trigger verdict, with `file:line` | What would have to be true to wire it | Owner of that file |
|---|---|---|---|---|---|
| 1 | `appeal_approved_reversal` (+2 minor, community_value) | **owner_decision** — a naming mismatch, not a missing emitter | **(b)** Produced and adjudicated: an admin approves an appeal (`routes/appeals.ts:247`) whose `target_type` is `trust_score_event`; `services/appeals/resolveAppeal.ts:70-95` dismisses the offending event and emits **`appeal_approved`** at `:85` with delta 2 / minor / community_value — byte-identical values to `TRUST_EVENT_TYPES.APPEAL_APPROVED_REVERSAL`. The other approved-appeal branches (post, memory, highlight, no_show, memberships) emit nothing. | **Recommendation: the declared name wins.** (i) The emit fires only on the trust-event-*reversal* branch, so `_reversal` says what it is; `appeal_approved` overstates (a restored post earns nothing). (ii) The emitter hand-writes delta/severity; it should read the constant, as `routes/admin.ts` does for `CONTENT_REMOVED`. (iii) Production has 0 rows under either string, so the rename has no ledger cost; `TrustEventService.ts:177` names `appeal_approved` only in a comment. Patch in §3.1. Renaming the constant instead is the same one-line cost with a worse name. | Appeals (`services/appeals/resolveAppeal.ts`) |
| 2 | `event_attendee_no_show` (−5 **minor**, plan_attendance) | **owner_decision** — name and severity; the emitter exists | **(b)** Produced and adjudicated: host/moderator marks a `going` attendee absent, `routes/events.ts:3535-3597`; emits **`event_no_show`** −5 **moderate**, `source_type='event'`, `source_id=event id`, **48 h** dedup (`:3575-3583`). **Routing consequence of moderate vs minor: none.** Only serious/severe route to `pending_review` (`TrustEventService.ts:306-307`); `applyEventCaps` runs only on confirm and has no entry for either string (`TrustCapService.ts:197-204`); the scorer does not read severity (`TrustScoreService.ts:204`); restriction, recovery and gaming services never read it. The label is stored and nothing branches on it. **What does differ and matters:** 48 h dedup vs the wired emitters' 365 d + migration 2540 — the route upserts, so a second POST after 48 h charges the same absence twice. **Reachability:** the route requires `state ∈ {started, completed}` (`:3552`), and **no writer of `state='started'` exists** — every `events.state` write is `:403` (open/full/waitlist), `:2425`/`:4465` (cancelled), `:4366` (open), `:4520` (draft), `:4568` (completed, itself gated on `started` at `:4564`), `:4698` (archived); no migration function, no client (`artifacts/` holds only api-server and mockup-sandbox). So through the current API the emitter cannot fire; 96 of 97 open events are past their start. | Events owner: adopt the declared string and constant (severity becomes `minor` — cosmetic today), dedup 365 d, add the type to 2540's list; decide how an event reaches `started` (that gap blocks check-in, attendance and completion too, not just this). Appeals owner: `resolveAppeal.ts:98-112` (`case "no_show"`) clears `no_show_at` but leaves the `event_no_show` trust event `applied` — an approved no-show appeal does not reverse its penalty. | Events (`routes/events.ts`), Appeals |
| 3 | `stamp_verified` (+3 minor, passport_authenticity) | **missing_real_emitter** | **(b)** Produced and adjudicated: `services/passport/StampAwardEngine.ts` `_awardStampCore` fresh-award return (`:611-642`) classifies provenance (`stampVerificationTier`, `:31`) and already emits the §32 telemetry `stamp_verified` on tier `verified` (`:628-634`). The Trust half, `recordStampVerifiedTrustEvent` (`TrustEventService.ts`, exported), has **no caller** — the coverage test pins that. 47 live stamps, 0 events. | One call at the telemetry site, on the `awarded: true` return only — exact patch in §3.2. The recovery path (`skipToStampInsert`, `:261-287`) reaches the same return with a **new** `user_stamps` id, which is the first time that row exists; the dedup key is that id, so a healed stamp credits once. | Passport (`services/passport/StampAwardEngine.ts`) |
| 4 | `pulse_post_reported` (−5 moderate, content_quality) | **owner_decision** — refusal preserved | **(c)** Raw signal produced: a report on a post, `routes/reports.ts:67-131`. Two adjudications exist and neither is this: hide-content charges `content_removed` keyed on the **post id** (`routes/admin.ts:2200-2290`); resolve `{upheld:true}` charges **nothing** for a post (`:2124` is `targetType === "message"` only). Charging on **filing** is refused: a report is an accusation, and `reports.ts:161-186` treats the *reporter* as the party at risk. | The one honest meaning left is "**upheld but not removed**" — an admin resolves a post report as founded and leaves the post up. Decision: does that charge −5 moderate; and when one report is both hidden and upheld (legal: hide-content sets `in_review`, resolve accepts anything not `resolved`), `content_removed` must subsume it — same content id, or skip when a `content_removed` for that content exists. `trustEmitterWiring.test.ts` §6 now pins today's behaviour (hide + uphold → one event) and fails if resolve starts emitting for posts (measured: R1 below). | Admin (`routes/admin.ts`), on a Trust-supplied helper |
| 5 | `event_host_no_show` (−15 serious, host_quality) | **reserved_future_event** | **(a)** Nothing determines that a host did not appear. `event_host_no_show` occurs once in the tree, as a push-notification type name in a doc comment (`routes/events.ts:6375`), and nothing sends it. Attendees have no "host didn't come" report (Rent-a-Buddy has `buddy_no_show`, `routes/rentABuddy.ts:5959`; Events has none). The only raw signal — an event past `starts_at` still `open` — is the lifecycle gap in row 2, not host evidence. No cap entry (census C13). | A lifecycle that reaches `started`; then either an attendee report adjudicated by an admin, or a rule (host never checked in AND ≥N attendees did) — and a cap-map entry, since serious → `pending_review` → confirm → `applyEventCaps` finds nothing. | Events |
| 6 | `plan_no_show` (−10 moderate, plan_attendance) | **missing_real_emitter** (gated) | **(b)** Produced and adjudicated: the **trip owner** overrides a member's geofence attendance to `no_show` (`routes/geofence.ts:809-897`, schema `:65` over `ATTENDANCE_STATUSES` `:33`); the `no_show` branch (`:872-876`) feeds Compass (`recordActivityEvent`, `endFairExposure`) and **nothing else**. This is the same standing as the Events host marking absence (row 2), which emits. The product already carries the switch for exactly this consequence: `plan_geofences.no_show_affects_reliability` (`geofence.ts:57`, default false; admin default `routes/admin.ts:516`), which is read and echoed (`geofence.ts:134`, `:339`, `:409`) and **enforced by nothing**. | Emit from the override route iff the geofence's `no_show_affects_reliability` is true: subject = the member, actor (owner) in metadata, `source_type='geofence'`, `source_id=geofence id`, 365 d dedup. Note `plan_no_show` has a cap entry (`TrustCapService.ts:198`, ceiling 60 / 30 d) that can never apply at `moderate` — it is reached only via `recordAdjudicatedTrustEvent`; whether a host override is "adjudicated" enough for that path is the Trust-side question. Adjacent: Rent-a-Buddy's admin `resolve-dispute` (`routes/rentABuddySpec.ts:1718`) confirms a buddy no-show and bumps `no_show_count` (`:1813`) with **no trust event** — a different, undeclared vocabulary (`rent_buddy_*`). | Geofence/Trips (`routes/geofence.ts`) |
| 7 | `plan_late_cancel` (−5 minor, plan_attendance) | **reserved_future_event** | **(a)** No member-level commitment to a plan item exists to cancel. `plan_checkins.status` (`geofence.ts:33`) has no cancellation value; `trip.plan_cancelled` (`lib/tripKernel.ts:248`) is the **owner** cancelling the item, not a member withdrawing; `route_plan_members` (`migrations/0059`) is join/leave with no start time to be late against. The only late-cancel in the tree is `rent_buddy_late_cancel` (`routes/rentABuddy.ts:2054`, <2 h) — a different vocabulary on a disabled surface. | A per-member RSVP on timed plan items. | Trips |
| 8 | `host_positive_review` (+6 minor, host_quality) | **missing_real_emitter** (trip host) | **(b)** Produced: `routes/reviews.ts:199-258` writes an attendance-gated (`checkEligibility`, `:74`) review whose `entity_type='trip'` rates the trip's host — `GET /users/:id/reviews` (`:427-500`) aggregates them as "where this user hosted". The review is the evidence (the earlier lane wired event reviews on the same basis). Today only the **reviewer** earns (`review_submitted`, `:247`); the host gets nothing. Rent-a-Buddy likewise credits the reviewer (`routes/rentABuddy.ts:3266`) and its admin approve (`:4956`) only recomputes `average_rating`. No surface but Events credits the reviewed party. | Emit from `reviews.ts` for `entity_type='trip'` on first submission only (`PATCH /reviews/:id` exists, `:569`): subject = trip owner, `EVENT_REVIEW_RATING_BANDS` for the bands, keyed on the review id, 365 d, **no counterparty when `visibility='anonymous'`** (the 2370 refusal). **Owner question attached:** magnitude — `HOST_*` is +6/−8 where `EVENT_*` is +3/−6 for the same act on another surface; one of the two should survive. | Reviews/Trips (`routes/reviews.ts`) |
| 9 | `host_negative_review` (−8 moderate, host_quality) | **missing_real_emitter** (trip host) | Same as row 8 — negative band. | Same as row 8. | Reviews/Trips |
| 10 | `responded_promptly` (+2 minor, communication) | **owner_decision** | **(c)** Raw signal produced: buddy accept/decline latency (`routes/rentABuddy.ts:2197`, `:2294` → `services/rentBuddy/ReliabilityCounters.ts:140`, EWMA into `response_time_h`). Nothing adjudicates "promptly", and the tree already holds **two inconsistent band sets**: the ranker (`rentABuddy.ts:1054`, 0.5/1/4 h) and `CompatibilityScoreService.ts:205-208` (1/3/6 h). Message-request replies (`routes/requests.ts`) record no latency at all. | Decide the surface(s), the band, and whether an instant **decline** earns — that is the farmable shape (decline everything instantly; `DEFAULT_EARNING_CAP` bounds it at 10/day). Surface is disabled in production. | Rent-a-Buddy, Messaging |
| 11 | `travel_circle_join` (+1 minor, community_value) | **owner_decision** | **(b)-shaped, identity unresolved.** A circle join is produced: invitee accepts → `circle_memberships` upsert at `routes/requests.ts:447` **and** `routes/friends.ts:712` (whose `:710` comment claims to be "the ONLY path" — it is not). No adjudication is needed; the join is the fact. But "travel circle" appears **nowhere** in the product (0 hits in docs, migrations, routes outside the vocabulary); the `circle_*` tables are the Locate-Friends circle (`migrations/0108`). | Decide: is the Locate-Friends circle the "travel circle"; who is the subject (accepter, owner, both); and whether accepting a friend invite is community evidence at all (invite → accept → remove → re-invite loops; a 365 d dedup on the pair bounds it to once per pair per year). | Friends/Locate (`routes/requests.ts`, `routes/friends.ts`) |
| 12 | `mutual_report` (−3 minor, community_value) | **unsafe_to_emit_with_current_data** | **(c)** Raw signal produced: two `reports` rows A→B and B→A (`routes/reports.ts:67-131`, `target_type` user/profile). Nothing pairs them — the only "mutual" detector in Trust, `detectMutualRings` (`TrustGamingDetectionService.ts:191`), reads `trust_events` counterparties, not reports. | Why *unsafe* rather than reserved: every rule that charges both parties on reciprocity punishes the party the product itself protects — `reports.ts:161-186` auto-restricts and cooldowns the **reported** user to shield a reporter from retaliation, and a retaliatory counter-report is precisely what a "mutual report" charge would hit the victim with. An honest emitter needs an admin adjudication that **both** reports were bad-faith — a dismiss form with a reason that does not exist. | Admin/Reports |
| 13 | `fake_gps_confirmed` (−20 severe, location_honesty) | **owner_decision** | **(c)** Raw findings produced: `services/location/LocationSafetyService.ts:102` (`gps_coordinate_jump`, moderate, applied) and `:114` (`gps_impossible_speed`, serious → `pending_review` → `trust_reviews`). An adjudication exists: `routes/trust-admin.ts:207` → `TrustAdminService.confirmEvent:45` → `applyEventCaps` with the **`gps_impossible_speed`** entry (ceiling 55 / 14 d). It confirms the **same** type; it does not produce a `fake_gps_confirmed`. No client mock-location flag is captured anywhere (grep `is_mock`/`mock_location`: 0). | Decide whether an admin-confirmed impossible-speed finding **is** a fake-GPS confirmation. If yes, `confirmEvent` should escalate (re-type or a linked event) and **not** also apply the `gps_*` cap — otherwise one finding is charged −8 + ceiling 55/14 d **and** −20 + ceiling 35 (no expiry) + 30-day probation. If no, it needs evidence the product does not collect. | Trust (`TrustAdminService`), Location |

**Tally:** `missing_real_emitter` 4 (rows 3, 6, 8, 9) · `owner_decision` 6 (1, 2, 4, 10, 11, 13) ·
`reserved_future_event` 2 (5, 7) · `unsafe_to_emit_with_current_data` 1 (12) · `obsolete_dead` 0 ·
`explicit_hold` 0. `KNOWN_UNPRODUCED_TRUST_EVENT_TYPES` is unchanged: nothing was wired in this pass.

## 3. Patches for files this lane does not own

### 3.1 Appeals — `services/appeals/resolveAppeal.ts:82-90`

```ts
import { recordTrustEvent, TRUST_EVENT_TYPES } from "../trust/TrustEventService.js";
// …
      // Counter-event: small positive signal to offset the appeal friction.
      // Declared name and values — the vocabulary is the contract.
      const t = TRUST_EVENT_TYPES.APPEAL_APPROVED_REVERSAL;
      await recordTrustEvent(sc, {
        userId:     appellant_id,
        eventType:  "appeal_approved_reversal",
        category:   t.category,
        delta:      t.delta,
        severity:   t.severity,
        sourceType: "appeal",
        sourceId:   target_id,
      }).catch(() => {});
```

Then remove `appeal_approved_reversal` from `KNOWN_UNPRODUCED_TRUST_EVENT_TYPES`; the coverage
test will demand it.

### 3.2 Passport — `services/passport/StampAwardEngine.ts`, after the §32 telemetry block (ends `:636`), before the `return { awarded: true, … }` at `:637`

```ts
import { recordStampVerifiedTrustEvent } from "../trust/TrustEventService.js";
// …
    // Trust: a verified-provenance award is passport_authenticity evidence for
    // the OWNER. Fixed inside the Trust vocabulary (delta, severity, key on the
    // user_stamps id, 365-day dedup); the helper refuses a 'reported' tier and
    // never throws. Fire-and-forget — an award must not fail on bookkeeping.
    void recordStampVerifiedTrustEvent(sc, {
      userId,
      userStampId:       newStampId,
      tier,
      stampSourceType:   sourceType,
      stampDefinitionId: definition.id,
      awardedByAdminId:  adminId ?? null,
    });
```

`tier`, `sourceType`, `definition`, `adminId`, `newStampId` are all in scope at that point. Then
remove `stamp_verified` from `KNOWN_UNPRODUCED_TRUST_EVENT_TYPES`, and the
`trustEmissionChain.test.ts` chain (which already drives the helper directly) becomes end-to-end.

## 4. The test added, and its teeth

`src/test/trustEmitterWiring.test.ts` §6 — "cross-emitter: one adjudication reaching two admin
routes writes ONE trust event" (4 tests, 24 → 28). The existing §3/§4 proved *per-emitter*
replay (double-clicked hide → 2 audit rows, 1 event; injected 23505 → dedup). Not covered before:
one **report** reaching **both** `hide-content` and `resolve {upheld:true}`, in either order; two
**reports** on one post both hidden; a message report "hidden" (no mutation) then upheld.

```
cd artifacts/api-server && SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
  node --import tsx/esm --test src/test/trustEmitterWiring.test.ts
# tests 28 / # pass 28 / # fail 0 / EXIT 0
```

| Hand-revert | What it simulates | Result |
|---|---|---|
| R1 — `routes/admin.ts:2124`, drop `targetType === "message"` from the resolve guard | wiring `pulse_post_reported` (or anything) at resolve without subsuming `content_removed` | **# fail 3, EXIT 1** — §6 tests 1 and 2, plus §4 "upheld on a NON-message report" |
| R3 — `TrustEventService.isDuplicate` always answers `"new"` | the read-side dedup removed | **# fail 5, EXIT 1** — §6 test 3 (two reports, one post), plus §1 replay, §3 double-click, §4 second report |

R1 was applied as a single-line edit and restored; `git diff` on `admin.ts` afterwards shows only
the sibling lane's appended surface, and the guard line is byte-identical to HEAD. R3 was restored
from a pristine copy and verified with `diff -q`. A planned R2 (hide-content keyed on the audit row)
was not run: the classifier refused the batch; R3 already fails the same §6 assertion for the same
reason (the content-id key is what makes two reports one event).

## 5. What in the brief turned out to be wrong

1. "Nine have no triggering action anywhere" — see §0.
2. `census-trust.md` C13 cites `event_host_no_show (serious, −15, routes/events.ts:3473)` as an emitter.
   Nothing emits it; `:3473` is the attendance route (`event_attendance_confirmed`) and the no-show
   emitter at `:3575` writes `event_no_show`. Corrected in the census.
3. The brief's "97 open / 7 completed" is right and understates it: 96 of the 97 are past their start
   and no code path can move them — which makes the *existing* `event_no_show` emitter unreachable,
   not merely unfired.
4. `routes/admin.ts`'s `no_show` hits are the geofence config default (`no_show_affects_reliability`),
   a switch that nothing enforces — not an adjudication.
5. `lib/crowdFlowProducer.ts` names `plan_attendance_events` only in comments (`:152`, `:361`); it
   neither reads nor writes it.
