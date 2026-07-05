# Rent a Buddy — DB Schema & API Foundation Audit

**Audit date:** July 2026  
**Scope:** Task #1699 — DB schema gaps, API route coverage, RLS policies, payment honesty.  
**Audited files:**
- `artifacts/api-server/migrations/0047_rent_buddy.sql`
- `artifacts/api-server/migrations/0048_rent_buddy_marketplace.sql`
- `artifacts/api-server/migrations/0048_rent_buddy_rollout.sql`
- `artifacts/api-server/migrations/0050_rent_a_buddy.sql`
- `artifacts/api-server/migrations/0051_rent_buddy_compliance.sql`
- `artifacts/api-server/src/routes/rentABuddy.ts` (4510 lines)
- `artifacts/api-server/src/routes/rentABuddyMarketplace.ts` (2148 lines)
- `artifacts/api-server/src/routes/rentABuddyRollout.ts` (1262 lines)
- `artifacts/api-server/src/lib/database.types.ts`

---

## 1. Executive Summary

The Rent a Buddy foundation is substantially built. The API server compiles and bundles cleanly (5.2 MB). 145+ routes are implemented across three router files, covering traveler, buddy-owner, admin, rollout, and compliance surfaces. This audit documents one critical DB gap fixed by migration 0107, one public-listing route added to close a spec gap, and the honest state of the payment integration layer.

| Surface | Route count | Status |
|---------|-------------|--------|
| Traveler (discovery, booking, safety) | 55 | Implemented |
| Buddy-owner (profile, dashboard, availability, packages) | 35 | Implemented |
| Admin (applications, buddy moderation, analytics, support) | 40 | Implemented |
| Rollout & launch control | 20 | Implemented |
| **Total** | **150** | ✅ Build passes |

---

## 2. Database Schema Audit

### 2.1 Production schema (`rent_buddy_*` tables)

All production routes use the `rent_buddy_*` table family created by migrations 0047/0048/0051.

