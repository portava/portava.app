# Main-app media implementation and activation boundary

This document covers the uncommitted integration based on the reviewed #761 tree. No beta work, production migration, provider activation, deployment or subscription purchase is included. The previous media census is not promoted by this implementation: code construction, local verification and production acceptance are different gates.

## Reused infrastructure

The implementation reuses canonical media generations, existing upload validation and moderation, private Supabase Storage originals, PostgreSQL metadata, the current authorization services, Telegraph's translation interfaces and mobile language settings. New durable processing uses one PostgreSQL queue rather than Redis or a second job system. Visual indexing targets pgvector in the existing database, not a separate vector service.

Existing upload-time image normalization still strips sensitive metadata before a file can be delivered. It has not been moved after publication or removed to save request CPU. Moving all existing normalization out of API requests requires a reviewed quarantine/upload-state transition; the new responsive image work does run outside requests.

## Processing and storage

```text
Existing authenticated upload / validation / moderation
             |
Canonical source generation + owner-controlled audience
             |
Rendition request OR separate explicit AI consent
             |
One durable PostgreSQL derivative queue
             |
Independent logical workers (initially one shared worker host)
  Sharp images  |  FFmpeg video  |  vision  |  embeddings
  ASR  |  shared translation  |  synthetic voice dubbing
             |
Lease-bound results / creator-reviewed subtitle publication
             |
Private derivative volume or existing private object storage
             |
Current-source, consent, block and viewer-authorization checks
             |
Original-compatible application playback and search
```

Original media is not replaced by image variants, subtitles or synthetic audio. Images and adaptive streaming currently require a dedicated marked private persistent filesystem shared by the API and workers. This is not a complete multi-host object-storage adapter. Dubbing requires an explicitly configured private bucket separate from `post-media`; no bucket has been provisioned. Caption manifests and draft references use the existing private media storage path with dedicated protected readers. Database rows contain references and metadata, not large media objects.

## What the implementation covers

| Capability | Implemented scope | Not established by local implementation |
| --- | --- | --- |
| Queue | Persistent identities, leases, bounded retries, terminal failures, priority, cancellation, source invalidation, audit events and health callbacks | Real PostgreSQL multi-session deployment, production throughput |
| Images | Bounded separate Sharp child, orientation and metadata stripping, JPEG fallback, responsive WebP/AVIF variants, hashes and authorized private delivery | HEIC/animated/SVG support, distributed-volume operations, all existing API CPU removed |
| Adaptive video | FFmpeg H.264 renditions, HLS, previews, authorized segment relay, mobile fallback to original playback | Real mobile device streaming and production codec/runtime qualification |
| Image understanding | Pinned local-model interface, guarded input, versioned confidence-bearing candidates and explicit consent | Actual installed model, recognition accuracy, verified geographic facts, complete landmark/venue recognition |
| Visual search | Versioned image/text embeddings, pgvector adapter, metadata/visibility/block checks and revocation-safe result receipts | Installed vector extension/models, multilingual model quality, actual search capacity |
| Manual timed captions | Creator editing, WebVTT validation, revision-safe publication, playback-synchronized display and deletion | Full device accessibility/playback acceptance |
| ASR | Isolated audio extraction/transcription interface, explicit source-bound consent, durable jobs, protected review drafts | Installed ASR dependencies/model, tested language accuracy or production latency |
| Subtitle translation | Shared provider integration, separate translation consent, owner request/withdraw/review/publish UI, original-preserving revision-safe publication | Approved model and language-pair quality; activation depends on completed end-to-end review |
| Dubbing | Synthetic stock-voice adapter, bounded timed audio assembly, separate creator consent, private per-language tracks | Installed synthesis model, naturalness, separation of music/speech, lip synchronization or real device qualification |
| Social translation | Shared authorized translation service, source-version/viewer-aware cache, original toggle, comments, feed captions and profile biographies | Every product surface, all language pairs, encrypted-message server translation |
| Native compression | iOS native module and actual Apple codec core tests | Android implementation, Expo bridge/device/release certification |

Transcription, subtitle translation, creator post descriptions and voice dubbing are distinct content types and grants. An ASR grant does not authorize translation, dubbing, third-party processing, voice cloning or training. No real-person voice cloning or sensitive attribute inference is implemented or approved.

