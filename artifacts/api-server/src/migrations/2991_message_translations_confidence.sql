-- 2991_message_translations_confidence.sql
--
-- TELEGRAPH LANE, reserved band 2991-2993. Forward migration (2100-2999 band).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT
-- ══════════════════════════════════════════════════════════════════════════════
-- Add the two columns census-telegraph T240 names as missing from the
-- `MessageTranslation` contract:
--
--   confidence        text  NULL  CHECK (confidence IN ('high','low'))
--   provider_version  text  NULL
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY, AND WHY THE SECOND ONE IS NOT DECORATION
-- ══════════════════════════════════════════════════════════════════════════════
-- T240: *"Six of eight fields … Missing `providerVersion` and `confidence` —
-- and the absence of `confidence` is what makes T242 fail."*  T242 asks a
-- low-confidence operational translation to show the ORIGINAL ALONGSIDE the
-- translation "instead of pretending certainty", and the census's finding was
-- that the show-original mechanism is driven by `profiles.show_original_messages`
-- — a taste setting — because there was no certainty value to threshold on.
--
-- The signal was never absent from the tree. `lib/translation.ts`'s
-- `DetectLanguageResult` has carried `confidence: 'high' | 'low'` since the
-- provider abstraction was written, and `messageTranslation.ts#detectWithRetry`
-- discarded it one line after receiving it. This file gives it somewhere to go.
--
-- `provider_version` answers a different question from `provider`. `provider`
-- is the vendor ('openai'); `provider_version` is the engine that actually ran
-- ('gpt-5-mini'). A corpus of stored translations with no engine identity
-- cannot be compared across a model swap, cannot be selectively re-run, and
-- cannot answer "was this translated by the model we later found to be wrong
-- about Portuguese". One column now is cheaper than a backfill nobody can do.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY BOTH ARE NULLABLE, AND WHY `confidence` HAS NO DEFAULT
-- ══════════════════════════════════════════════════════════════════════════════
-- Every row that exists before this migration was written without a reading,
-- and there is no way to recover one: the text may since have been edited, the
-- provider may since have changed, and re-detecting today would produce a
-- statement about today's model rather than about the translation stored then.
--
-- A DEFAULT would have been the tempting alternative and is refused by name. A
-- default of 'low' would assert, of ten thousand historical rows, that somebody
-- measured them and found them unsure. A default of 'high' would assert the
-- opposite and is worse. NULL says the one true thing: no reading was taken.
-- The reader (`buildDisplayFields`) treats NULL as NOT-HIGH, so the product
-- behaviour is the safe one without the column having to lie to get it.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS DOES NOT DO
-- ══════════════════════════════════════════════════════════════════════════════
--   * It does not add an ENUM. `translation_status` is an enum type and this
--     deliberately is not: a two-value enum in the same table would invite a
--     third value later, and 'high'/'low' is the full range the provider
--     abstraction can produce. A CHECK is reversible without a type drop.
--   * It does not touch any existing column, constraint, index or policy on
--     `message_translations`. No existing row becomes invalid: both columns
--     arrive NULL and the CHECK admits NULL explicitly.
--   * It does not backfill. See above.
--   * It does not change RLS. The two columns live on a table whose policies
--     already scope every row to its `recipient_id`, and a confidence reading
--     about a translation is visible to exactly the person the translation was
--     made for.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THE WRITER DOES BEFORE THIS IS APPLIED
-- ══════════════════════════════════════════════════════════════════════════════
-- `services/messageTranslation.ts#upsertTranslation` names both columns, reads
-- the error (it used not to — a refusal resolved silently), and on the specific
-- undefined-column refusal RETRIES ONCE WITHOUT THEM, logging
-- `CONFIDENCE_MIGRATION_PENDING_MESSAGE`, which names this file. The
-- translation itself is the product feature; the reading is metadata about it,
-- and losing the row to keep the metadata would be the wrong trade. So this
-- migration being unapplied degrades T242 to "treat every translation as
-- not-certain" rather than breaking translation.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- REVERSAL (exact)
-- ══════════════════════════════════════════════════════════════════════════════
--   BEGIN;
--   ALTER TABLE public.message_translations
--     DROP CONSTRAINT IF EXISTS message_translations_confidence_check;
--   ALTER TABLE public.message_translations DROP COLUMN IF EXISTS confidence;
--   ALTER TABLE public.message_translations DROP COLUMN IF EXISTS provider_version;
--   COMMIT;
--
--   Lossy by construction: the readings are not recoverable once dropped. That
--   is stated rather than hidden, and it is why the forward direction is two
--   nullable columns and not a rewrite of anything.
-- ══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $pre$
BEGIN
  IF to_regclass('public.message_translations') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2991): public.message_translations is absent. There is no translation record to extend.';
  END IF;

  -- The six fields T240 counts as present must be there. If they are not, this
  -- is not the table the census measured and adding two more columns to it
  -- would produce a shape nothing in this tree reads.
  IF (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'message_translations'
        AND column_name IN ('message_id', 'recipient_id', 'source_language',
                            'target_language', 'translated_body', 'provider')) <> 6 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2991): public.message_translations does not carry the six MessageTranslation fields T240 counts as present. Refusing to extend a shape this tree does not recognise.';
  END IF;

  RAISE NOTICE '2991 precondition: public.message_translations present with its six existing contract fields.';
