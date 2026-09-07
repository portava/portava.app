# The anonymous sensing store, and what stands between it and an input — current state

*Derived from the repository, 2026-09-07, on branch `claude/portava-continuation-uqta94`
(`a9081f18`). Authoritative for control flow only where it cites a file; where it touches rulings
it defers to `docs/discovery/ROADMAP.md` and to the owner ruling quoted below.*

**This is a gap analysis, not a design.** It records what PR #475 built, which layers between a
device and a stored contribution do not exist, and which of those missing layers the ruling
already permits versus which need a decision. It does not say what an anonymous sensing input
*should* do — no Sensing specification is in this repository, and nothing here is derived from
one.

## Where the code actually is

PR #475 is **not merged into this branch**. `git merge-base --is-ancestor pr/475 HEAD` fails; the
PR head is `0597a245`, HEAD is `a9081f18`. None of its files exist in the working tree
(`artifacts/api-server/src/lib/sensingAnonStore.ts`,
`artifacts/api-server/src/lib/sensingCoverageAggregate.ts`,
`artifacts/api-server/src/migrations/2315_sensing_anon_contributions.sql` are all absent), and a
repo-wide grep for `2315` outside `.git` returns nothing. **Every citation below with a
`pr/475:` prefix is read from that ref, not from this tree** — `git show pr/475:<path>`.

The PR is five files plus one line:

| Path (at `pr/475`) | Lines | What it is |
|---|---|---|
| `src/lib/sensingAnonStore.ts` | 543 | the typed contract over the store |
| `src/lib/sensingCoverageAggregate.ts` | 231 | cohort → publish decision |
| `src/migrations/2315_sensing_anon_contributions.sql` | 402 | the table, two functions, RLS, postconditions |
| `src/test/sensingAnonStore.test.ts` | 372 | contract + **inertness** assertions |
| `src/test/sensingCoverageAggregate.test.ts` | 523 | counting and refusal assertions |
| `package.json:58` | 1 | both test files added to the default `test` script |

Migration `2315` **is applied to portava-ci and not to production**. That is a supplied
measurement, not a fact this document established from the tree — no database was queried here,
and no file in the tree records an apply state for `2315`.

## The ruling this store sits under

Quoted verbatim in `0597a245` and in the source of both modules
(`pr/475:src/lib/sensingAnonStore.ts:8-14`, `pr/475:src/migrations/2315_sensing_anon_contributions.sql:16-22`):

> "A short-lived anonymous sensing contribution/aggregation store IS allowed even though
> intel_observations requires actor_id. It is not a second intel lifecycle. Existing intel
> evidence -> claims -> snapshots remains canonical. The anonymous store may only own
> privacy-reduced sensor contributions, rotating IDs, TTL, cohort/coverage aggregation and
> revocation. It must not duplicate claim/review/status/conflict/snapshot semantics and must not
> contain a permanent profiles/user FK."

The FK the ruling is answering is real and unchanged in this tree:
`artifacts/api-server/src/migrations/2130_intel_storage.sql:142` —
`actor_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE`.

---

# 1. The store's contract, as built

## 1.1 The row

`pr/475:src/migrations/2315_sensing_anon_contributions.sql:107-193`. Eleven columns and nothing
else: `id` (`:110`, a storage key, joined by nothing), `contributor_token` text (`:121`),
`rotation_epoch` bigint (`:126`), `group_token` text nullable (`:134`), `zone_id` text (`:140`),
`time_bucket` timestamptz (`:145`), `cohort_key` text (`:151`), `signal_bucket` smallint
(`:155`), `reduction_version` smallint (`:161`), `created_at` / `expires_at` (`:164-165`).
CHECKs bound the TTL to ≤ 72 h (`:171-172`), token lengths to 16–128 (`:177-180`), `zone_id` to
1–128 (`:181-182`), `cohort_key` to ≤ 320 (`:183-184`), `signal_bucket` to 0–4 (`:187-188`) and
`rotation_epoch` to ≥ 0 (`:191-192`). Three indexes: `(cohort_key, expires_at)`,
`(rotation_epoch, contributor_token)`, `(expires_at)` (`:196-202`).

