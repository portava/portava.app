-- Add events.featured to back the existing admin "feature event" toggle
-- (admin.ts /admin/events routes read and write this column).
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS featured boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_events_featured ON public.events (featured) WHERE featured;
