# Step 01 gate — evidence

Captured 2026-08-12 by `npm run audit:staging-boundary-grant` in
`artifacts/api-server`, read-only against production `ajrurzioarfkagpuxfnb`
through `ciProdReadOnlyAuditGuard`. Reproduce with:

```
PORTAVA_PROD_READ_ONLY_AUDIT='read-only-audit-against-production' \
KNOWN_PROD_PROJECT_REF='ajrurzioarfkagpuxfnb' \
npm run audit:staging-boundary-grant
```

**Gate result: ✅ satisfied.**

## Why this file exists

The two policies Step 01 drops are declared by **no migration** and appear
**nowhere in git history** — verified by `git log --all -S` on both names, which
returns only prose documents. They were applied out of band.
`docs/fact-layer-20260810/PROMOTION.md` records their command and role but not
their `qual` / `with_check`.

So the live catalog was the only surviving copy of what these policies say.
Dropping them without capturing the body first would mean the rollback does not
exist — discovered at the moment someone needs it. This is that capture.

## Precondition — the prefixes are unused

| Measure | Value |
|---|---|
| `post-media` objects under `memories/` | **0** |
| `post-media` objects under `stories/` | **0** |
| `stories` rows | 0 |
| `post-media` objects, total | 35 |

Measured, not trusted. The packet's figures were re-derived rather than carried
forward, because the bucket is not static.

## The two policy bodies, verbatim

### `post_media_storage_memories_stories_insert`

- cmd `INSERT` · permissive `PERMISSIVE` · roles `{authenticated}`
- `qual` — null
- `with_check`:

```
((bucket_id = 'post-media'::text)
 AND ((storage.foldername(name))[1] = ANY (ARRAY['memories'::text, 'stories'::text]))
 AND ((storage.foldername(name))[2] = (auth.uid())::text)
 AND (lower(storage.extension(name)) = ANY (ARRAY['jpg'::text, 'jpeg'::text,
      'png'::text, 'webp'::text, 'heic'::text, 'mp4'::text, 'mov'::text,
      'webm'::text, '3gp'::text])))
```

This is the armed grant. It confirms the packet's prose exactly: any
authenticated caller may write into the durable bucket under
`memories/{their-uid}/…` or `stories/{their-uid}/…`, for **nine** extensions.

Two things the prose did not say, now visible:

- **The extension list includes `mp4`, `mov`, `webm`, `3gp`.** The grant admits
  video, and video is never stripped on any path (V5). D6b rules that promotion
  strips container metadata — this grant is a way to put video into the durable
  bucket without ever passing through promotion.
- **It includes `heic`.** D6a rules that the decoder gets added; this grant is a
  path that bypasses the decoder question entirely by writing the original.

### `post_media_memories_stories_delete`

- cmd `DELETE` · permissive `PERMISSIVE` · roles `{authenticated}`
- `qual`:

```
((bucket_id = 'post-media'::text)
 AND ((storage.foldername(name))[1] = ANY (ARRAY['memories'::text, 'stories'::text]))
 AND ((storage.foldername(name))[2] = (auth.uid())::text))
```

- `with_check` — null

## The rollback

Verbatim re-CREATE, to be carried in the Step 01 migration's down section:

```sql
CREATE POLICY "post_media_storage_memories_stories_insert" ON storage.objects
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (((bucket_id = 'post-media'::text) AND ((storage.foldername(name))[1] = ANY (ARRAY['memories'::text, 'stories'::text])) AND ((storage.foldername(name))[2] = (auth.uid())::text) AND (lower(storage.extension(name)) = ANY (ARRAY['jpg'::text, 'jpeg'::text, 'png'::text, 'webp'::text, 'heic'::text, 'mp4'::text, 'mov'::text, 'webm'::text, '3gp'::text]))));

CREATE POLICY "post_media_memories_stories_delete" ON storage.objects
  AS PERMISSIVE
  FOR DELETE
  TO authenticated
  USING (((bucket_id = 'post-media'::text) AND ((storage.foldername(name))[1] = ANY (ARRAY['memories'::text, 'stories'::text])) AND ((storage.foldername(name))[2] = (auth.uid())::text)));
```

## Operator runbook — the proof, and applying the drop

Ruling 2026-08-12: the red-proof is the **before/after production run**, and the
rollback DDL is validated **once**, as an operator one-shot against the CI
project. Neither becomes standing test machinery. The reasoning: options that
bake this into a suite would grant tests Management API DDL power **forever**,
to prove a one-time drift removal — durable machinery for a one-shot event.

All four steps are operator-executed through the sanctioned path.

### Step A — prove the grant is present (before)

```
cd artifacts/api-server
PORTAVA_PROD_READ_ONLY_AUDIT='read-only-audit-against-production' \
KNOWN_PROD_PROJECT_REF='ajrurzioarfkagpuxfnb' \
npm run audit:staging-boundary-grant
```

Expect **exit 0**, both bodies printed, both prefixes reporting 0 objects.
If it exits 1, stop — either a prefix is no longer empty, or a policy is
already gone. Do not apply.

### Step B — validate the rollback DDL, once, against the CI project

One-shot. Not a test, not repeated. Against the **CI** project, never
production.

1. Apply the captured re-CREATE (both statements from "The rollback" above) to
   the CI project.
2. Read back pg's own deparsed form:

```sql
select policyname, cmd, permissive, roles::text, qual, with_check
  from pg_policies
 where schemaname = 'storage' and tablename = 'objects'
   and policyname in ('post_media_storage_memories_stories_insert',
                      'post_media_memories_stories_delete')
 order by policyname;
```

3. Diff `qual` and `with_check` against the production bodies recorded above.
   **They must match character for character.** A mismatch means the rollback
   would restore something subtly different from what was there — which is the
   whole failure this step exists to catch.
4. Drop both policies from the CI project again, leaving it as found:

```sql
DROP POLICY IF EXISTS "post_media_storage_memories_stories_insert" ON storage.objects;
DROP POLICY IF EXISTS "post_media_memories_stories_delete" ON storage.objects;
```

### Step C — apply the migration to production

Apply `src/migrations/20260815_close_memories_stories_grant.sql` through the
normal production migration path (`docs/production-migration-runbook.md`).

### Step D — prove the grant is gone (after)

Re-run the Step A command. Expect **exit 1**, reporting:

```
❌ policy post_media_storage_memories_stories_insert is NOT present live.
❌ policy post_media_memories_stories_delete is NOT present live.
```

That inversion — exit 0 with bodies before, exit 1 with both absent after — is
the red-proof. Its positive control is Step A itself: the same instrument, same
run, demonstrably able to see the policies when they exist. An absence assertion
that never showed it could detect presence is the vacuity the packet warns
about, and Step A is what rules it out.

Record both outputs against this document when done.

## What this evidence does not establish

- **Whether the DELETE policy backs a live user-facing delete.** The packet's
  D3B depends on that trace and it has not been done. Step 01 drops the DELETE
  alongside the INSERT because both are scoped to the same two unused prefixes
  and zero objects exist under them — so no live delete can be operating there.
  That reasoning does **not** extend to the owner-prefix policies, which D3B
  covers and Step 01 leaves alone.
- **Whether any of the 35 objects carries GPS.** Still unmeasured;
  `auditStorageExif` refuses production by design.
