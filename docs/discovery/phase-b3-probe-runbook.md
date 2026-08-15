# Phase B3 probe — staged runbook

**Status: ⏸️ PARKED — 2026-08-15. Staged, authorised, and NEVER RUN.**

> Blocked on platform routing: Replit intercepts `/api/*` on the workspace dev
> domain and serves it from the local dev artifact regardless of what is bound
> underneath, so no same-origin proxy can put a browser session in front of
> production — and there is no deployed frontend. See `ROADMAP.md` →
> **Phase B — PARKED**.
>
> **The exit criterion remains unmet. Parking is not closure.** This document is
> kept intact — baseline, methodology, division of labour, conditions — because
> it is what makes the park cheap to reverse. **Do not build a new mechanism to
> get around the routing rule**; that is precisely the prerequisite chain the
> owner's ruling of 2026-08-15 ended.

Prepared 2026-08-15 by the agent session that verified the deploy. Every
precondition below was checked, not assumed.

Companion: `ROADMAP.md` → *Phase B — B3 — The repeat probe*, and
*DEPLOY VERIFIED CLEAN, 2026-08-15 12:13Z*.

---

## Division of labour — this is the point, not an implementation detail

| Role | Who | Does |
|---|---|---|
| **Observation** | the browser agent | Runs the probe. Reports **timestamps** (UTC start and end) and what it navigated. |
| **Verification** | a separate agent session | Queries production **independently** against the reported window and renders the verdict. |

**These stay in different hands.** An observer who also renders the verdict on
their own run is reporting, not verifying, and the Phase B result is worth
exactly as much as that separation.

> **This is why `--since`/`--until` exists.** The verifier must be able to
> address *the same window* the observer reported. The report previously offered
> only a rolling `--days N` with no upper bound, under which a before/after pair
> addresses two different windows and the delta silently conflates *rows the
> probe wrote* with *rows that rolled out from under the baseline*. A verifier
> who cannot address the observer's window is not independently checking the
> claim — they are producing a second, differently shaped claim and calling the
> pair agreement.

**The observer reports the window. The observer does not report the verdict.**

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

## The contamination question — ASKED AND ANSWERED before the probe, not after

**Condition on the authorisation, discharged 2026-08-15.** The probe runs while
Foursquare is returning HTTP 429 and Google is carrying every card. The question
that had to be settled first: *does the 429 make any discovery path fail outright
and suppress serve points that would otherwise log?* If it did, the measurement
would be genuinely contaminated rather than merely unusual, and this would hold.

**It does not. Both halves were checked.**

| Half | Check | Result |
|---|---|---|
| **Server** | Transitive import closure of `routes/discovery.ts` — **50 modules** | **Zero** reference `places-api.foursquare.com` or `FOURSQUARE_API_KEY`. The only FSQ mention in `discovery.ts` is `row.source.startsWith("fsq")` at `:652` — attribution on stored rows, no network call. **The 429 cannot suppress a serve-point write.** |
| **Client** | `useFsqPhoto` / `fsqPhotoLookup` / `photoProviderOutage` | `lookupFsqPhoto` **never throws** — returns null on any failure, so a 429 falls through to `lookupGooglePhoto`, which currently works. The chain is deferred 500 ms, non-blocking on list render, with a terminal `.catch(() => {})`. `foursquare_quota_exhausted` is classified as an **outage** reason and reported, not raised. |

**The client half matters specifically for a browser-driven probe**, and is the
half that is easy to miss: a card render that crashed on a failed photo lookup
would stop the agent navigating onward to further serve points, reducing
serve-point diversity *with no server-side failure at all*. That would look
exactly like an unreachable surface. It does not happen — but "the server never
calls Foursquare" would not have established that on its own.

**Proceed. Record the provider state (below); do not treat it as a qualifier.**

---

## What this writes to production

The probe writes `rank_events` rows, and those rows are the app logging its own
normal browsing — **indistinguishable from a real user opening Discovery**. It is
not a schema change, a deletion, or an irreversible policy edit. It is stated
here so the cost is a decision rather than a surprise, not because it needs a
gate.