There is no claim type, no value payload and no free text. The migration says so and enforces it
(`:355-368`, see §5).

## 1.2 What `sensingAnonStore.ts` exposes

All citations `pr/475:src/lib/sensingAnonStore.ts`.

**Constants.** `SENSING_TABLE` (`:93`), `SENSING_ROTATION_PERIOD_SECONDS = 3600` (`:105`, a whole
multiple of the 30-minute privacy bucket, pinned by a guard test), `SENSING_DEFAULT_TTL_SECONDS =
24 h` (`:108`), `SENSING_MAX_TTL_SECONDS = 72 h` (`:115`, mirroring the SQL CHECK, which stays
authoritative), `SENSING_REDUCTION_VERSION = 1` (`:122`), `SENSING_BUCKET_MIN/MAX = 0/4`
(`:125-126`), `SENSING_READ_LIMIT = 5000` (`:396`).

**Pure derivations.** `rotationEpochFor(atMs)` (`:165-168`); `deriveEpochSecret(deviceSecret,
epoch)` — **device-side**, exported only so the contract is testable and a future client has one
definition to implement (`:170-180`); `revocationCommitment(epochSecret)` = SHA-256 (`:186-189`);
`deriveContributorToken(epoch, commitment)` = HMAC under the server pepper (`:195-201`);
`deriveGroupToken(epoch, groupTag)` → token or `null` (`:215-221`); `sensingTimeBucket(atMs)`
floors to `PRIVACY_THRESHOLD_V1.timeBucketMinutes` (`:229-237`); `sensingCohortKey(zoneId,
timeBucketIso, reductionVersion)` (`:243-254`).

**Input and row types.** `SensingContributionInput` (`:281-296`) carries `commitment`,
`rotationEpoch`, optional `groupTag`, `zoneId`, `observedAtMs`, `signalBucket`, and optional
`ttlSeconds` / `reductionVersion`. There is no field an account, device or session id could
occupy. `SensingContributionRow` (`:263-274`) is those eleven columns minus `id`.

**`buildSensingContributionRow(input, nowMs)`** (`:307-358`) is pure and returns
`{ok:true,row}` or `{ok:false,error}` with named errors: `commitment_required`, `epoch_invalid`,
`zone_required`, `observed_at_invalid`, `signal_bucket_out_of_range`, `reduction_version_invalid`,
`ttl_invalid`, `ttl_exceeds_maximum` (`:311-332`), and `epoch_does_not_match_observation` when the
claimed epoch is not the epoch the observation falls in (`:336-338`) — the check that stops a
device pinning one epoch forever and defeating rotation.

**I/O.** `recordSensingContribution(db, input, nowMs)` inserts (`:373-387`);
`readSensingCohort(db, cohortKey, nowIso, limit)` selects one cohort's unexpired rows and returns
a discriminated `SensingReadResult` (`:408-410`, `:413-453`), where a full page is reported
`complete:false` because it is indistinguishable from a truncated one (`:443`);
`revokeSensingContributions(db, revocation)` RPCs `revoke_sensing_contributions` (`:487-507`);
`purgeExpiredSensingContributions(db, nowIso)` RPCs `purge_expired_sensing_contributions`
(`:531-542`). **The Supabase client is injected in every case** — the module names no credential
(`:372`).

`applySensingRevocation(rows, revocation)` (`:514-520`) and
`isSensingContributionExpired(row, nowMs)` (`:361-366`) are the in-memory equivalents, exposed so
the properties are provable without a database.

## 1.3 What `sensingCoverageAggregate.ts` exposes

One function. `aggregateSensingCohort(read: SensingReadResult, options)` →
`SensingCohortAggregate` (`pr/475:src/lib/sensingCoverageAggregate.ts:92-103`, `:133-230`).

