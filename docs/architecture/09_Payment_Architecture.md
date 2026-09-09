# Payment Architecture

*Derived from the repository, 2026-09-07. Sections 1–2 are **current state** and cite the file
that does the thing; sections 3–9 are **DESIGN** and are labelled as such — nothing in them is
built. Section 10 mixes both — its citations are current state, its posture is design; section 11
is the ledger of what does not exist. Where a claim is about the live database it cites
`artifacts/api-server/baseline/20260819_baseline_structure.sql`, the pg_dump of production, not a
migration file: this repo has three migration trees and a committed migration is not evidence of
an applied one (`docs/migrations.md:3-7`, and `.agents/memory/migration-applied-vs-committed.md`).*

**The headline, stated once so nothing below reads as understatement: Portava moves no money.**
There is no payment processor, no wallet, no balance, no double-entry ledger, and no disbursement
path. What exists is a **priced booking**, an **estimated fee breakdown**, a **non-cash credits
ledger**, and **reference data** (FX rates, price baselines). Everything else in this document is
design.

---

## 1. Current state — what actually exists

### 1.1 Rent-A-Buddy: priced, never charged

Rent-A-Buddy is the only surface in the tree that computes a price a human owes another human.
Price is **server-computed**, never client-supplied: `routes/rentABuddy.ts:1577-1580` derives
`total_usd` from the buddy profile's `hourly_rate_usd × duration_h`, then splits it into
`deposit_usd` / `cash_balance_usd` according to `payment_mode`.

The two routes that would take the money are **honest stubs**. `POST
/rent-a-buddy/bookings/:id/pay-deposit` and `.../pay-full` return **503** with
`payment_stub: true` and no side effects (`routes/rentABuddy.ts:1686-1704`). The comment above
them states the reason exactly: *"Return 503 so no booking is ever marked 'paid' and no false
milestone notification is sent."* `GET /rent-a-buddy/bookings/:id/refund-eligibility` is a **501**
with no body logic at all (`routes/rentABuddy.ts:3198-3203`).

**No payment processor is installed.** No `package.json` in the tree depends on Stripe or any
other processor. The only Stripe reference in `artifacts/api-server/src` is **Stripe *Identity***
— a KYC adapter — and both of its methods throw
(`services/identityVerification/providers.ts:45-59`). Identity verification is not payment, and
neither is operational.

Because identity verification does not work, **booking creation itself is hard-blocked**:
`lib/rentBuddyKycGate.ts:57-80` returns 503 `verification_unavailable` on both insert paths unless
`rent_buddy_allow_bookings_without_kyc` is explicitly on (seeded false,
`migrations/2074_rent_buddy_kyc_gate_flag.sql:36-39`). The master flag `rent_buddy_enabled` is
seeded **false** by owner decision (`migrations/2210_rent_buddy_default_off.sql:29-31`), which
supersedes `0090`'s forced TRUE.

### 1.2 The live money schema

These tables exist in production. Column lists are from the baseline dump.

| Table | Shape | Line |
|---|---|---|
| `rent_buddy_bookings` | `payment_mode`, `total_usd`, `deposit_usd`, `cash_balance_usd`, `addons_total_usd`, `tip_usd`, `payment_status`, mutual cash-confirmation booleans | `baseline:3804-3856` |
| `rent_buddy_earnings_ledger` | per-booking fee breakdown, `is_estimated`, **`UNIQUE (booking_id)`** | `baseline:9018-9040`, `:14263` |
| `rent_buddy_fee_rules` | `platform_fee_percent` + traveller service fee, keyed `UNIQUE (buddy_level)` | `baseline:9062-9069`, `:14288` |
| `rent_buddy_payouts` | `amount_usd`, `status`, hold/release actor + timestamps | `baseline:9295-9309` |
| `rent_buddy_tips` | `amount_usd` per booking | `baseline:9491-9499` |
| `fx_rates` | ECB reference rates, base EUR, `UNIQUE (base_currency, currency, rate_date)` | `src/migrations/0174_reference_data.sql:5-14` |
| `price_baselines` | curated per-day cost bands by (scope, category, tier) | `src/migrations/0171_price_baselines.sql:16-37` |
| `intel_reward_ledger` | append-only **non-cash** credits, `CHECK (cash_amount = 0)` | `src/migrations/2170_intel_reward_ledger.sql:34-44` |
| `canonical_events` | append-only interaction spine, UPDATE/DELETE/TRUNCATE blocked by trigger | `src/migrations/2120_canonical_events.sql:56-84`, `:141-157` |
| `intel_attributions` | append-only attribution ledger with `algorithm_version` | `src/migrations/2277_intel_outcomes_attribution.sql:171-201` |

`rent_buddy_bookings.payment_status` is a seven-value enum — `not_required`, `pending`,
`authorized`, `captured`, `partial`, `refunded`, `failed` (`baseline:635-643`). **Nothing reads it
and nothing writes it.** A repo-wide grep finds it only in the generated types
(`lib/database.types.ts:13610`, `:13662`, `:13714`). Every booking row carries the column default
`not_required` forever. It is a modelled payment state machine with no transitions.

