-- Migration 0182: Country essentials (curated travel-readiness reference data)
--
-- Plug types, mains voltage/frequency, drive side, and emergency numbers per
-- country. Curated static data (no live provider — none worth using exists for
-- this). Plug/voltage/frequency are engineering-standardized (IEC) and stable;
-- emergency numbers are curated with a confirm-on-arrival disclaimer surfaced
-- by every consumer (safety-relevant).
--
-- confidence='curated', source + dataset date recorded on the table. Countries
-- not seeded return nothing (unknown) — the app never guesses.
--
-- Safe to re-run: seed uses ON CONFLICT (code) DO NOTHING so curated edits made
-- later via admin are preserved.

CREATE TABLE IF NOT EXISTS country_essentials (
  code           CHAR(2)     PRIMARY KEY,
  plug_types     TEXT[]      NOT NULL DEFAULT '{}',
  voltage        INTEGER,
  frequency      INTEGER,
  drive_side     TEXT        CHECK (drive_side IN ('left','right')),
  emergency      JSONB       NOT NULL DEFAULT '{}',
  confidence     TEXT        NOT NULL DEFAULT 'curated',
  source         TEXT        NOT NULL DEFAULT 'IEC World Plugs; national emergency-service directories (curated)',
  last_verified_at DATE      NOT NULL DEFAULT DATE '2026-07-24',
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE country_essentials ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'country_essentials' AND policyname = 'ce_read') THEN
    CREATE POLICY ce_read ON country_essentials FOR SELECT USING (auth.role() IN ('authenticated','service_role'));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'country_essentials' AND policyname = 'ce_svc') THEN
    CREATE POLICY ce_svc ON country_essentials FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

