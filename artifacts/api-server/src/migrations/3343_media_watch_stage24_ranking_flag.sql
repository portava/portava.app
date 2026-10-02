-- 3343_media_watch_stage24_ranking_flag.sql
-- Media — the ranker half of the owner's surface decision F2 as ONE flag,
-- seeded OFF (census-media §34: MD11, MD215, MD402, MD435).
--
-- Additive + idempotent. Safe to re-run. SCREAMING_CASE like the rest of the
-- MEDIA_* family; a CAPABILITY: `true` = the Watch feed is ordered by the §24
-- Media Ranking stage.
--
-- ── WHAT THIS GATES ─────────────────────────────────────────────────────────
-- Read server-side at GET /api/media/feed (routes/mediaFeed.ts, the Watch
-- feed) through services/media/WatchStage24Ranking.isWatchStage24RankingEnabled,
-- which is isFlagEnabled: an absent row, a failed read and FALSE all read
-- false. ON: the page the eligibility gate admitted is ordered by
-- services/media/MediaRankingService.rankCandidatesForViewer — the §24 stage
-- the World shell already uses, which reads no like, stamp, view, watch time or
-- completion rate — instead of services/ranking/MediaFeedRankingService's
-- rankMediaFeed, which multiplies by watch completion, qualified views and
-- re-watches. That function has no other caller, so ON retires the legacy
-- Watch ranker from every request path. Impressions log the §24 terms the
-- page was ordered by, prefixed `s24_`; the legacy "Why This?" snapshot is not
-- written for a page the legacy ranker did not order.
--
-- ON IS NOT GATED BY MEDIA_RANKING_ENABLED. That flag is the LEGACY ranker's
-- master switch (OFF there = chronological order). The §24 stage has no master
-- switch in the World shell and has none here; turning this ON is itself the
-- decision to rank Watch with it. The NOTICE below reports what Watch does on
-- the database it runs against today.
--
-- ── RUNTIME EFFECT OF SEEDING: NONE, AND THAT IS CHECKED ───────────────────
-- Seeded FALSE; the postcondition refuses a seed that finds it ON. Absent and
-- FALSE read the same: rankMediaFeed orders the page exactly as today. The one
-- cost is one extra flag read per Watch page, started beside the ranking loads
-- so it adds no round trip. Turning it ON is the owner's F2 decision, and
-- whether Media may own the §24 stage at all is the §42-against-§48 decision
-- MD435 records.
--
-- Rollback: db/rollback/2026-09-27-3343-media-watch-stage24-ranking-flag-rollback.sql
-- NOT applied to any database by the lane that wrote it.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'MEDIA_WATCH_STAGE24_RANKING_ENABLED',
    false,
    'Media (census-media §34, owner decision F2, MD435): the Watch feed (GET /api/media/feed) is ordered by the §24 Media Ranking stage (services/media/MediaRankingService.rankCandidatesForViewer), which reads no engagement count or watch time, instead of the legacy MediaFeedRankingService.rankMediaFeed and its watch-completion, qualified-view and re-watch multipliers. Read in services/media/WatchStage24Ranking.ts via isFlagEnabled (fail-closed). Not gated by MEDIA_RANKING_ENABLED, the legacy ranker''s own master switch. ON: impressions log the §24 terms (s24_*), no legacy Why-This snapshot is written. OFF / absent / unreadable (the seed): the legacy ranker orders the page exactly as today.'
  )
ON CONFLICT (flag) DO NOTHING;

DO $$
DECLARE present int; on_count int; legacy_on int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'MEDIA_WATCH_STAGE24_RANKING_ENABLED';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected MEDIA_WATCH_STAGE24_RANKING_ENABLED present, found %', present;
  END IF;

  -- Tell the applier what Watch does today on THIS database.
  SELECT count(*) INTO legacy_on FROM public.feature_flags
    WHERE flag = 'MEDIA_RANKING_ENABLED' AND enabled = TRUE;
  RAISE NOTICE '3343: MEDIA_WATCH_STAGE24_RANKING_ENABLED seeded/kept. On this database the legacy ranker''s master switch MEDIA_RANKING_ENABLED is %, so Watch is ordered today by %.',
    CASE WHEN legacy_on = 1 THEN 'ON' ELSE 'OFF/absent' END,
    CASE WHEN legacy_on = 1 THEN 'rankMediaFeed (watch multipliers)' ELSE 'recency (rankMediaFeed''s chronological fallback)' END;

  -- Seeded ON would mean this migration took the F2 decision.
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'MEDIA_WATCH_STAGE24_RANKING_ENABLED' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: MEDIA_WATCH_STAGE24_RANKING_ENABLED is ON — retiring the legacy Watch ranker is the owner''s F2 decision and this must ship OFF';
  END IF;
END $$;

COMMIT;