It takes the **read result**, not rows, so a caller physically cannot hand it the output of a
failed read (`:126-135`). A failed read refuses as `read_failed` and an incomplete one as
`read_incomplete` (`:140-141`), both distinct from the privacy gate's own reasons so an outage
cannot hide behind a suppression (`:83-90`). Expired rows are dropped before counting (`:144`).
`distinctActors` is the size of the contributor-token set (`:146-149`, `:182`), `distinctGroups`
counts distinct non-null group tokens (`:162-169`, `:183`), `maxGroupShare` divides the largest
group's distinct contributors by the **union** of grouped contributors (`:172-178`).

It computes no threshold of its own: `evaluatePrivacy` from `lib/privacyGate` is imported and its
verdict returned unchanged (`:71-75`, `:189-192`, `:207-220`). In this tree that gate refuses
below 15 distinct actors, below 5 independent groups, above a 20 % single-group share, and inside
a 10-minute publication delay (`artifacts/api-server/src/lib/intelContracts.ts:733-737`, applied
at `artifacts/api-server/src/lib/privacyGate.ts:94-126`).

## 1.4 The revocation scheme

Documented at `pr/475:src/lib/sensingAnonStore.ts:28-79` and implemented as cited above:

1. the device holds a long-lived `deviceSecret` that never leaves it;
2. `epochSecret = HMAC(deviceSecret, "sensing-anon/epoch/v1|<epoch>")` (`:176-180`) — device-only;
3. `commitment = SHA-256(epochSecret)` (`:186-189`) travels with the contribution;
4. the server derives `contributor_token = HMAC(pepper, "sensing-anon/contributor/v1|<epoch>|<commitment>")` and stores that (`:195-201`, `:346`);
5. to revoke, the device **reveals the `epochSecret`**; the server re-derives commitment → token
   (`revocationTargetToken`, `:472-478`) and deletes by `(epoch, token)`
   (`revoke_sensing_contributions`, `pr/475:src/migrations/2315_sensing_anon_contributions.sql:239-260`).

`SensingRevocation` has exactly two fields — an epoch and a secret (`:461-465`) — and the SQL
function takes only `(bigint, text)` (`:239-242`), so there is no identity anywhere on the path.
Knowing a stored token is not enough to revoke: the credential is the preimage (`:61-64`).

## 1.5 The server pepper — where it comes from, and whether anything configures it

`sensingPepper()` (`pr/475:src/lib/sensingAnonStore.ts:139-150`) reads, in order:

| # | Env var | Configured anywhere in this repo? |
|---|---|---|
| 1 | `SENSING_CONTRIBUTOR_PEPPER` | **No.** Zero occurrences repo-wide outside PR #475's own module. Not in `artifacts/api-server/.env.example`, not in `src/lib/envValidation.ts`, not in `.github/workflows/`, not in `.replit`, not in `check-missing-secrets.sh`, not in `audit-runtime-env*.sh`. |
| 2 | `INTEL_GROUP_KEY_SECRET` | **No source, but read by live code.** Not in `.env.example`, and absent from both `REQUIRED_KEYS` and `OPTIONAL_KEYS` (`artifacts/api-server/src/lib/envValidation.ts:9-22`). It is read with the same `?? SESSION_SECRET` fallback by `src/lib/intelGroupKey.ts:69-72` and `src/lib/intelMissionNonce.ts:40-42`. |
| 3 | `SESSION_SECRET` | **Yes.** Required at boot — `envValidation.ts:13`, enforced by `assertRequiredEnv` (`:43-68`, `process.exit(1)` at `:66`) — and documented in `artifacts/api-server/.env.example:11`. |

**So the answer is: the pepper has exactly one configured source in this repository, and it is the
third fallback.** Unless an operator sets one of the first two out of band, every
`contributor_token` and `group_token` would be keyed under `SESSION_SECRET`. There is **no
constant fallback** — with none of the three set, derivation throws (`:144-148`), which is the
intended fail-closed behaviour, not a gap.

Two consequences follow from the store's own documentation of its failure mode (`:72-79`):
rotating the pepper makes rows written before the rotation **unrevokable** until they expire; and
`SESSION_SECRET` is a session-signing secret whose rotation is a routine security action taken for
unrelated reasons. Whether that coupling is acceptable, or whether a dedicated
`SENSING_CONTRIBUTOR_PEPPER` must be provisioned before any row is written for a real user, is not
settled anywhere in this tree. It is a decision, and it is recorded here as one (see §3).

