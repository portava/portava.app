# Portava Revenue Model — current state

*Derived from the repository, 2026-09-07. Authoritative for the commercial model only where it
cites a file; where it touches rulings it defers to `docs/discovery/ROADMAP.md`.*

**Scope boundary.** This document answers *where revenue comes from* and *what the product may
never sell*. It does not describe how money moves: the wallet, the ledger mechanics, settlement
and payout are `09_Payment_Architecture.md`. Contributor rewards, Traveler Impact and the
creator side of the economy are `07_Creator_Economy.md`. Where a mechanism belongs to those
documents it is named and not restated.

---

## The one-sentence state

**Portava has one built revenue surface — the Rent-a-Buddy marketplace — it has a commission
model expressed in three places that disagree with each other, and it collects nothing, because
no payment path exists and the marketplace's master switch is seeded OFF.** Every other revenue
line named in product discussion is unbuilt.

---

## 1. The revenue lines

| # | Line | Where it would come from | Code state |
|---|---|---|---|
| 1 | **Marketplace commission** on Rent-a-Buddy bookings | % of a booking's `total_usd`, by buddy level | **Modelled, computed, never charged.** Fee schedule in `rent_buddy_fee_rules`; per-booking estimate written by `lib/rentBuddyEarningsLedger.ts` |
| 2 | **Traveller-side service fee** on the same bookings | flat USD and/or % added to the traveller | **Schema + admin editor exist; structurally always 0** — see §2.4 |
| 3 | **Tips** | traveller → buddy, post-completion | **Built** (`routes/rentABuddyMarketplace.ts:1866`), **and Portava takes none of it** — see §2.2 |
| 4 | **Event ticketing** | selling admission to events with capacity | **Deliberately not built.** `priceType` is `"free" \| "external"` only (`routes/events.ts:486`), ticket links must point off-platform to an allowlisted host (`:3813`) — see §3.5 |
| 5 | **Subscriptions / paid tiers** | recurring consumer or buddy plans | **Not built.** No plan, subscription or entitlement table; no billing processor; no paywall — see §4 |
| 6 | **Paid placement / promoted listings** | selling rank or feed position | **Refused by design**, with the refusal enforced in code in four places — see §6 |
| 7 | **Data / intelligence licensing** | selling the place corpus or graph | **Not built and not designed.** No such surface exists in the tree |

Only line 1 has a real code path end to end, and even that path stops before money.

### 1.1 Nothing is switched on

`rent_buddy_enabled` — the marketplace master switch — is seeded **FALSE**, and that seed is the
last word in the canonical chain: `migrations/2210_rent_buddy_default_off.sql:29-31` uses
`ON CONFLICT (flag) DO UPDATE SET enabled = false`, explicitly superseding
`0090_rent_buddy_rollout_tables.sql:187-192`, which had forced it TRUE on every restore. The
migration records the owner decision verbatim: Rent a Buddy stays unavailable "until an
administrator explicitly enables it, and only after KYC, payments, safety controls, moderation,
and SOS flows are launch-ready" (`2210:3-6`). `0117_beta_feature_flags.sql:33` lists it TRUE but
is an inert `ON CONFLICT DO NOTHING` no-op, and says so in its own comment.

The gate is fail-closed: `checkRentBuddyEnabled` returns `!!data && !!data.enabled`, so a missing
row, a null client and a failed read all deny (`routes/rentABuddy.ts:157-163`, guard at `:212`).

> **What the flag's live value is, is not an in-tree fact.** Per
> `.agents/memory/migration-applied-vs-committed.md` a migration file is not evidence of
> application in either direction. The *intended and canonical* default is OFF. Do not restate
> "Rent a Buddy is live" from `docs/rent-buddy-product.md`'s July header without re-reading the
> live `feature_flags` row.

---

## 2. Take rate: the marketplace commission model

### 2.1 The intended model — a supply-side ladder

Commission is levied on the buddy, scaled by the buddy's level. The schedule is a table, one row
per level, with a unique key on `buddy_level`
(`artifacts/api-server/migrations/0048_rent_buddy_marketplace.sql:398-406`):

