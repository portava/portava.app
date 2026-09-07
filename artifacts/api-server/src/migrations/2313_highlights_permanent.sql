-- 2313_highlights_permanent.sql
-- A Highlight may be permanent, and an expired one is ARCHIVED rather than gone.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2313.
--
-- Additive and idempotent: one DROP NOT NULL guarded by a catalog check, one
-- NOT VALID CHECK, and two policy replacements guarded by DROP POLICY IF EXISTS.
-- No row is written, no row is deleted, no flag is flipped. Re-running is a no-op.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- TWO OWNER RULINGS, 2026-09-06
-- ══════════════════════════════════════════════════════════════════════════════
--   1. A Highlight may be PERMANENT, and the user chooses the term.
--   2. An expired Highlight is ARCHIVED, not invisible: its owner can still see
--      it, and re-post it.
--
-- Both land in the same two policies, so they ship together. Doing either alone
-- leaves the table in a state where the feature appears to work and shows
-- nothing.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THE COLUMN CHANGE ALONE WOULD BE WORSE THAN NOTHING
-- ══════════════════════════════════════════════════════════════════════════════
-- Expiry is enforced in RLS, not merely in queries. Live today:
--
--   highlights_select         ... AND (expires_at > now()) AND (owner OR viewer…)
--   highlights_select_active  ... AND (expires_at > now()) AND (owner OR viewer…)
--
-- Two consequences, and the second is the one nobody would have predicted:
--
--   * `NULL > now()` is NULL, not TRUE. Both policies are PERMISSIVE, so a row
--     needs to satisfy at least one — and a permanent Highlight satisfies
--     neither. Making the column nullable WITHOUT touching the predicate makes
--     permanence a feature that saves successfully and then displays nothing.
--
--   * The expiry test sits OUTSIDE the owner branch, ANDed across the whole
--     policy. So an expired Highlight is invisible to its own owner too. That is
--     the archive ruling's blocker, and it is a database rule — no amount of
--     route work can see around it.
--
-- So the predicate both moves INSIDE the viewer branch and gains its NULL arm:
--
--   (deleted_at IS NULL) AND (
--        owner_id = auth.uid()                            -- archive: always
--     OR ((expires_at IS NULL OR expires_at > now()) AND …viewer clauses…)
--   )
--
-- Everything else in both policies — blocks, visibility tiers, circle,
-- friendship, trip crew — is reproduced byte-for-byte from the baseline. This
-- migration changes WHERE the expiry test applies and WHAT it admits, and
-- nothing else. Non-owners see exactly what they saw before, minus nothing.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT NULL MEANS
-- ══════════════════════════════════════════════════════════════════════════════
-- `expires_at IS NULL` means PERMANENT — the owner chose "never". It does not
-- mean "unset" or "not yet decided": the CHECK below refuses a row that is
-- neither permanent nor dated after creation, so NULL cannot arrive by omission
-- from a writer that simply forgot the column.
--
-- Existing rows are untouched: every Highlight keeps the exact expiry it has.

-- ── 1. The column ─────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'highlights'
      AND column_name = 'expires_at' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE public.highlights ALTER COLUMN expires_at DROP NOT NULL;
  END IF;
END $$;

COMMENT ON COLUMN public.highlights.expires_at IS
  'When this Highlight stops being visible to OTHERS, or NULL for PERMANENT (the owner chose "never"). NULL is a deliberate choice, never an omission — see highlights_expiry_is_permanent_or_dated. The owner always sees their own Highlights regardless of this column: an expired one is ARCHIVED, not gone, and can be re-posted. Any reader filtering on this column for a non-owner must admit the NULL arm (expires_at IS NULL OR expires_at > now()); a bare `> now()` hides every permanent Highlight.';

-- ── 2. A NULL can only ever be a deliberate "permanent" ───────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.highlights'::regclass
      AND conname = 'highlights_expiry_is_permanent_or_dated'
  ) THEN
    ALTER TABLE public.highlights
      ADD CONSTRAINT highlights_expiry_is_permanent_or_dated
      CHECK (expires_at IS NULL OR expires_at > created_at)
      NOT VALID;
  END IF;
END $$;

-- NOT VALID deliberately: it governs new and updated rows without a full-table
-- scan and without failing this apply on a historical row whose clock skew left
-- expires_at <= created_at. Validate separately once the table is known clean;
-- nothing here depends on it being validated.

-- ── 3. The two SELECT policies ────────────────────────────────────────────────