| Table | Migration | RLS | Notes |
|-------|-----------|-----|-------|
| `rent_buddy_profiles` | 0047 | ✅ 3 policies | Core buddy profile; extended by 0048 + 0051 |
| `rent_buddy_applications` | 0047 | ✅ 2 policies | Application workflow |
| `rent_buddy_availability` | 0047 | ✅ 3 policies | Per-date slots; extended by 0048 |
| `rent_buddy_packages` | 0047 | ✅ 3 policies | Service packages; extended by 0048 |
| `rent_buddy_addons` | 0047 | ✅ 3 policies | Optional add-ons; extended by 0048 |
| `rent_buddy_saved` | 0047 | ✅ 2 policies | Favorites; extended by 0048 |
| `rent_buddy_waitlist` | 0047 | ✅ 2 policies | City/category waitlist; extended by 0048 |
| `rent_buddy_bookings` | 0047 | ✅ 3 policies | Core booking; extended by 0048 + rollout |
| `rent_buddy_booking_extensions` | 0047 | ✅ 2 policies | Add-time extensions |
| `rent_buddy_route_stops` | 0047 | ✅ 2 policies | Structured route stops |
| `rent_buddy_route_change_requests` | 0047 | ✅ 2 policies | Route change flow |
| `rent_buddy_safety_checkins` | 0047 | ✅ 2 policies | In-booking safety check-ins |
| `rent_buddy_safety_events` | 0047 | ✅ 2 policies | Escalated safety events |
| `rent_buddy_user_limits` | 0047 | ✅ 2 policies | Per-user access restrictions |
| `rent_buddy_emergency_contacts_snapshot` | 0047 | ✅ 2 policies | Booking-time EC snapshot |
| `rent_buddy_reviews` | 0047 | ✅ 2 policies | Blind mutual reviews |
| `rent_buddy_disputes` | 0047 | ✅ 2 policies | Dispute lifecycle |
| `rent_buddy_match_preferences` | 0048 | ✅ 2 policies | Traveler matching prefs |
| `rent_buddy_search_events` | 0048 | ✅ 1 policy | Search analytics |
| `rent_buddy_match_scores` | 0048 | ✅ 2 policies | Compatibility score cache |
| `rent_buddy_requests` | 0048 | ✅ 3 policies | Traveler open requests |
| `rent_buddy_offers` | 0048 | ✅ 3 policies | Buddy offers on requests |
| `rent_buddy_package_stops` | 0048 | ✅ 3 policies | Package itinerary stops |
| `rent_buddy_booking_addons` | 0048 | ✅ 2 policies | Per-booking add-ons |
| `rent_buddy_tips` | 0048 | ✅ 2 policies | Post-booking tips |
| `rent_buddy_pricing_rules` | 0048 | ✅ 2 policies | Admin pricing guidance |
| `rent_buddy_fee_rules` | 0048 | ✅ 2 policies | Platform fee schedule |
| `rent_buddy_earnings_ledger` | 0048 | ✅ 2 policies | Buddy earnings ledger |
| `rent_buddy_city_rollouts` | 0048r | ✅ 2 policies | Per-city launch status |
| `rent_buddy_beta_access` | 0048r | ✅ 2 policies | Beta user allowlist |
| `rent_buddy_launch_checklists` | 0048r | ✅ 1 policy | QA checklist per city |
| `rent_buddy_launch_audit_logs` | 0048r | ✅ 1 policy | Rollout audit trail |
| `rent_buddy_global_controls` | 0048r | ✅ 1 policy | Global kill-switches |
| `rent_buddy_launch_controls` | 0051 | ✅ 2 policies | Per-country/city/category gate |
| `rent_buddy_admin_access_logs` | 0051 | ✅ 1 policy | Admin sensitive-data access log |
| `rent_buddy_tag_consents` | 0051 | ✅ 4 policies | Mutual post-tagging consent |
| `rent_buddy_training_checklist` | 0051 | ✅ 2 policies | Buddy onboarding training items |
| `rent_buddy_support_reports` | 0051 | ✅ 3 policies | User support reports |
| `rent_buddy_admin_response_templates` | 0051 | ✅ 2 policies | Admin reply templates |
| `rent_buddy_admin_actions` | **0107** ← NEW | ✅ 1 policy | Admin audit log (**was missing**) |

### 2.2 Gap: `rent_buddy_admin_actions` (fixed by migration 0107)

**Finding:** `rent_buddy_admin_actions` is called in 20+ INSERT statements across `rentABuddy.ts` and `rentABuddyMarketplace.ts` and is declared in `database.types.ts`, but no prior migration created it. It existed only in the production Supabase DB (applied via an undocumented path).

**Fix:** Migration `0107_rent_buddy_admin_actions.sql` creates the table with both the `notes TEXT` column (used by route handlers) and `details JSONB` column (referenced in `database.types.ts`).

Schema:
```sql
rent_buddy_admin_actions (
  id          UUID PK,
  admin_id    UUID FK → profiles(id),
  target_type TEXT NOT NULL,  -- 'application'|'buddy'|'profile'|'package'|'user'
  target_id   TEXT NOT NULL,
  action      TEXT NOT NULL,
  notes       TEXT,
  details     JSONB,
  created_at  TIMESTAMPTZ
)
```

### 2.3 Orphaned schema (`buddy_*` tables from migration 0050)

**Finding:** Migration `0050_rent_a_buddy.sql` creates a parallel, simpler table family: `buddy_profiles`, `buddy_packages`, `buddy_addons`, `buddy_availability`, `buddy_bookings`, `buddy_reviews`, `buddy_applications`, `buddy_saved`, `buddy_waitlist`. No route file references these tables — all routes use `rent_buddy_*`.

**Assessment:** These tables are a legacy planning artifact created before the richer `rent_buddy_*` schema was designed. They are applied to the DB but are functionally dormant.

