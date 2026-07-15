-- Migration 0064: tags approval workflow
-- Adds status column to support approval_required tag_permission setting.
-- status: 'approved' (immediate) | 'pending' (awaiting target approval) | 'rejected'

ALTER TABLE tags
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'approved';

CREATE INDEX IF NOT EXISTS tags_status_idx ON tags (status) WHERE status <> 'approved';
