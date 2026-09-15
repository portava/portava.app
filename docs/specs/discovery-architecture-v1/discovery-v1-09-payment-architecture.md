# 09 — Payment Architecture

## 1. Build now vs later

Build now:
- attribution,
- wallet/accounting model,
- immutable ledger,
- pending earnings,
- holds,
- rule versioning.

Do later:
- real payouts,
- tax workflows,
- multi-country payout expansion,
- currency settlement complexity.

## 2. Ledger-first design

Never make wallet balance the source of truth.

Use immutable ledger entries.

Conceptual entry:
- id
- account_id
- entry_type
- amount
- currency
- direction
- source_type
- source_id
- attribution_id
- rule_version
- status
- created_at

## 3. Earnings states

- observed
- provisional
- pending
- verified
- held
- payable
- paid
- reversed

## 4. Attribution records

Store:
- conversion/event id
- gross economic value
- Portava revenue
- eligible creators
- Trail/content/place contributions
- confidence
- attribution method
- rule version

## 5. Wallet

Wallet is a projection:
- pending balance,
- available balance,
- lifetime earned,
- paid,
- held.

Rebuildable from ledger.

## 6. Refunds and reversals

Never mutate old ledger rows.
Create reversing entries.

## 7. Rule engine

Payout policy should be versioned and configurable.

Example dimensions:
- revenue source,
- creator eligibility,
- attribution confidence,
- fraud status,
- campaign rules.

## 8. Currency

Store monetary amounts as integers in minor units where possible.
Record source currency and settlement currency separately.

## 9. Payout provider abstraction

Future interface:
- create recipient
- validate recipient
- request payout
- get payout status
- handle webhook
- reverse/hold

Do not tightly couple core ledger to one provider.

## 10. Security

- service-role/backend only for ledger mutation,
- strict RLS for creator read views,
- signed webhook verification,
- idempotency keys,
- audit log.

## 11. Acceptance criteria

Payment architecture is ready before payouts when:
- every earning can be reconstructed,
- no balance depends on mutable totals,
- attribution is linked,
- reversals are possible,
- provider can be swapped later.