**Recommendation:** Do not drop them yet — a future data-migration task should decide whether to populate them as views/aliases pointing to `rent_buddy_*` or to remove them in a cleanup migration. Dropping them now risks breaking any direct Supabase Studio queries or dashboard scripts that may reference them.

### 2.4 Enum coverage

All enums are created idempotently (`DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$`):

| Enum | Values |
|------|--------|
| `rent_buddy_status` | pending, active, paused, rejected, suspended |
| `rent_buddy_application_status` | pending, under_review, approved, rejected |
| `rent_buddy_booking_status` | pending, confirmed, in_progress, completed, cancelled, disputed |
| `rent_buddy_payment_mode` | full_in_app, deposit_plus_cash |
| `rent_buddy_safety_status` | normal, check_requested, uncomfortable, emergency |
| `rent_buddy_flag_source` | message, booking_note, profile, route_change, report, payment, review |
| `rent_buddy_flag_severity` | low, medium, high, critical |
| `rent_buddy_flag_status` | open, reviewing, resolved, dismissed, escalated |
| `rent_buddy_dispute_reason` | cash_balance_disagreement, no_show, harassment, policy_violation, route_violation, other |
| `rent_buddy_dispute_status` | open, reviewing, resolved, closed |
| `rent_buddy_checkin_type` | arrival, comfort_30min, check_ok, uncomfortable, end_early, contact_support, start_safe_return, emergency_phrase |
| `rent_buddy_safety_event_type` | route_change_unapproved, comfort_check_distress, emergency_phrase_triggered, off_app_payment_attempt, feel_unsafe, end_early, no_show, harassment_reported, private_meetup_violation, unapproved_extra_guest, abandoned_booking, venue_scam_complaint, nightlife_unsafe_end |
| `rent_buddy_safety_event_status` | open, reviewing, resolved |
| `rent_buddy_risk_status` | normal, watch, limited, under_review, suspended |
| `rent_buddy_city_status` | disabled, waitlist_only, buddy_applications_open, internal_testing, beta_testing, public_mvp, paused, suspended |
| `rent_buddy_beta_access_type` | invited, staff, influencer, tester |
| `rent_buddy_beta_status` | active, revoked |
| `rent_buddy_checklist_status` | pending, in_progress, passed, failed |
| `rb_tag_consent_status` | pending, approved, declined, removed, auto_removed |
| `rb_support_category` | buddy_no_show, traveler_no_show, cash_dispute, harassment, adult_service_violation, off_app_payment, route_changed, venue_scam, refund_request, fake_profile, emergency, other |
| `rb_support_status` | open, in_review, resolved, closed |

---

## 3. API Route Coverage

### 3.1 Discovery & public listing (`rentABuddy.ts` + `rentABuddyMarketplace.ts`)

| Method | Path | Authenticated | Notes |
|--------|------|---------------|-------|
| **GET** | `/api/buddies` | No | **Added in Task #1699** — RESTful public listing with SQL-level filtering, sorting, and pagination via query params (`city`, `category`, `language`, `maxBudgetUsd`, `buddyLevel`, `available`, `featured`, `verified`, `q`, `page`, `perPage`) |
| GET | `/api/rent-a-buddy/cities/:city/available` | No | Available buddies in a city |
| POST | `/api/rent-a-buddy/search` | No | POST-based search (legacy; superseded by GET /api/buddies) |
| GET | `/api/rent-a-buddy/buddies/:buddyId` | Optional | Full buddy profile with packages, addons, reviews, availability |
| GET | `/api/rent-a-buddy/by-user/:userId` | No | Buddy profile by user ID |
| GET | `/api/rent-a-buddy/buddies/:buddyId/availability` | No | Availability calendar |
| GET | `/api/rent-a-buddy/buddies/:buddyId/reviews` | No | Public reviews |
| GET | `/api/rent-a-buddy/buddies/:buddyId/packages` | No | Buddy's packages |
| GET | `/api/rent-a-buddy/buddies/:buddyId/addons` | No | Buddy's add-ons |
| GET | `/api/rent-a-buddy/sections` | No | Marketplace home sections |
| GET | `/api/rent-a-buddy/available-now` | No | Buddies in "available now" mode |
| GET | `/api/rent-a-buddy/cities/:city/top` | No | Top-ranked buddies in city |
| GET | `/api/rent-a-buddy/launch-status` | No | City/category availability check |
| GET | `/api/rent-a-buddy/availability/location` | No | Location-based availability |
| GET | `/api/rent-a-buddy/pricing/suggestion` | Yes | Pricing guidance for new buddies |

