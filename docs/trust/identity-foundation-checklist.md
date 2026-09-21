# Identity-verification foundation — the shared checklist

*Requirements role, 2026-09-14, worktree at `ebca2f95c`. This file states obligations and how
to prove them. It grades nothing, moves no census verdict, and contains no product code.*

| | |
|---|---|
| **What this is** | One checklist that Implementation builds against and Verification checks independently, derived from the owner's two specifications and the two existing mappings. |
| **Authoritative sources, in priority order** | 1. `docs/specs/upgrades-v2/03-TRUST-v2.md` · 2. `docs/trust/verified-foundation-plan.md` · 3. `docs/architecture/census-trust.md` (requirement IDs and verdicts) · 4. `docs/trust/compliance-v1.md` (clause mapping). |
| **Verdict column** | **Carried from census-trust, never re-graded here.** `C` BUILT-AND-CORRECT · `W` BUILT-BUT-WRONG · `NB` NOT-BUILT · `CV` CANNOT-VERIFY · `—` a duplicate mapping the census deliberately does not grade separately. Last-statement-wins: §17 of census-trust is the current word on `TV-1a` (`C`) and `TV-6c` (`C`), §14/§13 on `TV-P5` (`C`), `TV-7a` (`C`), `TV-7b` (`C`). |
| **Row count** | **55** — **31 BUILDABLE NOW**, **24 BLOCKED**. |
| **Paths** | Repository-relative from the worktree root. Every `file:line#needle` anchor was opened at this tree. |

---

## 0. Scope — where the line is drawn, explicitly

**IN.** The path from a user starting verification to a provider result landing, being stored,
and reaching every gate that consumes it:

session creation → provider adapter contract → webhook receipt → signature verification →
`identity_verifications` writes → `profiles.verification_level` / `verified_at` → `is_over_18`
→ the gates that read them → revocation → retention and erasure → the badge and label surfaces
that display the result.

**OUT.** Trust **scoring** — event eligibility, category weights, decay, caps, thresholds,
serious findings, recovery, earning caps, dedup windows. Those are inventoried in
`docs/trust/scoring-parameters-for-ratification.md` and are not restated here.

**The two places the line is crossed on purpose, and why:**

1. **The identity award is a direct consumer of an identity outcome.**
   `IDENTITY_VERIFIED` is +10 `respect_safety`
   (`artifacts/api-server/src/services/trust/TrustEventService.ts:815#IDENTITY_VERIFIED:`),
   emitted on the transition to `verified`. The *emission and its idempotency* are in scope
   (IDF-21); the *size and category of the delta* are not — they are D-SCORING, listed in §6.
2. **`C22` — ceiling-only override persistence.** This is an admin-scoring row, not an identity
   row. It is in this checklist because **the owner named it as a must-fix** and it needs a
   single shared statement of what is actually missing. It sits in its own annex (§4, rows
   IDF-50…IDF-54) so that no reader mistakes it for part of the identity path.

**Out of scope and stated so no one re-derives it:** `TV-7a` (provider erasure ordering) is
**CLOSED**. It is carried below as `C` with its proof, not reopened. Reports calling it an open
GDPR hole are quoting census-trust §12.4, which §13.1 and §17's opening paragraph superseded.

---

## 1. ID preservation ledger — nothing disappears

Every existing `TV-*` / `TRV2-*` identifier that touches the identity foundation appears in at
least one checklist row, and its `Existing requirement ID(s)` cell names it. This checklist adds
`IDF-nn` ids; **it does not retire, renumber or merge any census id.**

**Splits (one existing id → several checklist rows).** A split never changes the census row's
scope; it separates criteria that Implementation ships and Verification proves at different
times.

| Existing id | Split into | Why |
|---|---|---|
| `TV-P2` | IDF-14, IDF-18 | The invariant has a verification-table half (holds) and a `profiles` half (does not). They have different blockers. |
| `TV-1c` | IDF-19, IDF-20 | The write and the vocabulary the write must satisfy are blocked by two different decisions (`D-2870-APPLY`, `D-LEVEL-VOCAB`). |
| `TV-5b` | IDF-23, IDF-24 | "gates read `is_over_18`" and "unverified users see a gate, not silent hiding" are separately testable and separately owned. |
| `TV-6b` | IDF-09, IDF-45 | The adapter code exists and is unit-tested; the sandbox transcript does not. |
| `TV-4c` | IDF-30 | Not a split — listed so the reader sees where the one identity-touching moderation row went. `TV-4a`, the queue itself, is **excluded** (§7). |
| `C22` | IDF-50…IDF-54 | One census row, five distinct executable obligations. §4 gives the reasoning. |

**Merges.** None. No two census ids were folded into one checklist row.

**New rows (`NEW`).** IDF-25, IDF-26, IDF-27, IDF-51, IDF-52, IDF-53 state obligations no census
row states. They are requirements, not verdicts; the integration lead decides whether any of
them becomes a census row.

---

## 2. Part A — BUILDABLE NOW (31 rows)

Nothing in this table waits on an unapproved scoring-policy decision, an owner configuration
step, or a migration. **This is the set Implementation is given.** Rows already at `C` are here
as *no-regression* obligations: Verification runs the named check and it must stay green.

