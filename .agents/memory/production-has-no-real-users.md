---
name: Production has no real users — every profile is an owner-created test account
description: The production project is pre-launch. Its whole population is test accounts the owner made, so "0 rows" is the expected state, not evidence of a defect, and no k-anonymity gate can be reached there.
---

## The fact

**Stated by the owner, 2026-09-25: there are no users. Every account in production
is a test account the owner created themselves.**

`ajrurzioarfkagpuxfnb` is a **pre-launch** project that happens to be called
production. It serves no public traffic.

Measured the same day, read from the live database rather than inferred:

| table | rows |
| --- | ---: |
| `profiles` | **58** (all owner-created test accounts) |
| `sensing_anon_contributions` | 0 |
| `sensing_contribution_sessions` | 0 |
| `intel_observations` | 0 |
| `intel_state_snapshots` | 0 |
| `stories` | 0 |

## What this invalidates

Several architecture censuses reason about production emptiness as if it were an
*adoption* problem — something that improves as the product grows. It is not. There
is no population to grow from yet. Two specific readings are wrong:

1. **"The contributor population cannot reach k for the foreseeable term"**
   (census-sensing §11, about the k = 15 distinct contributors from ≥ 5 independent
   groups privacy gate). The gate is not *nearly* reachable and it is not a scaling
   question — **nothing has ever contributed**. Writing it as a forecast about growth
   implies a trajectory that does not exist.

2. **Any row held `W` or `X` "because production has no data"** is held on a fact
   about the launch state, not about the code. Such rows cannot move until the product
   has real users, and no amount of building changes that. They should be labelled as
   pre-launch-capped, distinct from deployment-capped.

## The two rules that follow

**A count of 0 in production is the EXPECTED state and is never, by itself, evidence
that a feature is broken.** Before filing "this produces nothing in production",
check whether anything could ever have produced something. Usually nothing has.

**Conversely: nothing can be production-verified against real usage.** A feature can
be verified as *applied* (schema, RLS, grants, a probe inside a rolled-back
transaction) but not as *exercised by real traffic*. Do not claim production
verification of behaviour that requires users; say the apply was verified and the
behaviour was not.

## What is genuinely verifiable in production today

Schema presence and shape · RLS enabled and policy count · grants by role · function
source (`pg_proc.prosrc`) · ledger rows and checksums · feature-flag values ·
functional probes inside a transaction that is rolled back.

## What is NOT

Anything needing a second independent contributor, a cohort, a k-gated aggregate,
real ingest traffic, or a populated table. Those wait on launch, not on a diff.