INSERT INTO country_essentials (code, plug_types, voltage, frequency, drive_side, emergency) VALUES
  ('US', ARRAY['A','B'], 120, 60, 'right', '{"all":"911"}'::jsonb),
  ('CA', ARRAY['A','B'], 120, 60, 'right', '{"all":"911"}'::jsonb),
  ('MX', ARRAY['A','B'], 127, 60, 'right', '{"all":"911"}'::jsonb),
  ('CR', ARRAY['A','B'], 120, 60, 'right', '{"all":"911"}'::jsonb),
  ('GB', ARRAY['G'], 230, 50, 'left', '{"all":"999","police":"999","ambulance":"999","fire":"999"}'::jsonb),
  ('IE', ARRAY['G','F'], 230, 50, 'left', '{"all":"112","police":"999"}'::jsonb),
  ('FR', ARRAY['C','E'], 230, 50, 'right', '{"all":"112"}'::jsonb),
  ('DE', ARRAY['C','F'], 230, 50, 'right', '{"all":"112","police":"110"}'::jsonb),
  ('ES', ARRAY['C','F'], 230, 50, 'right', '{"all":"112"}'::jsonb),
  ('IT', ARRAY['C','F','L'], 230, 50, 'right', '{"all":"112"}'::jsonb),
  ('NL', ARRAY['C','F'], 230, 50, 'right', '{"all":"112"}'::jsonb),
  ('BE', ARRAY['C','E'], 230, 50, 'right', '{"all":"112"}'::jsonb),
  ('PT', ARRAY['C','F'], 230, 50, 'right', '{"all":"112"}'::jsonb),
  ('AT', ARRAY['C','F'], 230, 50, 'right', '{"all":"112"}'::jsonb),
  ('CH', ARRAY['C','J'], 230, 50, 'right', '{"all":"112","police":"117","fire":"118","ambulance":"144"}'::jsonb),
  ('GR', ARRAY['C','F'], 230, 50, 'right', '{"all":"112"}'::jsonb),
  ('SE', ARRAY['C','F'], 230, 50, 'right', '{"all":"112"}'::jsonb),
  ('NO', ARRAY['C','F'], 230, 50, 'right', '{"all":"112","ambulance":"113","fire":"110"}'::jsonb),
  ('DK', ARRAY['C','E','F','K'], 230, 50, 'right', '{"all":"112"}'::jsonb),
  ('FI', ARRAY['C','F'], 230, 50, 'right', '{"all":"112"}'::jsonb),
  ('PL', ARRAY['C','E'], 230, 50, 'right', '{"all":"112"}'::jsonb),
  ('CZ', ARRAY['C','E'], 230, 50, 'right', '{"all":"112"}'::jsonb),
  ('HU', ARRAY['C','F'], 230, 50, 'right', '{"all":"112"}'::jsonb),
  ('HR', ARRAY['C','F'], 230, 50, 'right', '{"all":"112"}'::jsonb),
  ('IS', ARRAY['C','F'], 230, 50, 'right', '{"all":"112"}'::jsonb),
  ('TR', ARRAY['C','F'], 230, 50, 'right', '{"all":"112"}'::jsonb),
  ('RU', ARRAY['C','F'], 220, 50, 'right', '{"all":"112","police":"102","ambulance":"103","fire":"101"}'::jsonb),
  ('JP', ARRAY['A','B'], 100, 50, 'left', '{"police":"110","fire":"119","ambulance":"119"}'::jsonb),
  ('CN', ARRAY['A','C','I'], 220, 50, 'right', '{"police":"110","ambulance":"120","fire":"119"}'::jsonb),
  ('KR', ARRAY['C','F'], 220, 60, 'right', '{"police":"112","fire":"119","ambulance":"119"}'::jsonb),
  ('TW', ARRAY['A','B'], 110, 60, 'right', '{"police":"110","fire":"119","ambulance":"119"}'::jsonb),
  ('HK', ARRAY['G'], 220, 50, 'left', '{"all":"999"}'::jsonb),
  ('TH', ARRAY['A','B','C','O'], 230, 50, 'left', '{"police":"191","ambulance":"1669","fire":"199"}'::jsonb),
  ('VN', ARRAY['A','C','F'], 220, 50, 'right', '{"police":"113","ambulance":"115","fire":"114"}'::jsonb),
  ('ID', ARRAY['C','F'], 230, 50, 'left', '{"all":"112","police":"110"}'::jsonb),
  ('MY', ARRAY['G'], 240, 50, 'left', '{"all":"999"}'::jsonb),
  ('SG', ARRAY['G'], 230, 50, 'left', '{"police":"999","ambulance":"995","fire":"995"}'::jsonb),
  ('PH', ARRAY['A','B','C'], 220, 60, 'right', '{"all":"911"}'::jsonb),
  ('IN', ARRAY['C','D','M'], 230, 50, 'left', '{"all":"112","police":"100","ambulance":"102","fire":"101"}'::jsonb),
  ('AU', ARRAY['I'], 230, 50, 'left', '{"all":"000","police":"000"}'::jsonb),
  ('NZ', ARRAY['I'], 230, 50, 'left', '{"all":"111"}'::jsonb),
  ('AE', ARRAY['G'], 220, 50, 'right', '{"police":"999","ambulance":"998","fire":"997"}'::jsonb),
  ('SA', ARRAY['G'], 230, 60, 'right', '{"police":"999","ambulance":"997","fire":"998"}'::jsonb),
  ('IL', ARRAY['C','H','M'], 230, 50, 'right', '{"police":"100","ambulance":"101","fire":"102"}'::jsonb),
  ('EG', ARRAY['C','F'], 220, 50, 'right', '{"police":"122","ambulance":"123"}'::jsonb),
  ('ZA', ARRAY['C','D','M','N'], 230, 50, 'left', '{"police":"10111","ambulance":"10177"}'::jsonb),
  ('KE', ARRAY['G'], 240, 50, 'left', '{"all":"999"}'::jsonb),
  ('NG', ARRAY['D','G'], 230, 50, 'right', '{"all":"112"}'::jsonb),
  ('MA', ARRAY['C','E'], 220, 50, 'right', '{"police":"19","ambulance":"15"}'::jsonb),
  ('BR', ARRAY['C','N'], 127, 60, 'right', '{"police":"190","ambulance":"192"}'::jsonb),
  ('AR', ARRAY['C','I'], 220, 50, 'right', '{"all":"911","ambulance":"107"}'::jsonb),
  ('CL', ARRAY['C','L'], 220, 50, 'right', '{"police":"133","ambulance":"131","fire":"132"}'::jsonb),
  ('CO', ARRAY['A','B'], 110, 60, 'right', '{"all":"123"}'::jsonb),
  ('PE', ARRAY['A','B','C'], 220, 60, 'right', '{"all":"105","ambulance":"106"}'::jsonb)
ON CONFLICT (code) DO NOTHING;

-- Rollout flag (default FALSE).
INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('country_essentials_enabled', FALSE,
   'Country essentials: plug types, voltage, drive side, emergency numbers on trip readiness surfaces')
ON CONFLICT (flag) DO NOTHING;
