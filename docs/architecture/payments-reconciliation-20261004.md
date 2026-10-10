# Payments and Creator Economy — Reconciliation, 2026-10-04

*Written 2026-10-04 against `f71cfb85f` (the `origin/main` tip; merge of PR #586). Analysis and
documentation only — this pass built nothing, applied nothing, flipped no flag and wrote to no
database. **Production (`ajrurzioarfkagpuxfnb`) was not read, not even for aggregates.** Every
deployment fact below is quoted from a committed capture in `artifacts/api-server/baseline/`.
Every `file:line` carries an anchor so the next code move is loud rather than silent
(`artifacts/api-server/scripts/check-doc-citations.mjs:319#good`).*

## Why this document exists

`docs/architecture/09_Payment_Architecture.md` §11 says that everything in its §§3–10 is unbuilt —
*"No migration, no table, no route, no flag"* — and that no processor is chosen, nothing inserts a
payout row, refunds 501 and tax documents are unavailable. A 2026-10-03 measurement repeated that
and placed payments outside its denominator entirely, with no census.

**Half of that is now false, and the half that is false is the structural half.** An append-only,
double-entry, minor-unit, currency-paired ledger exists in the canonical migration chain. So does a
payout-provider interface, a sandbox-only provider-key guard, an integrity-and-audit layer with a
one-transaction door, and an erasure guard that refuses to decide. Thirteen migrations and roughly
twenty-two modules implement §§4–10's shapes. §11's **money** claims remain true: Portava still
moves no money, and the reason is no longer "nothing is built" but "everything built is
CHECK-constrained to be unable to".

§11 is corrected by a dated header on that file. Its body is left unedited, as the four corrected
censuses do.

---

## 1. Inventory — what actually exists

**Count: 88 artifacts.** 22 migrations in the canonical chain + 2 staged outside it, 11 tables and
views, 22 code modules, 5 route groups, 4 feature flags + 3 environment switches, 19 test files.
Reachability is stated per row: *reachable* means a request or a scheduler tick can enter it on
some deployment; *inert* means nothing outside a test can.

### 1.1 Migrations — canonical chain (`artifacts/api-server/src/migrations/`)

| File | What it creates | Applied to production? |
|---|---|---|
| `2170_intel_reward_ledger.sql` | `intel_reward_ledger`, append-only by grant, `CHECK (cash_amount = 0)` | **YES** (`artifacts/api-server/baseline/20260922_production_tables.txt:277#intel_reward_ledger`) |
| `2180_intel_reward_ledger_idempotency.sql` | partial unique `(actor_id, idempotency_key)` | YES |
| `2204_intel_reward_ledger_erasure_grant.sql` | DELETE grant for account erasure only | YES |
| `2900_intel_reward_ledger_reversals.sql` | compensating-entry shape | unknown — not separately captured |
| `2901_rent_buddy_earnings_entries.sql` | **`rent_buddy_earnings_entries`** — the first real ledger | **NO** (absent from `20260922_production_tables.txt`) |
| `2920_creator_attributions.sql` | `creator_rule_versions` + `creator_attributions` | **NO** |
| `2921_creator_earning_entries.sql` | **`creator_earning_entries`** — the creator ledger | **NO** |
| `2922_creator_attribution_flag.sql` | seeds `creator_attribution_enabled` FALSE | **NO** (flag row absent) |
| `2930_creator_share_canonical_view.sql` | `creator_share_ledger` view, 3 partitions | **NO** |
| `3385_creator_share_ledger_includes_creator_entries.sql` | adds the 4th partition (`artifacts/api-server/src/migrations/3385_creator_share_ledger_includes_creator_entries.sql:182#public.creator_earning_entries`) | **NO** |
| `3386_creator_attribution_recommendation_link.sql` | `recommendation_id` + served-recommendation trigger | **NO** |
| `3387_creator_ledger_integrity_and_audit.sql` | balance trigger, audit table, the door (below) | **NO** |
| `3510_creator_ledger_erasure_policy_undecided.sql` | a refusal on all four ledgers | **NO** |
| `2074_rent_buddy_kyc_gate_flag.sql` | `rent_buddy_allow_bookings_without_kyc`, seeded FALSE | YES |
| `2210_rent_buddy_default_off.sql` | forces `rent_buddy_enabled` FALSE | YES |
| `2330_rent_buddy_money_atomicity.sql` | `rb_accumulate_booking_tip`, `rb_buddy_earnings_summary` | unknown — see §5 |
| `2332_money_grant_boundary.sql` | locks client grants on the legacy money tables | unknown |
| `2277_intel_outcomes_attribution.sql` | `intel_attributions`, append-only derived ledger | YES |
| `0171` / `0185` price baselines, `0174` `fx_rates`, `0183` FX flag | reference data | YES |

**Staged deliberately OUTSIDE the chain** — two mutually exclusive answers to the open erasure
decision, held in `reconciliation-staging/` so that merging cannot decide it:
`reconciliation-staging/3511_creator_ledger_erasure_delete_on_erasure.sql` (delete on erasure) and
`reconciliation-staging/3512_creator_ledger_erasure_retain_pseudonymised.sql` (retain,
pseudonymised), each with a rollback beside it. A test asserts neither has reached the chain
(`artifacts/api-server/src/test/creatorLedgerErasurePolicyShape.test.ts:1#/**`).

**There is no `3513`.** The highest file in the canonical chain is `3510`; `ls src/migrations | grep
'^351'` returns one name. A constraint on this pass named `src/migrations/3513_*` as owned by
another PR; no such file exists at `f71cfb85f`, so nothing was read or edited under that name.

### 1.2 The ledger tables, and what makes them ledgers

`2901` and `2921` are the substance of the correction. Both are append-only **by grant and by
trigger**, both carry amounts as signed integer minor units paired with an explicit currency, and
both make a settlement structurally unrecordable.

| Property | `rent_buddy_earnings_entries` (2901) | `creator_earning_entries` (2921) |
|---|---|---|
| Amount | `artifacts/api-server/src/migrations/2901_rent_buddy_earnings_entries.sql:141#(amount_minor` — `bigint`, `<> 0` | `artifacts/api-server/src/migrations/2921_creator_earning_entries.sql:144#amount_minor` |
| Currency | `artifacts/api-server/src/migrations/2901_rent_buddy_earnings_entries.sql:142#currency` — `char(3)` | `artifacts/api-server/src/migrations/2921_creator_earning_entries.sql:145#currency` |
| Settlement impossible | `artifacts/api-server/src/migrations/2901_rent_buddy_earnings_entries.sql:146#(cash_settled_minor` | `artifacts/api-server/src/migrations/2921_creator_earning_entries.sql:150#(cash_settled_minor` |
| Idempotency | `artifacts/api-server/src/migrations/2901_rent_buddy_earnings_entries.sql:184#rbee_idempotency_key_once` | `artifacts/api-server/src/migrations/2921_creator_earning_entries.sql:197#cee_idempotency_key_once` |
| No UPDATE | trigger `artifacts/api-server/src/migrations/2901_rent_buddy_earnings_entries.sql:202#rbee_no_update` | trigger `artifacts/api-server/src/migrations/2921_creator_earning_entries.sql:250#public.creator_earning_entries;` |
| Deny-default | `artifacts/api-server/src/migrations/2901_rent_buddy_earnings_entries.sql:208#public.rent_buddy_earnings_entries` then `:213#public.rent_buddy_earnings_entries` | `artifacts/api-server/src/migrations/2921_creator_earning_entries.sql:258#account-erasure` |

`creator_attributions` carries the same boundary on the attribution side:
`artifacts/api-server/src/migrations/2920_creator_attributions.sql:296#ca_no_settlement` and its
currency column at `artifacts/api-server/src/migrations/2920_creator_attributions.sql:236#currency`.

`3387` adds what a ledger needs beyond append-only: a **deferred** constraint trigger asserting
every `(transaction_key, currency)` sums to zero at COMMIT
(`artifacts/api-server/src/migrations/3387_creator_ledger_integrity_and_audit.sql:391#public.creator_earning_transaction_balances()`),
an audit table
(`artifacts/api-server/src/migrations/3387_creator_ledger_integrity_and_audit.sql:422#public.creator_ledger_audit_events`),
and a one-transaction door
(`artifacts/api-server/src/migrations/3387_creator_ledger_integrity_and_audit.sql:478#public.creator_ledger_append(p`)
that writes entries, attribution and audit row together.

**One asymmetry worth naming, because it is not what the invariant table implies.** 2901's zero-sum
rule is enforced **in code only**, not by a constraint — the migration says so itself
(`artifacts/api-server/src/migrations/2901_rent_buddy_earnings_entries.sql:52#zero-sum`). Append-only is
structural; balance is a convention on that table. 2921's *is* structural, via 3387. A future writer
that bypasses the builder could insert a single-sided Rent-A-Buddy entry and the schema would accept
it.

### 1.3 Code modules

**Pre-money by construction, and typed that way.** `cashSettledMinor: 0` is a *literal type*, not a
default (`artifacts/api-server/src/lib/creatorLedgerEntries.ts:491#cashSettledMinor:`), and the
builder refuses a non-zero settlement before reading anything else
(`artifacts/api-server/src/lib/creatorLedgerEntries.ts:603#buildCreatorEarningEntries(`,
`artifacts/api-server/src/lib/creatorLedgerEntries.ts:609#input.settledMinor`). The derived status
vocabulary admits three of `09` §3's eight states and can never produce `payable` or `paid`
(`artifacts/api-server/src/lib/creatorLedgerStatus.ts:219#EarningStatus`), with
`available` likewise a literal `0`
(`artifacts/api-server/src/lib/creatorLedgerStatus.ts:290#available:`) carried with a stated reason
(`artifacts/api-server/src/lib/creatorLedgerStatus.ts:301#AVAILABLE_REASON`).

| Module | Role | Reachable? |
|---|---|---|
| `lib/paymentsMode.ts` | the sandbox-only provider-key guard (§1.4) | **reachable** |
| `lib/paymentsStartupLog.ts` | one startup line, booleans only | reachable |
| `lib/creatorLedgerEntries.ts` | pure entry model, folds, refusals | reachable |
| `lib/creatorLedgerPlans.ts` | pure payload builder for the door | reachable |
| `lib/creatorLedgerStatus.ts` | pure status/balance derivation | reachable |
| `lib/creatorLedgerRows.ts` | the one model→row mapping | reachable |
| `lib/creatorShareCanonical.ts` | pure fold over the canonical relation | reachable |
| `lib/creatorRuleEvaluation.ts` | refuses `{}` rule params rather than defaulting (`artifacts/api-server/src/lib/creatorRuleEvaluation.ts:68#p))`) | reachable |
| `lib/creatorAttributionScheduler.ts` | hourly tick, started at `artifacts/api-server/src/index.ts:293#startPlaceCooccurrenceRebuildScheduler();` | reachable, **inert**: one flag read per tick |
| `lib/rentBuddyEarningsLedger.ts` | writes the legacy estimate summary row | reachable |
| `lib/rentBuddyFeeSchedule.ts` | the single fee resolver (`artifacts/api-server/src/lib/rentBuddyFeeSchedule.ts:46#FEE_SCHEDULE_TABLE`, `:104#resolveFeeSchedule(`) | reachable |
| `lib/rentBuddyKycGate.ts` | hard-blocks booking creation (§1.4) | **reachable and closed** |
| `services/creators/CreatorAttributionService.ts` | the only writer of all three tables | reachable |
| `services/creators/CreatorAttributionProducers.ts` | the one production attribution producer | reachable, flag-gated |
| `services/creators/CreatorLedgerOperations.ts` | hold / release / recompute / reverse | reachable (admin) |
| `services/creators/CreatorLedgerReader.ts` | the creator's own-ledger read | reachable |
| `services/creators/PayoutProvider.ts` | §9's six-operation interface (§1.5) | **inert** — only tests import it |
| `services/ledger/CanonicalShareReader.ts` | paging reader, refuses partial folds | **inert** — no route calls it |
| `services/ledger/RewardReversal.ts` | compensating entries on the non-cash ledger | reachable |
| `services/identityVerification/*` | 8 modules: Stripe Identity, Persona, mock, readiness, webhook signature, erasure | reachable, **gated closed** (§1.4) |
| `lib/rewardEarnings.ts` | non-cash qiu→credits, `cashAmount: 0` literal | reachable |
| `lib/fx.ts` + `lib/fxRefreshScheduler.ts` | ECB reference rates, never a settlement rate | reachable |

### 1.4 Routes and gates

**Mounted.** Both creator routers are registered:
`artifacts/api-server/src/routes/index.ts:247#router.use(rentABuddyMarketplaceRouter);`.

| Route group | Endpoints | Authorization / gate |
|---|---|---|
| `routes/creatorEconomy.ts` | 3 creator-own reads, e.g. `artifacts/api-server/src/routes/creatorEconomy.ts:64#asyncHandler(async` | `requireUser` + the flag; payout eligibility **deliberately not served** |
| `routes/adminCreatorLedger.ts` | 5: audit read, hold, release, recompute, `artifacts/api-server/src/routes/adminCreatorLedger.ts:104#asyncHandler(async` | `artifacts/api-server/src/routes/adminCreatorLedger.ts:88#requireAdmin(req,` + the flag re-checked in every service function |
| `routes/rentABuddy.ts` pay | `pay-deposit` / `pay-full`, both **503**, no side effects (`artifacts/api-server/src/routes/rentABuddy.ts:2298#async`) | none needed — constant responses |
| `routes/rentABuddy.ts` refund | `refund-eligibility`, **501** (`artifacts/api-server/src/routes/rentABuddy.ts:4082#async`) | none |
| `routes/rentABuddySpec.ts` payouts | hold (`artifacts/api-server/src/routes/rentABuddySpec.ts:2446#asyncHandler(async`), release (`:2495#asyncHandler(async`) | `requireAdmin`; now **compare-and-swap** (§3) |
| `routes/verification.ts` | session create, status, webhook | rate-limited, signature-enforced, key-mode-gated |

**Three independent locks hold the creator ledger closed**, all currently shut:

1. **The flag.** `creator_attribution_enabled` is seeded FALSE
   (`artifacts/api-server/src/migrations/2922_creator_attribution_flag.sql:60#false,`) with a
   postcondition that refuses to ship it on
   (`artifacts/api-server/src/migrations/2922_creator_attribution_flag.sql:77#creator_attribution_enabled`).
   No migration anywhere sets it TRUE. Reads fail closed.
2. **`requireAdmin`**, with `owner` not accepted, on every write path.
3. **Empty rule params.** 2920 seeds all six lineages with `params = '{}'`
   (`artifacts/api-server/src/migrations/2920_creator_attributions.sql:354#public.creator_rule_versions`)
   and the evaluator refuses `{}` rather than defaulting. **No migration seeds any percentage** —
   `creator_share_ppm` / `platform_fee_ppm` have zero hits across `src/migrations/`.

So on every database this tree can reach, **zero earning entries can be booked by anyone**, even
with the flag on and an admin authenticated.

**Identity verification is built and gated closed.** Stripe Identity and Persona are *real*
integrations that call the vendors' APIs — not stubs. What keeps them non-operational is a
one-element allowlist:
`artifacts/api-server/src/services/identityVerification/readiness.ts:67#IMPLEMENTED_PROVIDERS`
contains only `"mock"`. That closes the booking gate:
`artifacts/api-server/src/lib/rentBuddyKycGate.ts:51#identityProviderStatus();` reads it,
`:62#KYC_OVERRIDE_FLAG);` reads the FALSE override flag, and the gate answers **503**
(`artifacts/api-server/src/lib/rentBuddyKycGate.ts:70#httpStatus:`) on all five booking-creation
paths. It fails closed on a database error.

### 1.5 The provider-mode guard, and the payout boundary

`lib/paymentsMode.ts` is a built, tested control with no analogue in §§3–10: it classifies a provider
key by documented prefix (`artifacts/api-server/src/lib/paymentsMode.ts:59#Record<KeyedProvider,`,
`:69#classifyProviderKey(provider:`), allows `live` only on the exact string `"true"`
(`artifacts/api-server/src/lib/paymentsMode.ts:101#NodeJS.ProcessEnv`), refuses an unrecognised
prefix outright, throws before any `fetch`
(`artifacts/api-server/src/lib/paymentsMode.ts:161#assertProviderKeyAllowed(`), refuses a
signature-verified webhook claiming `livemode`
(`artifacts/api-server/src/lib/paymentsMode.ts:176#assertWebhookLivemodeAllowed(`), and refuses the
unsigned mock (and the fake payment and tax providers) outside the test runner, a dev host included (N-2, 2026-10-06)
(`artifacts/api-server/src/lib/paymentsMode.ts:247#mockIdentityPermitted(env:`).

`services/creators/PayoutProvider.ts` is `09` §9's interface verbatim — six operations
(`artifacts/api-server/src/services/creators/PayoutProvider.ts:63#PayoutProvider`) — whose only
implementation answers `payouts_disabled` from constants and is frozen
(`artifacts/api-server/src/services/creators/PayoutProvider.ts:88#NONE_PAYOUT_PROVIDER:`). Any
configured name other than `none` is **refused, not looked up**
(`artifacts/api-server/src/services/creators/PayoutProvider.ts:109#resolvePayoutProvider(configured?:`).
It imports nothing, and no ledger module imports it.

### 1.6 Flags and switches

| Switch | Kind | State | Where |
|---|---|---|---|
| `creator_attribution_enabled` | DB flag | **FALSE** | `2922:60` |
| `rent_buddy_enabled` | DB flag | **FALSE** | `artifacts/api-server/src/migrations/2210_rent_buddy_default_off.sql:30#rent_buddy_enabled` |
| `rent_buddy_allow_bookings_without_kyc` | DB flag | **FALSE** | `2074`, `2085` |
| `budget_fx_conversion_enabled` | DB flag | **FALSE** | `0183` |
| `PAYMENTS_ALLOW_LIVE` | env | unset ⇒ live refused | `artifacts/api-server/src/lib/paymentsMode.ts:101#NodeJS.ProcessEnv` |
| `IDENTITY_PROVIDER` | env | defaults `mock` | `artifacts/api-server/src/lib/paymentsMode.ts:186#configuredIdentityProvider(env:` |
| `CREATOR_PAYOUT_PROVIDER` | env | any value but `none` refused | `artifacts/api-server/src/services/creators/PayoutProvider.ts:109#resolvePayoutProvider(configured?:` |

**Payments are in no mode at all**, and that is the accurate phrasing: there is no
`payments_enabled` flag and no `payments_mode` setting. `PAYMENTS_ALLOW_LIVE` governs only
*identity* provider keys today.

### 1.7 Tests

Nineteen files, **all registered in the main runner** (`artifacts/api-server/package.json:93#SUPABASE_URL=http://127.0.0.1:9`)
— so they run in CI's unstarvable static tier, not only on a developer's machine.

The two that bear directly on §11: `test/paymentsLiveGuard.test.ts` (694 lines, A–H) drives the real
modules with only `fetch` stubbed and pins that a live or unrecognised key makes **zero** fetch calls
on all six provider paths. `test/creatorPayoutProviderBoundary.test.ts` (198 lines, PV1–PV5) patches
`fetch`, `http`, `https`, `net`, `tls` and `dns` to record and throw, then asserts all six operations
refuse without touching any of them, that four real processor names are refused
(`artifacts/api-server/src/test/creatorPayoutProviderBoundary.test.ts:96#(const`), and — statically
— that no ledger file imports a payment client or calls `fetch`
(`artifacts/api-server/src/test/creatorPayoutProviderBoundary.test.ts:114#assert.ok(!/\bfetch\s*\(|from\s+`).

**Note on what PV2 actually asserts**, because the framing inverts easily: it asserts *"no provider
is chosen"*, not *"no provider module exists"*. The module exists and is the thing under test.

---

## 2. The ten approved decisions, graded

Graded against §1's inventory. **BUILT** = the decision's substance is implemented and reachable on
some deployment. **PARTIAL** = the seam, interface or constraint exists but the decision's own
content does not. **ABSENT** = nothing implements it.

### D1 Processor — "Stripe Connect in test mode as the first integration, behind a payment-provider interface" → **PARTIAL**

The *interface* half is BUILT and is §9's six operations verbatim
(`artifacts/api-server/src/services/creators/PayoutProvider.ts:63#PayoutProvider`); a sandbox-only
key guard with test/live prefix classification exists and is enforced before any request
(`artifacts/api-server/src/lib/paymentsMode.ts:161#assertProviderKeyAllowed(`). The *Stripe Connect*
half is ABSENT and verified so in §3.1. Note the interface is the **payout** boundary only — there
is no charge/checkout provider interface anywhere, so the seam the decision describes covers
disbursement and not collection.

### D2 Merchant / losses — "the service provider is the seller for their service… direct-charge model" → **ABSENT**

No seller-of-record concept exists. There is no merchant, sub-merchant, connected-account or
seller-of-record column on any table; zero hits for `on_behalf_of`, `transfer_data`,
`destination_charge`, `application_fee`. The ledger's account vocabulary names
`buddy_payable` / `platform_revenue` / `traveler_receivable` / `cash_external` — a platform-as-
intermediary shape, which is the model this decision moves away from. **Nothing contradicts the
decision; nothing implements it.**

### D3 Fees — "10 % platform commission on the pre-tax service price, shown before checkout; no commission on tips; no deposit in the first release; configurable by product and market" → **PARTIAL**

- **Commission exists, configurably, but not at 10 %.** The schedule of record is a per-level table
  read through one resolver (`artifacts/api-server/src/lib/rentBuddyFeeSchedule.ts:46#FEE_SCHEDULE_TABLE`),
  seeded 25 / 22 / 15 / 12 / 12 % by buddy level
  (`artifacts/api-server/migrations/0134_rent_buddy_schema_rebuild.sql:1208#traveler_service_fee_pct)`).
  **`10` / `0.10` as a fee percentage has zero hits in the tree.** The column is `integer`, so a
  fractional rate is not expressible. Configurability is by **buddy level**, not by product or
  market.
- **No commission on tips is BUILT, and structurally.** The commission base is the booking total
  only, and the tip transaction credits the buddy in full with no `platform_revenue` leg — two
  independent confirmations, one in the fee input and one in the entry legs.
- **"Shown before checkout" — unknown.** Not established: this pass did not trace the mobile
  checkout surface, and the 503 on `pay-deposit` means no checkout executes.
- **No deposit — CONTRADICTED in code.** A booking in `deposit_plus_cash` mode still computes a
  30 % deposit from a hard-coded literal (`artifacts/api-server/src/routes/rentABuddy.ts:2166#Number(buddyProfile.hourly_rate_usd)`
  and the three lines below it), ignoring the `deposit_percent` columns that exist. Unreachable
  today because `rent_buddy_enabled` is FALSE, but the first release would ship it.

### D4 Payouts — "monthly, after earnings are finalized, services are completed, and verification is complete; carry small balances forward to a locally appropriate minimum" → **ABSENT**

Every element verified absent in §3.4: no scheduler, no `finalized_at`, no monthly run, no minimum,
no carry-forward. The *refusal* is well-built — `available` is a literal `0` with a stated reason
— but a refusal is not the decision. The one piece pointing the right way is that
`09` §9's payout **states** are now partly honoured on the legacy table: hold and release are
compare-and-swap (§3).

### D5 Refunds — "full refund when the provider cancels, the service is unavailable, or a safety issue is upheld… don't promise fees or deposits are non-refundable" → **ABSENT**

`refund-eligibility` is 501 (`artifacts/api-server/src/routes/rentABuddy.ts:4082#async`) and there
is **no refund-execution route at all**. What exists is ledger **reversal** — a different thing,
correctly distinguished: `POST /admin/creator-ledger/transactions/reverse` appends negating entries
and never edits or deletes. Two residual hazards, both pre-existing: seeded support-template text
in the legacy tree *promises* "a full refund has been initiated", with nothing executing it; and an
abuse detector reads a `refunded` booking status that the enum cannot produce, so detector 8 of 8
has never fired.

### D6 Currencies — "customer's local currency when the processor supports it; store the original transaction currency and amount, plus any conversion details" → **PARTIAL**

- **Currency + amount pairing is BUILT** on all three new tables (§1.2) — `amount_minor bigint` +
  `currency char(3)`, CHECK-shaped, exactly §3's first refusal.
- **The four live money tables have no currency column at all** and encode USD in column names
  (`total_usd`, `amount_usd`, …). The new tables sit *beside* them, not over them.
- **Conversion details are ABSENT.** `exchange_rate` has zero hits; no table stores an original
  amount plus a rate plus a converted amount. `fx_rates` is ECB *reference* data behind a FALSE
  flag, and the canonical view **refuses** to convert between units because no rate between them
  has been decided. That refusal is correct under §8's "never fabricate", but it is not the
  decision's "store the conversion".

### D7 Tax — "calculate, collect, report, remit where legally required; a tax-provider interface; configure each launch country before enabling checkout" → **ABSENT**

Verified in §3.3. No provider, no interface, no rate table, no per-country configuration, no
withholding. `tax_withheld` exists only as a reserved doc concept and is **not** in the ledger's
account CHECK. The single tax-adjacent artifact is a hardcoded disclaimer shown to buddies
(`artifacts/api-server/src/routes/rentABuddy.ts:7575#documents`) — which is honest, and is the whole
of it.

### D8 Identity — "no unverified bookings; identity and payment-provider verification before offering or booking; Sumsub behind a provider interface, with per-country availability checks" → **PARTIAL**

- **"No unverified bookings" is BUILT and is the strongest-held decision in this set.** The gate
  fails closed, blocks all five creation paths with 503, and is tied to live readiness rather than
  to editable config (§1.4).
- **The provider interface is BUILT**, with three providers registered and two of them real
  integrations.
- **Sumsub is ABSENT — zero hits, verified four ways** (§3.2). The chosen vendors in the tree are
  Stripe Identity and Persona.
- **Payment-provider verification is ABSENT** — there is no payment provider to verify against.
- **Per-country availability checks are ABSENT.** `documentCountry` is recorded as an *output* and
  consulted by nothing; there is no allowlist, no country parameter on the verification request, and
  Stripe's own `country_not_supported` is flattened to a generic failure — so a user in an
  unsupported country gets an undifferentiated error.

### D9 Creator-ledger erasure — "pseudonymize accounting entries… keep only what tax, accounting, disputes or legal need, with a defined retention period and access controls" → **PARTIAL**

- **Access controls are BUILT**: deny-default RLS, `REVOKE ALL` from every role including
  `service_role`, then a narrow re-grant; no UPDATE to anyone; the audit table and the door carry no
  client grant; the door is **not** `SECURITY DEFINER`.
- **Pseudonymisation is WRITTEN BUT HELD.** `reconciliation-staging/3512_...` implements exactly this
  decision — one fresh pseudonym substituted everywhere including inside jsonb keys, aborting if the
  id survives — and is deliberately kept out of the chain. Its own header states it is
  *pseudonymised, not anonymous*: `booking_id` / `subject_id` still re-identify through
  `rent_buddy_profiles.user_id`. That caveat is load-bearing against the decision's word
  "pseudonymize", and it is honest rather than hidden.
- **What is in the chain decides nothing, on purpose.** `3510` makes every ledger DELETE fail with
  `CL451` on all four tables
  (`artifacts/api-server/src/migrations/3510_creator_ledger_erasure_policy_undecided.sql:130#public.creator_ledger_erasure_policy_undecided()`,
  `:149#public.rent_buddy_earnings_entries;`), row-level so a user with no ledger rows stays
  deletable. It exists because the schema had already answered the question twice,
  inconsistently — 2901 via `SET NULL` (which the append-only trigger refuses, failing with the
  wrong cause) and 2920/3387 via `CASCADE` (which silently deleted the whole creator ledger).
- **Retention period: ABSENT.** No statutory period is stated anywhere for these tables.
- **A blind spot this pass found — since CLOSED, and the hole behind it measured.** As graded here,
  none of the five new ledger/attribution/audit tables appeared in `lib/deletionDispositions.ts` at
  all — not in `RETAINED_WITH_REASON`, not even in `UNCLASSIFIED_BACKLOG`, which that file is
  explicit is *"NOT a decision"* — while the three legacy money tables *are* in that backlog
  (`artifacts/api-server/src/lib/deletionDispositions.ts:596#rent_buddy_earnings_ledger`,
  `:551#rent_buddy_payouts`, `:559#rent_buddy_tips`). All five are now classified: the four ledgers
  in a new `AWAITING_OWNER_DECISION` bucket that records C-11 without answering it, and
  `creator_rule_versions` in `RETAINED_WITH_REASON` (it carries no beneficiary and no actor, so it
  is not a C-11 subject). The CAUSE is not fixed and is bigger than these five: the coverage guard
  reads the 2026-08-19 baseline plus a hand-typed `POST_BASELINE_TABLES` list and never reads
  `src/migrations/`, so registration is a thing a person must remember and forgetting cannot be
  reported. A baseline **recapture cannot close it either**, because recapture snapshots PRODUCTION
  and these migrations are not applied. Measured against `scripts/lib/canonicalSchema.ts`, which
  already replays the whole chain: 529 tables, 142 post-baseline, **114 of them named in no bucket**.

### D10 Launch flags — "keep payments in test mode until payment, identity and tax readiness are established" → **PARTIAL**

Satisfied in effect and by a stronger mechanism than a flag, but **not as stated**. There is no
payments mode to be in: no `payments_enabled` flag, no test/live mode switch for payments. What
holds is four FALSE flags, a one-element readiness allowlist, an unset `PAYMENTS_ALLOW_LIVE`, a
provider resolver that refuses every real name, and CHECK constraints that make settlement
unrecordable. The decision's *intent* is over-satisfied; its *instrument* does not exist, so there
is nothing to flip to "test" when readiness arrives — and nothing that would stop two readiness
legs being skipped, since no single switch reads all three.

**Tally: 0 BUILT · 6 PARTIAL (D1, D3, D6, D8, D9, D10) · 4 ABSENT (D2, D4, D5, D7).**

---

## 3. Verified absences — searched, not asserted

The last such claim went stale, so each absence below is a search result with the method stated.
Searches used `rg` excluding `node_modules` and `.git`, across the whole worktree.

### 3.1 No payment processor

All **16** `package.json` files return zero hits for `stripe`, `@stripe/*`, `stripe-node`. Zero hits
worktree-wide for `SetupIntent`, `stripe.accounts`, `acct_`, `transfer_data`, `application_fee`,
`destination_charge`, `on_behalf_of`, `charges.create`, `checkout.session`, `STRIPE_API_KEY`,
`STRIPE_PUBLISHABLE`. `PaymentIntent`, `Stripe Connect`, `STRIPE_SECRET`, `STRIPE_CONNECT` and
`STRIPE_WEBHOOK` appear **only in documentation**. `braintree`, `razorpay`, `checkout.com`, `mollie`,
`payoneer`, `dwolla`, `lemonsqueezy`, `plaid`: zero. `adyen` / `paypal` / `wise` as processor names
appear only as negative assertions in two tests and in scam-text scanners. `square`, `paddle`,
`vertex`, `wise` otherwise match geometry, icons, a paddle boat and "byte-wise".

**`artifacts/api-server/src/services/payments/` does not exist** — `artifacts/api-server/src/lib/paymentsMode.ts:42#(services/payments/*,` names it
as the future home.

Every `stripe` code hit in the tree is **Stripe *Identity***, a KYC product, confined to
`services/identityVerification/`, plus the key-mode guard and one column-name regex.

### 3.2 No Sumsub

**Zero hits, verified four ways:** `grep -rniI "sumsub"` over 8,350 text files; `grep -rniIE
"sum[-_ ]?sub"` for spelling variants; `git grep -in "sumsub" HEAD` over all tracked files;
`find -iname "*sumsub*"`. No reference in any file, migration, doc, test or filename.

### 3.3 No tax provider

Zero hits worktree-wide for `avalara`, `taxjar`, `stripe tax`, `sovos`, `quaderno`, `taxProvider`,
`TaxProvider`, `tax_provider`, `calculateTax`, `taxRate`, `sales_tax`, `tax_document`,
`taxDocument`, and `vat` / `gst` / `1099` at word boundaries. `withholding` matches only
privacy-language. The only tax artifact is the disclaimer string at `artifacts/api-server/src/routes/rentABuddy.ts:7575#documents`.

### 3.4 No payout scheduler — proved by enumeration

There is no cron and no scheduler registry. `pg_cron` is **not installed** — the only two mentions
say so. The mechanism is that a `start…()` exported from `src/lib` is called from `src/index.ts`,
and nothing else can start a worker; a test pins this
(`artifacts/api-server/src/test/schedulerRegistration.test.ts:38#WORKER_SUFFIXES`). Enumerating all
**57** registered workers in `src/index.ts`, **none** concerns payouts, earnings finalization,
monthly runs or balance carry-forward. The three money-adjacent ones are: `startFxRefreshLoop`
(reference rates), `startCreatorAttributionScheduler` (attribution only, flag-gated FALSE), and
`startIntelRewardScheduler` (non-cash credits, `cash_amount = 0` CHECK-enforced).

Also absent: `minimum_payout`, `minimumPayout`, `payout_threshold`, `payout_schedule`,
`payoutSchedule` (zero hits); `finalized_at` (zero hits in `src/`, `migrations/`, `baseline/`);
`carry_forward` matches only chat-message carry-forward. `monthly` in a money context is a read-only
dashboard aggregation, not a payout run.

### 3.5 No refund path

Covered in D5. One 501 route, no execution route, zero refund calls to anything.

### 3.6 Nothing inserts a payout row — still true

No `INSERT INTO rent_buddy_payouts`, no `.insert(` on the table, no SQL function writing it,
anywhere in `src/` or `baseline/`. The route layer says so in its own words. The three runtime
references are one SELECT (to choose 404 vs 409) and the two UPDATEs. There is also **no read
route**: a buddy cannot list their payouts, despite a SELECT policy existing for them.

### 3.7 `payment_status` — still no reader and no writer

Zero hits in `routes/`, `services/`, `migrations/`, `scripts/`. Every hit is generated types, a
capability snapshot, or a column-name regex. The column is NOT NULL, defaults `not_required`, and
every booking sits at that default forever.

### 3.8 Three §11 claims that have gone stale in the *safe* direction

Recorded because §11's body is left unedited and a reader would otherwise inherit them. These are
about §1 and §11's framing, not new defects:

1. **Payout hold/release are no longer unguarded transitions.** Both are now compare-and-swap with
   the predicate in the same statement as the write
   (`artifacts/api-server/src/routes/rentABuddySpec.ts:2403#PAYOUT_NOT_HOLDABLE_FROM`), answering
   404/409 on zero rows and writing the audit row only when a transition happened. The predicates
   are a denylist rather than an allowlist because `status` is still free text.
2. **The tip path is no longer three non-transactional writes with an overwriting upsert.** It is
   one RPC in one transaction that accumulates, with the payee derived database-side. The fallback
   path also accumulates and self-reports `atomic: false`; two sharp edges remain there (two
   projection updates whose errors are not inspected, and a lost-update window under concurrency).
3. **The three disagreeing fee constants are gone.** One resolver reads the schedule and returns
   `resolved` / `no_such_level` / `read_failed` with **no numeric fallback arm**; callers refuse
   rather than guess. 22 / 0.22 / 0.15 / 15 survive only as prose explaining the removal. (§1.3.3 of
   `09` already records this as closed; it is restated because §11 does not.)

Also stale, and in the *unsafe* direction for a reader: `artifacts/api-server/src/lib/rentBuddyKycGate.ts:6#stubs` still calls the
two real adapters "stubs", and `artifacts/api-server/src/app.ts:127#future` still calls webhook signature verification "future" —
both are present and enforced today.

---

## 4. Can payments be censused?

**Yes — and 15 requirements already are.** This is the part of the 2026-10-03 conclusion that is
wrong on its own terms, not merely out of date.

### 4.1 The requirements are already enumerated, inside another census

`census-discovery.md` carries a monetization lane whose rows are payment and creator-economy
requirements in exactly the standard form — an id, a criterion quoted from a spec section, a
verdict, and cited evidence: **DV-56…DV-69** (fourteen rows) plus **DV-81**, graded against `07` §10,
`08` §7 and `09` §9/§11. Two more rows carry payment clauses inside a broader criterion (DV-74's
ledger-audit and creator-fraud-hold actions; DV-82's `attribution_double_count` stop condition).

Those verdicts have **moved**, which is the direct evidence that the surface is measurable: all
fifteen read `N` at the §11 table, and eight were taken `N → W` by the §51/§52 passes. So payments
are not outside every denominator — they are inside Discovery's, at 15 rows, and the lane that put
them there is the same lane that built §1's inventory.

### 4.2 What a dedicated census would contain, and how big it would be

Enumerable in the same form, from three sources:

| Source | Gradeable criteria | Basis |
|---|---|---|
| The ten approved owner decisions | **41** | Sub-clauses, counted as §2 grades them: D1 4 · D2 2 · D3 5 · D4 5 · D5 4 · D6 3 · D7 6 · D8 5 · D9 4 · D10 3 |
| `09_Payment_Architecture.md` §§3–10 | **~60** | §3's 3 refusals · §4's 4 · §5.2's 9 account types · §5.3's 7 invariants I1–I7 · §5.4's envelope · §6's 4 attribution fields + 3 constraints · §7's 3 rules + webhook ordering + atomicity · §8's 5 · §9.1's 9 states + CAS + 4 failure states + the KYC gate · §9.2's 3 + cash exclusion · §10's 5 + audit + retention |
| `07_Creator_Economy.md` and `08_Portava_Revenue_Model.md` design sections | **~45** | Reward ladder, anti-gaming, standing, take-rate ladder, booking economics, subscriptions, non-goals |

**≈ 146 criteria, of which ≈ 131 would be new** and 15 would be moved or cross-referenced from
census-discovery. That places it between `census-sensing` (127) and `census-passport` (169) — an
ordinary size for this corpus, not an outlier. Verdict distribution would be unusual and worth
predicting honestly: a high BUILT-BUT-WRONG share, because most of what exists implements §§4–10's
*shapes* while being gated off, unapplied, or constrained to be unable to do the thing.

**This pass did not create a census, and the number above is an estimate of a denominator, not a
measurement of one.**

### 4.3 One obstacle a census author must know first

The thirteen existing censuses grade against an **owner-supplied spec**, hash-verified in
`docs/specs/upgrades-v2/SOURCE-MANIFEST.json`. Entries 12, 13 and 14 of that manifest are
`07_Creator_Economy.md`, `08_Portava_Revenue_Model.md` and `09_Payment_Architecture.md` — so an owner
spec for payments does exist and is recorded.

**Its bytes are not in the repository.** The manifest's `sources/` directory was never committed
(`git log --all --diff-filter=A -- 'docs/specs/upgrades-v2/sources/**'` returns nothing), and the
`docs/architecture/` files of the same three names are **not** the manifest's bytes — their SHA-256s
differ from the recorded ones, including at the first commit that introduced them. Those files are
repo-*derived* state documents written over the owner spec's filenames, as `09`'s own subtitle says
(*"Derived from the repository, 2026-09-07"*).

So a payments census graded against `docs/architecture/09` would be grading against a document the
tree wrote about itself — the circularity the other thirteen avoid. **The denominator source should
be the ten approved owner decisions, which are first-party and verbatim, with the derived documents
used only for the design clauses they contribute.** That is a methodological difference from the
thirteen, and it should be declared in the census's header rather than discovered later.

---

## 5. Unknown

House style, and load-bearing — each of these is a thing this pass could not establish, not a thing
it judged.

- **Whether `2900`, `2330` and `2332` are applied to production.** The committed table snapshot
  proves table *existence*, not function, trigger or grant existence, and these three add no table.
  `2330`'s `rb_accumulate_booking_tip` is called through a path written to tolerate the RPC being
  absent, which is consistent with either state.
- **Whether `2901`, `2920`, `2921`, `2930`, `3385`, `3386`, `3387` and `3510` are applied to any
  non-production database.** Their tables are absent from the 2026-09-22 production snapshot. The
  census records a local PostgreSQL 16 harness; this pass did not query `portava-ci`.
- **The exact 2026-10-03 measurement being corrected.** No document at `f71cfb85f` contains the
  69.2 % figure or the "payments sit outside the denominator" conclusion. The occurrences of "69.2"
  in `docs/architecture/` are **section numbers**, not percentages. The conclusion is reported here
  as it was handed over; its artifact is not in the tree and so is not cited.
- **Whether fees are shown before checkout** (D3). The mobile checkout surface was not traced.
- **Whether `rent_buddy_fee_rules` actually holds the five seeded rows in production.** The seed
  lives only in the frozen legacy tree, and a row count would require reading production.
- **What `'standard'` buddy level does in practice.** It is settable by an admin route and has no fee
  row, so every fee-dependent route would refuse for such a buddy; whether any buddy holds that
  level is unknown.
- **Whether the five new ledger tables' erasure disposition is intentionally deferred or simply
  missed** (D9). `3510` defers the *policy* explicitly; their total absence from
  `deletionDispositions.ts` is a different gap and no document states which it is.

---

## 6. The correction to `09` §11

A dated header is added to `docs/architecture/09_Payment_Architecture.md`, in the form the four
corrected censuses use (`census-layover.md`, `census-map.md`, `census-passport.md`,
`census-sensing.md`). Its body is **not** rewritten: §§1–10 remain as written, and §11's list
remains readable as the state it described on 2026-09-07.

---

## 7. Addendum, 2026-10-05 (lane B) — the criteria's provenance, and the test-mode slice built against them

*Branch `claude/mission-b-payments-identity-trust-20261005`, from `2e46835263`, merged with `800516a2ff`.
Nothing applied, deployed or flipped; no database read or written; no real provider called — there are no
Stripe or Sumsub keys in this lane. Decisions are cited by their ids in `docs/ops/owner-decisions-20261004.md`.*

### 7.1 §4.3 is wrong about where the owner's spec is, and §4.2's "≈146" mostly fails its own test

§4.3 says the manifest's bytes for `07`/`08`/`09` "are not in the repository". They are, at
`docs/specs/discovery-v1/07_Creator_Economy.md`, `08_Portava_Revenue_Model.md` and
`09_Payment_Architecture.md` (installed 2026-09-14, `docs/specs/discovery-v1/00-PROVENANCE.md`). Their
sha256 match `docs/specs/upgrades-v2/SOURCE-MANIFEST.json` exactly (`208c9bac…`, `9b336148…`, `0197464b…`),
as do the declared source files on the owner's machine. The `docs/architecture/` files of the same names
do not (`9e4a7fed…`, `b8136a32…`, `d9551fd9…`). The genuine `09` is about two kilobytes: it has no §5.2
account taxonomy, no invariants I1–I7 and no nine-state §9.1 — those exist only in the derived document.
So of §4.2's ≈146, the ≈60 counted from the derived `09` and the ≈45 from the derived `07`/`08` are the
tree grading itself, and are not used. The `PAY-###` ids on #595/#596/#598/#603 come from a
`tasks/payments.json` that is in no commit; their provenance cannot be checked, and they are
cross-referenced only. The criteria built against are the owner's answers (OD-PAY-1 … OD-PAY-11,
OD-INPUT-4, OD-TRUST-2/3/5, OD-TRIP-1) and the hash-verified `docs/specs/discovery-v1/0{7,8,9}`.

### 7.2 What now exists (all of it behind `PAYMENT_PROVIDER`, default `none`)

| decision | built | where |
|---|---|---|
| OD-PAY-1/2 provider interface, buddy is the seller | direct charge on the buddy's account, commission as a separate platform fee; a market without direct charges is **refused**, never silently made a destination charge | `artifacts/api-server/src/services/payments/bookingPayments/checkout.ts:193#const model = selectChargeModel(deps.provider.capabilities(), market, "refuse");` |
| OD-PAY-3 10 % on the pre-tax price, shown first, none on tips, no deposit | 1000 bps, versioned, by product and market (no market rule decided, none configured); the quote shows the commission as taken FROM the price | `artifacts/api-server/src/services/payments/bookingPayments/commissionPolicy.ts:54#bps: 1000,`, `artifacts/api-server/src/services/payments/bookingPayments/bookingQuote.ts:110#const commission = commissionMinor(input.serviceMinor, rule.bps);` |
| OD-PAY-4 monthly, finalised, completed, verified; carry forward | plan / hold / release / execute; finalised = dispute window closed; a currency with **no configured minimum pays nothing** (the owner named no number) | `artifacts/api-server/src/services/payments/bookingPayments/payouts.ts:165#const carryReason = minimum === undefined` |
| OD-PAY-5 refunds | the owner's table; fees returned in proportion; an uncaptured payment is cancelled, not refunded | `artifacts/api-server/src/services/payments/bookingPayments/refunds.ts:66#case "cancelled_before_service": {` |
| OD-PAY-6 original currency and conversion | stored as charged and as the provider reports settlement; **local-currency pricing is NOT built** — prices are stored only as `total_usd` | `artifacts/api-server/src/migrations/3931_rent_buddy_payments.sql:141#amount_minor                 bigint      NOT NULL CHECK (amount_minor > 0),` |
| OD-PAY-7 tax configured per market before checkout | checkout refuses where the registered tax provider has not configured the market | `artifacts/api-server/src/services/payments/bookingPayments/bookingQuote.ts:100#return r.reason === "tax_not_configured"` |
| OD-PAY-11 test mode until readiness | `livemode` CHECK false on every provider-mirroring table; readiness gate; live events refused | `artifacts/api-server/src/migrations/3931_rent_buddy_payments.sql:166#CONSTRAINT rbbp_test_mode_only CHECK (livemode = false)` |
| `09` §2/§6/§10 ledger first, reversals, signed webhooks | money is posted to the ledger BEFORE state changes; the event is marked processed LAST | `artifacts/api-server/src/services/payments/bookingPayments/webhookProcessor.ts:171#const failure = await postAll(deps, [...planPaymentPostings(` |

**The production ledger binding is PR #598's `payment_post_transaction`** (wave 2, through
`services/payments/bookingPayments/ledgerAdapter.ts`; `artifacts/api-server/src/routes/rentABuddyPayments.ts:55#ledger: paymentLedgerAdapter(sc),`).
Until 3821-3823 are applied it answers `ledger_unavailable`, so every webhook that must
book money answers 503 and the provider retries, and this tree never acknowledges unbooked money. Every
end-to-end proof is therefore against the deterministic fake provider with an in-memory store and ledger
(`artifacts/api-server/src/test/rentBuddyPaymentSlice.test.ts:1#/**`, 42 cases;
`artifacts/api-server/src/test/rentBuddyPaymentRoutes.test.ts:1#/**`, the real routers and the raw-body
webhook over HTTP).

### 7.3 Statements above that this addendum corrects

- §1.4 and `09`'s lines that say booking creation is open "unless `rent_buddy_allow_bookings_without_kyc`
  is explicitly on": that override is **retired** (OD-PAY-10, no tester bypass) and no longer read
  (`artifacts/api-server/src/lib/rentBuddyKycGate.ts:52#if (status.operational && verificationIsBookingGrade()) return`; 3932 deletes the row, N-1).
- §2 D8 "No unverified bookings is BUILT": it was a deployment-level gate only. Both people are now
  checked on every creation path, and a sandbox-key verification does not count
  (`artifacts/api-server/src/services/identityVerification/currentVerification.ts:154#if (mode === "test")`).
