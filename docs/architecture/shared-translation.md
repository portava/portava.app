# Shared translation: self-hosted, authorized, derived

This main-application lane reuses `TranslationProvider` in
`artifacts/api-server/src/lib/translation.ts`. Telegraph and content translation
use the same provider and protected-text helper. There is no new paid-provider
fallback, shared queue, media registry, caption processor, dubbing processor, or
database migration.

## Runtime selection

`getTranslationProvider()` defaults to `self-hosted`. It requires both
`TRANSLATION_SELF_HOSTED_URL` and a private `TRANSLATION_SELF_HOSTED_TOKEN` of at
least 32 characters. An absent model/configuration is unavailable, never a mock
translation. Unknown provider names, including `openai`, are unavailable. The
existing OpenAI class remains for compatibility/offline tests but is no longer
selected by the production factory. Mock selection requires explicit `mock`
plus `NODE_ENV=test`; test injection remains available to existing suites.

The existing `TRANSLATION_ENABLED=false` switch still disables the content and
message services. No flag or environment was activated by this implementation.

The adapter only accepts literal loopback HTTP endpoints (`127.0.0.1` or `::1`),
without userinfo/query/fragment/path. It does not follow redirects. Use a worker
on the API host or a separately authorized private local proxy; remote TLS,
deployment, credentials, and routing are not provisioned here. Requests and
responses have size/deadline limits, and model failures never expose worker
error details or fall back to an external provider.

## Actual local model runtime

`artifacts/api-server/scripts/translation-runtime.py` is a standalone loopback
HTTP runtime using locally provisioned **CTranslate2 + SentencePiece**. It does
not download, install, convert, or update models. With no model/dependencies,
authenticated `/health` returns 503 with `ready:false`, no language pairs and
no provider identity. Unauthenticated requests receive 401. Request text and
translations are not written to disk or request logs.

The API request process never starts Python or model inference. It only performs
bounded HTTP I/O against an already-running, explicitly configured runtime.
The standalone runtime limits accepted connections to eight with five-second
socket read deadlines, and limits model execution to one request at a time.
There is no request-to-subprocess bridge in the application.

An explicitly provisioned model directory must contain:

- `translation.json`: `{"source":"es","target":"en"}` for the actual trained
  pair, not a claim that the example pair is installed or evaluated.
- `source.spm` and `target.spm`: the matching SentencePiece tokenizers.
- `model/`: a compatible converted CTranslate2 translation model, including
  `model.bin`, configuration and vocabulary files.
- Optionally `language-identification.bin`: a separately provisioned fastText
  language-identification model, plus the local fastText runtime. Without it,
  detection is unavailable; no heuristic English/source-language guess is made
  by this runtime.

The implementation is for a single explicit source/target model pair, using
SentencePiece token strings. It does not claim compatibility with every
multilingual model, special-token convention, model license, or language. More
pairs require a separately reviewed local runtime expansion, not hard-coded
accuracy claims. Model provenance includes the runtime version and a SHA-256
over the manifest, tokenizers and model files actually loaded.

For an authorized isolated run, pass `--model-dir /approved/local/model` and
`--port <approved-local-port>` with the private token in the environment. The
default port is ephemeral. This is not a deployment instruction or activation.
Only one inference runs at a time; concurrent work receives `translation_busy`.
Input is bounded at 8,000 characters/1,024 source tokens; capped output is
rejected rather than silently truncated. Client cancellation bounds the HTTP
wait, not an already-running native model operation. The parent-owned worker
supervisor must provide process/resource deadlines for production operation.

The direct inference API follows the primary
[CTranslate2 Translator documentation](https://opennmt.net/CTranslate2/python/ctranslate2.Translator.html).
No real model/dependencies were installed or evaluated in this change.

## Shared authorized service: captions / dubbing / content

Export `createAuthorizedTranslationService` from
`artifacts/api-server/src/services/platformTranslation.ts`.

Construct once with `{ loadAuthorizedSubject, provider?, enabled?, now? }` and
call `.translate({ viewerId, subjectId, targetLanguage })`. The mandatory loader
must re-read authoritative access, block/deletion state, source generation and
viewer preferences; return `null` for refusal. Otherwise return:

```ts
{
  revision: string,
  protection: 'server-readable' | 'e2ee',
  sourceLanguage: string,
  fields: Record<string, string>,
  preferences: { enabled: boolean, targetLanguage?: string }
}
```

E2EE subjects are denied before cache/provider use. Never send decrypted E2EE
text from a client to this service. The API has no arbitrary plaintext
translation endpoint. The loader is a security boundary, not a caller-supplied
`authorized:true` assertion.

Success returns `status:'translated'`, `fields`, `sourceRevision`,
`sourceLanguage`, `targetLanguage`, `provider`, and `providerVersion`.
Other results have empty fields and `status:'skipped'|'unavailable'|'denied'`.
Use cue IDs as field keys; timing stays with the captions worker. Dubbing can
consume the same result without duplicating translation. Persist derived media
with the original `sourceRevision`/generation CAS and recheck the caller's own
publication policy: the service does not grant later publication authority.

The bounded in-memory cache partitions viewer, subject, target, generation,
original fields and preferences. Every retrieval reauthorizes, including a
second read before returning provider or cached output. Changed/deleted/blocked
sources cannot return a stale result. Cache is at most 64 entries, 60-second
TTL; it is not durable storage or a cross-process queue. Observed denial purges
that subject's entries; `clear()` is available to owning lifecycles. No source
row is overwritten. URLs, emails and mentions are carried byte-for-byte outside
translated spans. Splitting context can affect quality; preservation tests do
not establish accuracy.

## Existing application integration

- `/api/content/:entityType/:entityId/translation` keeps its authenticated,
  per-entity authorization path and uses the shared service for post captions,
  comments, event/trip text and bios. It reads the viewer's existing preferred
  language, refuses block/deletion/access failures and returns `private,
  no-store`. `followers_only` and unknown post visibility cannot bypass the gate.
- That route deliberately does **not** trust legacy `content_translations`
  rows: their schema has no source fingerprint/generation. Existing legacy
  service/cache invalidation remains compatible, but is not the route's cache
  authority. No additional plaintext derivative table is introduced.
- Telegraph keeps existing message preference/display/provenance behavior and
  E2EE send/retry guards. The preference-change sweep additionally rechecks
  current thread encryption, ciphertext, membership/history bounds, deletion,
  blocks, preferences and source identity before provider work and publication.
  Existing kernel/history switches and own-message history exception are reused.
- `useContentTranslation` uses viewer/entity/language/source-revision identity,
  clears stale state, rejects late responses and only toggles an available
  translation. It reuses existing settings, not a second settings system.
  `CommentsSheet` supplies the comment body/edit revision, so an edited comment
  immediately returns to its current original while translation is pending.
  An unavailable model does not leave a dead translation toggle. The existing
  language preference context reloads per account and rejects late reads/saves
  after logout or account change. Settings explain model-dependent availability
  and label the null preference honestly, rather than claiming device-language
  resolution. No second settings store is introduced.
  Posts/events/trips/bios have an authorized API path, not newly integrated
  display components in this lane; replies are not newly wired either. This
  change does not retrofit every component or add realtime deletion subscriptions.
  The original remains the caller's authoritative display text.

## Remaining acceptance dependencies

Provision and independently evaluate the actual local model/tokenizer pair and
optional detector, including license, language quality and resource limits.
Then obtain deployment/activation approval and prove the built application's
real end-to-end text/caption/dubbing paths. No accuracy, universal-language,
E2EE server-translation, full-device, or Media-100% claim follows from fixtures.
