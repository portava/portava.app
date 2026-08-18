# Rent-a-Buddy booking-creation paths — pricing and validation parity

**Status: investigation, read-only. No code was changed to produce this document.**
**Prepared:** 2026-08-18 · groundwork for P3 (shared booking-pricing service).

## Framing, read this first

Every divergence recorded below — pricing and validation alike — is currently
**latent, not active**, for one specific, verifiable reason:
`requireBookingKyc` (`artifacts/api-server/src/lib/rentBuddyKycGate.ts:91-96`,
gate logic at `:1-13`) **hard-blocks all five booking-creation paths today**,
because production has no working identity-verification provider — both real
adapters in `services/identityVerification/providers.ts` are stubs and the
mock provider is refused in production. Every path in this document calls
`requireBookingKyc` before it reaches any of the pricing or validation logic
described here (citations under each path), so none of it is reachable by a
live request right now.

That makes this document **a precondition for reopening Rent-a-Buddy, not a
bug report against today's closed state**. The moment a working KYC provider
lands and `requireBookingKyc` starts passing, every divergence below goes
live simultaneously, on the first booking. Nothing here needs to be treated
as urgent while KYC stays hard-blocked — but nothing here should be treated
as low-priority for the KYC-restoration project either, since restoring KYC
*is* what turns it live.

## Scope note

This investigation covers Rent-a-Buddy booking creation and pricing only.
Story media / `post_media` is explicitly out of scope and was not touched or
examined for this document.

---

## 1. The five booking-creation paths

Five distinct entry points insert into `rent_buddy_bookings`. This count is
corroborated independently by the codebase's own prior audit comment at
`artifacts/api-server/src/routes/rentABuddySpec.ts:415-421`: *"There are five
creation paths; before this change two were gated."*

| # | route | file:line (handler / insert) | initial `status` |
|---|---|---|---|
| 1 | `POST /rent-a-buddy/bookings` — canonical checkout, the one the shipped app's "Book This Package" and hourly-booking flows both use | `rentABuddy.ts:999` / insert `:1310` | `"requested"` |
| 2 | `POST /rent-a-buddy/packages/:packageId/book` (`bookPackage`) | `rentABuddyMarketplace.ts:1292` / insert `:1374` | `"pending"` |
| 3 | `POST /rent-a-buddy/offers/:offerId/accept` | `rentABuddyMarketplace.ts:1024` / insert `:1083` | `"pending"` |
| 4 | `POST /rent-a-buddy/bookings/:bookingId/rebook` | `rentABuddy.ts:6230` / insert `:6306` | `"pending"` |
| 5 | `POST /rent-a-buddy/buddies/:buddyId/request` | `rentABuddySpec.ts:408` / insert `:526` | `"pending"` |

Path 1 is the only one whose initial `status` is `"requested"` rather than
`"pending"` — flagged in §4, not resolved here.

### 1.1 Canonical checkout — `rentABuddy.ts:999-1353`

**Real client flow, precisely** (correcting an initial assumption before
this investigation started): `buddy/[id].tsx:120,408` — "Book This Package"
does **not** call `createBooking` directly. It navigates to
`/(rent-a-buddy)/checkout` with `{buddyId, packageId}`. `checkout.tsx:190-194`
loads the package and sets `duration = pkg.durationH * 3600`.
`checkout.tsx:226-243` (`submitBooking`) calls `createBooking({...})` — no
`paymentMode` field is ever sent by the client.
`src/services/rentABuddy.ts:337-357` posts to `POST /api/rent-a-buddy/bookings`.