### 1.3 `rent_buddy_earnings_ledger` is not a ledger

It is one **mutable summary row per booking**, enforced by `UNIQUE (booking_id)`
(`baseline:14263-14264`) and written by a single upsert on that conflict target
(`lib/rentBuddyEarningsLedger.ts:73-91`). Its own header says so: *"THIS IS NOT PAYMENT … The row
is an ESTIMATE"* (`lib/rentBuddyEarningsLedger.ts:24-28`). Four consequences follow from the
shape, and each one is a reason section 5 chooses double-entry instead:

1. **It records money as collected that was never collected.** The upsert sets
   `in_app_amount_collected: Number(booking.deposit_usd ?? 0)`
   (`lib/rentBuddyEarningsLedger.ts:87`). For `payment_mode = 'full_in_app'`, `deposit_usd` **is**
   the whole total (`routes/rentABuddy.ts:1579`). So a full-in-app booking books its entire value
   as in-app collected at the moment of booking, while `pay-full` returns 503 and no money exists.
2. **It never settles.** `is_estimated: true` and `cash_balance_confirmed: false` are written at
   creation (`lib/rentBuddyEarningsLedger.ts:89-90`) and no writer ever changes them —
   `createEarningsLedgerEntry` is the only writer in the tree; every other reference is a SELECT
   (`routes/rentABuddyMarketplace.ts:1905`, `:2156`, `:2279`). The `is_estimated` flag the read
   path branches on (`routes/rentABuddyMarketplace.ts:2266`) can therefore never be false.
3. **Three call sites compute net earnings three different ways, from two different fee
   constants.** `lib/rentBuddyEarningsLedger.ts:37,66` reads `rent_buddy_fee_rules` with a default
   of **22 %**; `routes/rentABuddyMarketplace.ts:2191-2195` takes `ledger[0].platform_fee_percent`
   — an arbitrary row's rate — and applies it to *every* completed booking, defaulting to 22 %;
   `routes/rentABuddy.ts:6237` hard-codes **0.15**. The last of these is exactly the defect
   `docs/rent-buddy-audit.md:401-405` filed against "Task #1701 / #1703"; it is still open.
4. **Aggregates are computed in the API process over an unbounded select.**
   `routes/rentABuddy.ts:6229-6268` and `routes/rentABuddyMarketplace.ts:2149-2196` pull booking
   rows and sum them in JavaScript with no pagination — PostgREST's default row cap silently
   truncates the sum for any buddy past it. That is the read-side twin of the counter problem in
   `.agents/memory/counter-update-atomicity.md`.

The tip path shows the same shape at write time: `routes/rentABuddyMarketplace.ts:1891-1912`
performs **three unrelated writes** — an upsert into `rent_buddy_tips` keyed on `booking_id`, an
UPDATE of the ledger's `tip_usd`, and an UPDATE of the booking's `tip_usd` — with no transaction
and with the last two explicitly best-effort. The upsert also **replaces** rather than accumulates,
so a second tip overwrites the first.

### 1.4 `rent_buddy_payouts`: a lifecycle nothing can enter

