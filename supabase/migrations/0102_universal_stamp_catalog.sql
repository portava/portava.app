-- Migration: Universal Stamp Catalog
-- Creates the canonical stamp catalog tables, adds catalog_id to existing
-- ownership tables, and sets up RLS policies.
-- Safe to run on an existing database — uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.

-- ── 1. universal_stamp_catalog ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS universal_stamp_catalog (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_location_key  text NOT NULL,
  stamp_type              text NOT NULL,
  display_name            text NOT NULL,
  country                 text NOT NULL,
  country_code            char(2) NOT NULL,
  region                  text,
  city                    text,
  neighborhood            text,
  lat                     numeric(10, 6),
  lng                     numeric(11, 6),
  place_ids               jsonb DEFAULT '{}',
  status                  text NOT NULL DEFAULT 'pending_artwork'
                            CHECK (status IN ('pending_artwork', 'approved', 'rejected', 'archived')),
  active_version_id       uuid,  -- FK added after stamp_artwork_versions exists
  prompt_template_version text NOT NULL DEFAULT 'v1.0',
  earn_count              int NOT NULL DEFAULT 0,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- Unique per (location_key, stamp_type) pair
CREATE UNIQUE INDEX IF NOT EXISTS uix_catalog_key_type
  ON universal_stamp_catalog (canonical_location_key, stamp_type);

-- For admin filtering by country / status
CREATE INDEX IF NOT EXISTS ix_catalog_country_code ON universal_stamp_catalog (country_code);
CREATE INDEX IF NOT EXISTS ix_catalog_status       ON universal_stamp_catalog (status);
CREATE INDEX IF NOT EXISTS ix_catalog_stamp_type   ON universal_stamp_catalog (stamp_type);

-- ── 2. stamp_artwork_versions ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS stamp_artwork_versions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_id               uuid NOT NULL REFERENCES universal_stamp_catalog (id) ON DELETE CASCADE,
  status                   text NOT NULL DEFAULT 'candidate'
                             CHECK (status IN ('candidate', 'approved', 'rejected', 'archived')),
  storage_path             text,
  public_url               text,
  generation_source        text NOT NULL DEFAULT 'ai_generated'
                             CHECK (generation_source IN ('ai_generated', 'admin_upload')),
  provider                 text,
  model_version            text,
  prompt_used              text,
  prompt_template_version  text,
  generation_metadata      jsonb DEFAULT '{}',
  created_by_admin_id      uuid,
  reviewed_by_admin_id     uuid,
  reviewed_at              timestamptz,
  rejection_reason         text,
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_artwork_catalog_status
  ON stamp_artwork_versions (catalog_id, status);

-- Back-fill FK from catalog to active version (safe circular ref via ALTER)
ALTER TABLE universal_stamp_catalog
  ADD CONSTRAINT fk_catalog_active_version
  FOREIGN KEY (active_version_id)
  REFERENCES stamp_artwork_versions (id)
  ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;

-- ── 3. stamp_generation_queue ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS stamp_generation_queue (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_id          uuid NOT NULL REFERENCES universal_stamp_catalog (id) ON DELETE CASCADE,
  status              text NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued', 'generating', 'review_required', 'retryable_failed', 'archived')),
  priority            int NOT NULL DEFAULT 5,
  attempts            int NOT NULL DEFAULT 0,
  max_attempts        int NOT NULL DEFAULT 3,
  last_error          text,
  locked_until        timestamptz,
  locked_by           text,
  triggered_by_action text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Only one active job per catalog entry (status not in archived/retryable_failed)
CREATE UNIQUE INDEX IF NOT EXISTS uix_queue_catalog_active
  ON stamp_generation_queue (catalog_id)
  WHERE status NOT IN ('archived', 'retryable_failed');

CREATE INDEX IF NOT EXISTS ix_queue_status_priority
  ON stamp_generation_queue (status, priority, created_at);

-- ── 4. stamp_admin_audit_log ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS stamp_admin_audit_log (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id         uuid NOT NULL,
  action           text NOT NULL,
  catalog_id       uuid REFERENCES universal_stamp_catalog (id) ON DELETE SET NULL,
  version_id       uuid REFERENCES stamp_artwork_versions (id) ON DELETE SET NULL,
  target_catalog_id uuid REFERENCES universal_stamp_catalog (id) ON DELETE SET NULL,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_audit_catalog_id ON stamp_admin_audit_log (catalog_id);
CREATE INDEX IF NOT EXISTS ix_audit_admin_id   ON stamp_admin_audit_log (admin_id);

-- ── 5. stamp_reconciliation_log ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS stamp_reconciliation_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_table        text NOT NULL,
  source_id           uuid NOT NULL,
  raw_country         text,
  raw_city            text,
  stamp_type          text,
  canonical_key       text,
  catalog_id          uuid REFERENCES universal_stamp_catalog (id) ON DELETE SET NULL,
  needs_admin_review  bool NOT NULL DEFAULT false,
  review_reason       text,
  processed_at        timestamptz NOT NULL DEFAULT now()
);

-- ── 6. Add catalog_id to ownership tables ─────────────────────────────────────

ALTER TABLE passport_stamps
  ADD COLUMN IF NOT EXISTS catalog_id uuid REFERENCES universal_stamp_catalog (id) ON DELETE SET NULL;

ALTER TABLE user_stamps
  ADD COLUMN IF NOT EXISTS catalog_id uuid REFERENCES universal_stamp_catalog (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_passport_stamps_catalog_id ON passport_stamps (catalog_id);
CREATE INDEX IF NOT EXISTS ix_user_stamps_catalog_id     ON user_stamps (catalog_id);

-- ── 7. RLS policies ───────────────────────────────────────────────────────────

ALTER TABLE universal_stamp_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE stamp_artwork_versions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE stamp_generation_queue  ENABLE ROW LEVEL SECURITY;
ALTER TABLE stamp_admin_audit_log   ENABLE ROW LEVEL SECURITY;
ALTER TABLE stamp_reconciliation_log ENABLE ROW LEVEL SECURITY;

-- universal_stamp_catalog: service_role full access; authenticated read approved entries
DROP POLICY IF EXISTS "catalog_service_all" ON universal_stamp_catalog;
CREATE POLICY "catalog_service_all" ON universal_stamp_catalog
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "catalog_authenticated_read_approved" ON universal_stamp_catalog;
CREATE POLICY "catalog_authenticated_read_approved" ON universal_stamp_catalog
  FOR SELECT TO authenticated USING (status = 'approved');

-- stamp_artwork_versions: service_role full access; authenticated read approved versions
DROP POLICY IF EXISTS "artwork_service_all" ON stamp_artwork_versions;
CREATE POLICY "artwork_service_all" ON stamp_artwork_versions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "artwork_authenticated_read_approved" ON stamp_artwork_versions;
CREATE POLICY "artwork_authenticated_read_approved" ON stamp_artwork_versions
  FOR SELECT TO authenticated USING (status = 'approved');

-- Admin audit log: service_role only (append-only; no delete in policies)
DROP POLICY IF EXISTS "audit_service_all" ON stamp_admin_audit_log;
CREATE POLICY "audit_service_all" ON stamp_admin_audit_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Queue: service_role only
DROP POLICY IF EXISTS "queue_service_all" ON stamp_generation_queue;
CREATE POLICY "queue_service_all" ON stamp_generation_queue
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Reconciliation log: service_role only
DROP POLICY IF EXISTS "reconcile_service_all" ON stamp_reconciliation_log;
CREATE POLICY "reconcile_service_all" ON stamp_reconciliation_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);
