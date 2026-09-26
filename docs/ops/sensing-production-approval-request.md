# Sensing — the one consolidated production approval request

Prepared 2026-09-26 on branch `claude/sensing-completion-20260925` (PR #528).
**Nothing below has been executed on production** (`ajrurzioarfkagpuxfnb`),
which has only been read. Every schema step has been applied and verified on
`portava-ci`. The step-by-step procedure is
`docs/ops/sensing-cutover-runbook.md`; this page is the decision the owner
takes, in the order it must be taken.

Four states, kept apart on purpose:

| State | Where this work is |
|---|---|
| Built on the branch | yes, all of it |
| Merged | no |
| Deployed | no |
| Flag enabled / realised in production | no |

---

## 1. What user consent permits today, and what `surface` would need

**Today nobody has consented to having their passive sensing shown to
anyone.** Every recorded consent is `intel_contributions_v1`. Its words, the
only words anyone has agreed to, describe Quick Signals: explicit taps
combined with other travellers' reports. They say nothing about the phone
sensing in the background, and nothing about showing passive contributions
to other people.

**Changing the policy constant alone does not establish consent, and on this
branch it cannot surface anything.** `SENSING_ANON_GRANTED_SCOPES` is the
owner's ruling on what the store may do. The code now carries, separately,
what each person agreed to:

- a session carries the intersection of the policy and its holder's recorded
  consent (`lib/sensingConsentScopes`), so under v1 no session is issued at
  all;
- each contribution records whether its own session carried `surface`
  (3315's `surface_permitted`, default `false`);
- the publisher counts only those contributions, so a cohort publishes only
  if at least k people who each agreed to be shown are in it.

**What would permit the proposed surface disclosure:** a person granting the
v2 disclosure (`docs/contracts/sensing-consent-disclosure-v2.md`), whose third
paragraph reads: *"When enough people are counted, other travelers may see
that people are around a place right now, or that it isn't known. Never how
many, and never who."* That permits one thing: a zone-level "people are here"
or "not known", after the crowd threshold and the differencing gate. It does
not permit a count, a band, a list or anything that singles out a person.
It covers only contributions made under sessions issued after that person's
own grant. Existing v1 holders are not migrated; each must grant v2 anew.

---

## 2. The approvals requested, in order

Each numbered item is a separate decision. A later item does nothing useful
without the earlier ones, and the code refuses in that order.

### A. Schema on production

Apply with `scripts/src/apply-migrations.ts` where the service-role
credentials exist, so the ledger row and checksum are the runner's.

| Step | Files | Window | Prerequisite | Verify (read-only; runbook §2) | Recover |
|---|---|---|---|---|---|
| A1 | `2277`, `2278` | any time | Q0 all sensing tables empty | ledger rows; their own sections in `docs/migrations.md` | their rollbacks |
| A2 | `3002 → 3003 → 3310`, then the code (B1) | **one quiesced window** | A1; identity runbook §4 steps 1–4 | identity runbook §6; Q2 `subject_nullable = YES`, `pepper` non-NULL | identity runbook §5a, only while Q0 is all-zero; never un-quiesce on a failed deploy |
| A3 | `3311` | before B1 | — | Q2 `provenance_cols = 2`; both GIN indexes | `db/rollback/2026-09-26-3311-…`, then its ledger row |
| A4 | `3312` | before the client release (B2) | — | Q2 `feature_checks = 3`; 15 nullable columns; 0 FKs | `db/rollback/2026-09-26-3312-…`, then its ledger row |
| A5 | `3004`, `3110`, `3313` | before any flip in C | — | Q3 each seed `false` **and** Q1 its ledger row (a flag seed is invisible to schema checks); `published_store` non-NULL | each seed's rollback; 3110's own section |
| A6 | `3314` | before `memory_projection` ON | Q2b shows 2195's body (read 2026-09-26: it does) | Q2 `claim_refs = _uuid`; the GIN index; Q2b md5 `c12a0ff3cf71a23373b03f025fb2a938` | `db/rollback/2026-09-26-3314-…` (refuses while any session memory exists) |
| A7 | `3315` | before `surface` (E) | — | Q2 `surface_col = boolean`; zero rows read `true` | `db/rollback/2026-09-26-3315-…` (refuses while any row reads `true`) |
| A8 | `2841` (seeds `experience_session_enabled` FALSE) | before F2's verification | none; it adds no table (sessions are two rows on the existing `canonical_events`, present on production) | Q1 its ledger row **and** the flag row reading `false` (read 2026-09-26: applied on portava-ci by CI; **absent on production**, no ledger row, no flag row) | its postcondition refuses a TRUE seed; delete the row and the ledger row |

### B. Code and client

| Step | Change | Prerequisite | Verify | Recover |
|---|---|---|---|---|
| B1 | Deploy the api-server from PR #528's merged head | inside A2's window; A3 before it | runbook §4 smoke: publisher logs `surface_scope_not_granted`; no `provenance_unavailable`; `POST /v1/sensing/session` answers the pepper refusal | roll back the deploy while still quiesced (identity runbook §5) |
| B2 | Ship the client build (capture loop, commitment, consent gate by version) | A4 | the installed client does not start capture under v1 consent | ship the previous build; the server accepts both shapes |

### C. Operator artifact

| Step | Change | Prerequisite | Verify | Recover |
|---|---|---|---|---|
| C1 | Set `SENSING_CONTRIBUTOR_PEPPER` in the production environment | A2 | the ingest and the issuer stop answering the pepper refusal; the issuer then answers `disclosure_does_not_cover_passive_sensing` for every account (expected until D) | unset it; both refuse again |

### D. Consent v2 — the owner's decision on words, then one release

| Step | Change | Prerequisite | Verify | Recover |
|---|---|---|---|---|
| D1 | Approve the v2 title, four paragraphs, footnote and settings summary in `docs/contracts/sensing-consent-disclosure-v2.md`, or supply replacements | — | the client module and the contract file carry the same words | — |
| D2 | Decide whether the settings switch may grant v2 from its one-line summary, or must open the full text first | D1 | — | — |
| D3 | One release: `INTEL_CONSENT_DISCLOSURE_VERSION = "sensing_contributions_v2"` in `lib/intelConsent.ts` together with a client carrying the D1 words | D1, D2, B2 | `GET /v1/intel/consent` returns `currentDisclosureVersion: sensing_contributions_v2`; a grant from an older client is refused 409; a new grant records v2 | revert the constant in one release; v2 grants already recorded stay recorded and keep their meaning |

After D3, people who choose to grant v2 get sessions with
`collect`, `retain`, `aggregate`. Not `surface`, until E.

### E. The `surface` scope — the policy change

| Step | Change | Prerequisite | Verify | Recover |
|---|---|---|---|---|
| E1 | Add `"surface"` to `SENSING_ANON_GRANTED_SCOPES` in `lib/sensingContributionPolicy.ts`, reviewed and deployed | A7, D3 | new v2 sessions carry `surface`; contributions under them read `surface_permitted = true`; v1 holders and pre-E1 contributions read `false` | revert the line and deploy; the publisher and producer refuse on the next call |

### F. Flags — exact values

Every flag below reads `false` or has no row on production today (read
2026-09-26; `experience_session_enabled`, `sensing_publication_enabled` and
`sensing_presence_context_enabled` have no row because 2841, 3313 and 3004
are not applied there). The two capture flags `intel_capture_quick_signal` and
`intel_trail_followup` are `true` there and are **not** changed by this
request.

| Step | Flag | Value | Rows it serves | Prerequisite | Verify | Recover |
|---|---|---|---|---|---|---|
| F1 | `discovery_candidate_projection_enabled` | `true` | S49 | none on this branch | a served candidate carries `coverage` | set `false` |
| F2a | `experience_session_enabled` | `true` | S92, S112 (the sessions a memory is made from) | A8. An owner decision in its own right: it opens routes that WRITE canonical events for a person (open, read, close their own session; 12-hour lookback; no coordinate stored) | `GET` of the viewer's open session stops answering `feature_disabled` | set `false`; the routes refuse at once |
| F2 | `memory_projection` | `true` | S92, S112 | A6, F2a | the memory scheduler stops answering `disabled`; closing an eligible session writes one memory with its `claim_refs` | set `false`; the sweep expires what was projected |
| F3 | `sensing_publication_enabled` | `true` | S39, S24 | A5, A7, C1, E1, and at least k v2 contributors per cohort | `sensing publication pass` logs `published > 0`; new rows in `sensing_published_aggregates` carry no contributor column | set `false`; rows expire within 24 h, or `delete from public.sensing_published_aggregates` |
| F4 | `sensing_presence_context_enabled` | `true` | S39 | F3 | a Compass turn with `sensingZoneIds` gets the `[Zone presence …]` header, observed or unknown only | set `false`, before F3 |

### G. Outside every tool in this environment

| Step | Change | Verify |
|---|---|---|
| G1 | Republish `https://portava.replit.app` successfully (the last publish reads `failed`) | the publish status reads success |
| G2 | From outside the CI proxy: `curl -sI https://portava.replit.app`; obtain Supabase's at-rest encryption attestation | HSTS and TLS in the served headers (S17) |

---

## 3. What each approval moves, and what it cannot

| Rows | Moved by | Still not "production realised" until |
|---|---|---|
| S19 S97 S111 S118 | A1, A2, B1 | a real capture lands with a non-null contributor token |
| S18 S32 | A2, B1, C1, D3 | a v2 holder's device obtains a session and a contribution is written |
| S112 | A3, A6, A8, F2a, F2 | an erasure runs with both steps logged and no failures |
| S92 | A6, A8, F2a, F2 | a closed session produces a memory |
| S49 | F1 | a candidate is served with coverage |
| S39 S24 | A5, A7, C1, D3, E1, F3, F4 | a publication is recorded and a Compass turn reads it |
| S26 S66 | real use | real contributions meet the gates |
| S17 | G1, G2 | the headers are read |

## 4. Boundaries this request keeps

- No step here is executed by the integration owner. Production has been
  read, never written.
- The 2481 ledger row on `portava-ci` stays as it is.
- No consent is recorded, migrated or inferred on anyone's behalf.
- No individual contribution is ever exposed: publication is k-gated,
  differencing-gated and carries no contributor column, and consent is one
  bit per row that is never published.