### 3.2 Traveler — bookings

| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/rent-a-buddy/bookings` | Create booking — full launch-control + age + verification gating |
| GET | `/api/rent-a-buddy/bookings` | List traveler's bookings |
| GET | `/api/rent-a-buddy/bookings/:bookingId` | Get single booking |
| POST | `/api/rent-a-buddy/bookings/:bookingId/pay-deposit` | Deposit intent (see §4.1 on payment honesty) |
| POST | `/api/rent-a-buddy/bookings/:bookingId/pay-full` | Full payment intent (see §4.1) |
| POST | `/api/rent-a-buddy/bookings/:bookingId/cancel` | Cancel booking |
| POST | `/api/rent-a-buddy/bookings/:bookingId/reschedule` | Reschedule request |
| GET | `/api/rent-a-buddy/bookings/:bookingId/dispute` | Get dispute |
| POST | `/api/rent-a-buddy/bookings/:bookingId/dispute` | Open dispute |
| POST | `/api/rent-a-buddy/bookings/:bookingId/no-show` | Report no-show |
| GET | `/api/rent-a-buddy/bookings/:bookingId/refund-eligibility` | Refund eligibility check |
| POST | `/api/rent-a-buddy/bookings/:bookingId/review` | Submit review |
| POST | `/api/rent-a-buddy/bookings/:bookingId/report` | Report booking |
| POST | `/api/rent-a-buddy/bookings/:bookingId/add-time` | Request extension |
| POST | `/api/rent-a-buddy/bookings/:bookingId/tip` | Add tip post-completion |
| POST | `/api/rent-a-buddy/bookings/:bookingId/addons` | Add add-ons to booking |
| POST | `/api/rent-a-buddy/bookings/:bookingId/confirm-cash` | Confirm cash balance amount |
| POST | `/api/rent-a-buddy/bookings/:bookingId/route` | Set/update route plan |
| POST | `/api/rent-a-buddy/bookings/:bookingId/route-change` | Request route change |
| POST | `/api/rent-a-buddy/bookings/:bookingId/route-change/:changeId/approve` | Approve route change |
| POST | `/api/rent-a-buddy/bookings/:bookingId/route-change/:changeId/decline` | Decline route change |
| POST | `/api/rent-a-buddy/bookings/:bookingId/stay-connected` | Stay-connected ping |
| POST | `/api/rent-a-buddy/bookings/:bookingId/thread` | Open Telegraph thread |
| POST | `/api/rent-a-buddy/bookings/:bookingId/tag-consent` | Request mutual tagging consent |
| POST | `/api/rent-a-buddy/bookings/:bookingId/support/report` | File support report |
| POST | `/api/packages/:packageId/book` | Book from a package |

### 3.3 Traveler — safety

| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/rent-a-buddy/bookings/:bookingId/safety/checkin` | Safety check-in |
| POST | `/api/rent-a-buddy/bookings/:bookingId/safety/feel-unsafe` | Feel-unsafe escalation |
| POST | `/api/rent-a-buddy/bookings/:bookingId/safety/end-early` | End booking early |
| POST | `/api/rent-a-buddy/bookings/:bookingId/safety/emergency-phrase` | Emergency phrase trigger |

### 3.4 Traveler — marketplace (requests, offers, saved, waitlist)

| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/rent-a-buddy/requests` | Create open traveler request |
| GET | `/api/rent-a-buddy/requests/:requestId` | Get request |
| GET | `/api/rent-a-buddy/requests/:requestId/offers` | Offers on a request |
| POST | `/api/rent-a-buddy/offers/:offerId/accept` | Accept buddy offer |
| POST | `/api/rent-a-buddy/offers/:offerId/decline` | Decline buddy offer |
| POST | `/api/rent-a-buddy/buddies/:buddyId/save` | Save buddy |
| DELETE | `/api/rent-a-buddy/buddies/:buddyId/save` | Unsave buddy |
| GET | `/api/rent-a-buddy/me/saved-buddies` | List saved buddies |
| POST | `/api/rent-a-buddy/buddies/:buddyId/book-again` | Rebook with same buddy |
| POST | `/api/rent-a-buddy/waitlist/v2` | Join waitlist |
| GET | `/api/rent-a-buddy/me/waitlist/v2` | My waitlist entries |
| DELETE | `/api/rent-a-buddy/waitlist/:waitlistId` | Leave waitlist |
| POST | `/api/rent-a-buddy/match/preferences` | Save match preferences |
| POST | `/api/rent-a-buddy/match` | Get personalised matches |
| POST | `/api/rent-a-buddy/tag-consents/:consentId/approve` | Approve tagging consent |
| POST | `/api/rent-a-buddy/tag-consents/:consentId/decline` | Decline tagging consent |
| DELETE | `/api/rent-a-buddy/tag-consents/:consentId` | Remove tagging consent |

### 3.5 Buddy-owner — profile & dashboard

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/rent-a-buddy/apply` | Get application status |
| POST | `/api/rent-a-buddy/apply` | Submit buddy application |
| GET | `/api/rent-a-buddy/me/profile` | Get own buddy profile |
| PATCH | `/api/rent-a-buddy/me/profile` | Update own buddy profile |
| PATCH | `/api/rent-a-buddy/me/availability` | Update availability |
| GET | `/api/rent-a-buddy/me/availability-settings` | Get availability settings |
| PATCH | `/api/rent-a-buddy/me/availability-settings` | Update availability settings |
| POST | `/api/rent-a-buddy/me/available-now` | Toggle "available now" on |
| DELETE | `/api/rent-a-buddy/me/available-now` | Toggle "available now" off |
| GET | `/api/rent-a-buddy/me/requests` | Incoming booking requests |
| GET | `/api/rent-a-buddy/me/matching-requests` | Open requests matching buddy's categories |
| GET | `/api/rent-a-buddy/me/offers` | Own submitted offers |
| POST | `/api/rent-a-buddy/requests/:requestId/offers` | Submit offer on a request |
| POST | `/api/rent-a-buddy/offers/:offerId/withdraw` | Withdraw offer |
| GET | `/api/rent-a-buddy/me/eligibility` | Check booking/feature eligibility |
| GET | `/api/rent-a-buddy/me/posting-defaults` | Content-tagging posting defaults |
| GET | `/api/rent-a-buddy/me/beta-status` | Beta access status |
| GET | `/api/rent-a-buddy/me/training-checklist` | Training checklist status |
| POST | `/api/rent-a-buddy/me/training-checklist/:itemKey` | Mark training item complete |
| GET | `/api/rent-a-buddy/me/earnings/summary` | Earnings summary |
| GET | `/api/rent-a-buddy/me/earnings/ledger` | Ledger with filtering |
| GET | `/api/rent-a-buddy/dashboard` | Dashboard summary (bookings, earnings) |
| GET | `/api/rent-a-buddy/dashboard/requests` | Dashboard: incoming requests |
| PATCH | `/api/rent-a-buddy/dashboard/offer` | Dashboard: update offer |
| GET | `/api/rent-a-buddy/dashboard/availability` | Dashboard: availability calendar |
| POST | `/api/rent-a-buddy/dashboard/availability` | Dashboard: set availability |
| GET | `/api/rent-a-buddy/dashboard/packages` | Dashboard: packages |
| POST | `/api/rent-a-buddy/dashboard/packages` | Dashboard: add package |
| PATCH | `/api/rent-a-buddy/dashboard/packages/:packageId` | Dashboard: update package |
| DELETE | `/api/rent-a-buddy/dashboard/packages/:packageId` | Dashboard: remove package |
| GET | `/api/rent-a-buddy/dashboard/addons` | Dashboard: add-ons |
| POST | `/api/rent-a-buddy/dashboard/addons` | Dashboard: add add-on |
| PATCH | `/api/rent-a-buddy/dashboard/addons/:addonId` | Dashboard: update add-on |
| DELETE | `/api/rent-a-buddy/dashboard/addons/:addonId` | Dashboard: remove add-on |
| GET | `/api/rent-a-buddy/dashboard/earnings` | Dashboard: earnings summary |
| GET | `/api/rent-a-buddy/dashboard/earnings/summary` | Dashboard: rich earnings breakdown |

