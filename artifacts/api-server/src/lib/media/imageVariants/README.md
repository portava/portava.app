# Image variants: independent-worker handoff

Main app only. Default OFF. No schema, shared registry, upload, shared queue, package, or flag changes in this lane. The integration adds an unmounted protected route factory and production build outputs; the parent owns shared wiring.

## Audit: already built versus missing

- `lib/mediaProcessing.ts` already provides `processImage` (orientation, metadata stripping, 4096px ceiling), JPEG thumbnail 400px, JPEG feed 1500px, and a 64-bit difference hash. This handler reuses all four; that hash is a near-duplicate aid, not a visual embedding.
- `routes/posts.ts:storeVerifiedMediaUpload` performs those operations before storing the canonical source. Resumable message uploads reuse it. `routes/postcards.ts` completion downloads, normalizes, replaces the upload and builds its feed JPEG. `routes/profile.ts` normalizes profile images. Existing security normalization remains unchanged.
- The old `mediaProcessingWorker.ts` is an in-app measurement/retry timer. It decodes stored images but discards the normalized result; it does not publish a responsive WebP/AVIF ladder. Do not describe it as the independent derivative worker.
- Upload originals are not proven quarantined from owner reads. Moving security stripping out of those requests would create a disclosure interval. This lane moves only the NEW responsive work to the shared independent worker; it does not remove existing synchronous thumbnail/feed work or claim all upload CPU is offloaded.

## Factories and parent integration

`createImageVariantsRuntime(sc, config, { queue, fetch?, metric? })` returns:

- `handler`: shared3980-compatible `{ kind: "image_variants", modelVersion: "sharp-responsive-v1", timeoutMs: 120000, handle(context), discard(context, output) }`.
- `enqueue(source, signal?)`: calls the injected shared `createMediaJobQueue(sc)` only. No image decoding in this call. `source` is `{assetId, ownerUserId, sourceVersion, bucket, path, sizeBytes}`. Use the generation and identity owned by upload after its moderation CAS, not a freshly rebased version. Requires `ready`, active/approved moderation, active owner, exact canonical identity and private `post-media` owner path. Missing/held/stale sources refuse.
- `readFile(viewerId, source, filename)`: returns `{bytes, mime}` or null, never a public storage URL. The authenticated product/relay adapter must resolve the exact canonical source server-side, not trust body actor/path fields. Requires queue `media_derivative_ready`, same pipeline/source/lease result, file hash and fresh canonical/owner/viewer/shared media authorization before and after disk read. Canonical visibility additionally narrows access. Context-dependent canonical `trip_crew`/`shared_moment` is conservatively unavailable to nonowners until the parent supplies an entity/context-aware adapter; no audience guessing.
- `eraseSource(source)`: called by lifecycle purge AFTER canonical tombstoning, BEFORE row removal; pass that tombstone's exact current source identity/version. Persists a derivative tombstone, calls shared `media_derivative_cancel_asset`, serializes against private file writes, then removes ALL derivative generations for only this asset. Throws on any unconfirmed cancellation or disk failure. Works with processing flags OFF. Never deletes, replaces or touches the source storage object. Retry with the same identity after failures. Do not mark purge complete before this returns.

`createImageVariantsJobHandler(sc, config, options?)` independently returns just the handler. The structural context is the parent's `MediaJobContext`; no generic queue/scheduler is duplicated.

`imageVariantsConfigFromEnv(env)` reads `MEDIA_IMAGE_VARIANTS_ENABLED === "1"`, `MEDIA_IMAGE_VARIANTS_ROOT`, `SUPABASE_URL`. Additionally requires fresh DB `media_canonical_enabled` and `media_derivative_jobs_enabled`. No flag was activated. A dedicated absolute root whose parent exists is required; it must be empty/unmarked or have this feature's valid marker. Root/directories are 0700, files 0600. Never put it under public/static serving.

Parent wiring still required:

1. Supply the shared queue to the upload-owned post-moderation enqueue hook; do not add another upload pipeline or enqueue raw unmoderated bytes. Existing JPEG fallback remains usable while queued/unconfigured/failed. Only post-media images are supported, not profile-media, encrypted payloads, SVG, HEIC or animations.
2. Register handler in the ONE independent derivative entrypoint, concurrency **1 per handler**, lease 180s recommended. The parent owns retries/backoff/deadletter, renewal and cancellation. Errors currently use the queue's bounded generic retry policy (not a new typed-error class or scheduler).
3. `build.mjs` now emits `dist/runMediaDerivativeWorker.mjs` and separate `dist/encoderChild.js`; `imageVariantsConfigFromEnv` automatically resolves the child beside the source or bundle. Existing Sharp must remain available at runtime; no dependency was added. Built OFF-worker startup and actual built-child synthetic encoding are tested, not deployment or live processing.
4. Mount `createMediaImageVariantsRouter()` from `routes/mediaImageVariants.ts` in the existing `/api` router. `GET /api/media/image-variants/source?source=<encoded-original-reference>` resolves an exact canonical image; `GET /api/media/image-variants/:assetId/:generation/descriptor` pins a known generation. The ready descriptor contains measured dimensions/MIME/bytes and relative authenticated file URLs, never private paths, lease tokens or signed originals. The relay delegates to the existing authorized `readFile`, uses private/no-store and nosniff, and returns no redirects or public filesystem paths. No product selector or shared registry was edited here.
5. Wire purge `eraseSource` before original deletion/canonical row removal and await/propagate errors. API reader and worker must share the same dedicated private persistent volume. All deployments holding a replica must participate in erasure; multi-host fanout is not implemented here.

## Pipeline and bounded artifacts

Production acquisition signs the exact canonical owner path for 15s, pins configured HTTPS origin plus exact path, rejects redirects/extra signing parameters/MIME/encoding changes, streams at most the exact recorded size (8 MiB ceiling), and rechecks lease/generation. No ambient provider export, model, credentials or paid service.

Heavy work runs in a separate local child process of the independent worker, not an API request. The child gets no inherited service credentials/environment. Sharp concurrency=1/cache=false; 16,777,216 input pixels, single frame JPEG/PNG/WebP only; serial encoding; 90s hard kill, bounded stdout; handler deadline 120s. Native helpers need no weakening to become cancellable because process termination provides the boundary.

Eight outputs: `thumb.jpg`, `feed.jpg`, and `image-{320,800,1600}.{webp,avif}`. No enlargement. WebP quality82/effort3; AVIF quality50/effort2; existing JPEG helpers unchanged. Metadata strips by reencoding; SHA256 for source and every output; difference hash on normalized source. Maximum 8MiB/file, 24MiB/job. Manifest carries measured dimensions, MIME, byte lengths and hashes, source identity, pipeline and lease token; no signed URL, caption, coordinates or original EXIF. Queue result is comfortably below its 60KB cap.

Files are private until the parent finishes the same lease transaction. Files are fsynced before return; DB completion is the only publication authority. An ambiguous parent finish must retain artifacts rather than falsely discard them. `discard` validates exact source and lease token; another attempt's output is never removed. The image artifact helper is feature-specific: adaptive's helper accepts only HLS/TS/preview filenames and video types, so importing it for images would require unrelated shared changes.

There is no AI/intelligence consent grant inferred here: these are on-platform renditions of an already accepted, readable canonical upload, under its current audience and deletion rules. No raw E2EE or external export path is introduced.

## Evidence and limits

Focused tests generate actual synthetic Sharp JPEG/PNG/WebP/AVIF, decode every output, check orientation, transparent output, metadata stripping, dimensions, stable hashes, original immutability, child cancellation, and private disk publication/revocation/erasure. Runtime DB/auth/storage responses are injected in-memory, not live proofs. The always-registered worker test directly imports the shared `jobs/worker.js`; its queue transport is stateful in-memory, not SQL/concurrency proof. Route tests exercise the real Express handler and actual file reader. The build test rebuilds the production artifacts before testing, requires no model or credentials, and never silently skips.

