-- Rollback for 3674_memory_graph_model.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
-- Roll back 3676 and 3675 first.
--
-- WHAT 3674 DID: memories.source_mode, memory_relations.source_mode, the
-- memory_entity_links view, memory_id_redirects, memory_graph_shadow_daily and
-- its record function, the mirror/erasure functions and triggers, three flags
-- seeded FALSE.
-- WHAT THIS ROLLBACK DOES: drops all of it, and deletes the LEGACY_IMPORTED
-- edges (derived, re-derivable; without the triggers they would go stale).
-- IT REFUSES while:
--   * any memory_id_redirects row exists: a merged-away Memory's URL would stop
--     resolving (§22 stable IDs and URLs). Decide what happens to those URLs first.
--   * any USER_CREATED memory_relations row exists: a split's lineage would be
--     lost with the column that marks it.
-- Dropping memories.source_mode loses the LEGACY_IMPORTED / USER_CREATED
-- distinction; re-applying 3674 marks EVERY row then present LEGACY_IMPORTED,
-- which is the conservative (lower-provenance) direction.
-- The shadow counts are dropped: they are counts, re-collectable.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.memory_id_redirects') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.memory_id_redirects) THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3674): memory_id_redirects holds merged Memory ids whose URLs would stop resolving.';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
               AND table_name = 'memory_relations' AND column_name = 'source_mode') THEN
    IF EXISTS (SELECT 1 FROM public.memory_relations WHERE source_mode = 'USER_CREATED') THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3674): memory_relations holds USER_CREATED edges (split lineage).';
    END IF;
  END IF;
END $$;

DROP TRIGGER IF EXISTS memory_graph_mirror_memories ON public.memories;
DROP TRIGGER IF EXISTS memory_graph_erase_memories ON public.memories;
DROP TRIGGER IF EXISTS memory_graph_mirror_tags ON public.memory_tags;
DO $$
BEGIN
  IF to_regclass('public.memory_episodes') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS memory_graph_erase_episodes ON public.memory_episodes';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
               AND table_name = 'memory_relations' AND column_name = 'source_mode') THEN
    EXECUTE 'DELETE FROM public.memory_relations WHERE source_mode = ''LEGACY_IMPORTED''';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.memory_graph_on_memory_write();
DROP FUNCTION IF EXISTS public.memory_graph_on_tag_write();
DROP FUNCTION IF EXISTS public.memory_graph_on_episode_delete();
DROP FUNCTION IF EXISTS public.memory_graph_backfill_legacy(uuid, integer);
DROP FUNCTION IF EXISTS public.memory_graph_mirror_memory(uuid);
DROP FUNCTION IF EXISTS public.memory_graph_shadow_record(text, integer, integer, integer, integer, integer, integer);
DROP VIEW IF EXISTS public.memory_entity_links;
DROP TABLE IF EXISTS public.memory_id_redirects;
DROP TABLE IF EXISTS public.memory_graph_shadow_daily;
ALTER TABLE public.memory_relations DROP CONSTRAINT IF EXISTS memory_relations_source_mode_check;
ALTER TABLE public.memory_relations DROP COLUMN IF EXISTS source_mode;
ALTER TABLE public.memories DROP CONSTRAINT IF EXISTS memories_source_mode_check;
ALTER TABLE public.memories DROP COLUMN IF EXISTS source_mode;
DELETE FROM public.feature_flags
 WHERE flag IN ('memory_merge_split_enabled', 'memory_graph_shadow_read_enabled', 'memory_graph_read_cutover_enabled');
DELETE FROM public.schema_migration_ledger WHERE filename = '3674_memory_graph_model.sql';

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.memory_id_redirects') IS NOT NULL OR to_regclass('public.memory_graph_shadow_daily') IS NOT NULL
     OR to_regclass('public.memory_entity_links') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3674 rollback): a 3674 relation still exists';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
               AND table_name IN ('memories', 'memory_relations') AND column_name = 'source_mode') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3674 rollback): a source_mode column still exists';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'memory_graph_%') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3674 rollback): a memory_graph trigger still exists';
  END IF;
  IF to_regclass('public.memory_relations') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3674 rollback): memory_relations belongs to 2994 and must survive';
  END IF;
END $post$;