| Checklist ID | Existing requirement ID(s) | Clause | Current verdict | Blocked by | How Verification proves it |
|---|---|---|---|---|---|
| **IDF-01** | `TV-1a` | `POST /api/verification/session` — auth required; creates the provider session for the caller; upserts the `identity_verifications` row in **`created`** status; returns `redirectUrl` (`docs/trust/verified-foundation-plan.md:35#/api/verification/session`, `docs/trust/verified-foundation-plan.md:36#identity_verifications`) | **C** | NOTHING | `cd artifacts/api-server && node --import tsx/esm --test src/test/verificationSessionCreatedStatus.test.ts` — 2/2. Then `sed -n '239p' artifacts/api-server/src/routes/verification.ts` must contain `"created"` (`artifacts/api-server/src/routes/verification.ts:257#status:`), the column default in `db/migrations/0161_identity_verification.sql:28#default`. |
| **IDF-02** | `TV-1e` | Rate limit: max 3 session creations per user per 24 h — the cost control, since each real-provider session is billable (`docs/trust/verified-foundation-plan.md:44#24h`) | **C** | NOTHING | `node --import tsx/esm --test src/test/verification.test.ts`; the rate-limit case must assert a 4th create in-window is refused. `grep -n 'VERIFICATION_SESSION_LIMIT' artifacts/api-server/src/routes/verification.ts` returns the constant, value 3. |
| **IDF-03** | `TV-0b` | Provider adapter interface + normalized status model — one shape all vendors map onto (`docs/trust/verified-foundation-plan.md:28#types.ts`) | **C** | NOTHING | `grep -n 'export interface VerificationResult' artifacts/api-server/src/services/identityVerification/types.ts` → `artifacts/api-server/src/services/identityVerification/types.ts:58#VerificationResult`; every field optional-or-derived, no raw-document field. `node --import tsx/esm --test src/test/verificationProviderNormalization.test.ts`. |
| **IDF-04** | `TV-0c` | Working mock provider with forced-failure test hints (`docs/trust/verified-foundation-plan.md:29#mockProvider.ts`) | **C** | NOTHING | `grep -n 'TEST_HINTS' artifacts/api-server/src/routes/verification.ts` returns the four hints; `node --import tsx/esm --test src/test/verification.test.ts` exercises each hint to its normalized `failure_reason`. |
| **IDF-05** | `TV-0d`, `TV-G1` | Env-driven factory; built **provider-agnostic** so the vendor is a config decision, not an architecture decision (`docs/trust/verified-foundation-plan.md:30#providers.ts`, `docs/trust/verified-foundation-plan.md:7#provider-agnostic`) | **C** | NOTHING | `artifacts/api-server/src/services/identityVerification/providers.ts:149#IDENTITY_PROVIDER` is the only vendor switch. `grep -rln 'stripeIdentity\|personaCreateSession' artifacts/api-server/src --include=*.ts \| grep -v test` must return files only under `services/identityVerification/` — a hit anywhere else is a vendor leak into architecture. |
| **IDF-06** | `TV-P4` | The mock provider is **refused in production** by the factory (`docs/trust/verified-foundation-plan.md:19#refused`) | **C** | NOTHING | `artifacts/api-server/src/services/identityVerification/providers.ts:154#IDENTITY_PROVIDER=mock` throws. `node --import tsx/esm --test src/test/verificationWebhookProviderUnavailable.test.ts` — the refusal is load-bearing for that suite. |
| **IDF-07** | `TV-1b` | `POST /api/verification/webhook` — **raw-body** route, mounted before the global JSON parser, passing the raw bytes to `provider.handleWebhook` (`docs/trust/verified-foundation-plan.md:38#/api/verification/webhook`) | **C** | NOTHING | `artifacts/api-server/src/routes/verification.ts:314#webhookRawParser` and `artifacts/api-server/src/routes/verification.ts:316#webhookHandler`; `grep -n 'webhookRawParser' artifacts/api-server/src/app.ts` must show the mount **above** `express.json`. |
| **IDF-08** | `TV-P5` | Webhooks are signature-verified in **every real adapter**; an unverified webhook **throws, never silently accepts** (`docs/trust/verified-foundation-plan.md:20#signature-verified`) | **C** | NOTHING | `node --import tsx/esm --test src/test/verificationWebhookSignature.test.ts`. Signature failure must reach `artifacts/api-server/src/routes/verification.ts:372#invalid_signature` (HTTP 400), verified **before** the body is parsed (`artifacts/api-server/src/services/identityVerification/webhookSignature.ts:168#verifyTimestampedHmacSignature`). |
| **IDF-09** | `TV-6b` (adapter-contract half), `TV-U9` | Both real adapters normalize vendor payloads onto the shared result model — including `underage` → `isOver18 = false` — and a mocked test certifies **only** the adapter contract (`docs/specs/upgrades-v2/03-TRUST-v2.md:44#signatures,`) | **W** | NOTHING for this half — the sandbox half is IDF-43 (`D-PROVIDER`) | `node --import tsx/esm --test src/test/verificationProviderNormalization.test.ts`; the two normalizations must remain at `artifacts/api-server/src/services/identityVerification/stripeIdentity.ts:173#underage` and `artifacts/api-server/src/services/identityVerification/persona.ts:134#underage`. |
| **IDF-10** | `TV-1b`, `TV-P5` | "Provider not configured" is **not** "irrelevant": the webhook answers 503 so the provider retries, never 200 (`docs/trust/verified-foundation-plan.md:21#silently`) | **C** | NOTHING | `node --import tsx/esm --test src/test/verificationWebhookProviderUnavailable.test.ts`; `artifacts/api-server/src/routes/verification.ts:357#res.sendStatus(503);` must not become 200. |
| **IDF-11** | `TV-1b` | A persist failure returns 5xx so the provider retries; an unreadable `identity_verifications` **rethrows** rather than resolving as an unknown session (`docs/trust/verified-foundation-plan.md:39#normalized`) | **C** | NOTHING | `node --import tsx/esm --test src/test/verificationWritesIssued.test.ts` and `src/test/verificationStatusUnreadableProfile.test.ts`. `artifacts/api-server/src/routes/verification.ts:389#res.sendStatus(500);` on the catch path; `artifacts/api-server/src/routes/verification.ts:382#persistResult` is the guarded call. |
| **IDF-12** | `TV-1b` | On a normalized result the row is updated with status, normalized failure reason and the derived booleans only (`docs/trust/verified-foundation-plan.md:39#normalized`) | **C** | NOTHING | `artifacts/api-server/src/routes/verification.ts:150#is_over_18:` is inside the single patch object; `node --import tsx/esm --test src/test/verification.test.ts`. |
| **IDF-13** | `TV-P1`, `TRV2-05` | Portava stores **no** raw government-ID images, document numbers or selfies — opaque provider references only — and none of them enters a **log** (`docs/trust/verified-foundation-plan.md:13#government-ID`, `docs/specs/upgrades-v2/03-TRUST-v2.md:23#TRV2-05`) | **C** | NOTHING | Column audit: `grep -n 'is_over_18\|selfie_match\|document_country\|provider_session_id\|provider_verification_ref' db/migrations/0161_identity_verification.sql` must be the whole derived set, with `db/migrations/0161_identity_verification.sql:36#is_over_18` a boolean. Log audit: every `req.log` on the verification path binds only an error object and at most a user id — `artifacts/api-server/src/routes/verification.ts:229#unavailable`. |
| **IDF-14** | `TV-P2` (verification-table half), `TV-P1` | The verification row itself stores **no date of birth**; age is carried as the derived `is_over_18` boolean (`docs/trust/verified-foundation-plan.md:15#birth.`, `docs/trust/verified-foundation-plan.md:16#is_over_18`) | **C** | NOTHING | `grep -in 'birth\|dob' db/migrations/0161_identity_verification.sql` returns only the prose commitment at `db/migrations/0161_identity_verification.sql:8#NEVER` — no column. The `profiles` half is IDF-17/IDF-18 and is **not** closed by this. |
| **IDF-15** | `TV-1d` | `GET /api/verification/status` — the caller's current verification row, as a poll fallback for webhook lag (`docs/trust/verified-foundation-plan.md:42#/api/verification/status`) | **C** | NOTHING | `artifacts/api-server/src/routes/verification.ts:401#verification/status`; the SELECT list is `artifacts/api-server/src/routes/verification.ts:412#is_over_18,` and must carry no provider payload field. `node --import tsx/esm --test src/test/verificationStatusUnreadableProfile.test.ts`. |
| **IDF-16** | `TV-1f`, `TRV2-06` | Trust hook on the **transition** to `verified` — once per transition, not once per delivery: provider webhooks are at-least-once by design and this route returns 5xx to force retries (`docs/trust/verified-foundation-plan.md:46#hook:`) | **C** | NOTHING | `node --import tsx/esm --test src/test/verificationTrustIdempotency.test.ts`. The dedup key must stay non-empty: `artifacts/api-server/src/routes/verification.ts:42#TRUST_SOURCE_TYPE` travels with `providerSessionId` into `artifacts/api-server/src/routes/verification.ts:103#recordTrustEvent`, because `artifacts/api-server/src/services/trust/TrustEventService.ts:242#sourceId` returns `"new"` for a keyless emit. |
| **IDF-17** | `TV-1g` | Tests: mock-provider end-to-end (create → webhook approve → profile level set), forced failures map to the correct reasons, rate limit (`docs/trust/verified-foundation-plan.md:48#end-to-end`) | **C** | NOTHING | `node --import tsx/esm --test src/test/verification.test.ts` green, and `node artifacts/api-server/scripts/check-test-registration.mjs` must list **no** unregistered verification suite — two are unregistered today (`verificationSessionCreatedStatus.test.ts`, `verificationAttemptMetrics.test.ts`); registering them in `package.json` is part of this row. |
| **IDF-25** | **NEW** | **A stored `is_over_18 = false` must defeat the self-asserted date of birth at every 18+ gate.** A provider result that a government document proves the holder is a minor cannot leave the user passing gates on the birthday they typed. | **NB** (no census row states it) | **NOTHING.** Independent of `D-PROVIDER` and of **both** directions of `D-DOB` — see §5 | New suite `src/test/verifiedMinorGate.test.ts`: seed `profiles.date_of_birth` at an adult date **and** a latest `identity_verifications` row with `status='failed'`, `failure_reason='underage'`, `is_over_18=false`; assert every gate refuses. Mutation that must go red: delete the `is_over_18` clause from the gate. Reach check: `grep -rn 'is_over_18' artifacts/api-server/src --include=*.ts \| grep -v test` must return more than the write (`artifacts/api-server/src/routes/verification.ts:150#is_over_18:`) and the status SELECT (`artifacts/api-server/src/routes/verification.ts:412#is_over_18,`). |
| **IDF-27** | **NEW** | The **Rent-a-Buddy booking gate** — the one that pairs strangers in person — must be among the gates in IDF-25, and must refuse on a known-minor signal regardless of whether `requireIdVerification` is on for that location. | **NB** | **NOTHING** | `artifacts/api-server/src/routes/rentABuddy.ts:1854#loadTravelerIdentity` feeds the age comparison at `artifacts/api-server/src/routes/rentABuddy.ts:1869#travIdentity.age`; a case in `src/test/verifiedMinorGate.test.ts` must drive that path with a launch control whose `requireIdVerification` is **false** and still get a 403. |
| **IDF-30** | `TV-4c` | The `verification_revoked` admin action clears `profiles.verification_level` (`docs/trust/verified-foundation-plan.md:85#verification_revoked`) | **C** | NOTHING | `node --import tsx/esm --test src/test/adminUnverifyRevokesIdLevel.test.ts` — 5/5. The write is `artifacts/api-server/src/routes/admin.ts:1655#verification_level:`. |
| **IDF-32** | `TV-7a`, `TRV2-10` (deletion clause) | Account deletion calls `provider.requestProviderDeletion()` **then** deletes the user's `identity_verifications` rows — in that order (`docs/trust/verified-foundation-plan.md:112#requestProviderDeletion()`) | **C — CLOSED, do not reopen** | NOTHING | `node --import tsx/esm --test src/test/verificationProviderErasure.test.ts` — 6/6. Ordering is structural: `artifacts/api-server/src/services/accountDeletion/AccountDeletionService.ts:1002#request_provider_verification_deletion` precedes `artifacts/api-server/src/services/accountDeletion/AccountDeletionService.ts:1016#delete_identity_verifications`; the callee is `artifacts/api-server/src/services/identityVerification/providerErasure.ts:58#requestProviderDeletionForUser`. Swapping the two steps must turn the suite red. |
| **IDF-33** | `TV-7b` | Retention job purges failed/expired verification rows older than **90 days** (`docs/trust/verified-foundation-plan.md:114#90`) | **C** | NOTHING | `node --import tsx/esm --test src/test/verificationRetention.test.ts`. Constants: `artifacts/api-server/src/services/identityVerification/retention.ts:31#PURGEABLE_STATUSES` and `artifacts/api-server/src/services/identityVerification/retention.ts:34#VERIFICATION_RETENTION_DAYS`; the scheduler call is `artifacts/api-server/src/lib/trustMaintenanceScheduler.ts:620#purgeExpiredVerificationRecords` and must remain **above** the `isTrustEnabled` gate, so a scoring flag cannot silently stop a GDPR job. |
| **IDF-34** | `TV-U5` | The plan's retention values apply to the **stated verification records**, not automatically to all Trust evidence; do not rewrite unrelated retention rules (`docs/specs/upgrades-v2/03-TRUST-v2.md:38#retention/reversal`) | **C** | NOTHING | `grep -rn 'VERIFICATION_RETENTION_DAYS' artifacts/api-server/src --include=*.ts \| grep -v test` must return only `retention.ts` and its scheduler call — a reference from any trust-evidence purge is the violation. |
| **IDF-44** | `TV-6c` | **Monitor attempts per verified user** — ">2.0 average means UX friction worth fixing" (`docs/trust/verified-foundation-plan.md:108#friction`) | **C** | NOTHING | `node --import tsx/esm --test src/test/verificationAttemptMetrics.test.ts`. Computation `artifacts/api-server/src/services/identityVerification/attemptMetrics.ts:145#computeAttemptsPerVerifiedUser`, threshold exported not retyped (`artifacts/api-server/src/services/identityVerification/attemptMetrics.ts:57#ATTEMPT_FRICTION_THRESHOLD`), reachable at `artifacts/api-server/src/routes/admin.ts:3577#admin/verification/attempt-metrics` behind `requireAdmin`. |
| **IDF-50** | `C22` | An admin score override is a **CEILING** that must actually persist, and the persist must be **observed, not asserted** (`docs/specs/upgrades-v2/03-TRUST-v2.md:36#ceiling,`; owner ruling **CAP now, PIN later behind a flag**) | **W** | NOTHING — the decision is made; see §4 | `node --import tsx/esm --test src/test/trust-integration.test.ts` — the `D-OVERRIDE: the ceiling the owner ruled for must PERSIST` describe block, 3 cases. The four characterization mutations in census-trust §15.4 (P1–P4) must each turn it red. |
| **IDF-51** | `C22`, **NEW** | **The apply path is guarded and the removal path is not.** `adminRemoveOverride` swallows the lift failure and the recalculation, then audits and returns success regardless — see §4. | **W** (part of `C22`) | NOTHING | New cases in `src/test/trust-integration.test.ts`: with `liftCap` failing, `adminRemoveOverride` must reject, write **zero** `score_override` audit rows, and leave the cap active; with the recalculation failing, likewise. Today both resolve `{ ok: true }` — `artifacts/api-server/src/services/trust/TrustAdminService.ts:468#liftCap`, `artifacts/api-server/src/services/trust/TrustAdminService.ts:480#recalculateTrustScore`, `artifacts/api-server/src/services/trust/TrustAdminService.ts:484#logAdminAction`. |
| **IDF-52** | `C22`, **NEW** | **The one override-adjacent route bypasses the service.** `POST /admin/trust/users/:userId/cap/override` lifts **any** cap by id — a moderation ceiling included — with a fire-and-forget recalculation, and never calls `adminRemoveOverride`. | **W** (part of `C22`) | NOTHING | `grep -n 'adminRemoveOverride' artifacts/api-server/src/routes/*.ts` returns nothing today. A route test must assert: the handler refuses a cap whose `reason_code` is not `admin_override` (or the owner ratifies that an admin may lift a moderation ceiling — an authority question, flagged in §6), and responds only after the recalculation is **observed**, not at `artifacts/api-server/src/services/trust/TrustAdminService.ts:480#recalculateTrustScore`. Route under test: `artifacts/api-server/src/routes/trust-admin.ts:463#admin/trust/users/:userId/cap/override`, lift at `artifacts/api-server/src/routes/trust-admin.ts:502#adminRemoveOverride`. |
| **IDF-53** | `C22`, **NEW** | **The `score_override` audit vocabulary is polluted.** The trust-**settings** route files its audit row under `action_type: "score_override"`, so a query for "who overrode a user's score" returns settings edits. | **W** (part of `C22`) | NOTHING | `grep -n 'action_type' artifacts/api-server/src/routes/trust-admin.ts` — the settings write at `artifacts/api-server/src/routes/trust-admin.ts:626#action_type:` must use its own action type (e.g. `update_setting`), and `trust_admin_actions` rows of type `score_override` must then be exactly the rows written by `artifacts/api-server/src/services/trust/TrustAdminService.ts:396#logAdminAction`. Pin with an assertion in `src/test/trustAdminAuditInsertSchemaDrift.test.ts`. |
| **IDF-47** | `TV-U7` | Isolated fixtures spanning the named classes — **invalid signatures** and **revoked verification** are the two that bind this checklist (`docs/specs/upgrades-v2/03-TRUST-v2.md:44#signatures,`) | **C** | NOTHING for these two classes; the other six are scoring-side and out of scope (§0) | `node --import tsx/esm --test src/test/verificationWebhookSignature.test.ts src/test/adminUnverifyRevokesIdLevel.test.ts`. |
| **IDF-48** | `TV-U11` | Do not enable providers, run backfills, alter scoring policy or activate production flags **merely to close a requirement** (`docs/specs/upgrades-v2/03-TRUST-v2.md:46#badges,`) | **C** | NOTHING — a standing guard rail on every row above | `IMPLEMENTED_PROVIDERS` gaining a non-mock member **without** IDF-45's sandbox transcript turns this row and `TV-U9` red in the same commit. Check by diffing `artifacts/api-server/src/services/identityVerification/readiness.ts:53#IMPLEMENTED_PROVIDERS` against the transcript's existence. |
| **IDF-49** | `TV-U10` | Preserve report/block journeys, **badges, age gates**, Safety Center and existing authorized consumers (`docs/specs/upgrades-v2/03-TRUST-v2.md:46#badges,`) | **C** | NOTHING — a no-regression obligation over IDF-23…IDF-27 and IDF-35…IDF-36 | `node --import tsx/esm --test src/test/ageGate.test.ts src/test/meetupAgeRsvp.test.ts src/test/circleInviteAge.test.ts` must stay green through the IDF-25 work. An age gate that *stops* refusing is the regression this row exists to catch. |