| `buddy_level` | `platform_fee_percent` | `traveler_service_fee_pct` |
|---|---|---|
| `new` | 25 | 5 |
| `rising` | 22 | 5 |
| `pro` | 15 | 5 |
| `elite` | 12 | 5 |
| `city_ambassador` | 12 | 5 |

(seed at `0048_rent_buddy_marketplace.sql:418-424`, repeated verbatim by
`0134_rent_buddy_schema_rebuild.sql:1208-1215`).

The design intent is legible and worth stating because nothing else in the repo states it: **the
take rate falls as a buddy earns standing.** It is a retention instrument, not a price list — the
platform charges most where it is carrying the most risk (an unproven buddy) and least where the
buddy has become the reason travellers return.

### 2.2 The arithmetic that actually runs

One shared writer computes the per-booking breakdown for all five booking-creation paths
(`lib/rentBuddyEarningsLedger.ts`, whose header lists them at `:5-11`):

```
feePercent        = fee_rules[buddy_level].platform_fee_percent ?? 22   (:60-66)
platformFeeAmount = round2(total_usd * feePercent / 100)                (:69)
buddyGross        = total_usd + tip_usd                                 (:70)
buddyNet          = round2(buddyGross - platformFeeAmount)              (:71)
```

Three consequences follow from those four lines:

- **The commission base is `total_usd` only.** Add-ons are carried in the row
  (`addons_usd`, `:79`) but are not in the fee base; the tip is added *after* the fee
  (`buddyGross = total + tip`, `:70`), so **Portava takes 0 % of tips**. That is a real
  commercial decision sitting in the code, unrecorded anywhere else.
- **Every row is an estimate.** `is_estimated: true` is hard-coded (`:90`), and the module header
  is explicit: "THIS IS NOT PAYMENT… No money moves" (`:24-28`).
- **The write is best-effort.** The booking is already committed when the ledger runs, so a
  failure is logged and swallowed (`:92`). A booking can therefore exist with no fee record at
  all. Payment mechanics and the settlement consequences of that are `09_Payment_Architecture.md`.

### 2.3 Three take rates, and they disagree

The same commission is expressed as three different constants in three files:

| Value | Where | What reads it |
|---|---|---|
| **per-level 25/22/15/12/12** | `rent_buddy_fee_rules` seed | the ledger writer, per booking |
| **22 %** | `DEFAULT_PLATFORM_FEE_PERCENT` (`lib/rentBuddyEarningsLedger.ts:37`) | fallback when the buddy's level has no fee row |
| **22 %** | `defaultFeePercent` (`routes/rentABuddyMarketplace.ts:2192`) | the buddy dashboard's fee estimate when the ledger is empty |
| **15 %** | `platformFeePct = 0.15` (`routes/rentABuddy.ts:6237`, applied `:6251`, published to the client `:6290`) | `GET /rent-a-buddy/dashboard/earnings/summary` — **for every buddy, at every level** |

So a `new` buddy is quoted **15 %** by the earnings-summary screen, has **25 %** written to their
ledger row, and sees **22 %** on the dashboard if their ledger is empty. Nothing reconciles them
and nothing fails when they diverge.

**This must be resolved before any money is charged, and the resolution is one-directional:**
`rent_buddy_fee_rules` is the schedule of record because it is the only one an operator can
change without a deploy; the two literals are drift. `routes/rentABuddy.ts:6237` in particular is
not a default — it ignores the buddy's level entirely.

### 2.4 The traveller-side fee is structurally zero

The ledger reads `traveler_service_fee_usd` (`lib/rentBuddyEarningsLedger.ts:67`). Both seeds
populate only `traveler_service_fee_pct` (`0048_rent_buddy_marketplace.sql:418`,
`0134:1208`), leaving `traveler_service_fee_usd` at its column default of `0`
(`0048:402`). **No code anywhere reads `traveler_service_fee_pct`** — the only non-type,
non-test references are the admin write (`routes/rentABuddyMarketplace.ts:2579`) and the admin
screen (`travel-buddy-standalone/app/(rent-a-buddy)/admin/fee-rules.tsx:89`).

