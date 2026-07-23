# Portava Verified Foundation — Phased Plan

Suggested repo location: `docs/trust/verified-foundation-plan.md`

Goal: government-ID identity verification with optional selfie liveness,
verified badges, trust integration, reporting/blocking, a moderation
queue, and safety surfaces — built provider-agnostic so the ID-check
vendor (Stripe Identity vs Persona) is a config decision, not an
architecture decision.

## Privacy invariants (non-negotiable, encoded in schema + adapter types)

1. Portava never stores raw government-ID images, document numbers, or
   selfies. Opaque provider references only.
2. Portava never stores date of birth. Age gating stores a derived
   `is_over_18` boolean only.
3. Verification rows are deletable per-user for GDPR erasure without
   destroying moderation audit history (reports/actions use SET NULL).
4. The mock provider is refused in production by the factory.
5. Webhooks are signature-verified in every real adapter; an unverified
   webhook throws, never silently accepts.

## Phase V-0 — Foundation (DONE — files delivered as drop-ins)

- [x] Schema: `identity_verifications`, `moderation_reports`,
      `moderation_actions`, profile `verification_level` + `verified_at`
      (`0161_identity_verification.sql`)
- [x] Provider adapter interface + normalized status model (`types.ts`)
- [x] Working mock provider with forced-failure test hints (`mockProvider.ts`)
- [x] Stripe/Persona stubs + env-driven factory with prod guard (`providers.ts`)
- [x] `VerifiedBadge` component (teal = ID verified, gold = ID + selfie)

## Phase V-1 — Server routes + service (Agent, after E2EE migration settles)

- `POST /api/verification/session` — auth required; creates provider
  session for the caller; upserts the `identity_verifications` row in
  `created` status; returns `redirectUrl`.
- `POST /api/verification/webhook` — raw-body route; passes to
  `provider.handleWebhook`; on a normalized result, updates the row and,
  when `verified`, sets `profiles.verification_level` via
  `toVerificationLevel()` and `verified_at`.
- `GET /api/verification/status` — caller's current verification row
  (poll fallback for webhook lag).
- Rate limits: max 3 session creations per user per 24h (cost control —
  each real-provider session is billable).
- Trust Score hook: on transition to `verified`, emit the existing trust
  event the platform uses so verification contributes to Trust Score.
- Tests: mock-provider end-to-end (create → webhook approve → profile
  level set), forced failures map to correct failure reasons, rate limit.

## Phase V-2 — Client verification flow (Agent)

- Entry points: Passport profile ("Get verified"), Rent-a-Buddy gate.
- Screens: intro (what/why/what we never store) → provider hand-off
  (opens `redirectUrl`; for the mock, a dev screen with
  Approve / Fail buttons that POSTs the mock webhook) → pending →
  success / failure with retry.
- Render `VerifiedBadge` beside names in: profile header, traveler cards,
  Rent-a-Buddy listings, reviews, event attendee lists — inside
  `UserIdentityLink` so profile-tap behavior is preserved.
- Failure UX: clear reason ("document couldn't be read", "selfie didn't
  match") + retry path; `underage` failure routes to an age-policy screen
  and does NOT allow retry spam.

## Phase V-3 — Report / Block completion (Agent — WAIT until E2EE thread
migration is merged, since Telegraph screens are being touched now)

- Report entry points: profile overflow menu, post/comment overflow,
  Telegraph thread menu, event page, buddy listing, review.
- Report sheet: category picker (matches `moderation_reports.category`),
  optional details, confirmation. Writes via server route (not direct
  client insert) so server can attach `subject_user_id` reliably.
- Block flow already exists platform-wide — verify each report entry
  point also offers Block, reusing the existing block service.
- Reporter sees "we received it" state; no visibility into outcomes
  beyond generic notification if actioned.

## Phase V-4 — Moderation queue (Agent)

- Admin-only web/screen: list open reports, filter by category/status,
  view subject content snapshot, act (warn / remove content / suspend
  with expiry / ban / dismiss), every action writing `moderation_actions`.
- Suspension enforcement middleware on auth: suspended users get a
  read-only state with an appeal contact; banned users are signed out.
- `verification_revoked` action clears `profiles.verification_level`.

## Phase V-5 — Safety Center + age gating (Agent)

- Safety Center screen: links to Safe Return, SOS, verification status,
  blocked-users list, community guidelines, report history.
- Age gating: features flagged 18+ (nightlife-tagged events, Rent a
  Buddy) check `is_over_18` from the latest verified row; unverified
  users see a "verify to access" gate, not silent hiding.

## Phase V-6 — Provider go-live (OWNER + Agent)

Owner dashboard work:
- Choose Stripe Identity or Persona; create account; obtain API keys;
  configure webhook endpoint + signing secret; set Replit Secrets
  (`IDENTITY_PROVIDER`, provider keys, `IDENTITY_WEBHOOK_SECRET`).
Agent work:
- Implement the chosen adapter in `providers.ts` per the mapped TODOs;
  webhook signature verification; sandbox-mode end-to-end test; then flip
  `IDENTITY_PROVIDER` in staging → production.

Cost checkpoints: ~$1.50–3.00 per verification attempt at both vendors.
Rate limiting from V-1 is the cost-control mechanism; monitor attempts
per verified user (>2.0 average means UX friction worth fixing).

## Phase V-7 — GDPR / retention (Agent)

- Account-deletion flow calls `provider.requestProviderDeletion()` then
  deletes the user's `identity_verifications` rows.
- Retention job: purge failed/expired verification rows older than 90
  days.
- Document the data flow in the privacy policy surface.

## Sequencing note

V-1 and V-2 can start immediately after the E2EE migration merge — they
touch server routes and new screens, no overlap. V-3 must wait for the
Telegraph screen migration to settle. V-6 is gated on the provider
decision + owner dashboard access.
