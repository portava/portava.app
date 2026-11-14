# Higgsfield image and video creation

Status: implemented in source; production database infrastructure applied on 2026-11-13 as hosted migration `20261113172636`. **API/client deployment and feature activation remain pending.** No paid generation, account-access test, visual-quality comparison or iPhone build has been performed. This does not establish A++ or 100% media readiness.

The post composer links to `/create-ai`. Users choose image/video, describe the scene, select an aspect ratio, consent to external processing, and create a private draft. Images use the Soul 2 text-to-image contract; videos use the Seedance 2.5 text-to-video contract (5 seconds, 720p, silent). Preview and “Open to save” require owner authorization and issue a 60-second private-storage link. Saving opens the platform/browser viewer; there is no automatic publication or direct insertion into a public post. Drafts expire after seven days.

This is a generation integration. It does not replace captions, image recognition, visual search, feed ranking, adaptive playback, or the transparent stamp-art provider. Existing generated entity covers also retain their provider. A generation API is not a transcription or recommendation API.

The no-polling guarantee here covers generation and the new provider-release workflow. Older app code still contains periodic reads (including caption access checks, notifications, live comments and trip/crew updates); those have not been converted by this change. Replacing access checks requires equivalent revocation events before removing their protection. No app-wide latency or polling-free claim has been established.

## Events, privacy and billing

1. The authenticated API reserves a job and an estimated rolling-day budget transactionally, before any provider request. The owner/client request ID deduplicates retries; an altered intent with the same ID is refused. Default estimated limits are $2 per owner and $10 globally. Failed/deleted attempts remain counted conservatively because charges/refunds cannot be inferred from local state.
2. The API pushes the job ID to a durable Redis/Valkey stream. The consumer blocks for events (`XREADGROUP BLOCK 0`); it does not scan for jobs periodically. It uses leases and the persisted job ID as the provider idempotency key. The exact provider model/input is retained for the accepted job across releases.
3. The submission includes an HTTPS callback. Higgsfield completion webhooks are verified against the **raw** body using its Standard Webhooks signature and five-minute timestamp tolerance. The request ID must match the stored receipt. Valid duplicate events are safe. The endpoint acknowledges only after durable database receipt and queue handoff; a receipt race or unavailable queue returns 503 for provider redelivery.
4. Completion triggers one download from an exact operator-reviewed CDN hostname. Credentials are never sent to that host. Redirects, oversized output and stalled bodies are refused. Images are decoded/normalized with metadata stripped. MP4 video is locally probed and remuxed with metadata, audio and non-video tracks removed. Outputs go only to the private bucket; the worker verifies bucket privacy before uploading.
5. The database broadcasts **only a job ID** on the owner's private channel when visible state changes. The client subscribes while active, reads once on connection/reconnection and coalesces notifications. It unsubscribes on background/session change and discards stale responses. There are no status-polling intervals. Manual Refresh remains available.
6. Provider data is explicitly deleted after the private copy is recorded. A three-hour provider retention header covers its documented two-hour webhook retry window; it is not an instant deletion guarantee during outages. Draft deletion hides the result immediately; if provider processing is underway, its completion event resumes deletion. An already issued signed URL can remain usable for at most 60 seconds.
7. One-shot expiry deadlines and startup/queue-reconnection reconciliation recover local work and remove expired drafts. Delivery failures retry with bounded backoff; exhausted delivery leaves the stream message pending and logs `media_generation_consumer_stopped` for operator restart/replay. This is error recovery, not status polling. Use durable AOF/no-eviction Redis 6.2+ or compatible Valkey; monitor the consumer and pending-message age. No Redis server was available locally for an actual stream integration/load test.

## Activation requirements

Canonical migration `4025_higgsfield_generation_jobs.sql` and its byte-identical Supabase mirror were applied to production project `ajrurzioarfkagpuxfnb` after the owner's activation approval. Hosted migration: `20261113172636`; SHA-256: `a46a6749662c8688c3ff7d739fea5f1ec57438f203ff49fc499de8cb27645be8`. Postconditions verified: job-table RLS enabled; anonymous/authenticated table and reservation access denied; service-role access granted; owner-channel receive isolation and client-send prohibition installed; the 80 MiB WebP/MP4 bucket is private. The canonical schema ledger records this receipt. The generation flag remains **false** pending the requirements below; no existing flags were changed. All 15 generation regression tests passed again before application.

Configure server secrets/settings (never client variables or chat):

- `HIGGSFIELD_CREDENTIALS`: API key ID and secret as `KEY_ID:KEY_SECRET`.
- `HIGGSFIELD_WEBHOOK_SECRET`: the `whsec_` secret revealed in the API account's Settings. Unsigned callbacks are refused.
- `HIGGSFIELD_WEBHOOK_BASE_URL`: the public API's HTTPS origin. The callback is `/api/media/generation/webhook/:jobId`.
- `HIGGSFIELD_OUTPUT_HOSTS`: exact verified output CDN hostnames, comma-separated. No wildcard default is assumed.
- `HIGGSFIELD_DATA_POLICY_REVIEWED=true`: only after enabling/checking account training exclusion and reviewing Higgsfield and ByteDance processing terms. This variable records operator configuration; it cannot verify the vendor's settings itself.
- `REDIS_URL`: durable event queue; do not reuse an evictable cache without checking persistence/eviction settings.
- `MEDIA_FFMPEG_BINARY`, `MEDIA_FFPROBE_BINARY`: trusted absolute paths for video validation.
- Optional budget overrides: `HIGGSFIELD_USER_DAILY_BUDGET_USD`, `HIGGSFIELD_DAILY_BUDGET_USD`.

Provision the migration/Realtime permissions, deploy API and client code, validate a real image and video, reconnect/redelivery, queue restart, private-account isolation and deletion, then enable the flag for the intended rollout. Actual account model availability, costs and visual quality remain unverified. Current public estimates used for reservations are $0.0057 per 1080p image and $1.3235 per 5-second 720p video; reconcile with the account's current rates before activation. The API has separate pay-per-generation billing from the consumer Higgsfield subscription.

## Verification and references

Automated coverage includes provider contracts, bounded transport, hostile response URLs, signature/timestamp/tampering checks, owner isolation, duplicate billing prevention, webhook wait behavior, real local PostgreSQL budget/lease/role checks, and client session/subscription behavior. Mocked provider tests are not evidence of real model quality.

Official references checked 2026-11-13: [API and billing](https://higgsfield.ai/creator-hub/help-center/integrations/what-is-the-higgsfield-api), [Soul 2](https://open.higgsfield.ai/models/higgsfield-ai/soul/v2/standard/api-reference), [Seedance 2.5](https://open.higgsfield.ai/models/bytedance/seedance-2.5/text-to-video/api-reference), [webhooks](https://docs.higgsfield.ai/docs/how-to/webhooks), [idempotency](https://docs.higgsfield.ai/docs/concepts/idempotency), [retention](https://docs.higgsfield.ai/docs/enterprise/data-retention), [training exclusion](https://docs.higgsfield.ai/docs/enterprise/model-training), [Realtime authorization](https://supabase.com/docs/guides/realtime/authorization).
