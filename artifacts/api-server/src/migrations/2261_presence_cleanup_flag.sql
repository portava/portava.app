-- 2261_presence_cleanup_flag.sql
-- Operationally enforce the presence_in_context session bound. OFF by default.
BEGIN;
INSERT INTO public.feature_flags(flag, enabled, description) VALUES
 ('presence_cleanup_enabled', false, 'Marks stale and deletes expired circle_presence rows; disabled by default until scheduler rollout is verified.')
ON CONFLICT (flag) DO NOTHING;
COMMIT;