So `traveler_service_fee_amount` is 0 on every ledger row unless an admin has hand-set the USD
column. **Revenue line 2 does not exist today**, and the 5 % in the seed is a number nothing can
act on.

### 2.5 The level ladder is partly unreachable

`buddy_level` defaults to `'new'` (`0134_rent_buddy_schema_rebuild.sql:184`). It has exactly two
writers:

- `PATCH /rent-a-buddy/admin/buddies/:buddyId/level` — which validates against
  `['standard', 'pro', 'elite']` (`routes/rentABuddy.ts:4605`), and
- `POST /rent-a-buddy/admin/profiles/:id/city-ambassador` — which sets
  `city_ambassador` or `elite` (`routes/rentABuddyMarketplace.ts:2465`).

Cross-referencing against the fee schedule:

- **`'standard'` is not a level in the fee table.** An admin who sets it moves the buddy to the
  22 % fallback (`rentBuddyEarningsLedger.ts:66`) — silently, because a missing fee row is
  indistinguishable from a deliberate 22 %.
- **`'rising'` has a fee row and no writer.** The 22 % rung can never be reached by promotion.
- There is **no automatic progression** anywhere: no route, migration or scheduler moves a buddy
  up the ladder on volume, rating or tenure. The retention instrument in §2.1 is entirely manual.

This is the same defect family as the writerless gate already documented in-tree at
`routes/rentABuddy.ts:1522-1543` (`new_buddy_public_only` / `new_buddy_max_hours` have no writer,
so every buddy is permanently capped at 2 hours per booking). **Promotion is an unbuilt product
decision, not an oversight to patch inside a fee change.**

### 2.6 A risk worth naming: an unseeded fee schedule fails the same way an unseeded flag does

`rent_buddy_fee_rules` appears in **no file in the canonical migration chain**
(`artifacts/api-server/src/migrations/`). Its DDL and seed exist only in
`artifacts/api-server/migrations/`, which `src/scripts/frozenMigrationRoots.ts:73-75` records as
the *frozen legacy root*. The table itself is real — it is present in the 2026-08-19 production
baseline (`artifacts/api-server/baseline/20260819_baseline_structure.sql:9062`) — but that
baseline is schema-only, so **whether the five seed rows are present in production is not
established anywhere in this repository.**

If they are absent, every booking settles at the 22 % fallback and nothing reports it. That is the
`.agents/memory/unseeded-feature-flag-gates.md` failure shape applied to pricing: *the absence of
a row is indistinguishable from a deliberate value*. Verify with a live query before quoting a
take rate to a buddy.

---

## 3. Booking economics

### 3.1 How a booking is priced

The canonical path (`POST /rent-a-buddy/bookings`) prices from the buddy's own rate:

```
rateUsd  = buddy.hourly_rate_usd                    routes/rentABuddy.ts:1577
totalUsd = round2(rateUsd * durationH)              :1578
```

The buddy sets `hourly_rate_usd` themselves (`:3689`, `:4044`) and **nothing validates it against
any range.** `rent_buddy_pricing_rules` — the admin table holding `suggested_min_usd` /
`suggested_max_usd` (`0134:1162-1174`) — has **zero readers and zero writers in `src/`**; the only
references are the RLS disposition list and the generated types. It is dead schema.

What actually answers `GET /rent-a-buddy/pricing/suggestion` is a hard-coded table in code —
per-category bands, city multipliers (`tokyo: 1.3` … `bali: 0.7`) and level multipliers
(`new: 0.8` … `city_ambassador: 1.5`) in `services/rentBuddy/PricingService.ts:44-67`. Its own
header states the contract: the suggestion is "shown to Buddy only, **never enforced**"
(`PricingService.ts:5-6`).

**Portava therefore sets no prices.** It publishes non-binding guidance and takes a percentage of
whatever the two parties agree. That is the commercial posture, and it is worth being deliberate
about: it keeps Portava out of price-fixing and out of the buddy's pricing autonomy, at the cost
of any pricing floor that would protect the take rate.

### 3.2 Deposit split, and the second engine