Run serially from `artifacts/api-server`:

```sh
node --import tsx/esm --test --test-concurrency=1 src/test/mediaImageVariantsEncoder.test.ts src/test/mediaImageVariantsRuntime.test.ts src/test/mediaImageVariantsWorker.test.ts src/test/mediaImageVariantsRoute.test.ts src/test/mediaImageVariantsBuild.test.ts
IMAGE_VARIANTS_MUTATION=generation node --import tsx/esm --import ./src/test/helpers/imageVariantsMutation.mjs --test --test-name-pattern='source generation and exact' src/test/mediaImageVariantsRuntime.test.ts
IMAGE_VARIANTS_MUTATION=publication node --import tsx/esm --import ./src/test/helpers/imageVariantsMutation.mjs --test --test-name-pattern='read rechecks queue publication' src/test/mediaImageVariantsRuntime.test.ts
```

The configured `createConfiguredImageVariants(sc, env?)` bridge returns null while OFF, otherwise `{handler, enqueue, readFile, eraseSource, service}` using the existing shared queue. Enqueue only the source snapshot owned by the successful moderation CAS. GET routes never enqueue or encode. Pending publication returns `{state:"original",reason:"not_ready",assetId,sourceVersion,variants:[]}`; typed `not_found`, `feature_disabled`, and retryable `degraded_unavailable` errors must preserve the client's already-authorized original fallback, not mint another URL or widen access. Client integration must resolve relative derivative URLs only against the trusted API origin and include its existing authenticated transport; plain unauthenticated image URLs will not work.

Build assets: `dist/transcribe.py`, `dist/runtime/media-vision/{worker.py,model-manifest.json}`, `dist/runtime/media-visual-index/clip_worker.py`, and `dist/runtime/translation-runtime.py`. The build narrowly relocates the vision worker import-meta URL without modifying its source. Set `MEDIA_VISUAL_WORKER` to the absolute bundled CLIP script path when separately approved; its model-lock/runtime configuration is still required. No model, Python packages, FFmpeg, Piper or credentials are packaged or downloaded. Copied scripts are not runtime/model-quality proof.

Erasure/orphans: the reader and worker require the same dedicated private volume. Preserve the root marker and durable `revoked/<assetId>` tombstones. Purge must await `eraseSource` before removing canonical/source authority and propagate failure, even with flags OFF. Crash leftovers are under `assets/<assetId>/<sourceVersion>/<leaseToken>`; an orphan reconciler must consult exact shared queue publication/lease state and preserve live, published, or uncertain-completion leases. Never steal `locks/<assetId>` without independently proving the writer has ended, never infer expiry from directory mtime alone, and never remove originals. Multi-host erasure, quotas and image-orphan reconciliation remain integration/operations gates; the adaptive janitor must not be assumed to cover these image paths.

Mutations must exit nonzero on resulting-state assertions; they change in-memory modules only. Logs/report outside the repository distinguish native-codec proof from synthetic transports.

Remaining operational limits: no live storage/DB/deployed worker proof; no multi-session SQL proof; no load/quality/device/production scalability claim. Hard-kill/native crash can leave unservable per-lease files or a short-write asset lock. Source purge erases stale files; stale crash locks require reviewed operator recovery (no unsafe automatic lock stealing). A disk-quota/orphan-retention sweeper and multi-host persistent storage topology remain parent infrastructure work. Job metrics report measured elapsed time/input/output bytes; 8MiB/16MP/90s are ceilings, not measured capacity or dollar cost estimates. Flags stay OFF until those integration/operations decisions are reviewed.

References: [Sharp output metadata and formats](https://sharp.pixelplumbing.com/api-output/), [Sharp rotation](https://sharp.pixelplumbing.com/api-operation/), [Supabase signed storage URLs](https://supabase.com/docs/reference/javascript/storage-from-createsignedurl). The Supabase changelog Markdown fetch was attempted but the documentation fetcher rejected its content type; no new Supabase API or schema is introduced.
