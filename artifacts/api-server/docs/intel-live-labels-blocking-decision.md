# IG live labels — the one decision that unblocks the pilot

> **RESOLVED 2026-08-26.** The owner ruled: keep the `distinctActors≥15 AND
> distinctGroups≥5` gate intact (no crowd-specific weakening), and instrument an
> independent group at capture. V1 group model: **solo = one group; a shared Trip
> Crew = one group; "with others" without a shared crew id = actor/confidence
> contribution only, ZERO group credit; unknown = same, fail-closed.** Session/
> device clustering is a later fraud/dedup enhancement, NOT part of the privacy
> primitive. Implemented in the group-signal PR (migration 2171 + `lib/intelGroupKey`
> + capture wiring + aggregator `distinctGroups`/`maxGroupShare` + the funnel's
> insufficient-vs-unavailable split). The section below is kept as the decision
> record.

**Status (at time of writing):** the Da Nang Phase-1 intelligence pipeline is now
**fully wired and instrumented end-to-end**, and it will emit **zero public live
labels** until one owner design decision is made. This document frames that
decision. It does not implement it — the only implementations available without a
ruling would weaken a privacy gate, which is out of bounds.

_Written 2026-08-26. Grounded in the code cited; no data was fabricated._

---

## Where the pipeline stands

| Stage | Component | State |
|---|---|---|
| Capture | `routes/intel.ts` → `IntelCaptureService` → `intel_observations` | built, flag-gated |
| Claim | `proposeClaim` / `approveClaim` → `intel_claims` | built |
| **Projection (driver)** | `lib/intelProjectionScheduler` + `intelProjectionAggregator` | **wired** (PR #143) — the previously-missing driver |
| Privacy gate | `lib/privacyGate.evaluatePrivacy` | built |
| Snapshot | `intel_state_snapshots` | written by the scheduler |
| Read/serve | `lib/liveClaimRead` → `routes/placeLiving` | built, flag-gated |
| **Measurement** | `lib/intelFunnelReport` + `report:intel-funnel` | **wired** (this branch) |

The two "library built but no driver" gaps the certification found are now closed:
the projection has a scheduler, and the density gate / funnel has a reader. What
remains is **not** a wiring gap — it is a **data-collection decision**.

## Why nothing publishes

`projectClaim` asks the shared privacy gate whether an aggregate may be published.
The gate (`PRIVACY_THRESHOLD_V1`, `lib/intelContracts.ts:411`) requires, in order:

1. `minUniqueActors: 15` — ≥15 distinct **people** (k-anonymity).
2. `minIndependentGroups: 5` — ≥5 distinct **independent groups/parties**.
3. `maxSingleGroupShare: 0.2` — no single group is >20% of contributions.
4. `publicationDelayMinutes: 10` — a 10-minute settling delay.

Capture collects **no group/party signal** — `intel_observations` has `actor_id`
but no group column (`migrations/2130_intel_storage.sql`) — and the projection
aggregator leaves `distinctGroups`/`maxGroupShare` **undefined**
(`lib/intelProjectionAggregator.ts`). The gate treats a missing group count, once
the actor floor is cleared, as `invalid_input` and **suppresses**
(`lib/privacyGate.ts:101-112`). This is the gate working **as designed** — it is
fail-closed, not broken.

**The precise consequence, and why it is not yet the blocker for Da Nang:** the
checks run in order, so a claim below 15 distinct actors suppresses as
`below_actor_threshold` — the group clause never runs. Only once a subject crosses
15 distinct contributors does the missing group signal become the reason
(`invalid_input`). The new `report:intel-funnel` prints exactly this breakdown, so
you can see at any moment whether the pilot is still density-limited or has reached
the group-signal wall.

## The decision

**What counts as an "independent group/party", and where does the signal come
from at capture?** The gate's intent is to stop one crowd (a single tour group, a
venue's own staff, one friend group) from reading as broad independent consensus.
Any answer needs (a) a definition, (b) a capture-side field, (c) a schema column,
and (d) derivation in `assembleClaimInput`.

| Option | Signal source | Privacy strength | Cost |
|---|---|---|---|
| **A. Trip crew / party id** | the traveler's active trip-plan or crew membership | strong — a real social unit | needs crew id threaded into capture |
| **B. Explicit party attestation** | ask "are you here with a group?" at capture | medium — self-reported, gameable | capture UX change |
| **C. Session/device clustering** | heuristic: cluster actors by device/session/time | weak — a proxy, not identity | derivation only, no UX |
| **D. Relax the gate for crowd claims** | define a crowd-specific threshold | changes the gate — **owner-only** | threshold + policy sign-off |

**What I will not do without your ruling:** the tempting shortcut —
`distinctGroups = distinctActors` (one actor = one group) — **defeats the
independence guard entirely**: a single 15-person tour group would read as 15
independent groups. That is a privacy-gate weakening and is off-limits per the
standing rule ("do not weaken any privacy threshold"). Options C and D also move
privacy strength and are your call, not an autonomous build.

Note the threshold matches the spec's §13 **movement** rule. Crowd-level labels may
warrant their own threshold — that is part of decision D if you take it.

---

## Safe follow-ups already identified, held for your sequencing

These are additive and safe, but each has a reason it is not an unattended build:

- **Persist the suppression reason + confidence detail** on `intel_state_snapshots`
  (the projection computes `PrivacyDecision.reason` and the full `ConfidenceResult`,
  then stores only the boolean/number). Additive, diagnostic, changes no serving
  path — but it pairs a **prod migration** with a write-path edit, and the edit
  breaks projection the instant it deploys ahead of the migration. This must be
  **migration-first, owner-pressed** (your final-trigger preference), not run while
  you are away. Today the funnel re-derives the reason read-only instead.
- **`commercialRisk` penalty** from `commercial_disclosure` (penalty-only, can only
  lower confidence). Lives in the aggregator, which is on the **unmerged #143**
  branch — a clean follow-up once #143 lands.
- **Scheduler suppression-reason logging** — have `runIntelProjectionPass` log the
  same reason breakdown the funnel computes, so operators see it in logs without
  running the report. In-memory only; a follow-up on #143.

## Consequential items — owner decision required (unchanged)

Rewards ledger, QIU, mission generation/dispatch, movement prediction, and
`canonical_events` **outcome** verbs are all built-but-unwired, but wiring each is a
consequential action (grants value, dispatches commitments, or serves predictions)
and/or depends on the group-signal decision above. They stay held, per the standing
financial/consequential boundaries.
```
