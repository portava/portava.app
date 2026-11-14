# Event-driven external-provider updates

Implemented in code; not active until committed/deployed and the release/evaluation sources, GitHub credentials and branch protection are configured. There is **no scheduled discovery, catalog polling, app timer or live model lookup on a user request**.

`config/external-integrations.json` inventories 21 external integrations. It distinguishes model/SDK version pins from provider-managed services. The inventory is not a claim that every provider has a release webhook, that every connection is active, or that any new version has qualified. Where a vendor offers no release event, a trusted release relay must supply one. Without that source the update waits; instant automatic detection cannot be promised without polling.

## Flow

1. A trusted provider webhook/release relay sends GitHub `repository_dispatch` with event type `provider-release`. Its `client_payload` contains `event`, `eventSignature`, `evidence`, `evidenceSignature`.
2. The release relay and an independent evaluation service sign their objects using **different** HMAC-SHA256 keys. Objects use recursive sorted-key JSON serialization (`canonical` in the script). Only metadata/version information belongs in these events, never user prompts, images, transcripts or credentials.
3. The gate validates the known provider/source URL, timestamp, exact baseline commit and registry hash, model adapter contract, account access, privacy/safety, rollback, tests, cost and p95 latency. AI updates additionally require at least 100 held-out reviewed cases, at least 30 per segment, blinded/reference-checked results and a nonnegative quality lower bound. A valid signature authenticates the evaluation service's attestation; it does not itself prove the evaluation was truthful. The evaluator and retained result artifact must be independently maintained and audited.
4. A qualified event updates a **specific** model binding or installed SDK package. Model history retains earlier versions for queued jobs and rollback. Models are read locally at API startup, with no per-request network/DB lookup. The current OpenAI text/image defaults and Higgsfield image/video endpoints use this registry. Explicit operator model overrides still take precedence.
5. A GitHub workflow prepares lockfiles, creates a PR, and queues automatic merge only when the branch requires the complete `CI · verdict (skipped or cancelled is not a pass)` check. A dedicated GitHub App/PAT is required so the PR actually triggers CI. Existing deployment automation must roll out the merged revision; this workflow does not invent deployment credentials or deploy directly.

All supported SDK releases, including major releases, need the same compatibility evidence and required CI. Native SDK changes remain blocked by the owner's instruction not to build iPhone until requested. New API protocols, consent/config versions, model weight/runtime migrations, financial contracts and unknown model adapter shapes produce `adapter_migration_required` or a blocking result; they cannot safely be rewritten from a release announcement alone. Deepgram's model/config/consent pin and Hugging Face's weights/runtime contract must migrate together, so neither currently receives a blind runtime model substitution. Services whose backend/data updates are vendor-managed need compatibility monitoring rather than a model selector.

## Setup

GitHub repository secrets:

- `PROVIDER_RELEASE_EVENT_SECRET`: at least 32 characters, held by the trusted release relay.
- `PROVIDER_EVALUATION_SECRET`: different key, held by the evaluation service.
- `PROVIDER_UPDATE_GITHUB_TOKEN`: scoped App/PAT able to create update branches/PRs and read branch protection. Its PRs must trigger CI. Do not bypass branch protection or required reviewers.

The workflow runs only on release dispatches. No release subscriptions or evaluator credentials were available in this workspace; none have been fabricated or silently enabled. A manual/operator dispatch of a **real** signed event uses the same gate. A failed signature, missing check, quality/cost/latency regression, stale baseline, unsupported migration or unavailable branch protection blocks the update instead of silently picking a fallback model.

Event fields: `id`, `provider`, `kind` (`model`, `sdk`, `contract`), `publishedAt`, `releaseUrl`; model: `binding`, `previous`, `version`; SDK: `package`, `previous`, `version`. Evidence fields and executable synthetic examples are in `scripts/provider-release-events.test.mjs`. Never use those synthetic fixtures as live evaluation receipts.

Rollback: revert the qualified update commit (including lockfiles) and redeploy through the normal deployment path. Existing image/video jobs retain their original model, request body and provider idempotency key. Do not change credentials, callback URLs or request headers while recovering an ambiguously accepted submission.

Verification: signed-event, independent-signature, stale-commit, source-origin, quality/privacy/cost/contract rejection, native-build guard and no-polling tests. No provider was upgraded and no automatic merge or deployment occurred in this session.

Sources: [OpenAI version stability and evaluations](https://developers.openai.com/api/reference/overview), [Deepgram's model catalog/version metadata](https://developers.deepgram.com/reference/manage/models/list), [Higgsfield model contracts](https://open.higgsfield.ai/explore), [GitHub repository dispatch](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#repository_dispatch).