`payment_mode` is `full_in_app | deposit_plus_cash` (`0134:336`). The canonical route hard-codes
the split:

```
depositUsd     = paymentMode === "deposit_plus_cash" ? round2(totalUsd * 0.3) : totalUsd
cashBalanceUsd = totalUsd - depositUsd                          routes/rentABuddy.ts:1579-1580
```

The `0.3` is a literal. `rent_buddy_launch_controls.min_deposit_pct` exists, defaults to 30
(`0134:1345`) and is **write-only** — an admin can set it (`routes/rentABuddy.ts:5428`, `:5445`)
and nothing reads it. Meanwhile the marketplace booking paths (offer-accept, package-book) call a
*different* engine, `calculateDeposit`, which applies risk rules
(`routes/rentABuddyMarketplace.ts:1610`, `:1828`). **Two booking paths, two deposit policies.**
Reconciling them is `09_Payment_Architecture.md`'s work; recorded here because the split
determines how much of a booking is ever collectible in-app, and therefore how much of the take
rate is enforceable rather than trust-based.

Its sibling `full_payment_required` **is** read and enforced (`routes/rentABuddy.ts:1280`,
`:1322`) — so a market can be forced fully in-app, which is the one lever that would make the
commission collectible per booking.

### 3.3 No money moves

Both payment endpoints return **503** and refuse to mark anything paid:

> `POST /rent-a-buddy/bookings/:bookingId/pay-deposit` and `/pay-full` →
> `{ error: "payment_not_available", payment_stub: true }` — "In-app payment is not yet
> available. Payment arrangements are agreed directly with your Buddy after booking confirmation
> — no charge is made through the app." (`routes/rentABuddy.ts:1686-1704`)

The comment above them states the reason: return 503 "so no booking is ever marked 'paid' and no
false milestone notification is sent to the traveler" (`:1687-1688`). The buddy dashboard says the
same to the buddy: "All figures are estimates. Cash balance is tracked but not charged. **Payout
system not connected.**" (`routes/rentABuddyMarketplace.ts:2199`), and each ledger row carries
"Estimated — payout not processed" (`:2266`).

There is **no payment processor in the tree at all**. The only Stripe references are Stripe
*Identity* (KYC) adapters, and they are stubs whose every method throws
(`services/identityVerification/providers.ts:46-59`), with production explicitly barred from the
mock (`:108`).

**Consequence for the revenue model: the take rate is currently an accounting fiction.** Bookings
are real, the fee is computed, and the money is settled between two people in cash, off-platform,
where Portava's commission is uncollectible. Any revenue forecast built on booking volume today
is measuring GMV that the platform has no path to touch.

### 3.4 Market availability gates the revenue, not the code

Bookings are deny-by-default once any launch control exists: a booking whose (country, city,
category) matches no control is refused `location_unavailable`
(`routes/rentABuddy.ts:1246-1252`, and the deny-by-default no-match branch at `:1284-1297`). Categories are seeded
globally with `nightlife` waitlist-only and `group`/`concierge` disabled pending pilot
(`0134:1358-1373`). Launch cities are Cebu, Manila and Davao City at `public_mvp`
(`0092_seed_rent_buddy_launch_cities.sql:40-45`, into `rent_buddy_city_rollouts`).

**The addressable market for line 1 today is three Philippine cities.** Sizing anything against a
global TAM is not supported by the code.

### 3.5 Events: capacity without commerce

Events carry real capacity and demand signal — `max_attendees`, `going_count`, waitlist,
auto-transition when full (`routes/events.ts:289-315`, `:2671-2676`; field names per
`.agents/memory/events-api-field-names.md`: `maxAttendees`, `goingCount`, camelCase from
`formatEvent`). That is the shape of a ticketing business, and it is **deliberately not one**:

- `priceType` is `z.enum(["free", "external"])` — on create (`:486`) and update (`:520`). There is
  **no "paid on Portava" value.**
- `priceUrl` must resolve to one of eight allowlisted third-party ticketing hosts — Eventbrite,
  Ticketmaster, DICE, RA, StubHub, AXS, TicketWeb, Universe (`:3813-3816`), enforced on create
  (`:571`), on publish (`:1744`, `:4220`) and on update.