DROP POLICY IF EXISTS highlights_select ON public.highlights;
CREATE POLICY highlights_select ON public.highlights FOR SELECT USING (
  (deleted_at IS NULL)
  AND (
    -- ARCHIVE: the owner sees their own Highlights whatever the expiry says.
    (owner_id = auth.uid())
    OR (
      -- Everyone else: live, or permanent.
      (expires_at IS NULL OR expires_at > now())
      AND (NOT public.viewer_is_blocked(owner_id))
      AND (
        (visibility = ANY (ARRAY['public'::text, 'travelers_nearby'::text]))
        OR (
          (visibility = 'circle_only'::text)
          AND (
            public.in_accepted_circle(auth.uid(), owner_id)
            OR (EXISTS (
              SELECT 1 FROM public.user_friendships
              WHERE (
                ((user_friendships.user_a = auth.uid()) AND (user_friendships.user_b = highlights.owner_id))
                OR ((user_friendships.user_b = auth.uid()) AND (user_friendships.user_a = highlights.owner_id))
              )
            ))
          )
        )
      )
    )
  )
);

DROP POLICY IF EXISTS highlights_select_active ON public.highlights;
CREATE POLICY highlights_select_active ON public.highlights FOR SELECT TO authenticated USING (
  (deleted_at IS NULL)
  AND (
    (owner_id = auth.uid())
    OR (
      (expires_at IS NULL OR expires_at > now())
      AND (NOT public.is_blocked(auth.uid(), owner_id))
      AND (
        (visibility = ANY (ARRAY['public'::text, 'travelers_nearby'::text]))
        OR (
          (visibility = 'circle_only'::text)
          AND (EXISTS (
            SELECT 1 FROM public.circle_memberships cm
            WHERE ((cm.user_id = highlights.owner_id) AND (cm.other_id = auth.uid()))
          ))
        )
        OR (
          (visibility = 'trip_only'::text)
          AND (EXISTS (
            SELECT 1 FROM (public.trip_members tm1 JOIN public.trip_members tm2 ON ((tm1.trip_id = tm2.trip_id)))
            WHERE ((tm1.user_id = highlights.owner_id) AND (tm2.user_id = auth.uid()))
          ))
        )
      )
    )
  )
);

-- Archive listings scan (owner_id, expires_at). The partial index keeps that
-- read off a full scan without carrying the live rows it will never return.
CREATE INDEX IF NOT EXISTS highlights_owner_archive_idx
  ON public.highlights (owner_id, expires_at DESC)
  WHERE deleted_at IS NULL AND expires_at IS NOT NULL;

-- ══════════════════════════════════════════════════════════════════════════════
-- POSTCONDITIONS
--
-- The last two are the point of this file. Either failure produces a feature
-- that writes successfully and then shows nothing, so the apply REFUSES rather
-- than leaving the database in that state.
-- ══════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_nullable    text;
  v_policies    int;
  v_no_null_arm int;
  v_owner_gated int;
BEGIN
  SELECT is_nullable INTO v_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'highlights' AND column_name = 'expires_at';

  IF v_nullable IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: public.highlights.expires_at is absent.';
  END IF;
  IF v_nullable <> 'YES' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: highlights.expires_at is still NOT NULL — a permanent Highlight cannot be stored.';
  END IF;

  SELECT count(*) INTO v_policies
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'highlights' AND cmd = 'SELECT';
  IF v_policies < 2 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected at least 2 SELECT policies on highlights, found %.', v_policies;
  END IF;

  -- PERMANENCE: no SELECT policy may test expiry without admitting NULL. Both
  -- policies are PERMISSIVE, so one bad policy is not rescued by the other being
  -- right — a permanent row must satisfy at least one, and it satisfies neither
  -- if either is written this way.
  SELECT count(*) INTO v_no_null_arm
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'highlights' AND cmd = 'SELECT'
    AND qual LIKE '%expires_at > now()%'
    AND qual NOT LIKE '%expires_at IS NULL%';
  IF v_no_null_arm > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % SELECT policy(ies) require expires_at > now() without admitting NULL. A permanent Highlight would be invisible to every viewer including its owner.', v_no_null_arm;
  END IF;

  -- ARCHIVE: the owner branch must not be gated on expiry. A policy shaped
  -- `(expires_at …) AND (owner_id = auth.uid() OR …)` hides an expired Highlight
  -- from its own owner, which is the ruling this migration exists to satisfy.
  -- Detected structurally: the owner test must appear BEFORE the expiry test in
  -- the normalised qual, i.e. expiry sits inside the non-owner arm.
  SELECT count(*) INTO v_owner_gated
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'highlights' AND cmd = 'SELECT'
    AND qual LIKE '%expires_at%'
    AND position('owner_id = auth.uid()' in qual) > position('expires_at' in qual);
  IF v_owner_gated > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % SELECT policy(ies) test expiry before the owner branch, so an expired Highlight is hidden from its own owner. The archive requires the owner arm to be unconditional.', v_owner_gated;
  END IF;
END $$;
