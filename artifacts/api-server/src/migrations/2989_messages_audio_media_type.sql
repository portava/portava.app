-- 2989_messages_audio_media_type.sql
--
-- TELEGRAPH LANE, reserved band 2989-2994. Forward migration (2100-2999 band).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT
-- ══════════════════════════════════════════════════════════════════════════════
-- Widen `public.messages.media_type` from ('image','video') to
-- ('image','video','audio'), so a Telegraph §6.2 VOICE message can record WHAT
-- ITS ASSET IS in the same column every other message asset uses.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THIS EXACT COLUMN, AND WHY IT IS NOT OPTIONAL
-- ══════════════════════════════════════════════════════════════════════════════
-- `services/telegraph/messageKinds.ts` has, since the §6 lane, refused VOICE BY
-- NAME with this reason:
--
--   "VOICE needs an audio asset, and messages.media_type is constrained to
--    ('image','video') while lib/mediaPipeline.ts admits image and video MIME
--    types only. Sending a voice envelope with nowhere to upload the audio
--    would be a kind that cannot carry its asset. Requires a migration."
--
-- and `travel-buddy-standalone/src/features/telegraph/composer/composerMenu.ts`
-- renders §6.1's Voice entry DISABLED carrying the same sentence. This file is
-- the migration both of them name.
--
-- It would have been possible to carry the audio URL inside the §6.2 JSON
-- envelope in `messages.body` and leave the media columns NULL — that is how
-- GIF is carried, and it needs no DDL. It is the wrong answer HERE and the
-- difference is ownership of the bytes: a GIF's URL points at a provider, a
-- voice note's URL points at OUR storage. Every consumer that reasons about
-- message-owned assets — the §6.4 content drawer's preview, the data-saver
-- path, `media_duration_seconds`, and anything that later sweeps storage for a
-- deleted message — reads the media columns. A voice note written with
-- `media_url` set and `media_type` NULL would be an asset this schema cannot
-- describe: present, ours, and of unstated type. A CHECK constraint evaluating
-- to NULL PASSES in Postgres, so that row would have been accepted today and
-- would have been wrong quietly. This migration is the honest alternative.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS DOES NOT DO
-- ══════════════════════════════════════════════════════════════════════════════
--   * It does not widen `lib/mediaPipeline.ts`'s ALLOWED_MEDIA_MIME. The
--     general upload allowlist (posts, memories, stories, postcards) is
--     UNCHANGED and still admits image and video only. Voice bytes go through
--     a separate, narrower, voice-only allowlist that admits ONE container — an
--     MP4/M4A whose EVERY TRACK IS AUDIO, decided from the tracks rather than
--     from the `ftyp` brand (ALLOWED_VOICE_MIME, sniffVoiceAudio) — and draw on
--     the SAME per-user upload rate-limit bucket, so voice buys no fresh
--     allowance.
--   * It does not touch `media_assets.media_type`. A voice note is a message
--     asset, not a `media_assets` row; nothing here creates one.
--   * It does not add a column. `media_url`, `media_thumbnail_url` and
--     `media_duration_seconds` already exist on `messages`
--     (`baseline/20260819_baseline_structure.sql:7568-7572`); a voice note uses
--     `media_url` + `media_duration_seconds` and leaves the thumbnail NULL.
--   * It does not make any EXISTING row invalid. This is a strict widening: every
--     value the old constraint admitted, the new one admits.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- REVERSAL (exact)
-- ══════════════════════════════════════════════════════════════════════════════
--   BEGIN;
--   -- Refuses if any audio row exists, rather than orphaning it:
--   DO $$ BEGIN
--     IF EXISTS (SELECT 1 FROM public.messages WHERE media_type = 'audio') THEN
--       RAISE EXCEPTION 'cannot reverse 2989: audio messages exist';
--     END IF;
--   END $$;
--   ALTER TABLE public.messages DROP CONSTRAINT messages_media_type_check;
--   ALTER TABLE public.messages ADD CONSTRAINT messages_media_type_check
--     CHECK (media_type = ANY (ARRAY['image'::text, 'video'::text]));
--   COMMIT;
-- ══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $pre$
DECLARE
  n_cols INTEGER;
