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

## What this evidence does not establish

- **Whether the DELETE policy backs a live user-facing delete.** The packet's
  D3B depends on that trace and it has not been done. Step 01 drops the DELETE
  alongside the INSERT because both are scoped to the same two unused prefixes
  and zero objects exist under them — so no live delete can be operating there.
  That reasoning does **not** extend to the owner-prefix policies, which D3B
  covers and Step 01 leaves alone.
- **Whether any of the 35 objects carries GPS.** Still unmeasured;
  `auditStorageExif` refuses production by design.
