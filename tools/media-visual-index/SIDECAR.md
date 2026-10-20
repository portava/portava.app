# Authenticated consent and private image acquisition delta

This additive sidecar does not mount routes, register providers, activate flags, change schema or install/download a model. Parent owns integration. The only changed pre-existing lane code file is `visualIndexJobHandler.ts`; all other sidecar code/tests are new.

## Route factory

Mount `createMediaVisualIndexRouter(env)` from `routes/mediaVisualIndex.ts` under the existing `/api` router. It defines:

- `POST /media/visual-index/:assetId/consent`: strict body `{sourceVersion,scope:"media_visual_index",expiresAt}`. Explicit absolute UTC expiry must be future and at most 30 days away. Requires the existing `requireUser` verified token/account gate, valid owner UUID, exact own canonical generation, owner-prefixed storage and an active owner profile. Caller identity comes only from `auth.user.id`; body actor/owner fields are rejected, never trusted. This calls the existing 3982 consent RPC, then the existing image provider's durable enqueue path. `202 {accepted:true,state:"queued",assetId,sourceVersion}` means queue acceptance, not completed inference.
- `POST /media/visual-index/:assetId/enqueue`: strict body `{sourceVersion}`. Same ownership/generation/gates, plus a current unrevoked grant. Retry this endpoint after queue uncertainty; it preserves the consent revision and the parent's queue idempotency key. Reposting `/consent` intentionally refreshes the consent revision; it is not an idempotent retry endpoint.
- `DELETE /media/visual-index/:assetId/consent`: strict body `{sourceVersion}`. Authenticated exact asset owner only. Works when feature flags/env are OFF and media is held/deleted, without requiring ready/public media or signing/downloading anything. It uses the existing revocation RPC, verifies no live grant and no vector row remain, then returns 204. Unknown write/read results are 503, never completed revocation. It never deletes shared source bytes. Existing ban/session restrictions remain enforced by `requireUser`.

Grants/enqueue require `MEDIA_VISUAL_INDEX_ENABLED=1`, `media_vision_provider_enabled=true` and `media_derivative_jobs_enabled=true`; missing/failed flag reads cannot authorize work. Twenty grant/enqueue attempts per user per minute use the existing limiter; durable queue limits still belong to parent. Responses use `Cache-Control: private, no-store`.

Grant and enqueue are **two existing RPC transactions**, not a fabricated atomic operation. If consent is acknowledged but queue acceptance is uncertain, response is 503 with `{consentGranted:true,queued:null,state:"queue_unconfirmed",retryable:true}`. The job may already exist; retry `/enqueue` with the same source version. No rollback can erase a concurrently renewed grant. Existing index commit and publication CAS continue to require the exact current grant revision, generation and queue lease.

## Production worker acquisition

`createVisualIndexJobHandler({sc,env})` now supplies `createCanonicalVisualImageAcquirer({sc,env})` by default. No test-only acquisition injection is required. It remains an independent-background-worker factory; routes never call acquisition or inference. Optional `{fetch}` is a transport test seam; `{acquireImage}` remains a trusted composition override for a future shared implementation.

The helper re-reads exact canonical ID/version/owner/bucket/path/size/MIME, active owner state, fresh gates and unchanged consent revision before signing, before download, after download and after decode. It requires an existing active profile in addition to the shared account gate: that gate deliberately allows a missing profile for some API flows, which is not authorization to process retained media.

Only owner-prefixed, nonempty ASCII key segments in `post-media` are accepted; no traversal, percent-encoded path components, alternate bucket or client URL. `SUPABASE_URL` must be the configured HTTPS `*.supabase.co` origin with no nonstandard port/path/credentials. Custom/self-hosted storage origins are not silently allowed by this sidecar.

The helper creates a 15-second private signed URL for the exact canonical key, verifies exact origin/path and a single nonempty token, and rejects credentials, fragments, query extras and redirects. It requests `redirect:error`, `credentials:omit`, `Cache-Control:no-store`, and identity content encoding. It accepts only status 200 and an exact canonical MIME. A declared length must equal canonical size; streamed bytes must also equal it, bounded at 8 MiB. A 15-second overall deadline and abort signal bound acquisition; already-issued SDK signing/read calls may finish after the caller stops waiting, but no later download/decode proceeds after cancellation.

Actual Sharp decoding validates sniffed JPEG/PNG/WebP, a single frame, at most 16,777,216 source pixels and a 3-second native processing timeout. A small decoded buffer is discarded; **original downloaded bytes are returned unchanged**, preserving this lane's exact-size check, content digest and pinned CLIP preprocessing. No user media is written to disk or exported to an inference provider.

Galileo's `imageUnderstandingPixels.ts` was inspected. It produces a normalized, metadata-free JPEG and reports the original byte count separately. Direct reuse would break this lane's original-byte size/digest contract and change preprocessing/model identity; its separate policy/attachment authority is not this feature's consent. This sidecar therefore implements a compatible original-byte reader rather than weakening either contract. Parent may later extract a shared bounded transport primitive while preserving each feature's authorization and transformation contract.

Text cache misses remain refused pending the parent's viewer-bound query bridge. No fake asset, extra scheduler, model download, public bucket assumption, storage mutation or shared registry edit is introduced.

## Focused verification

From `artifacts/api-server`, run serially:

```
node --import tsx/esm --test --test-concurrency=1 src/test/mediaVisualIndex.test.ts src/test/mediaVisualCanonical.test.ts src/test/mediaVisualIndexRoute.test.ts src/test/mediaVisualImageAcquisition.test.ts
```

The route suite runs the real Express router, JSON body parser and `requireUser` against Node IncomingMessage/ServerResponse objects in memory, with a fetch-failure sentinel and synthetic auth/storage/DB state. It does not verify hosted Auth/PostgREST. The acquisition suite executes the installed Sharp decoder against generated PNG/JPEG/WebP and injects signed responses/byte streams; it does not contact Supabase. The handler test uses a synthetic encoder and does not prove CLIP quality.

`VISUAL_SIDECAR_MUTATION=owner` or `origin`, with `--import ../../tools/media-visual-index/mutate_sidecar.mjs`, removes one guard in memory and must turn its behavioral test red. No source/checker is weakened.

API references checked: [Supabase signed URLs](https://supabase.com/docs/reference/javascript/storage-from-createsignedurl), [Sharp constructor limits](https://sharp.pixelplumbing.com/api-constructor/), [Sharp timeout/output](https://sharp.pixelplumbing.com/api-output/). Actual decoder behavior is also tested locally. The Supabase Markdown changelog fetch was unavailable in this environment; no current hosted-schema claim is derived from it.