---

## 3. Part B — BLOCKED (24 rows)

Every row names the exact decision or gate and **who must make it**. Nothing here is startable
by Implementation until that is answered.

| Checklist ID | Existing requirement ID(s) | Clause | Current verdict | Blocked by | How Verification proves it |
|---|---|---|---|---|---|
| **IDF-18** | `TV-P2` (`profiles` half) | *"Portava never stores date of birth. Age gating stores a derived `is_over_18` boolean only."* (`docs/trust/verified-foundation-plan.md:15#birth.`) — inverted in practice: `profiles.date_of_birth` is written and read by every gate | **W** | **OWNER — `D-DOB`, sequenced behind `D-PROVIDER`.** Honour the invariant (migrate gates onto the derived bit, then drop the column) or amend it in writing. Amending a privacy commitment is not a lane's to do. | After the decision: `grep -rn 'date_of_birth' artifacts/api-server/src --include=*.ts \| grep -v 'database.types\|/test/'` returns no gate read. Today the writer is `artifacts/api-server/src/routes/profile.ts:608#row.date_of_birth`, validated only for format and a *claimed* age at `artifacts/api-server/src/routes/profile.ts:603#ageYears`, and the reader is `artifacts/api-server/src/lib/travelerVerification.ts:66#date_of_birth`. |
| **IDF-19** | `TV-1c` | On `verified`, set `profiles.verification_level` via `toVerificationLevel()` and `verified_at` (`docs/trust/verified-foundation-plan.md:40#verification_level`, `docs/trust/verified-foundation-plan.md:41#toVerificationLevel()`) | **W** | **OWNER — `D-2870-APPLY`, i.e. a DEPLOY.** `artifacts/api-server/src/migrations/2870_profiles_verification_level_identity_vocabulary.sql:4#2870` is written, reversible and additive, and applied to **no database**. Until it applies, the write is a 23514 and no user can become ID-verified at all. | Post-apply: a mock end-to-end run leaves `profiles.verification_level` at `id_verified`. Code side today: `artifacts/api-server/src/routes/verification.ts:61#toVerificationLevel` → `artifacts/api-server/src/routes/verification.ts:71#verification_level:`, error rethrown; `node --import tsx/esm --test src/test/verificationLevelVocabulary.test.ts`. Constraint target: `artifacts/api-server/src/migrations/2870_profiles_verification_level_identity_vocabulary.sql:160#profiles_verification_level_check`. |
| **IDF-20** | `TV-1c` (vocabulary half), `TRV2-12` | Two vocabularies share one column: **platform standing** (`basic_verified`/`trusted_traveler`/`host_verified`/`buddy_verified`, granted by admin) and **ID-check outcome** (`id_verified`/`id_selfie_verified`, written by the webhook). Presentation must stay semantically accurate (`docs/specs/upgrades-v2/03-TRUST-v2.md:30#TRV2-12`) | **W** (carried from `TV-1c`) | **OWNER — `D-LEVEL-VOCAB`.** Merge, rank, or split into separate columns? Mapping one onto the other would close `TV-1c` without a migration and was deliberately not done. | Once ruled: a single enumeration must be the source for both writers and every reader. Today the outcome vocabulary is `artifacts/api-server/src/services/identityVerification/types.ts:107#id_selfie_verified`, the standing vocabulary is written at `artifacts/api-server/src/routes/admin.ts:1655#verification_level:`, and the consumer collapses both to a boolean at `artifacts/api-server/src/lib/travelerVerification.ts:85#verification_level`. |
| **IDF-21** | `TV-1f` (delta half), `TRV2-04` | The identity award's **category and size** — `IDENTITY_VERIFIED` +10 to `respect_safety` — as a *policy* value rather than an inherited constant | **C** for the emission; the value is unratified | **OWNER — `D-SCORING`.** See §6, decision S-1. Preserve current behaviour until ruled (`docs/specs/upgrades-v2/03-TRUST-v2.md:34#weights,`). | Whatever is ratified must appear once, at `artifacts/api-server/src/services/trust/TrustEventService.ts:815#IDENTITY_VERIFIED:`, and be asserted by a test naming the ratified number. Until then no lane may change it — `node --import tsx/esm --test src/test/trustEventCoverage.test.ts` pins the vocabulary. |
| **IDF-22** | `TV-0a` (identity half) | Schema: `identity_verifications`, profile `verification_level` + `verified_at` (`docs/trust/verified-foundation-plan.md:26#verification_level`) | **W** | **PARTIAL.** The identity half holds (`db/migrations/0161_identity_verification.sql:28#default`). The row cannot reach `C` because its `moderation_actions` half needs **OWNER — `D-MODACTION-SHAPE`** plus a migration the integration owner must number. | Identity half: `grep -c '' db/migrations/0161_identity_verification.sql` and column audit as in IDF-13. The failing half is out of this checklist's scope (§7) and is tracked on `TV-0a` in census-trust. |
| **IDF-23** | `TV-5b` | 18+ features (nightlife-tagged events, Rent a Buddy) check **`is_over_18` from the latest verified row** (`docs/trust/verified-foundation-plan.md:91#18+`, `docs/trust/verified-foundation-plan.md:92#is_over_18`) | **NB** | **OWNER — `D-DOB`, behind `D-PROVIDER`.** Migrating the gates now would refuse every 18+ feature to all users permanently: `artifacts/api-server/src/services/identityVerification/readiness.ts:53#IMPLEMENTED_PROVIDERS` admits only the mock, and the mock is refused in production, so no user can hold a verified `is_over_18`. | After a provider exists: a gate test asserting a user with no verified row is refused *and offered the gate*, and a user with `is_over_18 = true` passes. **Do not conflate with IDF-25** — IDF-25 refuses a *known minor* and is buildable today; IDF-23 makes the verified bit the *only* age source. |
| **IDF-24** | `TV-5b` (second criterion) | Unverified users see a **"verify to access" gate, not silent hiding** (`docs/trust/verified-foundation-plan.md:93#hiding.`) | **NB** | **OWNER — `D-DOB`**, then the **CLIENT LANE** (`travel-buddy-standalone/**`) | A client test asserting the gated surface renders a verify CTA rather than omitting the item, and that the CTA routes to the verification entry point (the missing route is IDF-40). |
| **IDF-26** | **NEW** | **What happens to a verified minor** beyond the refusal in IDF-25: refuse the gate only, age-restrict the account, suspend, or clear the contradicted self-asserted date of birth? | **NB** | **OWNER — a new decision, proposed name `D-MINOR`.** This is a product answer, not a wiring one, and it is *not* `D-DOB`: IDF-25 is correct under either `D-DOB` direction, IDF-26 is not derivable from either. | Once answered: a case in `src/test/verifiedMinorGate.test.ts` asserting the chosen consequence, plus an assertion that the *unchosen* consequences do **not** occur (so a later widening is loud). |
| **IDF-28** | `TV-P3`, `TRV2-10` (lineage clause) | Verification rows are deletable per-user for GDPR erasure **without destroying moderation audit history** — reports/actions use SET NULL (`docs/trust/verified-foundation-plan.md:17#deletable`) | **W** | **OWNER — `D-MODACTION-FK`**, then a **MIGRATION the integration owner must number.** `moderation_actions.target_user_id` is `ON DELETE CASCADE` (erasing a subject destroys the record about them) and `performed_by` is NO ACTION (erasing a moderator is blocked outright). Converge to SET NULL as `db/migrations/2138_profiles_fk_convergence_prep.sql` already intends, or amend invariant 3. | Post-migration: erase a subject in a test database and assert the `moderation_actions` row survives with a NULL subject. `node --import tsx/esm --test src/test/deletionCoverage.test.ts`. |
| **IDF-29** | `TV-P0` | The five invariants are *"non-negotiable, **encoded in schema + adapter types**"* — the encoding is a separate obligation from the invariants (`docs/trust/verified-foundation-plan.md:11#encoded`) | **W** | **PARTIAL.** Invariant 1's encoding holds and invariant 2's holds for the verification table; **invariant 3 is contradicted by the schema** and needs IDF-28's migration; invariants 4 and 5 are runtime throws, not type or schema constraints. Blocked on **`D-MODACTION-FK`** for the half that can be encoded at all. | A shape guard under `src/test/` asserting `identity_verifications` carries no column outside the derived set, plus the FK assertions from IDF-28. Runtime-throw invariants stay proved by IDF-06 and IDF-08 and are explicitly **not** claimed as "encoded". |
| **IDF-31** | `TRV2-10` | Derived effects of revocation, appeal and account deletion follow **the defined** reversal/retention policy (`docs/specs/upgrades-v2/03-TRUST-v2.md:28#TRV2-10`) | **CV** | **OWNER — `D-REVERSAL`.** Correctness is defined by a policy that does not exist. Three mechanisms disagree today: revocation clears the level but leaves the `identity_verified` award applied; an upheld appeal *adds* a small positive; deletion destroys evidence by FK cascade. | Today's behaviour is already pinned as a *characterization*, not a correctness claim: `node --import tsx/esm --test src/test/trust-integration.test.ts`, `D-REVERSAL: revocation reverses moderation consequences and nothing else`. Once ruled, that test's name and assertions must change with the ruling — a silent scope change is the failure mode. |
| **IDF-35** | `TV-0e` | `VerifiedBadge` component — teal = ID verified, gold = ID + selfie (`docs/trust/verified-foundation-plan.md:31#VerifiedBadge`) | **NB** | **OWNER — `D-BADGE`** (wording and colours are listed as unresolved brand decisions at `docs/specs/upgrades-v2/03-TRUST-v2.md:38#retention/reversal`), then the **CLIENT LANE** | `grep -rn 'VerifiedBadge' travel-buddy-standalone --include=*.tsx` returns a component today: **zero hits**. After: a component test asserting each level renders its ruled treatment and `none` renders nothing. |
| **IDF-36** | `TV-2c`, `TRV2-12` | Render the badge beside names on six surfaces — profile header, traveler cards, Rent-a-Buddy listings, reviews, event attendee lists — **inside `UserIdentityLink`** so profile-tap behaviour is preserved (`docs/trust/verified-foundation-plan.md:58#VerifiedBadge`, `docs/trust/verified-foundation-plan.md:60#UserIdentityLink`) | **NB** | **OWNER — `D-BADGE` and `D-LEVEL-VOCAB`**, then the **CLIENT LANE**. Also needs IDF-19 applied, or every badge is correctly absent. | The badge must read `verificationLevel`, **not** `profiles.verified`. The wrong-source render exists today at `travel-buddy-standalone/src/components/PeopleYouMayKnow.tsx:191#user.verified`; the wrapper that must host the badge is `travel-buddy-standalone/src/components/interaction/UserIdentityLink.tsx:27#<UserIdentityLink`. A component test per surface, plus a grep asserting no badge is sourced from `verified`. |
| **IDF-37** | `TV-U1`, `TRV2-12` | *"Keep these concepts separate … **Never merge them into one score**"* — verified identity is not person Trust, and source reliability never appears as a person's badge (`docs/specs/upgrades-v2/03-TRUST-v2.md:9#separate:`) | **W** | **RENT-A-BUDDY LANE** (`services/rentBuddy/CompatibilityScoreService.ts`), and the reading is contestable — census-trust §16.2 records the dissent | `node --import tsx/esm --test src/test/trustSeamOwnership.test.ts` plus the seam guard `npm run check:trust-seam-ownership`; the added assertion is that no compatibility or ranking output folds `verification_level` into a single trust number. |
| **IDF-38** | `TV-2a` | Entry points: Passport profile ("Get verified") **and the Rent-a-Buddy gate** (`docs/trust/verified-foundation-plan.md:53#Rent-a-Buddy`) | **W** | **CLIENT LANE.** The Passport entry exists; the Rent-a-Buddy gate routes nowhere, so a user the server-side gate refuses is given no way to satisfy it. | A client test asserting the 403 body's `verification_required` / `age_verification_required` error (thrown at `artifacts/api-server/src/routes/rentABuddy.ts:1864#travIdentity.age`) renders a CTA that navigates to `/profile/verification`. |
| **IDF-39** | `TV-2b` | Screens: intro (**what/why/what we never store**) → provider hand-off → pending → success/failure with retry (`docs/trust/verified-foundation-plan.md:54#intro`) | **W** | **CLIENT LANE.** Three of four screens exist; the "what we never store" section does not. Content is already enumerable server-side, so this is buildable the moment the client lane takes it. | A component test asserting the intro screen names the five invariants. Source of truth for the copy: `artifacts/api-server/src/services/identityVerification/types.ts:58#VerificationResult` (the complete stored shape) plus `docs/trust/verified-foundation-plan.md:13#government-ID`. |
| **IDF-40** | `TV-2d` | Failure UX: clear human reason + retry path; **`underage` routes to an age-policy screen and does NOT allow retry spam** (`docs/trust/verified-foundation-plan.md:61#Failure`, `docs/trust/verified-foundation-plan.md:62#underage`) | **W** | **CLIENT LANE.** Copy is currently a mechanical `failureReason.replace(/_/g,' ')` and `underage` takes no distinct branch. The normalized reasons it must switch on are fixed and generated by both real adapters and the mock. | A component test per normalized reason asserting human copy, and an `underage` case asserting the age-policy branch renders **without** a retry CTA. Client read of the bit: `travel-buddy-standalone/src/services/verification.ts:72#isOver18:`. **This is the display half; the enforcement half is IDF-25 and does not depend on it.** |
| **IDF-41** | `TV-5a` | Safety Center screen linking Safe Return, SOS, **verification status**, blocked users, community guidelines, report history (`docs/trust/verified-foundation-plan.md:89#Safety`) | **W** | **CLIENT LANE.** Four of six links present; a repository-wide search returns no community-guidelines surface at all, so one must be written before it can be linked. | A screen test asserting six links resolve. Only the verification-status link is this checklist's concern; the other five are carried so `TV-5a` does not vanish. |
| **IDF-42** | `TV-7c`, `TRV2-05` | Document the identity data flow in the **privacy policy surface** (`docs/trust/verified-foundation-plan.md:116#privacy`) | **NB** | **CLIENT LANE.** No privacy-policy screen, route or link exists in `travel-buddy-standalone/app` or `src`. | `grep -rin 'privacy' travel-buddy-standalone/app --include=*.tsx -l` must return a policy screen. Content is available: invariants 1–5, plus the stored-column inventory from IDF-13. |
| **IDF-43** | `TV-6a` | **OWNER:** choose Stripe Identity or Persona; open the account; obtain keys; register the webhook endpoint; take the signing secret as `IDENTITY_WEBHOOK_SECRET`; set Replit Secrets **staging first** (`docs/trust/verified-foundation-plan.md:98#Persona;`, `docs/trust/verified-foundation-plan.md:100#IDENTITY_WEBHOOK_SECRET`) | **NB** | **OWNER — `D-PROVIDER`.** Six steps, no code reading needed. ~$1.50–3.00 per attempt at either vendor. **Also blocks `D-DOB`.** | Verifiably not done rather than unverifiable: the adapters consume exactly `IDENTITY_WEBHOOK_SECRET` for both vendors. Done when the staging environment answers a real signed webhook. |
| **IDF-45** | `TV-6b` (sandbox half) | **AGENT:** sandbox-mode end-to-end test, then flip `IDENTITY_PROVIDER` staging → production (`docs/trust/verified-foundation-plan.md:103#signature`, `docs/trust/verified-foundation-plan.md:104#IDENTITY_PROVIDER`) | **W** | **OWNER — `D-PROVIDER`**, then one session of lane work | A sandbox transcript: session → hosted flow → signed webhook → `verified` row → `profiles.verification_level` set. Then the chosen name joins `artifacts/api-server/src/services/identityVerification/readiness.ts:53#IMPLEMENTED_PROVIDERS`. **What turns it red:** any guessed payload field (Stripe `verified_outputs.address.country`, `last_error.code`; Persona `attributes.status`, `birthdate`, `country-code`, the `included[]` check names) not being where the adapter assumes. |
| **IDF-46** | `TV-U8` | Test actual consuming routes and **real database constraints/RLS** where applicable (`docs/specs/upgrades-v2/03-TRUST-v2.md:44#signatures,`) | **W** | **DEPLOY.** The database half cannot be exercised until migration 2870 applies (IDF-19). | Post-apply: a test that writes `verification_level = 'id_verified'` against the real constraint and succeeds, and one that writes a value outside the ratified vocabulary and is rejected with 23514. |
| **IDF-54** | `C22` (deferred half) | **PIN semantics behind a flag** — the admin's number IS the score until lifted; plus expiry, two-admin precedence, and relief from a moderation ceiling | not graded (deliberately not built) | **OWNER — `D-OVERRIDE` follow-ons.** The first clause is ruled (CAP); three are open. See §6, decision S-4. | Nothing to verify until ruled. What must stay true meanwhile: `trust_caps` has no floor column, `artifacts/api-server/src/services/trust/TrustScoreService.ts:186#Math.min` stays a pure minimum fold, and `artifacts/api-server/src/services/trust/TrustScoreService.ts:318#caps[cat]` stays a ceiling comparison. A `Math.max` appearing without a ruling is the silent conversion the spec forbids at `docs/specs/upgrades-v2/03-TRUST-v2.md:36#ceiling,`. |
| **IDF-55** | `TRV2-04` | The **whole chain** works end to end: session → signed webhook → authorized transition → profile → badge; duplicates and invalid signatures create no additional effect (`docs/specs/upgrades-v2/03-TRUST-v2.md:22#TRV2-04`) | **—** (census maps it onto nine rows rather than grading it separately) | **Composite:** blocked until IDF-19 (`D-2870-APPLY`), IDF-35/36 (`D-BADGE`), IDF-45 (`D-PROVIDER`) all land | One end-to-end suite that walks the full chain in a test database and asserts the badge-visible state at the end. Until then the chain is proved in segments by IDF-01, IDF-07, IDF-08, IDF-16, IDF-19. **This row is the acceptance gate for the foundation as a whole.** |

