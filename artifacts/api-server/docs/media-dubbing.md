# Synthetic dubbing — inactive integration

This lane produces a **separate, explicitly AI-labelled translated audio track**. It never opens or changes the original media, trains a model, accepts a voice sample, chooses a speaker identity, or runs another ASR/translation service. Default route composition and absent TTS configuration fail closed. This is main-app work only.

## Runtime and output

`createPiperSpeech` accepts an operator-supplied, already-installed local Piper executable and an existing `.onnx` model with its adjacent `.onnx.json`. Executable/model/config SHA-256 values must match; paths must resolve to regular local files without symlinks. A single stock speaker, exact configured language, explicit stock-voice approval and offline-sandbox attestation are required. No automatic downloads, credentials, account creation, managed fallback or package install occurs. No example voice/model is selected for the owner.

Piper receives validated plain text on stdin, not command-line arguments. Phoneme/SSML directives and control characters are refused. It emits raw mono PCM16. Each child has a 60-second deadline, output/diagnostic byte caps, scrubbed environment, one concurrent call per engine, abort handling, SIGKILL and close/reaping. Model/interpreter/dependency immutability and OS-level denied network egress remain operator responsibilities; the attestation boolean is not a sandbox implementation. Approval must cover the particular model's origin/license and synthetic-use policy. Piper itself is GPL; no distribution/license conclusion is implied here.

Renderer limits: 300-second media, 200 non-overlapping cues, 30 seconds per cue, 2,048 UTF-8 bytes per cue, 32,768 bytes overall. Output is mono PCM16 WAV at 24kHz, at most **14,400,044 bytes**, exact requested duration and sample-aligned cue starts. Lower-rate PCM is linearly resampled, not time-stretched. Short speech is padded with silence. Speech exceeding its slot is **refused whole**, never clipped, sped up or allowed to overlap. This is coarse subtitle alignment, not forced phoneme alignment, lip synchronization, speaker matching, a music mix or AAC muxing. WAV contains only format/data chunks, not copied media metadata. No original audio is blended into it.

Only the installed macOS speech fixture tool has produced real speech on this host. It is explicitly **not** a production fallback or Piper/translation proof. Piper and an approved model are absent. Unit tone/CLI protocol fixtures do not prove neural inference, translated meaning, naturalness or language quality.

## Shared contracts and parent composition

Production factories are in `lib/media/dubbing/composition.ts`:

- `createConfiguredMediaDubbingRouter({ client, env?, authenticate?, rateLimit? })` is synchronous. Defaults reuse parent `requireUser` and `checkRateLimit`; caller can pass its existing wrappers. It snapshots only validated immutable configuration and a lightweight `{id, language, modelVersion}` descriptor. **No model file read, hash check, Piper initialization or synthesis runs in API construction or requests.** Flags and source/viewer/caption state are rechecked, not cached. Environment changes require router reconstruction; model readiness belongs to the separate worker, not the API.
- `await createConfiguredDubbingHandler(client, env?)` returns the actual shared handler or `null` when configuration/flags/runtime are unavailable. Only this worker path dynamically imports and initializes `createPiperSpeech`. Parent must await it in the worker registry, never in an API handler/startup dependency. It does not start a loop or claim jobs.
- `await createMediaDubbingWorker({ client, env? })` additionally returns safe disabled reasons or `{status:'ready', handler, queue, runPass(signal)}`. `runPass` rechecks flags, uses concurrency 1 and a 90-second lease; parent still owns scheduling/shutdown.
- `createMediaDubbingCleanup({ client, env? })` returns `{revoke, eraseOwned}` independent of engine and flags.
- `await eraseDubbingSource(client, sourceOwner, assetId, env?)` is the canonical-source erasure hook **after parent canonical withdrawal**. It processes up to 100 objects and throws `cleanup_failed` on a full page so the caller retries rather than falsely acknowledging complete erasure. Repeated calls are safe. A missing bucket with retained rows throws and keeps their cleanup keys; no bucket plus no rows is a successful no-op. It does not itself withdraw the original source.