---

# 2. Every layer between a device and a stored contribution

Nothing in this tree calls any of the above. PR #475's own tests assert it: a walk of `src/`
asserting no importer outside those modules' tests
(`pr/475:src/test/sensingAnonStore.test.ts:347-357`) and no file naming the table
(`:360-366`). Both tests are in the default `test` script (`pr/475:package.json:58`), so **the
first live import turns CI red until that test is amended in the same PR** — a deliberate
tripwire, not an obstacle to route around quietly.

| # | Layer | What exists | What does not exist |
|---|---|---|---|
| 1 | **Device secret custody** | `travel-buddy-standalone/src/lib/secureStore.ts` — a typed wrapper over `expo-secure-store` (iOS Keychain / Android Keystore), which **silently no-ops on web** (`:8-11`) | No `deviceSecret` is generated, stored or rotated anywhere. No key name, no lifecycle, no deletion behaviour. |
| 2 | **Device-side derivation** | `deriveEpochSecret` and `revocationCommitment` exist as **server-language** definitions using `node:crypto` (`pr/475:src/lib/sensingAnonStore.ts:88`, `:176-189`) | No client implementation, and **no SHA-256/HMAC primitive available to the client**: `travel-buddy-standalone/package.json:36-99` lists no `expo-crypto`, no `@noble/*`, no crypto polyfill; a repo-wide grep for `expo-crypto` and `digestStringAsync` returns nothing. The vendored `expo-openmls` port exposes thread encryption and device signing keys only (`travel-buddy-standalone/src/lib/e2ee/realPort.ts:22-41`). |
| 3 | **Sensor capture + reduction** | Nothing | No producer of `signalBucket`. The ordinal's meaning is pinned by `reduction_version` in code (`pr/475:src/lib/sensingAnonStore.ts:117-122`), and the migration states the vocabulary question is deliberately unanswered and owner-owned (`pr/475:src/migrations/2315_sensing_anon_contributions.sql:70-80`). |
| 4 | **Zone labelling** | `zone_id` is plain text with no FK (`2315:136-140`) | No client or server producer of a `zoneId` for this store. |
| 5 | **Group tag producer** | `deriveGroupToken` accepts an opaque `groupTag` (`sensingAnonStore.ts:215-221`) | **Nothing produces one.** The intel analogue derives `crew:<tripId>` or `solo:<actorId>` (`artifacts/api-server/src/lib/intelGroupKey.ts:14-19`) — the solo form needs an account id, which this store has none of. With every `groupTag` absent, `distinctGroups` is 0 and every cohort refuses with `below_group_threshold` (`privacyGate.ts:101-106` against `minIndependentGroups: 5`, `intelContracts.ts:734`). |
| 6 | **Transport / route** | 143 route modules, mounted in `artifacts/api-server/src/routes/index.ts`; the intel capture family at `:291-300`. The nearest shape for an unauthenticated POST is `src/routes/crashReport.ts:161`, keyed for rate-limiting on `req.ip` (`:162`) and persisting nothing | **No route** accepts a contribution, a revocation, or serves a sensing aggregate. No `POST` and no `GET` names the table or either module (asserted by `pr/475:src/test/sensingAnonStore.test.ts:360-366`). |
| 7 | **Auth posture for an anonymous caller** | `requireUser` (`src/lib/http.ts:185-215`) verifies a Bearer token via the **service-role** client and 401s otherwise; `optionalUser` (`:159-172`) returns null instead of 401. `getServiceClient()` (`src/lib/supabase.ts:17-23`) builds a client from `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` and is the **only** client the server constructs — `ANON_KEY` appears in `src/test/*` RLS-boundary tests only, never in `src/lib` or `src/routes` | No posture for a caller with no account. The store's grants are `service_role`-only (`2315:282-289`), so an anonymous write **must** pass through a server process holding the service-role key; there is no PostgREST-direct option. Nothing decides whether the route is unauthenticated, or authenticated-with-the-identity-discarded. |
| 8 | **Abuse control** | `checkRateLimit(limiterId, userId, limit, windowMs)` — keyed `"<limiter>:<userId>"` (`src/lib/rateLimit.ts:137-143`), best-effort in memory unless `REDIS_URL` is set (`:5-26`) | No per-caller key exists for an anonymous contributor that is not an identity. `crashReport.ts:162` uses `req.ip`, which the store may not hold (§5) and which is not equivalent to a contributor. Nothing decides what an anonymous submission budget is or what it is keyed on. |
| 9 | **Lawful basis / purpose registration** | `src/lib/locationPurposes.ts` — twelve registered purposes, each with lawful basis, retention, visibility and deletion behaviour (`:1-25`, entries at `:102-314`). Contribution consent is server-authoritative and **per-account**: `hasValidIntelConsent(sc, actorId)` (`src/lib/intelConsent.ts:1-18`, `:42`) | No purpose entry claims `sensing_anon_contributions`. The mechanical check would not force one: `src/scripts/checkLocationPurposes.ts` scans the baseline for coordinate columns only (`COORD_COLUMNS`, `:37-40`) and this table has none, so its silence is not clearance. The existing consent mechanism is keyed on an account id and cannot represent an anonymous contributor at all. |
| 10 | **TTL sweep invocation** | `purge_expired_sensing_contributions(timestamptz)` exists, is `SECURITY DEFINER`, `service_role`-only (`2315:216-232`, `:262-265`). The house pattern for calling one is `src/lib/intelRetentionScheduler.ts` — flag-gated, fail-closed, distinguishing `disabled` / `no_client` / `error` (`:47-78`, `:125`) — started from `src/index.ts:135` | **No scheduler, no caller.** No `pg_cron`: no migration in `src/migrations` contains `cron.schedule` or `pg_cron`, so sweeps run only from the Node schedulers listed at `src/index.ts:110-171`. Rows would persist to their `expires_at` and then sit there. |
| 11 | **Aggregation read + consumer** | `aggregateSensingCohort` returns a decision and publishes nothing (`sensingCoverageAggregate.ts:66-69`). The analogous wired path for intel is producer → snapshot table → admin route (`src/lib/intelCoverageScheduler.ts:1-16`, `src/routes/intelCoverage.ts:1-15`, `requireAdmin` on every route) | No caller computes a cohort key, no caller reads a cohort, nothing consumes a `SensingCohortAggregate`. No surface displays one. |
| 12 | **Feature flag** | `isFlagEnabled(sc, flag)` reads `feature_flags` fail-closed (`src/lib/featureFlags.ts:14-24`); flags are seeded OFF by migration (house pattern) | No flag row exists. Grep for `sensing` across `src/migrations/*.sql` returns nothing. |
| 13 | **Schema presence in production** | `2315` applied to portava-ci (supplied) | Not applied to production (supplied). Until it is, an input path has no table to write to there. |

