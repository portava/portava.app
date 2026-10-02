# Input Intelligence performance protocol — G354

**Written:** 2026-09-21 · **Branch:** `claude/ii-telemetry-metrics`
**Covers:** `census-input-intelligence.md` **G354** (§49 — Performance
certification: P50/P95 latency, cold start, render cost, large-index behaviour).

---

## 0. What this document is, and the one rule that governs it

This is the **runnable protocol and the ledger**. It is not a result.

**Every row in the ledger below reads NOT RUN.** No measurement in this document
has been taken, because no deployment and no physical handset were reachable
from the session that wrote the harness. That is a failed prerequisite, not a
product pass and not a product failure.

> **The substitution rule, inherited from `docs/map/device-measurement-protocol.md`:**
> simulator, web, unit and component evidence **must not** be entered in these
> ledger rows as a substitute for a measured result.

That rule is why this document is separate from the test suite. The suite proves
the *instruments*; a green suite is not a number. A row moves off **NOT RUN**
only when an operator runs §2–§4 against a real deployment (and, for §4, real
hardware) and attaches the evidence the row names.

G354 stays **CANNOT-VERIFY** in the census until then. The harness existing
narrows the blocker from "no harness exists" to "no run exists"; it does not
settle the requirement.

---

## 1. Prerequisites

Every one is hard. A run missing any of them is **NOT RUN**.

| # | Prerequisite | Why, and what happens without it |
| --- | --- | --- |
| P1 | A deployed api-server reachable over HTTPS, with `INPUT_ASSIST_BASE_URL` pointing at its `/api` root. | `POST /input-assistance/suggest` is the thing being measured. There is no local stand-in: the route's cost is dominated by the database behind it. |
| P2 | A real user bearer token for that deployment (`INPUT_ASSIST_TOKEN`). | `requireUser` runs first (`artifacts/api-server/src/routes/inputAssistance.ts`), and the per-user rate limit is keyed to it. Use a test account, not a person's. |
| P3 | Knowledge of whether the server process had just started. | The cold-start row is only valid against a cold process, and no harness can verify that from outside. An operator who does not know must record the cold row as **NOT RUN**. |
| P4 | For §4 only: a physical iOS and Android handset with frame profiling enabled. | Render cost is a device fact. See §4. |
| P5 | Migration 2950 applied, for §5 only. | The serve-log cross-check reads `input_assistance_telemetry_events`, which is unapplied on every database today (`artifacts/api-server/src/scripts/checkProductionDrift.ts`). |

**The rate limit is not to be raised for a run.** `/input-assistance/suggest`
allows 90 requests per user per minute. The harness paces itself at 70/min and
prints that it did. A number obtained by widening the limit is a number about a
different system than the one that serves users.

---

## 2. Latency — P50/P95, and cold start

```
INPUT_ASSIST_BASE_URL=https://<host>/api \
INPUT_ASSIST_TOKEN=<bearer> \
  pnpm --filter @workspace/api-server run measure:input-latency -- --iterations 120
```

The harness is `artifacts/api-server/src/scripts/measureInputAssistanceLatency.ts`.
It is read-only: it issues `POST /input-assistance/suggest` and nothing else.

It reports **two** latencies per sample and never merges them:

- **round trip** — what this process saw, network included;
- **serve self** — the `serverMs` the route measures of itself
  (`artifacts/api-server/src/routes/inputAssistance.ts`), carried on the response
  envelope.

The difference between them is the network, and neither side can measure that
alone. A single "latency" number hides it.

**It refuses to print a percentile below 60 successful samples**, exiting
non-zero. A P95 over a short sample is one observation with a confident name on
it.

**Cold start** is the first request of the run, reported on its own line and
never folded into the warm sample — an averaged cold start disappears. It is
valid only under P3.

---

## 3. Large-index behaviour

Same command, same run. The harness splits its corpus:

- **selective** — `reykjavik`, `ljubljana`, `chiang mai`, `ushuaia`, `trondheim`;
- **unselective** — `sa`, `ba`, `la`, `san`, `ne`.

Both groups are reported with their mean suggestion count, so "slower" can be
read against "matched more". An index that degrades with candidate-set size
shows up as a widening gap between the two; one that does not shows the gap
closing to the network floor.

**What this does not cover:** the size of the canonical index on the deployment
being measured. Two runs against differently-sized indexes are not comparable,
and the operator must record the row count alongside the result.

---

## 4. Render cost — device only

**Not measurable by any script in this repository, and not approximated.**

Render cost is the frame cost of `SuggestionOverlay` drawing N rows on real
hardware. It belongs with the other device rows of this programme and is
governed by the same substitution rule: a component-test render time is not a
frame time.

An operator with handsets should follow the capture method in
`docs/map/device-measurement-protocol.md` (`dumpsys gfxinfo` framestats on
Android, Instruments on iOS), opening each of the mounted fields listed in
`travel-buddy-standalone/src/platform/input-assistance/contexts/fieldInventory.ts`
and capturing while the overlay is populated. Fewer than 100 usable frames is
**NOT RUN**, not a pass.

---

## 5. Cross-check against the serve log — optional, and only after 2950

Once migration 2950 is applied and the §44 sink has been collecting, the same
latency question can be asked of real user traffic rather than of a harness:

```
pnpm --filter @workspace/api-server run report:input-metrics -- --days 7
```

`G372 suggest latency (server)` and `(client)` in that output are P50/P95 over
`suggestion_request_completed` events from real devices. That is a **better**
number than §2's, because it is the population rather than a probe — and it is a
different measurement, so it does not satisfy §2's row. Record both.

---

## 6. The ledger

| Row | Dimension | Environment | P50 | P95 | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| L1 | Suggest latency, round trip | — | — | — | **NOT RUN** | — |
| L2 | Suggest latency, serve self (`serverMs`) | — | — | — | **NOT RUN** | — |
| L3 | Cold start (first request, cold process) | — | — | — | **NOT RUN** (P3 unmet) | — |
| L4 | Large index — selective queries | — | — | — | **NOT RUN** | — |
| L5 | Large index — unselective prefixes | — | — | — | **NOT RUN** | — |
| L6 | Render cost — overlay frame timing, Android | — | — | — | **NOT RUN** (P4 unmet: no handset) | — |
| L7 | Render cost — overlay frame timing, iOS | — | — | — | **NOT RUN** (P4 unmet: no handset) | — |
| L8 | Serve-log latency over real traffic (§5) | — | — | — | **NOT RUN** (P5 unmet: 2950 unapplied) | — |

**G354 closes when L1–L7 carry results.** L8 is a stronger measurement of the
same thing and does not substitute for L1/L2.

---

## 7. What the test suite proves, and what it does not

These prove the *instrument*, and are listed so nobody mistakes them for the
measurement:

| Test | What it proves |
| --- | --- |
| `artifacts/api-server/src/test/inputAssistanceMetrics.test.ts` | The §57 computation — including the latency percentiles — is right to exact values over hand-built rows, and is nearest-rank rather than interpolated, so a reported P95 is a latency the system really produced. |
| `travel-buddy-standalone/src/platform/input-assistance/services/__tests__/installInputTelemetry.test.ts` | The §44 sink is attached at app boot, so `suggestion_request_completed` — which carries `serverMs` and `clientMs` — can reach the serve log at all. |
| `travel-buddy-standalone/src/platform/input-assistance/components/__tests__/telemetryLinkage.component.test.tsx` | The hook carries the serve's own `serverMs` through without inventing one when the deployment sends none. |

None of them opens a socket, and none of them is a latency.
