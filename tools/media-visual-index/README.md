# MD293 — inactive self-hosted visual index

This lane implements CLIP pixel embeddings, an existing-Postgres pgvector store, image-to-image search, and a background text-to-image encoder/search contract. It does not enable the product, export photographs, infer facts about places, or replace the shared derivative queue.

## Integration

- `createLocalVisualIndexProvider({sc, env}, options?)`: `local-clip-index`, `{sceneSignals:false, similarMedia:true, ingest:true}`. Compose with the separate scene provider; do not replace it. API ingest validates the exact upload-owned `sourceVersion`, bucket/path and canonical state, then calls the parent's `media_derivative_enqueue` with `kind=embedding`. It does **not** encode pixels.
- `createVisualIndexJobHandler({sc, env}, {acquireImage})`: the parent's `MediaJobHandler` structural contract (`kind`, `modelVersion`, `timeoutMs`, `handle`, `discard`). Register in the **independent** shared worker, never the API startup loop. The handler accepts `MediaJobContext`, calls `isCurrent()` before/after expensive work, and passes job ID/token to the atomic index commit. Use initial concurrency **1**; larger limits require measured memory/throughput proof.
- `acquireImage(source, {signal,maxBytes,maxPixels})`: parent/Galileo owns this shared acquisition implementation. It must retrieve the authorized canonical storage object, not a client URL, honor cancellation and the 8 MiB streaming/16,777,216-pixel ceilings, and preserve the original. This lane accepts still PNG/JPEG/WebP only; it does not guess video posters. Bytes travel over a local child-process pipe, never a hosted inference API or a media file on disk.
- Grant/revoke explicit owner consent through service-only `media_visual_index_consent(asset, authenticatedActor, exactVersion, allowed, expiry)`. No grants are seeded. A feature flag or provider selection is **not** consent. The parent must supply an authenticated consent surface or another reviewed consent authority. New consent revisions invalidate earlier jobs/vectors. Retention is at most 30 days and cannot exceed consent expiry.
- Search must pass its authenticated `viewerId`. The seed `storageKey` is intentionally ignored: the existing projection supplies a URL, not an authoritative storage key. Canonical attachments and exact legacy storage-path/public-URL matches map assets to post IDs. The shared eligible search projection, attachment override, source visibility and context guard authorize the actual projected primary image for every seed/candidate. No asset ID is guessed from a post ID.
- Result label: **visually similar**, not verified place evidence. `score = 1 - cosine_distance / 2` is an ordering value, **not calibrated confidence**, probability, or quality percentage. Parent presentation must not convert it to an accuracy claim.
- `eraseVisualIndexAsset(sc, {assetId,sourceVersion,bucket,path}): Promise<void>` must be awaited by `MediaLifecycleService` **after authorization revocation and before purge completion**. It throws on missing/mismatched source or failed cleanup, deletes embeddings/consent, and records a minimal asset-ID tombstone. It never deletes source storage bytes. Account deletion must invoke the same hook before removing canonical rows. A narrower per-lease discard RPC cannot erase another lease's replacement.
- Schedule `media_visual_index_sweep` from the shared maintenance worker. Reads refuse expired entries even before sweep. Source generation/state changes synchronously invalidate vectors through a trigger; consent change/delete also invalidates. Backups, replicas, retained WAL and tombstone lifetime still need an operator retention/erasure policy. SQL row deletion is not proof of physical backup erasure.

## Text-to-image boundary

`provider.textSearch({viewerId,text,language,limit})` only queues or reads a viewer-bound cached result. `handleVisualIndexJob` has an actual CLIP text-encoder branch; its normalized text vector searches the **pixel** index in the same CLIP space. The cache key includes viewer, exact query, language and pinned model. Query/result TTL is five minutes; no plaintext query is logged.

Only explicitly labelled English queries are accepted by this model contract, with a 512-character/77-token ceiling. This is not multilingual validation or language-quality proof. No other language is silently translated or labelled supported.

The parent's current queue requires `asset_id NOT NULL` and an asset generation. A free-text query has neither. Until parent supplies a viewer-bound query variant and durable `enqueue`/`readTextResult` bindings, the default text-search factory returns `refused`; **do not create a fake asset or another queue**. This is a specific integration blocker, not a claim that text search is production-complete.

## Store choice and migration

The checkout had no pgvector extension or vector column to reuse, only documented proposals. Parent's read-only production metadata check also found **no installed vector extension** (nor pgmq/pg_cron); this lane does not claim otherwise. The existing Postgres database remains the target; there is no SQLite, Redis, paid vector service or additional database. Exact additional extension dependency: **pgvector (`vector`), with HNSW, `vector(512)`, `vector_norm`, `vector_dims` and cosine `<=>` support**, installed in schema `extensions`. Migration `3982_media_visual_index.sql` creates that extension, service-only/RLS tables, a cosine HNSW index and restricted RPCs. Extension/package availability and its reviewed version remain deployment preflight requirements. If pgvector already lives in another schema in a target environment, preflight/adapt that environment deliberately; this migration does not move an existing extension. No extension apply or activation is authorized.

The Supabase 2.121.0 CLI generated `20261015145310_media_visual_index.sql` in isolated external workdir `similarity-migration.NjyasE`; its generated name was adapted to parent-reserved canonical slot **3982**. Depends on parent slot 3980; no live database apply was performed. SQL checks source identity, canonical state, consent revision, pinned model and current queue lease in one transaction. A vector is invisible until the parent queue successfully publishes a matching lease receipt. Index candidates are not an authorization oracle: RPC/table access is revoked from anon/authenticated; server reads still apply the viewer gates.

