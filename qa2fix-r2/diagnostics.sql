-- QA Round 2 — diagnostics for the two "duplicate" bugs (12, 13).
-- Run these SELECTs first to tell a real double-INSERT apart from a double-RENDER
-- or seed-data duplication. Nothing here mutates data.

-- ── BUG 12: duplicate shared-post delivery in a Telegraph thread ──────────────
-- Are there actually two message rows, or one row rendered twice?
-- Replace the thread filter as needed. If COUNT > 1 for the same (thread, sender,
-- shared post, minute), it's a real double-insert → the share endpoint needs an
-- idempotency guard. If COUNT = 1, it's a client double-render bug.
SELECT thread_id, sender_id, content, COUNT(*) AS copies,
       MIN(created_at) AS first_at, MAX(created_at) AS last_at
FROM messages
WHERE content ILIKE '%QA testing Portava from Cebu%'
GROUP BY thread_id, sender_id, content
HAVING COUNT(*) > 1
ORDER BY copies DESC;

-- Broader sweep: any near-duplicate messages sent within 5 seconds of each other
-- (a classic double-submit signature).
SELECT thread_id, sender_id, content, COUNT(*) AS copies
FROM messages
GROUP BY thread_id, sender_id, content
HAVING COUNT(*) > 1
ORDER BY copies DESC
LIMIT 50;

-- ── BUG 13: identical caption+video posts under different demo authors ────────
-- If the same media_urls/content appears under multiple author_ids, this is
-- SEED-DATA duplication (the /posts feed is a straight select — no author-swapping
-- join), not a feed bug. Confirm, then clean the seed rows.
SELECT content, media_urls, COUNT(DISTINCT author_id) AS distinct_authors,
       COUNT(*) AS rows, array_agg(DISTINCT author_id) AS authors
FROM posts
WHERE status = 'active'
GROUP BY content, media_urls
HAVING COUNT(DISTINCT author_id) > 1
ORDER BY rows DESC;

-- To clean confirmed seed duplicates (REVIEW the SELECT above first — this deletes):
-- WITH dupes AS (
--   SELECT id, ROW_NUMBER() OVER (PARTITION BY content, media_urls ORDER BY created_at) AS rn
--   FROM posts WHERE status = 'active'
-- )
-- DELETE FROM posts WHERE id IN (SELECT id FROM dupes WHERE rn > 1);

-- ── BUG 11: video posts with a placeholder/empty media URL ───────────────────
SELECT id, author_id, media_urls, created_at
FROM posts
WHERE status = 'active'
  AND (media_urls IS NULL OR media_urls::text ILIKE '%example.com%' OR media_urls::text ILIKE '%placeholder%')
ORDER BY created_at DESC
LIMIT 50;
