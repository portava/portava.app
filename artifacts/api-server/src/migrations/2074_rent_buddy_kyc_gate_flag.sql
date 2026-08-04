-- 2074_rent_buddy_kyc_gate_flag.sql
-- Override flag for the Rent-a-Buddy booking KYC gate (audit P1 item 8).
--
-- Rent-a-Buddy pairs strangers for in-person meetings, and production has no
-- working identity verification: both real adapters in
-- services/identityVerification/providers.ts are stubs whose every method
-- throws, and getIdentityProvider() refuses the mock provider in production.
-- No user can complete a check, so `rent_buddy_profiles.id_verified` can never
-- legitimately become true.
--
-- lib/rentBuddyKycGate.ts therefore blocks BOTH booking-creation paths
-- (POST /rent-a-buddy/bookings and POST /rent-a-buddy/bookings/:id/rebook)
-- with 503 verification_unavailable whenever verification is non-operational.
--
-- This flag is the ONLY way to override that block. It defaults to false and
-- is read with isFlagEnabled(), which returns false on any DB error — so a
-- database problem cannot accidentally open bookings.
--
-- ⚠ Enabling this flag means: unverified strangers may book each other for
--   in-person meetings. Only do so for a deliberate, supervised pilot.
--
-- The correct fix is not this flag — it is to implement a real provider:
--   1. Choose Stripe Identity or Persona.
--   2. Implement the adapter in providers.ts (the API mapping is already
--      written out in comments there).
--   3. Set STRIPE_IDENTITY_SECRET_KEY or PERSONA_API_KEY, plus
--      IDENTITY_WEBHOOK_SECRET, and IDENTITY_PROVIDER=<name>.
--   4. Add the provider name to IMPLEMENTED_PROVIDERS in
--      services/identityVerification/readiness.ts.
-- After step 4 the gate re-opens on its own and this flag stays false forever.
--
-- Note: payments are also still stubs (two 501 responses in
-- routes/rentABuddy.ts), so with this gate closed users additionally cannot
-- create bookings they would have had no way to pay for.

INSERT INTO feature_flags (flag, enabled, description, metadata) VALUES
  ('rent_buddy_allow_bookings_without_kyc', false,
   'Override: permit Rent-a-Buddy booking creation while identity verification is non-operational. Unsafe; for supervised pilots only.',
   '{"rollout":"audit-p1-8","unsafe":true,"requires_review":true}')
ON CONFLICT (flag) DO UPDATE SET
  description = EXCLUDED.description,
  metadata    = EXCLUDED.metadata;
