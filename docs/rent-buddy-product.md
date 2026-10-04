# Rent a Buddy — Product Documentation

**Last updated:** 2026-10-04 (reconciled sentence by sentence against the code; see "How this document was reconciled" at the foot)  
**Status:** Built, and **off by default**. The master switch `rent_buddy_enabled` is seeded `false` (`artifacts/api-server/src/migrations/2210_rent_buddy_default_off.sql`) and an administrator must turn it on. Booking creation is additionally refused while identity verification is not operational. No money moves: no payment processor is connected.

---

## Overview

Rent a Buddy is a social travel companionship marketplace built into Travel Buddy. Travelers can book local companions for city tours, language support, arrival assistance, nightlife guidance, shopping help, content creation, and more. It is **not** a dating, escort, or adult service — these use cases are blocked by the safety layer.

---

## Governing decisions (owner rulings, 2026-10-04)

These rulings govern the product. Each is marked with what the code does today. Where the two differ, the ruling is the requirement and the gap is listed — this document does not describe the gap as if it were the design.

| Ruling | Status in code |
|--------|----------------|
| **No unverified bookings.** Identity verification, and payment-provider verification, are required before someone can offer or book the service. Where valid verification cannot be provided the feature stays unavailable. | **Partly implemented.** While no identity provider is operational, every booking-creation path answers `503 verification_unavailable` (`lib/rentBuddyKycGate.ts`). Once a provider is operational, a verified ID is required for the high-risk categories and wherever a launch control sets `require_id_verification` (the default for a new control) — not yet unconditionally for every booking, and not yet as a condition of *offering*. Payment-provider verification does not exist: no provider is connected. The override flag `rent_buddy_allow_bookings_without_kyc` contradicts this ruling; it is seeded `false` and must stay `false`. |
| **Adults only.** Only adults who pass identity verification, provider onboarding and safety checks may be paid; no payments for minors. | **Partly implemented.** A traveller whose verified identity record says they are under 18 is refused on every booking-creation path, whether or not a launch control matches. Minimum ages (18; 21 for nightlife by default) are enforced where a launch control matches. Nothing is paid to anyone, so the payout half is not built. |
| **Commission: 10 % of the pre-tax service price, shown before checkout.** A starting value, configurable by product and market. | **Implemented**, with one thing for the owner to decide — see "Money" below. The rate is configuration read by the database, the checkout screen shows it before a request can be sent, and 10 is what applies when nothing is configured. The stored fee schedule holds other values and was deliberately not changed. |
| **No platform commission on tips.** | **Implemented.** A tip is recorded as one pair of ledger entries from traveller to buddy and no commission entry exists for it. |
| **No deposit in the first release.** | **Implemented in what is charged and shown** — nothing is charged, and no screen says a deposit is taken or collected. **Not yet removed from the booking's stored terms:** a booking still carries a payment mode and a stored in-app / cash split (see "Money"). |
| **Refunds.** Full refund when the provider cancels, the service is unavailable, or a safety issue is upheld; full refund for a cancellation before the service begins; cancellations after it begins go through support and local rules. Fees or deposits are never promised to be non-refundable. | **Not implemented as refunds** — there is nothing to refund, because nothing is collected. **Implemented in the record:** when a booking is cancelled, declined, expires, or a dispute is resolved for the traveller, its earning entries are reversed in the same database transaction. The app no longer says a deposit is forfeited. |
| **Payments stay in test mode** until payment, identity and tax readiness are established. | **Holds.** `pay-deposit` and `pay-full` answer `503`; no processor is installed. |

---

## Feature Flags

`rent_buddy_enabled` is the master switch. **Every non-admin route that creates or changes Rent a Buddy state is gated by it** and answers `403 feature_disabled` while it is off; a test enumerates the handlers and fails if one is added without the gate (`artifacts/api-server/src/test/rentBuddyHandlerGating.test.ts`).

Routes that only **read** are, for the most part, not gated — a deliberate, recorded choice (routine decision, 2026-10-04):

