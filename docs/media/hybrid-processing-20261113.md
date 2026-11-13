# Hybrid media processing — 13 November 2026

Status: implementation and local regression checks completed; consent migrations applied to production. Inference providers are not provisioned or enabled by this change. No iPhone build was run. This is implementation evidence, not a claim of 100% production quality or an A++ grade.

The owner's latest direction is **in-house open source only when equal or better than the paid alternative**. Local Whisper, SigLIP and CLIP remain candidates; the optional managed adapters remain available. No replacement has established live parity. See `docs/ops/provider-replacement-policy-20261113.md` for the source audit and executable comparison check.

The subsequent Mac feasibility run is recorded in `tools/local-inference-lab/README.md`. SigLIP, Whisper Turbo and a compact writing model now have real local runtime evidence. That probe uncovered and fixed the caption PCM-loader incompatibility and added exact-silence abstention. It also recorded material latency and model-quality failures; production provisioning, paired parity and device validation remain outstanding.

## Ownership and processing boundaries

Portava owns permissions, ranking, feedback, job leases, source-version checks, revocation and publication. Replaceable inference adapters supply limited outputs. They do not publish posts, change audiences or turn image similarities into verified observations.

| Function | Implementation | Boundary |
| --- | --- | --- |
| Timed caption drafts | Deepgram Nova-3, with an explicitly pinned provider version; existing local Whisper remains available | Extract mono WAV locally. Send audio only, with `mip_opt_out=true`. Validate returned model/version, language confidence and actual word timestamps. Creator reviews before publication. |
| General image understanding | The existing pinned SigLIP worker, optionally hosted on a dedicated Hugging Face endpoint | Send a normalized JPEG or stored video poster with the pinned protocol. No user identity, original storage URL, face identification or precise-location claim. Scores remain uncalibrated similarities. |
| Visual similarity search | Existing CLIP pipeline | Unchanged by these hosting adapters. Indexing, visibility checks and deletion continue to be Portava's responsibility. |
| Input writing assistance | Existing writing provider through the Input gateway | Explicit request, a separate insertion action, editable proposal, current field only. No automatic publication or ambient media export. |

Both new transports refuse redirects, bound response bytes and enforce a deadline across response headers and body. Errors omit provider payloads and credentials. Cancellation retires the result. External requests already accepted by a provider cannot be recalled; Portava rechecks consent/source/lease before processing and before storing or publishing a result.

## Provider-bound consent

Caption status returns a receipt containing provider, model version, configuration version and disclosure version. The client displays the provider and submits that receipt only after opt-in. `media_caption_asr_enqueue_v2` compares it under database locks before stamping the consent row. A changed configuration requires a fresh review. Legacy local consent has no managed disclosure receipt and is refused by the managed worker.

Image understanding uses a separate `hf-siglip-v1-…` policy namespace and an explicit `processingProvider: "huggingface"` request field. Local policies cannot authorize managed execution. `GET /api/media/image-understanding/processing` supplies the available policy and disclosure. Availability checks both the provider and queue database flags; unreadable flags produce an unavailable response. There is no automatic opt-in from upload, caption consent, visual search consent or an account-wide preference.

The owner's post overflow menu now mounts `ImageUnderstandingSheet` with per-attachment selection, loaded provider disclosure, explicit opt-in, private consent status, and unverified travel-scene suggestions. Withdrawal remains available with processing disabled or status unreadable. Closing, switching media, backgrounding or changing the owner retires pending work. The transport checks source versions, refuses redirects and unknown tags, and uses a ten-second token/request/body budget. Mounted component, menu ownership and transport tests cover these paths. General availability still requires real inference and device validation.

The models remain behind existing feature flags and owner allowlists. Neither migration enables a flag or inserts a provider key. SQL artifacts are mirrored for the two repository migration workflows; use the appropriate workflow once, not both:

- API migrations `4023_managed_media_processing_consent.sql` and `4024_managed_image_cost_semantics.sql`.
- Supabase CLI-generated migrations `20261113130932_managed_media_processing_consent.sql` and `20261113131420_managed_image_cost_semantics.sql`.

## Deployment configuration

The two migrations were applied to production project `ajrurzioarfkagpuxfnb` on 13 November 2026 before activating any provider. Hosted versions are `20261113141121` (consent) and `20261113141138` (cost semantics). The API canonical ledger was reconciled to prevent a second application:

| Canonical file | SHA-256 |
| --- | --- |
| `4023_managed_media_processing_consent.sql` | `aded73c56f2bd91ba185ec30ce9fdecb456e3e344203ea10982f601c6bd01085` |
| `4024_managed_image_cost_semantics.sql` | `3ec9b5770e8ed590f0a1b914f6c54a8d5ac70cc862b5083ef479319c4d2aff53` |

Hosted verification confirmed the provider/disclosure columns and v2 consent RPC. `authenticated` cannot execute it; `service_role` can. The existing `media_caption_asr_enabled`, `media_derivative_jobs_enabled` and `media_vision_provider_enabled` flags remain **false**. `media_captions_enabled` remains **true**, unchanged. Security advisors returned the same 272 preexisting findings before and after, with zero new findings when excluding observation timestamps. This is not a claim that unrelated advisor findings are resolved.

