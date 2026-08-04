-- 2070_rls_hardening.sql
-- Enable RLS (deny-all) on tables that exist in the live DB without RLS.
--
-- Why: the mobile app ships the Supabase ANON key. Any table without RLS is
-- fully readable AND writable by anyone holding that key. The API server is
-- unaffected — requireUser() (lib/http.ts) and every worker/service use the
-- SERVICE-ROLE client, which bypasses RLS entirely.
--
-- Client audit (2026-08-04): grepped travel-buddy-standalone/src for direct
-- supabase-js .from() usage. The client's own supabase client touches ONLY:
-- profiles, user_follows, trips, trip_members, message_thread_members,
-- circles, and the 'post-media' storage bucket. NONE of the 12 tables below
-- are accessed client-side (feature_flags and the reaction/like tables were
-- checked specifically — all reads/writes go through the API). Deny-all is
-- therefore safe: no permissive policies are added on purpose.
--
-- Each table is wrapped in a to_regclass() existence check so this migration
-- is idempotent and safe to run on environments where a table hasn't been
-- created yet (ENABLE ROW LEVEL SECURITY is itself idempotent).

-- devices — E2EE device registry (20260801_e2ee_devices.sql). Server-only:
-- routes/devices.ts + routes/keyPackages.ts via service client. Contains
-- device public keys/metadata; must not be world-writable.
DO $$
BEGIN
  IF to_regclass('public.devices') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;

-- key_packages — E2EE prekey bundles (20260802_e2ee_key_packages.sql).
-- Server-only: routes/keyPackages.ts. Anonymous writes here would enable
-- key-substitution attacks; lockout is the whole point.
DO $$
BEGIN
  IF to_regclass('public.key_packages') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.key_packages ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;

-- post_reactions — post likes. Written/read only by routes/engagement.ts and
-- routes/posts.ts (service client). The app calls the API for reactions; it
-- never queries this table with the anon key.
DO $$
BEGIN
  IF to_regclass('public.post_reactions') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.post_reactions ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;

-- comment_likes — comment likes. Same pattern as post_reactions:
-- routes/engagement.ts + routes/posts.ts only.
DO $$
BEGIN
  IF to_regclass('public.comment_likes') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.comment_likes ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;

-- post_shares — share counters, routes/posts.ts only.
DO $$
BEGIN
  IF to_regclass('public.post_shares') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.post_shares ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;

-- post_edits — post edit history, routes/posts.ts only. Without RLS anyone
-- could read every user's edit history with the anon key.
DO $$
BEGIN
  IF to_regclass('public.post_edits') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.post_edits ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;

-- stamp_milestones — milestone crossings (2051_stamp_milestones.sql, which
-- created it without RLS). Written by StampAwardEngine, read by
-- routes/passportStamps.ts + routes/profile.ts — all service-role.
DO $$
BEGIN
  IF to_regclass('public.stamp_milestones') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.stamp_milestones ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;

-- post_event_links — post↔event associations (20260731_post_event_links.sql).
-- Server-only: lib/eventPostsDiscovery.ts.
DO $$
BEGIN
  IF to_regclass('public.post_event_links') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.post_event_links ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;

-- media_stamp_reactions — stamp reactions on media
-- (20260814_media_stamp_reactions.sql). Server-only: routes/mediaFeed.ts.
-- (The client's mediaInteractions.ts mentions the table name only in a code
-- comment — it calls the API, not the table.)
DO $$
BEGIN
  IF to_regclass('public.media_stamp_reactions') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.media_stamp_reactions ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;

-- place_mismatch_reports — user reports of wrong place data. Server-only:
-- routes/posts.ts (create) + routes/adminPlaceMismatch.ts (admin review).
-- Must not be publicly readable (reporter IDs) or writable (spam).
DO $$
BEGIN
  IF to_regclass('public.place_mismatch_reports') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.place_mismatch_reports ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;

-- feature_flags — server-side kill switches / rollout flags. 60+ server
-- references, ZERO client references: the app learns flag state from API
-- responses, never by querying this table. Without RLS anyone with the anon
-- key could read the rollout roadmap — or WRITE flags and toggle features
-- for everyone. Deny-all is required, not just safe.
DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;

-- job_health — background-job heartbeats (delayedPostPublisher,
-- dailyBriefCleanup, tripCrewLiveShareScheduler, adminRankingMetrics).
-- Pure server operational state; no client involvement.
DO $$
BEGIN
  IF to_regclass('public.job_health') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.job_health ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;