- The switch exists to stop the product creating state. It is not a privacy control, and it is turned off precisely when something is wrong.
- A buddy must still be able to read the record of work already done — their bookings and their earnings — while the lane is paused. Hiding it would turn "paused" into "your history is gone".
- Safety reads (an active session, a safety check-in, a report) must never depend on a marketing switch.
- The launch-status and waitlist reads are how the app explains *why* the feature is unavailable.

Admin and moderation routes are not gated by the switch either: they are how the lane is operated while it is off. They require the admin role.

| Flag | Controls | Seeded |
|------|---------|--------|
| `rent_buddy_enabled` | Master switch — every non-admin write | `false` |
| `RENT_BUDDY_NIGHTLIFE_ENABLED` | Nightlife category availability | — |
| `RENT_BUDDY_PACKAGES_ENABLED` | Package bookings | `false` |
| `RENT_BUDDY_OFFERS_ENABLED` | Accepting an offer on a request | — |
| `RENT_BUDDY_GROUP_BOOKINGS_ENABLED` | Group bookings | — |
| `rent_buddy_allow_bookings_without_kyc` | Lets bookings through while identity verification is not operational. Contrary to the owner ruling above; keep `false`. | `false` |
| `disable_rent_buddy_booking`, `disable_rab_bookings` | Emergency stops for booking creation (both names are honoured) | off |
| `safe_return_enabled` | Safe Return (a shared platform feature, not a Rent a Buddy flag) | — |

Two flags this document used to list are read by **no code** and have been removed from it: `rent_buddy_stamps_enabled` and `rent_buddy_safe_return`. Safe Return is gated by `safe_return_enabled`. The `top_rated_buddy` stamp is not gated by a flag at all — see "Review System".

**Flags fail closed.** A capability flag that is missing, or that cannot be read, is treated as **off** (`lib/featureFlags.ts#isFlagEnabled`; the master switch reader in `routes/rentABuddy.ts` likewise). An emergency stop that cannot be read is treated as **engaged** (`isKillSwitchEngaged`): a database problem stops bookings rather than opening them. `safe_return_enabled` is read as on / off / unknown, and unknown is refused. (This document previously said the flags fail open. They do not.)

---

## Service Categories

| Category | Risk Level | Verification Required |
|----------|-----------|----------------------|
| `arrival` | High | Both buddy and traveler must be verified |
| `nightlife` | High | Both buddy and traveler must be verified + admin nightlife approval |
| `adventure` | Medium | Advisory only (no hard gate) |
| `wellness` | Medium | Advisory only (no hard gate) |
| `city` | Low | None beyond the booking gates below |
| `language` | Low | None beyond the booking gates below |
| `food` | Low | None beyond the booking gates below |
| `shopping` | Low | None beyond the booking gates below |
| `culture` | Low | None beyond the booking gates below |
| `content` | Low | None beyond the booking gates below |
| `nature` | Low | None beyond the booking gates below |
| `other` | Low | None beyond the booking gates below |

**High-risk enforcement:** At booking creation, if a category is `arrival` or `nightlife`, both the buddy (`rent_buddy_profiles.verification_status = 'verified'` or `id_verified AND phone_verified`) and the traveler must be verified. The API returns `{ error: "verification_required", side: "buddy" | "traveler" | "both" }` on failure.

"None" in this table means the category adds no requirement of its own. Every booking, in every category, still passes the identity gate, the launch controls and the age checks described under "Governing decisions" and "Launch Controls".

---

## Booking Lifecycle

The status column has fourteen values. The sets the code keys on are defined once, in `artifacts/api-server/src/lib/rentBuddyBookingStatus.ts`.