BEGIN
  IF to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2989): public.messages is absent. There is no message table to widen.';
  END IF;

  -- The three columns a voice note writes must already exist. If one of them is
  -- missing, widening the CHECK would produce a schema in which `media_type`
  -- says `audio` and nothing can say WHERE the audio is or HOW LONG it runs.
  SELECT count(*) INTO n_cols
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'messages'
    AND column_name IN ('media_url', 'media_type', 'media_duration_seconds');
  IF n_cols <> 3 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2989): public.messages carries only % of the 3 media columns a voice note writes (media_url, media_type, media_duration_seconds). Widening the type constraint alone would describe an asset the row cannot locate.', n_cols;
  END IF;

  RAISE NOTICE '2989 precondition: public.messages present with all 3 voice-bearing media columns.';
END
$pre$;

-- ── The widening ─────────────────────────────────────────────────────────────
-- Idempotent: DROP ... IF EXISTS then ADD. Re-running this file is a no-op
-- beyond replacing an identical constraint with an identical constraint.
--
-- Postgres validates the new CHECK against every existing row on ADD. That is
-- deliberate and is the cheapest proof available that this is a widening: if
-- any row somehow carried a media_type outside the new list, this ALTER fails
-- loudly rather than installing a constraint the table already violates.
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_media_type_check;

ALTER TABLE public.messages ADD CONSTRAINT messages_media_type_check
  CHECK (media_type = ANY (ARRAY['image'::text, 'video'::text, 'audio'::text]));

-- ── Postconditions ───────────────────────────────────────────────────────────
-- ABSOLUTE and RE-RUNNABLE STANDALONE: every assertion below reads the CURRENT
-- catalog state only. There is no before/after comparison and no temp table, so
-- `certify:migrations` can execute this block on its own, at any later time,
-- against a database this file has already been applied to, and get the same
-- answer.
DO $post$
DECLARE
  def TEXT;
  n_bad INTEGER;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'messages'
    AND c.conname = 'messages_media_type_check'
    AND c.contype = 'c';

  -- 1. THE CONSTRAINT MUST EXIST. This is the assertion that matters most and
  --    is the one a careless "just drop the check" would trip: with no CHECK at
  --    all, `media_type` accepts any string, every assertion about 'audio'
  --    below would still pass, and the column would have stopped meaning
  --    anything. An absent constraint is a WORSE outcome than the one this file
  --    set out to fix, so it is refused by name.
  IF def IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2989): constraint messages_media_type_check does not exist on public.messages. Without it media_type admits any string and the column no longer constrains anything.';
  END IF;

  -- 2. It must admit the new value.
  IF def NOT LIKE '%''audio''%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2989): messages_media_type_check does not admit ''audio''. Its definition is: %', def;
  END IF;

  -- 3. It must STILL admit both old values. A constraint that traded image or
  --    video for audio would satisfy (1) and (2) and would break every photo
  --    and video message in the product.
  IF def NOT LIKE '%''image''%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2989): messages_media_type_check no longer admits ''image''. The widening dropped an existing value. Its definition is: %', def;
  END IF;
  IF def NOT LIKE '%''video''%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2989): messages_media_type_check no longer admits ''video''. The widening dropped an existing value. Its definition is: %', def;
  END IF;

  -- 4. It must be an IN-list over exactly those three and nothing else. Checked
  --    by naming the three forbidden-by-omission spellings that a sloppy
  --    rewrite reaches for: a NULL-only check, a bare NOT NULL, or `true`.
  IF def LIKE '%IS NOT NULL%' OR def ~* '\(true\)' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2989): messages_media_type_check is not a value list — it is: %. media_type must be constrained to the three named asset types.', def;
  END IF;

  -- 5. THE TABLE MUST AGREE WITH ITS OWN CONSTRAINT. Postgres validates on ADD,
  --    but this block is re-run standalone long after that ADD, by which time
  --    rows have arrived. A row whose media_type is outside the list can only
  --    exist if the constraint was disabled, dropped and re-added NOT VALID, or
  --    bypassed — each of which is worth a loud failure.
  SELECT count(*) INTO n_bad
  FROM public.messages
  WHERE media_type IS NOT NULL
    AND media_type NOT IN ('image', 'video', 'audio');
  IF n_bad > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2989): % row(s) in public.messages carry a media_type outside (image, video, audio) despite the constraint. The constraint is not being enforced.', n_bad;
  END IF;

  RAISE NOTICE '2989 postconditions: messages_media_type_check present and admits image, video, audio; 0 rows violate it. Definition: %', def;
END
$post$;

COMMIT;
