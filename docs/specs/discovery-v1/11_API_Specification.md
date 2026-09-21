# 11 — API Specification

## 1. API principles

- existing auth/session conventions first,
- server-side authorization,
- idempotency for retries,
- versioned event schemas,
- explicit errors,
- no empty catches for critical behavior.

## 2. Behavior API

Prefer server-generated recommendation/exposure records where possible.

Endpoints/service actions conceptually:
- create recommendation exposure
- record client behavior batch
- validate event schema
- query internal diagnostics

Batching is acceptable for high-volume client telemetry.

## 3. Trails API

- list/search Trails
- get Trail
- get Trail modules
- follow/unfollow Trail
- suggest Trail association
- attach/detach content
- propose Trail
- report Trail/content mismatch
- get related Trails

## 4. Trending API

- trending by location
- trending by Trail
- personalized trending
- trend explanation
- emerging places/Trails

Never return internal raw scores unless needed for admin diagnostics.

## 5. Recommendation API

Inputs:
- surface
- session context
- pagination/cursor

Outputs:
- recommendation_id
- items
- reason labels where user-facing
- cursor
- model/version metadata internally

## 6. Creator economy API

Read:
- impact summaries
- attributed conversions
- provisional earnings
- payout eligibility

Write:
- payout profile later
- payout request later

No client-side earning calculation.

## 7. Revenue attribution API

Conversion ingestion:
- booking completed
- marketplace purchase
- affiliate conversion
- refund/reversal

Must be idempotent.

## 8. Admin APIs

- Trail merge
- Trail archive
- drift diagnostics
- trend integrity review
- creator fraud holds
- ledger audit

## 9. Error semantics

Telemetry and ranking APIs should distinguish:
- validation failure,
- authorization failure,
- constraint mismatch,
- transient DB failure,
- feature-disabled,
- unsupported surface.

A failure must not masquerade as success.

## 10. Acceptance criteria

API layer is ready when:
- every mutation is authorized,
- event rejection is observable,
- recommendation_id propagates end-to-end,
- attribution is idempotent,
- admin actions are audited.
