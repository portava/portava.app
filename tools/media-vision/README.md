# Main-app image understanding (disabled integration)

This is the local inference subprocess for the **existing shared media derivative worker**, not another queue, HTTP inference service, app-process inference loop or deployment. It performs actual SigLIP tensor inference over decoded pixels. No model/runtime is installed or downloaded by this patch.

## Model and predictions

- Model: `google/siglip-base-patch16-224`, immutable revision `7fd15f0689c79d79e38b1c2e2e2370a7bf2761ed`; model card declares Apache-2.0. `model-manifest.json` pins safetensors/config/tokenizer bytes to public repository hashes. No pickle weights, remote code, automatic download, credentials or arbitrary prompts.
- Taxonomy: `travel-scene-v1`. Nineteen fixed English prompts: five crowd/abstention prompts and fourteen travel tags: beach, ocean, mountain, architecture, food, sunset, forest, snow, desert, waterfall, lake, garden, boat, market. Travel output is at most six candidates above an uncalibrated similarity score of 0.5. This threshold is **not validated recognition accuracy**.
- Metadata includes model ID/revision, taxonomy, inference duration, processing time, source generation, and confidence explicitly labeled `uncalibrated_similarity`. Candidates are `verified=false`, `eligibleAsObservation=false`. No intel observations, location/city/country/landmark identification, face recognition, sensitive-attribute inference, caption-derived evidence, or conversation/call analysis.
- Images: canonical owned JPEG/PNG/WebP, maximum 8 MiB / 16M pixels, re-encoded without metadata to JPEG at most 1024px / 2 MiB. Video: only its canonical stored poster, explicitly labeled `stored_poster`; no claim of full-video understanding or verified frame provenance.

## Parent integration

API factory: `createImageUnderstandingProvider({sc, env})`, name `self_hosted_siglip`. `ingest` queues the exact supplied source generation; `sceneSignals` reads only own-viewer completed artifacts. Parent composes it with the separate index capability; do not replace one provider with the other.

Shared acquisition export for the similarity lane: `readImageUnderstandingStorageBytes({sc,origin,path,mime,signal,expectedBytes,beforeRead})` returns **original bounded bytes**, not vision's normalized JPEG. Parent must supply the index lane's canonical-source/owner/viewer/feature-consent validator as mandatory `beforeRead` (called before signing and immediately before GET), exact canonical byte count, and zero the returned buffer after use. The index's decoder still enforces its own pixel/frame limits. No vision-consent grant is a substitute for index consent. This shares the same fixed-origin signed-object/stream/SSRF path; no second fetch pipeline is needed. `acquireImageUnderstandingPixels` layers native normalization on this same primitive for vision only.

Background factory:

```ts
createImageUnderstandingJobHandler({
  sc,
  env,
  createJobError: (code, retryable) => new MediaJobError(code, retryable),
});
```

It returns the parent's `kind`, `modelVersion`, `timeoutMs`, `handle(context)` and `discard(context, output)` shape, plus `close()` for shutdown. Queue kind is `vision`, model version `google/siglip-base-patch16-224@7fd15f0689c79d79e38b1c2e2e2370a7bf2761ed/travel-scene-v1`. Initial concurrency is one; the loaded Python model is reused serially. Parent owns persistent enqueue/claim/retry/backoff/deadletter/renewal/cancellation/health and the independent worker entrypoint.

Migration 3981 depends on parent migration 3980. It stores feature consent and artifact bindings only. A feature enqueue transaction invokes the **same** generic enqueue function. `revision_key` is SHA256 of the stable asset/generation/model/taxonomy/policy/attachment key. Do not enqueue vision directly without this binding.

`handle` stages artifacts only under a valid generation/consent/lease CAS. It returns `{result:{artifactKey,publicationToken},inputBytes,outputBytes}`. Parent finishes the generic job; artifact reads require the completed state and exact matching output token. Failed/retried/cancelled jobs cannot expose staged artifacts. `discard` erases only its own lease. A lost/ambiguous finish must retain staging until parent reconciliation; a caller must not unconditionally discard on a network timeout after a possibly committed finish. Two parameterless, tightly scoped definer triggers allow normal source privacy edits to erase service-only derivatives without granting clients artifact access. All RPCs are invoker/service-role-only.

Mount the **unregistered** `createMediaImageUnderstandingRouter(env)` under the app's `/api` prefix after parent review. It provides:

- `POST /media/image-understanding/:postMediaId/consent`: authenticated, own selected attachment only; strict `{sourceVersion,policyVersion,scope:"media_image_understanding"}`; returns 202 queue acceptance, not completed recognition. No URLs, source paths, owner identities, prompts or flags accepted from the client.
- `DELETE /media/image-understanding/:postMediaId/consent`: revoke own attachment consent, even when processing flags are OFF. Revocation erases artifacts and cancels vision jobs. No source bytes are deleted. Consent cannot silently be reactivated for the same policy/generation after revocation; a new reviewed policy or generation is required.
- `GET /media/image-understanding/:postMediaId`: authenticated own-viewer platform metadata; completed artifacts only, current consent/source checked before and after read, private/no-store. Returns generic travel candidates/model metadata and explicit unsupported exact-recognition categories, not storage URLs, raw paths, embeddings or facts.

Cache lifetime is tied to source/model/taxonomy/policy generation, not a timer that would strand a completed idempotent job. Source generation/owner/key/state/deletion/purge, attachment/post privacy state, consent revocation or account restriction invalidate the feature binding and candidates. No audience is widened. Other owners' artifacts are not available in this first implementation. Retain all D25 and media deletion policy holds.

## Gates and runtime prerequisites (not activated)

Both DB flags `media_vision_provider_enabled` and `media_derivative_jobs_enabled` must permit processing. Additionally require `MEDIA_IMAGE_UNDERSTANDING_ENABLED=true`, `MEDIA_IMAGE_UNDERSTANDING_PROVIDER=self_hosted_siglip`, an exact owner UUID allowlist in `MEDIA_IMAGE_UNDERSTANDING_ALLOWED_OWNER_IDS`, and the explicitly reviewed `MEDIA_IMAGE_UNDERSTANDING_APPROVED_POLICY`. No env defaults enable processing. Granting feature-specific consent is separate from these operator controls; no external-media/provider consent is inferred.

The independent worker needs absolute `MEDIA_VISION_PYTHON` and `MEDIA_VISION_MODEL_DIR` paths. Provision a separately audited/pinned Python environment with PyTorch, Transformers (SiglipModel/SiglipProcessor), Pillow, tokenizers and safetensors; approved matching model files must already be present. Do not install through repository dependency symlinks. Run model loading/inference with egress disabled and deployment CPU/memory/process limits. Python disables remote-code/model download paths and receives no app credentials. The TS supervisor enforces a 90-second job timeout and kills inference on cancellation; the native decoder has its own timeout. The model is about 813 MB of weights; real peak memory, latency, cost and capacity are **not measured**.

`worker.py` accepts bounded JSONL with only protocol/version/taxonomy and base64 JPEG pixels; stdout is a bounded strict result. Errors are sanitized. No media is written to disk or analytics. Normalized Node buffers are zeroed after use; no claim is made of physical allocator/GPU/OS memory erasure. Deployment sandbox/resource policy and model/library supply-chain approval remain integration prerequisites.

## Offline validation

From `artifacts/api-server`, run the focused Node test with existing read-only dependencies:

```sh
SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test --test-concurrency=1 src/test/imageUnderstanding.test.ts
```

From repository root:

```sh
/usr/bin/python3 -I -B tools/media-vision/test_worker.py
MEDIA_VISION_PGLITE_MODULE=/absolute/read-only/pglite/dist/index.js MEDIA_QUEUE_MIGRATION=/absolute/3980_media_derivative_jobs.sql node --test --test-concurrency=1 tools/media-vision/test-artifacts.mjs
```

PGlite executes the real feature/shared queue SQL against a synthetic in-memory fixture, not a live/shared DB. Node tests execute real Sharp transforms, local HTTP and the actual Python refusal path; successful inference in orchestration tests uses explicit synthetic runner outputs. Python tests validate protocol and score-to-candidate formatting only. **None proves actual model inference success, language/recognition quality, hosted Supabase/RLS behavior, multiprocess contention or scalability.**

Primary docs: [pinned SigLIP model/license](https://huggingface.co/google/siglip-base-patch16-224/tree/7fd15f0689c79d79e38b1c2e2e2370a7bf2761ed), [SigLIP API](https://huggingface.co/docs/transformers/model_doc/siglip), [Supabase functions](https://supabase.com/docs/guides/database/functions), [PostgreSQL locking](https://www.postgresql.org/docs/current/explicit-locking.html). Managed OpenAI was investigated but deferred; no managed inference path is present.
