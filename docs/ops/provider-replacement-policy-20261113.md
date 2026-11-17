# Provider replacements: quality before cost

Owner direction, 13 November 2026: prefer available open-source implementations and operate them in-house **only if they are equally good or better than the paid service**. Preserve the configured implementation until that is demonstrated. This policy does not enable inference, migrate production data or switch providers.

## What the source audit found

These are integrations referenced by the code, not a statement that each is active, billed or provisioned. No account billing audit was performed. Open software still needs compute, storage, operations and, in some cases, licensed source data. The table is a candidate shortlist, not a parity certificate.

| Capability / existing integration | In-house candidate | Evidence required before replacement |
| --- | --- | --- |
| Caption drafts / optional Deepgram | Existing local `faster-whisper` adapter and pinned Whisper weights | Paired transcription, timing, language and hallucination measurements, including silence, noise, accents and code switching; load and failure recovery |
| Image understanding / optional dedicated Hugging Face endpoint | Existing local pinned SigLIP worker, using the same model and protocol | Travel-scene precision/recall, abstention and privacy checks; local runtime compatibility, latency and throughput. Identical weights alone do not establish operational parity |
| Visual search / CLIP | Existing local CLIP pipeline | Retrieval relevance, cold start, index freshness, visibility isolation and deletion; no new paid service needed |
| Compass, Input writing, translation / OpenAI integration | A separately qualified open model served through vLLM or another audited runtime | Grounded answers, tools, multilingual quality, structured outputs, long requests, refusal and latency. OpenAI-compatible HTTP does not make model names, tools or image endpoints interchangeable |
| Stamp/visual image generation / OpenAI integration | No model selected yet | Separate prompt adherence, image quality, safety, model/weight licensing and hardware evaluation; do not redirect image generation to a text-only server |
| Geocoding / Mapbox and Google references | Self-hosted geocoder and licensed geographic data, candidate Nominatim | Coverage and accuracy in Portava's markets, multilingual names, address quality and freshness |
| Places/photos / Google and Foursquare | Open geographic data plus Portava-owned or licensed place/media records | Venue completeness, current hours, closures, photo rights and attribution. A tile server does not replace a POI/photo dataset |
| Map rendering/tiles and routing / Google route integrations, existing MapLibre | Owned tile serving and OSRM-class routing | Route validity, travel-time accuracy, modes, geographic coverage, map readability and offline behavior; live traffic requires a separate data source |
| Voice/video / LiveKit service | Self-hosted LiveKit | TURN/NAT reachability, packet loss, reconnects, mobile handoffs, concurrency and regional latency |
| Database/Auth/Storage / Supabase | Self-hosted Supabase | Restore drills, migrations, JWT/session behavior, RLS, signed object URLs, deletion, replication and capacity. No live migration authorized by this shortlist |
| Cache/rate limits / Redis integration | Existing self-hosted compatible cache or qualified Valkey | Lua/transaction behavior, TTLs, contention, failure policy, durability and recovery for the exact commands used |
| Error reporting / Sentry; telemetry / OpenTelemetry | Qualified GlitchTip plus self-managed OpenTelemetry/Grafana backends | Mobile SDK coverage, source maps, grouping, alerting, retention and operator recovery; compatibility is measured per feature |
| Weather / Open-Meteo references | Owned ingestion/serving of permitted weather data | Forecast quality, geography, update cadence and upstream data access. Public open APIs are external services until hosted in-house |
| Event search / Ticketmaster references | Portava events plus permitted open/partner feeds | Coverage, cancellations, ticket links, freshness and usage rights; crawler code is not a replacement for licensed event inventory |
| Payments / Stripe Connect | Keep the payment-network provider; orchestration can stay in-house | Open-source software does not supply acquiring, settlement or card-network access |
| Identity / Stripe Identity, Persona, Sumsub | No equivalent selected | Fraud resistance, document/liveness coverage and trusted verification sources require separate review; OCR alone is not equivalent verification |
| Phone verification / Twilio | Keep a carrier-connected delivery provider unless an equivalent delivery route is proven | Global reach, deliverability, abuse resistance and carrier connectivity cannot be supplied solely by local application code |
| Push notifications / Expo/native platform integration | Own scheduling and delivery orchestration where useful | APNs/FCM device delivery still relies on platform infrastructure; preserve token lifecycle, delivery and privacy |

Primary source anchors include `src/lib/openai.ts`, `src/lib/media/captions/runtime.ts`, `src/lib/media/vendors/imageUnderstandingManaged.ts`, `src/services/geocodingService.ts`, `src/lib/foursquarePlaces.ts`, `src/lib/eventsCache.ts`, `src/lib/calls/livekitService.ts`, `src/services/payments/StripeConnectProvider.ts`, `src/services/identityVerification/providers.ts`, and `src/services/phoneVerification/smsProvider.ts` under `artifacts/api-server`; client telemetry lives in `travel-buddy-standalone/src/lib/sentry.ts`.