Implemented environment variables (no automatic activation):

- `MEDIA_DUBBING_STORAGE_BUCKET`: required existing dedicated private Supabase bucket name; no default, no creation and no `post-media`. Keep this selection available and stable for deletion even when generation is OFF. Changing it while retained rows exist requires an explicit migration/reconciliation, not silently repointing cleanup.
- `MEDIA_DUBBING_PIPER_CONFIG`: inline JSON, maximum 8,192 UTF-8 bytes, strict keys `executable`, `executableSha256`, `modelPath`, `modelSha256`, `configSha256`, `language`, `stockVoiceApproved:true`, `offlineSandboxAttested:true`. Both explicit approval booleans are required; strings such as `"true"` are refused. Paths must be normalized absolute local paths; pins are lowercase 64-character SHA-256. No file is opened by the environment validator. API and worker must receive the same config, including paths, to derive the same queue model identity.

Missing/malformed runtime configuration disables generation but preserves a separately valid bucket and the withdrawal/cleanup paths. Missing/invalid bucket disables generation; withdrawal still rotates consent/cancels jobs before reporting any cleanup failure. Neither `media_dubbing_enabled` nor `media_derivative_jobs_enabled` is enabled by these variables. Rate limiting uses the parent helper at 120 requests/minute per user, with separate generate/read/withdraw keys so exhausting generation does not prevent withdrawal; this is not a replacement for the queue's durable bounds.

Parent owns `lib/media/jobs/{queue,worker}.ts`, route mounting, provider composition, health/concurrency controls and root test registration. Dubbing imports their types; it creates no parallel persistent queue. `createDubbingHandler` returns the shared `MediaJobHandler` (`kind: 'dubbing'`, runtime model identity, 300-second timeout). Construct with the store methods, engine, and `jobError: (code, retryable) => new MediaJobError(code, retryable)` from the shared queue. Permanent consent/source/input/overflow/integrity failures do not retry; transient runtime/storage failures use the shared bounded retry policy. The worker calls `discard` when publication loses its lease. Concurrency one is recommended for a local engine.

`captionBridge.ts` reuses Rawls's `CaptionAsset`, `CaptionSnapshot`, translated `CaptionVariant`, and the existing `parseWebVtt`/`CaptionCue`. `dubbingSourceFromCaptionSnapshot` selects exactly one published, labelled translated variant, preserving its timing and deriving the content/model-bound translation revision. Parent supplies `loadTranslatedSource` by reading Rawls's authorized current asset/snapshot on **every** call. No cached owner-only authorization shortcut is acceptable.

`translatedDubbingCues` consumes Planck's `PlatformTranslationResult`: field keys `cue_0`, `cue_1`, etc.; exact expected `sourceRevision` and target language are required. It preserves timing, refuses skipped/unavailable/denied, missing/extra fields and mock identities. Planck's current service allows at most 100 fields, so this direct bridge allows at most 100 cues; the renderer separately accepts up to 200 already-published cues. Translation remains in the shared service; parent/Rawls publish translated caption variants before dubbing. Never route E2EE/decrypted message text into this lane.

## Durable consent and publication

Migration **3986**, generated through the official CLI before adaptation to the repository's numeric sequence, depends on parent **3980**. It creates service-only RLS-enabled consent/artifact tables, RPCs, a protected readable view and a default-OFF `media_dubbing_enabled` flag. It has not been applied to a live database. No Storage bucket is created: pass an existing, dedicated private bucket to `createDubbingStore`; public and original `post-media` buckets are refused. Configure its object-size limit for this bounded WAV format. Audit bucket RLS before deployment: clients must have no direct object read/write grants; delivery is through the authenticated route only.

Consent is owner-only, explicit, versioned, language/content-bound and compare-and-set. The creator fetches the current consent revision before accepting the disclosure. Identical retries of that grant are idempotent; revocation rotates the revision so a delayed pre-revocation request cannot opt in again. Source generation/path/owner/size changes and moderation/processing holds withdraw consent; a later approval does not restore it. New opt-in is required.