The probe is an authenticated navigation session against production Discovery.
Its serves write:

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

## Step 1 — BEFORE baseline (read-only, run by the VERIFIER)

**Do not skip this.** Without a baseline, a post-probe reading cannot distinguish
rows the probe produced from rows that were already there. **A before/after pair
is the measurement; a single after-reading is an anecdote.**

The report refuses production by default and fails closed — that is the
`ciProdReadOnlyAuditGuard`, and it is load-bearing. It has a **sanctioned front
door** for exactly this case, which must be opened deliberately:

```bash
cd artifacts/api-server

# Note the UTC instant you run this. It is the lower bound of the probe window.
PORTAVA_PROD_READ_ONLY_AUDIT='read-only-audit-against-production' \
KNOWN_PROD_PROJECT_REF='ajrurzioarfkagpuxfnb' \
pnpm run report:discovery-serve-points -- --days 1 \
  | tee /tmp/b3-before-$(date -u +%Y%m%dT%H%M%SZ).txt
```

`--days 1` is the right flag **here**: the baseline question is "what was already
in the table", which is a rolling-window question. The **fixed** window is what
step 3 needs.

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

## METHODOLOGY DEVIATION — ruled 2026-08-15, and it belongs in the verdict

**There is no deployed frontend to browse.** The runbook's browser-hits-production
step could not be satisfied literally. The agent flagged the deviation and
offered options rather than substituting quietly, which was correct.

**RULED: run the frontend locally behind a LOCAL SAME-ORIGIN PROXY that forwards
`/api/*` to production server-to-server.** The browser talks to the local dev
server and nothing else.

> **This supersedes an earlier ruling in this document's history.** The first
> ruling was to point the local frontend straight at production and widen
> `ALLOWED_ORIGINS` to permit the dev origin. **That was reversed, and the reason
> is the finding it collided with:** production *already* auto-allows any
> subdomain of the multi-tenant parent `kirk.replit.dev` with
> `credentials: true` — see
> `../security/cors-dev-domain-allowlist-in-production.md`. Adding another
> permitted origin, in production, to make a test convenient, is **the wrong
> direction on a policy that needs tightening rather than loosening.**
>
> **No live production config change for a measurement.** The proxy achieves the
> same measurement with zero production change.

**The reasoning, which is the part that must survive.** Phase B measures
**server-side** behaviour: whether discovery serve points log rows when
exercised. Those serve points are api-server routes. **Which frontend served the
JavaScript does not change which route fires or whether it writes.** What matters
is that requests reach the production API and the production database, and the
proxy does exactly that — it changes the transport, not the routes.

**Registering and deploying `travel-buddy-standalone` as a real artifact was
explicitly REFUSED.** That is a new production surface and a publish, which is
the owner's trigger.

### The three conditions imposed with the ruling

| | Condition |
|---|---|
| **1** | The agent must **first confirm the local frontend is equivalent to the deployed build for serve-path purposes, and STOP if it is not.** Measuring a different client would make the result unreadable. |
| **2** | It must **document the exact env value used**, that **backend and database were production**, and that the **frontend was local**. |
| **3** | Everything else per this runbook **unchanged** — window not verdict, authenticated throughout, browse paths prioritised. |

### State the substitution PLAINLY in the verdict, not in a footnote

A reader six months from now needs to know **the client was local and the backend
was production**. That is exactly the kind of detail that turns a clean result
into a disputed one when it surfaces later instead of upfront.

---

## HOW TO RUN IT — the local same-origin proxy

**Why a proxy at all, in one measurement.** A local frontend talking straight to
production is cross-origin, and production does not accept every origin:

| Origin | Direct to production |
|---|---|
| `https://<id>.kirk.replit.dev` (**any** subdomain) | **200**, `ACAO` echoed |
| `http://localhost:3000` / `:8081` | **HTTP 500**, no `ACAO` |
| No `Origin` (server-to-server) | **200** |

> **This is the trap the phase exists to avoid, and the measurement would have
> introduced it.** Run the probe from `localhost` straight at production and
> every request 500s, zero rows are written, and the report shows an unexercised
> surface — **indistinguishable from the surface being unreachable.** It would
> read as a clean Phase B failure while being an artefact of the probe's own
> origin. Worse, it surfaces as a **500, not a CORS error**, so it looks like a
> server fault.

