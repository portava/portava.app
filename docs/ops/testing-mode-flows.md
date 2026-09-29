# Testing-mode flows — what a tester can now do, and how to check it

Portava is in testing mode: the hosted testing app (the Replit deployment on the
Supabase project `travel-buddy`, not publicly launched) must carry every intended
feature end to end. This file records, per platform flow, what a tester does in
the app, what they should see, and what the server writes, so a tester can walk
the flow and an engineer can check the result.

Each lane appends its own section. Flow ids are those of the flow catalogue
(`flows.json`, the testing-mode lane brief). Area flows are recorded in their
area's census (`docs/architecture/census-*.md`); only the platform flows
(`PLAT-*`) are recorded here.

**Everything below is controlled evidence** (unit, component and route tests
in this repository). None of it is production evidence. No flag was changed,
no migration was added, and nothing was applied to any database.

---

## TM-RAB lane (WP-01) — Rent-a-Buddy: run the booking, refused gates, admin moderation

Branch `lane-tm-rab`, cut from `main` at `18518e982`. Flows: PLAT-F43, PLAT-F45,
PLAT-F49, PLAT-F50, PLAT-F55, PLAT-F56. No other Rent-a-Buddy flow in
`flows.json` is marked "needs code" without being payment work (see Decisions).

**No payment code.** Nothing here takes, holds, refunds or pays out money. Where
a screen mentions money it keeps the existing honest copy: no payment goes
through the app; traveller and buddy settle directly.

**Every gate stays on the server.** `rent_buddy_enabled`, the KYC / identity
readiness gate (`rent_buddy_allow_bookings_without_kyc`), the kill switches
`disable_rab_bookings` / `disable_rent_buddy_booking`,
`rent_buddy_global_controls.all_bookings_paused`, city rollout, beta access,
launch controls and user limits decide exactly what they decided before. The
server now only *names* the gate in the refusal body (`gate`), and the app shows
a refused gate as its own state: which gate refused, and what unblocks it.

### Preconditions on the testing app (owner / admin, unchanged by this lane)

- `rent_buddy_enabled` ON (owner decision). Off, every Rent-a-Buddy screen shows
  the gate state "Rent a Buddy is switched off — REFUSED BY rent_buddy_enabled —
  an admin turns it on in Admin → Feature flags". If the flags cannot be read the
  app says so and offers "Try again"; it never shows "off" for a failed read.
- New bookings additionally need the KYC gate open (an operational identity
  provider, or the owner turning `rent_buddy_allow_bookings_without_kyc` on), no
  kill switch engaged, the city rolled out (and beta access for beta cities), and
  a launch control covering the location if any control exists (deny-by-default).
  Each of these, when it refuses, is shown by name with its unblock.

### PLAT-F43 — the buddy suggests another time; the traveller answers

- **Where:** buddy: Buddy dashboard → Booking requests → "Suggest" (existing
  sheet), or any accepted booking → Session → "Suggest another time". Traveller:
  the booking screen `(rent-a-buddy)/booking/[id]` → Session → Suggested changes.
- **Steps:** as the buddy, suggest a new date and/or start time. As the traveller,
  open the booking: the suggestion reads e.g. "Start time: 10:00 → 14:00" with the
  buddy's reason. Tap **Accept** (the booking's date/time is updated server-side)
  or **Decline**. The side that suggested sees "You suggested this — waiting for
  the other side".
- **Server:** `POST /api/rent-a-buddy/bookings/:id/suggest` writes
  `buddy_booking_change_requests`; the NEW read
  `GET /api/rent-a-buddy/bookings/:id/change-requests` (party-only, behind
  `rent_buddy_enabled`) returns them with `requestedByMe`;
  `POST /api/rent-a-buddy/bookings/:id/respond-change-request` answers.
- **Check:** `SELECT change_field, proposed_value, status FROM buddy_booking_change_requests WHERE booking_id = :id;`
  then `SELECT booking_date, start_time FROM rent_buddy_bookings WHERE id = :id;`

### PLAT-F45 — run the booking: start, check-ins, emergency phrase, complete, confirm

- **Buddy:** Buddy dashboard → **My sessions** lists accepted, in-progress and
  awaiting-confirmation bookings. **Start session** (only from scheduled /
  confirmed) → `in_progress`. **Complete session** (only from in_progress) →
  `completed_pending_traveler_confirmation` with a 24 h window. The same
  controls are on the booking screen's Session panel.
