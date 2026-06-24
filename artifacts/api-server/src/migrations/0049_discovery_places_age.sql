-- Migration: 0049_discovery_places_age.sql
-- Adds optional min_age / max_age columns to discovery_places so community
-- submissions can declare age requirements, enabling server-side age filtering
-- on GET /api/discovery/community.

ALTER TABLE public.discovery_places
  ADD COLUMN IF NOT EXISTS min_age integer CHECK (min_age >= 0 AND min_age <= 120),
  ADD COLUMN IF NOT EXISTS max_age integer CHECK (max_age >= 0 AND max_age <= 120);

COMMENT ON COLUMN public.discovery_places.min_age IS 'Minimum age (years) required; NULL = no minimum';
COMMENT ON COLUMN public.discovery_places.max_age IS 'Maximum age (years); NULL = no maximum';
