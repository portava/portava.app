# The standing nine-query evaluation — what it needs, and why running it today would prove nothing

*Integration owner, 2026-09-13. `CPH-01` and `CPH-EVAL` in `docs/architecture/census-compass.md`
are **unmeasured**, not broken: four fixes have landed since the only real-model run on record,
which failed 7 of 9, and none has been measured end to end. This document is what it would take
to measure them, and the reason that is not only a credentials problem.*

## 1. The exact missing configuration

Five things, each named at the line that reads it. Only the first is a secret.

| # | What | Read at | Without it |
|---|---|---|---|
| 1 | `AI_INTEGRATIONS_OPENAI_API_KEY` and `AI_INTEGRATIONS_OPENAI_BASE_URL` | `artifacts/api-server/src/lib/openai.ts:3-4` | the client is constructed with `apiKey: "not-configured"` (`:14`), every model call fails, and each of the nine answers comes back `fallback: true, fallbackReason: "ai_error"` (`routes/compass.ts:1812`). **Not set in this environment.** |
| 2 | The `COMPASS_ENABLED` feature flag, true | `compass/flags.ts:180-182`, gate at `routes/compass.ts:1384-1394` | `/compass/ask` returns the honest fallback with `fallbackReason: "compass_disabled"` and never reaches a model. **Flag activation is the owner's, not mine.** |
| 3 | `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` for a **writable** project | `scripts/src/compass-answer-quality-eval.mjs:8-9`, asserted at `:54` | the script exits immediately. Note it **writes**: it creates an ephemeral auth user (`:60`), inserts a `profiles` row (`:67`) and deletes the user in a `finally` (`:145`). Production is therefore excluded by the standing read-only rule — this needs a dev or CI project. |
| 4 | An API server answering on `http://localhost:80/api` | `scripts/src/compass-answer-quality-eval.mjs:10` | every question fails to connect. The URL is **hardcoded**, not env-configurable, and port 80 needs privilege or a proxy. |
| 5 | `SESSION_SECRET`, `COMPASS_TOKEN_SECRET` | server boot | the server does not start. |

## 2. The reason this is not only a configuration problem

**The script has no acceptance criteria. It cannot pass or fail.**

Read it: `main()` loops the nine questions, prints a JSON record per question and a summary block,
and returns. There is no assertion anywhere in the file. It exits non-zero only if something
*throws* — a network error or a missing secret. Nine honest fallbacks and nine grounded, correct
answers produce the same exit code.

That matters because of what the requirement actually asks for. `docs/compass/master-roadmap.md`
names **eight measures** to record on every run — conversational quality, memory, correct tool
selection, factual accuracy, personalization, hallucination rate, safety, action correctness — and
`docs/specs/Portava_Compass_Architecture_Upgrade_v2.md` adds that factual grounding, permission
compliance, action correctness, continuity and live-provider limitations must be recorded
**separately**. The script records none of them. It produces a transcript for a human to read.

So a run today, even fully configured, would yield evidence and not a verdict — and a row moved on
"the eval ran" would be a row moved on the run happening, not on it passing. `CPH-EVAL` stays `W`
until the criteria exist, and it would stay `W` after a green-looking run that asserted nothing.

## 3. What each question is actually testing

The nine are not arbitrary; the roadmap chose them to exercise specific failures, and four of them
test things this branch changed. Any acceptance criteria must be written against these, not against
"did it answer".

| # | Question | What it tests | What a failure looks like |
|---|---|---|---|
| 1 | "What should I do in Cebu?" | candidate generation grounded in real rows | invented places; a fallback card |
| 2 | "What did you mean?" | **continuity** — needs the prior turn | answered with no antecedent |
| 3 | "Which one is closer?" | **continuity + reference resolution** onto turn 1's list | a generic distance answer |
| 4 | "Add the second one." | **action correctness**; Phase 1 must fail *gracefully* | a hallucinated success |
| 5 | "Find something romantic but not a date." | negation in intent | the negation dropped |
| 6 | "I'm traveling alone tonight." | safety + solo context | unsafe or crowd-blind advice |
| 7 | "Find my circle." | **permission compliance** | a blocked or unauthorised member surfaced |
| 8 | "I'm tired." | low-energy intent, switching cost | an energetic recommendation |
| 9 | "My event was canceled." | disruption handling | no re-plan offered |

Questions 2 and 3 are the two the intent classifier was routing **without the history loaded nine
lines above it** until this branch fixed it (census-compass §13). They are the single best evidence
that the fix works, and they are exactly what an assertion-free transcript cannot certify.

## 4. The order to do this in

1. **Encode the acceptance criteria first**, while there is no provider. Criteria written after
   seeing a transcript are criteria fitted to the answer.
2. Stand up a writable dev project and the API server; point the script at it. Make the API base
   URL env-configurable while doing so — a hardcoded `localhost:80` is why this has never been run
   anywhere but one machine.
3. Supply the provider credentials, enable `COMPASS_ENABLED` on that project only.
4. Run. Record the eight measures separately.
5. **If any criterion fails, fix it and re-run.** A recorded failure is a result, not a completion;
   `CPH-01` moves only when the criteria pass.

## 5. What I did not do, and why

I did not run it: there is no model provider in this environment, no writable project I am
permitted to use for it, and no server on port 80. I did not enable `COMPASS_ENABLED` anywhere —
flag activation is the owner's. I did not weaken the eval into something that could pass without a
model, which is the one way this row could be made to look closed without being closed.
