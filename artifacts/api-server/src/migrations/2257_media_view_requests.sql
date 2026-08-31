-- 2257_media_view_requests.sql
-- Media v2 Phase 10 (Human Network) — Request-a-View (§19) storage.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Media band 2257+.
--
-- Additive + idempotent. Safe to re-run. This migration does NOT fork the
-- mission/coverage system: a Request-a-View creates a targeted coverage task in
-- the EXISTING public.intel_mission_candidates store (2167). These two tables are
-- the media-owned FRONT of that flow — the contributor opt-in registry and the
-- per-viewer request ledger that the mission table has no place for. The actual
-- coverage/mission row lives in intel_mission_candidates, referenced here by FK.
--
-- Adds three things, all dark until an admin flips the flag:
--
--   1. feature flag `media_request_a_view_enabled` (CAPABILITY, seeded FALSE) —
--      the master gate. Its reader is services/media/MediaViewRequestService,
--      added in the same change (check-flag-polarity: a flag arrives with the
--      unit that reads it). `*_enabled` ⇒ CAPABILITY; a read that fails is
--      fail-closed to false (isFlagEnabled), so an unhealthy DB leaves the
--      feature OFF — never silently on.
--
--   2. public.media_view_request_optins — the OPT-IN + eligibility registry.
--      A contributor is asked for a view ONLY when a row exists with
--      opted_in = true AND eligible = true. Absent row / either false ⇒ never
--      asked (fail-closed). opted_in is the contributor's own choice (they set
--      it); eligible is service-owned (trust/verification), never self-set —
--      the same self-verification hazard 2144/2154 closed elsewhere. No client
--      grant: the service role reads/writes both on the caller's behalf.
--
--   3. public.media_view_requests — the per-viewer request LEDGER, for
--      throttling, dedupe, and audit. Each row references the
--      intel_mission_candidates row it created (ON DELETE SET NULL) and records
--      how many opted-in eligible contributors were asked (recipient_count).
--
-- RUNTIME EFFECT: NONE. Flag seeded false ⇒ the service refuses every request
-- (fail-closed) until the owner presses the flag. No data written, only schema +
-- one disabled flag row. The intel_mission_candidates table and its dispatch
-- gating (intel_missions) are untouched — a request-created candidate is a
-- NON-CASH 'candidate' that the intel dispatch path still gates exactly as today.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags does not exist.';
  END IF;
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.profiles does not exist.';
  END IF;
  IF to_regclass('public.places') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.places does not exist.';
  END IF;
  IF to_regclass('public.intel_mission_candidates') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.intel_mission_candidates does not exist (needs 2167). Request-a-View creates coverage tasks THERE, not in a parallel store.';
  END IF;
END $$;

-- ── 1. Master gate flag (CAPABILITY, OFF) ────────────────────────────────────
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'media_request_a_view_enabled',
    false,
    'Master gate for Media v2 Phase 10 Request-a-View (§19). OFF (the seed): services/media/MediaViewRequestService refuses every request (fail-closed) and asks no contributor. ON: an eligible viewer may request a current perspective of a place; the service throttles per-viewer and per-place, dedupes near-duplicate open requests, refuses any request that would pinpoint a restrictive Hidden Gem / protected location, selects ONLY opted-in + eligible + un-blocked contributors to notify, and creates a NON-CASH targeted coverage task in the existing intel_mission_candidates store. Reads are fail-closed (isFlagEnabled) so an unreadable flag leaves the feature OFF. A request is a prompt for a fresh observation, never a demand, and never surfaces to a contributor who did not opt in.'
  )
ON CONFLICT (flag) DO NOTHING;