The expanded directive is not completely implemented. This integration checkout now has account-scoped, device-local automatic-dubbing preference persistence (`travel-buddy-standalone/src/services/languagePreferences.ts:15#export async function readAutomaticDubbingPreference(`, `travel-buddy-standalone/src/services/languagePreferences.ts:27#export async function writeAutomaticDubbingPreference(`), reuses the existing preferred-language flow (`travel-buddy-standalone/src/context/LanguagePreferenceContext.tsx:94#const updateLanguage = useCallback(`), and passes the preference into the existing-player dubbing session (`travel-buddy-standalone/src/components/media/MediaDubbingSession.tsx:72#automaticPreference: automaticDubbingPreference,`). This is bounded local client implementation, not cross-device preference synchronization or evidence of parent-checkout integration, activation or native-device acceptance. Universal notification localization, every Discovery/Trips/Passport/Compass surface, advanced video scene analysis, background-music separation, Android native compression and provider-specific managed image/video adapters remain unfinished. Existing explicitly configured legacy OpenAI text translation remains supported; new platform/subtitle pipelines select self-hosted processing without automatic paid fallback. Viewer playback preferences do not grant creator consent for synthetic voice generation.

Manual post descriptions remain the existing feature. The new timed-caption controls are mounted in the two shared video players, with preferred-language selection and original-track fallback after the viewer enables captions. Backend caption operations currently accept canonical post videos only, not private calls, encrypted messaging or every possible attachment context. Reusing a player in another product does not broaden those backend permissions.

## Current enablement

No new feature is enabled in production. New advanced paths default off or refuse operation without their validated configuration. Missing models or credentials do not convert into fabricated outputs or automatic paid fallback. Existing standard uploads, manual post descriptions, original playback and original text remain available when optional services fail.

Local tests use synthetic images/video/PCM and controlled model responses. They demonstrate contracts and failure handling, not real recognition, transcription, translation or synthesized-speech quality. **No new language is certified by those fixtures.** Activate only a measured allowlist after testing representative consented samples, including accents, code-switching, timing, unsafe mistranslations and failure cases.

## Activation requirements

1. Finish independent integration review and merge through normal main checks; do not mix with beta work.
2. Rehearse the canonical migrations in a disposable actual PostgreSQL environment with concurrent sessions and appropriate extension versions. Do not apply individual files out of order to production.
3. Approve the worker host, private persistent volume/bucket, disk quotas, process supervision, network isolation and erasure topology. No new paid host or GPU is authorized by the code.
4. Install commercially permitted pinned model files and their isolated dependencies. The Python environments inspected for this work do not contain the required vision, embedding, ASR or translation models/runtimes; the Piper dubbing model is also absent.
5. Validate consent withdrawal, caption edits, blocks, source changes, account deletion and orphan cleanup against actual storage and roles. Keep artifact roots and bucket identities stable until all old data is erased.
6. Exercise complete upload → processing → creator review → viewer playback/search → deletion flows on supported iOS/Android devices and slow connections.
7. Measure CPU/RAM/disk/queue age/egress and language accuracy. Choose limits, alert thresholds and a rollback plan before any narrow rollout.

Cleanup deliberately retains unresolved writes as visible retryable debt. An expired job or empty object listing is not proof that an in-flight upload has stopped. Translation hard deletion that bypasses the canonical lifecycle still requires a retained-ledger/quiescence recovery design; native audio cleanup across a lost handle/remount also remains unproven. Keep the affected advanced paths OFF rather than claiming those cases are safe. Crash-held image locks are never stolen on age alone.

The D25 photo-crowd policy hold remains in force. Generic AI configuration is not authorization to process location-sensitive media, private messages or calls. End-to-end encrypted content must not be decrypted for server-side translation.

## Cost and scaling

No new service has been purchased. Managed-provider spending from the new disabled paths is zero; this does not mean self-hosting is free. Use measured child-process CPU time, model memory, generated bytes, retained months and bytes delivered per view with the actual hosting contract. Do not use scheduler-only benchmarks as inference-cost estimates. The worked storage assumptions and formulas are in `media-selfhosted-workers.md`.

Start with one bounded worker process per active kind and low aggregate host concurrency. Add replicas only after real queue-age/resource measurements justify them. Logical separation supports later independent deployment; shared-volume topology, centralized capacity limits, distributed caching and operational monitoring still require deployment validation. Neither millions of users nor 100/1,000/10,000 concurrent-user capacity has been certified.

## Final integration checkpoint — 2026-10-15

Six parallel workers contributed implementation and bounded review. The integrated checkout remains uncommitted and unpublished. Remote main was verified at `324ed0dd2b61371afc6f20a5a843f89406b57cc8`; its tree `495bf043f4c0f8c2a2c2f9da137bf5ea6109c8d4` matches this checkout's reviewed starting tree. This is not a claim that the new changes are already on main.