- `priceUrl` is not even public: it is returned only to the host and participants (`:3784-3786`).

So Portava hands paying attendees to someone else and keeps none of it. That is a defensible
current-state choice (no payments, no refunds, no chargeback exposure, no event-organiser
liability) and it is the **largest unexercised revenue option in the product**: capacity, RSVP
funnel and attendance already exist; only the money does not. Turning it on is a payments
decision (`09`) plus a policy decision, not a discovery one.

---

## 4. Subscriptions and tiers

### 4.1 What exists: nothing

There is no subscription in this codebase. Specifically, and verified by search across
`artifacts/api-server/src`, `travel-buddy-standalone/src` and `travel-buddy-standalone/app`:

- no `subscriptions`, `plans` or `entitlements` table, and no such migration;
- no billing or IAP integration — no Stripe Billing, RevenueCat, StoreKit or Play Billing;
- no paywall component, checkout-for-a-plan flow, or "upgrade" surface. The only `checkout` route
  in the app is the Rent-a-Buddy booking form
  (`travel-buddy-standalone/src/components/BuddyCard.tsx:80`);
- every `subscription` hit in the tree is a realtime channel subscription.

### 4.2 The naming trap: "premium" in this repo means rendering, not paying

`0177_stamp_premium_foundation.sql` is **not** a monetisation migration, despite the name. It is
the Stamp Wave 1 *composition engine* foundation: destination palettes, rarity tiers, artwork QC,
thumbnails, behind `stamp_premium_rendering_enabled`, seeded FALSE (`0177:117`). "Premium" there
describes the artwork pipeline — AI hero art plus server-composited borders and typography — and
the same usage runs through `lib/stamps/generationWorker.ts:963-1042`,
`lib/visuals/promptBuilder.ts:85` and `routes/passport.ts:1030`.

Nothing in the stamp system is purchasable. `edition_size` and `is_limited` (`0177:74-75`) are
scarcity of *earning*, not of buying.

**Anyone reading this repo for a paid tier will find the word "premium" ~40 times and no product
behind it. Say so once here so it is not rediscovered.**

### 4.3 The only real tier is supply-side

`buddy_level` (§2.5) is the sole tier construct that changes anyone's economics, and it runs the
opposite way to a subscription: **the tier is granted by Portava and it lowers what the user
pays.** It is earned standing, not purchased access. A future consumer subscription would be a new
axis, not an extension of this one — and it must not be allowed to collapse into it, because a
buddy who could *buy* `elite` would be buying a 12 % take rate and a search-ranking position at
the same time (`GET /api/buddies` sorts `featured DESC, average_rating DESC, review_count DESC`,
per `docs/rent-buddy-product.md`; `featured` is admin-only — `routes/rentABuddy.ts:4575`).

### 4.4 If a tier is ever built, this is how the entitlement check must work

There is no entitlement primitive. The only capability primitive is the feature flag, and it
exists in two fail-closed readers:

| Reader | Behaviour on unknown / error | Citation |
|---|---|---|
| server `isFlagEnabled(sc, flag)` | `false` on error, `false` on missing row | `lib/featureFlags.ts:14-26` |
| client `FeatureFlagsContext.isEnabled(key)` | `false` on unknown key or failed fetch — "entry points are hidden rather than crashing" | `travel-buddy-standalone/src/context/FeatureFlagsContext.tsx:5-7`, default at `:37` |

**The governing hazard, and it has already fired here.** Per
`.agents/memory/unseeded-feature-flag-gates.md`, a flag key referenced in code — even mocked
`true` in green tests — but never inserted into the live `feature_flags` table is permanently
`false`, with **no error and no log**, and is indistinguishable from "feature not built yet."
`migrations/2300_phantom_feature_flag_rows.sql` is the recorded case: five such rows, including
`PORTAVA_PUBLISHER_BOOST_ENABLED` and `PORTAVA_FEATURED_BOOST_ENABLED`, read by
`services/ranking/MediaFeedRankingService.ts:888-896` and by `routes/mediaFeed.ts`, seeded by
nothing in the canonical chain. `2300:49-58` is worth quoting because it decides a question this
document will otherwise be asked: a seed for `PORTAVA_PUBLISHER_BOOST_ENABLED` *does* exist, in
`artifacts/api-server/supabase/migrations/` — and **"a seed in a directory nothing runs is not a
seed."**

