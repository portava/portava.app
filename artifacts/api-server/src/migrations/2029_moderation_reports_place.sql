-- Migration 2029: extend moderation_reports to accept place subject type
--
-- The reporting UI (PlaceReportSheet) posts subjectType:'place' with
-- place-specific category values. Both the subject_type and category
-- CHECK constraints must be widened to accept them.
--
-- Safe to re-run: DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT pattern.
-- The constraint names below follow PostgreSQL's default naming scheme for
-- inline CHECK constraints: <table>_<column>_check.
--
-- Place-specific categories:
--   wrong_place, wrong_photo, duplicate, closed,
--   incorrect_address, incorrect_category, outdated_image

-- ── subject_type ──────────────────────────────────────────────────────────────

ALTER TABLE moderation_reports
  DROP CONSTRAINT IF EXISTS moderation_reports_subject_type_check;

ALTER TABLE moderation_reports
  ADD CONSTRAINT moderation_reports_subject_type_check
  CHECK (subject_type IN (
    'user','post','comment','message','event','review','buddy_listing','media','place'
  ));

-- ── category ──────────────────────────────────────────────────────────────────

ALTER TABLE moderation_reports
  DROP CONSTRAINT IF EXISTS moderation_reports_category_check;

ALTER TABLE moderation_reports
  ADD CONSTRAINT moderation_reports_category_check
  CHECK (category IN (
    -- General moderation categories
    'impersonation','harassment','scam_fraud','inappropriate_content',
    'safety_concern','underage','spam','other',
    -- Place-specific report categories
    'wrong_place','wrong_photo','duplicate','closed',
    'incorrect_address','incorrect_category','outdated_image'
  ));