**The proxy removes the question rather than answering it.** The browser makes
only same-origin requests to the local dev server; the forward to production is
server-to-server and therefore carries **no `Origin` header at all** — the case
production already permits, with **no production change**.

```
browser ──same-origin──> proxy ──server-to-server──> production API
                           │
                           └────────────────────────> Metro dev server
```

### Verified, not assumed

Same `Origin: http://localhost:8097` header, two paths, measured 2026-08-15:

| Path | Result |
|---|---|
| Direct to production | **HTTP 500** |
| Through the proxy | **HTTP 200**, real Nominatim body |

### Run it

```bash
# terminal 1 — Metro. EXPO_PUBLIC_API_BASE_URL must be EMPTY: every call site
# reads `?? ''`, so empty makes the app issue same-origin RELATIVE /api requests.
cd travel-buddy-standalone
EXPO_PUBLIC_API_BASE_URL= pnpm exec expo start --web --port 8081

# terminal 2 — the proxy
node scripts/dev-same-origin-proxy.mjs \
  --api https://portava.replit.app --metro http://127.0.0.1:8081 --port 8090
```

**Open the app at `http://localhost:8090`** — the proxy — **not at Metro's port.**
Opening Metro directly means `/api` 404s and no rows are written.

The proxy logs every forwarded call as `[api] GET /api/... -> 200 (123ms)`.
**Keep that log: it is a client-side audit trail to set beside the server-side
row counts**, and it is how a serve point that was *attempted* can be told from
one that was never tried. It never logs header values, so an `Authorization`
bearer token cannot reach a terminal scrollback.

### Sanity check before navigating

```bash
curl -s -o /dev/null -w '%{http_code}\n' 'http://localhost:8090/api/places/search?q=Barcelona'
```

**Expect `200`.** A `502` means the proxy cannot reach production; a `404` means
you are pointed at Metro rather than the proxy. Either way **STOP** — that is
condition 1 failing, and rows collected afterwards are unreadable.

---

## Step 2 — The probe (run by the OBSERVER)

**Record and report these FIVE things. They are the observer's entire output:**

1. **`PROBE_START`** — UTC instant immediately before the first navigation,
   ISO-8601, e.g. `2026-08-15T14:02:00Z`.
2. **`PROBE_END`** — UTC instant immediately after the last navigation.
3. **What was navigated**, in enough detail to say which serve points were
   *attempted* — so that a serve point which produced no row can be told apart
   from one that was never exercised.
4. **The exact `EXPO_PUBLIC_API_BASE_URL` value used**, the **origin the
   frontend actually ran on**, and an explicit statement that **backend and
   database were production while the frontend was local** (condition 2 of the
   methodology ruling above).
5. **The proxy's `[api]` log** for the probe window — the client-side record of
   which routes were actually called and what they returned. This is what
   distinguishes a serve point that was *attempted and produced no row* from one
   that was *never exercised*, and the verifier cannot reconstruct it.

> **Report the window; do not report the verdict.** Whether the probe "worked" is
> the verifier's call, made against the table. An observer's impression that
> "Discovery loaded fine" is not evidence about serve points, and reporting it as
> though it were is exactly the coupling this split exists to prevent.
>
> **Widen `PROBE_START`/`PROBE_END` by a minute at each end** when reporting.
> `served_at` is written server-side and a boundary row lost to clock skew is a
> row the verifier will never see.

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

## Step 3 — AFTER reading and verdict (run by the VERIFIER)

**Two readings, and they answer different questions. Run both.**

**3a — the probe window itself.** This is the reading the verdict is rendered
from. Substitute the observer's reported instants:

```bash
cd artifacts/api-server

PORTAVA_PROD_READ_ONLY_AUDIT='read-only-audit-against-production' \
KNOWN_PROD_PROJECT_REF='ajrurzioarfkagpuxfnb' \
pnpm run report:discovery-serve-points -- \
  --since "$PROBE_START" --until "$PROBE_END" \
  | tee /tmp/b3-window.txt
```

