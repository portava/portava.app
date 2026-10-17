# Self hosted media processing

This work adds disabled, source-version-bound background processing to the existing canonical media layer. It does not deploy workers, provision models, enable production flags, or certify millions of users. Existing uploads and playback remain the fallback when optional processing is unavailable.

## Infrastructure audit

Read-only production metadata on 2026-10-15 confirms private `post-media` and `profile-media` buckets, canonical media/assets/attachments, processing attempts, lifecycle events, and existing content/message translation tables. `media_canonical_enabled` is false. The checked advanced flags are absent. No `vector`, `pgmq`, or `pg_cron` extension was installed on that project at inspection. No user media or credentials were read.

Reuse PostgreSQL for metadata, leases, and optional pgvector indexing, and existing object storage for originals. The new queue does not require Redis, PGMQ, another vector database, or a paid AI account. Enabling pgvector and deploying later migrations still require the normal reviewed database rollout. No beta work is part of this change.

## Architecture

```text
Authenticated upload and existing safety checks
             |
Canonical asset + immutable source generation
             |
Feature authorization and creator consent
             |
PostgreSQL durable derivative queue
             |
Independent bounded worker processes
  images | FFmpeg | vision | embeddings | subtitles | dubbing
             |
Private derived files / metadata / vectors
             |
Lease-bound publication + current-source validation
             |
Per-viewer authorized delivery and search
```

The application enqueues work and serves authorized results. It must not launch FFmpeg or model inference in normal request handlers. Workers call concrete handlers through `MediaJobContext`, with an abort signal and a current-lease check. A handler must check source identity, relevant consent, account state and feature policy before fetching bytes, before inference, and before staging its output. Queue ownership alone is not permission to analyze every private attachment.

Original files remain unchanged. Optional AI failures must not block otherwise valid standard uploads or playback. Safety holds cannot be bypassed because another derivative completed.

## Queue contract

Migration `3980_media_derivative_jobs.sql` creates a service-only, RLS-protected queue and state-event audit trail. It seeds `media_derivative_jobs_enabled` OFF and grants no client access to its tables or worker functions.

- Identity: asset, canonical source version, kind, pinned model/pipeline version, target language and revision key.
- Immutable source snapshot: owner, bucket, path and measured byte count, checked against canonical state at claim and finish.
- States: pending, processing, completed, failed, retrying and cancelled. Failed after five attempts is the dead-letter state, not an infinite automatic replay.
- Claim: atomic bounded `FOR UPDATE SKIP LOCKED`, unique lease token, one to eight jobs per pass, 15–900 second leases.
- Retry: exponential delay from 30 seconds, capped at 900 seconds, only when the failure is retryable.
- Recovery: expired leases return to delayed retry or terminal failure. The old token cannot publish.
- Admission: at most 100 pending/processing/retrying jobs per owner; duplicates reuse their existing identity.
- Publication: compare job ID, token, state, expiry, source and enabled global gate; retain at most 64 KiB of JSON descriptors, never media bytes.
- Revocation: canonical changes cancel incompatible jobs and invalidate completed results. State events carry status and sanitized error classes, not media contents or secrets.

Workers must never use a newly read source generation to reauthorize an older job. After automated moderation, only that upload's successful hold-to-approval transition may hand its resulting generation to derivative submission.

The worker retains private files if the completion response is lost after an uncertain database commit. Deleting them immediately could destroy successfully published playback. Such files need reconciliation and bounded orphan cleanup; a network failure is not proof that publication failed.

## Worker configuration

The shared runtime is implemented in `artifacts/api-server/src/lib/media/jobs`. Concrete worker composition and application integration are separate feature changes; this directory by itself is not a running deployment.

| Configuration | Default | Limit |
| --- | --- | --- |
| `MEDIA_DERIVATIVE_WORKER_ENABLED` | false | Explicit `true` only |
| `MEDIA_WORKER_CONCURRENCY` | 1 | 1–8 |
| `MEDIA_WORKER_LEASE_SECONDS` | 120 | 15–900 seconds |
| `MEDIA_WORKER_POLL_MS` | 10000 | 100–60000 milliseconds |
| `MEDIA_WORKER_MAX_RSS_MB` | 1024 | 128–16384 MiB |
| `MEDIA_WORKER_QUEUE_TIMEOUT_MS` | 10000 | 1–30000 milliseconds |
| Handler deadline | Handler-specific | Maximum 600 seconds |

Polling passes do not overlap in one process. High process RSS pauses new claims. This is admission backpressure, not an OS memory limit: use process/container CPU, memory, disk, PID and network limits for the actual deployment. Child processes must obey abort signals, bounded output and timeouts. Cooperative JavaScript cancellation cannot forcibly stop an uncooperative native library; a process supervisor must terminate a stuck worker and let its lease expire.

Health callbacks report state, RSS, process CPU counters, aggregate wall time, completions, failures, lost leases and cleanup failures. Process CPU counters do not measure FFmpeg/Python child CPU or GPU consumption. Collect those separately before estimating inference cost. Do not label wall time as CPU time or infer provider billing from successful-job counts.

