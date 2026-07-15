-- 0083_place_category_columns.sql
-- Adds primary_category and secondary_categories to discovery_places.
--
-- primary_category: canonical Discovery tab key (food|beaches|nightlife|activities|events|places|transport|other)
-- secondary_categories: additional canonical categories for multi-category places
--
-- Backfills from existing category + place_type values using the same mapping
-- logic as the server-side placeCategories.ts module.
-- Safe to re-run: uses IF NOT EXISTS / DO NOTHING guards.

ALTER TABLE discovery_places
  ADD COLUMN IF NOT EXISTS primary_category  text,
  ADD COLUMN IF NOT EXISTS secondary_categories text[] NOT NULL DEFAULT '{}';

-- Backfill primary_category from the canonical mapping.
-- Priority order: category field → place_type field → 'places' default.
UPDATE discovery_places SET primary_category = CASE
  -- ── food ──────────────────────────────────────────────────────────────────
  WHEN lower(category)   IN ('food','restaurant','cafe','bistro','bakery','hawker centre','hawker center','food court','eatery','snack','diner','fast food','ice cream') THEN 'food'
  WHEN lower(place_type) IN ('food','restaurant','cafe','bistro','bakery','hawker centre','hawker center','food court','eatery','snack','diner','market','fast food','ice cream') THEN 'food'
  WHEN lower(category)   = 'market' AND lower(place_type) IN ('restaurant','cafe','food','hawker centre') THEN 'food'

  -- ── beaches ───────────────────────────────────────────────────────────────
  WHEN lower(category)   IN ('beaches','beach','beach club','beach resort','surf beach') THEN 'beaches'
  WHEN lower(place_type) IN ('beach','beach club','beach resort','surf beach') THEN 'beaches'

  -- ── nightlife ─────────────────────────────────────────────────────────────
  WHEN lower(category)   IN ('nightlife','bar','pub','nightclub','casino','lounge','cocktail bar','rooftop bar','club','biergarten') THEN 'nightlife'
  WHEN lower(place_type) IN ('bar','pub','nightclub','casino','lounge','cocktail bar','rooftop bar','club','biergarten') THEN 'nightlife'

  -- ── activities ────────────────────────────────────────────────────────────
  WHEN lower(category)   IN ('activities','activity','park','garden','viewpoint','nature reserve','natural landmark','volcano','island','water park','theme park','zoo','aquarium','marina','hiking','sport','gym','fitness centre','sports centre','swimming pool','golf course','stadium') THEN 'activities'
  WHEN lower(place_type) IN ('park','garden','viewpoint','nature reserve','natural landmark','volcano','island','water park','theme park','zoo','aquarium','marina','stadium') THEN 'activities'

  -- ── events ────────────────────────────────────────────────────────────────
  WHEN lower(category)   IN ('events','event','museum','gallery','theatre','cinema','arts centre','festival','concert','performance','arena','concert hall') THEN 'events'
  WHEN lower(place_type) IN ('museum','gallery','theatre','cinema','arts centre','festival','concert','arena','concert hall','stadium') AND lower(category) = 'events' THEN 'events'

  -- ── transport ─────────────────────────────────────────────────────────────
  WHEN lower(category)   IN ('transport','transit','airport','station','bus station','ferry','metro','subway') THEN 'transport'
  WHEN lower(place_type) IN ('transport','transit','airport','station','bus station','ferry','metro','subway') THEN 'transport'

  -- ── places / landmarks ───────────────────────────────────────────────────
  WHEN lower(category)   IN ('places','place','attraction','landmark','temple','church','cathedral','mosque','shrine','monument','palace','castle','fort','ruins','historic district','heritage site','shopping district','entertainment district','mall','shopping','street','neighborhood','square') THEN 'places'
  WHEN lower(place_type) IN ('landmark','temple','church','cathedral','mosque','shrine','monument','palace','castle','fort','ruins','historic district','heritage site','attraction','shopping','neighborhood','shopping district','entertainment district') THEN 'places'

  -- ── default ───────────────────────────────────────────────────────────────
  ELSE 'places'
END
WHERE primary_category IS NULL;

-- After backfill, set NOT NULL
ALTER TABLE discovery_places ALTER COLUMN primary_category SET NOT NULL;
ALTER TABLE discovery_places ALTER COLUMN primary_category SET DEFAULT 'places';

-- Index for fast category-filtered queries
CREATE INDEX IF NOT EXISTS discovery_places_primary_category_idx
  ON discovery_places (primary_category);

CREATE INDEX IF NOT EXISTS discovery_places_city_category_idx
  ON discovery_places (city, primary_category);
