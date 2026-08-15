# P1 Discovery — Roadmap

**Status: living document. Update it in the same PR as the work it describes.**

> ## ⚠️ ARCHITECTURAL REDIRECT — 2026-08-15, from the owner
>
> **The DESTINATION of the A–F sequence is SUPERSEDED. Its completed work is not.**
>
> **Discovery is no longer a ranking project. It is an EVIDENCE SYSTEM.**
>
> > Place Intelligence describes the world; Taste describes the traveller;
> > Context describes the moment; Candidate generation describes the available
> > choices; Ranking predicts the fit; Exploration determines what the system
> > still needs to learn; Event Truth tells it what actually happened.
> >
> > **Once those contracts exist the ranker becomes replaceable without
> > destroying the evidence beneath it.**
>
> ### The invariant — governing, alongside the statement above
>
> > **ABSENCE OF EVIDENCE MUST NEVER SILENTLY BECOME EVIDENCE OF ABSENCE.**
>
> **Phase B tests this in the current system. Event Truth must encode it
> permanently.** And it is not a new rule — it is the general form of two rules
> already in force here. **Three faces of one thing:**
>
> | Face | Where it shows up |
> |---|---|
> | **Vacuity is failure** | a check that examines nothing passes |
> | **Swallowed failures are first-class defects** | a failure that is caught and discarded looks like success |
> | **Absence of evidence ≠ evidence of absence** | a window with no rows reads as "it didn't happen" |
>
> In every one, **success is indistinguishable from not having worked.** Stated
> as one rule because it is one rule, and because each face was discovered
> separately at a cost that the general form would have avoided.
>
> #### The guard for face one has already earned its keep — 2026-08-15
>
> `artifacts/api-server/scripts/check-test-registration.mjs` fails CI when a
> `.test.ts` exists under `src/` but is not in the curated `test` script:
> *"they would silently never run."*
>
> In PR #64 it caught **`apiKeyEmptyVsAbsent.test.ts`** — a test written to make
> an empty-but-present API key distinguishable from an absent one. It passed
> locally, 11/11, and was registered in no CI job at all.
>
> **The commit whose entire purpose was making a silent failure observable
> shipped a test whose own result would have been silent.** The author was
> actively thinking about that exact failure mode and still missed it; the guard
> caught it.
>
> Recorded here because it will otherwise read later as a coincidence or a tidy
> anecdote. It is neither — it is the strongest available evidence that this
> guard, the registered-file count floor, and the ghost-path check are load
> bearing. **Do not soften them, allowlist around them, or treat a registration
> failure as paperwork.** Adding a test under `artifacts/api-server/src/` is not
> finished until it is in the `test` script; local green says nothing about
> whether CI runs it.
>
> Recorded verbatim as governing. What follows from it:
>
> | | |
> |---|---|
> | **Phase B** | **THE IMMEDIATE GATE.** *"Fix exists"* is not *"surface proven."* Exit criterion stays authoritative and **unmet**. |
> | **Phases A–D** | **LAND AS PLANNED**, including Phase B's criterion. Verified infrastructure is not discarded because the destination moved. |
> | **Phases E and F** | **FROZEN.** Do not continue them because they were next. |
> | Anything assuming the six P1 components are **peer scoring systems** | **STALE** — must be re-scoped before implementation. |
> | **Workstream S** | continues — it is orthogonal to the destination. |
>
> The new sequence is **[The superseding sequence](#the-superseding-sequence)**.
> The A–F phases below are kept for the record and for the work still in flight.

## Why this file exists

Sessions working on this die to container restarts without warning. A plan that
lives only in a chat transcript dies with it, and the next session reconstructs
it from commit messages — badly, and differently each time.

So this is the durable artifact. It is the answer to "what is this, where did it
get to, and what happens next" for anyone — human or agent — arriving cold.

**How to use it:** read the four constraints, read the status table, open the
first phase that is not `DONE`, and start at its entry criteria. Every phase
states what must be true before it starts, what must be true before it is
finished, and how that is verified. A phase whose exit criterion cannot be
satisfied is **declared blocked and skipped** — never quietly softened.

Companion documents:

| | |
|---|---|
| `discovery-engine-mode-packet.html` | the design, the eight D1–D8 rulings, and the operator-actions record |
| `discovery-engine-ruling-sheet.html` | the owner's decision sheet as presented |
| `phase-minus-1-repository-proof.md` | repository proof of the carried-in claims at HEAD |
| `phase-b3-probe-runbook.md` | **the staged B3 probe** — exact commands, the sanctioned read-only front door for the production baseline, the production writes it incurs, and what to record. **STAGED, NOT RUN; the owner presses it** |
| `../migrations.md` | applied/staged migration state, and what `audit:schema` can and cannot establish |
| `../ops/retention-policy.md` | the 90-day window covering `discovery_shadow_serves`. **Event Truth's classes are ruled separately** — packet §7 — and this document is amended when Event Truth is implemented, not before |

---

## The four constraints that shape everything

Read these before planning anything. Three of the four are about the world
rather than the code, and every one of them has already changed a decision.

### 1. The app is PRE-LAUNCH

17 posts, 0 places, no organic traffic. `rank_events` serves since the
instrumentation clock started: **0**. Distinct users: **0**.

**Consequence:** any exit criterion that is a measurement over real traffic is
blocked on **launch**, not on engineering. Such work is **built ready-to-run and
not run**. A measurement taken over an empty window is not a weak measurement —
it is not a measurement, and the tooling must refuse to render a verdict on one
rather than return a confident zero.

This is also why the D5 revisit clause was resolved on structural grounds with
the empirical check explicitly **deferred and NOT satisfied**. Synthetic traffic
was considered and **rejected**: Cache A fronts a rate-limited external
dependency (Overpass), operator-designed traffic cannot answer a real-world
hit-rate question without circularity, and it would pollute production
`rank_events` for the full 90-day retention.

### 2. The discovery surface is BARELY REACHABLE in the current build

A 14-minute live probe produced **exactly ONE** `surface='discovery'` row, out of
464 rank rows that hour (270 pulse, 189 compass, 4 live_pulse). It also surfaced
**CORS-blocked `places-api.foursquare.com` calls** and a **navigation bug**
(Nightlife detail lands on `/passport`).

**Consequence, and it is sharper than it looks.** An empty window makes
`report:discovery-serve-points` *refuse* a verdict. A **thin non-empty** window
makes it *return* one — a handful of serves that all happened to be cache hits
exits 0 and reads as *"Cache A absorbs the traffic and personalisation rarely
runs"*, the packet's central claim, apparently corroborated, when what was
actually measured is that almost nobody could reach discovery.

**A failure that returns a verdict is worse than one that refuses, because
nothing about it looks wrong.** This is why Phase B ranks ahead of every other
piece of engineering: measurement infrastructure over an unreachable surface
produces confident wrong answers, not missing ones.

### 3. The caches are IN SERIES, not a fork

`routes/discovery.ts`: Cache A is checked at `:1113` and returns **before** the
Compass block at `:1211`. Cache A's key is `(destination, category, radiusKm)` —
**user-independent** — with a **2-hour TTL**, and on a cold fetch the *unranked*
OSM list is written to it while the ranked output goes only to the requesting
user's Cache B entry.

**Consequence:** for a given key the ranker runs at most once per two hours and
its output reaches exactly **one user**. Everyone else receives the raw Overpass
order. A flag that merely wrapped the ranker would switch an engine that almost
no request reaches — which is precisely the failure the owner directive names.

This is the defect D5=B exists to fix, and it is a statement about control flow:
**true at any traffic volume, including zero.**

### 4. `rank_events` is mutable state with a client-input surface

Outcomes arrive from clients and UPDATE existing rows (`routes/rankEvents.ts`).
One contaminated row corrupting the comparison funnel is disqualifying — which
is why D7=A put shadow data in its own append-only table.

**And the trap that is easy to miss:** `DiscoveryRankingService.rankItems` writes
its **own** `rank_events` rows — `writeRankAnalyticAsync` at `:768/:867/:879/:888`,
an eligible and a scored row per candidate — **whenever it is handed a client**,
and nothing at the calling layer can ask it not to. A 15-place run writes 30 rows.

**Consequence:** any code path that computes a ranking whose result no user
receives must be handed a client that **cannot write**, not merely be careful
about its own writes. `rankForViewer(..., { served: false })` does this
(`lib/discoveryPde.ts`), and records the intercepted count so the guard stays
observable rather than assumed.

---

## Rails

Non-negotiable, and unchanged across the whole roadmap.

- **Worktree isolation.** Every change in its own git worktree.
- **PR flow.** Branch → PR → three green verdict sets → `gh pr merge N --merge --admin`.
- **Commit and push every step.** The container restarts without warning; work
  that exists only in a worktree is work that will be lost.
- **Production writes are staged for the operator**, with before/after
  verification. Never applied by the agent.
- **Behaviour-preserving at introduction.** Every stage lands inert. Mode stays
  `legacy`, cohort stays nobody, and nothing a user receives changes.
- **Migrations must be applied to BOTH projects.** CI's `schema drift` job runs
  against the sanctioned CI project (`hwokxgbmezheskbzskfr`), never production
  (`ajrurzioarfkagpuxfnb`) — the read-only guard refuses production inside CI by
  design. A production-only apply leaves CI red in a way that looks identical to
  no apply at all.

### Working discipline

These are the habits that have caught real defects on this workstream. They are
listed because each one caught something.

- **Enumerate populations, do not estimate them.** "1 of 464 rows" is a finding;
  "discovery traffic seems low" is not.
- **Red-proof with a positive control.** A guard asserting "nothing was written"
  passes trivially against a pipeline that stopped doing anything. Pair it with
  a run that *does* write. (This is test `D2` in `discoveryPde.test.ts`.)
- **Vacuity is failure.** An empty check set, a zero-row window, a suppressed
  claim — each must exit non-zero or refuse a verdict, never pass quietly.
- **Flag your own errors rather than quietly fixing them.** Two examples worth
  keeping: the claim that `audit:schema` "compares objects, not privileges" was
  wrong and *load-bearing* — the wrong version prescribed a fix that would have
  left the real gap open while looking addressed. And
  `auditShadowAppendOnly.ts` shipped asserting 2092's two triggers but not
  2093's TRUNCATE trigger — the same defect it exists to catch, committed by the
  catcher.
- **A migration comment asserting a constraint is not a constraint.** Either the
  live catalog is asserted against directly, or the claim is decoration. `2092`
  claimed `service_role` held INSERT and SELECT "and nothing else"; the catalog
  held all seven privileges for a day.

---

## Status

| Phase | Name | Status |
|---|---|---|
| **A** | Land Stage 2 | **DONE** — PR #50 merged 2026-08-15, 26/26 green |
| **B** | Make discovery reachable | **BLOCKED — awaiting the B3 probe ONLY.** The deploy precondition is **MET**: build `a384e29fa` (build-id `58536e52`) was verified clean and live 2026-08-15 12:13Z, carrying #55/#56 — verified in the *running* build, not merely published. Exit criterion (rows at multiple serve points) **still unmet**; nothing has been measured in either direction. PR #54's ruling governs and stands. It is **NOT** blocked on Google SSO — see the correction below; that conflation was mine, not #54's. **The B3 probe has NOT been run.** When it is, **record the photo-provider state alongside the result** (FSQ 429 / Google live as of 12:13Z) — it does not affect serve-point logging, and the check establishing that is recorded below. |
| **C** | Complete shadow coverage | NOT STARTED |
| **D** | D5=B engine split | NOT STARTED |
| **E** | Measurement readiness | ❄️ **FROZEN** — superseded destination |
| **F** | Owner gates | ❄️ **FROZEN** + **NOT AGENT WORK**. The two gates still stand absolutely. |

> **Maintain this table in the same PR as the work.** A status table that is
> updated separately is a status table that is wrong. Use `DONE`, `IN PROGRESS`,
> `BLOCKED — <reason>`, or `NOT STARTED`.

### Landed 2026-08-15 — the Phase B unblock

Four PRs, in the order they had to land:

| PR | What | Why it was on the critical path |
|---|---|---|
| **#57** | RLS fixture made idempotent | **The unblock.** Every live-DB run in the repo was red, on every branch, including PRs touching no server code. |
| **#58** | Serve-point report fixed | **The instrument.** It rendered the Phase B verdict and was misreporting live instrumentation as absent. See the B3 warning. |
| **#55** | #3658 — false "Couldn't verify your account" wall | Blocked reaching `/discovery` at all on an authenticated session. |
| **#56** | #3657 guard rewritten | The 3642 guard was green and *could not* have caught 3657. |

> ### CORRECTION, 2026-08-15 — this paragraph was wrong when first written
>
> An earlier revision of this section (PR #59, mine) said Phase B was
> *"**BLOCKED** on an authentication prerequisite — the Google provider is not
> enabled in Supabase"*, and that the four PRs *"do not unblock Phase B"*.
>
> **That equated two things PR #54 explicitly separates, and #54 is right.**
> #54's own words: *"It must NOT be repaired inside Phase B to get the probe
> through. **Google auth is not part of Phase B's acceptance criteria**"*, and it
> anticipates *"collecting Discovery evidence **by another route**"*. #54 never
> named Google as Phase B's blocker. The blocker it recorded is narrower and
> plainer: **no authenticated session had been obtained, so the probe never
> ran.** The Google-provider conflation was introduced downstream of #54, in
> this file, by me — not by the ruling.
>
> **Checked against the B3 spec rather than against the summary:** B3's exit
> criterion is *"a repeat probe produces discovery rows at MULTIPLE serve
> points"*, verified by `report:discovery-serve-points`. Phase B's entry is
> *"Phase A merged."* **Neither names an authentication method.** What B3 needs
> is an authenticated session; it is indifferent to how one was obtained.
>
> Two facts established since #54 was written:
>
> | | |
> |---|---|
> | The QA account authenticates by **email and password**, and a partial probe already ran that way | so a session is obtainable without Google |
> | **#3681** — headless automation can never complete real Google OAuth; Google blocks it structurally | so Google Sign-In is **unverifiable by automated test regardless**, and waiting on it would be waiting on something that cannot arrive |
>
> **#55 is therefore not merely an engineering blocker.** #3658's false
> *"Couldn't verify your account"* wall is what cut the password-authenticated
> probe short. Fixing it removes the barrier that actually stopped the probe.
>
> **What follows, precisely — and it is narrower than "Phase B is unblocked":**
> the exit criterion is **still unmet**, and blockage is still not closure. What
> changed is *what it is waiting on*. It is waiting on **a deploy carrying #55
> and #56, and then a probe** — not on a Supabase dashboard toggle. The
> currently deployed build contains neither fix, so no probe run before that
> deploy can close Phase B either.
>
> **Google SSO remains a real, separate, confirmed defect** (#54 §2, and
> `docs/auth/google-sso-provider-not-enabled.md`). Nothing here repairs it or
> reduces its priority. It is simply not what Phase B was ever gated on.

**The four PRs are engineering fixes. #57 and #58 unblock CI and the
instrument; #55 removes the wall that stopped the probe; #56 makes a guard able
to fail.** None of them is Phase B *evidence* — per #54 §3, an agent that
authenticates and navigates has reached the **starting line**. Phase B closes on
discovery rows at multiple serve points and on nothing else.

### DEPLOY VERIFIED CLEAN, 2026-08-15 12:13Z — the precondition above is now MET

The paragraph above ends: *"It is waiting on a deploy carrying #55 and #56, and
then a probe... The currently deployed build contains neither fix."* **That is
no longer true.** The deploy half is satisfied. The probe half is not, and
nothing here closes Phase B.

#### What happened, in order

| Time (UTC) | Event |
|---|---|
| 11:23:13 | **Publish `d43b2fb3a`** — tree `bf16e88d`, **byte-identical to `cd1f4e1bb`**. This shipped the unreviewed drift. |
| 11:23:47 | **Revert `87e245786`** — 34 seconds later. Five local commits reverted with history intact; all five preserved on `wip/discovery-photo-cache-lru`. |
| 11:30–11:39 | #63, #64 merge; branch reconciled. |
| 11:55:17 | **Publish `a384e29fa`** — build-id `58536e52-de91-4ce1-b1d9-1a91fc2e7813`, tree `2014ada7`, **byte-identical to `origin/bughunt-20260805`**. |

**The drift was live for roughly 32 minutes.** It is worth stating what that
means rather than only that it happened — see the fallback-chain finding below.

#### How "clean" was established — and why git alone was not enough

Git proves which commit was *published*. It cannot prove which build the
autoscale instances are *running*. Both were checked, and they agree.

| Method | Evidence |
|---|---|
| **Git** | `tree(a384e29fa) == tree(origin/bughunt-20260805) == tree(HEAD)` = `2014ada7`. #55, #56, #57, #58, #61, #62, #63, #64 all in history. |
| **Live, decisive** | `GET /api/places/photo` on production returns a **`places.googleapis.com/v1/places/{id}/photos/{ref}/media`** URL. That construction exists **only** in the clean tree (`places.ts:510`). The drift's `/places/photo` calls `places-api.foursquare.com` and **cannot emit that shape** under any input. |
| **Live, corroborating** | `/api/places/fsq-photo` returns the wire string `foursquare_quota_exhausted`, introduced by **#61** (`9b9b120da`). So the running build is at or past #61 — and #55, #56, #57, #58 are all ancestors of #61. |

**Method note for whoever verifies a deploy next.** The useful discriminator was
not a version endpoint — `/api/healthz` returns `{"status":"ok"}` and nothing
else. It was **a wire string that only one of the two candidate trees can
produce.** Pick a response value the other tree is structurally incapable of
emitting, not one that merely differs in likelihood.

#### Google is no longer SERVICE_DISABLED

Places API (New) enablement was blocked on billing activation. **That cleared.**

- `/api/places/photo` returned real photo URLs for **5 of 5** distinct places
  (Eiffel Tower, Sagrada Família, Park Güell, Colosseum, Tokyo Tower), each a
  different Google place ID.
- One media URL was followed end-to-end: **HTTP 200, `image/jpeg`, 135,854 bytes.**

The route reads **`GOOGLE_MAPS_API_KEY`**, which is the only name the repository
uses. **`GOOGLE_PLACES_API_KEY` is referenced nowhere as a `process.env` read** —
only in a comment at `places.ts:444` and a test docstring. A secret provisioned
under that name is **inert by design, not broken**, and #64 exists so that this
class of thing reports itself honestly.

#### Foursquare is quota-exhausted — and this is why the revert was load-bearing

`/api/places/fsq-photo` returns `foursquare_quota_exhausted` (**HTTP 429**)
uniformly, on every place tried. FSQ is the **primary** photo provider; Google is
the **fallback**. Right now every Discovery place card is carried entirely by the
Google fallback.

> **The drift replaced the Google fallback with a second Foursquare call —
> collapsing the chain to FSQ → FSQ.** Had it stayed live into the 429, both
> links of a two-provider chain would have been the same exhausted provider, and
> Discovery would have had **no working photo provider at all**. The two faults
> are independent and neither is visible from the other; they compose into an
> outage. The revert was not hygiene.
>
> This is the fallback-chain form of the governing invariant. A fallback that
> calls the same provider as the primary is **absence of redundancy presenting as
> redundancy** — it looks like a chain and is a single point of failure.

#### The provider state does NOT contaminate Phase B — established, not assumed

It is tempting to read "unusual provider state" as a reason to withhold Phase B
closure. **It is not**, and the distinction matters in both directions.

**Phase B's exit criterion is discovery rows at MULTIPLE serve points. That is
about instrumentation reachability, not photo provenance.** Whether a card's
image came from Foursquare or Google does not change whether the serve point
logged.

The one case where it *would* genuinely matter is if the 429 made a discovery
path fail outright and suppress serve points that would otherwise log. **That was
checked before the probe rather than after, and it does not happen:**

| Check | Result |
|---|---|
| Transitive import closure of `routes/discovery.ts` — **50 modules** | **Zero** reference `places-api.foursquare.com` or `FOURSQUARE_API_KEY`. |
| Only FSQ mention in `discovery.ts` | `row.source.startsWith("fsq")` at `:652` — attribution on rows already in the DB. **No network call.** |
| Where photo lookup actually happens | A separate client-initiated call per card, against `/api/places/fsq-photo`, **after** the discovery response is sent and `logDiscoveryServe` has run. |

**The discovery serve path makes no Foursquare call. The 429 cannot suppress a
serve point.**

**So: record the provider state alongside the probe result, do not treat it as a
blocker.** The reason to record it is that a probe run today is a measurement
taken while FSQ was at 429 and Google was carrying every card, and a later reader
with no note will not know that. **Recorded so that nobody later reads a valid
Phase B closure as contaminated, or an invalid one as clean.**

#### Separate live defect found while verifying — Google autocomplete returns nothing

`GET /api/places/google-autocomplete?input=Barcelona&type=city` returns
`{"places":[],"powered_by":"google"}`. The key is present and demonstrably
working (the photo route proves it), so this is the **legacy**
`maps.googleapis.com` Places Autocomplete endpoint returning non-OK or a non-`OK`
status body. **Places API (New) is enabled; the legacy Places API apparently is
not.**

This is a **user-facing defect in destination search**, and it is **not** caused
by the drift — the clean tree is correctly on the legacy endpoint, and the drift
is the tree that moved *off* it. `places.ts:289` documents the route as
degrading to an empty list on non-OK, which is honest but silent: the caller
cannot distinguish "no such city" from "the API is off". **Not yet filed. It is
its own defect and does not belong to Phase B.**

#### Phase B status after all of the above

| | |
|---|---|
| Deploy carrying #55 and #56 | **MET** — verified in the running build, not merely published |
| Probe producing discovery rows at multiple serve points | **UNMET** |
| Phase B | **still OPEN.** Blockage was never closure, and neither is a satisfied precondition. |

#### Open PRs as of 2026-08-15 12:15Z

Recorded because a red PR with no note reads, to the next session, as work that
was abandoned rather than work whose redness *is* the result.

| PR | Checks | Reading |
|---|---|---|
| **#65** — REVIEW ONLY, cd1f4e1bb replaces the Google fallback with a second FSQ call | 31 pass / **11 fail** | **Leave open. Do not merge.** It targets `review/photo-cache-base`, not trunk. **The red is the finding**: the drift does not pass CI, which corroborates reverting it rather than reviewing it in place. Merging it would re-introduce the FSQ → FSQ collapse described above. |
| **#60** — FSQ photo liveness + URI-change reload | 26 pass / **6 fail**, CONFLICTING | **Close as superseded.** Self-titled *"RED, do not merge as-is"*. Its intent shipped via **#61** (audible provider failure) and **#62** (liveness check + caching). |
| **#54** — Phase B is BLOCKED (authentication prerequisite) | **32/32 green**, CONFLICTING | **Owner's.** ⚠️ **Partly stale after #63.** #54's core separation was *correct* and #63 affirms it — but #54 is still open against a tree whose Phase B section now records the opposite status. Its blocked-on-authentication framing has been overtaken: the wall is fixed (#55), the deploy is verified, and only the probe remains. |
| **#52** — Phase B1 + C0, server-side FSQ proxy | **26/26 green**, CONFLICTING, +1857/−148 | **Owner's.** Overlaps substantially with what landed via #61/#62; the server-side FSQ proxy exists in trunk now. Needs a scope re-read against current trunk before it can be merged or closed. |

**Three things the next session must not misread:**

1. **CI going green is not proof #57 worked.** The fixture collision was a race
   between two `live-db.yml` runs on the same commit (`push` + `pull_request`);
   it clears on its own and recurs. #57 stops a crashed run *poisoning* the
   project permanently — it does **not** make the suite concurrency-safe, and
   #57 says so in place rather than implying otherwise.
2. **`dismissedByBack` in `discovery.tsx` is not covered by any test.** Removing
   it leaves all five back-nav tests green. That is recorded in the test file's
   header as a finding about the fix, not a gap to be papered over: the branch it
   guards is unreachable in every sequence that can be modelled. Independently
   re-verified 2026-08-15. **Do not manufacture a scenario to turn it red.**

---

## The superseding sequence

**Governing from 2026-08-15.** Steps 2–10 replace the destination that A–F was
heading toward. Step 1 is the A–D work already in flight.

### The design constraint that decides Event Truth's shape

**Do NOT duplicate every viable candidate on every request — that becomes
enormous.** Instead, make the recommendation request a **first-class object**:

- a **`discovery_session` / `ranking_run`** capturing context and **candidate-set
  identity**;
- **candidate evaluations** recording eligibility, viability and scores *against
  that run*;
- **user events** referencing the **served recommendation**.

That preserves the counterfactual **without a giant JSON snapshot per
impression**.

### The steps

| # | Unit | Note |
|---|---|---|
| **1** | **Land the in-flight harness — A–D** | Including Phase B's unmet probe criterion |
| **2** | **EVENT TRUTH** | Sessions/runs, candidate viability, exposures, interactions, strong outcomes, attribution, context snapshots, stable IDs, **append-only**, able to **reconstruct opportunity** |
| **3** | **PLACE INTELLIGENCE v1 + VISIBLE CARDS** | Fixed experiential taxonomy, richer cards, *"Why this place"*. **Ships user-visible value — not merely ranker input** |
| **4** | **TASTE BOOTSTRAP** | Visual onboarding using **contrasting sets**, not isolated binaries. **Stop early when uncertainty drops.** Archetype priors |
| **5** | **PORTABLE TASTE** | Learned across destinations from **strong events**, with confidence **per taste dimension** |
| **6** | **CANDIDATE GENERATION** | |
| **7** | **CONTEXTUAL RANKING** | **Taste as the spine**; graph, behaviour, trails and **capped `local_momentum` as modifiers only** |
| **8** | **GOVERNOR** | Exploration and diversity **allocator** — budget ~**15–25 %** with **reason codes**, *not fixed positions* |
| **9** | **LEARNED RESIDUAL** | **Only after trustworthy outcomes exist.** It must **improve the explicit model**, and an **unexplainable high-confidence prediction must CONSTRAIN how aggressively it is exploited** |
| **10** | **OPTIMISE AGAINST TRIP OUTCOMES** | |

### The execution sequence — locked

1. **Phase B evidence closure** ← *immediate gate*
2. Remaining **A–D** exit criteria
3. **Event Truth schema packet** *(written — must now also pass the `verified_visit` test; retention **ruled** 2026-08-15 and folded in as packet §7)*
4. **Event Truth implementation**
5. **Place Intelligence**

**E and F stay frozen.**

### Why Phase B gates the whole architecture, not just Phase C

The next architecture **assumes instrumentation can distinguish absence of
behaviour from absence of observation.** That assumption is load-bearing for
every step after it.

**If Phase B cannot demonstrate that distinction in the CURRENT system, Event
Truth cannot be trusted to encode it into the new one.** A team that has never
once separated "nobody did this" from "we did not see it" will build a schema
that cannot separate them either.

So: **zero or suspiciously thin probe output is an INVESTIGATION RESULT, not a
successful low-traffic result.** It does not close Phase B. It opens a
question.

#### When the probe finishes there are exactly TWO legitimate outcomes

| | Outcome |
|---|---|
| **1** | **Evidence closure** — discovery rows at **multiple** serve points, the B3 criterion met on its own terms |
| **2** | **A newly discovered reachability or observability defect** — named, with evidence |

> **"Probably low traffic" is NOT a third state.** It is the shape a thin window
> takes when nobody looks at it hard, and it is indistinguishable from a broken
> surface by construction — which is the exact confusion the governing invariant
> forbids. A probe that returns few rows has either found a defect or has not yet
> been read; it has not produced a result.

**Schema work is not a reason to relax this.** Event Truth being designed, ruled
on, or ready does not advance Phase B by one row, and the gate is unchanged by
anything in the packet.

### Step 2 is GATED

**Before any migration**, Event Truth requires a **schema design packet**
answering one counterfactual explicitly:

> Given a recommendation made **six months ago**, can we reconstruct
> **what the traveller saw**, **what viable alternatives existed**, **why each
> candidate was considered or removed**, **what context existed**, and **what the
> traveller eventually did**?

**If it cannot, say so rather than building it.**

→ **`event-truth-schema-packet.md`** — written, and its verdict on the *current*
system is **NO, on five independent grounds**.

**The retention question the packet escalated is RULED** (owner, 2026-08-15;
packet §7). It is **not** a longer global window, and that is the half most
likely to be misremembered:

| | |
|---|---|
| **The six-month counterfactual STAYS** | Travel feedback is delayed and episodic; the strongest downstream evidence often arrives long after the recommendation. A 90-day window would make the system **forget evidence before it has enough longitudinal behaviour to evaluate itself** |
| **Discovery decision evidence** | **12 months** |
| **Raw sensitive context** | **shortest practical — ≤ 90 days preferred** |
| **Derived non-sensitive evidence** | **12 months or longer where justified** |
| **The principle** | **Preserve the decision evidence, not every sensitive input that produced it.** Precise location is never retained because ranking analytics would benefit |
| **And it redefines reproducibility** | After evidence expires, reproducing the **historical decision** — *policy v2 evaluated classes A and B on date X and concluded verified=true at confidence Y* — never a claim that the computation can be rerun |

**This closes a policy gap, not a schema gap.** Both acceptance tests still
answer **NO** on the current system, and step 2 remains gated behind Phase B.

---

## Phase A — Land Stage 2  ·  *(A–F: destination superseded; A–D still land)*

Shadow observation exists, is wired to the Cache A serve points, writes to an
append-only table, and is gated by the D6 cohort.

**Entry:** Stage 0 (instrumentation) and Stage 1 (the dispatch above the cache
fork) live; the PDE engine merged.

**Steps**

1. `lib/discoveryShadow.ts` — comparison + write. Compares **served pages**, not
   full ranked lists: a reordering below the fold changed nothing anybody saw.
2. Wire serve points 1–3 (`serveCachedPlaces`), after `res.json()`.
3. Migration `2092` — `discovery_shadow_serves`, append-only per D7=A.
4. Migration `2093` — repair the grants `2092` claimed but did not make.
5. Migration `2094` — `cohort_reason` / `cohort_bucket`.
6. `lib/discoveryCohort.ts` — the D6 gate.
7. `audit:shadow-append-only` — assert the exact privilege set against the live
   catalog.

**Exit**

- [x] All three migrations applied to **both** projects.
- [x] `audit:schema` exit 0 on both.
- [x] `audit:shadow-append-only` exit 0 on both — `service_role` exactly
      `INSERT, SELECT`; `anon`/`authenticated` nothing; RLS on; 3/3 triggers.
- [x] PR #50 green (26/26) and merged 2026-08-15.

**Verification**

```bash
pnpm run audit:schema                 # 280 files, 4063 claimed objects, none missing
pnpm run audit:shadow-append-only     # exact privilege set, RLS, all three triggers
```

Both must be run against **both** projects. Against a project lacking the table,
`audit:shadow-append-only` exits **2**, not 1 — absence and a wrong privilege set
are different findings and must not be conflated.

---

## Phase B — Make discovery reachable

**Ranked first among engineering work.** Every later measurement is worthless
without it, and worse than worthless: it returns confident wrong answers rather
than refusing.

**Entry:** Phase A merged.

### B1 — Foursquare CORS

**What is known from the code, at HEAD:**

`travel-buddy-standalone/src/services/fsqPhotoLookup.ts:48` calls
`https://places-api.foursquare.com/places/search` **directly from the client**,
authenticated with `EXPO_PUBLIC_FOURSQUARE_API_KEY`.

Two separate problems, and the second is the more serious:

1. On web that is a cross-origin request to an API that does not serve browser
   CORS headers. It cannot succeed, and it fails on every place card.
2. **`EXPO_PUBLIC_*` ships to the client bundle.** A Foursquare API key is being
   handed to every browser that loads the app. The header comment calls it
   "already public"; that is a description of the leak, not a justification.

**The server already has everything needed.**
`artifacts/api-server/src/lib/foursquarePlaces.ts` calls the *same* endpoint with
a server-held `FOURSQUARE_API_KEY` (`:35`), same API version (`:15`). A
`GET /places/photo` endpoint already exists (`routes/places.ts:430`) but is
**Google-backed**, so it is a sibling rather than a drop-in.

**Steps**

1. Add a server endpoint that proxies FSQ photo lookup by `name` + `lat`/`lng`,
   reusing `lib/foursquarePlaces.ts`. Match the shape and error semantics of
   `/places/photo`: a missing key returns `{ photoUrl: null, reason: ... }`
   rather than an error.
2. Point `fsqPhotoLookup.ts` at it. Keep the client-side memory cache, the
   in-flight dedup, and the silent-failure contract — all three are correct and
   none of them is the bug.
3. **Remove `EXPO_PUBLIC_FOURSQUARE_API_KEY` from the client path** and record
   the key rotation as an operator action. A key that has shipped in a bundle is
   compromised regardless of what the code does next.
4. Preserve the "Powered by Foursquare" attribution requirement
   (`FSQ_ATTRIBUTION`, `lib/fsq/fsqPlaces.ts:12`) — it is an API-terms obligation
   and it applies wherever the photo is displayed, not wherever it is fetched.

**Exit:** no browser request to any `foursquare.com` host; place cards resolve
photos through the server; no Foursquare key in the client bundle.

**Verification:** grep the built client bundle for `foursquare.com` and for the
key name — both absent. Unit tests for the new endpoint including the
no-key-configured path. `fsqPhotoLookup`'s existing tests updated to assert the
proxy URL rather than the Foursquare URL.

### B2 — The navigation bug

**Reported:** Nightlife detail lands on `/passport`.

**Not yet diagnosed, and this roadmap will not pretend otherwise.** What is known
of the route surface: `travel-buddy-standalone/app/place/[id].tsx` exists
alongside a `app/place/[id]/` directory containing `day.tsx` and `moments.tsx`.
That is a legal expo-router shape, so it is a lead and not a conclusion.

**Steps**

1. Reproduce, and capture the *actual* navigation target — the `pathname` and
   `params` passed, not the screen that ends up rendered. Those differ, and the
   difference is the bug.
2. Establish whether it is category-specific (Nightlife only) or general to
   place detail. **This is the branch point:** category-specific points at the
   category → route mapping; general points at route resolution or a guard
   redirect.
3. Check for an auth or onboarding guard redirecting to `/passport`. A fallback
   redirect that fires on an unresolvable route is a common shape for exactly
   this symptom, and it would explain why the landing screen is unrelated to the
   requested one.
4. Fix, with a component test pinning the navigation target.

**Exit:** Nightlife place detail opens place detail. A test fails if the target
regresses.

### B3 — The repeat probe

**Exit criterion for the whole phase, and the operator's stated bar:** a repeat
probe produces discovery rows at **MULTIPLE serve points** — not one.

**Verification**

```bash
pnpm run report:discovery-serve-points -- --days 1
```

Read against the serve-point table. **One row at serve point 9 is the FAILING
state** — it is what the 14-minute probe already produced. Success means several
distinct serve points appear, which demonstrates that the discovery surface is
navigable rather than that one endpoint responds.

> **Entry state as of 2026-08-15 12:13Z — this probe is now RUNNABLE.** The
> deploy precondition is met: the live build was verified clean and carries
> #55/#56. See *DEPLOY VERIFIED CLEAN* above. The probe has not been run.
>
> → **Staged runbook: `phase-b3-probe-runbook.md`.** Exact commands, the
> sanctioned read-only front door for the production baseline, the production
> writes the probe incurs, and what to record. **The owner presses it.**
>
> **Run `--days 1` BEFORE the probe as well as after.** The before-run is the
> baseline; without it a post-probe reading cannot distinguish rows the probe
> produced from rows that were already there. A before/after pair is the
> measurement — a single after-reading is an anecdote.
>
> **Record the photo-provider state with the result.** At the time of writing,
> Foursquare is returning **HTTP 429** on every photo lookup and Google is
> carrying every card. This does **not** affect serve-point logging — the
> transitive import closure of `routes/discovery.ts` (50 modules) contains no
> Foursquare call site, and photo lookup happens client-side per card after the
> discovery response is already sent. **The state is recorded so the measurement
> stays interpretable later, not because it qualifies the verdict.** A future
> reader who finds a Phase B closure dated during an FSQ outage must be able to
> see that the question was asked and answered rather than overlooked.

> **The instrument that renders this verdict was itself broken until
> 2026-08-15 (PR #58).** It bounded `servePoint` to 1..6 while the writer had
> grown to 9, so it reported the five real, marked, post-Stage-0b production
> rows as *"rows that predate Stage 0"* and printed **"the instrumentation was
> not enabled during this window"** when it demonstrably was. A Phase B verdict
> read before that fix would have been a false negative indistinguishable from
> absence of observation — the governing invariant violated inside the ruler
> rather than the thing measured.
>
> **Do not read a Phase B verdict from a build predating `a015c3a76`.** The
> fixed reader is red-proofed against those exact production rows
> (`discoveryServePointReport.test.ts`); reintroducing the 1..6 bound turns 9 of
> its 13 tests red.

**If B2 cannot be reproduced:** say so, record what was tried, and proceed to
Phase C. Do not fabricate a fix for a bug that cannot be shown to exist.

---

## Phase C — Complete shadow coverage

**Entry:** Phase B exit met, or explicitly declared blocked.

### C1 — Serve points 4–5 (Compass)

`CACHE_B_HIT` (4) and `COMPASS_FRESH_RANK` (5), reached inside the
`category === "for_you" && callerUserId` block at `routes/discovery.ts:1253`.

**Say what this comparison actually is.** Serve points 1–3 compare PDE against
*no ranker at all* — that is the caches-in-series finding. Serve points 4–5
compare PDE against **Compass**, a genuinely different ranker with its own
candidate cache and its own scoring pipeline.

These are **different questions**, and their rows must never be pooled:

| Serve points | Legacy ran | The question |
|---|---|---|
| 1–3 | no ranker | does ranking reach traffic it currently cannot? |
| 4–5 | Compass | do two rankers disagree, and how? |
| 6 | PDE itself | *(see C2)* |

`serve_point` is already on every row, which makes the separation queryable. The
divergence report (C3) must **report them separately and refuse to sum them**.

**Exit:** shadow rows appear from serve points 4–5 when the mode and cohort admit
a request there; the comparison is documented as ranker-vs-ranker in the module
and in the report output.

### C2 — Serve point 6: decide and document

**Recommendation: do not wire it, and record why.**

Because the PDE engine was *extracted* from the cold-fetch path rather than
copied, `routes/discovery.ts` already calls `rankForViewer` for serve point 6.
Shadowing it would compare a result **with itself** and report zero divergence —
a number that reads as evidence and is a tautology.

**Rows that cannot fail to agree do not belong in a table whose purpose is to
find disagreement.** Pooled into any aggregate, they dilute real divergence
toward zero in exact proportion to how much cold-fetch traffic exists.

**Exit:** the decision is written down in `lib/discoveryShadow.ts` and in the
packet, with the tautology argument, so that a later reader does not "fix" the
omission. If the decision is ever reversed, those rows must carry a marker
distinguishing them.

### C3 — The divergence report

A read-only report over `discovery_shadow_serves`, modelled on
`reportDiscoveryServePoints.ts` and inheriting its discipline.

**Requirements**

1. **Refuses a verdict on an empty window**, exactly as the serve-point report
   does. Zero shadow rows means "shadow has not run", never "the engines agree".
2. **Breaks down by `serve_point`**, and never sums 1–3 with 4–5.
3. **Breaks down by `cohort_reason`.** D6=A rows come from a handful of internal
   accounts and prove the harness runs; D6=B rows are the hashed sample the
   measurement is actually made from. Pooling them is a category error.
4. **Separates `sort_by IS NOT NULL`.** `applyFilters` *re-sorts* when `sortBy`
   is `rating`/`popular`/`nearest`, on both sides and after ranking, so those
   requests agree **by construction**. They are real serves and are not evidence
   that PDE changes nothing. An analysis that pools them finds PDE less
   consequential than it is, in exact proportion to how many users sort.
5. **Surfaces `pde_suppressed_writes`.** Expected `> 0` on most rows. A sudden
   zero means the write suppressor stopped being reached — not that the run
   became clean.
6. Read-only, behind the read-only audit front door, registered in
   `READ_ONLY_AUDIT_ENTRY_POINTS` with a written reason.

**Exit:** the report runs, and against today's empty table it exits **refusing a
verdict**. That refusal is the passing state at this point in the timeline.

**Verification:** run it. A report that returns a confident "0% divergence"
against an empty table has failed, not passed.

---

## Phase D — D5=B engine split

The consequential architecture change, already ruled. **This is the actual fix
for one-user-per-city-per-two-hours.**

**Entry:** Phase C exit met, or explicitly declared blocked. The PDE ranking half
already exists (`lib/discoveryPde.ts`); this phase builds the retrieval half and
the shape that lets ranking run on every request.

**The split**

| | Retrieval | Ranking |
|---|---|---|
| cost | expensive | cheap |
| dependency | external (Overpass, rate-limited) | internal |
| varies by user? | **no** | **inherently yes** |
| disposition | **stays cached**, same key, same 2-hour TTL | **runs every request** |

**What is wrong today, precisely.** Cache A's key is user-independent — correct
for a candidate set. But it is consulted as a **response** cache:
`serveCachedPlaces` merges, filters, slices, `res.json()`s and returns. Every
per-user stage below it is not skipped by a decision; it is **never reached**.
Retrieval and ranking are fused into one cache entry, shared on the retrieval
half's key.

**Steps**

1. Introduce an explicit candidate-set type and cache boundary — the cached
   object is *candidates*, not a response. Same key, same TTL, **same Overpass
   call volume**. D5=B is affordable precisely because it does not change
   external call volume; an engine that retrieved for itself would multiply
   Overpass traffic by exactly the factor D5=B was chosen to avoid.
2. Make the cache-hit path capable of ranking: candidates → `rankForViewer` →
   `applyFilters` → page. Shadow mode already runs exactly this sequence
   (`routes/discovery.ts`), so the shape is proven before it serves anything.
3. Keep it **behaviour-preserving under mode `legacy`**: the ranked path is
   reachable but not taken. Legacy must continue to fall *through* the existing
   code rather than through a copy of it (mechanic M2) — a duplicated legacy path
   drifts and silently invalidates every comparison.
4. State the costs the packet already names: **ranking CPU** moves from once per
   city per two hours to every request — the single largest recurring cost in the
   proposal, and the one being knowingly bought. **Latency**: Cache A hits are
   currently the fastest path precisely because they skip everything; under D5=B
   they gain a ranking pass.

**Exit:** under mode `legacy`, responses are byte-identical and the serve-point
distribution is unchanged. The ranked-on-cache-hit path exists, is tested, and is
not taken.

**Verification:** the existing discovery and ranking suites pass unchanged — that
is the behaviour-preservation proof. Plus direct tests that the ranked path
produces a correctly filtered and paged result over cached candidates.

---

## Phase E — Measurement readiness  ·  ❄️ FROZEN

**Everything needed so that the day traffic exists, the comparison runs and
states its own verdict.** Nothing here is run to conclusion now; all of it is
built ready-to-run.

**Entry:** Phase D exit met, or explicitly declared blocked.

**Steps**

1. **A single documented runbook**: what to run, in what order, what each exit
   code means, and what must be established *before* any window is quoted.
2. **The reachability precondition, enforced rather than described.** Phase B's
   finding says a thin window may be a broken surface. The runbook must require
   establishing reachability separately — and where it can be checked
   mechanically, the report should say "reachability not established" rather
   than leave it to the reader.
3. **Discharge the deferred D5 empirical check.** It is owed **before the
   pde-serving flip**, and it is currently recorded as deferred and explicitly
   NOT satisfied. `report:discovery-serve-points` exit 3 — ranked share above one
   third — has **not been ruled out by evidence**.
4. **Pre-register what would falsify the packet**, before numbers exist. Writing
   down "this result would mean D5=B was wrong" while the answer is unknown is
   worth far more than deciding afterwards what the numbers meant.
5. Confirm the 90-day retention story still holds for whatever volume shadow
   actually produces.

**Exit:** a person who has never seen this workstream can run the sequence and
get a verdict or an explicit refusal — never a number requiring interpretation.

**Verification:** dry-run every command in the runbook today. Each must either
succeed or refuse for the stated reason. **A command that errors for an
unexplained reason is a failure of this phase**, not of the environment.

---

## Phase F — Owner gates  ·  ❄️ FROZEN (the gates themselves stand)

**Build nothing past these. Both are behaviour changes and neither has been
ruled on.**

| Gate | Who decides | State |
|---|---|---|
| Enabling `shadow` for any cohort | **Owner** | not ruled |
| The `pde`-serving flip for real users | **Owner** | not ruled |

The D6 cohort gate exists so the *first* decision is available to be made.
**Building the mechanism that makes a decision available is not the decision.**
"The gate exists" and "the gate has been opened" are one sentence apart, and a
reader skimming for status must not have to infer which happened.

Owed before the second gate: the deferred D5 empirical check (Phase E, step 3).

---

## The rulings, for reference

All eight ruled 2026-08-14 by the delegated operator.

| # | Ruling |
|---|---|
| D1 | **B** — `DISCOVERY_ENGINE_MODE` via `lib/featureFlags.ts`, never `compass/flags.ts` (its `LIKE 'COMPASS_%'` loader would read `false` with no error) |
| D2 | **A** — one flag row; `enabled` is the master switch, `metadata.mode` selects the path |
| D3 | **B** — every failure resolves to `legacy`, plus the `disable_discovery_pde` kill switch |
| D4 | **A** for the flag, **C** for the baseline |
| D5 | **B** — user-independent candidates, rank every request. *Revisit clause resolved 2026-08-15 on structural grounds; empirical check deferred to post-launch and explicitly NOT satisfied* |
| D6 | **A then B** as staged escalation; C only with the owner |
| D7 | **A** — append-only `discovery_shadow_serves` |
| D8 | **A** — real impression rows at every serve point |
