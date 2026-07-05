# Rent a Buddy — Product Documentation

**Last updated:** July 2026  
**Status:** Live (public_mvp) — Cebu, Manila, Davao City seeded

---

## Overview

Rent a Buddy is a social travel companionship marketplace built into Travel Buddy. Travelers can book local companions for city tours, language support, arrival assistance, nightlife guidance, shopping help, content creation, and more. It is **not** a dating, escort, or adult service — these use cases are blocked by the safety layer.

---

## Feature Flags

All Rent a Buddy routes are gated by the `rent_buddy_enabled` feature flag. Individual surfaces have additional flags:

| Flag | Controls |
|------|---------|
| `rent_buddy_enabled` | Master switch — all routes |
| `RENT_BUDDY_NIGHTLIFE_ENABLED` | Nightlife category visibility |
| `rent_buddy_stamps_enabled` | Stamp awards (top_rated_buddy) |
| `rent_buddy_safe_return` | Safe Return emergency control |

All flags fail-open on DB error to avoid disrupting users in the event of a transient flag store failure, except `rent_buddy_safe_return` which is fail-closed.

---

## Service Categories

| Category | Risk Level | Verification Required |
|----------|-----------|----------------------|
| `arrival` | High | Both buddy and traveler must be verified |
| `nightlife` | High | Both buddy and traveler must be verified + admin nightlife approval |
| `adventure` | Medium | Advisory only (no hard gate) |
| `wellness` | Medium | Advisory only (no hard gate) |
| `city` | Low | None |
| `language` | Low | None |
| `food` | Low | None |
| `shopping` | Low | None |
| `culture` | Low | None |
| `content` | Low | None |
| `nature` | Low | None |
| `other` | Low | None |

**High-risk enforcement:** At booking creation, if a category is `arrival` or `nightlife`, both the buddy (`rent_buddy_profiles.verification_status = 'verified'` or `id_verified AND phone_verified`) and the traveler must be verified. The API returns `{ error: "verification_required", side: "buddy" | "traveler" | "both" }` on failure.

---

## Booking Lifecycle

```
pending → scheduled → in_progress → completed_pending_traveler_confirmation → completed
                                  ↘ disputed
         ↘ cancelled
                    ↘ expired (after expires_at)
                    ↘ no_show_pending → disputed
```

Key transitions:
- **pending** — traveler submits booking request; buddy has 24h to accept
- **scheduled** — buddy accepts; session is confirmed
- **in_progress** — buddy or traveler triggers check-in at meetup
- **completed_pending_traveler_confirmation** — session ends; traveler has `dispute_window_h` hours to confirm or dispute
- **completed** — confirmed or auto-completed after dispute window closes
- **disputed** — either party raised a dispute before the window closed

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

---

## Rebook

After a booking reaches `completed` status, the traveler can request the same buddy again via:

- **API:** `POST /api/buddy-bookings/:id/rebook`
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
When enabled (`rent_buddy_safe_return` flag), traveler can trigger an emergency check-in protocol that notifies their trusted circle and creates a safety event for admin visibility.

---

## Launch Controls

Rent a Buddy is rolled out city-by-city via `rent_buddy_launch_controls`. Each control can:
- Enable/disable bookings for a city/country/category combination
- Require ID verification or phone verification
- Set minimum age (separate nightlife minimum)
- Enforce full in-app payment only
- Put the city in waitlist-only mode

Deny-by-default: if any launch controls exist in the table, bookings for cities/categories not covered by a control are blocked.

Current live cities (seeded by migration 0092): **Cebu, Manila, Davao City** at `public_mvp` status.

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

| Screen | Route | Notes |
|--------|-------|-------|
| Marketplace | `/(rent-a-buddy)/` | Listings with filter sheet |
| Buddy profile | `/(rent-a-buddy)/buddy/[id]` | Reviews, packages, availability |
| Book buddy | `/(rent-a-buddy)/book/[id]` | Booking request form |
| My bookings | `/(rent-a-buddy)/bookings` | Traveler booking list |
| Booking detail | `/(rent-a-buddy)/booking/[id]` | Actions: message, review, rebook, cancel |
| Review | `/(rent-a-buddy)/review` | Submit review for completed booking |
| Buddy dashboard | `/(rent-a-buddy)/dashboard` | Buddy earnings, stats, requests |

---

## Database Migration Log (Rent a Buddy)

| Migration | Purpose |
|-----------|---------|
| 0047 | Core schema: profiles, bookings, reviews, packages, addons, saved, waitlist |
| 0048 | Marketplace: platform fee, payment modes, category approvals |
| 0050 | Compliance: policy flags, safety events, admin controls |
| 0051 | Rollout: launch controls, global controls |
| 0107 | Admin actions audit log |
| 0108 | Spec tables: buddy_services, availability_exceptions, booking_events, views |
| 0109 | Missing enums: verification_status, buddy_level |
| 0110 | Payouts |
| 0111 | Onboarding acknowledgement |
| 0112 | Lifecycle: dispute window, no-show grace, auto-complete |
| 0113 | Lifecycle fixes |
| 0114 | Review moderation: `moderation_status` column on `rent_buddy_reviews` |