Three rules follow for any tier gate:

1. **A tier gate that is never seeded silently disables the paid feature for every paying
   customer.** The subscriber is charged and the entitlement reads `false`. There is no
   distinguishable failure — this is the "absence of evidence must never silently become evidence
   of absence" invariant (ROADMAP) with a receipt attached.
2. **Do not build entitlement on the flag table.** A flag is a global on/off; an entitlement is
   per-user and time-bounded. Overloading one on the other produces a boolean that cannot express
   "this user's plan lapsed on Tuesday." An entitlement store is unbuilt and needs designing
   alongside `09`.
3. **Fail-closed stays fail-closed, and the migration must carry a postcondition** that RAISEs if
   the row is absent — the pattern `2300:145-165` and `2289:70-74` already use.

---

## 5. Pricing and currency

### 5.1 Everything commercial is USD, by column

The marketplace has no currency dimension at all. Money is carried in USD-suffixed numeric
columns — `total_usd`, `deposit_usd`, `cash_balance_usd`, `hourly_rate_usd`, `extra_usd`,
`amount_usd`, `platform_fee_amount`, `traveler_service_fee_usd` (`0134:337-339`, `:374`,
`0048_rent_buddy_marketplace.sql:436-449`). There is **no `currency` column on
`rent_buddy_bookings`, on the fee rules, or on the earnings ledger**, and the pricing-guidance
table is hard-coded in USD (`PricingService.ts:44-56`).

For a marketplace whose only launch market is the Philippines, this means the buddy quotes USD,
the traveller pays cash in PHP at whatever rate the two of them agree, and the ledger records a
USD figure that was never a USD transaction. **Multi-currency is not a v2 nicety; it is a gap in
the revenue record.**

### 5.2 Currency machinery exists — for the traveller's budget, not for Portava's money

Two migrations named in the brief are often misread as pricing infrastructure. They are not:

- **`0183_budget_fx_conversion.sql`** adds `budget_fx_conversion_enabled`, seeded **FALSE**
  (`:15-17`). It converts *trip cost-estimate bands* into the traveller's home currency when
  `?home=<ISO4217>` is passed. The rates are ECB reference rates in `fx_rates`, base EUR
  (`lib/fx.ts:1-8`), and the honesty contract is explicit: conversions carry an "indicative"
  disclaimer (`FX_DISCLAIMER`, `lib/fx.ts:20-21`) and `convert()` returns **null** rather than
  fabricating a number when a currency is missing (`:11-14`, `:71`).
- **`0185_seed_price_baselines.sql`** seeds `price_baselines` — 24 global rows plus 64 countries
  of curated per-day cost bands across lodging/food/transport/activities/nightlife/other at four
  tiers. These are what a *trip costs a traveller*, not what Portava charges. The migration marks
  every row `confidence='curated'` and states it is "NOT a live cost-of-living feed", to be
  replaced by a licensed provider later (`0185:12-16`). Before it, every trip estimate returned
  `no_baseline_data` (`0185:3-5`, reason enum at `lib/tripBudgetIntel.ts:255`).

**The reusable asset is the honesty contract, not the rates.** `fx.ts` already refuses to invent a
conversion and labels the ones it makes. When marketplace money becomes multi-currency, it should
adopt that contract — and it will need a *transactional* rate (the rate at which a booking was
struck, stored on the row), not an indicative one. ECB reference rates are correct for "roughly
what will this trip cost you" and wrong for "what do we owe this buddy."

### 5.3 Nothing in the budget engine touches the take rate

`price_baselines` and `fx_rates` have no reader in any Rent-a-Buddy path. `PricingService`'s city
multipliers are an independent hard-coded table. There is no connection between what the platform
knows a city costs and what it suggests a buddy charge there — an obvious, unbuilt link, noted
because it looks built and is not.

