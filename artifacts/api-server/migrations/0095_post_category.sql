-- Add optional category column to posts for editorial classification.
-- Values match the PostCategory enum on the client (food, nightlife, beach, etc.).
ALTER TABLE posts ADD COLUMN IF NOT EXISTS category TEXT;