END
$pre$;

-- ── The two columns ──────────────────────────────────────────────────────────
-- Idempotent. Re-running this file adds nothing and changes nothing.
ALTER TABLE public.message_translations
  ADD COLUMN IF NOT EXISTS confidence text;

ALTER TABLE public.message_translations
  ADD COLUMN IF NOT EXISTS provider_version text;

-- The CHECK admits NULL explicitly rather than relying on Postgres's
-- NULL-passes-a-CHECK rule. Both behave identically; only one of them says so
-- to the next person to read the schema, and this repository has already been
-- bitten once by a CHECK that silently passed on NULL (see 2989's header).
ALTER TABLE public.message_translations
  DROP CONSTRAINT IF EXISTS message_translations_confidence_check;

ALTER TABLE public.message_translations
  ADD CONSTRAINT message_translations_confidence_check
  CHECK (confidence IS NULL OR confidence = ANY (ARRAY['high'::text, 'low'::text]));

COMMENT ON COLUMN public.message_translations.confidence IS
  'Telegraph §18.2 T240/T242. How certain the record is that this translation says what the original said: ''high'' only when the provider READ THE MESSAGE TEXT and reported high confidence in the source language; ''low'' otherwise; NULL when no reading was taken (every row written before migration 2991). NULL is treated as NOT-HIGH by services/messageTranslation.ts#buildDisplayFields, which shows the original alongside the translation rather than pretending certainty.';

COMMENT ON COLUMN public.message_translations.provider_version IS
  'Telegraph §18.2 T240. The ENGINE that produced this translation (e.g. ''gpt-5-mini''), as distinct from `provider`, which is the vendor. Set from the same constant the call uses, so it cannot drift from the model that actually ran.';

-- ── Postconditions ───────────────────────────────────────────────────────────
-- ABSOLUTE and RE-RUNNABLE STANDALONE: every assertion reads the CURRENT
-- catalog only, so `certify:migrations` can execute this block at any later
-- time against a database this file has already been applied to.
DO $post$
DECLARE
  def TEXT;
  n_bad INTEGER;
  n_new INTEGER;
BEGIN
  -- 1. BOTH columns must exist. One of two is a half-applied contract.
  SELECT count(*) INTO n_new
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'message_translations'
    AND column_name IN ('confidence', 'provider_version');
  IF n_new <> 2 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2991): public.message_translations carries % of the 2 columns this migration adds. T240 counts eight fields; a half-applied pair is a seven-field contract nothing reads correctly.', n_new;
  END IF;

  -- 2. Both must be NULLABLE. A NOT NULL on either would make every historical
  --    row unwritable and would force the backfill this file refuses to fake.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'message_translations'
      AND column_name IN ('confidence', 'provider_version')
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2991): confidence or provider_version is NOT NULL. Rows written before this migration have no reading and must be allowed to say so.';
  END IF;

  -- 3. Neither may carry a DEFAULT. A default would manufacture a reading for
  --    every future row that the writer chose not to take — precisely the
  --    "pretending certainty" T242 exists to stop.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'message_translations'
      AND column_name IN ('confidence', 'provider_version')
      AND column_default IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2991): confidence or provider_version carries a DEFAULT. A default manufactures a confidence reading nobody took.';
  END IF;

  -- 4. THE CONSTRAINT MUST EXIST and must be a value list. Without it the
  --    column admits any string and stops meaning anything — the same failure
  --    2989's postcondition 1 guards against.
  SELECT pg_get_constraintdef(c.oid) INTO def
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'message_translations'
    AND c.conname = 'message_translations_confidence_check'
    AND c.contype = 'c';

  IF def IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2991): constraint message_translations_confidence_check does not exist. Without it confidence admits any string.';
  END IF;
  IF def NOT LIKE '%''high''%' OR def NOT LIKE '%''low''%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2991): message_translations_confidence_check does not admit both ''high'' and ''low''. Its definition is: %', def;
  END IF;
  IF def ~* '\(true\)' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2991): message_translations_confidence_check is not a value list — it is: %', def;
  END IF;

  -- 5. THE TABLE MUST AGREE WITH ITS OWN CONSTRAINT, re-checked here because
  --    this block is re-run long after the ADD, by which time rows exist.
  SELECT count(*) INTO n_bad
  FROM public.message_translations
  WHERE confidence IS NOT NULL AND confidence NOT IN ('high', 'low');
  IF n_bad > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2991): % row(s) carry a confidence outside (high, low) despite the constraint. The constraint is not being enforced.', n_bad;
  END IF;

  RAISE NOTICE '2991 postconditions: confidence and provider_version present, nullable, defaultless; confidence constrained to (high, low); 0 rows violate it. Definition: %', def;
END
$post$;

COMMIT;