Keep provider credentials server-side. Do not put them in `EXPO_PUBLIC_*` values or client bundles.

For managed captions, configure `MEDIA_CAPTION_ASR_PROVIDER=deepgram`, `MEDIA_CAPTION_ASR_DEEPGRAM_KEY`, an absolute approved `MEDIA_CAPTION_ASR_FFMPEG_PATH`, `MEDIA_CAPTION_ASR_MODEL_VERSION=deepgram:nova-3:<validated-provider-version>`, a new `MEDIA_CAPTION_ASR_CONFIG_VERSION`, and the validated language allowlist. Floating `latest`/`beta` pins are refused. The private `media_caption_asr_config` row must match those versions, use `processing_provider=deepgram`, and obtain `runtime_verified_at` from a successful evaluation. Existing caption/queue flags and `MEDIA_CAPTION_ASR_ENABLED` still apply. Enabling without this evidence is not part of this change.

For managed SigLIP, deploy `tools/media-vision/handler.py`, `worker.py`, `model-manifest.json` and the approved model files to a dedicated authenticated Hugging Face endpoint. Use an audited, version-pinned Python environment as required by the existing worker runbook. Configure `MEDIA_VISION_EXECUTION=huggingface`, `MEDIA_VISION_HF_ENDPOINT`, `MEDIA_VISION_HF_TOKEN`, the existing image-understanding flags/owner allowlist, and a new `MEDIA_IMAGE_UNDERSTANDING_APPROVED_POLICY=hf-siglip-v1-<reviewed-deployment>`. The model identifier remains `self_hosted_siglip`: it is Portava's pinned worker hosted on managed infrastructure, not a general hosted model router. Restrict endpoint access, disable request-body logging and verify the hosting region, retention and capacity before enabling it. Default local execution remains available.

Paid provider/hosting costs are recorded as **unknown (`null`)**, not zero, until billing evidence is available. Cached caption reads do not incur another inference request. Record real provider usage and billed cost before making efficiency claims.

## Verification and release evidence

Local checks cover provider payload restrictions, MIP opt-out, model fallback refusal, timestamp validation, timeouts, cancellation, response size limits, endpoint restrictions, private drafts, provider-specific client copy and receipt transmission. Executable PostgreSQL tests cover consent epochs, grants, provider/config changes, legacy consent, transaction rollback, RLS/execute permissions, image result cost semantics and revocation.

The surrounding media/input work also adds viewer-scoped signing and cache retirement, bounded image recovery with manual retry, durable upload-journal failure handling, explicit writing proposals in composers, and bounded consent/settings/paste/location transports. New regressions are included in `test:system-quality`; SQL fixtures and Python worker tests run separately.

Before assigning a production A++ grade, collect real multilingual caption accuracy and timing results, image calibration against consented travel examples, provider latency/failure/billing samples, revocation/deletion evidence, accessibility checks and device playback/upload evidence. Provisioning and those live/device checks remain outstanding. The earlier broad test invocation included a live-database test whose safety guard correctly refused to run without a sanctioned test database; local mock and PGlite results do not replace it.

Primary provider references checked for this implementation: [Deepgram prerecorded speech](https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded), [Deepgram data and opt-out controls](https://developers.deepgram.com/trust-security/your-data), [Hugging Face custom endpoint handlers](https://huggingface.co/docs/inference-endpoints/guides/custom_handler).

### Local validation results

- API system-quality suite: **1,620 passed**, zero failures/skips.
- Client system-quality suite: **516 passed** across 69 suites; the additional consent-loading regression then passed with the focused 15-test consent/location run.
- Caption consent migration: executable PostgreSQL/PGlite transaction test passed. Image artifact/migration suite: **9 passed**. Python worker/hosting adapter: **6 passed**.
- The 213-test media failure recheck and the tombstone-access suite passed with isolated fixture configuration.
- API and client runtime type checks passed; test type-check debt remained at the existing API **860/113 files** and client **144/54 files** baselines. No baselines were relaxed.
- Changed TypeScript lint: zero errors, existing/new warnings remain; mock lint and orphan-test checks passed with no newly orphaned tests.

All provider responses in these checks were synthetic. No provider accuracy, production latency, production billing or iPhone behavior is inferred from these results.

### Consent UI and replacement-policy follow-up

- Focused consent/transport/post-detail client run: **58 passed**, 8 suites.
- Image-understanding API run, including disabled/unreadable database flags: **17 passed**.
- Provider comparison checker: **8 passed** using synthetic adversarial receipts, covering segment regressions, uncertainty, stale/missing evidence, duplication, privacy failures and CLI refusal. No candidate provider was benchmarked by these tests.
- Both runtime type checks passed. Test type debt stayed at API **860/113 files** and client **144/54 files**, without changing baselines.
- Focused lint: zero errors, 40 warnings; mock lint passed; orphan check found zero new orphaned tests. `git diff --check` passed.
- Application/worker code remains local; only the two documented database migrations were applied. Inference flags remain off, and no iPhone build was run.