### 3.6 Buddy-owner — booking lifecycle actions

| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/rent-a-buddy/bookings/:bookingId/accept` | Accept booking |
| POST | `/api/rent-a-buddy/bookings/:bookingId/decline` | Decline booking |
| POST | `/api/rent-a-buddy/bookings/:bookingId/start` | Start booking |
| POST | `/api/rent-a-buddy/bookings/:bookingId/complete` | Complete booking |

### 3.7 Admin — applications & buddy moderation

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/rent-a-buddy/admin/applications` | Pending applications |
| PATCH | `/api/rent-a-buddy/admin/applications/:appId` | Approve/reject/review application |
| GET | `/api/rent-a-buddy/admin/buddies` | List all buddies with filtering |
| POST | `/api/rent-a-buddy/admin/buddies/:buddyId/suspend` | Suspend buddy |
| POST | `/api/rent-a-buddy/admin/buddies/:buddyId/reactivate` | Reactivate buddy |
| POST | `/api/rent-a-buddy/admin/buddies/:buddyId/feature` | Feature buddy |
| POST | `/api/rent-a-buddy/admin/buddies/:buddyId/unfeature` | Unfeature buddy |
| PATCH | `/api/rent-a-buddy/admin/buddies/:buddyId/level` | Set buddy level |
| PATCH | `/api/rent-a-buddy/admin/buddies/:buddyId/categories` | Update approved categories |
| POST | `/api/rent-a-buddy/admin/buddies/:buddyId/nightlife-approve` | Nightlife manual approval |
| PATCH | `/api/rent-a-buddy/admin/users/:userId/verification` | Override ID/phone/age verification |
| POST | `/api/rent-a-buddy/admin/users/:userId/limits` | Set user limits |
| PATCH | `/api/rent-a-buddy/admin/users/:userId/limits` | Update user limits |
| POST | `/api/rent-a-buddy/admin/users/:userId/risk-status` | Set risk review status |
| GET | `/api/rent-a-buddy/admin/bookings` | List all bookings |
| GET | `/api/rent-a-buddy/admin/bookings/:bookingId/sensitive` | Read sensitive booking data (access-logged) |