```
requested ─┐                                             ┌→ completed
pending  ──┴→ scheduled → in_progress ─┬→ completed_pending_traveler_confirmation ─┤
   │              │            │       │                                           └→ disputed
   │              │            │       └→ completed            (the traveller ends the session)
   │              │            └→ no_show_pending → disputed   (after a 2-hour grace period)
   │              └→ cancelled_by_traveler | cancelled_by_buddy
   ├→ declined
   ├→ cancelled_by_traveler | cancelled_by_buddy
   └→ expired                                                  (after expires_at)

disputed → completed    (an admin resolves the dispute for the buddy)
disputed → cancelled    (an admin resolves the dispute for the traveller)
```

Key transitions:
- **requested / pending** — the traveller submits a booking request and it awaits the buddy. The canonical route (`POST /api/rent-a-buddy/bookings`) writes `requested`; the other four creation paths (rebook, the spec request, accepting an offer, booking a package) write `pending`. Both mean the same thing and every guard accepts both.
- **The buddy has 24 hours to accept.** A request not answered by its `expires_at` is moved to `expired` by the request sweeper. The canonical route sets `expires_at` 24 hours ahead (`BUDDY_ACCEPT_WINDOW_HOURS`). A package booking may expire sooner — 15 minutes when the buddy is marked available now, 1 hour for a same-day booking, otherwise 24 hours. *Known gap:* rebook, the spec request and offer acceptance write no `expires_at`, so those requests do not expire.
- **scheduled** — the buddy accepts; the session is confirmed. (`confirmed` exists in the enum and is accepted by guards for old rows; nothing writes it.)
- **declined** — the buddy declines the request.
- **cancelled_by_traveler / cancelled_by_buddy** — either party cancels before the session. A user cancellation never writes plain `cancelled`.
- **in_progress** — the buddy or the traveller starts the session at the meetup.
- **completed_pending_traveler_confirmation** — the buddy marks the session complete; the traveller has 24 hours to confirm or dispute.
- **completed** — the traveller ended or confirmed the session, or the 24-hour window closed without a dispute (auto-completed by the sweeper).
- **no_show_pending** — a no-show was reported; after a 2-hour grace period the sweeper opens a dispute.
- **disputed** — either party raised a dispute, or a no-show escalated.
- **cancelled** — written only by admin dispute resolution, when the dispute is resolved for the traveller.
- **expired** — the buddy did not answer in time.

When a booking reaches `cancelled`, `cancelled_by_traveler`, `cancelled_by_buddy`, `declined` or `expired`, its earning entries are reversed in the same database transaction as the status change (see "Money").

---

## Money

**No money moves.** No payment processor is connected, `pay-deposit` and `pay-full` answer `503`, nothing is charged through the app, and nothing is paid out. Everything below is a *record* — an estimate of what a booking would earn — kept so that it is already correct when payment arrives.

### The ledger
- Every booking has **ledger entries** (`rent_buddy_earnings_entries`: append-only, signed, in minor units, double-entry) and one **summary row** (`rent_buddy_earnings_ledger`) that is the sum of those entries.
- Both are written by one database function, `rb_post_booking_ledger` (migration `3824_rent_buddy_ledger_posting.sql`), in one transaction, and it is safe to call twice for the same event. The API computes no fee, net or total itself.
- **A booking is not created without its ledger.** All five creation paths post the ledger immediately after inserting the booking; if that fails the booking is withdrawn and the request answers `503` with a named error (`ledger_unavailable`, `ledger_write_failed` or `ledger_refused`). There is no fallback that writes the figures another way.
- Entries are never updated or deleted. A cancelled, declined or expired booking, and a dispute resolved for the traveller, append exact reversing entries.
- Every summary row is marked `is_estimated`. Only a settlement entry — which must name a payment provider and its reference — can clear it, and no route can write one. Until a provider exists, "collected in app" is `0` everywhere.

### Commission
- **10 % of the pre-tax service price** is the starting value (owner ruling). The base is the booking's `total_usd`; no tax is computed anywhere, so that is the pre-tax price. The commission is taken from the buddy's earnings — nothing is added to the price the traveller sees.
- The rate is **configuration**, resolved by the database most-specific first:
  1. a **market / product override** — `platform_fee_percent` on a launch control for the country, city and category (admin: Launch Controls);
  2. the **fee schedule** for the buddy's level — `rent_buddy_fee_rules` (admin: Marketplace → Fee rules);
  3. **10**, when neither exists.
