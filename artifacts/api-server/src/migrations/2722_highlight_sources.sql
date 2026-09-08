-- 2722_highlight_sources.sql
--
-- WHAT: one new table, public.highlight_sources — the §3.6 link table joining a
-- Highlight to the Memories or Episodes it projects. Nothing existing is
-- altered; no column is added to `highlights`.
--
-- WHY. Highlights/Memories Development Architecture Spec v1 §12 opens with the
-- sentence the whole section rests on:
--
--     "Highlights are disposable, audience-specific projections over one or
--      more Memories or Episodes. They are not the source of historical truth."
--
-- §3.5 gives a Highlight `source_memory_ids: uuid[]`; §3.6 names the table,
-- `highlight_sources`, "Links Highlights to Memories/Episodes".
--
-- WHAT IS TRUE TODAY, MEASURED. routes/highlights.ts POST /highlights inserts a
-- row from a CLIENT-SUPPLIED `mediaUrl` with no source of any kind. A Highlight
-- on this surface is an independent record, not a projection: it cannot be
-- rebuilt from anything, it has no provenance, and deleting the Memory it
-- depicts (if one exists) leaves it standing. That is census H93 —
-- BUILT-BUT-WRONG, "a Stories product wearing the spec's noun" — and it is also
-- §28.12, "Always make derived projections rebuildable", which cannot hold for
-- a projection with no source.
--
-- WHY A TABLE AND NOT `source_memory_ids uuid[]` ON `highlights`.
--   * §3.6 names a table, and an array cannot carry per-source data. The
--     `source_type` column is load-bearing: §12 says "Memories OR Episodes",
--     and those are two different id spaces.
--   * An FK cannot be declared from inside an array, so an array would let a
--     Highlight cite a Memory that does not exist — the exact "fabricated
--     link" §22 forbids during backfill.
--   * A link row can be added and removed without rewriting the Highlight,
--     which is what "disposable projection over one or more Memories" needs.
--
-- WHY THERE IS NO FOREIGN KEY ON `source_id`. The §3.6 `memories` table this
-- would reference is the SPEC's canonical Memory table, and it does not exist.
-- public.memories DOES exist (migration 0067) but it is the legacy scrapbook
-- Memory, a different artifact with a different lifecycle, and pointing this FK
-- at it would assert an equivalence §22 explicitly warns against ("legacy
-- media-centric records should be imported as lower-provenance Memories rather
-- than upgraded into invented rich context"). So `source_id` is UUID with no
-- REFERENCES, `source_type` says which space it lives in, and the constraint
-- that a source must exist is enforced by whatever writes the link — not by a
-- foreign key that would silently pick a winner in a modelling question nobody
-- has answered. This is stated here so a later reader does not "fix" the
-- missing FK by adding the wrong one.
--
-- WHAT THIS DOES NOT DO. It creates no rows. Every Highlight on production
-- (23 rows, measured 2026-09-07) stays sourceless, and the read code reports
-- them as sourceless rather than inventing a provenance for them — §22: "Never
-- fabricate trip IDs, place IDs, participant links, or 'visited' outcomes
-- during backfill. Unknowns remain null/unresolved until evidence supports
-- reconciliation."
--
-- REVERSIBLE BY:
--   DROP TABLE IF EXISTS public.highlight_sources;
-- Nothing else is touched, so there is nothing else to undo.
--
-- NOT APPLIED BY THIS LANE. Written only.

CREATE TABLE IF NOT EXISTS public.highlight_sources (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  highlight_id  UUID NOT NULL
                  REFERENCES public.highlights(id) ON DELETE CASCADE,
  -- §12: "over one or more Memories or Episodes".
  source_type   TEXT NOT NULL CHECK (source_type IN ('MEMORY', 'EPISODE')),
  -- Deliberately NOT a foreign key. See the header.
  source_id     UUID NOT NULL,
  -- §4 TruthLevel / §28.13 "Always store provenance and engine/reason-code
  -- versions for inferred facts": how this link came to exist. A link asserted
  -- by a user is not the same claim as one an engine proposed, and a projection
  -- that cannot tell them apart cannot honour §4's truth precedence.
  provenance    TEXT NOT NULL DEFAULT 'USER_ASSERTED'
                  CHECK (provenance IN
                         ('USER_ASSERTED', 'SYSTEM_OBSERVED', 'MUTUALLY_CONFIRMED',
                          'INFERRED', 'UNKNOWN')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The same source cannot be linked to the same Highlight twice. §28.15:
  -- "Always make merge/split and publication changes auditable and idempotent."
  CONSTRAINT highlight_sources_unique UNIQUE (highlight_id, source_type, source_id)
);

CREATE INDEX IF NOT EXISTS highlight_sources_highlight_idx
  ON public.highlight_sources (highlight_id);

-- The reverse direction is what §21 revocation needs: "which Highlights project
-- this Memory" is the question a Memory deletion has to answer before it can
-- claim the profile-Highlight destination was reached.
CREATE INDEX IF NOT EXISTS highlight_sources_source_idx
  ON public.highlight_sources (source_type, source_id);

ALTER TABLE public.highlight_sources ENABLE ROW LEVEL SECURITY;

-- A link row is readable by whoever may read the HIGHLIGHT, not by whoever may
-- read the source. That direction matters: the Highlight is the public-facing
-- projection and the Memory is the private canonical record (§10, "Canonical
-- Memory storage and public/social projections are intentionally separate"), so
-- inheriting readability from the source would leak the private side's
-- audience onto the public one.
--
-- The predicate is deliberately the OWNER, not the highlight's visibility:
-- knowing WHICH Memory a Highlight projects is provenance about the owner's
-- private history, and §23 makes owner-only the default for that. A viewer who
-- may see the Highlight still sees the Highlight; they do not learn what it was
-- built from.
CREATE POLICY highlight_sources_select_owner
  ON public.highlight_sources
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.highlights h
    WHERE h.id = highlight_sources.highlight_id
      AND h.owner_id = auth.uid()
  ));

CREATE POLICY highlight_sources_insert_owner
  ON public.highlight_sources
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.highlights h
    WHERE h.id = highlight_sources.highlight_id
      AND h.owner_id = auth.uid()
  ));

CREATE POLICY highlight_sources_delete_owner
  ON public.highlight_sources
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.highlights h
    WHERE h.id = highlight_sources.highlight_id
      AND h.owner_id = auth.uid()
  ));

-- No UPDATE policy. A link is created or removed; editing which source a link
-- points at, in place, is how provenance quietly changes under an audit.

COMMENT ON TABLE public.highlight_sources IS
  'Highlights/Memories spec v1 §3.6 / §12. Links a Highlight to the Memories or Episodes it '
  'projects, so a Highlight can be rebuilt (§28.12) and so §21 revocation can find the '
  'Highlights that project a deleted Memory. source_id carries NO foreign key on purpose — '
  'see the migration header.';