---

## 4. `C22` — what the persistence gap actually is

**The previous lane's claim was "the only gap is that no route calls `adminOverrideScore`."
That claim is true as far as it goes and it is not the whole gap.** Verified by reading the code
at this tree, not by quoting.

**Confirmed true.** `grep -rn 'adminOverrideScore' artifacts/api-server/src --include=*.ts`
returns the definition, its own error strings, and test files — **no route**. The only
admin-initiated ceiling writer is `artifacts/api-server/src/services/trust/TrustAdminService.ts:362#createCap`
inside that unreachable function. So **at the time this was written** no admin could set a
ceiling at all, and the owner's ruling governed a capability nobody had.

> **⚠ SUPERSEDED BY §10.** This paragraph and §4's item 2 describe the BEFORE state. The route was
> built and independently verified; `C22` moved `W → C` in census-trust §18.1. The before-state
> sentences are kept because they are the argument for why the work was needed — read them as
> history, not as a statement about the tree.

**Confirmed fixed, and worth stating so nobody re-fixes it.** The *apply* path now persists
correctly and says so: the raw `trust_profiles` write is gone, the recalculation's failure is no
longer swallowed (`artifacts/api-server/src/services/trust/TrustAdminService.ts:371#recalculateTrustScore`),
the persisted value is **read back** rather than computed
(`artifacts/api-server/src/services/trust/TrustAdminService.ts:374#getTrustProfileResult`), a
value above the ceiling throws
(`artifacts/api-server/src/services/trust/TrustAdminService.ts:385#persistedScore`), and the
failure text the owner quoted —
`artifacts/api-server/src/services/trust/TrustAdminService.ts:377#confirmed` — is the guard,
not a bug report.