- **For the owner:** the stored fee schedule holds 25 / 22 / 15 / 12 / 12 % by buddy level, not 10. While those rows exist they are what applies — the migration did not rewrite live configuration. Making 10 % the rate in force means clearing or changing those rows, or setting overrides. That is a decision about live pricing and is not made by this document or by the code.
- A booking keeps the rate it was priced at; changing configuration does not re-price it.
- **Shown before checkout:** the booking form shows the commission that applies to this buddy and category, from `GET /api/rent-a-buddy/buddies/:buddyId/commission`, and a request cannot be sent until it has loaded. A buddy sees their rate on the earnings screens.
- A traveller-side service fee is stored in the fee schedule but is **not charged and not recorded**. Whether one should exist is undecided.

### Tips
- `POST /api/rent-a-buddy/bookings/:bookingId/tip`, traveller only, completed bookings only. Tips add up; a second tip does not replace the first.
- **No commission on tips.** A tip is one pair of entries, traveller to buddy.
- A client may send an `Idempotency-Key`; the same key with the same amount is recorded once. No screen in the app sends a tip yet.

### Deposits and payment modes
- **No deposit is taken** (owner ruling), and no screen says one is.
- *Known gap:* a booking still stores a payment mode (`full_in_app` or `deposit_plus_cash`) and an in-app / cash split computed when it is created. These are stored terms, not money collected, and they predate the ruling. Removing them belongs to the payment work, not to this document.

### Cash
- Either party can confirm that the cash balance changed hands (`POST /api/rent-a-buddy/bookings/:bookingId/confirm-cash`). The confirmation is one locked database write, and an amount above what the booking says is owed is refused.

### Payouts
- `rent_buddy_payouts` is a status record. Nothing in the app creates a payout row yet, and **no money moves**: "released" is a status.
- Admins can list payouts by state and hold or release one (`GET /api/rent-a-buddy/admin/payouts`, `POST …/:payoutId/hold`, `POST …/:payoutId/release`; app: Admin → Payouts). A reason is required. The status change and its audit entry are one database transaction — if the audit entry cannot be written, the status does not change.

---

## Review System

### Submission
- Route: `POST /api/rent-a-buddy/bookings/:bookingId/review`
- Who can review: both traveler and buddy, once per booking
- Gate: booking must be in `completed` status
- Duplicate guard: returns `409 already_reviewed` if reviewer already submitted
- Fields: `rating` (required), `body`, `safetyScore`, `communicationScore`, `punctualityScore`, `photos[]`

### Visibility
Reviews start with `is_public: false` and `moderation_status: 'pending_moderation'`. A review only becomes publicly visible (`is_public: true`) after admin approval (see Moderation below). There is no automatic double-blind unblinding — `blind_until` is stored on the row but visibility is governed entirely by the moderation status, not by whether both sides have reviewed.

### Moderation
All reviews start with `moderation_status: 'pending_moderation'`. Admins review the moderation queue at:
- `GET /api/rent-a-buddy/admin/reviews?moderationStatus=pending_moderation`
- `POST /api/rent-a-buddy/admin/reviews/:reviewId/approve` — sets `is_public: true`, `moderation_status: 'approved'`, recalculates `average_rating` and `review_count` on the buddy's profile
- `POST /api/rent-a-buddy/admin/reviews/:reviewId/reject` — sets `is_public: false`, `moderation_status: 'rejected'`

Only approved reviews drive the buddy's `average_rating` and `review_count`. Existing reviews that were unblinded before Task #1703 are backfilled to `auto_approved`.

### The `top_rated_buddy` stamp
After a traveller's review is submitted, the buddy is awarded the `top_rated_buddy` stamp if their profile shows an average rating of 4.8 or higher across at least 3 reviews. **No feature flag gates this** (routine decision, 2026-10-04: the sentence that named `rent_buddy_stamps_enabled` was removed rather than a flag added — adding one, seeded off, would have switched off an award that is live, and stamp policy belongs to the Passport work, not here).