- **Traveller:** the booking screen → Session: **I've arrived** / **All good**
  (check-ins, `POST …/check-in` with `arrival` / `check_ok`); when the buddy has
  completed, **Confirm completion** → `completed` (or **Open a dispute**).
  In the live session (`(rent-a-buddy)/active`): **End session** now completes
  the booking on the server first and only then opens the review (it used to
  navigate without writing anything, so the booking stayed in progress and the
  review was refused). **I need to check my passport** is the discreet
  emergency phrase: it records the safety event and opens a private prompt only
  the traveller sees (I am okay → check-in; End booking now; Share location;
  Start Safe Return; Contact support; Use emergency button → dials 112).
- **Server:** `/start`, `/complete`, `/traveler-confirm`, `/check-in`,
  `/safety/emergency-phrase` (all existing).
- **Check:** `SELECT status, started_at, completed_at FROM rent_buddy_bookings WHERE id = :id;`
  `SELECT checkin_type FROM rent_buddy_safety_checkins WHERE booking_id = :id;`
  `SELECT event_type FROM rent_buddy_safety_events WHERE booking_id = :id;`
- **Physical:** meeting in person is simulated; GPS is not read by these controls.

### PLAT-F49 — review moderation

- **Where:** Admin → Rent a Buddy → **Review Moderation** (`admin/reviews`).
- **Steps:** after a completed booking, the traveller reviews (existing
  `review.tsx`). As admin, the review is under Pending; **Approve** makes it
  public and recalculates the buddy's rating; **Reject** asks for a reason and
  keeps it hidden. Approved / Rejected tabs list moderated reviews.
- **Check:** `SELECT moderation_status, is_public FROM rent_buddy_reviews WHERE id = :id;`
  `SELECT average_rating, review_count FROM rent_buddy_profiles WHERE user_id = :buddy;`

### PLAT-F50 — the buddy lists and withdraws their own offers

- **Where:** Buddy dashboard → **My offers**.
- **Steps:** every offer the buddy sent, newest first, with its answer
  (waiting / accepted / declined / expired / withdrawn). **Withdraw offer** on a
  pending one. An offer the traveller already accepted cannot be withdrawn: the
  server refuses it (compare-and-set on `pending`) and the app says "Already
  answered"; an accepted offer links to its booking.
- **Check:** `SELECT status FROM rent_buddy_offers WHERE id = :id;`

### PLAT-F55 — launch-controls editor

- **Where:** Admin → Rent a Buddy → **Launch Controls** (`admin/launch-controls`).
- **Steps:** **New control** for a country code / city / category (blank = any)
  with bookings open, verified-ID and verified-phone requirements. Per control:
  switches for Bookings open / Waitlist only / Require verified ID / Require
  verified phone, and steppers for the minimum and nightlife minimum age. The
  screen states up front that controls are deny-by-default, and asks for
  confirmation before creating the first one. Payment fields on the row are not
  edited here.
- **Check:** `SELECT * FROM rent_buddy_launch_controls;` then, as a traveller, a
  booking in an uncovered location is refused with the gate state "No launch
  control covers this booking — REFUSED BY rent_buddy_launch_controls".

### PLAT-F56 — support reports, risk review, verification override

- **Where:** Admin → Rent a Buddy → **Support Reports**, **Risk Review**.
- **Support:** tabs Open / In review / Resolved / Closed; **Update status /
  notes**.
- **Risk:** tabs Watch / Limited / Under review / Suspended / Normal; **Set risk
  status** with a required note (Suspended also switches the user's Rent-a-Buddy
  access off server-side); **Verification…** records a manual ID / phone / age
  decision — each field is "No change" unless chosen, so saving never revokes a
  verification by accident.
- **Check:** `SELECT status, admin_notes FROM rent_buddy_support_reports WHERE id = :id;`
  `SELECT risk_review_status, verification_status, id_verified FROM rent_buddy_profiles WHERE user_id = :u;`
  `SELECT action FROM rent_buddy_admin_actions ORDER BY created_at DESC LIMIT 5;`

### What was built

- Server (`artifacts/api-server`):
  - refusals name the gate: `requireRentBuddyEnabled` → `gate: "rent_buddy_enabled"`;
    the five kill-switch refusals name the engaged switch via
    `engagedRabBookingKillSwitch` (`src/lib/featureFlags.ts`). Decisions unchanged.
  - `GET /rent-a-buddy/bookings/:id/change-requests` (new, appended to
    `src/routes/rentABuddy.ts`).
  - offer withdraw is compare-and-set on `pending` (`src/routes/rentABuddyMarketplace.ts`).
  - admin launch-controls / support / risk-review reads, and launch-control PATCH,
    risk-status, verification override, review approve / reject, now answer 5xx on
    a database error instead of an empty list or `ok`.
  - `check:rent-buddy-contract` lists the 17 routes the new screens depend on.