---

## 6. Non-goals — what Portava will not monetise, and why

These are not aspirations. Each is already enforced somewhere in the code, and the enforcement is
the reason to state them: they are load-bearing and must not be traded away for a revenue line.

### 6.1 Ranking is never purchasable

**This is the hard boundary.** The moment a merchant can pay for position, every ranking signal
becomes a price signal and the discovery corpus stops being evidence about the world. Four
independent enforcements already exist:

- **Compass's two scores are structurally independent.** `computeCommunityScore(item)` takes
  *only the item* — it has no viewer parameter, so it cannot contain viewer inputs
  (`compass/CompassRecommendationEngine.ts:69`). `computeCompassMatch(item, profile, …)` is
  labelled "personal fit — popularity-independent" (`:93`) and contains no popularity term
  (`:145`). Per `.agents/memory/compass-dual-score-ranking.md`, tests assert the independence in
  both directions, and "Why this?" may only be built from stored `RankingFactor[]` — the
  delivery-time snapshot, never a recomputation. **A paid boost has nowhere to enter either
  score without breaking a test.** Keep it that way.
- **Paid contributions never become reputation.** `PassportReputationService.ts:81-86` defines
  `isPaid(metadata)` and `:171` skips those rows entirely: "§20 rule 1: a paid/sponsored
  contribution never inflates a factual count." The client enforces it a second time — the
  contribution card's normaliser is "a closed ALLOW-LIST… PAID contributions are never surfaced
  as reputation. There is no field on the returned shape for paid/purchased activity"
  (`travel-buddy-standalone/src/services/passportContributions.ts:15-24`). **Two independent
  layers, deliberately.**
- **A disclosed commercial relationship downgrades epistemic standing, it does not buy it.**
  Intel capture records a non-`none` commercial disclosure under the **non-independent**
  `sponsored` source class, which "keeps a disclosed-commercial report out of independent
  community consensus — it never overwrites confidence, only its epistemic standing"
  (`services/intel/IntelCaptureService.ts:394-399`), and `sponsored` resolves to the
  `"sponsored"` source label, never to `"consensus"` (`:453-462`). Fail-closed: an omitted
  disclosure is `'none'`.
- **Featured placement is editorial and admin-only.** `portava_featured` is written only through
  `routes/adminFeatured.ts` behind a role check, and `2160_portava_featured_write_boundary.sql`
  revokes anon/authenticated table-level INSERT/UPDATE (`:39-42`). ⚠ That migration is marked
  **"STAGED. Apply to portava-ci ONLY. DO NOT APPLY TO PRODUCTION without owner approval"**
  (`2160:3`), so the boundary's production status is an open item, not a settled fact — it is the
  single most important thing to verify before any "featured" surface is described as safe.
  Separately, the boost it feeds is inert: `PORTAVA_FEATURED_BOOST_ENABLED` and
  `PORTAVA_PUBLISHER_BOOST_ENABLED` are seeded **false** (`2300:125-133`).

**And the ranker itself is on owner HOLD** (ROADMAP ruling 4; `06_Recommendation_Engine.md`), with
the modifier machinery behind `discovery_ranking_modifiers_enabled` seeded OFF and a migration
postcondition that RAISEs if it is ever seeded on (`2289:70-74`). Phase F is **FROZEN and not
agent work**. **No commercial requirement may be used as a reason to move that hold.** A revenue
document is exactly the pressure that ratchets are built to resist.

### 6.2 Attention is not the product

There is no ad server, ad slot, sponsored-post type, or promoted-listing surface anywhere in the
tree. The only `sponsored` identifier in the codebase is the *penalty* class in §6.1. Building an
ad surface would require inventing a ranking input whose value to Portava rises with how little
the viewer wanted it — the exact inversion of `portavaRank`'s actionability weight, which is the
highest single weight in the vector at 0.9 (`06_Recommendation_Engine.md`).

### 6.3 Safety is never a paid feature