---

# 3. What the ruling permits, what needs a decision, and what it forbids

The ruling is an **enumeration of what the store may own**: "privacy-reduced sensor
contributions, rotating IDs, TTL, cohort/coverage aggregation and revocation". It is silent about
transports, clients and surfaces. Silence is not permission and it is not prohibition; below,
silence is classified as *needs a decision*, and the reasoning is given each time.

## 3.1 Not built, but clearly inside the ruling

| Item | Why it is inside |
|---|---|
| **A TTL sweep that calls `purge_expired_sensing_contributions`** | "TTL" is named in the ruling's enumeration, and the function is already part of the permitted store (`2315:216-232`). A scheduler calling it deletes rows and adds nothing. It is still subject to how it lands, not whether: `ROADMAP.md:487-488` — *"Behaviour-preserving at introduction. Every stage lands inert."* |
| **Server-side re-derivation of a revocation token from a presented `epochSecret`** | "revocation" is named. `revocationTargetToken` (`sensingAnonStore.ts:472-478`) and the SQL function are the mechanism the ruling contemplates. This covers the derivation and the delete — **not** the endpoint that receives the secret (§3.2). |
| **Calling `aggregateSensingCohort` over a cohort and obtaining a decision** | "cohort/coverage aggregation" is named. The function publishes nothing (`sensingCoverageAggregate.ts:66-69`) and imports the shared gate rather than restating a threshold (`:71-75`). Computing the decision is inside; acting on it in a user-visible surface is not (§3.2). |
| **Writing a contribution through `recordSensingContribution` from a server process holding `service_role`** | "privacy-reduced sensor contributions" is named, and the write path with its validation already exists (`sensingAnonStore.ts:307-387`). What is *not* settled is where the input comes from — every one of layers 1–8 above. |