- Client (`travel-buddy-standalone`): `src/services/rentABuddyGates.ts`,
  `src/services/rentABuddyLifecycle.ts`,
  `src/components/rentabuddy/{RabGateRefusalState,BookingLifecyclePanel,RabAdminScaffold}.tsx`,
  screens `buddy-dashboard/{sessions,my-offers}.tsx`,
  `admin/{reviews,support,risk,launch-controls}.tsx`; wiring in `_layout.tsx`,
  `booking/[id].tsx`, `active.tsx`, `buddy-dashboard/index.tsx`, `admin/index.tsx`;
  service fixes in `src/services/rentABuddy.ts` (refusals keep `gate`;
  `submitCheckIn` sent `{status, broadArea}` to a route that reads
  `{checkinType, response}`), `src/services/rentABuddyAdmin.ts` (reads return
  `ok:false` instead of `[]`; launch-control writes send the route's camelCase
  keys) and `src/hooks/useRentABuddyFlag.ts` (tri-state read). Six routes
  registered in `src/navigation/portavaRoutes.ts` (closing line).

### Decisions (routine; decided and implemented)

1. **Traveller "End session" completes the booking** through `POST /complete`
   (the server's traveller path goes straight to `completed`); the buddy's
   completion opens the traveller's 24 h confirmation. Mirrors the server.
2. **Name the gate, don't re-decide it.** Refusal bodies gain a `gate` field;
   `feature_disabled` without one is the master switch (its only other source).
3. **Admin screens stay behind the client's `rent_buddy_enabled` check**, as the
   existing admin screens are. The server exempts admin routes; the admin turns
   the flag on in Admin → Feature flags (outside the group) first, and city
   rollouts keep bookings closed until an admin opens a city.
4. **Verification override is per-field opt-in** ("No change" default): the risk
   list does not carry current verification columns.
5. **Launch-control editor leaves payment fields alone** (`full_payment_required`,
   `min_deposit_pct`): payment policy waits on the owner.
6. **PLAT-F51 (packages, add-ons, tips) is not built here**: it prices and
   records money (add-on totals, tips) and the catalogue files it under
   payments.md rows 4–6. PLAT-F44 (deposit / refund) and PLAT-F53 (payouts) are
   payment work. All wait on the owner's payment decision.

### Tests (red first → green) and mutations

- `artifacts/api-server/src/test/rentBuddyTestingModeWiring.test.ts` (registered
  on the `test` line): **RED 22 of 29 → GREEN 29/29**. Mutations M1–M19 (drop
  each gate name, blank the kill-switch name, drop the withdraw CAS predicate,
  unscope / un-guard / mis-attribute the change-request read, swallow each admin
  read and write error): **all 19 red**, each restored byte-identically (sha256).
  All 89 api-server suites that import or read the touched route files: 1760/1760.
- Client node:test: `rentABuddy.gates.test.ts` 32, `rentABuddy.lifecycle.test.ts`
  15, `useRentABuddyFlag.state.test.ts` 8 — red at HEAD (modules/functions
  absent: 0/1, 0/1, 0/8) → green.
- Client jest: `rentABuddy.testingModeWiring.component.test.ts` (16),
  `BookingLifecyclePanel.component.test.tsx` (9), `rabLayout.gate` (3),
  `buddySessionsOffers` (9), `rabAdminScreens` (10), `activeSession.lifecycle` (4).
  Against HEAD sources: 6 suites FAIL, 19 failed / 4 passed (the 4 are
  pass-through cases that were already true). All green on the branch; every
  RAB-touching jest suite 272/272.
- Client mutations CM1–CM15 (gate naming, traveller offered Start, `gate`
  dropped by `apiFetch`, old check-in body, partial sessions list, admin read back
  to `[]`, gate shown as a generic Alert, failed suggestions read shown empty,
  End session without completing, unreadable flag shown as off, verification
  sending untouched fields, failed sessions read shown empty, Withdraw on answered
  offers, snake_case launch-control keys): **all 15 red**, restored by sha256
  (CM15 first survived; its test was strengthened to toggle a field whose column
  and key differ).

### Not done, and why

- **Payments** (PLAT-F44, PLAT-F51, PLAT-F53): owner decision.
- **Owner/admin activation on the testing app**: `rent_buddy_enabled`, city
  rollouts, beta access and the KYC gate are unchanged here; with them closed,
  every flow above shows the named gate state rather than working end to end.
- **PLAT-F56 user limits and the sensitive-booking view** have routes and no
  screen; the brief's scope for this lane was support, risk and verification.
- **`rent_buddy_requests.country_code`** (PLAT-F50's backfill blocker, migration
  2212 unproven on travel-buddy) is untouched: posting a request can still fail
  on the testing database until that migration is applied.
- The existing Safe Return switch on `active.tsx` posts a check-in type
  (`safe_return_enabled`) that is not in the `rent_buddy_checkin_type` enum;
  left as found (out of this lane's flows), noted for the Safety lane.
