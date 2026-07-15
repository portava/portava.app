-- 0126: enforce canonical-location identity at the database level.
--
-- The resolver's find-then-insert is not atomic: two concurrent resolves for
-- the same place could both miss the SELECT and both INSERT, creating two
-- canonical rows for one real-world location. This unique expression index
-- makes the second INSERT fail with 23505; the resolver catches that and
-- re-matches against the winner's row.
--
-- Identity = normalized name + coarse kind class + country code (unknown
-- country collapses to '', so "Cebu" and "Cebu City" racing on first-ever
-- resolve collide as intended). The CASE mirrors kindClass() in
-- src/lib/canonicalLocations.ts — keep the two in sync.

CREATE UNIQUE INDEX IF NOT EXISTS uq_canonical_locations_identity
ON public.canonical_locations (
  normalized_name,
  (CASE
    WHEN kind IN ('country', 'region') THEN 'admin'
    WHEN kind IN ('city', 'town', 'district', 'neighborhood') THEN 'city'
    ELSE 'venue'
  END),
  COALESCE(country_code, '')
);