Note that even these four are gated on process, not on the ruling: `2315` reaching production is
an operator action (`ROADMAP.md:485-486`), and any flag they hang from would be a new seeded-OFF
row.

## 3.2 Not built, and needs an owner decision

| Item | Why it is not merely engineering |
|---|---|
| **Any HTTP route — ingest, revoke, or read** | The ruling says nothing about a transport. Adding one is the step that turns an inert store into a reachable surface, and it forces three sub-decisions below (posture, abuse budget, revocation UX) that are privacy decisions, not implementation details. |
| **The auth posture for an anonymous caller** | Two coherent shapes exist and the tree contains no basis for choosing: unauthenticated (the `crashReport.ts:161` shape) or authenticated-then-identity-discarded. The second means an account token is presented on a request that writes an unlinkable row — the row stays anonymous, the *request* does not. Which is acceptable is an owner judgement about the boundary, not a code style question. |
| **The abuse budget and what it is keyed on** | There is no anonymous per-caller key in this codebase that is not an identity (`rateLimit.ts:137-143` takes a `userId`; `crashReport.ts:162` uses `req.ip`). The obvious fixes — a device handle, a persistent installation id — are structurally refused by the store (§5) and would need to live somewhere else, which is a decision about where. |
| **A `groupTag` producer** | Nothing derives one, and the intel analogue's "solo counts as a group" form is `solo:<actorId>` (`intelGroupKey.ts:17-19`), which needs the account this store does not have. Deciding what constitutes an *independent group* among anonymous contributors is exactly the judgement `privacyGate`'s ≥ 5-group clause depends on (`privacyGate.ts:98-106`) — and getting it wrong inflates independence, the one direction the gate cannot tolerate. |
| **What `signal_bucket` means (the reduction pipeline, and which sensor)** | The migration states this outright: choosing a signal vocabulary "is a product decision with a named owner, not a schema decision an engineer makes from memory" (`2315:70-80`). Picking what the five ordinals encode is that decision in a different place. |
| **Client capture at all** | Device secret custody, generation, rotation and deletion (layer 1); a client hash primitive that does not exist today (layer 2); whether capture is foreground-only; what the user is told. None of this is named by the ruling, and all of it is user-facing behaviour. |
| **A lawful basis / purpose registry entry** | `locationPurposes.ts:1-25` records the ruling that *every* location-processing purpose carries a documented lawful basis, retention, visibility and deletion behaviour. The automated checker will not force one here (it scans for coordinate columns, `checkLocationPurposes.ts:37-40`), and the existing consent gate is per-account (`intelConsent.ts:42`) so it cannot express consent for an anonymous contributor. Whether an entry is owed, and under which basis, is a decision — and its absence is currently invisible to CI, which is why it is written down here. |
| **Whether a dedicated `SENSING_CONTRIBUTOR_PEPPER` must be provisioned first** | Today the only configured source is `SESSION_SECRET` (§1.5). Coupling revocability to a session secret's rotation schedule is a tradeoff someone has to accept or refuse before real contributions exist. |
| **Publishing any aggregate to a user-visible surface** | The ruling permits *aggregation*; a published surface is a product change. `aggregateSensingCohort` returning `publishable: true` is a permission, not an instruction, and there is no consumer (`sensingCoverageAggregate.ts:66-69`). |
| **Applying `2315` to production** | `ROADMAP.md:485-486`: *"Production writes are staged for the operator, with before/after verification. **Never applied by the agent.**"* |
| **Enabling any flag that would make an input path live** | Same discipline (`ROADMAP.md:487-488`), and the standing shape everywhere else in this tree: seeded OFF by migration, flipped by an owner. |

