-- 2910_discovery_trails.sql
--
-- `docs/specs/discovery-v1/02_Trails.md` §18 — the canonical Trail object.
-- census-discovery DV-20, DV-24, DC-02, DC-03, DC-04, DC-05, DC-20.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2910.
--
-- ⚠ THE NAME COLLIDES. READ THIS BEFORE ASSUMING WHAT A "TRAIL" IS HERE.
-- =====================================================================
-- `lib/trailLiveIntel.ts` and `GET /v1/trails/:id/live-intel` already say
-- "trail" and mean something else entirely: a `route_plans` row with
-- `route_stops`, i.e. one trip's route, Intelligence Gathering §19. THIS file
-- builds `02_Trails.md`'s object — a PERMANENT, themed discovery space
-- ("Bangkok After Dark") that organises content, places and other Trails around
-- a travel theme. It does not touch `route_plans` or `route_stops`, and the two
-- must never be merged.
--
-- WHY THIS IS BUILT NOW, AND WHY IT IS NOT A CONTRADICTION OF THE RULING
-- =====================================================================
-- `docs/discovery/ROADMAP.md:148` marks "Anything assuming the six P1
-- components are **peer scoring systems**" as "STALE — must be re-scoped before
-- implementation". `docs/architecture/02_Trails.md:5-12` records the re-scope
-- that answers it: "ROADMAP step 7 keeps trails only as a future MODIFIER to
-- the ranker, never a parallel engine." The owner has lifted the freeze on this
-- scope; the re-scope still governs the SHAPE. So:
--
--   BUILT HERE       the OBJECT — identity, membership, relationships, health.
--   NOT BUILT HERE   any ordering, any score column, any ranking table. The one
--                    number Trails contributes is computed in
--                    lib/discoveryTrailAffinity.ts, is capped at 0.10 in code,
--                    and is shaped as a modifier map for the EXISTING ranker.
--
-- MIGRATION 2290 IS NOT SUPERSEDED, AND DELIBERATELY SO
-- ====================================================
-- 2290's postcondition RAISEs if `trail` is ever admitted to
-- `compass_graph_nodes.node_type`. Nothing here needs that lifted. A Trail's
-- relationships live in `trail_edges` (§6's own six edge types, which the
-- intelligence graph's vocabulary does not contain), and Trails contribute to
-- ranking as a bounded modifier rather than as a graph-walked entity. Admitting
-- a `trail` node kind would make Trails a peer of `person`/`place`/`event` in
-- the graph engine — which is the peer-system reading the ruling marked STALE.
-- 2290 stays as written and `10` §7's "never edit an applied migration" is not
-- exercised.
--
-- COORDINATION: this file touches NONE of rank_events, place_momentum,
-- protected_zones, canonical_locations, or any feature_flags row. Trail
-- behaviour is read from `rank_events` and folded onto Trails in application
-- code (lib/discoveryTrailAffinity.trailMomentumFromRankEvents), so `04` §2's
-- "Do not create a new parallel behavior store" is not re-opened: no table
-- below records an impression or an outcome.
--
-- RUNTIME EFFECT ON EXISTING SURFACES: NONE. No existing table, column,
-- constraint, policy or flag is altered. Until this file is applied, the new
-- routes under /api/v1/discovery/trails read a missing relation and degrade to
-- 503 `degraded_unavailable` (services/trails/TrailService.ts), which is the
-- behaviour every deployment has today.
--
-- Readers: services/trails/TrailService.ts, routes/trails.ts
--          (/api/v1/discovery/trails*), lib/discoveryTrailAffinity.ts.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $pre$
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION '2910: PRECONDITION FAILED: public.profiles is required for contributor references';
  END IF;
  IF to_regclass('public.trails') IS NOT NULL THEN
    RAISE EXCEPTION '2910: public.trails already exists; this migration is not idempotent by design';
  END IF;
END
$pre$;

-- ── §18 `trails` ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.trails (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              text        NOT NULL,
  title             text        NOT NULL,
  description       text        NULL,
  -- §1's "destination/place scope", split: a lowercased destination string (the
  -- same shape GET /discovery already takes) and an optional canonical place.
  destination       text        NULL,
  place_scope       uuid        NULL,
  parent_trail_id   uuid        NULL REFERENCES public.trails(id) ON DELETE SET NULL,
  lifecycle_status  text        NOT NULL DEFAULT 'proposed',
  created_by        uuid        NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  -- §5's canonicalization metadata: which of the four checks ran, what they
  -- measured, and the origin. A record of HOW the Trail was admitted, so a
  -- later duplicate argument has evidence instead of opinions.
  canonicalization  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- DV-20: "Trails are canonical objects, not strings". The slug is the
  -- canonical handle and it is UNIQUE, so two spellings of one theme cannot
  -- both exist. Content references trails.id, never a title.
  CONSTRAINT trails_slug_unique UNIQUE (slug),
  CONSTRAINT trails_slug_shape CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  -- §7's five states, verbatim. Mirrored by TRAIL_LIFECYCLE_STATES in
  -- lib/discoveryTrailObject.ts; src/test/discoveryTrailSchemaContract.test.ts
  -- fails if the two ever disagree.
  CONSTRAINT trails_lifecycle_known CHECK (
    lifecycle_status IN ('proposed','active','needs_update','stale','archived')),
  CONSTRAINT trails_not_own_parent CHECK (parent_trail_id IS DISTINCT FROM id)
);
COMMENT ON TABLE public.trails IS
  '02_Trails.md §18: the canonical Trail — a permanent themed discovery space. NOT route_plans (that is the IG §19 trail). Identity is the UNIQUE slug plus this id; content references trail_id and never a title (DV-20). Ranking contribution is a capped modifier in lib/discoveryTrailAffinity.ts, never an ordering of its own (ROADMAP step 7).';