### Application and deployment changes

- Existing upload/moderation orchestration now submits eligible exact-generation image jobs without running Sharp in the request. Adaptive video, vision and embedding adapters share the derivative queue rather than creating separate pipelines.
- The production build emits separate worker, cleanup and isolated image-encoder entrypoints, plus the required Python scripts. Packaging scripts is not packaging model weights, Python dependencies, FFmpeg or Piper.
- Worker kinds are `image_variants`, `adaptive_video`, `vision`, `embedding`, `captions`, `subtitle_translation` and `dubbing`. Use the existing configuration sections and feature-specific READMEs; the `media:worker` and `media:cleanup` scripts do not enable any flag themselves.
- Authenticated API routes cover image variants, adaptive playback, visual indexing, captions/transcription, subtitle translation and dubbing. Source references, generation, permission and consent are checked separately from queue ownership.
- The two shared video players include caption and audio-language controls, original fallback, explicit pause/focus gating and creator-reviewed generation. Owner withdrawal remains reachable through an explicit metadata-only action even when generation is OFF; mounting that control does not initiate a request.
- Six canonical migrations add durable processing, vision/index metadata and separate caption/translation/dubbing grants. All are pending; see `migrations.md`. Originals remain in existing private object storage. No bucket, database extension, worker host or paid account has been created.

### Final selected verification

| Check | Result | Evidence boundary |
| --- | --- | --- |
| Integrated new backend suites | **497/497 passed, zero skipped**, about 27 seconds | Includes route/worker/privacy/deletion/failure fixtures, actual synthetic image/video encoding, build packaging and isolated SQL tests; not the full application test suite |
| Selected mobile integration/regression suites | **189/189 passed across 27 suites**, about 4.8 seconds | Includes captions, translation, dubbing, both shared players, Watch pause/focus behavior and language settings; native audio/video are mocked |
| Six-migration integration harness | **1,414 assertions passed**, independently rerun with exit 0 | Actual SQL functions, triggers, roles and pgvector in a disposable single-session PGlite database; not hosted or multi-session PostgreSQL |
| Deliberately broken security controls | **13/13 mutations rejected** in the six-migration harness | Includes consent epochs, source/caption invalidation and publication-lease binding; mutations affect only disposable fixtures |
| Separate dubbing storage protocol | **111 assertions passed** | Tests pending writer settlement and retained cleanup; not live object storage |
| Existing adjacent backend regression selection | **184/184 passed** | Overlaps some new translation suites; do not add it to the integrated total as distinct coverage |
| Production API/mobile TypeScript | **Passed** | No production diagnostics in either package |
| Test TypeScript ratchets | **Unchanged and passed** | Existing API baseline 862 diagnostics in 115 files; mobile 173 in 60. Baselines were not increased or suppressed |
| Migration prefixes/session state, security-definer oracle, test registration, mobile mocks/imports, whitespace | **Passed** | Existing documented migration collisions/findings remain; static checks are not a live database security audit |

Earlier separate native iOS evidence covers 23 actual Apple-codec core/SDK checks, not Expo linking or physical-device acceptance. Real ASR, translation, vision and speech synthesis accuracy has not been measured. There are **no newly certified languages**, and the scheduler timings in `media-selfhosted-workers.md` are not concurrent-user performance results.

### Issues found and corrected during review

- Asset-wide dubbing withdrawal now advances a durable token even before the first language grant; delayed old requests cannot recreate permission.
- Completed dubbing output must carry the exact token of the lease that staged it. An expired worker's artifact cannot be published by a later lease.
- Playback options reread selected publication identities after final source/caption checks; withdrawn audio cannot remain advertised as ready through that request.
- User pause, Watch focus loss, global pause, backgrounding and authentication changes independently fence auxiliary-audio admission, rather than trusting delayed native playback callbacks.
- Owner withdrawal and audio recovery remain accessible together during a native mute hold. An unready requested language is not offered as playable.
- Image orphan cleanup requires a durable unchanged 30-minute observation, current lock, authoritative source/job absence and exact fingerprint checks. Restarts retain the observation; changes reset the grace interval.
- Unsettled writes and unknown erasure results remain retryable debt. Cleanup never claims success merely because a job expired or the source row disappeared.

### Remaining work, not a 100% claim

