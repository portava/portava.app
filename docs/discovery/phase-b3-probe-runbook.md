# Phase B3 probe — staged runbook

**Status: STAGED, NOT RUN. The owner presses this.**

Prepared 2026-08-15 by the agent session that verified the deploy. Every
precondition below was checked, not assumed. The probe itself is a **production
write** and is therefore not an agent action.

Companion: `ROADMAP.md` → *Phase B — B3 — The repeat probe*, and
*DEPLOY VERIFIED CLEAN, 2026-08-15 12:13Z*.

---

## Why this is runnable now

Phase B's exit criterion — **discovery rows at MULTIPLE serve points** — has been
waiting on a deploy carrying #55 and #56. **That precondition is met.**

| | |
|---|---|
| Live build | `a384e29fa`, build-id `58536e52-de91-4ce1-b1d9-1a91fc2e7813` |
| Tree | `2014ada7` — byte-identical to `origin/bughunt-20260805` |
| Carries | #55, #56, #57, #58, #61, #62, #63, #64 |
| Verified | In the **running** build, not merely published — `/api/places/photo` returns a `places.googleapis.com` media URL, a construction only the clean tree can emit |

**This does not close Phase B.** It makes the probe meaningful. Nothing has been
measured in either direction.

---

## What this writes to production

**State this plainly before pressing anything.** The probe is an authenticated
navigation session against production Discovery. Its serves write:

- `rank_events` rows — `DiscoveryRankingService.rankItems` writes an eligible and
  a scored row **per candidate** whenever it is handed a client
  (`writeRankAnalyticAsync`, `:768/:867/:879/:888`). **A 15-place run writes 30
  rows.**
- `discovery_serve_log` rows via `logDiscoveryServe`.

`rank_events` is covered by the **90-day retention window**
(`docs/ops/retention-policy.md`). Rows written today persist for 90 days and are
visible to every later report over that window. That is the intended cost of the
measurement — it is named here so it is a decision rather than a surprise.

**The report in steps 1 and 3 is SELECT-only and writes nothing.**

---

## Step 1 — BEFORE baseline (read-only)

**Do not skip this.** Without a baseline, a post-probe reading cannot distinguish
rows the probe produced from rows that were already there. **A before/after pair
is the measurement; a single after-reading is an anecdote.**

The report refuses production by default and fails closed — that is the
`ciProdReadOnlyAuditGuard`, and it is load-bearing. It has a **sanctioned front
door** for exactly this case, which must be opened deliberately:

```bash
cd artifacts/api-server

PORTAVA_PROD_READ_ONLY_AUDIT='read-only-audit-against-production' \
KNOWN_PROD_PROJECT_REF='ajrurzioarfkagpuxfnb' \
pnpm run report:discovery-serve-points -- --days 1 \
  | tee /tmp/b3-before-$(date -u +%Y%m%dT%H%M%SZ).txt
```

**Preconditions, all verified present in the deploy shell on 2026-08-15:**

| Requirement | State |
|---|---|
| `SUPABASE_URL` → `ajrurzioarfkagpuxfnb.supabase.co` | already set |
| `SUPABASE_SERVICE_ROLE_KEY` | already set |
| No CI marker variables in the environment | none present |
| `PORTAVA_PROD_READ_ONLY_AUDIT` | **supplied by the command above** |
| `KNOWN_PROD_PROJECT_REF` | **supplied by the command above** |

> **Do not "fix" a refusal by changing the guard.** The intent value is a
> sentence and not a boolean precisely because `1` and `true` are what a person
> types to make an error message go away. If it refuses, read the reason — it
> names the specific one.

---

## Step 2 — The probe

Authenticate as the QA account **by email and password**. Not Google: per #3681,
headless automation can never complete real Google OAuth, and Phase B was never
gated on it (ROADMAP correction, #63).

Navigate Discovery so that **several distinct serve points** are exercised — that
is the criterion, and it is about the *surface being navigable*, not about one
endpoint responding. Cover at minimum:

- `GET /discovery` on a **cold** key (cache A miss) — the cold-fetch rank path
- `GET /discovery` on a **warm** key (cache A hit, then cache B)
- Compass-backed views
- Feed / search / suggest entry points (serve points 7–9)

**Watch for the two known live defects while navigating** — both are real and
neither blocks the probe:

1. **Nightlife detail lands on `/passport`** (B2, unfixed). If it still
   reproduces, that is evidence for B2, not a probe failure.
2. **Destination search returns nothing** — `/api/places/google-autocomplete`
   returns an empty list with a working key. Newly found 2026-08-15, not yet
   filed, not Phase B's.

---

## Step 3 — AFTER reading, and what to record

Same command as step 1, `-after-` in the filename. Then record **all** of the
following in the same place as the verdict:

| Record | Value at staging time |
|---|---|
| Build the probe ran against | `a384e29fa` / build-id `58536e52` |
| Before/after row counts, per serve point | — |
| Distinct sessions | — |
| **Photo-provider state** | **Foursquare HTTP 429 (quota exhausted); Google live and carrying every card** |

### Why the provider state is recorded and what it does NOT mean

**It does not qualify the verdict.** Phase B's criterion is serve-point
reachability, not photo provenance. Whether a card's image came from Foursquare
or Google does not change whether the serve point logged.

The one case where it *would* have mattered is a 429 making a discovery path fail
outright and suppressing serve points that would otherwise log. **That was
checked before the probe rather than after, and it does not happen:**

- The transitive import closure of `routes/discovery.ts` — **50 modules** —
  contains **zero** references to `places-api.foursquare.com` or
  `FOURSQUARE_API_KEY`.
- The only FSQ mention in `discovery.ts` is `row.source.startsWith("fsq")` at
  `:652`, attribution on rows already in the DB. No network call.
- Photo lookup is client-initiated per card, against a different route, **after**
  the discovery response is sent and `logDiscoveryServe` has run.

**Record it so the measurement stays interpretable later** — so that a future
reader who finds a Phase B closure dated during an FSQ outage can see the
question was asked and answered, rather than overlooked. **Nobody should later
read a valid closure as contaminated, or an invalid one as clean.**

---

## How to read the result

**Exactly two legitimate outcomes**, per the roadmap:

| | Outcome |
|---|---|
| **1** | **Evidence closure** — discovery rows at **multiple** serve points. B3 met on its own terms. |
| **2** | **A newly discovered reachability or observability defect** — named, with evidence. |

> **"Probably low traffic" is NOT a third state.** One row at serve point 9 is
> the **failing** state — it is what the 14-minute probe already produced. A
> probe that returns few rows has either found a defect or has not yet been read;
> it has not produced a result.

**Two failure modes specific to this run:**

- **An empty window makes the report REFUSE a verdict. A thin non-empty window
  makes it RETURN one.** A handful of serves that all happened to be cache hits
  exits 0 and reads as *"cache A absorbs the traffic and personalisation rarely
  runs"* — the packet's central claim, apparently corroborated, when what was
  actually measured is that almost nobody could reach discovery. **A failure that
  returns a verdict is worse than one that refuses.**
- **CI going green is not proof of anything here**, and neither is the report
  exiting 0. Read the per-serve-point counts.

---

## Update the roadmap in the same session

Per the rails, the status table is maintained **in the same PR as the work**. On
completion, update:

- the **Status** table row for **B**
- **B3**, with the before/after figures and the provider state
- if outcome 2: file the defect and name it in the roadmap rather than leaving
  the probe looking inconclusive
