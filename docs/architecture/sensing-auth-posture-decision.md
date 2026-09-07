# OWNER DECISION REQUIRED: SENSING_AUTH_POSTURE

*2026-09-07. Nothing in this document was applied to any database. Migrations 2480 and 2481 were
dry-run inside ONE rolled-back transaction on portava-ci (`hwokxgbmezheskbzskfr`): every
precondition, postcondition and functional probe passed, then `ROLLBACK`; a read afterwards
confirmed no table, no function and no ledger row exists. Production (`ajrurzioarfkagpuxfnb`)
was read for aggregate counts only.*

## The reframing the decision rests on

The structural cap on Sensing is `intel_observations.actor_id uuid NOT NULL REFERENCES
profiles(id)` (`2130_intel_storage.sql:142`). It caps Sensing **only if passive contributions must
enter that table**. They need not: `sensing_anon_contributions` (2315, CI-only) is already the
anonymous contribution store — no FK, rotating peppered tokens, 72 h TTL, one row per contributor per
cohort (2340), identity-free revocation — and its aggregates are consumed as a projection
(`lib/sensingPresenceState.ts`), never promoted into the canonical lifecycle. **The FK stays exactly as
it is for human claims.** What is missing is not schema but a decision: *who is eligible to obtain a
contribution credential*. Spec §3: *"Separate contribution eligibility/authentication from signal
ingest where practical: eligibility proves an authorized participating device; ingest receives an
opaque short-lived credential."*