**Three things the claim misses. All three are persistence, all three are buildable now.**

1. **The removal path has the exact defect that was fixed on the apply path** (IDF-51).
   `artifacts/api-server/src/services/trust/TrustAdminService.ts:438#adminRemoveOverride`
   swallows the lift with `artifacts/api-server/src/services/trust/TrustAdminService.ts:468#liftCap`
   `.catch(() => {})`, swallows the recalculation at
   `artifacts/api-server/src/services/trust/TrustAdminService.ts:480#recalculateTrustScore`,
   then unconditionally writes the audit row at
   `artifacts/api-server/src/services/trust/TrustAdminService.ts:484#logAdminAction` and returns
   `{ ok: true }`. There is no read-back. So a removal that lifted nothing — or that lifted the
   cap and never got the score back up — is reported and audited as done. `liftCap` itself
   throws on a database error, so the swallow is the whole of the loss. **Ceiling persistence is
   confirmed on apply and unconfirmed on remove**, which is half a guarantee.

2. **There *is* an override-adjacent route, and it bypasses the service** (IDF-52).
   `artifacts/api-server/src/routes/trust-admin.ts:463#admin/trust/users/:userId/cap/override`
   exists behind `requireAdmin`. Despite the name it **lifts** a cap: it calls
   `artifacts/api-server/src/routes/trust-admin.ts:502#adminRemoveOverride` directly by cap id — any cap,
   including a `behavior_confirmed` moderation ceiling — never calls `adminRemoveOverride`, and
   fires the recalculation as fire-and-forget at
   `artifacts/api-server/src/services/trust/TrustAdminService.ts:480#recalculateTrustScore` before answering
   `{ ok: true }`. Two consequences: the service's selection and audit logic is dead code, and
   the route's own persistence is unconfirmed in exactly the way the apply path no longer is.
   It also silently grants the **relief from a moderation ceiling** that census-trust §15.5
   lists as deliberately not built.

