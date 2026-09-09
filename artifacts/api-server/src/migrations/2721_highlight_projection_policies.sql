-- 2721_highlight_projection_policies.sql
--
-- WHAT: one new table, public.highlight_projection_policies — the §10 audience
-- and precision policy for a Highlight. One row per Highlight, holding the
-- owner-selected location precision, the person-visibility rung, and the five
-- §10 consent dimensions as separate booleans. Nothing existing is altered.
--
-- WHY. Highlights/Memories Development Architecture Spec v1 §3.5 gives a
-- Highlight an `audience_policy_id`; §3.6 names the table
-- `memory_visibility_policies`, "Audience and location precision policy"; §10
-- states the invariant this table exists to make checkable:
--
--     "Publishing location must never exceed the owner's selected precision."
--
-- WHAT WAS MEASURED BEFORE WRITING THIS (production snapshot
-- src/lib/capability/snapshots/20260908-production-schema.json, and grep):
--
--   * public.highlights = id, owner_id, media_url, media_type,
--     video_duration_seconds, caption, location_name, location_city,
--     location_country, visibility, expires_at, created_at, deleted_at,
--     archived_at, filter_id, filter_intensity, updated_at.
--     THERE IS NO PRECISION COLUMN AND NO AUDIENCE POLICY. `visibility` is a
--     five-value audience enum; it says who may see the Highlight, never how
--     much location detail they see. So "the owner's selected precision" does
--     not exist to be exceeded, which is why census H81 is NOT-BUILT rather
--     than BUILT-BUT-WRONG.
--
--   * The only location clamp anywhere near this data is the Hidden-Gem ceiling
--     in lib/mediaLocationVisibility.ts, applied at routes/memories.ts:87-107.
--     It is a CEILING IMPOSED BY A PLACE, not a precision CHOSEN BY AN OWNER,
--     and it never runs on `highlights` (census H76). This table is the missing
--     owner-chosen half; the two compose with `strictestPrecision`, which only
--     ever moves toward HIDDEN.
--
--   * routes/highlights.ts persists location_name / location_city /
--     location_country verbatim from the client with no precision control at
--     all (census H82).
--
-- WHY FIVE BOOLEAN COLUMNS AND NOT A jsonb BAG. §10's five consent dimensions
-- are a closed set, and the read code must distinguish THREE states per
-- dimension: granted (stored true), withheld (stored false), and unknown
-- (absent / null / not a boolean). A jsonb bag makes `unknown` and `withheld`
-- the same shape unless every reader remembers to check, and the one thing this
-- policy may never do is let an unreadable consent render as consent given. A
-- nullable boolean column per dimension makes the three states structural.
-- All five default to NULL — i.e. UNKNOWN, i.e. refuse — deliberately: a
-- DEFAULT FALSE would be a stored withholding nobody chose, and a DEFAULT TRUE
-- would be manufactured consent.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ============================================
-- It does not set a default precision for the Highlights that exist today, and
-- it adds no trigger or backfill that would. LOCATION_PRECISION_DEFAULT — what
-- precision applies to a Highlight whose owner has never chosen one — is an
-- OWNER decision on the blocker ledger. §10 says the default should be
-- restrictive ("Temporary operational location must not leak into durable
-- public Highlights by default") but does not name a rung, and choosing one
-- here would strip location text from every Highlight now on the surface
-- through a migration rather than through a decision. So: no row is created for
-- any existing Highlight, `resolveLocationDisclosure` reports
-- `applied: false, reason: "no owner-selected precision"`, and the response is
-- byte-for-byte what it is today until an owner picks a rung.
--
-- It also does not add `audience_policy_id` to `highlights`. The FK direction
-- here is policy → highlight, so the join works without touching the hot table,
-- and §3.5's `audience_policy_id` can be added later as a plain column if a
-- Highlight ever needs to share one policy row with another.
--
-- READ-SIDE CONTRACT. services/highlights/highlightProjectionPolicy.ts returns
-- three states, and the fail-closed answers differ per axis:
--     ready + no row   → precision UNSET (row unchanged), consent UNKNOWN (refuse)
--     absent           → report "not deployed", do NOT clamp, log at ERROR
--     unreadable       → CLAMP TO HIDDEN. A location we cannot prove is within
--                        the owner's precision is a location we do not publish.
--
-- REVERSIBLE BY:
--   DROP TABLE IF EXISTS public.highlight_projection_policies;
-- The read code returns to `absent`, nothing is clamped, and the surface is
-- exactly as it is before this migration. No other object is touched.
--
-- NOT APPLIED BY THIS LANE. Written only.

CREATE TABLE IF NOT EXISTS public.highlight_projection_policies (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  highlight_id  UUID NOT NULL UNIQUE
                  REFERENCES public.highlights(id) ON DELETE CASCADE,
  owner_id      UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,

  -- §10 location precision ladder, coarsening left to right.
  -- NULL = the owner has not chosen. NOT a default; see the header.
  location_precision TEXT
                  CHECK (location_precision IN
                         ('EXACT', 'VENUE', 'NEIGHBORHOOD', 'CITY', 'COUNTRY', 'HIDDEN')),

  -- §10 person visibility ladder. NULL = not chosen; the read code treats an
  -- unset rung the same as it treats an unset precision — unenforced and said
  -- so, never silently NAMED.
  person_visibility TEXT
                  CHECK (person_visibility IN
                         ('NAMED', 'PROFILE_LINKED', 'CREW_ONLY', 'ANONYMOUS_COUNT', 'HIDDEN')),

  -- §10 consent dimensions. Three states each: TRUE granted, FALSE withheld,
  -- NULL unknown. NULL is the default and it REFUSES.
  consent_store                          BOOLEAN,
  consent_resurface                      BOOLEAN,
  consent_personalize                    BOOLEAN,
  consent_share                          BOOLEAN,
  consent_contribute_to_aggregate_intel  BOOLEAN,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The read path is "the policies for the highlights on this page".
CREATE INDEX IF NOT EXISTS highlight_projection_policies_highlight_idx
  ON public.highlight_projection_policies (highlight_id);

CREATE INDEX IF NOT EXISTS highlight_projection_policies_owner_idx
  ON public.highlight_projection_policies (owner_id);

ALTER TABLE public.highlight_projection_policies ENABLE ROW LEVEL SECURITY;

-- Owner-only, all four verbs.
--
-- WHY VIEWERS DO NOT GET A SELECT POLICY EVEN THOUGH THE POLICY GOVERNS WHAT
-- THEY SEE: the policy row is the owner's private choice, and the clamped
-- OUTPUT is what a viewer is entitled to — not the rule that produced it.
-- Letting a viewer read `location_precision = 'COUNTRY'` tells them a precise
-- location exists and is being withheld, which is a smaller disclosure than the
-- location itself but is still one nobody asked for. The server reads this
-- table through the service client inside the projection pass, exactly as it
-- already does for every other Highlights read.
CREATE POLICY highlight_projection_policies_select_own
  ON public.highlight_projection_policies
  FOR SELECT TO authenticated
  USING (owner_id = auth.uid());

CREATE POLICY highlight_projection_policies_insert_own
  ON public.highlight_projection_policies
  FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY highlight_projection_policies_update_own
  ON public.highlight_projection_policies
  FOR UPDATE TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY highlight_projection_policies_delete_own
  ON public.highlight_projection_policies
  FOR DELETE TO authenticated
  USING (owner_id = auth.uid());

COMMENT ON TABLE public.highlight_projection_policies IS
  'Highlights/Memories spec v1 §10 / §3.5 audience_policy. One row per Highlight. '
  'location_precision and person_visibility are NULL until the owner chooses — '
  'LOCATION_PRECISION_DEFAULT is an unmade owner decision and this migration does not take it. '
  'The five consent columns are three-valued: TRUE grants, FALSE withholds, NULL is unknown and refuses.';