---

## Rebook

After a booking reaches `completed` status, the traveler can request the same buddy again via:

- **API:** `POST /api/buddy-bookings/:id/rebook` (an alias; the handler is `POST /api/rent-a-buddy/bookings/:bookingId/rebook`)
- **Body:** `{ bookingDate: "YYYY-MM-DD", startTime?, durationH?, groupSize? }`
- **Mobile:** "Book again" button on the booking detail screen

The rebook route copies `city`, `category`, and `notes` from the original booking and applies the buddy's current hourly rate. It creates a fresh `pending` booking — the buddy must accept again.

---

## Safety Layer

### Policy keyword scanning
All booking notes and traveler messages are scanned against `POLICY_RULES` which cover:
- Adult service solicitation (critical) — immediate booking block
- Romantic/escort language (high) — policy flag + possible access limits
- Off-app payment solicitation (high) — logged to `rent_buddy_policy_flags`
- Massage service language (medium) — flagged for admin review

### Off-app solicitation detection
Patterns like `off-app`, `pay outside`, `venmo me`, `PayPal me` are matched by the `off_app_payment` rule. Matches create a `rent_buddy_policy_flags` row for admin review. Severe matches (high/critical) block the booking immediately.

### Nightlife safety
Nightlife bookings require:
1. Buddy category approval (`category_approvals.nightlife = true`)
2. Admin nightlife sign-off (`nightlife_admin_approved = true`)
3. Public meetup location (private rooms, homes blocked)
4. Both buddy and traveler verified (high-risk gate)

### Safe Return
When enabled (`safe_return_enabled` flag — a platform flag, not a Rent a Buddy one), traveler can trigger an emergency check-in protocol that notifies their trusted circle and creates a safety event for admin visibility.

---

## Launch Controls

Rent a Buddy is rolled out city-by-city. Two tables are involved: `rent_buddy_city_rollouts` holds each city's rollout stage, and `rent_buddy_launch_controls` holds the booking policy for a country / city / category combination. Each launch control can:
- Enable/disable bookings for a city/country/category combination
- Require ID verification or phone verification
- Set minimum age (separate nightlife minimum)
- Enforce full in-app payment only
- Put the city in waitlist-only mode
- Set a commission override for that market and category (see "Money")

Deny-by-default: if any launch controls exist in the table, bookings for cities/categories not covered by a control are blocked.

Cities seeded by `artifacts/api-server/src/migrations/0092_seed_rent_buddy_launch_cities.sql`: **Cebu, Manila, Davao City** at `public_mvp` rollout status. A city's rollout status does not make the feature live: the master switch is off by default and the identity gate applies.

---

## Admin Controls

### Buddy moderation
- Approve/reject applications (`PATCH /api/rent-a-buddy/admin/applications/:appId`)
- Suspend/reactivate buddies
- Feature/unfeature buddies
- Set buddy level, approved categories, nightlife approval
- Risk scan and risk-status override

### Review moderation queue
- `GET /api/rent-a-buddy/admin/reviews` — list reviews by moderation status
- `POST /api/rent-a-buddy/admin/reviews/:id/approve` — approve + recalculate rating
- `POST /api/rent-a-buddy/admin/reviews/:id/reject` — hide review

### Safety queue
- `GET /api/rent-a-buddy/admin/safety/flags` — policy flags
- Confirm / dismiss / escalate flags
- Apply user limits (cash_balance_disabled, rent_buddy_disabled, max_booking_duration_minutes)

### Payouts queue
- `GET /api/rent-a-buddy/admin/payouts?status=` — list payout records by state
- `POST /api/rent-a-buddy/admin/payouts/:payoutId/hold` and `…/release` — a reason is required; the change and its audit entry are written together. No money moves.

### Global controls
Pause all bookings, applications, cash balance, or nightlife with a single toggle in `rent_buddy_global_controls`.