CREATE INDEX IF NOT EXISTS idx_trails_destination_lifecycle ON public.trails (destination, lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_trails_parent ON public.trails (parent_trail_id) WHERE parent_trail_id IS NOT NULL;

-- ── §18 `content_trails` ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.content_trails (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trail_id       uuid        NOT NULL REFERENCES public.trails(id) ON DELETE CASCADE,
  source_type    text        NOT NULL,
  source_id      uuid        NOT NULL,
  relationship   text        NOT NULL,
  -- §4's Signal vocabulary, required exactly when relationship = 'signal'.
  signal         text        NULL,
  source         text        NOT NULL DEFAULT 'user',
  confidence     numeric     NOT NULL DEFAULT 0.5,
  contributor_id uuid        NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  content_state  text        NOT NULL DEFAULT 'just_arrived',
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_trails_source_type_known CHECK (
    source_type IN ('post','place','event','itinerary','route')),
  CONSTRAINT content_trails_relationship_known CHECK (
    relationship IN ('primary','supporting','signal')),
  CONSTRAINT content_trails_source_known CHECK (
    source IN ('curated','user','community','system')),
  -- §7's six in-Trail content states, verbatim.
  CONSTRAINT content_trails_state_known CHECK (
    content_state IN ('just_arrived','growing','featured','evergreen','rediscovered','archived_from_active_rotation')),
  -- §4's eight Signals — a CLOSED set, so a label cannot become free text.
  CONSTRAINT content_trails_signal_vocabulary CHECK (
    (relationship = 'signal' AND signal IN ('luxury','solo_friendly','late_night','family','hidden_gem','rooftop','food','live_music'))
    OR (relationship <> 'signal' AND signal IS NULL)),
  CONSTRAINT content_trails_confidence_bounded CHECK (confidence >= 0 AND confidence <= 1)
);
COMMENT ON TABLE public.content_trails IS
  '02_Trails.md §18: membership of content in a Trail. relationship is §4''s primary | supporting | signal; signal carries §4''s closed eight-word vocabulary. NOT a behaviour store — no impression or outcome is ever written here (04 §2); Trail momentum is folded from rank_events in lib/discoveryTrailAffinity.ts.';
-- Uniqueness with a nullable column: COALESCE, because NULLs are DISTINCT by
-- default and a plain UNIQUE would admit unlimited duplicate primary rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_content_trails_label
  ON public.content_trails (trail_id, source_type, source_id, relationship, COALESCE(signal, ''));
CREATE INDEX IF NOT EXISTS idx_content_trails_trail ON public.content_trails (trail_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_trails_source ON public.content_trails (source_type, source_id);

-- ── §4's label cap, enforced in the DATABASE as well as in code (DC-02) ──────
--
-- "Do not let creators attach unlimited discovery labels."
--
-- The application enforces this too (lib/discoveryTrailObject.capTrailLabels),
-- and that is not redundancy for its own sake: the cap is a property of the
-- DATA, and a cap that lives only in one write path stops being true the moment
-- a second write path exists. THREE SEPARATE BUDGETS, not one pool — a shared
-- pool would let a creator spend the whole allowance on Signals and leave the
-- content in no Trail, inverting what §4 is for.
CREATE OR REPLACE FUNCTION public.content_trails_label_cap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE held int; cap int;
BEGIN
  cap := CASE NEW.relationship
           WHEN 'primary'    THEN 1
           WHEN 'supporting' THEN 3
           WHEN 'signal'     THEN 5
         END;
  SELECT count(*) INTO held
    FROM public.content_trails
   WHERE source_type = NEW.source_type
     AND source_id = NEW.source_id
     AND relationship = NEW.relationship
     AND id IS DISTINCT FROM NEW.id;
  IF held >= cap THEN
    RAISE EXCEPTION '02 §4: % label cap of % reached for %:%',
      NEW.relationship, cap, NEW.source_type, NEW.source_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.content_trails_label_cap() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.content_trails_label_cap() IS
  '02_Trails.md §4 "Do not let creators attach unlimited discovery labels": one primary Trail, three supporting, five Signals — three separate budgets per piece of content. Mirrored by MAX_PRIMARY_TRAILS / MAX_SUPPORTING_TRAILS / MAX_SIGNALS in lib/discoveryTrailObject.ts.';

DROP TRIGGER IF EXISTS content_trails_label_cap_trg ON public.content_trails;
CREATE TRIGGER content_trails_label_cap_trg
  BEFORE INSERT OR UPDATE OF relationship, source_type, source_id ON public.content_trails
  FOR EACH ROW EXECUTE FUNCTION public.content_trails_label_cap();

-- ── §18 `trail_edges` (§6 relationships — DV-24) ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.trail_edges (
  from_trail_id uuid        NOT NULL REFERENCES public.trails(id) ON DELETE CASCADE,
  to_trail_id   uuid        NOT NULL REFERENCES public.trails(id) ON DELETE CASCADE,
  edge_type     text        NOT NULL,
  strength      numeric     NOT NULL DEFAULT 0.5,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_trail_id, to_trail_id, edge_type),
  -- §6's six relationship kinds, verbatim. NOT the intelligence graph's
  -- vocabulary: this is why 2290's refusal of a `trail` node kind still holds.
  CONSTRAINT trail_edges_type_known CHECK (
    edge_type IN ('parent','child','related','seasonal_variant','geographic_sub','experience_branch')),
  CONSTRAINT trail_edges_no_self CHECK (from_trail_id <> to_trail_id),
  CONSTRAINT trail_edges_strength_bounded CHECK (strength >= 0 AND strength <= 1)
);
COMMENT ON TABLE public.trail_edges IS
  '02_Trails.md §18/§6: navigable relationships between Trails (DV-24). Six edge types. Separate from compass_graph_edges by design — migration 2290 refuses a trail node kind and this table is why that refusal costs nothing.';
CREATE INDEX IF NOT EXISTS idx_trail_edges_to ON public.trail_edges (to_trail_id, edge_type);

-- ── §18 `trail_health_snapshots` (§11 — DC-05) ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.trail_health_snapshots (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trail_id      uuid        NOT NULL REFERENCES public.trails(id) ON DELETE CASCADE,
  -- §11's nine metrics. A metric with no input is stored as JSON null and named
  -- in `unmeasured`, never defaulted to zero (census-discovery DV-79's rule).
  metrics       jsonb       NOT NULL,
  model_version text        NOT NULL,
  -- 10 §5: a derived feature retains the window it was computed over.
  member_count  int         NOT NULL DEFAULT 0,
  captured_at   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.trail_health_snapshots IS
  '02_Trails.md §11 health metrics with the model version that produced them (10 §5). Health influences ranking through lib/discoveryTrailHealth.trailHealthScale, which is floored at 0.85 — §11: health must not silently erase legitimate content.';
CREATE INDEX IF NOT EXISTS idx_trail_health_recent ON public.trail_health_snapshots (trail_id, captured_at DESC);

-- ── `trail_follows` — §3 contributors/followers, and the affinity input ──────
CREATE TABLE IF NOT EXISTS public.trail_follows (
  trail_id   uuid        NOT NULL REFERENCES public.trails(id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trail_id, user_id)
);
COMMENT ON TABLE public.trail_follows IS
  '11 §3 follow/unfollow Trail. A SUBSCRIPTION, not a behaviour record: no impression, outcome or engagement is written here (04 §2 / DC-08). Read by lib/discoveryTrailAffinity.ts to decide which Trails a viewer''s modifier map is built from.';
CREATE INDEX IF NOT EXISTS idx_trail_follows_user ON public.trail_follows (user_id);

-- ── `trail_reports` — §15 moderation intake ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.trail_reports (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trail_id         uuid        NOT NULL REFERENCES public.trails(id) ON DELETE CASCADE,
  content_trail_id uuid        NULL REFERENCES public.content_trails(id) ON DELETE CASCADE,
  reported_by      uuid        NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  reason           text        NOT NULL,
  resolution       text        NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- §15's own sources of moderation, as the report vocabulary.
  CONSTRAINT trail_reports_reason_known CHECK (
    reason IN ('unrelated_content','duplicate_trail','wrong_place_link','stale','abuse')),
  CONSTRAINT trail_reports_resolution_known CHECK (
    resolution IS NULL OR resolution IN ('removed','merged','corrected','marked_stale','dismissed'))
);
COMMENT ON TABLE public.trail_reports IS
  '02_Trails.md §15 moderation intake for 11 §3 "report Trail/content mismatch". Feeds §11''s report_rate metric. Resolution is an admin action and is never written by the reporting route.';
CREATE INDEX IF NOT EXISTS idx_trail_reports_open ON public.trail_reports (trail_id) WHERE resolution IS NULL;

-- ── RLS ──────────────────────────────────────────────────────────────────────
--
-- The three PUBLIC objects (the Trail, its membership, its edges) are readable
-- by any signed-in user, because a Trail is a discovery space and hiding it
-- would make it undiscoverable. Everything else is closed:
--   trail_follows        a viewer sees only their OWN follows — who follows a
--                        Trail is social context, and DSV2's privacy section
--                        forbids disclosing it.
--   trail_reports        no client read at all: a reporter must not be able to
--                        enumerate what others reported.
--   trail_health_snapshots  internal diagnostics. §12: "Avoid exposing opaque
--                        quality scores" — so the numbers never leave the server
--                        and the client gets §12's five status words instead.
-- NO table grants INSERT/UPDATE/DELETE to `authenticated`: every write goes
-- through the API's service client, where §4's cap and §5's checks run.
ALTER TABLE public.trails                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_trails         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trail_edges            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trail_follows          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trail_reports          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trail_health_snapshots ENABLE ROW LEVEL SECURITY;

-- DROP-then-CREATE rather than bare CREATE, for the same reason the CREATE
-- TABLEs above carry IF NOT EXISTS: this file's objects are already present on
-- portava-ci from a rehearsal that recorded no ledger row, and a migration whose
-- effect is already there must be a no-op rather than a 42P07/42710 failure.
-- Re-asserting the policy is safer than IF NOT EXISTS would be here: a policy
-- left over with a DIFFERENT predicate would silently survive "if not exists",
-- whereas dropping and recreating guarantees the predicate below is the one in
-- force. Nothing downstream is skipped — the $post$ block re-proves the label
-- cap and the signal vocabulary BEHAVIOURALLY, by inserting probe rows and
-- requiring the refusals, so a wrong-shaped leftover still fails this file.
DROP POLICY IF EXISTS trails_public_select ON public.trails;
CREATE POLICY trails_public_select ON public.trails
  FOR SELECT TO authenticated USING (lifecycle_status <> 'archived');
DROP POLICY IF EXISTS content_trails_public_select ON public.content_trails;
CREATE POLICY content_trails_public_select ON public.content_trails
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS trail_edges_public_select ON public.trail_edges;
CREATE POLICY trail_edges_public_select ON public.trail_edges
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS trail_follows_own_select ON public.trail_follows;
CREATE POLICY trail_follows_own_select ON public.trail_follows
  FOR SELECT TO authenticated USING (user_id = auth.uid());

REVOKE ALL ON public.trails                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.content_trails         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.trail_edges            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.trail_follows          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.trail_reports          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.trail_health_snapshots FROM PUBLIC, anon, authenticated;

GRANT SELECT ON public.trails         TO authenticated;
GRANT SELECT ON public.content_trails TO authenticated;
GRANT SELECT ON public.trail_edges    TO authenticated;
GRANT SELECT ON public.trail_follows  TO authenticated;

-- ── Postconditions ───────────────────────────────────────────────────────────
DO $post$
DECLARE n int; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['trails','content_trails','trail_edges','trail_health_snapshots','trail_follows','trail_reports'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION '2910: POSTCONDITION FAILED: public.% was not created', t;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass) THEN
      RAISE EXCEPTION '2910: POSTCONDITION FAILED: RLS not enabled on public.%', t;
    END IF;
    IF has_table_privilege('authenticated', 'public.' || t, 'INSERT')
       OR has_table_privilege('authenticated', 'public.' || t, 'UPDATE')
       OR has_table_privilege('authenticated', 'public.' || t, 'DELETE') THEN
      RAISE EXCEPTION '2910: POSTCONDITION FAILED: authenticated must not write public.%', t;
    END IF;
  END LOOP;

  -- Reports and health snapshots are server-side only.
  IF has_table_privilege('authenticated', 'public.trail_reports', 'SELECT')
     OR has_table_privilege('authenticated', 'public.trail_health_snapshots', 'SELECT') THEN
    RAISE EXCEPTION '2910: POSTCONDITION FAILED: trail_reports / trail_health_snapshots must not be client-readable';
  END IF;

  -- §4's cap must actually refuse. Probed with TWO DIFFERENT Trails on purpose:
  -- a second primary row for the same (trail, source) is already impossible via
  -- uq_content_trails_label, so probing that would prove the index and say
  -- nothing about the cap. Content in two DIFFERENT primary Trails is the
  -- violation §4 actually names, and only the trigger can refuse it.
  INSERT INTO public.trails (id, slug, title, lifecycle_status)
    VALUES ('00000000-0000-4000-8000-0000000029a0', 'migration-2910-probe-a', 'probe a', 'proposed'),
           ('00000000-0000-4000-8000-0000000029a1', 'migration-2910-probe-b', 'probe b', 'proposed');
  INSERT INTO public.content_trails (trail_id, source_type, source_id, relationship)
    VALUES ('00000000-0000-4000-8000-0000000029a0', 'place', '00000000-0000-4000-8000-0000000029b0', 'primary');
  BEGIN
    INSERT INTO public.content_trails (trail_id, source_type, source_id, relationship)
      VALUES ('00000000-0000-4000-8000-0000000029a1', 'place', '00000000-0000-4000-8000-0000000029b0', 'primary');
    RAISE EXCEPTION '2910: POSTCONDITION FAILED: a second PRIMARY Trail was admitted for one piece of content (02 §4 cap not enforced)';
  EXCEPTION WHEN check_violation THEN
    NULL;  -- refused by content_trails_label_cap(), which is the requirement
  END;

  -- §4's Signal vocabulary must be closed.
  BEGIN
    INSERT INTO public.content_trails (trail_id, source_type, source_id, relationship, signal)
      VALUES ('00000000-0000-4000-8000-0000000029a0', 'place', '00000000-0000-4000-8000-0000000029b0', 'signal', 'vibes');
    RAISE EXCEPTION '2910: POSTCONDITION FAILED: a signal outside 02 §4''s vocabulary was admitted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  DELETE FROM public.trails
   WHERE id IN ('00000000-0000-4000-8000-0000000029a0', '00000000-0000-4000-8000-0000000029a1');
  SELECT count(*) INTO n FROM public.content_trails
    WHERE trail_id = '00000000-0000-4000-8000-0000000029a0';
  IF n <> 0 THEN
    RAISE EXCEPTION '2910: POSTCONDITION FAILED: content_trails did not cascade (% rows left)', n;
  END IF;

  -- 2290 stays intact: this migration must not have admitted a trail node kind.
  IF to_regclass('public.compass_graph_nodes') IS NOT NULL THEN
    SELECT count(*) INTO n FROM pg_constraint
     WHERE conrelid = 'public.compass_graph_nodes'::regclass
       AND conname = 'compass_graph_nodes_node_type_check'
       AND pg_get_constraintdef(oid) LIKE '%''trail''%';
    IF n <> 0 THEN
      RAISE EXCEPTION '2910: POSTCONDITION FAILED: trail must NOT be admitted to the intelligence graph (2290 stands)';
    END IF;
  END IF;
END
$post$;

COMMIT;

-- REVERSAL (manual):
--   DROP TRIGGER IF EXISTS content_trails_label_cap_trg ON public.content_trails;
--   DROP FUNCTION IF EXISTS public.content_trails_label_cap();
--   DROP TABLE IF EXISTS public.trail_reports;
--   DROP TABLE IF EXISTS public.trail_health_snapshots;
--   DROP TABLE IF EXISTS public.trail_follows;
--   DROP TABLE IF EXISTS public.trail_edges;
--   DROP TABLE IF EXISTS public.content_trails;
--   DROP TABLE IF EXISTS public.trails;