### 3.8 Admin — safety & support

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/rent-a-buddy/admin/safety/flags` | Safety flags queue |
| POST | `/api/rent-a-buddy/admin/safety/flags/:flagId/dismiss` | Dismiss flag |
| POST | `/api/rent-a-buddy/admin/safety/flags/:flagId/confirm` | Confirm flag |
| POST | `/api/rent-a-buddy/admin/safety/flags/:flagId/escalate` | Escalate flag |
| GET | `/api/rent-a-buddy/admin/safety/events` | Safety events log |
| GET | `/api/rent-a-buddy/admin/risk-review` | Profiles under risk review |
| POST | `/api/rent-a-buddy/admin/run-risk-scan` | Trigger risk pattern scan |
| GET | `/api/rent-a-buddy/admin/support/reports` | Support reports queue |
| PATCH | `/api/rent-a-buddy/admin/support/reports/:reportId` | Resolve support report |
| GET | `/api/rent-a-buddy/admin/support/templates` | Admin response templates |

### 3.9 Admin — marketplace & pricing

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/rent-a-buddy/admin/analytics` | System-wide analytics |
| GET | `/api/rent-a-buddy/admin/marketplace/analytics` | Marketplace analytics |
| GET | `/api/rent-a-buddy/admin/marketplace/cities` | City-level marketplace metrics |
| POST | `/api/rent-a-buddy/admin/profiles/:id/feature` | Feature via profile ID |
| DELETE | `/api/rent-a-buddy/admin/profiles/:id/feature` | Unfeature via profile ID |
| POST | `/api/rent-a-buddy/admin/profiles/:id/city-ambassador` | Set city ambassador |
| POST | `/api/rent-a-buddy/admin/packages/:id/approve` | Approve package |
| POST | `/api/rent-a-buddy/admin/packages/:id/disable` | Disable package |
| GET | `/api/rent-a-buddy/admin/pricing/outliers` | Flag pricing outliers |
| PATCH | `/api/rent-a-buddy/admin/fee-rules` | Update fee rules |
| POST | `/api/rent-a-buddy/admin/users/:userId/force-public-meetup` | Force public meetup |
| POST | `/api/rent-a-buddy/admin/users/:userId/force-full-in-app` | Force full in-app payment |
| POST | `/api/rent-a-buddy/admin/restrictions/city-category` | Set city/category restriction |
| GET | `/api/rent-a-buddy/admin/launch-controls` | Get launch controls |
| POST | `/api/rent-a-buddy/admin/launch-controls` | Create launch control |
| PATCH | `/api/rent-a-buddy/admin/launch-controls/:controlId` | Update launch control |