---

## Ranking Algorithm (GET /api/buddies)

The public buddy listing at `GET /api/buddies` orders results by:

1. `featured` DESC — manually featured buddies always appear first
2. `average_rating` DESC — higher rated buddies rank higher
3. `review_count` DESC — tie-break by social proof volume

Filters available: `city`, `country`, `category`, `language`, `minBudgetUsd`, `maxBudgetUsd`, `minRating`, `buddyLevel`, `available` (now | date), `verified`, `featured`, `q` (full-text search across name/tagline/bio/city).

---

## Mobile Screens

Files are under `travel-buddy-standalone/app/(rent-a-buddy)/`.

| Screen | Route | Notes |
|--------|-------|-------|
| Marketplace | `/(rent-a-buddy)/` | Listings with filter sheet |
| Search | `/(rent-a-buddy)/search` | Search and filters |
| Buddy profile | `/(rent-a-buddy)/buddy/[id]` | Reviews, packages, availability |
| Book a buddy | `/(rent-a-buddy)/checkout` | Booking request form; shows the commission before the request is sent |
| Active session | `/(rent-a-buddy)/active` | The traveller's current session, safety check-ins |
| Booking detail | `/(rent-a-buddy)/booking/[id]` | Actions: message, review, rebook, cancel |
| Review | `/(rent-a-buddy)/review` | Submit review for completed booking |
| Buddy dashboard | `/(rent-a-buddy)/buddy-dashboard` | Requests, sessions, offers, availability |
| Buddy earnings | `/(rent-a-buddy)/buddy-dashboard/earnings` and `…/earnings-ledger` | Estimates from the ledger; nothing is shown as collected |
| Admin hub | `/(rent-a-buddy)/admin` | Rollout, launch controls, applications, buddies, bookings, flags, reviews, support, risk, payouts, analytics, marketplace |

There is no `/(rent-a-buddy)/book/[id]`, `/(rent-a-buddy)/bookings` or `/(rent-a-buddy)/dashboard` screen; an earlier version of this table listed them.

---

## Database Migration Log (Rent a Buddy)

**Two directories hold migration files and they reuse the same numbers for different files.** Cite the directory, not just the number.

- `artifacts/api-server/src/migrations/` is the **canonical** tree — what is applied.
- `artifacts/api-server/migrations/` is the **frozen legacy** tree — history only; it is not applied and must not be edited.
- What is actually live is recorded in the baseline dump, `artifacts/api-server/baseline/20260819_baseline_structure.sql`, plus the canonical migrations numbered after it.

### Canonical tree — `artifacts/api-server/src/migrations/`

| File | Purpose |
|------|---------|
| `0050_rent_a_buddy.sql` | Original marketplace tables and the feature-flag seed |
| `0090_rent_buddy_rollout_tables.sql` | Rollout tables: city rollouts, global controls, beta access |
| `0092_seed_rent_buddy_launch_cities.sql` | Seeds Cebu, Manila, Davao City |
| `0133_rent_buddy_availability_alignment.sql` | Availability schema aligned with the API |
| `0135_rent_buddy_meetup_base_coords.sql` | Approximate meetup-base coordinates on buddy profiles |
| `0147_buddy_bookings_compat_view.sql` | `buddy_bookings` compatibility view |
| `0162_rent_buddy_availability_blocks.sql` | `availability_blocks` on buddy profiles |
| `2074_rent_buddy_kyc_gate_flag.sql` | The identity-gate override flag, seeded off |
| `2145`, `2146`, `2155`, `2156`, `2157` `…_write_boundary.sql` | Column-level write boundaries: a buddy cannot self-verify, self-approve an application, a service, an add-on or a package |
| `2210_rent_buddy_default_off.sql` | Forces the master switch off by default |
| `2212_rent_buddy_country_snapshot.sql` | Snapshots the service country on bookings and requests |
| `2304_rent_buddy_launch_control_identity.sql` | Makes a launch control's key unique |
| `2305_rent_buddy_signal_writers.sql` | Gives two read-only profile signals a writer |
| `2330_rent_buddy_money_atomicity.sql` | Atomic cash confirmation, tip accumulation (superseded for tips by 3824) and the earnings aggregate |
| `2332_money_grant_boundary.sql` | Explicit grants on the money tables |
| `2901_rent_buddy_earnings_entries.sql` | The append-only ledger entries table |
| `3510_creator_ledger_erasure_policy_undecided.sql` | Refuses deleting ledger entries while the erasure policy is undecided |
| `3824_rent_buddy_ledger_posting.sql` | One function writes a booking's entries and summary together; commission from configuration; reversals; payout hold / release with its audit entry |

