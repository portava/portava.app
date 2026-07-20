-- 0150: Add media_type to passport_memories.
-- Allows the memory creation form to distinguish image vs video media.
-- NULL = legacy row (image assumed for rendering).

ALTER TABLE passport_memories ADD COLUMN IF NOT EXISTS media_type TEXT CHECK (media_type IN ('image', 'video'));