**Gate stack:** `requireRentBuddyEnabled` (:1006) → `requireBookingKyc`
(:1011) → kill switches `disable_rent_buddy_booking`/`disable_rab_bookings`
(:1015-1018) → `checkRentBuddyAccess({..., action: "book"})` (:1020-1030) →
test-booking admin check (:1033-1046) → `rent_buddy_user_limits`
(:1048-1054) → payload required-field check (:1062-1064) → cash-balance /
full-in-app / nightlife account-limit checks (:1066-1076) → launch-control
country/city/category gating, including ID verification, phone
verification, DOB/age check, full-payment-required (:1078-1148) → max
booking duration (:1150-1153) → buddy existence/active check (:1155-1161) →
self-booking block (:1164-1166) → mutual block-table check (:1168-1191) →
buddy `status`/`admin_status` check (:1193-1195) → nightlife/group
category-approval check (:1197-1206) → nightlife admin-approval check
(:1208-1214) → nightlife public-meetup-location check (:1216-1224) →
high-risk-category dual verification (arrival/nightlife require both
sides verified) (:1226-1263) → new-buddy public-location/max-hours
restriction (:1265-1282) → notes policy-violation scan (:1284-1297).

**Pricing computed:**
- `:1299-1300`: `totalUsd = round(buddyProfile.hourly_rate_usd * durationH)`.
  **This ignores the package's own price entirely, even when `packageId` is
  set.** `checkout.tsx` sets `durationH = pkg.durationH` for a package
  booking, so the server ends up charging *hourly rate × package duration*,
  not the package's flat price. `rent_buddy_packages.price_usd`
  (`artifacts/api-server/migrations/0134_rent_buddy_schema_rebuild.sql:261`)
  is a buddy-set column, independent of `hourly_rate_usd * duration_h` — a
  discounted or premium-priced package is silently mispriced by this route.
- `:1059,1066-1072`: `paymentMode` comes from `req.body.paymentMode`
  (client-supplied), default `"full_in_app"` — the **client**, not
  risk-based server logic, decides payment mode. Only two coarse
  account-level flags (`cash_balance_disabled`, `full_in_app_payment_required`)
  and one launch-control flag (`:1133`) constrain it — none of
  `calculateDeposit`'s buddy-level/traveler-history/category/risk-hold
  engine (§1.2) runs here.
- `:1301-1302`: deposit is a flat **30%** hardcode
  (`depositUsd = totalUsd * 0.3`) when `deposit_plus_cash`, or 100% when
  `full_in_app`.
- Fields `bookPackage` writes that this route never writes at all:
  `pricing_type`, `deposit_rule_applied`, `deposit_percent`,
  `deposit_reason`, `is_group_booking` — absent from the insert
  (`:1310-1334`) entirely.

**Columns written** (`:1310-1334`): `buddy_id, traveler_id, package_id,
trip_id, booking_date, start_time, duration_h, group_size, city, category,
notes, payment_mode, total_usd, deposit_usd, cash_balance_usd,
is_test_booking, expires_at, status: "requested", safety_status: "normal",
route_plan: [], updated_at`.

### 1.2 `bookPackage` — `rentABuddyMarketplace.ts:1292-1406`

**Gate stack:** `requireBookingKyc` (:1303) → kill switches (:1304-1307) →
package lookup + `admin_review_status === "approved"` (:1309-1318) →
group-size vs `max_group` (:1323) → buddy `status === "active"` +
group-approval (:1326-1327) → `checkRentBuddyAccess({..., action:
"package-book"})` (:1334-1341) → `rent_buddy_user_limits` (:1344-1346).
**No `requireRentBuddyEnabled` call anywhere in this file** — see §4.