### Frozen legacy tree — `artifacts/api-server/migrations/`

These are the files an earlier version of this table listed by number alone. In the canonical tree the same numbers belong to unrelated files (for example canonical `0047` is `0047_circle_age_settings.sql`).

| File | Purpose |
|------|---------|
| `0047_rent_buddy.sql` | Core schema: profiles, bookings, reviews, packages, addons, saved, waitlist |
| `0048_rent_buddy_marketplace.sql` | Marketplace: platform fee, payment modes, category approvals |
| `0048_rent_buddy_rollout.sql`, `0051_rent_buddy_compliance.sql` | Rollout and compliance: launch controls, global controls, policy flags, safety events, admin controls |
| `0107_rent_buddy_admin_actions.sql` | Admin actions audit log |
| `0108_rent_buddy_spec_tables.sql` | Spec tables: buddy_services, availability_exceptions, booking_events, views |
| `0109_rent_buddy_missing_enums.sql` | Missing enums: verification_status, buddy_level |
| `0110_rent_buddy_payouts.sql` | Payouts |
| `0111_rent_buddy_onboarding_ack.sql` | Onboarding acknowledgement |
| `0112_rent_buddy_lifecycle.sql` | Lifecycle: dispute window, no-show grace, auto-complete |
| `0113_rent_buddy_lifecycle_fixes.sql` | Lifecycle fixes |
| `0114_review_moderation.sql` | Review moderation: `moderation_status` column on `rent_buddy_reviews` |
| `0134_rent_buddy_schema_rebuild.sql` | The rebuild onto the `rent_buddy_*` tables |

---

## How this document was reconciled

On 2026-10-04 every sentence above was checked against the code. Where they disagreed, the document was corrected unless the document was right, in which case the code was changed.

| What the document said | What was true | What changed |
|---|---|---|
| Status: live | The master switch is seeded off | Document |
| All routes are gated by `rent_buddy_enabled` | Every non-admin write is; most reads are not | Document. Reads were deliberately not gated — reasons under "Feature Flags" |
| `rent_buddy_stamps_enabled` gates stamp awards | No code reads that flag | Document. The sentence was removed rather than a flag added — reasons under "Review System" |
| `rent_buddy_safe_return` gates Safe Return | The flag is `safe_return_enabled` | Document |
| Flags fail open on a database error | They fail closed | Document |
| The lifecycle starts at `pending`, and cancelling writes `cancelled` | The canonical route writes `requested`; user cancellations write `cancelled_by_traveler` / `cancelled_by_buddy`; `declined` was missing | Document: the diagram was redrawn |
| A buddy has 24 hours to accept | The canonical route allowed 48 | **Code**: now 24. The shared package-booking helper already capped a request at 24 hours, so 48 was one path disagreeing with the other; a traveller gets an answer a day sooner; and this window is how long a card hold would be kept waiting once payment exists, so the shorter bound is the conservative one |
| The dispute window is `dispute_window_h` hours | It is 24 hours, a constant in the routes | Document |
| Seven screens, including `book/[id]`, `bookings` and `dashboard` | Those three do not exist | Document: the table was corrected |
| Migrations `0047`–`0114` | Those numbers are the frozen legacy tree's | Document: re-keyed to file names in both trees |