The safety layer — Safe Return, check-ins, emergency phrase, the policy scanner, dispute windows,
verification gates — is gated on risk, never on plan. High-risk categories require *verification*
of both parties, not payment (`docs/rent-buddy-product.md`; enforced at booking creation via the
high-risk gate, `routes/rentABuddy.ts:1386-1394`; per-market ID/phone/age gate, `:1256-1275`). A tier that unlocked a safety control
would price a person's safety by their willingness to pay, and would make the disclosure and
verification gates negotiable. **Never tier: safety, moderation, dispute access, or the ability to
report.**

### 6.4 Off-platform payment solicitation is policed — as integrity, not as revenue protection

The policy scanner flags `off-app`, `pay outside`, "venmo me", "PayPal me" into
`rent_buddy_policy_flags` and blocks severe matches at booking creation
(`docs/rent-buddy-audit.md` §safety; `routes/rentABuddy.ts:1561-1575`). Worth stating the reason
precisely, because the honest one is stronger: **a booking taken off-platform loses the dispute
window, the safety check-ins, the emergency contact snapshot and the audit trail.** The lost
commission is the smaller harm — and while §3.3 holds, there is no commission to lose, so the
rule stands on the safety argument alone.

### 6.5 Nothing about a user's data is sold

No surface, table or route exists for licensing the place corpus, the intelligence graph or
behavioural data, and none should be designed before the privacy contracts in
`05_Graph_Engine.md` are read: graph builders already refuse to admit member-authored circle
names, `only_me` memories and person-to-person edges. Those refusals exist for the user's sake,
not the buyer's, and a data product would immediately be in tension with all of them.

---

## 7. What is NOT built, and why

| Not built | Why it is not built |
|---|---|
| **Payment collection** (`pay-deposit`, `pay-full`) | Deliberate 503 stub so no booking is falsely marked paid (`routes/rentABuddy.ts:1686-1704`). Design is `09_Payment_Architecture.md`. |
| **Payouts / disbursement** | Admin hold/release routes exist over `rent_buddy_payouts` (`routes/rentABuddySpec.ts:2155-2225`); disbursement does not. `09`. |
| **Traveller service fee** | Schema present, `_usd` column never seeded, `_pct` column never read (§2.4). |
| **A single take rate** | Three disagreeing constants (§2.3); reconciliation is a product decision, not a refactor. |
| **Buddy level progression** | No writer for `rising`, no automatic promotion, admin route accepts a level with no fee row (§2.5). |
| **Subscriptions / tiers / entitlements** | No table, no processor, no paywall (§4.1). An entitlement store must be designed with `09`, not bolted onto `feature_flags` (§4.4). |
| **Event ticketing revenue** | Capacity exists; `priceType` admits only `free`/`external` and ticket links must leave the platform (§3.5). |
| **Multi-currency commercial records** | USD-only columns; FX exists only for trip-budget display (§5). |
| **Pricing enforcement** | `rent_buddy_pricing_rules` has zero readers; guidance is advisory by design (§3.1). |
| **Paid ranking, ads, paid reputation, data licensing** | Refused. Four enforcements in code, and the ranker is on owner HOLD (§6). |
| **Any revenue at all, today** | The marketplace master switch is seeded OFF (§1.1) and no payment path exists (§3.3). |

---

## 8. Reading order for anyone changing this

1. `docs/discovery/ROADMAP.md` — the owner rulings. Ranker **HOLD**, Event Truth **gated**, Phase F
   **FROZEN + not agent work**. Nothing in this document may be used to move any of them.
2. `09_Payment_Architecture.md` — before touching a fee, deposit, ledger or payout.
3. `07_Creator_Economy.md` — before touching rewards, Traveler Impact or contributor standing;
   §6.1's paid-contribution exclusions are shared surface.
4. `docs/rent-buddy-product.md` and `docs/rent-buddy-audit.md` — the marketplace's own docs. Both
   carry July 2026 headers and predate `2210`; treat their "Status: Live" and their route
   inventory as historical until re-verified.
5. `.agents/memory/unseeded-feature-flag-gates.md` and
   `.agents/memory/migration-applied-vs-committed.md` — before asserting that any gate, flag or
   seed row is in force.
