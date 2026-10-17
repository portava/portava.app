# MD277: private self-hosted adaptive video

Main application only. This implementation does not enable any flag, provision infrastructure, change the original, or establish production readiness. CPU FFmpeg creates H.264/AAC MPEG-TS HLS, two non-upscaled renditions, a measured source probe, and one JPEG preview. No managed provider, paid subscription, GPU, public segment bucket, or E2EE decryption is used.

## Shared worker integration

The parent-owned `lib/media/jobs` worker is the **only durable queue and publisher**. There is no second scheduler, SQLite store, migration 3984, or in-request encoder.

`createAdaptiveJobHandler(sc, config, jobs, options?)` in `lib/media/adaptive/handler.ts` returns the shared worker contract:

- `kind = adaptive_video`, `modelVersion = hls-v1`, `timeoutMs = 570000`.
- `handle({job, signal, isCurrent})` returns `{result, inputBytes, outputBytes}`; it never calls queue finish/publish.
- `discard(context, output)` removes only the directory matching the exact asset, generation and lease token. It cannot erase another attempt.
- The shared worker renews leases, calls its single finish CAS, retries/backoffs/deadletters, and discards only a definitively rejected publication. An unknown commit acknowledgement retains private files for reconciliation, not immediate deletion.

Use one handler instance, worker concurrency one and 900-second renewable leases. Prefer three adaptive attempts in the shared queue (five remains the current bounded global maximum). The model version identifies the ladder configuration; change it when encoding settings/toolchain are deliberately changed. Empty target language and revision key are required. Payloads carry immutable canonical asset ID, positive safe integer sourceVersion, bucket, path and exact sizeBytes. The handler copies the snapshot, never rebases it, checks canonical ready/active-or-approved/not-deleted/not-purging state and owner-prefixed post-media storage, and rechecks before encoding and after atomic file publication. It polls cancellation, lease, canonical state and disk usage while working.

`createSelfHostedAdaptive(sc, config, jobs, options?)` provides `{adapter, processJob, discard, eraseAsset, playback, readFile}`. `processJob` returns an **unpublished** `AdaptiveOutput`; only the shared worker may finish its job. `options.download`/`options.encode` are testing seams; production omits them. Optional `metric` emits `adaptive_encoded` elapsed/input/output bytes, not an assertion of durable readiness.

The parent-supplied `AdaptiveJobs` has exactly three operations:

1. `enqueue(source) -> {id}`: obtain owner identity server-side, use the shared idempotent enqueue RPC, and reject a cancelled/deleted source. Never derive a new sourceVersion from a later row.
2. `ready(assetId, sourceVersion) -> AdaptiveOutput | null`: service-role-only lookup/RPC of completed `adaptive_video` / `hls-v1`, empty language/revision, matching current canonical generation/storage/size and flags. Validate its result using `decodeAdaptiveOutput(result, {assetId, sourceVersion})` from `descriptor.ts`. This rejects malformed, oversized, cross-generation, cross-asset and public-URL descriptors. Do not expose the queue SELECT to users.
3. `cancelAsset(assetId)`: durably revoke all generations/leases/result pointers before filesystem erasure. Errors must throw; a failed cancellation must not claim successful deletion.

`eraseAsset(assetId)` is the LifecycleService hook: await durable cancellation, then erase this asset's staging and output directories across generations. Call it after the canonical deletion is durably accepted, including account deletion. A failed erasure must remain a retryable lifecycle failure. Parent owns this wiring. Do not call it as a speculative pre-delete that could later roll back.

## Files and protected delivery

Worker and API must share the **same private persistent local root** on one host. Staging uses random mode-0700 directories. Output names bind canonical asset ID, source generation and lease; files are fsynced, atomically renamed, hashed and length-checked. No static server may expose this root. Child processes receive absolute trusted executable paths, argument arrays with `shell:false`, a scrubbed environment, local-file/pipe protocol allowlists and bounded thread counts. Metadata/chapters/subtitles/data are stripped; original files are not overwritten. Canonical probe/thumbnail columns are not rewritten (which would bump the source generation); actual probe/preview metadata is stored once in the shared job result.

