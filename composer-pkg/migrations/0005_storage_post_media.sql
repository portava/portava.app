-- ============================================================================
-- Travel Buddy — Storage setup: post-media bucket
-- Run in the Supabase SQL editor (project ajrurzioarfkagpuxfnb).
-- Creates a public-read bucket where authenticated users can upload ONLY into
-- their own folder: post-media/{auth.uid()}/...
-- ============================================================================

-- Create the bucket (public read for Pulse media). Idempotent.
insert into storage.buckets (id, name, public)
values ('post-media', 'post-media', true)
on conflict (id) do update set public = true;

-- ---- RLS policies on storage.objects for this bucket ----
-- Drop first so this script is re-runnable.
drop policy if exists "post-media public read"        on storage.objects;
drop policy if exists "post-media auth upload own"     on storage.objects;
drop policy if exists "post-media auth update own"     on storage.objects;
drop policy if exists "post-media auth delete own"     on storage.objects;

-- Public read (bucket is public; this makes SELECT explicit).
create policy "post-media public read"
  on storage.objects for select
  using ( bucket_id = 'post-media' );

-- Authenticated users may upload ONLY into a folder named after their uid:
--   post-media/<uid>/<uuid>.<ext>
-- storage.foldername(name) returns the path segments; [1] is the first folder.
create policy "post-media auth upload own"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'post-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Owners may update/delete only their own objects.
create policy "post-media auth update own"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'post-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "post-media auth delete own"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'post-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Verify:
--   select id, public from storage.buckets where id='post-media';        -- public=true
--   select policyname from pg_policies where tablename='objects'
--     and policyname like 'post-media%';                                  -- 4 rows
