# OWNER REVIEW: TWELVE FAMILIES OF TRUST SCORING PARAMETERS

*2026-09-14. Requested by the owner: "Send me the twelve families to review."
Every value below was read out of the source on the integration branch at
`8ba5e8515`, not from memory and not from a previous report. Nothing in this
document changes any value. The census rows that depend on these stay blocked
until a ruling — that is the owner's own condition, and it is the honest state.*

## Why this document exists

Twelve families of parameters decide every trust score Portava has ever
computed. They are in production. **Not one of them is ratified anywhere** — no
spec sentence, no decision record, no test that asserts a value *should* be what
it is rather than that it *is* what it is. That is the difference between a
number and a requirement, and it is why `census-trust.md` cannot grade the rows
that rest on them: there is nothing to grade against.

"Ratify current behaviour as v1" is a complete answer to every question below.
It costs nothing to say and it converts twelve unowned numbers into twelve
requirements, after which a change to any of them has to be argued rather than
committed.

**One structural note before the values.** Nine of the twelve are *overridable
at runtime* from a `trust_settings` row (id = 1); the values shown are the
built-in defaults used when no row exists. Three are not overridable at all —
they are literals in the code. Those three are marked **HARD-CODED** and are the
ones where "ratify as is" has a different meaning: ratifying a default says the
shipped starting point is right; ratifying a literal says nobody should be able
to change it without a deploy.

---

## 1. Nine category weights — *overridable*

`services/trust/TrustScoreService.ts:76#DEFAULT_SETTINGS`

| Category | Weight |
|---|---|
| `plan_attendance` | 0.180 |
| `respect_safety` | 0.150 |
| `location_honesty` | 0.130 |
| `host_quality` | 0.120 |
| `communication` | 0.100 |
| `content_quality` | 0.080 |
| `community_value` | 0.080 |
| `guide_accuracy` | 0.080 |
| `passport_authenticity` | 0.080 |

They sum to 1.000. **The question is not the arithmetic, it is the ordering:**
showing up to plans is weighted 2.25× as heavily as the authenticity of your
passport, and "did you behave safely" is weighted above "were you honest about
where you were". Both are defensible; neither is written down anywhere as
intended.

## 2. Six level thresholds — *overridable*

`TrustScoreService.ts:36#PUBLIC_TRUST_LEVELS`, thresholds at `:87#level_building_trust`, banded at `TrustScoreService.ts:280#level_city_trusted`

| Level | Score at or above |
|---|---|
| `new_traveler` | — (the floor) |
| `building_trust` | 35 |
| `reliable_traveler` | 50 |
| `trusted_traveler` | 65 |
| `highly_trusted` | 78 |
| `city_trusted` | 90 |

A new user starts at **50** (`TrustScoreService.ts:276#50 + movement`), which is already
`reliable_traveler`. So the first label a user ever wears is the third of six,
and the bottom two bands are only reachable by *losing* trust. If that is
intended, it is worth saying so, because it means `new_traveler` does not mean
new.

> **SUPERSEDED IN PART, 2026-09-22 — owner decision Q1 (nullable trust scores).**
> The paragraph above is kept as the argument that was put to the owner, and it
> is what prompted the ruling. It no longer describes the engine. A user with no
> events is now **NOT SCORED** (`overall_score` is `NULL`, every category is
> `NULL`) rather than scored 50, and `public_level` is `new_traveler` — so the
> first label a user wears is the first of six, not the third, and nobody is
> promoted to `reliable_traveler` on no evidence. The centring on 50 that the
> citation names still applies to a category that HAS events; what is gone is
> the substituted 50 for one that has none
> (`TrustScoreService.ts:257#if (relevant.length === 0) return null;`).
> **The six thresholds in the table above are NOT re-proposed and NOT ratified
> by this note** — they are unchanged values, and §2 still awaits the same
> ruling it always did. The only thing that changed is which users reach them.

## 3. Decay half-life: 90 days — *overridable*

`TrustScoreService.ts:86#decay_half_life_days`, applied at `:139#Math.pow(2`

Every event's weight is multiplied by `2^(-ageDays/90)`. A year-old event counts
for about 6 % of a fresh one. The half-life is the whole of the "people change"
policy — there is no other mechanism by which old conduct stops mattering.

## 4. **HARD-CODED** scoring window: 365 days

`TrustScoreService.ts:144#since`

Events older than a year are not loaded at all. This is a literal in
`loadEvents`, **not a setting** — an admin cannot change it, and it interacts
with §3: at 365 days an event is already down to 6 % weight, so the window is
close to a no-op today *and would stop being one the moment the half-life is
raised*. Ratifying the half-life without ratifying this is the one combination
that can surprise you later.