3. **The `score_override` audit vocabulary is polluted** (IDF-53). The trust-**settings** route
   files its audit row as `artifacts/api-server/src/routes/trust-admin.ts:626#action_type:`.
   An auditor asking "which admin overrode a user's score" gets settings edits back. Since
   IDF-50's whole point is that the audit row must say what happened, this is part of the same
   obligation.

**So the precise statement of the gap, for Implementation:** *the ceiling is durable in
`trust_caps` and its effect on `trust_profiles` is confirmed on apply only; it is unreachable
from any route; its removal is unconfirmed and can report a false success; the one route in the
area lifts caps outside the service and outside its own confirmation; and the audit type that
records overrides is shared with a different action.*

**Not in scope for this fix, by the owner's own words:** PIN semantics, expiry, two-admin
precedence, and relief from a moderation ceiling (IDF-54, and §6 decision S-4). *CAP now, PIN
later behind a flag* — and the flag does not exist yet.

---

## 5. The verified-minor hole — independently confirmed

**Confirmed at this tree, by reading, not by quoting.** Four measurements:

1. **Both real adapters produce the signal.** A provider result whose failure reason is
   `underage` is normalized to `isOver18 = false` at
   `artifacts/api-server/src/services/identityVerification/stripeIdentity.ts:173#underage` and
   `artifacts/api-server/src/services/identityVerification/persona.ts:134#underage`.
2. **It is persisted on every result state, not only success.**
   `artifacts/api-server/src/routes/verification.ts:150#is_over_18:` sits in the patch object
   that is applied before the `status === "verified"` branch, so a `failed`/`underage` result
   writes `is_over_18 = false` to the row.
3. **Nothing reads it as a gate.** A repository-wide search for `is_over_18` outside tests and
   generated types returns exactly three hits: that write, the status route's SELECT list
   (`artifacts/api-server/src/routes/verification.ts:412#is_over_18,`), and the client's display
   mapping (`travel-buddy-standalone/src/services/verification.ts:72#isOver18:`). **Zero gates.**
4. **Every 18+ gate reads the self-asserted date instead.** The single traveller-identity helper
   derives age from `profiles.date_of_birth` at
   `artifacts/api-server/src/lib/travelerVerification.ts:91#calculateUserAge(dateOfBirth),`, and
   that column is written by the user at
   `artifacts/api-server/src/routes/profile.ts:608#row.date_of_birth`, validated only for
   format, past-ness, and a **claimed** age of 18 at
   `artifacts/api-server/src/routes/profile.ts:603#ageYears`. The **Rent-a-Buddy booking gate**
   — which pairs strangers in person — loads that helper at
   `artifacts/api-server/src/routes/rentABuddy.ts:1854#loadTravelerIdentity` and compares the
   derived age to the minimum at
   `artifacts/api-server/src/routes/rentABuddy.ts:1869#travIdentity.age`.

**Therefore:** a user whose government document proves they are a minor keeps the adult birthday
they typed and passes every 18+ gate, including the booking gate. The product **holds proof of
the contradiction and does nothing with it.**

**And it is blocked on neither `D-PROVIDER` nor `D-DOB` — confirmed.** The refusal rule is a
*contradiction* rule, not a source-of-truth rule:

* Under `D-DOB` direction (a) — `is_over_18` becomes the gate — a `false` must refuse.
* Under `D-DOB` direction (b) — the self-asserted DOB is ratified as the gate — a verified
  contradiction of a self-assertion must still win, or the ratification means the product
  ignores evidence it paid a vendor for.

Both directions produce the same rule, so **closing it decides nothing**, and no decision is
owed before it is built. `D-PROVIDER` does not block it either: the rule is written and tested
against a stored row, and the row shape exists today
(`db/migrations/0161_identity_verification.sql:36#is_over_18`). Without a provider the rule is
simply never triggered in production — which is the same state as today, minus the hole.

**Rows:** **IDF-25** (the refusal — BUILDABLE NOW), **IDF-27** (the booking gate specifically —
BUILDABLE NOW), **IDF-26** (what *else* happens to a verified minor — BLOCKED on a new owner
decision `D-MINOR`). The client-side `underage` branch is **IDF-40** and is a separate,
display-only obligation: it must not be mistaken for enforcement.