## Executable offline comparison

`scripts/check-provider-parity.mjs` reads a preregistered policy and paired benchmark evidence. It changes no production configuration. `scripts/src/provider-parity.mjs` contains the required score dimensions for each supported workload. The root system-quality command runs the checker's regression tests.

1. Select the task profile and freeze a held-out case manifest **before** running either provider. Include every supported language, priority market and difficult use case as required segments. The immutable floors are 100 distinct inputs overall and 30 per segment; these are screening floors, not adequate power or representativeness guarantees.
2. Hash the policy with `node scripts/check-provider-parity.mjs --policy-hash POLICY.json`. Record that digest in the benchmark receipt. Use the same case IDs and input hashes for both implementations, with pinned model revisions, runtime and configuration digests. Do not include raw user content or credentials in evidence files.
3. Execute both providers on the same inputs. Record every response, including errors/timeouts, latency, output hashes, and every required quality dimension. Scores use the same documented normalization and rubric, from zero to one, higher better. Failed requests score zero. Use reference checks and blinded review. Review the candidate code and weight licenses for the intended use; open weights are not automatically unrestricted open source.
4. Run `node scripts/check-provider-parity.mjs --policy POLICY.json --evidence EVIDENCE.json`. Exit 2 means blocked/incomplete; exit 0 means **offline screen passed**, never approval to replace. The output always says `eligibleForReplacement: false`.
5. Review sample selection, statistical power and absolute product quality, then run production-like load, outages, deletion/revocation and recovery checks. Only a bounded canary with a working rollback and satisfactory live measurements can support a separate cutover decision. Parity with a weak baseline does not earn an A++ grade.

The checker rejects stale (over 30 days), future-dated, synthetic, unreviewed, mismatched or incomplete evidence; repeated inputs cannot inflate sample counts. Every required score, availability and p95 latency must avoid regression overall **and** within each segment. Critical failures block regardless of averages. A one-sided normal approximation for the paired mean difference also blocks uncertain quality comparisons. This is a descriptive uncertainty screen, not a multiple-comparison-adjusted confidence guarantee or proof of equivalence. Production and expert review remain necessary.

### Receipt structure

Policy fields: `schemaVersion: 1`, `profile`, `registeredAt` (UTC), `heldOut: true`, `datasetSha256`, `requiredSegments`, and `cases` with unique `caseId`, `inputSha256`, and `segments`.

Evidence fields: `schemaVersion: 1`, `kind: "live"`, `policySha256`, `datasetSha256`, `startedAt`, `completedAt`, `baseline`, `candidate`, `review`, and `pairs`.

Each provider identity has `id`, pinned `revision`, `configSha256` and `runtimeSha256`. The candidate also requires `hosting: "in_house"` and `licenseReview: { id, approved: true }`. The review requires `id`, `blinded: true`, `referenceChecked: true` and `completedAt`. Each pair repeats `caseId` and `inputSha256` and contains a baseline/candidate result: `ok`, positive `latencyMs` (including time spent on failures), `criticalFailures`, `outputSha256`, and a `quality` map containing exactly the profile's dimensions. Review IDs refer to separately retained review records; the checker validates the receipt, not the truth of an attestation.

### Current evidence

No in-house replacement has qualified. The comparison-checker tests use synthetic receipts; they say nothing about real provider quality. After the owner requested use of the current machine, isolated runtimes and pinned SigLIP, Whisper Turbo and Qwen weights were provisioned on the M4 Pro Mac with 24 GB memory. Real local inference completed, exposed a caption decoder incompatibility and silence hallucination (now guarded), and rejected the small writing candidate for intent/grounding and embedded-instruction failures. See `tools/local-inference-lab/README.md` and its recorded results. There is still no configured paid baseline or paired, reviewed live dataset. No production provider was replaced.

## Primary references checked

- [faster-whisper](https://github.com/SYSTRAN/faster-whisper), [SigLIP model files](https://huggingface.co/google/siglip-base-patch16-224/tree/main), [CLIP license](https://github.com/openai/CLIP/blob/main/LICENSE).
- [vLLM server quickstart](https://docs.vllm.ai/en/stable/getting_started/quickstart/), [LiveKit self-hosting](https://docs.livekit.io/transport/self-hosting/), [Supabase self-hosting](https://supabase.com/docs/guides/self-hosting/docker).
- [OSRM service API](https://project-osrm.org/docs/v26.6.1/http), [MapLibre Martin tile rendering](https://maplibre.org/martin/sources-styles/rendering/).
- [Valkey migration compatibility](https://github.com/valkey-io/valkey-doc/blob/main/topics/migration.md), [GlitchTip compatibility scope](https://glitchtip.com/documentation/contribute/), [self-managed OpenTelemetry backends](https://grafana.com/docs/opentelemetry/).

These references establish candidate capabilities and deployment options, not parity on Portava's workload. Verify the exact release and model licenses again when pinning a deployment.