Two admin routes move a payout: hold (`routes/rentABuddySpec.ts:2159-2192`) and release
(`:2197-2229`). **Nothing in the repository ever inserts a `rent_buddy_payouts` row** — a
repo-wide grep for the table finds only those two UPDATEs plus manifest/hash entries. The table
can only ever be empty, so the hold/release routes operate on rows that no code creates. This is
the same failure shape as the serve point with no caller in `00_STATUS.md` ("implemented,
instrumented and called by nothing").

Both routes are also **unguarded transitions**: each is a bare
`.update({ status: … }).eq("id", payoutId)` with no predicate on the current status, so releasing
an already-released or held-under-investigation payout succeeds silently. Section 7 makes every
payout transition a compare-and-swap for this reason.

### 1.5 The non-cash reward ledger — the one thing in the tree built like a ledger

`intel_reward_ledger` (`src/migrations/2170_intel_reward_ledger.sql`) is the closest existing
approximation of what section 4 describes, and its properties are worth naming because the payment
design reuses all of them:

- **Append-only by grant, not by convention.** service_role receives `INSERT, SELECT` only; there
  is no UPDATE grant, so a booked entry is immutable (`2170:55-56`).
- **A financial-control boundary in the schema.** `CHECK (cash_amount = 0)` makes it structurally
  impossible to book platform-funded cash through this table (`2170:40`). The header states the
  reasoning: cash is *"a SEPARATE switch behind payments/KYC/tax/fraud infrastructure that does not
  exist"* (`2170:12-15`).
- **Exactly-once by a partial unique index plus 23505 handling.** `(actor_id, idempotency_key)`
  WHERE the key is non-null (`src/migrations/2180_intel_reward_ledger_idempotency.sql:34-36`), and
  the service treats the unique violation as a **replay**, reading back and returning the original
  entry rather than crediting twice (`services/intel/RewardService.ts:72-91`). `2180:17-19` records
  why detection is via the error code and not PostgREST `on_conflict`: **inference does not match a
  partial index.**
- **A deletion grant added deliberately and reasoned about.** `2204` grants DELETE *only* so
  account deletion can erase the rows, and argues the retention question explicitly: non-cash, so
  no tax obligation applies (`2204:19-32`).

`intel_attributions` supplies the second half of the pattern — an append-only *derived* ledger
where recomputation is a **new row under a new `algorithm_version`, never a rewrite**
(`2277:36-40`), made at-most-once by `UNIQUE (outcome_event_id, observation_id, algorithm_version)`
(`2277:217-218`).

---

## 2. Currency and FX as they exist today

`fx_rates` holds ECB reference rates with `base_currency = 'EUR'`; each row's `rate` is *units of
`currency` per 1 EUR* for a `rate_date`, and conversion pivots through the base:
`amount_to = amount_from × (rate[to] / rate[from])` (`lib/fx.ts:1-18`, `:71-79`). Migration `0183`
wires it into the trip cost estimate behind `budget_fx_conversion_enabled`, seeded **FALSE**
(`src/migrations/0183_budget_fx_conversion.sql:15-18`; read at
`routes/tripBudgetIntel.ts:134-139`). Rates are refreshed daily by an env-gated scheduler
(`FX_REFRESH_ENABLED`), not by the flag (`lib/fx.ts:139-179`).

`0183` established an **honesty contract** that section 8 adopts wholesale rather than reinventing:

- Every conversion is labelled with its `rate_date` and an *indicative* disclaimer — ECB reference
  rates are not the rate anyone actually gets (`lib/fx.ts:20-21`, `:117`).
- When either currency is absent from the table, `convert()` returns **null** and the caller shows
  the original amount. **A conversion is never fabricated** (`lib/fx.ts:10-14`, `:77`).
- The source-currency figures are never altered by the presence of a conversion (`0183:8-10`).

`price_baselines` is admin-curated reference data that deliberately shipped **empty**, so estimates
returned `{ available: false, reason: 'no_baseline_data' }` rather than numbers nobody verified
(`0171:1-7`); `0185` seeded 24 global rows plus per-country scalings, marked
`confidence = 'curated'` precisely so a licensed feed can replace them pair-by-pair later
(`0185_seed_price_baselines.sql:1-19`).

**Every money amount in the live schema is `numeric(10,2)` and, apart from
`rent_buddy_profiles.currency` / `rent_buddy_packages.currency` (which the live booking path never
reads), is implicitly USD** — the columns are literally named `*_usd`. There is no currency column
on `rent_buddy_bookings`, `rent_buddy_earnings_ledger`, `rent_buddy_payouts` or `rent_buddy_tips`.

---

## 3. DESIGN — scope, and what this design refuses

Everything from here is unbuilt. Three refusals up front, because they constrain every section
that follows:

1. **No amount is ever stored as a float, and no amount is stored without its currency.** The
   existing `*_usd numeric(10,2)` columns are acceptable arithmetic but encode the currency in the
   column *name*, which cannot be joined, checked, or migrated. New money columns are
   `amount_minor bigint` + `currency char(3)`, always as a pair.
2. **Nothing here reads or writes money in the API process by read-modify-write.** Every balance
   move is a single statement, for the reason `.agents/memory/counter-update-atomicity.md` records:
   the completion review rejects read-modify-write increments as lossy under concurrency, and the
   fallback path in `services/rentBuddy/ReliabilityCounters.ts:61-75` — acceptable for a display
   counter — is **not** acceptable for money and must not be copied.
3. **No revenue signal enters the ranker.** See section 10.

## 4. DESIGN — the wallet / balance model

**There is no `wallet` table anywhere in the tree** (verified by grep across
`artifacts/` and `migrations/`). The design does not add one as a mutable row.

A wallet is **a name for a set of ledger accounts belonging to a party**, and a balance is **a
derived quantity, never a stored one that a writer maintains**. The reason is the one this repo has
already paid for twice: a denormalised counter that a request path increments drifts silently and
cannot be reconciled after the fact, and a summary row that is only ever written once
(§1.3) is indistinguishable from a correct one.

```
party (profile | platform | processor | external)
  └── account (party × account_type × currency)        ← the addressable unit
        └── entries (append-only, signed, minor units) ← the only truth
              balance := SUM(amount_minor) over entries
```

- **`payment_accounts`** — one row per `(owner_kind, owner_id, account_type, currency)`, unique on
  that tuple. `owner_kind ∈ {user, platform, processor, external}`. Creating an account is cheap
  and idempotent; a party with no entries has a zero balance by construction, not by a seeded row.
- **Balances are read from a materialised projection, not maintained by the writer.**
  `payment_account_balances` is refreshed by a single `INSERT … ON CONFLICT DO UPDATE SET
  balance_minor = payment_account_balances.balance_minor + EXCLUDED.delta_minor` executed **inside
  the same transaction as the entries**, or recomputed DB-side by a `SECURITY DEFINER` function.
  Either way it is one statement, matching the `rb_adjust_buddy_counter` shape
  (`src/migrations/2305_rent_buddy_signal_writers.sql:57-75`) — column allowlist, `GREATEST(0, …)`
  where a clamp is meaningful, `REVOKE ALL … FROM PUBLIC` then `GRANT EXECUTE … TO service_role`.
  A drift check that recomputes `SUM(entries)` and compares is the reconciliation job, and it is
  the *only* thing permitted to correct the projection.
- **Available vs. posted.** A payout eligibility read needs *available* balance = posted balance
  minus holds. Holds are themselves entries (into a `held` account), so "available" stays a pure
  function of the ledger and no second mutable field exists.

## 5. DESIGN — the double-entry ledger

### 5.1 Why double-entry, concretely, for this repo

Not because accounting convention says so. Because of §1.3 and §1.4:

| The single-row model's failure | What double-entry does instead |
|---|---|
| `in_app_amount_collected` records collection with no counterpart, so nothing contradicts it (§1.3.1) | A collection cannot be recorded without a matching credit to a real account; a fictitious collection fails the balance invariant |
| Three call sites recompute net from three constants (§1.3.3) | The split is computed **once**, at the moment the entries are written; every reader sums entries |
| The ledger row is mutable, so history is unrecoverable | Entries are append-only; a correction is a **new, opposite entry**, exactly as `intel_attributions` recomputes under a new `algorithm_version` (`2277:36-40`) |
| Payout rows nothing creates (§1.4) | A payout is *initiated from a balance*, so it cannot exist without the entries that funded it |

### 5.2 The account taxonomy

Every entry names two accounts. Nothing is booked against a single side.

| `account_type` | `owner_kind` | Normal sign | What it means |
|---|---|---|---|
| `user_payable` | user | credit | What the platform owes a buddy/creator |
| `user_receivable` | user | debit | What a traveller owes (an authorised-but-uncaptured charge) |
| `platform_revenue` | platform | credit | Platform fee earned — the counterpart of `rent_buddy_fee_rules.platform_fee_percent` |
| `platform_fee_expense` | platform | debit | Processor fees the platform absorbs |
| `processor_clearing` | processor | either | Money in flight at the PSP; reconciled against the PSP's own settlement report |
| `payout_in_transit` | platform | debit | A payout instructed but not confirmed |
| `hold_reserve` | platform | credit | Funds withheld against dispute/fraud/KYC |
| `refund_liability` | platform | credit | Refunds owed and not yet paid |
| `tax_withheld` | platform | credit | Reserved; unbuilt (see §10) |

Buddy tips (`rent_buddy_tips`) and platform fee (`rent_buddy_fee_rules`) are *not* new account
types — they are `user_payable` and `platform_revenue` entries carrying a different
`entry_reason`.

### 5.3 The invariants, and where each is enforced

These are checks a migration installs, not conventions a reviewer remembers.

| # | Invariant | Enforcement |
|---|---|---|
| **I1** | Every entry belongs to exactly one transaction, and each transaction's entries sum to **zero per currency**. | `DEFERRABLE INITIALLY DEFERRED` constraint trigger on `payment_ledger_entries`, checked at COMMIT, grouped by `(transaction_id, currency)`. Deferred is required: the two sides are separate INSERTs. |
| **I2** | Entries are immutable. | No UPDATE/DELETE grant to service_role (`2170:55-56` shape) **plus** a `BEFORE UPDATE OR DELETE … FOR EACH ROW` trigger that RAISEs (`2120:141-146`). |
| **I3** | **No `FOR EACH STATEMENT` append-only trigger.** | Deliberate omission. `2292_intel_stmt_trigger_removal_ig_campaign.sql:20-32` records the observed live failure: a statement-level trigger fires before any row is examined, so it refuses an erasure **cascade** whether or not there is anything to protect, making users undeletable. Row-level plus TRUNCATE-level only. |
| **I4** | No currency mixing inside one entry pair. | `CHECK` that both sides of a transaction share `currency`; cross-currency is two transactions plus an explicit FX transaction (§8). |
| **I5** | `amount_minor <> 0`, and `currency` matches the account's currency. | Column CHECK + FK to `payment_accounts (id, currency)` on a composite key. |
| **I6** | A user account's balance may not go negative except for account types explicitly allowed to. | Enforced in the balance-move function, not by the caller. |
| **I7** | Every transaction carries a non-null `attribution` (§6) and a non-null `idempotency_key` (§7). | `NOT NULL` columns. Absence is not permitted to be silent — this is `ROADMAP.md`'s governing invariant, *absence of evidence must never silently become evidence of absence*, applied to money. |

### 5.4 The transaction envelope

`payment_transactions` (one row) + `payment_ledger_entries` (≥ 2 rows). The transaction carries
`kind` (`charge`, `capture`, `fee`, `payout`, `refund`, `chargeback`, `reversal`, `fx`),
`idempotency_key`, `attribution_*`, `external_ref` (the PSP object id), and `occurred_at`. The
entries carry only account, signed `amount_minor`, currency and `entry_reason`.

The **spine** already exists for the observable half: `canonical_events` is append-only with
UPDATE/DELETE/TRUNCATE blocked (`2120:56-84`, `:141-157`), and `buddy_booking_events`
(`baseline:3788-3797`) already records `from_status → to_status` with an actor for booking
lifecycle. Money transitions get the same treatment; the ledger is the truth, the event log is the
narrative.

## 6. DESIGN — attribution

The question "which creator, place, or booking caused this money" must be answered **at write
time and stored on the transaction**, never reconstructed later by a join against mutable rows.
The repo already learned this the expensive way: `rank_events` is mutable state, an outcome
UPDATEs the impression row in place, and the *transition* is therefore unrecoverable
(`00_STATUS.md`, `04_Behavior_Engine.md`, `routes/rankEvents.ts:194`).

Every `payment_transactions` row carries a frozen attribution tuple:

- `cause_kind ∈ {booking, subscription, tip, reward, adjustment}` and `cause_id`.
- `subject_kind` / `subject_id` — the place, event, or trip the money is *about*, using the same
  vocabulary as `canonical_events.subject_kind` (`2120:69-70`).
- `beneficiary_account_id` — the account credited.
- `attribution_version` — the algorithm that decided the split, copied from
  `intel_attributions.algorithm_version` (`2277:200`). **A revised split is a new transaction under
  a new version, never an edit.**

Three constraints on attribution, each grounded:

1. **Multi-party attribution is a weighted set summing to ≤ 1.0, in its own append-only table.**
   `intel_attributions` already models exactly this — normalised weights per outcome, unique on
   `(outcome_event_id, observation_id, algorithm_version)` (`2277:181-183`, `:217-218`). Payment
   attribution reuses the shape rather than inventing a second one.
2. **The reporter is never the beneficiary by default.** `2277:54` and `:179-180` are explicit: the credited actor
   is the *contributor*, and the outcome reporter *"is not named on this table at all"*. The same
   separation applies to payments: whoever triggers a charge is not thereby a payee.
3. **Creator attribution cannot borrow the ranker's creator plumbing.** `creatorId` population is
   **HELD** — an owner scoping call, because populating it simultaneously activates four ranking
   behaviours that have never run against real values (`docs/fact-layer-20260810/DECISIONS.md:83-87`;
   `06_Recommendation_Engine.md`). A payment design that depends on it is blocked on a decision
   that is not a payments decision. Payment attribution therefore resolves creators through the
   **causing entity** (booking → buddy profile → `user_id`, as
   `lib/rentBuddyEarningsLedger.ts:53-58` already does), not through ranking metadata.

**Where this touches a standing ruling:** durable, reconstructable attribution of a *discovery*
event to a payment would want **Event Truth**, the append-only decision store — which is
**Phase-B gated and unbuilt**, with no migrations (`00_STATUS.md`;
`docs/discovery/event-truth-schema-packet.md`). This design therefore does **not** depend on it:
payment attribution is anchored to the commercial cause (booking/tip/reward), which is durable
today, and a discovery→purchase chain is explicitly out of scope until Event Truth exists.

## 7. DESIGN — idempotency and exactly-once

Money operations are at-least-once by nature: clients retry, webhooks redeliver, schedulers
re-fire. `2180`'s header names the exact defect this prevents — an at-least-once caller booking
the same earning twice on an append-only ledger with *no way to reverse it*
(`2180:6-12`).

The rule, in three parts:

1. **Every money-moving request carries a caller-supplied `idempotency_key` derived from the
   *event*, not the attempt.** `RewardService`'s doc-comment states the derivation rule verbatim —
   *"Derive it from the earning event (e.g. `outcome:<outcomeId>`), not per-attempt"*
   (`services/intel/RewardService.ts:24-31`). A per-attempt key makes the mechanism decorative.
2. **Uniqueness is a database index, not an application check.** `UNIQUE (scope, idempotency_key)`
   on `payment_transactions`. A read-then-insert guard loses the race; the index does not.
3. **A unique violation is a replay, not an error.** The writer catches `23505`, reads back the
   original transaction and returns it — the exact control flow at
   `services/intel/RewardService.ts:77-91`, which returns `{ ok: true, replayed: true }` with the
   original entry. **Do not attempt PostgREST `on_conflict` inference if the index is partial**:
   `2180:17-19` records that inference does not match a partial index, which is the trap that broke
   `intel_state_snapshots` in `2176`.

For processor webhooks, the PSP's event id is the idempotency key and the handler must be
**order-independent** as well as duplicate-safe: a `charge.captured` arriving before
`charge.authorized` must reconcile, not fail. State is derived from the entries, so a late-arriving
authorisation books an entry that is already superseded and nets to the same balance.

**Ordering vs. atomicity.** The tip path (§1.3) writes three tables with no transaction and two of
them best-effort. Money writes do the opposite: entries + transaction + balance projection are one
DB transaction, and anything genuinely optional (notifications, analytics) happens strictly
*after* commit.

## 8. DESIGN — currency and FX

Reuse `0183`, do not re-derive it.

- **The ledger is multi-currency; a transaction is single-currency (I4).** An account has one
  currency. A cross-currency movement is: debit source-currency account → credit an FX clearing
  account in the source currency (transaction 1), then debit FX clearing in the target currency →
  credit the target account (transaction 2), linked by `fx_transaction_id`. The spread lands in
  `platform_revenue` or `platform_fee_expense` as an explicit entry, never as an unexplained
  rounding difference.
- **A settlement rate is not a display rate.** `fx_rates` is ECB *reference* data and
  `lib/fx.ts:20-21` says in as many words that the rate a traveller actually pays may differ. It is
  correct for the budget estimator and **wrong** as a settlement rate. A settled FX transaction
  stores the **rate actually applied by the processor**, its source, and its timestamp, on the
  transaction row. `fx_rates` may seed a *quote*; it may never book a *settlement*.
- **Never fabricate.** `convert()` returns null when a rate is missing and the caller shows the
  original amount (`lib/fx.ts:10-14`, `:77`). A payment path extends this: a missing rate is a
  **refusal to book**, not a guess. This is the roadmap invariant again — an absent rate must not
  silently become a plausible number.
- **Rounding is booked, not dropped.** Splitting a total into fee + net produces a residual cent.
  `lib/rentBuddyEarningsLedger.ts:69-71` currently rounds each component independently, so
  `platform_fee_amount + buddy_net` need not equal `total`. Under I1 that transaction simply will
  not balance — which is the point. The largest-remainder residual is assigned deterministically to
  a named account.
- **Minor units, integers.** `numeric(10,2)` is safe arithmetic but invites float handling in JS
  (`Number(row.amount_usd ?? 0)` appears throughout `routes/rentABuddy.ts` and
  `routes/rentABuddyMarketplace.ts`). Ledger amounts are `bigint` minor units, and the API never
  performs money arithmetic in JavaScript at all.

## 9. DESIGN — payout lifecycle, refunds, reversals

### 9.1 Payout states

`rent_buddy_payouts.status` today is free `text` with the value set listed only in a **SQL
comment** (`artifacts/api-server/migrations/0110_rent_buddy_payouts.sql:9-10`) and no CHECK in the
live table (`baseline:9295-9309`). The design constrains it — an enum or CHECK, as
`rent_buddy_booking_status` already is (`baseline:475-489`).

```
eligible → requested → approved → instructed → paid
              │            │           │
              │            │           └──▶ failed ──▶ (returned) ──▶ requested
              │            └──▶ on_hold ──▶ approved | cancelled
              └──▶ cancelled
```

Every transition is a **compare-and-swap**: `UPDATE … SET status = :next WHERE id = :id AND status
= :expected`, and a zero-row result is a 409, not a success. The current hold/release routes are
the counter-example (§1.4) — they assert the target state unconditionally.

Failure states are first-class, because in payouts they are the common case:

| State | Cause | Ledger effect |
|---|---|---|
| `failed` | PSP rejected the instruction | Reverse `payout_in_transit` → `user_payable`; the money returns to the balance |
| `returned` | Bank returned funds after apparent success | Same reversal, plus a `reversal` transaction referencing the original |
| `on_hold` | Dispute, fraud signal, KYC lapse | Entries move to `hold_reserve`; **available** balance drops, posted balance does not |
| `cancelled` | Withdrawn before instruction | No entries; the request row records the reason |

**A payout must not be instructable while identity verification is non-operational.** That gate
already exists in the tree for bookings (`lib/rentBuddyKycGate.ts:57-80`) and it fails **closed**
on DB error by design (`:25-29`). Payout eligibility reads the same gate. Adding a second,
independently-defaulting switch would reproduce the defect `2210` had to correct — a flag whose
intended default was FALSE that a later migration forced TRUE
(`migrations/2210_rent_buddy_default_off.sql:8-19`).

### 9.2 Refunds, chargebacks, reversals

Three distinct things; conflating them is how a ledger loses money.

- **Refund** — platform-initiated, voluntary. A new transaction debiting `platform_revenue` and/or
  `user_payable` and crediting `refund_liability`, then `processor_clearing` on settlement. It
  references the original transaction; it never edits it.
- **Chargeback** — issuer-initiated, adversarial, and it can arrive *months* after payout. It
  debits `user_payable` (which may drive it negative — I6 permits this for exactly this account
  type) and books the processor's chargeback fee to `platform_fee_expense`. A chargeback that
  arrives after a payout is why `hold_reserve` exists and why payouts have a maturation window.
- **Reversal** — the platform's own correction of its own error. Always a new transaction whose
  entries are the negation of the original, carrying `reverses_transaction_id`. **Never** a DELETE:
  I2 makes that impossible, and `2277:36-40` already establishes the principle for derived data.

`rent_buddy_payment_status` already contains `refunded` and `partial` (`baseline:635-643`); those
values become derived reads over the entries, not a column someone remembers to update.

Cash bookings sit outside all of this, and the design must not pretend otherwise. `payment_mode =
'deposit_plus_cash'` leaves `cash_balance_usd` to be settled hand-to-hand, confirmed only by two
booleans on the booking (`routes/rentABuddy.ts:2596-2605`). `docs/rent-buddy-audit.md:397` names the
consequence: *"A buddy could confirm an inflated cash amount."* The confirm-cash route also reads
the booking and then writes it in a separate statement (`:2584-2600`), so two simultaneous
confirmations race. **Cash is not booked to the ledger as platform money.** At most it is recorded
as an off-ledger `memo` entry pair against an `external` party, so it appears in a buddy's earnings
view without ever claiming the platform holds it.

## 10. Audit and privacy posture

**Money data is restricted, and the restriction is structural.**

- **RLS deny-default; no client write grant, ever.** The pattern to copy is `2170:50-56`: `ALTER
  TABLE … ENABLE ROW LEVEL SECURITY`, then `REVOKE ALL` from `PUBLIC`, `anon`, `authenticated`
  **and** `service_role`, then a narrow re-grant. The revoke must be unconditional and must come
  first — the sibling note at `2120:29-32` records that a bare GRANT establishes no limit, *"the 2092
  defect 2093 repaired"*. Note that the existing money tables carry table-level `GRANT ALL … TO
  anon, authenticated` (`baseline:37347-37349` for `rent_buddy_earnings_ledger`, `:37464-37466` for
  `rent_buddy_payouts`); they are protected **only** by RLS policies. New money tables must not
  inherit that default.
- **Authorization helpers live in the `authz` schema, not `public`.** `2182` moved `is_blocked`,
  `in_accepted_circle` and `can_see_location` out of `public` with `ALTER FUNCTION … SET SCHEMA`
  precisely because PostgREST exposes `public` RPCs and the parameter-trusting `SECURITY DEFINER`
  predicates were an anonymous oracle over the social graph
  (`src/migrations/2182_close_authz_rpc_oracle.sql:22-32`, `:95-97`). Any predicate a payment policy
  calls goes in `authz`, and a function whose `search_path` is pinned must have the pin updated
  when it moves (`2182:99-102`).
- **Each side sees only its side.** The existing precedent is `rb_ledger_buddy`, `FOR SELECT USING
  (auth.uid() = buddy_user_id)` (`baseline:30887`) — the buddy reads their own row and nobody else
  does. Note the current asymmetry: the *traveller* who owes the money cannot read the ledger row
  about their own booking. The design gives each party a scoped view of the entries naming their
  account, never the counterparty's.
- **Amounts are not decorations on unrelated surfaces.** No money field belongs in a graph node, a
  feed payload, or a ranking feature vector. `05_Graph_Engine.md` establishes the principle for
  privacy generally: the `circle` node carries visibility and city but never the member-authored
  name; the `experience` node reads only published memories and re-checks per row.

**Audit.** Every transition is already-recorded by construction — the ledger is append-only (I2),
`buddy_booking_events` records booking transitions with an actor (`baseline:3788-3797`), and
`rent_buddy_admin_actions` records admin acts (`baseline:8875-8884`, written at
`routes/rentABuddySpec.ts:2184-2190`). What is missing today and must not be missing here: an admin
money action's audit write is currently **fire-and-forget after** the state change, so a failed
audit insert leaves an unlogged release. Under this design the audit row is inside the same
transaction as the entries; if it cannot be written, the money does not move.

**Retention vs. erasure — an unresolved conflict, named rather than assumed away.** The reward
ledger resolved it easily: non-cash, so no tax obligation, so erase with the contributions that
earned it (`2204:30-32`). **Real money cannot take that route.** Meanwhile the current money tables
— `rent_buddy_bookings`, `rent_buddy_earnings_ledger`, `rent_buddy_payouts`, `rent_buddy_tips` —
are all in `UNCLASSIFIED_BACKLOG` in `lib/deletionDispositions.ts:406-423`, which that file is
explicit is **"NOT a decision"**: the data survives account deletion and nobody has said whether it
should (`lib/deletionDispositions.ts:20-27`). The design's position is that financial records are
`RETAINED_WITH_REASON` with a stated statutory period and the **personal** columns pseudonymised at
deletion (account id retained, identity detached) — but that is an owner decision (D6), not one
this document may make. It is recorded here so it cannot be inherited as silence.

---

## 11. What is NOT built, and why

- **Everything in sections 3–10.** No migration, no table, no route, no flag. This document is
  design; the repo state is section 1.
- **A payment processor.** Not chosen, not installed, not stubbed beyond the two 503s
  (`routes/rentABuddy.ts:1686-1704`). Choosing one is an owner decision with KYC, tax and fraud
  consequences, exactly as `2170:12-15` states.
- **Payout creation.** The table and the two admin transitions exist; **nothing inserts a row**
  (§1.4). The lifecycle in §9.1 has no entry point until a funding source exists.
- **`payment_status` transitions.** The enum exists live; no reader, no writer (§1.2).
- **Refund eligibility.** 501 (`routes/rentABuddy.ts:3198-3203`).
- **Tax documents.** The earnings route says so to the user's face: *"Tax documents are not
  available yet"* (`routes/rentABuddy.ts:6289`). `tax_withheld` in §5.2 is a reserved account type
  with no writer.
- **Cash-flow settlement of the cash half.** Deliberately out of ledger scope (§9.2).
- **Any cash path for contributor rewards.** `intel_qiu_cash_pool` is a declared flag with a
  dependency on `intel_missions` (`lib/intelContracts.ts:755`, `:771`) and no funding source; `qiu` is
  shadow-only and *"NEVER moves money"* (`lib/qiuShadow.ts:9-14`).

### Standing rulings this document touches

`docs/discovery/ROADMAP.md` contains **no** payment, payout, wallet, ledger or monetisation ruling
— verified by grep, 2026-09-07. Payments are not a discovery workstream and this document does not
propose work inside one. Three adjacencies, stated explicitly:

1. **The ranker is on explicit owner HOLD** (`ROADMAP.md:222`). Nothing here proposes a ranking
   change, and the design **forbids** revenue as a ranking input: no `platform_revenue`,
   commission rate, or payout volume may become a `portavaRank` feature. `06` records that every
   modifier input is bounded by a code constant and that momentum is capped *below every taste
   signal*; a revenue term has no such bound and would invert the ordering the roadmap's step 7
   ("taste as the spine") establishes.
2. **Event Truth is Phase-B gated and unbuilt** (`00_STATUS.md`;
   `docs/discovery/event-truth-schema-packet.md`). §6 is designed to **not** depend on it —
   attribution anchors to the commercial cause. Discovery-to-purchase attribution is out of scope
   until Event Truth exists, and this document does not create a new prerequisite for it, which
   the 2026-08-15 owner ruling forbids (`ROADMAP.md:158-166`).
3. **Phase F is FROZEN + NOT AGENT WORK** (`ROADMAP.md:534`). Nothing here touches
   `DISCOVERY_ENGINE_MODE`, `discovery_ranking_modifiers_enabled`, or either owner gate.

### Contradictions found between the older documents and the tree

Recorded because both read as current otherwise.

- **`docs/rent-buddy-audit.md:380-389`** describes `pay-deposit`/`pay-full` as returning a fake
  `paymentIntent` with *"Complete payment via the Stripe payment sheet"* and emitting a milestone
  notification. **That is no longer true**: both routes now return 503 with no side effects
  (`routes/rentABuddy.ts:1686-1704`), which is strictly more honest. The audit's §4.1 is stale in
  the safe direction.
- **`docs/rent-buddy-audit.md:393`** recommends *adding* a `payment_status` column. It already
  exists live as a seven-value enum (`baseline:635-643`) — and has neither reader nor writer, which
  is a different and worse problem than not existing.
- **`docs/rent-buddy-audit.md:401-405`** (hard-coded 15 % platform fee) was filed against Task
  #1701/#1703 and is **still open** at `routes/rentABuddy.ts:6237`, now alongside *two* other
  independent fee computations (§1.3.3).
- **`docs/rent-buddy-product.md:203-207`** maps migration `0048` to *"Marketplace: platform fee,
  payment modes"*. In the archived root tree, `migrations/0048_booking_stay_connected.sql` is a
  two-column ALTER about connection opt-ins; the marketplace file is
  `artifacts/api-server/migrations/0048_rent_buddy_marketplace.sql` in the **frozen legacy** tree.
  Two trees share migration numbers. Read `docs/migrations.md:12-22` before citing a number, and
  cite the baseline dump for what is actually live.
- **`migrations/2074_rent_buddy_kyc_gate_flag.sql:32-33`** says payments are *"two 501 responses"*;
  they are 503 (`routes/rentABuddy.ts:1689`, `:1699`). Harmless drift, corrected here.
- **`migrations/0047_rent_buddy.sql`** (root, archived) grants the traveller `FOR ALL USING
  (auth.uid() = traveler_id)` on bookings — which would let a client edit `total_price`. The
  **live** schema does not: `rb_booking_parties` is SELECT-only and `rb_booking_traveler_ins` is
  INSERT-only (`baseline:30737-30753`). The archived file is not what production runs. A traveller
  can still INSERT a booking row directly with a client key under that policy, which is why the
  rule that prices are server-computed must eventually be a database CHECK or a
  `SECURITY DEFINER` entry point, not only a convention in `routes/rentABuddy.ts:1577-1580`.