**Inputs read:** `p.price_usd` (the package's own flat price, :1369),
`p.category`, `buddy.buddy_level` (:1358-1360); count of completed
`rent_buddy_bookings` for this traveler (:1349-1355) →
`travelerCompletedBookings`; `groupSize > 1` → `isGroupBooking` (:1363);
`limits.cash_balance_disabled` (:1364), `limits.full_in_app_payment_required`
(:1365) from `rent_buddy_user_limits`; `buddy.disable_deposit_cash` (:1366),
`buddy.cash_balance_accepted` (:1367), `buddy.risk_hold` (:1368) from
`rent_buddy_profiles`. `req.body.paymentMode` is destructured (:1320) but
**never used again** — a client-supplied payment mode is silently discarded
here; the server always computes it.

**Derivation** — the one path that fully delegates to the risk engine,
`calculateDeposit()` in `artifacts/api-server/src/services/rentBuddy/PricingService.ts:117-198`:
- Base deposit % by category/pricing-type (`:119-131`): 20% standard, 25%
  arrival, 35% nightlife, 25% content, 35% group.
- New-buddy floor: `buddyLevel === 'new'` → max(current, 35%) (`:134-138`).
- New/limited-history traveler floor: 0 completed → max(current, 40%); <3
  completed → max(current, 35%) (`:141-150`).
- Trusted-repeat reduction: ≥5 completed, non-new buddy, no risk hold, still
  at 20% → stays 20% (`:153-160`).
- Hard override to 100% full-in-app on `riskHold || cashBalanceDisabled ||
  fullInAppRequired` (`:163-173`).
- Otherwise: `depositUsd = round(totalUsd * pct/100)`, `cashBalanceDue =
  totalUsd - depositUsd`; `paymentMode = 'deposit_plus_cash'` only if
  `!disableDepositCash && buddyCashBalanceAccepted && cashBalanceDue > 0 &&
  pct < 100` (`:178-186`), else forced to `full_in_app` with the full total
  as the "deposit."

**Columns written** (`:1374-1399`): `buddy_id, traveler_id, package_id,
booking_date, duration_h, group_size, city, category, notes, payment_mode,
total_usd, deposit_usd, cash_balance_usd, pricing_type: "package",
deposit_rule_applied, deposit_percent, deposit_reason, is_group_booking,
expires_at, status: "pending"`.

### 1.3 Offer-accept — `rentABuddyMarketplace.ts:1024-1132`

**Gate stack:** `requireBookingKyc` (:1037) → kill switches (:1038-1041) →
offer lookup + `status === "pending"` + ownership check (:1044-1053) →
`checkRentBuddyAccess({..., action: "offer-accept"})` (:1058-1065) →
`rent_buddy_user_limits` (:1067-1073) → offer-expiry check (:1076-1080).
**No `requireRentBuddyEnabled` call.**

**Pricing computed:** none — **copies straight from the offer row**
(`:1097-1100`): `payment_mode: o.payment_mode, total_usd:
o.proposed_price_usd, deposit_usd: o.deposit_amount_usd, cash_balance_usd:
o.cash_balance_usd`. No `calculateDeposit` involvement.

**Upstream of that:** the offer itself is created at
`POST /rent-a-buddy/requests/:requestId/offers`
(`rentABuddyMarketplace.ts:914-973`, insert `:948-966`), where a **buddy**
supplies `proposedPriceUsd, depositAmountUsd, cashBalanceDue, paymentMode`
directly — only `proposedPriceUsd` is required to be truthy (`:942`);
nothing else is validated (no check that `deposit + cash == total`, no
`calculateDeposit` involvement at all). Path 1.3 inherits whatever the buddy
typed there, unchecked.

Also calls `createEarningsLedgerEntry` (`:1128`, see §2).

### 1.4 Rebook — `rentABuddy.ts:6230-6345`

**Gate stack:** `requireRentBuddyEnabled` (:6234) → `requireBookingKyc`
(:6240) — this file's own comment (`:6236-6239`) explains why: *"Rebook
INSERTs a new rent_buddy_bookings row, so it is a booking-creation path and
gets the same KYC gate as POST /rent-a-buddy/bookings. Without this it
would be a bypass."* → original-booking ownership + `status === "completed"`
check (:6252-6263) → buddy active check (:6266-6274) → availability/blocking
exception check (:6276-6289).

**Pricing computed:** `:6303-6304`: `totalUsd = rateUsd * newDurationH`
(hourly rate again — `package_id` is always forced `null` at `:6311`, so a
rebook can never carry package pricing forward even if the original booking
had a package). `:6322-6324`: hardcoded `payment_mode: "full_in_app"`,
`deposit_usd: totalUsd` (always 100%), `cash_balance_usd: 0` — no
client-supplied `paymentMode` is even read, and none of `calculateDeposit`'s
rules apply.

**Columns written** (`:6308-6329`): `buddy_id, traveler_id, package_id:
null, trip_id: null, booking_date, start_time, duration_h, group_size, city,
country_code, category, notes, total_usd, deposit_usd, cash_balance_usd,
payment_mode, status: "pending", safety_status: "normal", route_plan: [],
updated_at`.

### 1.5 Spec-request — `rentABuddySpec.ts:408-549`

Live, mounted route (`routes/index.ts:169`), reachable from mobile at
`/api/buddies/:buddyId/request` via the alias rewrite
(`artifacts/api-server/src/lib/specAliasRewrite.ts:20-22` rewrites
`/api/buddies/:id*` → `/api/rent-a-buddy/buddies/:id*`). **No client call
site was found anywhere in `travel-buddy-standalone/src` or `/app`** for
this route or its alias — it appears to be reachable server-side
infrastructure with no current mobile caller.

This route's own header comment (`:415-421`) is the source of the "five
creation paths" count cited in §1, and states plainly that before a prior
fix, this route "carried none of the gates the canonical
`POST /rent-a-buddy/bookings` applies" and was reachable via the mobile
alias — "a full bypass of KYC, both kill switches, the city rollout and
admin user limits." It is now gated.

**Gate stack:** `requireBookingKyc` (:428) → kill switches (:430-433) →
`checkRentBuddyAccess({..., action: "book"})` (:436-443) →
`rent_buddy_user_limits` (:445-451) → required-field validation
(:453-459) → self-booking checks, both by-profile and by-user-id
(:461-489) → mutual block-table check (:491-508) → category-availability
check (:510-514) → blocked/vacation-date check (:516-517). **No
`requireRentBuddyEnabled` call.**

**Pricing computed:** none — **`total_usd: 0, deposit_usd: 0` hardcoded**
(`:538-539`). No `payment_mode` field and no `cash_balance_usd` field are
written at all. This is the most severe of the five paths for pricing
purposes: a live, gated, mounted route that produces a **zero-priced
booking record** if ever hit.

**Columns written** (`:528-542`): `traveler_id, buddy_id, booking_date,
duration_h, city, category, notes, group_size, route_plan: [], total_usd: 0,
deposit_usd: 0, status: "pending", created_at, updated_at`.

---

## 2. Fee-rule and cash-balance logic already in the codebase

`rent_buddy_fee_rules` exists and is read, but it is **not** part of
deposit/payment_mode calculation — it is a separate, downstream concern:

- Admin-only writes: `PATCH /rent-a-buddy/admin/fee-rules`
  (`rentABuddyMarketplace.ts:2251-2270`), keyed by `buddy_level` →
  `platform_fee_percent, traveler_service_fee_usd, traveler_service_fee_pct`.
- Only consumer: `createEarningsLedgerEntry()`
  (`rentABuddyMarketplace.ts:1940-1981`), called **after** a booking already
  exists — from `bookPackage` (`:1402`) and offer-accept (`:1128`) only.
  **Not called from the canonical checkout route, rebook, or the
  spec-request route at all.** It reads the buddy's fee rule to compute
  `platform_fee_amount`/`buddy_net_estimated_amount` for
  `rent_buddy_earnings_ledger` — the buddy's *payout* math, downstream of
  and separate from the traveler's *charge*.
- Admin analytics also reads it wholesale (`:1998`) for reporting only.

No existing table-driven candidate exists for the deposit-percentage logic
itself — `calculateDeposit()` (§1.2) is entirely in-code constants.
`rent_buddy_fee_rules` is a candidate for folding into a shared service
*only if* that service is explicitly scoped to include buddy
payout/platform-fee economics — a distinct calculation from the four
traveler-facing fields (`payment_mode`, `deposit_amount`, `cash_balance_usd`,
`total_usd`) this investigation was scoped around.

---

## 3. Parity risks beyond the four pricing fields

*(Also latent-not-active per the framing note at the top of this document —
included here because a shared pricing-service extraction needs to know
about them even though they aren't strictly pricing.)*

- **Initial `status` differs** (§1 table): canonical checkout writes
  `"requested"`; the other four write `"pending"`. Any downstream
  state-machine logic keyed on initial status needs to already tolerate
  both, independent of the pricing-service work.
- **The platform "enabled" flag doesn't cover 3 of 5 paths.**
  `rentABuddy.ts:4` documents: *"All non-admin routes are gated by
  `requireRentBuddyEnabled`."* Verified: called by every handler in
  `rentABuddy.ts` (checkout `:1006`, rebook `:6234`) — but **never called
  anywhere in `rentABuddyMarketplace.ts` or `rentABuddySpec.ts`**.
  `bookPackage`, offer-accept, and spec-request rely only on the two
  kill-switch flags instead.
- **Validation asymmetry** between the canonical checkout route and
  `bookPackage`/offer-accept — detailed as FOLLOW-UP 2 below.
- **Admin kill-switch scoping gap** — detailed as FOLLOW-UP 1 below.

---

## FOLLOW-UPS

Two items filed here as their own records, not fixed in this investigation.
Both are framed the same as the rest of this document: **latent while KYC
stays hard-blocked, and both must close before KYC is restored** — restoring
KYC is what makes both of these reachable by a live booking for the first
time.

**Neither belongs inside the pricing-service extraction.** The shared
booking-pricing service being scoped from this document is pricing only:
`payment_mode`, `deposit_amount`, `cash_balance_usd`, `total_usd`. It must
not become the vehicle for importing or papering over the validation gaps
below — those are gate-stack fixes to the individual routes, made
independently, reviewed independently, before or alongside the pricing
extraction but not folded into it.

### Follow-up 1 — admin "pause all bookings" doesn't stop 2 of 5 paths

`artifacts/api-server/src/routes/rentABuddyRollout.ts`:
- `:185` — `gc.all_bookings_paused` only fires when `action === "book"`.
- `:213` — `gc.force_full_in_app` — same scoping.
- `:223` — `gc.force_public_meetup` — same scoping.

`bookPackage` passes `action: "package-book"`
(`rentABuddyMarketplace.ts:1337`) and offer-accept passes `action:
"offer-accept"` (`rentABuddyMarketplace.ts:1061`) — **neither matches
`"book"`, so neither is stopped by any of these three admin controls.** An
admin who pauses all bookings platform-wide does not actually stop package
bookings or offer-accepts from completing, and an admin who forces
full-in-app payment platform-wide does not stop those two paths from still
processing `deposit_plus_cash`. The spec-request route passes `action:
"book"` (`rentABuddySpec.ts`, matches canonical checkout) and so *is*
covered — it is specifically `package-book` and `offer-accept` that are
exempt.

### Follow-up 2 — validation asymmetry: bookPackage/offer-accept skip checks canonical checkout enforces

Canonical checkout (`rentABuddy.ts:999-1353`, full gate stack in §1.1)
enforces, and `bookPackage`/offer-accept (§1.2, §1.3) do not:
- Self-booking block (buddy cannot book themselves).
- Mutual block-table check (blocker/blocked in either direction).
- Nightlife/group category-approval check, and nightlife admin-approval
  check.
- Nightlife public-meetup-location enforcement.
- High-risk-category (arrival/nightlife) dual verification requirement.
- New-buddy public-location/max-hours restriction.
- Notes policy-violation scan.
- Full launch-control gating: country/city/category enable state,
  ID-verification requirement, phone-verification requirement, DOB/age
  check, full-payment-required-by-location.

`bookPackage` and offer-accept carry a narrower, different subset (package
or offer status, buddy active/group-approval, city/category rollout via
`checkRentBuddyAccess`, `rent_buddy_user_limits`) — none of the
launch-control, verification, self-booking, block-table, or policy-scan
checks above run on either of those two paths today.