**Ownership note for the lead.** The gate files are
`artifacts/api-server/src/routes/{meetups,requests,events,profile}.ts`,
`artifacts/api-server/src/routes/rentABuddy.ts`, `artifacts/api-server/src/routes/mediaFeed.ts`
and `artifacts/api-server/src/services/media/MediaProjectionService.ts`, plus the shared helper
`artifacts/api-server/src/lib/travelerVerification.ts`. Putting the rule in the **helper** makes
it one change with six consumers; putting it in each route makes it six changes that can drift
apart again — which is the bug the helper's own header says it was created to end.

---

## 6. Scoring-policy decisions the foundation touches — presented together

Every one of these is a **scoring** decision that the identity foundation runs into. Each has a
concrete example of what differs by answer, and a recommendation with its reasoning. **None is
taken here.** Where the spec is genuinely ambiguous it is marked as such rather than resolved.

| # | Decision | What concretely differs | Recommendation, and why |
|---|---|---|---|
| **S-1** | **The identity award's category and size.** `IDENTITY_VERIFIED` is +10 to `respect_safety` (`artifacts/api-server/src/services/trust/TrustEventService.ts:815#IDENTITY_VERIFIED:`). Ratify, re-weight, or re-categorize? | A user who does nothing but verify their ID gains the same +10 as hosting their first event, in **the same category** a confirmed behaviour report takes 20 off. So one ID check offsets half a confirmed safety finding. Under a separate `identity` category or a smaller delta, it would not. | **Ratify the +10 but move it out of `respect_safety`.** Verifying identity is evidence about *who you are*, not about *how you behave*; letting it net against behavioural findings in one column is the "never merge them into one score" clause of `docs/specs/upgrades-v2/03-TRUST-v2.md:9#separate:` happening inside a single category. A new category is a scoring change and needs the owner; leaving it where it is needs the owner too — the current placement is inherited, not approved. |
| **S-2** | **`D-REVERSAL` — does revoking a verification reverse its trust award?** (`TRV2-10`, IDF-31) | Today revocation clears `profiles.verification_level` (`artifacts/api-server/src/routes/admin.ts:1655#verification_level:`) and **leaves the +10 applied**, because the reversal helper selects on `source_type = 'moderation'` and the award's source type is `identity_verification` (`artifacts/api-server/src/routes/verification.ts:42#TRUST_SOURCE_TYPE`). So the two halves of "verified" come apart: the badge goes, the score does not. | **Reverse it, by a counter-event rather than by deleting the original.** A counter-event keeps the ledger append-only and replayable (the `TRV2-07` property), and it keeps the revocation itself as evidence. Deleting the award would make the history say the verification never happened, which is the one thing an audit log must not do. **Ambiguity flagged:** the spec says "the **defined** reversal/retention policy" and defines none (`docs/specs/upgrades-v2/03-TRUST-v2.md:28#TRV2-10`) — this is a recommendation, not a reading. |
| **S-3** | **Retention of derived trust evidence about an erased subject.** Does the plan's 90-day verification-record value apply to trust evidence too? (`TV-U5`, IDF-34) | Erasing a user today destroys trust evidence by FK cascade, while the verification rows follow the deliberate 90-day rule (`artifacts/api-server/src/services/identityVerification/retention.ts:34#VERIFICATION_RETENTION_DAYS`). If 90 days were extended to trust evidence, a moderation finding about an erased subject would also disappear on a timer instead of on erasure. | **Do not extend it.** The v2 spec already says the plan's values apply to the stated verification records and warns against rewriting unrelated retention rules (`docs/specs/upgrades-v2/03-TRUST-v2.md:38#retention/reversal`). Trust evidence retention is its own question and should be answered on its own, with `D-MODACTION-FK` (IDF-28), not inherited from a vendor-record rule. |
| **S-4** | **`D-OVERRIDE` follow-ons.** The first clause is ruled — **CAP now, PIN later behind a flag**. Three remain: precedence over a moderation ceiling, expiry, and two-admin removal. (IDF-54) | *Precedence:* today an admin **cannot** grant relief from a `behavior_confirmed` ceiling, because ceilings fold with a pure minimum (`artifacts/api-server/src/services/trust/TrustScoreService.ts:186#Math.min`) — but the lift route (IDF-52) lets them do it anyway by lifting the moderation cap directly. *Expiry:* `adminOverrideScore` passes no `expiresAt`, so every ceiling is permanent until lifted; the sweeper cannot sweep a null. *Two admins:* the lower ceiling wins regardless of who set it, and one admin's removal clears another's. | **(a) Keep "no relief" and close the route loophole** — decide it once, in the service, rather than leaving it decided by which endpoint an admin happens to call. **(b) Require an expiry** on an admin override, defaulting to a review date rather than permanence: a permanent ceiling set by one admin with no review is the shape that produces unexplainable scores years later. **(c) Make removal scope-aware** — an admin's removal lifts their own override; clearing another admin's needs its own action and audit row. All three are cheap **after** the route exists (IDF-50) and pointless before it. |
| **S-5** | **`D-SCORING` in general — what the identity foundation may assume.** (`TV-U2` is `CV` for exactly this reason: "current *approved* behavior" names an approval that does not exist.) | Nothing in Part A depends on a scoring parameter. The one place the foundation *touches* scoring is the identity award (S-1) and the admin ceiling (S-4). Everything else — session, adapter, webhook, storage, level, gates, revocation, retention, badge — is independently specified. | **Rule S-1 and S-4 and leave the rest of `D-SCORING` open.** The spec explicitly permits this: *"Missing scoring policy … does not prevent implementing independently specified privacy, authorization, idempotency, wiring and Sensing separation requirements"* (`docs/specs/upgrades-v2/03-TRUST-v2.md:40#100%`). That sentence is the licence under which Part A is buildable now, and it is the reason Part A contains no scoring parameter. |

---

## 7. Existing `TV-*` / `TRV2-*` ids that do **not** map into this checklist

Listed so the lead can confirm nothing vanished. **None of these is retired** — each stays a
census row under its current owner; it is simply outside the identity-verification foundation.

| id(s) | Why it is not here |
|---|---|
| `TV-3a`, `TV-3b`, `TV-3c`, `TV-3d` | Report/block journeys (Phase V-3). Moderation intake, not identity verification. All four are `C`. Their no-regression obligation is carried by IDF-49. |
| `TV-4a` | The moderation queue (list/filter/snapshot/act). Only its `verification_revoked` reach touches identity, and that is `TV-4c` → IDF-30. `TV-4a` stays `W` on `D-MODACTION-SHAPE` plus the admin-route lane. |
| `TV-4b` | Suspension enforcement UX. `D-SUSPENSION-UX`. Consumes a moderation outcome, not an identity outcome. |
| `TV-5a` | Safety Center as a whole; only its verification-status link is in scope, carried at IDF-41 so the id does not vanish. |
| `TV-0a` (moderation half) | `moderation_actions` shape — `D-MODACTION-SHAPE` plus a migration. Its identity half is IDF-22. |
| `TV-U2` | "Preserve current approved behavior" — `CV`, because no approval exists. Named in §6 as S-5 rather than given a row, since there is nothing executable to check. |
| `TV-U3`, `TV-U4`, `TV-U6` | Process obligations on how requirements are handled (request the policy; do not promote behaviour to specification; do not claim 100 %). This document is partly their discharge — §6 is the request, §0 the refusal to promote — but they are not build items. |
| `TV-U12` | "Produce the concrete configuration/release steps and identify the exact remaining owner action." Discharged by IDF-43's six steps plus §3's blocker column; no separate row. |
| `TRV2-01`, `TRV2-02`, `TRV2-03` | Sensing separation. No identity content. |
| `TRV2-06`, `TRV2-07`, `TRV2-09` | Adjudication, durability and admin authorization for the **scoring** engine. Their identity-touching clauses are already carried: duplicate delivery → IDF-16, admin audit → IDF-53. |
| `TRV2-08`, `TRV2-11` | Restriction reach (`D-RESTRICTION-REACH`) and backfill prohibition. Out of scope; `TRV2-11`'s "do not enable providers to close a requirement" overlap is carried by IDF-48 via `TV-U11`. |
| `A1`–`A20`, `C1`–`C32` (except `C22`) | Trust **scoring** rows — score projection, caps, restrictions, review queues, privacy guards, scheduler. Out of scope by §0. `C1` (dedup) is the mechanism IDF-16 depends on and is cited there rather than re-rowed. `C22` is the single exception, by owner direction, and is annexed in §4. |
| `A6` | "Live evidence actually reaches the ledger, **measured in production**." `identity_verified` is on its declared-and-unfired list, for a reason this checklist owns (IDF-19: no user can become verified until 2870 applies) — but `A6` is a production-measurement row and is settled by a deploy, not by this checklist. |