-- ── 2. Contributor OPT-IN + eligibility registry ─────────────────────────────
-- Fail-closed by construction: the default of both booleans is FALSE, and the
-- selector (lib/mediaViewRequest.selectEligibleRecipients) requires BOTH true.
CREATE TABLE IF NOT EXISTS public.media_view_request_optins (
  contributor_id  uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- The contributor's OWN choice to be asked for view requests. They set this.
  opted_in        boolean NOT NULL DEFAULT false,
  -- Service-owned eligibility (trust / verification / standing). NEVER self-set
  -- by the contributor — kept a separate column so a client write-grant could
  -- never let a user make themselves eligible.
  eligible        boolean NOT NULL DEFAULT false,
  -- Optional scoping: the city the contributor is active in. NULL = unscoped.
  city            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS media_view_request_optins_askable_idx
  ON public.media_view_request_optins (city)
  WHERE opted_in = true AND eligible = true;

-- ── 3. Per-viewer request LEDGER ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.media_view_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id          uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  subject_id            uuid NOT NULL REFERENCES public.places(id) ON DELETE CASCADE,
  claim_family          text NOT NULL,
  city                  text,
  zone_id               text,
  question              text NOT NULL,
  -- The coverage task this request created, in the EXISTING mission store.
  -- ON DELETE SET NULL: erasing the candidate does not erase the audit ledger row.
  mission_candidate_id  uuid REFERENCES public.intel_mission_candidates(id) ON DELETE SET NULL,
  status                text NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open','fulfilled','expired','refused')),
  -- How many opted-in + eligible + un-blocked contributors were asked. 0 is a
  -- valid, graceful outcome (pre-launch: no eligible contributors yet).
  recipient_count       integer NOT NULL DEFAULT 0 CHECK (recipient_count >= 0),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz
);

-- Per-viewer throttle window scan + dedupe of a viewer's own open requests.
CREATE INDEX IF NOT EXISTS media_view_requests_requester_created_idx
  ON public.media_view_requests (requester_id, created_at DESC);
-- Per-(place, family) open-request dedupe scan.
CREATE INDEX IF NOT EXISTS media_view_requests_subject_family_status_idx
  ON public.media_view_requests (subject_id, claim_family, status);

-- ── RLS + grants (2130/2167 shape: deny-default, REVOKE ALL then grant service_role) ─
-- Internal only: the service role reads/writes on the caller's behalf through the
-- route. No client grant and no authenticated policy — these are not user-facing
-- tables, and eligibility especially must never be client-writable.
ALTER TABLE public.media_view_request_optins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.media_view_request_optins FROM PUBLIC;
REVOKE ALL ON public.media_view_request_optins FROM anon;
REVOKE ALL ON public.media_view_request_optins FROM authenticated;
REVOKE ALL ON public.media_view_request_optins FROM service_role;
GRANT INSERT, SELECT, UPDATE ON public.media_view_request_optins TO service_role;

ALTER TABLE public.media_view_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.media_view_requests FROM PUBLIC;
REVOKE ALL ON public.media_view_requests FROM anon;
REVOKE ALL ON public.media_view_requests FROM authenticated;
REVOKE ALL ON public.media_view_requests FROM service_role;
GRANT INSERT, SELECT, UPDATE ON public.media_view_requests TO service_role;

-- ── Postconditions (conditional RAISE only) ──────────────────────────────────
DO $$
DECLARE present int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags WHERE flag = 'media_request_a_view_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_request_a_view_enabled not present after seed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'media_request_a_view_enabled' AND enabled = TRUE) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_request_a_view_enabled seeded ON — the feature must ship OFF';
  END IF;
  IF to_regclass('public.media_view_request_optins') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_view_request_optins not created';
  END IF;
  IF to_regclass('public.media_view_requests') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_view_requests not created';
  END IF;
END $$;

COMMIT;

-- REVERSAL (manual):
--   DROP TABLE IF EXISTS public.media_view_requests;
--   DROP TABLE IF EXISTS public.media_view_request_optins;
--   DELETE FROM public.feature_flags WHERE flag = 'media_request_a_view_enabled';
-- The reversal only removes dark schema + a disabled flag; no served data changes.
