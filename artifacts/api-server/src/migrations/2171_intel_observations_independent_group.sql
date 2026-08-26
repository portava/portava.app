-- 2171 — IG V1 independent-group signal on intel_observations.
-- ═══════════════════════════════════════════════════════════════════════════
-- Owner ruling 2026-08-26: the privacy gate (PRIVACY_THRESHOLD_V1) requires
-- distinctGroups>=5 and maxSingleGroupShare<=0.2, but capture collected no group
-- identity, so every crowd snapshot was suppressed as invalid_input and no live
-- label could ever publish. This adds the two columns the projection needs.
--
--   group_key         — an EPHEMERAL, NON-REVERSIBLE HMAC token (lib/intelGroupKey).
--                       SHARED across members of one Trip Crew / party so 15 people
--                       from one organized group collapse to ONE group (the leak the
--                       gate must catch); PER-ACTOR for a solo "Just me" observer, so
--                       a solo visitor counts as its own independent group. NULL when
--                       identity is unavailable (non-crew "with others", or unknown /
--                       pre-signal rows) — excluded from the >=5-group requirement.
--                       It is a digest of a server secret, so it stores NO names and
--                       NO membership, and it is scoped to the subject so the same
--                       party at two venues is unlinkable.
--   party_size_bucket — the raw "Who are you here with?" attestation, kept for
--                       MEASUREMENT only (the funnel's "insufficient independent
--                       groups" vs "group identity unavailable" diagnostic and the
--                       party-mix distribution). It never feeds the public calc.
--
-- ADDITIVE + BACKWARDS-COMPATIBLE: both columns are nullable with NO default, so
-- every existing row reads NULL. intel_observations is append-only (2130 triggers
-- guard row UPDATE/DELETE, not DDL), so these are set at INSERT and never
-- backfilled — matching the ruling's "no retroactive inference". No feature flag
-- is seeded here; group collection rides the existing intel_capture_quick_signal.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

ALTER TABLE public.intel_observations
  ADD COLUMN IF NOT EXISTS group_key text,
  ADD COLUMN IF NOT EXISTS party_size_bucket text;

-- Constrain only the human-facing attestation. group_key is an opaque digest and
-- is intentionally unconstrained. The NULL branch keeps every pre-existing row valid.
DO $$ BEGIN
  ALTER TABLE public.intel_observations
    ADD CONSTRAINT intel_observations_party_size_bucket_check
      CHECK (party_size_bucket IS NULL OR party_size_bucket IN ('just_me','one_other','two_to_four','five_plus'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN public.intel_observations.group_key IS
  'Ephemeral non-reversible HMAC token identifying the observer''s independent group (shared per Trip Crew/party, per-actor for solo, NULL when unavailable). Feeds distinctGroups/maxGroupShare in the privacy gate. Stores no names/membership.';
COMMENT ON COLUMN public.intel_observations.party_size_bucket IS
  'Raw "Who are you here with?" attestation (just_me/one_other/two_to_four/five_plus). MEASUREMENT ONLY — never used in the public intelligence calculation.';

COMMIT;