Root initialization only adopts a missing/empty directory, creating the exclusive `.portava-adaptive-root` marker with exact content `portava-adaptive-root:v1\n`. Existing nonempty unmarked roots are refused before chmod or child creation; existing output trees must be reviewed explicitly, not silently adopted. A marker must be a bounded regular single-link file with the expected content. Symlink roots/markers/staging/outputs refuse. Directory permissions use no-follow file handles only after marker/subdirectory validation. Reads and output deletion also verify the marker. `erase(assetId)` validates UUID internally before any initialization/scan, and deletes only well-formed generation/lease names for that UUID, not arbitrary prefix matches.

Parent mounts `createMediaAdaptiveRouter(resolveRuntime)` under `/api`:

- `GET /media/adaptive/:assetId/playback`: current authorized manifest URL, preview URL, sourceVersion and measured ladder.
- `GET|HEAD /media/adaptive/:assetId/:generation/master.m3u8`, `v0.m3u8`, `v1.m3u8`, `v[01]-NNNNN.ts`, `preview.jpg`.

Every request requires the existing authenticated session and fresh canonical `authorizeMediaAccess`; there is no post-media positive authorization cache. Authorization is rechecked after artifact lookup/read. Audience narrowing, blocks, missing state, owner deletion, generation replacement and local/feature OFF refuse retained bytes. Responses are private/no-store and never redirect to signed storage/public segment URLs. Single byte ranges return bounded 206 responses; malformed/multi/overflow/unsatisfiable ranges return 416 only after authorization. Filenames cannot traverse directories. A manifest is not a bearer grant: copied URLs do not authorize another viewer. Bearer session headers must accompany **every nested manifest/segment/preview fetch**; no long-lived query tokens are introduced.

Default configuration remains OFF, additionally requiring the existing `media_transcoder_enabled` database flag. Parent's independent queue gate remains OFF. An unavailable/unsupported rendition leaves original progressive playback available **through its existing authorization**, not a bypass using an old signed URL. Bytes already buffered before a revocation cannot be clawed back; subsequent fetches reauthorize.

## Client change owned by parent/captions lane

In `travel-buddy-standalone/src/components/media/WatchVideoCell.tsx`, add an optional typed `playbackSource` prop (`AVPlaybackSource` from expo-av), and change only the Video source expression from `source={{ uri: videoUrl }}` to `source={playbackSource ?? { uri: videoUrl }}`. Parent's source selector obtains the authorized playback metadata and supplies `{uri: manifestUrl, headers: {Authorization: sessionBearer}, overrideFileExtensionAndroid: 'm3u8'}`. Key requests/state to assetId + sourceVersion + viewer/session, discard stale async replies, unload on account/revocation changes, and freshly authorize any progressive fallback. Web playback lacking nested authenticated HLS support should keep progressive playback rather than publicly expose segments. Header propagation through native HLS, seeking, cancellation, fallback and web behavior need device/browser acceptance; this lane does not claim that proof.

## Resource and deployment boundaries

Hard application bounds: input 128 MiB; source duration 120 seconds; decoded frame pixel count at most 8,847,360; aspect ratio at most 4:1; at most 60 fps; square pixels; at least 360 source height for two non-upscaled outputs. Output <=96 MiB, <=128 files, <=8 MiB each. Renditions use 30 fps, four-second GOP/segments, at most two codec threads, 180-second subprocess deadlines. Probe output <=1 MiB and stderr tail <=8 KiB. Encoded metadata <=58,000 bytes leaves space under the shared queue's 60,000-byte result limit. Unsupported media is refused without modifying the original.