---

## 8. How to run everything in one pass

```
cd artifacts/api-server
node --import tsx/esm --test \
  src/test/verification.test.ts \
  src/test/verificationSessionCreatedStatus.test.ts \
  src/test/verificationWebhookSignature.test.ts \
  src/test/verificationWebhookProviderUnavailable.test.ts \
  src/test/verificationProviderNormalization.test.ts \
  src/test/verificationTrustIdempotency.test.ts \
  src/test/verificationWritesIssued.test.ts \
  src/test/verificationStatusUnreadableProfile.test.ts \
  src/test/verificationLevelVocabulary.test.ts \
  src/test/verificationProviderErasure.test.ts \
  src/test/verificationRetention.test.ts \
  src/test/verificationAttemptMetrics.test.ts \
  src/test/adminUnverifyRevokesIdLevel.test.ts \
  src/test/ageGate.test.ts \
  src/test/trust-integration.test.ts
```

Doc guards, from the repository root:

```
node artifacts/api-server/scripts/check-doc-citations.mjs      # must add zero findings
node artifacts/api-server/scripts/check-citation-targets.mjs   # must stay under its ceiling
```

---

## 9. What would turn THIS document red

* Any row's `Current verdict` disagreeing with the last statement on that id in
  `docs/architecture/census-trust.md`. This document carries verdicts; it never sets them.
* An existing `TV-*` / `TRV2-*` id appearing in neither §2, §3 nor §7 — that is the silent
  disappearance §1 exists to prevent.
* `grep -rn 'is_over_18' artifacts/api-server/src --include=*.ts | grep -v test` returning a
  gate read **without** IDF-25 being marked built — the hole would be closed by an unrecorded
  change, which is how it opened.
* A route calling `adminOverrideScore` appearing without IDF-50 being re-graded, or a `Math.max`
  appearing in the cap fold without the `D-OVERRIDE` PIN ruling (IDF-54).
* `artifacts/api-server/src/services/identityVerification/readiness.ts:53#IMPLEMENTED_PROVIDERS`
  gaining a non-mock member without IDF-45's sandbox transcript — IDF-48 and `TV-U9` fall in the
  same commit.
* Either specification file changing. The clause citations are against the tree recorded in
  `docs/specs/upgrades-v2/SOURCE-MANIFEST.json`; a drift shows there first.


---

## 10. Verification outcome — 2026-09-14, at `608c5aa09`

An independent **Verification** role re-derived every Part A claim from this checklist and the
code. It was **not** given Implementation's report. The integration lead re-checked its two
refusals personally before accepting them, and owns every verdict below.

| row | verification verdict | outcome |
|---|---|---|
| **IDF-50** | **CONFIRMED** | Route exists, mounted, awaited, reads the ceiling back. All four census §15.4 mutations go red. |
| **IDF-51** | **CONFIRMED** | Every step awaited, lifts counted, `trust_caps` and `trust_profiles` both re-read before anything is audited. Both named mutations go red. |
| **IDF-52** | **CONFIRMED — all four defects** | Including the user-scoping one. Verification built a live attack probe: cap belongs to user B, request through user A's URL. **Before:** 200, B's ceiling lifted, audit filed against A, A's cache wrongly cleared, B's never invalidated. **After:** 404, nothing written, no audit row, both caches intact. |
| **IDF-25** | **NOT CONFIRMED** | The rule reaches four Rent-a-Buddy files. **Seven further age gates call the helper zero times.** census-trust §18.2. |
| **IDF-27** | **CONFIRMED on the canonical gate; NOT CONFIRMED as an invariant** | A sibling booking route inserts a booking without passing through it. census-trust §18.2. |
| **IDF-53** | **Refusal CORRECT** | And worse than stated: supabase-js *resolves* on a DB error, so the `23514` would not even reach the swallowed `catch`. The rename would have produced **no audit row at all**. |

### 10.1 Two corrections to THIS document

1. **`IDF-53`'s "Blocked by" column said `NOTHING`. It is blocked on a migration.** That is a
   defect in the checklist, not in the implementation — recorded rather than quietly edited.
2. **The ownership note for `IDF-25` rested on a false premise.** It said putting the rule in
   `loadTravelerIdentity` made it *"one change with six consumers"*. The helper has four non-test
   consumers and all four are Rent-a-Buddy. The seven gates that needed it never call it.

### 10.2 The finding that justifies the three-role split

`trust-integration.test.ts:653#DEFECT` claims in its own comment that restoring the
fire-and-forget call turns it red. **It does not** — it passes for an unrelated reason. A builder
who writes both the fix and its pin cannot discover that the pin passes for the wrong reason;
only a reader who runs the mutation can. Queued for repair.

---

## 11. IDF-53 — DISCHARGED at `2940` + the route, and one thing §10 got wrong is now proven

Written by the integration owner. §10 recorded IDF-53's refusal as CORRECT and §10.1 recorded the
reason the row's own **Blocked by** column was wrong — *"It said `NOTHING`. It is blocked on a
migration."* Both stand, and the second is now demonstrated rather than argued: the rename was
applied together with `migrations/2940_trust_admin_actions_update_setting.sql`, and the guard that
would have caught the rename alone went red first.

### 11.1 What shipped

| piece | file |
|---|---|
| the CHECK widened, nine literals kept, `update_setting` added | `artifacts/api-server/src/migrations/2940_trust_admin_actions_update_setting.sql` |
| the settings handler files `update_setting` and BINDS its insert's error | `artifacts/api-server/src/routes/trust-admin.ts:626#action_type:` |
| the vocabulary allowlist, and a second set for what `logAdminAction` may write | `artifacts/api-server/src/test/trustAdminActionVocabulary.test.ts` |
| the row-specific pins (which writer uses which action type, and the error binding) | `artifacts/api-server/src/test/trustAdminAuditInsertSchemaDrift.test.ts` |

RED 4 of the 5 new cases, GREEN all of them; three mutations on the route all killed —
`score_override` restored (kills 1, 2, 4), an action type the CHECK rejects (kills 2, 3, 5), the
error binding discarded again (kills 5 alone).

### 11.2 Two things found on the way that were NOT in the row

1. **`update_setting` must NOT enter the `AdminActionType` union.** That union types
   `logAdminAction`, whose third positional parameter is `targetUser` — and a settings edit has no
   subject. So the guard now carries TWO sets: what the CHECK admits, and the narrower set
   `logAdminAction` may be passed. A new case pins the gap, because `update_setting` is now the
   interesting value: legal in the column, illegal as an argument.

2. **The guard's own positive controls had been using `update_setting` as their example of an
   unadmitted value.** `2940` made three of them pass for a reason unrelated to what they test — a
   positive control whose bad value stops being bad proves nothing. They now use a literal no
   migration has ever admitted. This was found only because the guard went red first, which is the
   argument for writing the source before the allowlist.

### 11.3 Reported, not folded in

- **`target_user: adminId` is still a contradiction.** The settings audit row asserts the admin
  acted upon themselves, because the column is `NOT NULL` and a settings edit has no target. IDF-53
  is about the action-type vocabulary; making that column nullable is a different migration and a
  different row.
- **Historical rows are NOT rewritten.** Settings edits already stored as `score_override` stay as
  they are — they are the record of how long the defect ran, and reclassifying them is an owner
  decision. `2940`'s header says the same.
- **The trust-score RECALCULATION SWEEP in the same handler still discards its own failure**
  (`.catch(() => {})` at the `setImmediate` sweep). A settings change whose recalculation never ran
  looks identical to one that did. Real, out of this row's scope, and named here rather than
  silently widened into. `check:silent-supabase-writes` does not see it because it is not a write.

### 11.4 What would turn §11 red

The row reopens if `routes/trust-admin.ts` writes `score_override` again, if `update_setting`
enters `AdminActionType`, if the audit insert stops binding its error, or if `2940` is reverted
while the code still writes `update_setting` — which the migration's own reversal note refuses,
because any stored `update_setting` row would fail the narrowed CHECK and the `ALTER` would abort.

**AND IT IS NOT DEPLOYED.** `2940` exists in the tree and in no database. Until it is applied, a
settings edit on any deployment writes `update_setting` into a column whose CHECK rejects it, and
because supabase-js RESOLVES a 23514 the row simply will not exist — the failure mode this whole
row is about, in the opposite direction. The migration must land before or with the code.