Artifact metadata is recorded under the owned live lease **before** private upload, keeping cleanup keys across crashes and source/job deletion. Upload never upserts. Staged artifacts cannot be read until the shared queue completes that exact artifact ID. Source/consent/current caption revisions and viewer authority are checked repeatedly, including after download. No public or signed Storage URL is returned. SQL publication fences source/lease/consent; the current translated-caption snapshot is revalidated in the service, not substituted with a mock SQL translator.

Revocation durably withdraws consent and cancels dubbing jobs before deleting objects. Failed deletion surfaces an error and retains the cleanup row; withdrawn audio remains unreadable. `eraseOwned(ownerId, assetId?)` removes at most 100 registered private objects per pass and returns the count. Parent must wire repeated erasure passes into account/source deletion and orphan cleanup; retained tombstones alone are not physical deletion. A crash after staging or a storage failure needs that cleanup integration. This lane does not overwrite shared deletion routes or activate a worker.

## Minimal UI contract — no player edits

- `GET /media/:assetId/dubbing?language=en-US`: authenticated **creator** obtains `consentRevision`, `optedIn`, `label`, `disclosureVersion`. State/revocation remain usable while generation is disabled or the model is unavailable.
- `POST /media/:assetId/dubbing`: `{ targetLanguage, explicitOptIn: true, disclosureVersion: 'synthetic-dubbing-v1', expectedConsentRevision }`; no text, source URL, model, speaker, reference audio or training settings. Returns 202 with a shared `jobId`, never a fabricated completed artifact.
- `DELETE /media/:assetId/dubbing`: creator withdraws all language grants, cancels jobs and removes artifacts. Repeat after cleanup errors; withdrawal is already effective.
- `GET /media/:assetId/dubbing/audio?language=en-US`: normal current viewer authorization, source/consent/caption checks, labelled bounded WAV bytes, `Cache-Control: private, no-store` and no direct storage URL.

Suggested consent text for parent UI review: “Generate a separate AI-translated audio track using a stock synthetic voice, not my voice. Keep my original video and audio. I can remove the generated track.” Label the selection **AI-generated translated audio**; original audio stays available and the default. Selecting a dubbed track must mute original audio only for that selection, preserve play/pause/seek/background state, and restore original selection on denial/revocation. This is an integration contract, not an implemented player or approved final wording. `WatchVideoCell` is untouched.

## Local commands

From `artifacts/api-server`, using the existing read-only dependency symlinks:

```sh
node --import tsx/esm --test --test-concurrency=1 src/test/mediaDubbing.test.ts src/test/mediaDubbingRuntime.test.ts src/test/mediaDubbingCaptionBridge.test.ts src/test/mediaDubbingRoutes.test.ts src/test/mediaDubbingComposition.test.ts
node --import tsx/esm ../../tools/media-dubbing/generate.mts --input /absolute/input.json --runtime /absolute/approved-piper-config.json --output-dir /absolute/existing-private-output
node --import tsx/esm ../../tools/media-dubbing/prove-apple-speech.mts /absolute/external-evidence-directory
node --import tsx/esm ../../tools/media-dubbing/test-store.mts /absolute/installed-pglite/dist/index.js /absolute/parent/src/migrations/3980_media_derivative_jobs.sql
```

`generate` is local/offline artifact creation, **not** a persistence, permission, translation or publication witness; its input is already authorized translated segments. Output directories are unique 0700, files 0600; failure cleans owned partial output. Do not use it as a replacement for the production store/queue checks. Use only invented text for local proof. A missing model exits 2 without an artifact.

The SQL tool runs the actual 3980/3986 SQL and parent queue/worker in isolated PGlite; storage is an explicit in-memory protocol fixture. It is not hosted Supabase Storage, multiprocess PostgreSQL concurrency, deployment, device audio synchronization, or live user-media proof. Parent must register all five test files in its shared manifest and arrange the isolated SQL tool separately; this lane does not edit root manifests. Composition tests need the actual shared queue/worker and Rawls service present in the combined integration tree; standalone lane validation uses an external resolver to those actual neighboring files, not stubs.