The HNSW index is only an index definition, not a scale benchmark. Search caps proposals at 200 and authorized results at 60, so denied neighbors can reduce recall. There is no claimed full-corpus recall, ANN quality, multi-process concurrency benchmark, Supabase deployment proof or recovery/backup-erasure proof.

The schema uses PostgreSQL 15+ security-invoker views. Review a current provider-supported pgvector package before deployment: upstream [0.8.2 release notes](https://github.com/pgvector/pgvector/blob/v0.8.2/CHANGELOG.md) include a parallel-HNSW-build buffer-overflow fix. An older bundled PGlite extension passing isolated tests is not approval to deploy that older version. The harness reports its actual embedded PostgreSQL/pgvector versions; it is not a standalone PostgreSQL server and supplies no multi-session server proof.

## Model and runtime

Pinned model: `openai/clip-vit-base-patch32`, revision `d44250afa9f05af7eca021052567539406661018`, 512 dimensions, image/text projection heads, RGB 224 preprocessing. The model ID includes the checkpoint revision and preprocessing contract. No pHash or generic text embedding substitutes for image vectors.

Upstream [CLIP MIT license](https://github.com/openai/CLIP/blob/main/LICENSE) permits commercial use under its notice terms; retain upstream notices with any distributed model/runtime. The [model card](https://huggingface.co/openai/clip-vit-base-patch32) nevertheless warns against unvalidated deployment and limits evaluated language use to English. License permission does not establish product suitability, training-data clearance, accuracy, fairness or owner consent. Those activation holds remain.

Runtime direct dependency candidate pins are in `requirements.txt`: Python 3.12, torch 2.6.0, transformers 4.57.1, safetensors 0.6.2, Pillow 12.3.0, NumPy 2.3.5. They were **not installed or compatibility-validated** here; a reviewed platform-specific transitive lock/security review is still required. The existing runtime supplies only NumPy/Pillow. Do not install into shared `node_modules` or the bundled runtime.

Provisioning is a separate, explicit operator action, not an API/worker side effect. `prepare_model.py --output <new-private-directory>` downloads only seven fixed public files from the pinned model revision and produces a SHA-256 file manifest. Review/store the emitted manifest digest separately as `MEDIA_VISUAL_MODEL_LOCK_SHA256`; the worker requires that digest, hashes every artifact, refuses symlinks, uses safetensors only, disables remote code and sets both HF/Transformers offline mode. It loads only from the approved local directory. Artifact provenance is pinned HTTPS revision plus a separately trusted digest, not an unsigned arbitrary model-directory name.

Settings, all required before worker use:

```
MEDIA_VISUAL_INDEX_ENABLED=1
MEDIA_VISUAL_PYTHON=/absolute/path/to/isolated/python3
MEDIA_VISUAL_WORKER=/absolute/checkout/tools/media-visual-index/clip_worker.py
MEDIA_VISUAL_MODEL_DIR=/absolute/private/pinned-model-directory
MEDIA_VISUAL_MODEL_LOCK_SHA256=<reviewed 64-character lowercase digest>
```

These are names/examples, not activation instructions. Missing vendor/queue flags are false, not permission to create or activate them. Parent reports `media_canonical_enabled=false` and private `post-media`/`profile-media` buckets; no public bucket or object URL fetch is assumed. Keep all feature gates off until owner/privacy/runtime/deployment checks are independently accepted. Python receives an allowlisted environment without application credentials. Parent enforces worker concurrency/lease/retry/dead-letter policy; child execution is CPU-only, one Torch thread, bounded output and a 90-second kill timeout. Model load/verification occurs per subprocess; warm model reuse must be coordinated with the vision worker rather than introducing a second daemon.

## Evidence commands

Run focused Node tests serially from `artifacts/api-server`:

```
node --import tsx/esm --test --test-concurrency=1 src/test/mediaVisualIndex.test.ts src/test/mediaVisualCanonical.test.ts
```

Run actual embedded Postgres/pgvector tests using **existing**, read-only PGlite dependencies:

```
PGLITE_ROOT=/absolute/existing/@electric-sql/pglite MEDIA_QUEUE_MIGRATION=/absolute/parent/3980_media_derivative_jobs.sql node --test tools/media-visual-index/test_postgres.mjs
```

Explicit `VISUAL_QUEUE_FIXTURE=1` tests this lane's real SQL against a minimal queue fixture, **not** parent integration. The harness creates and removes its own on-disk fixture DB and verifies state after reopen. `VISUAL_SQL_MUTATION=lease` or `generation` removes one guard in memory; each must make the suite red. Neither mutates source files or the parent's migration.

After an approved offline runtime/model exists, `python -B tools/media-visual-index/prove_model.py --model-dir ... --lock-sha256 ...` encodes synthetic red-circle/blue-square pixels and a text query using the real model. It asserts dimensions, unit norm, distinct image vectors and a simple cross-modal ranking. It is not a benchmark for travel/place similarity or multilingual performance. No such model proof has been obtained in this checkout.

Telemetry returned to the parent: actual input bytes, wall elapsed time and vector payload bytes (512 × float32 = 2048 bytes, excluding DB/HNSW overhead). No inference price is claimed; self-host CPU/RAM cost must be measured. Retry counts, lease losses, dead-letter age and cleanup failures belong to the shared worker health stream. Never log source bytes, storage URLs, embeddings or raw query text.