**3b — the rolling day**, directly comparable to the step 1 baseline:

```bash
PORTAVA_PROD_READ_ONLY_AUDIT='read-only-audit-against-production' \
KNOWN_PROD_PROJECT_REF='ajrurzioarfkagpuxfnb' \
pnpm run report:discovery-serve-points -- --days 1 \
  | tee /tmp/b3-after.txt
```

> **Read 3a for the verdict, not 3b.** 3b's window has moved since the baseline —
> its lower bound rolled forward while the probe ran. The before/after pair is a
> **sanity check** that the two agree in direction; it is not the measurement.
> If 3a and 3b disagree in direction, **stop and say so** rather than picking the
> friendlier one.
>
> `--days` cannot be combined with `--since`/`--until`; the report refuses,
> deliberately. Two different windows asked for at once has no sensible
> precedence.

Then record **all** of the following alongside the verdict:

| Record | Value at staging time |
|---|---|
| Build the probe ran against | `a384e29fa` / build-id `58536e52` |
| `PROBE_START` / `PROBE_END` as reported by the observer | — |
| Per-serve-point counts **in the fixed window** (3a) | — |
| Distinct sessions | — |
| Rolling-day before/after (step 1 vs 3b), as a direction check | — |
| **Photo-provider state** | **Foursquare HTTP 429 (quota exhausted); Google live and carrying every card** |
| Serve points **attempted but not observed** | — (from the observer's navigation report) |

That last row is the one most easily lost, and it is the difference between *"the
surface is unreachable"* and *"nobody went there"*. **A serve point with no rows
means nothing until you know whether anyone tried it.**

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

---

## RECORDED READINGS

Committed rather than left in `/tmp`, which does not survive a container
restart — the same reason this file exists at all.

### Step 1 baseline — taken 2026-08-15T12:50:13Z, window `--days 1`

Read READ-ONLY against production `ajrurzioarfkagpuxfnb` through
`ciProdReadOnlyAuditGuard`. **The probe had NOT yet run at this point.**

| | |
|---|---|
| Marked rows in window | **13** |
| Distinct sessions | **4** |
| Serve points with rows | **1 of 9 — point 9 (Suggest) only** |
| Unexercised | **1, 2, 3, 4, 5, 6, 7, 8** |
| `GET /discovery` serves (points 1–6) | **0** |

```
  9  Suggest (GET /discovery/suggest)   13  100.0%   4 sessions
  ⚠ ONE serve point only (9). Phase B's exit criterion is rows at
    MULTIPLE serve points; one does not meet it, however many rows it has.
```

**This is the FAILING state, and that is what makes it a good baseline.** Phase
B's criterion is unmet at T-0 on the same instrument that will read the result,
so any serve-point diversity appearing in the probe window is attributable to the
probe rather than to background traffic.

**Zero `GET /discovery` serves in the preceding 24 hours** — so serve points 1–6
are all at a floor of zero going in. The 13 rows are entirely on `/suggest`,
which contains no ranker call.

**What this baseline does NOT say.** It does not say the surface is unreachable.
The instrument says so itself, and the distinction is the workstream's governing
invariant:

> *Unexercised is NOT the same as unreachable: nothing here can tell a surface
> nobody visited from one nobody could reach. Say which, or say neither.*

**Answering that is what the probe is for.** Sections 2b and 3 correctly declined
to render a verdict — *"That is not the criterion holding. It is the criterion
untested."* An instrument that had returned a confident zero here would have been
the failure mode this whole phase is built around.

### Environment at baseline

| | |
|---|---|
| Live build | `a384e29fa` / build-id `58536e52` — verified clean |
| Foursquare photo lookups | **HTTP 429, quota exhausted** |
| Google photo fallback | **live, carrying every card** |
| `/api/places/google-autocomplete` | **returning empty with a working key** (separate defect, unfiled) |

### Step 2 — observer's window

*Not yet run. Record `PROBE_START`, `PROBE_END`, and what was navigated here.*

### Step 3 — verifier's readings and verdict

*Not yet run.*