## 3.3 What the ruling forbids outright

These are not judgement calls. Each is enforced by a postcondition that **fails the migration at
apply time**, so a violation cannot ship quietly (`2315:302-400`).

| Forbidden | Enforcement |
|---|---|
| A permanent `profiles` / `auth.users` FK | `2315:316-328` |
| **Any** foreign key at all — a join out is a re-identification path | `2315:332-338` |
| A column merely *named* like an account or device handle: `user_id`, `actor_id`, `profile_id`, `account_id`, `auth_id`, `owner_id`, `created_by`, `contributor_id`, `device_id`, `session_id`, `installation_id` | `2315:341-352` |
| Claim/review/status/conflict/snapshot semantics: `status`, `state`, `claim_type`, `claim_id`, `claim_family`, `value`, `conflict*`, `snapshot*`, `review*`, `reviewer_id`, `verdict`, `moderation_state`, `visibility`, `confidence`, `superseded_by`, `promotion_source`, `prior_status`, `new_status`, `source_class` | `2315:355-368` |
| A second intel lifecycle — promoting a contribution into evidence → claims → snapshots | The ruling's own words; structurally, there is nothing to promote: no claim type, no value, no free text (`2315:63-68`) |
| Rows living longer than 72 h | CHECK at `2315:171-172`, postcondition that the CHECK exists at `2315:386-391` |
| An `anon` or `authenticated` policy on the table | `2315:291-293`, postcondition at `2315:377-383` |

Two consequences worth stating plainly, because they are the shapes an input path would most
naturally reach for:

- **An anonymous input path may not be built by granting the `anon` PostgREST role INSERT.**
  Grants are revoked from `PUBLIC`, `anon` and `authenticated` and given only to `service_role`
  (`2315:282-289`) — and the api-server holds exactly one credential, the service-role key
  (`src/lib/supabase.ts:17-23`). The write must traverse the server.
- **An input path may not solve abuse by storing a device or installation identifier**, however
  hashed the column's *contents* are: the postcondition refuses the column **by name**
  (`2315:341-352`), and the reasoning given is that a handle is a permanent identity even without
  a constraint.

`UPDATE` sits slightly apart: it is granted to nobody (`2315:285`, reasoning at `2315:295-297`).
That is structural refusal rather than a clause of the ruling — recorded here so it is not
mistaken for either.

---

# 4. Standing gates in `docs/discovery/ROADMAP.md`

| Gate | Line | Does it apply? |
|---|---|---|
| **"COMPLETE coverage matrix, 7 destinations × 4 categories — outranks starting any new feature"** (measurement-system rulings, 2026-08-15) | `ROADMAP.md:290` | **Yes, on its face.** An anonymous sensing input path is a new feature, and this ruling orders it behind a measurement that this document cannot confirm is complete. |
| **"Production writes are staged for the operator… Never applied by the agent."** | `ROADMAP.md:485-486` | **Yes, directly.** Applying `2315` to production is an operator action. |
| **"Behaviour-preserving at introduction. Every stage lands inert."** | `ROADMAP.md:487-488` | **Yes.** It governs *how* anything in §3.1 may land, not whether. |
| **"Migrations must be applied to BOTH projects."** | `ROADMAP.md:489-492` | **Yes.** `2315` in CI and not in production is precisely the divergence this warns about; note the warned failure mode is the reverse (production-only apply leaving CI red), so the current direction is the safer one — but it is still a divergence. |
| **Phase F — Owner gates, ❄️ FROZEN + NOT AGENT WORK** | `ROADMAP.md:534`, section at `:1609-1612` (*"Build nothing past these"*) | **Not by its terms.** Both gates name discovery flags: enabling `shadow` for a cohort, and the `pde`-serving flip, both on `DISCOVERY_ENGINE_MODE` (`:1613-1616`); the third recorded hold is `discovery_ranking_modifiers_enabled` (`:1617-1623`). None names sensing. What *does* carry across is the sentence the section exists to make unmissable — *"Building the mechanism that makes a decision available is not the decision"* (`:1625-1628`) — which is exactly the posture PR #475 took. |
| **Step 2, EVENT TRUTH — "NOT STARTED — gated. Packet written; no migrations, no tables"** | `ROADMAP.md:944`; sequence live as of 2026-08-15 (`:212`), with *"Event Truth remains the next architectural foundation"* at `:221` | **Not directly.** Event Truth is the discovery decision store (sessions, runs, exposures, attribution); it does not name sensing and the anonymous store writes none of those objects. It applies **indirectly through ordering**: the ruled sequence puts Event Truth next, and `:222` puts ranker work on explicit hold. Whether an anonymous sensing input path may jump that sequence is not answered anywhere in the ROADMAP, which makes it a decision, not a permission. |