## 5. **HARD-CODED** earn/lose asymmetry

`TrustScoreService.ts:200#EARN_CONFIDENCE_WEIGHT` and
`TrustScoreService.ts:272#const confidence = Math.min(1, totalWeight / EARN_CONFIDENCE_WEIGHT);`
*(the application site was cited at line 250 until 2026-09-22; Q1's nullable-scores
docblock on `computeCategoryScore` moved it. Repointed by SEARCHING for the
multiplication the sentence below describes, not by adding the diff's offset,
and anchored on a string that occurs exactly once in the file. The claim is
unchanged: the ramp is applied to the positive branch only.)*

Positive movement is multiplied by `min(1, totalWeight / 5)` — a confidence
ramp, so a single good event moves the score very little and it takes roughly
five events' worth of weight before positives count in full. **Negative movement
applies at full strength immediately, with no ramp.**

The source states the reasoning at `services/trust/TrustScoreService.ts:195-230`: a serious finding must bite
regardless of how much positive history surrounds it. This is the most
consequential single asymmetry in the system and it is a product ethics
position, not a tuning constant.

## 6. Fifty per-event deltas — *hard-coded vocabulary*

`services/trust/TrustEventService.ts:782` onward. All fifty, grouped by sign:

**Positive (30)** — `IDENTITY_VERIFIED` +10 · `FIRST_EVENT_HOSTED` +10 ·
`FIRST_EVENT_JOINED` +10 · `RENT_BUDDY_APPLICATION_APPROVED` +10 ·
`HOST_POSITIVE_REVIEW` +6 · `PLAN_ATTENDED` +5 · `EVENT_HOSTED` +5 ·
`EVENT_ATTENDED` +5 · `GEM_VERIFIED_BY_GUIDE` +5 ·
`GEM_VERIFIED_BY_GUIDE_AUTHOR` +5 · `RENT_BUDDY_COMPLETED` +5 ·
`EVENT_ATTENDANCE_CONFIRMED` +4 · `RENT_BUDDY_POSITIVE_REVIEW` +4 ·
`SAFE_RETURN_COMPLETED` +3 · `GUIDE_VERIFICATION` +3 · `STAMP_VERIFIED` +3 ·
`EVENT_POSITIVE_REVIEW` +3 · `RENT_BUDDY_BOOKING_ACCEPTED` +3 ·
`RESPONDED_PROMPTLY` +2 · `CHECKIN_VERIFIED` +2 · `PASSPORT_STAMP_EARNED` +2 ·
`APPEAL_APPROVED` +2 · `APPEAL_APPROVED_REVERSAL` +2 · `REVIEW_SUBMITTED` +2 ·
`RENT_BUDDY_CASH_BALANCE_CONFIRMED` +2 · `TRAVEL_CIRCLE_JOIN` +1 ·
`GEM_CONTRIBUTION` +1 · `GEM_SAVED` +1 · `PULSE_POST_CREATED` +1 ·
`TELEGRAPH_CONNECTION_ACCEPTED` +1

**Negative (20)** — `BEHAVIOR_REPORT_CONFIRMED` −20 · `FAKE_GPS_CONFIRMED` −20 ·
`MESSAGE_REPORT_CONFIRMED` −15 · `EVENT_HOST_NO_SHOW` −15 · `PLAN_NO_SHOW` −10 ·
`CONTENT_REMOVED` −10 · `HOST_NEGATIVE_REVIEW` −8 · `EVENT_HOST_CANCELLED` −8 ·
`GPS_IMPOSSIBLE_SPEED` −8 · `STAMP_DISPUTED` −6 · `EVENT_NEGATIVE_REVIEW` −6 ·
`PLAN_LATE_CANCEL` −5 · `EVENT_NO_SHOW` −5 · `EVENT_ATTENDEE_NO_SHOW` −5 ·
`PULSE_POST_REPORTED` −5 · `GEM_DISPUTED` −5 ·
`RENT_BUDDY_POLICY_FLAG_CONFIRMED` −5 · `RENT_BUDDY_ROUTE_CHANGE_DECLINED` −5 ·
`GPS_COORDINATE_JUMP` −4 · `MUTUAL_REPORT` −3

Two pairs worth a second look before ratifying:

- `IDENTITY_VERIFIED` is **+10 to `respect_safety`** — verifying your ID raises
  your *safety* score, which is the same category a confirmed behaviour report
  takes 20 off. Those are not obviously the same axis.
- `FIRST_EVENT_HOSTED` / `FIRST_EVENT_JOINED` are +10 each, equal to
  `IDENTITY_VERIFIED` and double `PLAN_ATTENDED`. A first-time bonus of that
  size is a growth incentive sitting inside a trust score.