Start with one low-concurrency worker process on existing suitable infrastructure. Logical worker kinds can share a host. Multiple instances may safely claim distinct jobs; actual multi-host deployment also needs shared private artifact storage and matching model versions. A local-only output directory is not a distributed storage system. Keep expensive AI workloads below upload/safety/playback work in the supervisor's CPU and memory allocation.

## Privacy and deletion

No face identification, sensitive-attribute inference, voice cloning, or training on uploaded voices is authorized. Managed providers remain optional and require explicit data-sharing controls. Private calls and encrypted messages must not be silently made available to server-side models.

Model artifacts and transcripts must retain source generations, model identifiers, timestamps and honest uncertainty. Similarity scores are not verified geographic facts. A candidate landmark is not a certified location.

Each product result endpoint must reauthorize the viewer on every read, including caches and HLS segments. Never expose private file paths, provider secrets, or unrestricted storage URLs through queue descriptors.

Mark the canonical asset deleted first, then cancel derived work, erase files/tracks/index entries and finally report purge completion. Cleanup errors must remain retryable and visible. Keep erasure available even when feature flags are off. Canonical hard deletion cascades queue rows; filesystem/object-storage orphan reconciliation is also required because cascading rows cannot delete external files by themselves.

## Validation

The reviewed shared queue has 28 focused runtime tests and 74 isolated in-memory PGlite assertions. PGlite exercises SQL roles, source revocation, lease ownership, retry bounds and result visibility; it does not establish multi-session PostgreSQL lock behavior. A real PostgreSQL suite is registered in the existing local database harness for simultaneous enqueue, `SKIP LOCKED` claims, canonical changes and client-role denial. A skipped real-database suite is not a passing database test.

For lightweight local SQL validation, from `tools/media-worker` run `npm ci --ignore-scripts` and `npm test`. The pinned dependency and lockfile belong only to this validation tool; do not install into shared application dependency symlinks. No network database or production credential is used by that test.

For actual PostgreSQL integration use the repository's disposable local database harness, not a production URL. Existing provider/world/video regression coverage passed 234 tests on local fixtures. Native iOS source has separate real Apple-codec core/SDK evidence; that does not establish Expo bridge linking, device playback, Android support or release activation.

No 100-, 1,000- or 10,000-concurrent-user load target has been measured. Benchmark upload request latency separately from worker queue age, encoding throughput and authorized delivery latency. Use synthetic media in a bounded disposable environment, with an explicit resource budget, before enabling a higher concurrency setting.

`tools/media-worker/measure-scheduler.mts` separately exercises the actual worker scheduler with 100, 1,000 and 10,000 synthetic in-process jobs and duplicate submissions, at concurrency eight. Its queue and handler are fixtures: it does not encode media, perform inference, run PostgreSQL, contact storage, or represent concurrent users. A local 2026-10-15 run completed those workloads in 9, 28 and 222 ms respectively, with peak handler concurrency eight and no lost or duplicate completions. Those numbers measure scheduler overhead only; they must not be used as production throughput, capacity or cost estimates. Run from `artifacts/api-server` using `node --import tsx/esm ../../tools/media-worker/measure-scheduler.mts`.

## Cost assumptions

No new subscription is required by this code. Self-hosted inference still consumes compute, storage, bandwidth and operational time; it is not free infrastructure. Existing account limits and actual hosting rates must be checked before activation.

An illustrative 30-second clip with a combined two-rendition bitrate of 1.7 Mbps occupies about 6.375 MB of encoded video, before transport/container overhead, previews, transcripts, dubbing, originals and redundancy. This is an arithmetic planning assumption, not a measured encoder output or a provider quote.

| New clips per month | Derived video storage from that assumption |
| --- | --- |
| 1,000 | 6.375 GB |
| 10,000 | 63.75 GB |
| 100,000 | 637.5 GB |

Compute hours = jobs × measured CPU seconds per job ÷ 3,600. Retained storage = monthly generated bytes × retained months, plus protected originals. Delivery egress = measured bytes delivered per view × views, not upload count. Translation/dubbing demand depends on requested languages; do not generate every language for every upload. Apply actual contracted per-unit rates and existing included allowances to these measurements. Budget managed API spend as zero while those integrations are disabled; an unavailable rate must not silently mean a zero-cost approved provider.

## Activation prerequisites

1. Complete feature integration, independent review and current main checks.
2. Rehearse and apply only the approved canonical migrations through the established migration process.
3. Provide dedicated private artifact storage, process limits, lifecycle cleanup and monitoring.
4. Install reviewed, commercially permitted pinned models in isolated runtimes; do not download at request time.
5. Validate actual model accuracy, language pairs, translation preservation, subtitle timing and synthetic voice quality on representative consented fixtures.
6. Verify end-to-end authorization, blocks, deletion and consent revocation with real storage and RLS.
7. Confirm measured cost and capacity, then authorize a narrow flag rollout with rollback controls.

Until these conditions are met, advanced recognition, visual indexing, automatic transcription/translation and dubbing remain disabled rather than being advertised as production-ready.