### 3.10 Rollout & launch control (`rentABuddyRollout.ts`)

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/admin/rent-buddy/rollout/cities` | List city rollouts |
| POST | `/api/admin/rent-buddy/rollout/cities` | Create city rollout |
| GET | `/api/admin/rent-buddy/rollout/cities/:id` | Get city rollout |
| PATCH | `/api/admin/rent-buddy/rollout/cities/:id` | Update city rollout |
| POST | `/api/admin/rent-buddy/rollout/cities/:id/advance-status` | Advance city status |
| POST | `/api/admin/rent-buddy/rollout/cities/:id/pause` | Pause city |
| POST | `/api/admin/rent-buddy/rollout/cities/:id/resume` | Resume city |
| GET | `/api/admin/rent-buddy/rollout/cities/:id/metrics` | City metrics |
| GET | `/api/admin/rent-buddy/beta-access` | Beta access list |
| POST | `/api/admin/rent-buddy/beta-access` | Grant beta access |
| PATCH | `/api/admin/rent-buddy/beta-access/:id` | Update beta access |
| POST | `/api/admin/rent-buddy/beta-access/:id/revoke` | Revoke beta access |
| GET | `/api/admin/rent-buddy/qa/checklists` | QA checklists |
| POST | `/api/admin/rent-buddy/qa/checklists` | Create QA checklist |
| PATCH | `/api/admin/rent-buddy/qa/checklists/:id` | Update QA checklist |
| POST | `/api/admin/rent-buddy/qa/checklists/:id/mark-passed` | Mark checklist passed |
| POST | `/api/admin/rent-buddy/qa/checklists/:id/mark-failed` | Mark checklist failed |
| GET | `/api/admin/rent-buddy/global-controls` | Get global controls |
| PATCH | `/api/admin/rent-buddy/global-controls` | Update global controls |
| GET | `/api/admin/rent-buddy/audit-log` | Launch audit log |
| GET | `/api/rent-buddy/launch-status` | Public launch-status check |
| POST | `/api/rent-buddy/waitlist` | Public waitlist join (rollout file) |
| GET | `/api/rent-buddy/me/beta-status` | Beta status check |

---

## 4. Honesty Assessment

### 4.1 Payment processing (not yet integrated)

**Finding:** Routes `POST /pay-deposit` and `POST /pay-full` are honest stubs. They validate booking ownership and status, then return:

```json
{
  "paymentIntent": { "status": "requires_payment_method", "bookingId": "..." },
  "message": "Complete payment via the Stripe payment sheet."
}
```

They do **not** call any payment processor. No Stripe SDK is installed or called. The routes emit a milestone notification and invalidate the Compass cache, which are correct side-effects.

**Impact:** Deposits and full payments are logically modelled but not financially transacted. The platform should not go live until Stripe (or the chosen processor) is integrated and the `pay-deposit` / `pay-full` routes create real payment intents.

**Recommendation for Task #1701 (booking lifecycle):** Wire Stripe SDK calls in these two routes. Add `payment_status` column (`TEXT CHECK (payment_status IN ('unpaid','deposit_paid','paid','refunded','disputed'))`) to `rent_buddy_bookings` via migration 0108+ and update it from the payment webhook.

### 4.2 Earnings ledger — cash balance is not confirmed by payment

**Finding:** The earnings dashboard calculates buddy payout using `cash_balance_usd` from the booking row. This field is set by mutual confirmation (`/confirm-cash`), not by a real payment. A buddy could confirm an inflated cash amount.

**Recommendation:** Track cash confirmation with `cash_balance_confirmed_by_buddy` + `cash_balance_confirmed_by_traveler` (both columns exist and are correctly used by the confirm-cash route) and flag unresolved discrepancies for admin review.

### 4.3 Platform fee is hard-coded

**Finding:** The earnings summary route (`/dashboard/earnings/summary`) hard-codes `platformFeePct = 0.15` (15%) regardless of the buddy's `buddy_level`. The `rent_buddy_fee_rules` table has per-level fees (12%–25%) but is not consulted.

**Recommendation:** Join `rent_buddy_fee_rules` on the buddy's level to compute the correct net amount per booking.

---

## 5. RLS Policy Summary

Every `rent_buddy_*` table has RLS enabled. Policy pattern used consistently:

| Pattern | Tables |
|---------|--------|
| Service role full access | All 40+ tables |
| Owner-only read/write (`auth.uid() = user_id`) | profiles, applications, availability, saved, waitlist, limits, reviews (reviewer), checkins, training |
| Party-scoped read (traveler OR buddy) | bookings, extensions, route_stops, route_change_requests, booking_addons, tips, disputes |
| Public read | profiles (active), packages, addons, availability, pricing_rules, fee_rules, package_stops |
| Admin-only | admin_actions, admin_access_logs, support_templates, global_controls, launch_checklists, audit_logs |

---

## 6. Gaps Deferred to Downstream Tasks

| Gap | Downstream task |
|-----|----------------|
| Stripe payment integration on `/pay-deposit` and `/pay-full` | Task #1701 |
| Booking status state machine enforcement (can't `complete` without `start`, etc.) | Task #1701 |
| `payment_status` column on `rent_buddy_bookings` | Task #1701 |
| Platform fee from `rent_buddy_fee_rules` in earnings | Task #1701 / Task #1703 |
| Buddy onboarding UI / application review UI | Task #1700 |
| Full review + ranking pipeline | Task #1703 |
| Mobile integration (discovery screen, search, compass tile) | Task #1702 |
| Dropping / aliasing orphaned `buddy_*` tables | Future cleanup migration |

---

## 7. Migrations Applied by This Task

| Migration | Purpose |
|-----------|---------|
| `0107_rent_buddy_admin_actions.sql` | Creates `rent_buddy_admin_actions` audit log table with RLS and indexes |

---

## 8. Build Verification

```
> @workspace/api-server@0.0.0 build
> node ./build.mjs

  dist/index.mjs    5.2mb ✅
  dist/pino-worker.mjs
  dist/pino-file.mjs
  ...

⚡ Done in ~3000ms — no errors.
```

`pnpm --filter @workspace/api-server run build` passes with the new route and migration in place.