**One of these is declared and never fires.** `STAMP_VERIFIED` (+3
`passport_authenticity`) has been in the vocabulary since 2026-07-17; a
production read on 2026-09-07 found **zero** trust events from it. The live award
path does not emit it. Ratifying the value does not make it reachable — that is a
separate defect, recorded in `census-trust.md`.

## 7. Severity routing — *hard-coded*

`TrustEventService.ts:307#severity`

`serious` and `severe` events are recorded `pending_review` and wait for
adjudication. Everything else is `applied` immediately. Severity here is a
**route, not a magnitude** — it decides who reviews, not how much the score
moves. Worth ratifying explicitly, because the two readings are easy to confuse
and the code comments say the distinction has been confused before.

## 8. Seven per-finding ceilings, and their expiries — *hard-coded*

`services/trust/TrustCapService.ts:311#capMap`

| Finding | Category capped | Ceiling | Expires after |
|---|---|---|---|
| `fake_gps_confirmed` | `location_honesty` | 35 | **never** |
| `behavior_report_confirmed` | `respect_safety` | 40 | **never** |
| `message_report_confirmed` | `communication` | 45 | 60 days |
| `content_removed` | `content_quality` | 50 | 30 days |
| `gps_impossible_speed` | `location_honesty` | 55 | 14 days |
| `gps_coordinate_jump` | `location_honesty` | 55 | 7 days |
| `plan_no_show` | `plan_attendance` | 60 | 30 days |
| *any other* `severe` *finding* | `respect_safety` | 40 | **never** |

**The ceiling, not the delta, is what a serious finding actually does.** A −20
delta decays with everything else; a ceiling of 35 that never expires does not.
Two of these seven, plus the catch-all, are permanent. The source records that
this was already a live problem once: un-banning a user left the permanent
ceiling standing, so the sanction was reversible and its consequence was not.

## 9. Earning caps — *overridable*

`TrustEventService.ts:209#daily_cap_plan_attend`

| Bucket | Daily | Weekly |
|---|---|---|
| `plan_attend` | 3 | 10 |
| `guide_verify` | 5 | 20 |
| `gem_save` | 10 | 40 |

These were **999/999 — i.e. no cap at all** until recently, and only nine literal
event types are mapped to a bucket. An event type not in
`EVENT_TYPE_CAP_BUCKET` is uncapped. The bucket for a new positive event type
defaults to the most permissive one, which is a choice worth ratifying rather
than inheriting.

## 10. Dedup windows — *per-call, hard-coded at each site*

`TrustEventService.ts:276#dedupWindowHours`

Default **24 hours** on `(user, event type, source type, source id)`. Two sites
override it: the GPS suspicion path uses 24 h explicitly (`services/trust/TrustEventService.ts:450#dedupWindowHours`), and one path
uses **24 × 365 hours — a full year** (`services/trust/TrustEventService.ts:590#dedupWindowHours`), i.e. once ever. Dedup is
**fail-closed**: if the dedup read errors, the event is not recorded at all.
That is the right default and it means a database blip silently drops trust
events rather than double-counting them.

## 11. Recovery and probation — *hard-coded*

`services/trust/TrustRecoveryService.ts:68#deficit`

Recovery is measured as progress toward **50** (neutral), not toward the user's
previous score. Categories are prioritised by how far below neutral they sit,
with a deficit over 30 taking the lowest priority band. Probation is a flag and
an end date on `trust_profiles`; the length is set by the caller, not by a
constant here.

## 12. Reversals — *hard-coded*

`TrustEventService.ts:859#APPEAL_APPROVED_REVERSAL` and
`TrustAdminService.revokeModerationTrustConsequences`

A successful appeal awards **+2 `community_value`** and revokes the moderation
consequences. It does not restore the original score, and the +2 is in a
different category from whatever was lost. Reversal is therefore *not*
symmetrical with the finding it reverses, by construction.

---

## What a ruling unblocks, precisely

Nothing here is a request to change a number. It is a request to say which of
the twelve are intended as they stand. "All twelve, ratify as v1" is a complete
answer and unblocks every dependent row at once.

If you would rather rule selectively, the three that most repay a decision are:

1. **§5, the earn/lose asymmetry** — it is a product ethics position, it is
   hard-coded, and every score in the system is shaped by it.
2. **§8, the permanent ceilings** — two findings and the `severe` catch-all cap a
   user forever, and the delta everyone looks at is not the part that bites.
3. **§4, the 365-day window** — harmless today only because §3's half-life makes
   it so, and it is the one parameter an admin cannot reach.

Until a ruling lands, the dependent rows in `census-trust.md` stay `W`/`N` and
say why. They will not be moved on an assumption.