The code passes the selected local gates, but the full expanded product directive is still incomplete. Before calling the media system production-ready, complete the unfinished product surfaces listed above, Android/native-device acceptance, actual PostgreSQL concurrent-session tests, storage/writer crash recovery, translation hard-delete recovery and cross-remount audio cleanup. Then validate licensed model packages, language quality, worker resource limits, cost telemetry and real load using synthetic or explicitly consented samples.

Model activation needs an approved suitably isolated worker environment, commercially permitted pinned model packages, adequate CPU/RAM/disk, private persistent storage and measured language/recognition quality. A GPU, managed AI subscription or separate vector database is not mandatory for the current basic architecture. Any new paid host, bucket/provider account or external-media sharing requires separate approval. Do not enable advanced flags merely because these unit/integration tests pass.

## Main-app follow-up checkpoint — 2026-10-16

The earlier checkout/results above are historical snapshots. The Media implementation is now integrated into the main-app correction checkout, alongside the existing Memory, Trip, privacy and authorization changes. It is still uncommitted, unpublished and disabled where activation prerequisites are unmet. No beta work, hosted database apply, provider activation or deployment occurred.

Additive migration 3995 retains exact subtitle-translation draft/publication upload identities across source hard deletion. Both registered writers reserve before dispatch and record positive settlement; unknown uploads remain durable debt. Independent review passes 112 focused cases, 28 actual PostgreSQL 17.11 multi-session cases and eighteen additional SDK/native probes. The seven-migration combined SQL harness passes 1,466 assertions and independent replay. These counts overlap earlier tests and are not additional completed requirements.

The generic caption writer does not permanently fence every forgotten path: the dedicated translation publication path is fenced, while mixed/legacy writers and full account-deletion orchestration remain separate activation gates. Source disappearance, timeout, failed upload or an empty listing never proves writer settlement. Historical 3987 is unchanged.

The main-app build/router/runtime-asset integration has bounded independent acceptance. Mandatory runtime execution remains under integration: an ordinary test registration that skips because PGlite or FFmpeg is absent is not success. A separate required native Media translation deletion command now uses the same verified disposable PostgreSQL runtime as the existing Memory gates; its actual 28-case local execution passes. The four-Memory manifest and existing test floors remain unchanged. Hosted Linux CI has not been run.

The cross-remount dubbing repair retains unresolved native-resource ownership and prevents a successor sound from starting while cleanup is unconfirmed. Its 99-case build proof awaits independent review. Four preserved stronger counterexamples still demonstrate that failed native stop/unload after delayed play cannot establish physical silence through the current Expo wrapper. No new native safety or production-readiness claim follows; advanced dubbing stays disabled.

Post detail is connected to the existing translated-description component without changing the original description, Share/Edit payloads or server permission model. One genuine same-owner replacement-session case remains red in the mounted proof; the shared session-boundary correction is in progress. The initial Telegraph translation pipeline also has separately reproduced lifetime gaps under repair; the accepted per-fragment/retranslation write-fallback correction does not certify that initial pipeline.

Model licensing/installation, measured translation/transcription/voice quality, authorized worker/storage configuration, device validation, operational capacity and full deletion recovery remain required before activation. No language, live feature or architecture grade is promoted by this checkpoint.

### Subsequent main-app integration, still not activation

Initial message translation has now passed independent review of its bounded source/access/preference lifetime checks: 506 selected cases pass, including unchanged original proofs and actual mounted-route fixtures. These checks are not an atomic authorization or distributed cancellation guarantee. The PostDetail caption connection now passes its unchanged 29-case proof after a shared session-boundary repair; that repair and dependent SDK fixture reconciliation await independent acceptance.

Three Media transport/lifetime suites now use the correct existing Jest filename convention, with unchanged contents and 32 passing cases. The native-video fixture retains a stable mounted handle; fifteen post/player neighbor cases pass. Physical-device dubbing silence remains unverified, and the four stronger late-play/failed-stop counterexamples remain open. Unresolved native resources continue to block new dubbed playback rather than being silently discarded.

The direct dubbing eraser refuses pending or unknown upload states before object removal. Local regressions pass; independent review and the separately built account-deletion source barrier remain required. The account build reports fifteen actual PostgreSQL concurrency cases, but existing fixture integration and independent review are unfinished. Do not interpret either patch as a universal account-wide writer fence or as proof that all historical orphaned objects are discoverable.

Mandatory runtime gates are still being integrated. Eighteen actual SQL tests and two synthetic FFmpeg 8.0 encoding tests pass locally, but raw-output bounding, exact CI registration and verified Linux preparation require their remaining reviews. Nothing in this section authorizes hosted migrations, workers, models, flags or paid infrastructure.
