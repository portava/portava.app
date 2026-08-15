-- 2095_discovery_place_photos.sql
--
-- Persist the CANONICAL RESOLVED PHOTO for a place, so the FSQ -> Google ->
-- artwork chain stops being re-paid by every viewer of every card.
--
-- Classified by the owner as ENABLING INFRASTRUCTURE, not a new product
-- feature: the product already resolves that chain, so storing the winner adds
-- no behaviour -- it removes repeated external-provider work from behaviour
-- that is already approved.
--
-- WHY THIS IS A SEPARATE TABLE AND NOT A COLUMN ON discovery_places.
-- discovery_places holds PLACE RECORDS (city, name, category, blurb, rating).
-- The overwhelming majority of OSM places served by Discovery have no row there
-- and never will -- rows exist only for seeded or saved places. Writing place
-- rows for every place anyone looked at in order to hang a photo off them would
-- build a place corpus as a side effect, and corpus-building is explicitly NOT
-- the objective here; caching a resolved product fact is.
--
-- So this table holds a photo and nothing else. It carries no place attributes,
-- it cannot be browsed as a catalogue of places, and deleting all of it costs
-- nothing but a re-resolve.
--
-- WHY NOT discovery_cache: that table is a 2-hour L2 cache of whole result
-- payloads keyed by SEARCH QUERY. A photo is neither query-scoped nor
-- 2-hour-lived, and storing one there would inherit invalidation semantics that
-- are wrong for it in both directions.

CREATE TABLE IF NOT EXISTS public.discovery_place_photos (
  -- Place identity, namespaced. OSM places use the same `osm:<type>/<id>` form
  -- that discovery_places.tag already uses, so the two agree on what a place is.
  place_key    text PRIMARY KEY,

  -- Which provider resolved it. This is the source metadata the ruling asks to
  -- persist alongside the photo, and it is what lets the card's EXISTING
  -- provenance UI say something true instead of nothing.
  source       text NOT NULL CHECK (source IN ('foursquare', 'google')),

  -- A directly renderable URL, when the provider gives one that is stable.
  -- Foursquare photo URLs are plain CDN URLs and go here.
  photo_url    text,

  -- A provider-native identifier that must be turned into a URL at read time.
  --
  -- THIS COLUMN EXISTS BECAUSE OF A REAL FAILURE MODE. Google's photo media URL
  -- embeds the API key (`.../media?maxWidthPx=800&key=<KEY>`). Persisting that
  -- rendered URL would bake a credential into a stored row, and the day the key
  -- is rotated every stored photo becomes a dead link -- which renders as "this
  -- place has no photo", indistinguishable from never having resolved one. So
  -- Google rows store the photo RESOURCE NAME here and the URL is minted per
  -- read against the current key.
  photo_ref    text,

  resolved_at  timestamptz NOT NULL DEFAULT now(),

  -- REFRESH HORIZON. A row at or past this instant is treated as absent: the
  -- live chain runs again and the result is written back. This is what stops a
  -- photo resolved during a provider outage (Foursquare was returning HTTP 429
  -- on 2026-08-15, so Google was carrying every card) from being frozen in as
  -- the permanent answer.
  expires_at   timestamptz NOT NULL,

  -- Set when a read finds the row unusable (e.g. a Google row whose ref cannot
  -- be minted). Kept as a column rather than an immediate DELETE so that a
  -- broken row is observable rather than silently vanishing -- a signal nobody
  -- can read is not a signal.
  invalid_at   timestamptz,

  -- Exactly one of the two representations must be present, or the row is a
  -- stored nothing that reads as a resolved photo.
  CONSTRAINT discovery_place_photos_has_photo
    CHECK (photo_url IS NOT NULL OR photo_ref IS NOT NULL)
);

-- Read path is always "fresh row for this key?", so the PK covers lookups.
-- This index covers the sweep of expired/invalid rows.
CREATE INDEX IF NOT EXISTS discovery_place_photos_expires_at_idx
  ON public.discovery_place_photos (expires_at);

-- Server-side only. This table is written by the api-server's service role and
-- never read directly by a client, so no anon/authenticated grants are issued
-- and RLS stays on with no permissive policy.
ALTER TABLE public.discovery_place_photos ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.discovery_place_photos FROM anon, authenticated;