Both options therefore share the same store, the same ingest and the same credential shape; they
differ in the eligibility proof and in what the abuse budget is keyed on. The identity used to prove
eligibility is discarded before ingest under **every** posture — the contribution row has no column
it could occupy (2315's postconditions), and 2480's postconditions forbid a session column on the
contribution side.

---

## OWNER DECISION REQUIRED: SENSING_AUTH_POSTURE

**Current behavior:** `lib/sensingAuthPosture.ts` ships `SENSING_AUTH_POSTURE = "undecided"`, a
constant (no env var, no flag). While undecided, `sensingEligibility()` refuses every caller —
profile, attested device, or neither — with `posture_undecided`. There is no route (the tripwire
`test/sensingAnonStore.test.ts` forbids one and is correct), 2315/2340 exist in CI only, no
`SENSING_CONTRIBUTOR_PEPPER` is known to be set, and every intel table holds 0 rows in production.
Sensing observes nothing.

**Risk:** *Of not deciding:* every Sensing row from S20 onward stays blocked behind an absence of
policy rather than an absence of code; the machinery built for it (2315/2340, policy, presence,
vibe, lineage, differencing) never gets an input. *Of Option A:* a coverage floor Sensing cannot
reach from the current population (below). *Of Option B:* a new dependency on platform integrity
attestation that does not exist in this repo, and — if unattested devices are admitted — an abuse
surface bounded only by budgets.

### Option A (authenticated-only)

- **What it costs.** Eligibility = an authenticated profile (`requireUser`). The contributor
  population is the signed-in, consenting user base. Production on 2026-09-07: **58 profiles total,
  4 updated in 30 days, 0 in 7 days, 0 rows in `intel_contribution_consent`, 0 location snapshots.**
  The privacy gate (`PRIVACY_THRESHOLD_V1`) publishes a cohort only at **≥ 15 distinct contributors
  from ≥ 5 independent groups, none above 20 %, in one zone in one 30-minute bucket**; the
  differencing gate (`lib/sensingDifferencingGate.ts`) re-publishes only on a change of **≥ 5**
  contributors; the revocation lineage assumes a cohort survives one device leaving. From 58 accounts
  no zone-bucket will clear k = 15 for the foreseeable term, so under Option A every
  `SensingPresenceState` is `unknown` and every vibe inference is `null` until the signed-in,
  consenting, co-located population is roughly an order of magnitude larger. That is honest: the
  system reports "no coverage", not "quiet".
- **What it unblocks.** The abuse budget is keyed on the profile (existing `lib/rateLimit`
  `checkRateLimit(limiter, userId, …)`), which resolves owner decision #3 by construction; consent
  can reuse the per-account `intel_contribution_consent` (S25's existing control); an operator can
  revoke everything an abusive account obtained via 2481's `revoke_sensing_sessions_for_profile`.
  No new platform dependency.
- **What code exists for it now.** `sensingEligibility(ctx, "authenticated_only")` →
  `{issuanceClass:"authenticated_profile", budgetKey:"profile:<id>"}`; `lib/sensingContributionSession.ts`
  issuance/validation/budget; migration **2480** (sessions, no identity) + **2481** (the Option-A-only
  nullable `issued_to_profile_id` ledger with a CHECK that makes an anonymous session row
  unrepresentable) — both dry-run, unapplied. §3's "narrowly justified" clause for 2481's FK is
  written into the file: the ledger is short-lived (≤ 72 h, purged), is the abuse control A depends on,
  and can never reach a contribution (postconditions on both tables).

### Option B (anonymous-capable)

- **The chosen minimal schema change, and why.** Three candidates were weighed in
  `2480_sensing_contribution_sessions.sql`'s header:
  1. *Nullable `actor_id` + anonymous provenance on `intel_observations`* — **rejected**: every
     guarantee on that table is keyed on `actor_id` (RLS `actor_id = auth.uid()`; the replay key
     `UNIQUE (actor_id, idempotency_key)` — NULLs are distinct, so anonymous rows would have no
     replay protection; `erase_intel_for_actor`; `intelGroupKey`'s `solo:<actorId>`; `privacyGate`'s
     distinct-actor count). It would also mix passive features into a table of human claims — the
     second lifecycle the ruling forbids.
  2. *A separate anonymous source table* — **already exists**: 2315.
  3. *Wire what exists* — **chosen**: add only the missing piece, the **credential**:
     `sensing_contribution_sessions` (2480). No change to `intel_observations`.
- **Abuse controls.** A session carries `budget_cohorts_remaining`; `sensing_session_consume()`
  decrements it atomically (`FOR UPDATE`) and returns a named reason. Budget is consumed only after a
  *non-duplicate* write, so a replay (2340's key) costs nothing and gains nothing; a device that sprays
  cohorts exhausts its budget and must re-issue, which under B costs a fresh attestation. Defaults
  (`SENSING_SESSION_DEFAULT_BUDGET`, proposals not policy): attested 48, profile 48, unattested 8.
- **Rate limits.** Keyed on the credential hash, never an identity (`budgetKey: "credential"`);
  issuance itself rate-limited per attestation key (server-side, needs the attestation primitive).
- **Device/session privacy.** The bearer is 32 random bytes, stored only as
  `HMAC(SENSING_CONTRIBUTOR_PEPPER, bearer)` (`deriveSensingCredentialHash`); the session row has no
  identity column (postcondition-refused names) and no contribution has a session column (2315,
  re-asserted by 2480). The join exists only inside one request. Sessions live ≤ 72 h (CHECK).
- **Provenance.** `issuance_class ∈ {attested_device, unattested_device, authenticated_profile}` on
  the session, `policy_version` and `reduction_version` pinned; a contribution's provenance is its
  `reduction_version` and the state's `provenance.source = "sensing_anon"`.
- **Retention.** Sessions: `purge_expired_sensing_sessions()` removes expired/revoked rows (the
  sweep needs registering in `index.ts` beside `sensingRetentionScheduler` — code not yet written,
  trivially the same shape). Contributions: unchanged (2315/2340).
- **Moderation.** Nothing to moderate: no free text, no claim, no media. Abuse is budgets + k-gate +
  differencing gate.
- **Deletion.** Device: `revoke_sensing_session(credential)` + epoch-secret reveal for rows
  (`revoke_sensing_contributions`, existing). Operator: by credential hash. No account exists to
  cascade from. Lineage per `lib/sensingRevocationLineage.ts`.
- **RLS.** RLS on, `service_role` policy only, `REVOKE ALL … FROM service_role` then
  `GRANT SELECT, INSERT, DELETE` — **no UPDATE to any role**; budget decrement and revocation happen
  only through `SECURITY DEFINER` functions. Postconditions assert all of it.
- **What B additionally needs that does not exist:** a server-verified platform integrity
  attestation (App Attest / Play Integrity). `grep` finds none in `travel-buddy-standalone` or the
  server. Until it exists, B admits only profiles — unless the owner sets
  `SENSING_ALLOW_UNATTESTED_DEVICES = true` (seeded false), which is a separate, explicit acceptance
  of the abuse exposure.
- **Migration SQL:** `src/migrations/2480_sensing_contribution_sessions.sql` (both options),
  rollback `db/rollback/2026-09-07-2480-…`. 2481 is **not** applied under B.

#### PRE verification SQL (run before 2480, on the target database)

```sql
select to_regclass('public.sensing_anon_contributions') is not null            as store_present,       -- must be true
       exists(select 1 from pg_indexes where indexname='sensing_anon_contributions_replay_idx') as replay_key_present, -- true
       to_regclass('public.sensing_contribution_sessions') is null              as sessions_absent,     -- true
       (select count(*) from pg_constraint where conrelid='public.sensing_anon_contributions'::regclass and contype='f') as store_fks; -- 0
```

#### POST verification SQL (after 2480; after 2481 add the last two)

```sql
select (select indisunique from pg_index i join pg_class c on c.oid=i.indexrelid where c.relname='sensing_contribution_sessions_credential_key') as credential_unique, -- true
       has_table_privilege('service_role','public.sensing_contribution_sessions','UPDATE')  as sr_update,   -- false
       has_table_privilege('service_role','public.sensing_contribution_sessions','INSERT')  as sr_insert,   -- true
       has_table_privilege('authenticated','public.sensing_contribution_sessions','SELECT') as auth_select, -- false
       (select relrowsecurity from pg_class where oid='public.sensing_contribution_sessions'::regclass) as rls, -- true
       (select count(*) from pg_policies where tablename='sensing_contribution_sessions' and ('anon'=any(roles) or 'authenticated'=any(roles))) as user_policies, -- 0
       (select count(*) from pg_constraint where conrelid='public.sensing_contribution_sessions'::regclass and contype='f' and conname<>'sensing_contribution_sessions_issuer_fk') as unexpected_fks, -- 0
       (select count(*) from pg_constraint where conrelid='public.sensing_anon_contributions'::regclass and contype='f') as store_fks, -- 0 (still)
       (select count(*) from information_schema.columns where table_name='sensing_anon_contributions' and column_name in ('session_id','credential_hash')) as store_session_cols, -- 0
       to_regprocedure('public.sensing_session_consume(text, timestamptz)') is not null as consume_fn, -- true
       -- Option A only:
       (select is_nullable from information_schema.columns where table_name='sensing_contribution_sessions' and column_name='issued_to_profile_id') as issuer_nullable, -- 'YES'
       to_regprocedure('public.revoke_sensing_sessions_for_profile(uuid, timestamptz)') is not null as revoke_for_profile_fn; -- true
```

Functional probe (identical to the rolled-back dry-run) is in the session test's expectations:
budget 2 → ok, ok, `budget_exhausted`; unknown hash → `unknown`; +2 h → `expired`; revoke →
`revoked`; purge → 1; an anonymous session under 2481, an unknown scope, and a 73 h lifetime are all
`check_violation`.

### Recommended

**Option B**, but staged: apply 2480 only, keep `SENSING_ALLOW_UNATTESTED_DEVICES = false`, and issue
credentials to profiles first (B admits profiles) while the attestation primitive is built. That makes
Option A's behaviour the *first stage* of B rather than a competing schema, avoids 2481's profile FK
on a sensing table altogether, and never has to migrate away from A later. The coverage arithmetic is
the deciding fact: A's population (58 / 4 / 0) cannot clear k = 15, and A has no path to growing the
population beyond sign-ups; B's population is every attested install. If the owner rejects the
attestation dependency outright, choose A and apply 2480 + 2481 — everything else is identical.

### What becomes buildable immediately after the decision

- Either posture: set the constant in `lib/sensingAuthPosture.ts`; register the session purge sweep;
  the ingest route (eligibility → `buildSensingSessionRow` / `admitWithSensingSession` →
  `recordAnonSensingContribution` → `sensing_session_consume`) — at which point the tripwire's
  "no route" assertion is amended *deliberately* in the same diff, as it was designed to be; the
  aggregate read through `assessSensingCohortCoverage` → `buildSensingPresenceState` behind a new
  seeded-FALSE flag for whichever surface consumes it. Under A additionally: `checkRateLimit` keyed on
  the profile, consent via `intelConsent`. Under B additionally: the attestation verifier.
- **Stays blocked regardless:** 2315/2340/2480 reaching production (operator), the pepper
  (operator), the `groupTag` producer (owner: independence semantics — without it every cohort
  refuses `below_group_threshold`), `signal_bucket` meaning (owner), client capture (owner),
  publishing any aggregate to a surface (owner), `intel_live_promoted_scopes` (a sibling is building
  the writer), and the holds: Ranker HOLD, Phase F frozen, Event Truth Phase-B, SX-11 must-not-start.

---

## Census rows each option would move

| Row | A | B | Note |
|---|---|---|---|
| S20 separate eligibility from ingest; opaque credential | BC | BC | 2480 + `sensingAuthPosture` + `sensingContributionSession` |
| S30 IntelligenceContributionSession (issued half) | BC | BC | 2480 row = the issued session; policy half already BC |
| S33 replay/rate-limit per credential | BC (profile-keyed budget) | BC (credential-keyed budget) | budget on session + 2340 |
| S35 stale credentials rejected | BC | BC | `expired`/`revoked`/`not_started` |
| S25 purpose scopes | BC | BC | session carries and enforces them |
| S19/S118 no permanent user FK on WI contributions | BC (2481's FK is on the *session*, short-lived, never on a contribution — the "narrowly justified" exception, written) | **BC without exception** | the intel FK stays for human claims either way |
| S26 raw retention | unchanged (intel half is `lib/intel*`) | unchanged | — |
| S13/S23 gate reachability | **realised only if population ≥ k** — not from 58 | realised once attested installs ≥ k | the difference between the options in one line |

Neither option moves "realised in production" until the operator applies 2315/2340/2480, sets the
pepper, and a route exists.

## Hand-revert table (this pass)

| # | Behaviour | Reverted | Restored (`diff -q` clean) |
|---|---|---|---|
| R15 | `undecided` posture refuses everyone | see report | see report |
| R16 | budget refuses at zero | see report | see report |
| R17 | admission uses the session's scopes, not the caller's | see report | see report |
| R18 | 2481's Option A CHECK makes an anonymous session unrepresentable (text) | see report | see report |

**Nothing was applied to any database.**