No line in `ROADMAP.md` mentions sensing, the anonymous store, or `2315`
(grep for `sensing` / `anonymous` returns only `:1474`, an unrelated use of "Anonymous callers").
**The absence of a sensing gate is not a clearance** — it means the ROADMAP has not been asked
about this work.

---

# 5. Privacy obligations an input path would have to keep satisfying

These are enforced by the `DO $$` block at `2315:302-400`, which runs inside the same transaction
as the DDL (`BEGIN` at `:102`, `COMMIT` at `:402`). A migration that violates one **raises and
rolls back** — the obligation cannot be dropped by a later edit that forgets it, only by deleting
the postcondition, which is a visible act in a diff.

| Obligation | Postcondition | What it forecloses for an input path |
|---|---|---|
| **No FK to `profiles` / `auth.users`** | `:316-328` | Linking a contribution to the account that submitted it, ever. |
| **No foreign key at all** | `:332-338` | Also forecloses the innocent-looking ones — a zone FK to reference geometry, a place FK — because the postcondition's stated reason is that any join out is a re-identification hop. |
| **No identity-shaped column name** | `:341-352` | Rules out `device_id` / `session_id` / `installation_id` as an abuse or dedup key on this table. Any such mechanism has to live outside the store. |
| **No claim/review/status/conflict/snapshot column** | `:355-368` | Rules out marking a contribution "reviewed", "superseded", "promoted" or "in conflict" — i.e. any input path that wanted a workflow on top of ingest. Also rules out a `value` or `claim_type` column, so a richer payload cannot be smuggled in as one. |
| **TTL ≤ 72 h, structurally** | CHECK `:171-172`, postcondition `:386-391` | A row longer-lived than 72 h is unrepresentable. An input path cannot offer "keep my contributions until I delete them", and the client-side `ttlSeconds` is pre-refused above the ceiling (`sensingAnonStore.ts:332`) before the round trip. |
| **RLS on, `service_role` only, zero anon/authenticated policies** | `:371-375`, `:377-383`; grants at `:282-289` | The write must go through a server holding the service-role key. No direct-from-client insert, no user-facing read of the table. |
| **Both functions exist** | `:394-399` | A future migration cannot drop the sweep or the revocation path and still apply. |

One thing these do **not** enforce, stated so it is not assumed: the postconditions bind the
*schema*, not the *route*. Nothing structural stops a route from logging a submitter's IP or
account id in the request log while the row it writes stays clean. That is a property of the
transport, and the transport does not exist yet — which is where it should be decided.

---

## What is deliberately not in this document

- **No Sensing specification is cited, quoted or reconstructed.** None is in this repository. Every
  requirement above comes from the owner ruling, the migration's own postconditions, the
  ROADMAP, or code in this tree.
- **No design for the input path.** The layers in §2 are named as absent, not sketched.
- **No database was queried**, and no file was changed outside this one. The apply state of
  `2315` (CI yes, production no) is carried as a supplied measurement, flagged as such in §0.
- **This file is not in the `check-doc-citations.mjs` registry** (`COVERED`,
  `artifacts/api-server/scripts/check-doc-citations.mjs:98-123`, which names
  `docs/architecture/00_STATUS.md` and `01_Portava_Discovery_Engine.md` individually), so its
  citations are not machine-enforced. Its `pr/475:` citations could not be, in any case: those
  lines are not in this branch.
