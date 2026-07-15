-- Migration 0095: posts.category column
-- Applied manually to Supabase on 2026-07-04.
--
-- Adds a nullable free-text category to posts.
-- Values match the PostCategory enum on the client
-- (food, nightlife, beach, adventure, culture, wellness, etc.).
-- NULL is a valid value meaning "uncategorised".

ALTER TABLE posts ADD COLUMN IF NOT EXISTS category TEXT;