Decoder max_pixels enforces the frame-pixel ceiling during decode, not just initial metadata inspection; max_samples is 262,144 and filter buffering is limited to 32 frames. These options were checked against and exercised on the actual FFmpeg 8.0 local build. Older/different builds missing required options refuse; they are not silently accepted as equivalent.

Before any launch, the parent-owned independent worker/container needs a pinned, reviewed FFmpeg/libx264 toolchain and licenses, non-root identity, two-CPU/cgroup memory limits, private persistent-volume quota, no public mount, restricted egress (only source storage/DB in the Node worker; none in FFmpeg), and read-only application/binaries. The application checks do not substitute for OS/container memory/disk isolation. No container was built or deployed in this lane. Wall time × allocated CPU is only a cost upper-bound estimate, not measured CPU consumption or a paid-provider invoice. The shared queue carries actual wall/input/output metrics; no scalability/cost benchmark is claimed.

Abrupt process death can leave private staging or unreferenced completed-attempt directories. Shared reconciliation must compare durable result pointers/active leases before pruning these, and retry source/account erasure. In particular, never age-delete an output merely because a finish acknowledgement was lost. This is a launch hold until integrated; private quotas prevent unchecked accumulation. A multi-host API requires a future private storage adapter or appropriate shared volume, never fallback to public files.

**Bounded hard-delete orphan sweep is not implemented in this lane; parent owns its shared-sweeper integration.** Inventory filesystem outputs independently of job rows, because asset hard deletion can cascade away the only durable descriptor. Bound directory entries scanned, deletions and elapsed time per pass, using incremental iteration/resumption rather than a full readdir/sort each pass. Parse/validate the asset UUID and artifact name. Query canonical existence directly: a successful missing-row read is different from a read error, and `canonicalSource() === null` is not sufficient evidence (it also means ineligible/held media). Reconfirm missing state with the parent's cancellation tombstone/lease guard before deleting an exact candidate; retain it on every unknown/error or live lease. Do not infer deletion solely from missing job metadata or age. `AdaptiveArtifacts.removeOutput(directory)` provides marked-root/exact-name removal, but does not itself confer canonical/lease authorization. The existing whole-asset eraser is not a bounded orphan scanner. Until the parent supplies this guard and sweep, orphan reclamation remains explicitly incomplete; completed reads already deny missing canonical assets.

## Focused verification

State/HTTP tests use synthetic in-memory PostgREST/queue state and real private temporary files; the state suite runs the actual shared worker module. In the isolated lane checkout, set `ADAPTIVE_SHARED_WORKER_PATH` to the parent's `lib/media/jobs/worker.ts`; after integration the normal relative import resolves. Run serially from `artifacts/api-server` with dummy Supabase configuration and no Redis/credentials:

```sh
SUPABASE_URL=https://storage.example.test SUPABASE_ANON_KEY=synthetic REDIS_URL= node --import tsx/esm --test src/test/mediaAdaptive.test.ts
node --import tsx/esm --test src/test/mediaAdaptiveArtifacts.test.ts
FFMPEG_PATH=/absolute/trusted/ffmpeg FFPROBE_PATH=/absolute/trusted/ffprobe node --import tsx/esm --test src/test/mediaAdaptiveEncoding.real.test.ts
```

The real suite requires explicit binaries and fails, rather than silently skipping, if unavailable. It generates only synthetic testsrc/sine fixtures, encodes/probes two ladders, fully decodes output frames, checks a real JPEG preview, exercises silent media and cancellation, and verifies unreadable originals remain unchanged. Parent owns CI registration/toolchain availability. Durable SQL/RLS proof belongs to the shared queue tests, not these doubles. No census grades, vendor/privacy holds, owner acknowledgments or launch metadata are changed.

Reference: [upstream FFmpeg downloads](https://ffmpeg.org/download.html), [HLS muxer documentation](https://ffmpeg.org/ffmpeg-formats.html#hls-2), [Supabase authenticated downloads](https://supabase.com/docs/guides/storage/serving/downloads).
