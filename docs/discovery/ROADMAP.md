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
> #### A FOURTH FACE, added 2026-08-15 — and this one is a pattern, not a coincidence
>
> > **A SIGNAL NOBODY READS IS NOT A SIGNAL.**
>
> Three defects found on 2026-08-15 were each **already being logged** by code
> written specifically to report them. In every case the warning existed, fired,
> and was never looked at:
>
> | | The signal that existed | What it would have said |
> |---|---|---|
> | 1 | `app.ts:38` — fires whenever `ALLOWED_ORIGINS` is unset and the hardcoded fallback is in use | that production's CORS allowlist is not the one anyone configured |
> | 2 | `places.ts:330` — `"Google Places Autocomplete non-OK"`, carrying Google's own `status` | that destination search has been returning empty with a working key |
> | 3 | `places.ts:490` — `"Places API (New) is disabled on this Google Cloud project"`, with the activation URL | exactly which API needed enabling, and when |
>
> **All three were found by probing production from outside, not by reading the
> logs the code already writes.** That is the finding.
>
> This workstream has been *adding* observability and it has been right to —
> #61, #62 and #64 are why the Foursquare 429 and the Google key state were
> detectable at all. But **instrumentation with no reader is instrumentation that
> does not work**, and it fails in the invariant's own shape: the signal is
> present, the failure is unobserved, and the outcome is indistinguishable from
> having no instrumentation at all.
>
> **Consequence, and it is a real one:** *"we log that"* is not an answer to
> *"how would we know?"* — not until someone or something reads it. Before adding
> another `logger.warn` to close an observability gap, establish who or what
> reads it. **A log with no reader is a to-do note written to a file nobody
> opens.**
>
> #### FACE ONE, ONE LEVEL DEEPER — 2026-08-15. The instrument caught itself.
>
> > **PROVE THE TEST FAILS BEFORE YOU TRUST IT. A test you have only ever seen
> > pass is not evidence — it is a test-shaped object.**
>
> The place-id round-trip test (#78) was written specifically to catch a defect
> that two separately-correct routes had hidden between them. It was then
> reverted-and-rerun to prove it would fail. **IT PASSED.**
>
> The reason is worth stating exactly, because it generalises: the test drove the
> route through a **fetch stub that returned success regardless of the URL it was
> handed.** A stub that cannot see a wrong request cannot detect one. The test
> exercised the code, asserted on the response, and was **structurally incapable
> of failing** for the defect it was written to catch.
>
> **That is face one — vacuity is failure — occurring inside a test written by
> someone actively thinking about face one, on the same day, in the same
> workstream.** #58 was the instrument being wrong about the world. This is the
> instrument being wrong about itself.
>
> The fix was to make the stub answer the way **production Google actually did**:
> `INVALID_ARGUMENT` for a namespaced id. Then: **3 failures with the fix
> reverted, 22/22 with it.**
>
> ##### The dependency chain, which is the part that does not transfer for free
>
> That fix was only available because a **real production response existed to
> model the stub on** — and it existed because the observability fix had shipped
> hours earlier and put Google's actual status on the wire. **Three things earned
> each other, in sequence:**
>
> | | | |
> |---|---|---|
> | **1** | the observability fix (#75) | made the real failure *speak* |
> | **2** | a live probe against production | captured what it actually said |
> | **3** | a stub modelled on that answer | made the test able to fail |
>
> **Remove any one and the round-trip test is still green and still worthless.**
> A stub invented from imagination models the API you *expect*, which is the same
> API your code already assumes — which is why invented stubs so often cannot
> fail. **Model stubs on captured responses, not on expectations.**
>
> ##### What to do about it
>
> - **Every new test that guards a specific defect: break the fix, watch it go
>   red, restore.** Not for the important ones. For every one. It costs a minute.
> - **Distrust a stub that never rejects.** If no input makes it return an error,
>   it is scenery.
> - **`assert` on the request, not only the response**, whenever the defect could
>   be "we called the wrong thing."

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

---

> ## ⚠⚠ OWNER RULING — 2026-08-15, GOVERNING. THE BOTTLENECK HAS MOVED UPSTREAM.
>
> **This binds everything below it, including the redirect above.** Where they
> differ, this wins.
>
> ### The statement, verbatim
>
> > **Discovery measurement work may close its existing proof obligation, but it
> > NO LONGER GETS TO GENERATE NEW PREREQUISITE WORK BY DEFAULT. Any new blocker
> > must be weighed against fixing the place corpus and destination discovery
> > first. Ranking is downstream until the app has something worth ranking.**
>
> ### The reasoning — recorded because it reframes everything, not as commentary
>
> **The harness has already paid for itself.** It exposed auth blockage,
> observability gaps, CORS risk, the autocomplete failure, and several
> methodology weaknesses. That was its job and it did it.
>
> **The bottleneck is no longer measurement. It is upstream of it:**
>
> > empty/thin **place corpus** → broken **destination discovery** and
> > **autocomplete** → weak **user-visible place cards** → **THEN** ranking.
>
> Measuring a ranker sitting behind three broken upstream stages produces
> confident answers about the wrong stage.
>
> ### Phase B disposition
>
> **The same-origin proxy was the LAST ALLOWED PREREQUISITE.** The disposition
> was: Phase B proceeds, and **if anything else blocks before the verdict, STOP
> and formally PARK it** with its state recorded.
>
> ### ⏸️ THIS FIRED THE SAME DAY. PHASE B IS PARKED.
>
> The proxy was built and verified, with **no production config change** — and
> then failed on a **platform routing rule** that no proxy can address: Replit
> intercepts `/api/*` on the workspace dev domain and serves it locally
> regardless of what is bound underneath, and there is no deployed frontend.
>
> A different port, a different domain, or a different mechanism is **by
> definition another chain of prerequisite work**, which is exactly what this
> ruling ended. **No such attempt was made.**
>
> → **[Phase B — PARKED](#phase-b--parked-2026-08-15)** for the full state and
> the verified evidence of the blocker.
>
> **PARKED-WITH-EVIDENCE IS A LEGITIMATE OUTCOME, NOT A FAILURE**, and is worth
> more than another chain of prerequisites. Do not treat parking as losing. A
> session that parks with its state legible has delivered; a session that
> generates a fourth prerequisite has not.
>
> **The rule worked.** It was written in the morning and it stopped a fourth
> prerequisite the same evening — which is the strongest available evidence that
> it was the right rule, and the reason it should not be softened later when
> parking feels unsatisfying.
>
> ### The sequence — NOW LIVE, as of 2026-08-15
>
> Phase B has resolved by **parking**, so this is no longer "what comes after".
> **It is the current work.**
>
> | | | |
> |---|---|---|
> | **1** | **`google-autocomplete` is P1 PRODUCT FUNCTIONALITY** | Moves **ahead of any further ranker architecture**. *A user who cannot reliably select a destination never reaches the system we spent today measuring.* Filed: [`../places/google-legacy-places-api-returns-nothing.md`](../places/google-legacy-places-api-returns-nothing.md) |
> | **2** | **Place Intelligence starts as a VISIBLE PRODUCT UNIT** — enumeration done: [`place-intelligence-osm-card-enumeration.md`](place-intelligence-osm-card-enumeration.md); **both open questions now RULED: [`place-intelligence-owner-rulings.md`](place-intelligence-owner-rulings.md)** | **Not invisible corpus-building.** OSM-only destinations must produce useful cards: reliable photos, experiential attributes, provenance and confidence, category and context, graceful fallbacks. Helps users **now** *and* becomes ranking input later. |
> | **3** | **Event Truth remains the next architectural foundation** | May run **in parallel** with card enrichment, provided neither mutates the other's contract casually. **Must not become another week of invisible infrastructure before visible Discovery improves.** |
> | **4** | **RANKER WORK GOES ON EXPLICIT HOLD once Phase B resolves** | **No optimising ranking machinery over an empty corpus.** |
>
> **Item 4 supersedes the redirect's "Phases A–D land as planned" for the ranker
> portions specifically.** Phase D (the D5=B engine split) is ranking machinery;
> it is on hold once Phase B resolves, regardless of being "next".
>
> ### Item 2 — BOTH OPEN QUESTIONS RULED, 2026-08-15
>
> The enumeration raised two questions and refused to assume either answer. Both
> are now ruled by the owner. **Full text and reasoning:
> [`place-intelligence-owner-rulings.md`](place-intelligence-owner-rulings.md)** —
> read it before starting item 2, not after.
>
> **RULING 1 — persisting the resolved photo is ENABLING INFRASTRUCTURE, not a
> new product feature.** The product already resolves FSQ → Google → artwork, so
> persisting the winner **adds no behaviour** — it removes repeated
> external-provider work from behaviour already approved. Narrow: the canonical
> resolved photo and its source metadata, reused on subsequent reads, with
> **refresh and invalidation DEFINED EXPLICITLY**. Explicit non-goals, each
> needing a **new** ruling first: crawling photos, bulk enrichment, multiple
> candidates per place, quality scoring, cross-provider deduplication,
> pre-populating cities. *Caching a resolved product fact is the objective;
> corpus-building is not.*
>
> **RULING 2 — "useful" means TIER 1 INFORMATIVE for this phase.** The test:
> **a place card becomes materially more useful EVEN WITH ZERO PORTAVA USERS
> CONTRIBUTING ANYTHING.** Outdoor seating, wheelchair access, internet access,
> neighborhood, wikidata and image provenance, accuracy/confidence/disclaimer
> info are legitimate because they improve **the factual object itself**.
>
> **THE TIER BOUNDARY — verbatim, and governing:**
>
> > **TIER 1 is FACTUAL intelligence.**
> > **TIER 2 is ENRICHED or DERIVED intelligence from external and accumulated
> > place data.**
> > **TIER 3 is EXPERIENTIAL or OPINIONATED intelligence derived from Portava
> > behaviour — people-like-you, contextual recommendation, social proof, vibe,
> > opinionated ranking.**
>
> Tier 3 requires behavioural data; **smuggling it into Tier 1 would manufacture
> intelligence or create a premature scoring system.**
> **DO NOT BUILD TIER 3 MERELY BECAUSE TIER 1 IS FINISHED** — the gate is users,
> and it does not open by completing the tier below it.
>
> **IMPLEMENTATION ORDER, ruled:** (1) the nearly-free **OSM mapping win** — stop
> discarding `outdoor_seating`, `wheelchair`, `internet_access`,
> `addr:neighbourhood`, `wikidata`, `image` and populate the fields the card
> already understands; (2) **persist the resolved photo metadata**; (3) **MEASURE
> COVERAGE — part of the unit, not a follow-up**, and enumerated rather than
> estimated.
>
> #### ⚖️ MEASUREMENT-SYSTEM RULINGS — 2026-08-15, GOVERNING
>
> **Full text: [`place-intelligence-measurement-system-rulings.md`](place-intelligence-measurement-system-rulings.md).**
> Read it before starting anything below it.
>
> > **The key outcome is NOT 33%. It is that you have now built a MEASUREMENT
> > SYSTEM capable of telling you where the information deficit actually is.
> > Exploit that before building the next supply layer.**
>
> This reframes what Tier 1 was for. The obvious response to "33% carry outdoor
> seating" is to find a source for the other 67% — **that is the next supply
> layer, and it is exactly what this defers.** The instrument is the asset.
>
> | | Ruled | State |
> |---|---|---|
> | **1** | **Republish #66–#85** — authorised, owner presses. Verification re-run **IMMEDIATELY BEFORE**, not earlier the same day. The old supply-path condition is **MOOT and retired**: #83–#85 *are* the supply path, and coverage was measured against real Overpass data rather than the deployed build | verified at `9a59b321f` |
> | **2** | **Apply migration `2095`** right after republish verifies. Full discipline despite the tiny data risk: snapshot + before-state → sanctioned path → after-state + schema verification → **ONE REAL end-to-end photo-resolution and persistence proof**. Staged by agent, executed by owner | staged |
> | **3** | **COMPLETE coverage matrix, 7 destinations × 4 categories** — **outranks starting any new feature**. **PRESERVE PER-CITY AND PER-CATEGORY NUMBERS ALONGSIDE THE AGGREGATE; the result must NOT be reduced to one percentage.** If the default endpoint stays unreachable, **use the mirror and pace it** — same OSM database, and a complete matrix from it beats a partial one from the canonical host. **Record which endpoint produced the numbers** | |
> | **4** | **Fix the seed/live neighbourhood mismatch — AHEAD of Tier 2.** `seed-discovery-places.ts` and the live route must represent the same place shape, or QA produces **both false regressions and false confidence** | **DONE** — one shared `osmNeighborhood()`; drift guard red-proved. [`seed-live-place-shape-divergences.md`](seed-live-place-shape-divergences.md) |
> | **5** | **Change the default test city away from Cebu — but KEEP Cebu as an explicit low-coverage fixture. Do not solve Cebu by hiding it.** Two standing tests: does enrichment work when the source has data, and does the product degrade gracefully when it does not | |
> | **6** | **Paris is SEPARATE.** 0.0% from arrondissement tagging semantics is a **NORMALISATION problem** — not evidence Tier 1 failed, not evidence for Tier 2. File as a **narrow geography adapter** so it does not contaminate the enrichment decision | |
>
> **TIER 2 IS NOT AUTHORISED AS A PROVIDER INTEGRATION.** What is authorised,
> *after* the above, is a **TIER 2 LEVERAGE STUDY**: which missing card fields
> actually matter, which sources could supply them, **matchability WITHOUT
> Wikidata ids**, expected incremental coverage, latency and cost, and whether
> results can be persisted into the corpus. **The 3.2% wikidata figure is why —
> if only 3% of the corpus exposes the join key, perfect enrichment downstream
> of it still has a hard ceiling.** *Choose the source from evidence, not
> architecture aesthetics.*
>
> **STILL PARKED, unchanged:** Phase B, ranker work, Tier 3, the photo
> non-goals. **The corpus remains the constraint — ranking two-thirds of
> structurally thin places more intelligently does not create information.**
>
> #### Tier 1 progress
>
> | Step | State |
> |---|---|
> | **1 — OSM tag mapping** | **LANDED.** `mapOsmElementToPlace` in `routes/discovery.ts` now keeps the six ruled tags. `neighborhood` reaches the field the card already renders; `outdoor_seating` / `wheelchair` / `internet_access` reach the chip row; `wikidata` and `image` are **carried, not consumed** — they are the Tier 2 join key and photo candidate, and were previously discarded. Extracted to an exported pure function so the mapping is unit-testable at all: it was reachable only through a live Overpass call before. 15 tests, red-proved at **12 fail / 3 pass** with the behaviour reverted through the same seam. |
> | **2 — persist the resolved photo** | **CODE LANDED, INERT.** `discoveryPlacePhotoStore.ts` plus a read-through in both photo routes: a stored photo is served on the FIRST link of the chain, so neither provider is called. Google stores the photo **reference**, never the key-bearing media URL. Only a HEAD-verified Foursquare URL is persisted. Its table is created by **`2095_discovery_place_photos.sql`, STAGED for the operator** — [`place-photo-persistence-migration-staging.md`](place-photo-persistence-migration-staging.md). Until that is applied every store call degrades to "no stored photo", which is exactly today's behaviour. |
> | **3 — measure coverage** | **DONE — measured, not estimated.** `src/scripts/reportOsmTagCoverage.ts` runs the route's OWN Overpass filter and the route's OWN mapping function over real destinations, so what it counts is what a card would actually receive. Findings: [`osm-tier1-coverage-findings.md`](osm-tier1-coverage-findings.md). |
>
> **REFRESH AND INVALIDATION, defined as the ruling requires:** age (30-day
> horizon, enforced **on read** so an unswept store still cannot serve a stale
> photo); key rotation (cannot strand a row — the URL is minted per read); an
> unusable row (stamped `invalid_at`, read as absent, kept observable rather
> than silently deleted); explicit eviction (wired into the admin place-image
> paths, so an operator is never overruled by a photo we resolved earlier); and
> whole-store reset (truncate at any time; the cost is one re-resolve).
> **Named as NOT a trigger:** a client-side broken image — the card cannot
> report a 404 today, and the 30-day horizon is the backstop. Recorded so the
> gap is known rather than discovered.
>
> **Tier 1 deliberately does NOT set `headerImageUrl` from the OSM `image` tag.**
> The client's `useFsqPhoto` returns early when a header image is present, so
> promoting it here would silently replace the working FSQ → Google → artwork
> chain with an unvalidated third-party URL — and a dead URL renders as "no
> photo", which is indistinguishable from never having resolved one. Precedence
> is settled in step 2, where invalidation is defined.
>
> **REPUBLISH IS INDEPENDENT** and must not wait on Place Intelligence: **#66–#81
> ship alone** and Tier 1 starts from that published baseline. The single
> coupling condition — *does anything in #66–#81 alter the Overpass tag mapping
> or the photo resolution chain?* — was **verified NEGATIVE** at `807846dd1`
> against pre-#66 base `0e9a72aec`: `routes/discovery.ts` is not in the changed
> set at all, the client photo chain is untouched, and the `/places/photo` +
> `/places/fsq-photo` region of `routes/places.ts` is byte-identical but for four
> log-throttle constants belonging to the autocomplete/details routes. Evidence
> in the rulings document.
>
> ### What this means for the next session arriving cold
>
> Before proposing any new prerequisite, ask the question this ruling exists to
> force: **does this help a user select a destination or see a useful place card
> today?** If not, it is downstream work, and downstream work does not get to
> block by default any more.

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
| `place-intelligence-osm-card-enumeration.md` | **item 2 of the live sequence** — what an OSM-only place card renders today vs what it could, enumerated from code, with each addition costed by what it would actually require. Enumeration only; nothing built |
| `place-intelligence-owner-rulings.md` | **GOVERNING for item 2** — the owner's answers to the two questions the enumeration raised: photo persistence is *enabling infrastructure*, "useful" means *Tier 1 informative*. Carries the **tier boundary verbatim**, the named non-goals, the ruled implementation order, and the verification that **republish (#66–#81) is independent** |
| `place-photo-persistence-migration-staging.md` | **STAGED, NOT APPLIED** — `2095_discovery_place_photos.sql`, with before/after verification and the trap that a zero-row table is indistinguishable from a table nothing writes to. **The operator presses this** |
| `osm-tier1-coverage-findings.md` | **Tier 1 step 3** — measured coverage of the six ruled tags over 857 real places. Uneven by region in a way averaging hides, and it constrains Tier 2 |
| `seed-live-place-shape-divergences.md` | **Step 4** — `neighborhood` unified into one shared function used by both the seeder and the live route; **three further divergences filed rather than silently unified**, because each would change what the live feed returns |
| `place-intelligence-measurement-system-rulings.md` | **GOVERNING** — the measurement system is the outcome, not the 33%. Six ruled steps, the Tier 2 **leverage study** (not an integration), and what stays parked |
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

`routes/discovery.ts`: Cache A is checked at `:1786` and returns **before** the
Compass block at `routes/discovery.ts:1884#callerUserId`. *(Line citations
re-verified 2026-09-05 at `4cc19af82`; the same two points were at 1113 and 1211
when this was written and the file has since grown above them. The control-flow
claim is unchanged.)* Cache A's key is
`(destination, category, radiusKm)` —
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

Outcomes arrive from clients and UPDATE existing rows (`routes/rankEvents.ts:194#outcome_at`).
One contaminated row corrupting the comparison funnel is disqualifying — which
is why D7=A put shadow data in its own append-only table.

**Still true after #365 and #387, and both changed something about it.** #365
made an outcome upgrade any row on a strictly *lower funnel rung* rather than
only `outcome='impression'` (`routes/rankEvents.ts:111#upgradableOutcomesFor`, `:171`), so a tap
followed by a save no longer 404s — but the update is **still in place**, so the
tap is still overwritten and the transition is still unrecoverable. #387 stopped
the serve-point report reading the corpus through `outcome` at all
(`event_type IS NULL`, `lib/discoveryServePointReport.ts:540#event_type`). **Neither makes
`rank_events` an event log.** The mutability is the constraint; only the
instruments that used to depend on the mutable column have been moved off it.

**And the trap that is easy to miss:** `DiscoveryRankingService.rankItems` writes
its **own** `rank_events` rows — `writeRankAnalyticAsync` at `:871/:991/:1004/:1013`
*(re-verified 2026-09-05; `:768/:867/:879/:888` when this was written)*, an
eligible and a scored row per candidate — **whenever it is handed a client**,
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

**Last reconciled against the code: 2026-09-05**, at `4cc19af82` (PR #387), row
by row, each row cited to a file and line. The walk is recorded below the table:
**[Status reconciliation — 2026-09-05](#status-reconciliation--2026-09-05)**.

| Phase | Name | Status |
|---|---|---|
| **A** | Land Stage 2 | **DONE** — PR #50 merged 2026-08-15, 26/26 green |
| **B** | Make discovery reachable | ⏸️ **PARKED — 2026-08-15. NOT closed, NOT abandoned, and the exit criterion remains UNMET.** Re-checked 2026-09-05: **unchanged**. Blocked on: **no route exists from a browser session to the production API in this workspace** — Replit's path-based routing intercepts `/api/*` on the dev domain to the local dev artifact, and there is no deployed frontend. See **[Phase B — PARKED](#phase-b--parked-2026-08-15)** for the full state: baseline captured, instrument fixed and red-proofed, methodology settled, auth resolved, deploy verified clean. **Parking is not closure.** |
| **C** | Complete shadow coverage | **IN PROGRESS** — corrected 2026-09-05, it was recorded as `NOT STARTED` while two of its three units had landed. **C1 NOT STARTED** (shadow is wired at serve points 1–3 only: `logDiscoveryShadowServe` has exactly one call site, `routes/discovery.ts:1760#logDiscoveryShadowServe`, inside `serveCachedPlaces`). **C2 DONE** — the do-not-wire decision for serve point 6 is written where the phase requires it (`lib/discoveryShadow.ts:22-27#cold-fetch`). **C3 IN PROGRESS** — the divergence report is built, tested and registered (PR #252; `lib/discoveryDivergenceReport.ts`, `scripts/reportDiscoveryDivergence.ts`, `test/discoveryDivergenceReport.test.ts`), and **5 of its 6 requirements are met**. Requirement 2 is not: it groups by serve-point *class*, so serve points 4/5 land in an unlabelled `other` bucket (`discoveryDivergenceReport.ts:51-55#classifyServePoint`). The owner ruling still applies: this is measurement infrastructure, downstream of the upstream bottleneck. |
| **D** | D5=B engine split | **DONE** (the build) · **BLOCKED — owner gate, Phase F gate 2** (the flip). Corrected 2026-09-05. PR #250 wired the pde-mode serve path over Cache A (the `pdeCohort` branch, `routes/discovery.ts:1656-1676#pdeCohort`) and the phase's exit criterion is met on its own terms: under mode `legacy` the cached order is returned unchanged, the ranked-on-cache-hit path exists and is tested (`test/discoveryPdeServePath.test.ts`), and it is not taken. **The owner HOLD was never on building it — it is on ENABLING it**, which is Phase F's second gate and remains unruled: `DISCOVERY_ENGINE_MODE` is still seeded `enabled=false`, `metadata.mode='legacy'` (`migrations/2091_discovery_engine_mode_flags.sql:71-73#DISCOVERY_ENGINE_MODE`) and no later migration moves it. |
| **E** | Measurement readiness | ❄️ **FROZEN** — superseded destination. Step 3 (the deferred D5 empirical check) is **still owed and still NOT satisfied**; note that the instrument it reads has been corrected twice since it was deferred (#366, #387), so **no reading taken before `4cc19af82` is comparable with one taken after**. |
| **F** | Owner gates | ❄️ **FROZEN** + **NOT AGENT WORK**. The two gates still stand absolutely, and **both are still unruled** — verified in code 2026-09-05, not assumed: the mode flag ships `legacy`/off (`2091:70-73`) and the step-7/8 modifiers ship behind `discovery_ranking_modifiers_enabled`, seeded OFF with a postcondition that *fails the migration* if it is ever seeded on (`migrations/2289_discovery_ranking_modifiers_flag.sql:70-74#on_count`). |

> **Maintain this table in the same PR as the work.** A status table that is
> updated separately is a status table that is wrong. Use `DONE`, `IN PROGRESS`,
> `BLOCKED — <reason>`, or `NOT STARTED`.
>
> **This rule was broken and is being repaired rather than quietly restated.**
> Between 2026-08-31 and 2026-09-04 seven PRs landed discovery work (#250, #252,
> #355, #365, #366, #382, #387) and **not one of them touched this table**. The
> table said Phase C was `NOT STARTED` while its C3 report was built, tested and
> registered, and said Phase D was on hold while its serve path was wired. The
> reconciliation below is the repair; the rule above is why it should not have
> been needed.
>
> **And the rule now has a check behind it.** `check:doc-citations`
> (`artifacts/api-server/scripts/check-doc-citations.mjs`, wired in `ci.yml` and
> covered by `src/test/docCitations.test.ts`) executes every `file.ts:NNN`
> citation in `docs/discovery/`, in `00_STATUS.md`, in
> `01_Portava_Discovery_Engine.md` and in `lib/discoveryPde.ts`: the file must
> exist and be long enough, and — for a citation written in the anchored form
> `` `path:209-216#needle` `` — the text `needle` must be on the range's **first
> line**, 209.
>
> **The anchored half is the one that matters**, because a plain range check
> cannot see a line MOVE: this reconciliation's own first draft cited lines
> 205-213 of `check-guard-coverage.mjs`, then inserted three lines above that
> entry in the same diff, and both the old and the new range sit comfortably
> inside an 1115-line file. **Pinning the first line rather than the whole range
> is also not a style choice** — with a contains-anywhere rule the same
> three-line insert still leaves every anchor inside the stale nine-line range,
> which was checked by mutation and came back green. Anchoring the start line is
> what makes a citation's first number a claim that can fail. The same class,
> in reverse, was live in `lib/discoveryPde.ts`, where four
> `writeRankAnalyticAsync` line numbers had been 100+ lines stale while the
> identical fact was being corrected here.
>
> It cannot check a claim nobody wrote as a citation, and it cannot tell you a
> `DONE` is wrong. It removes exactly one failure mode — the citation that was
> true when it was typed.

### Status reconciliation — 2026-09-05

**This is a documentation-accuracy pass. It changed no engine behaviour, no DRS
constant, no flag, and no migration.** Every row above was walked against the
code at `4cc19af82` and given a citation. Both directions were corrected: **two
rows understated what had landed** (C and D), and **six claims were confirmed as
*still* gated** and left standing rather than tidied away.

#### Row by row — what the table said, and what the code says

| Row | What the table said | What the code says |
|---|---|---|
| **A** | `DONE` — PR #50 | **Unchanged and still true.** The three migrations (`2092`/`2093`/`2094`) and `lib/discoveryShadow.ts`, `lib/discoveryCohort.ts`, `audit:shadow-append-only` are all present |
| **B** | `PARKED`, exit criterion UNMET | **Unchanged.** Nothing in the tree bears on it: the blocker is a platform routing rule, and the two things that would lift it (a deployed frontend, or a non-browser probe harness) are still recorded-not-scheduled. **Kept exactly as written** |
| **C1** | `NOT STARTED` (correct, but for the wrong reason) | The **Stage-0 serve-point log** at points 4/5 has existed since 2026-08-14 (`489d26b8a`) — `routes/discovery.ts:1907#CACHE_B_HIT` and `:1967#COMPASS_FRESH_RANK`. **That is not C1.** C1 is the *shadow* comparison at 4/5, and `logDiscoveryShadowServe` still has exactly one call site — `routes/discovery.ts:1760#logDiscoveryShadowServe`, inside `serveCachedPlaces`, so serve points **1–3 only**. C1 is genuinely NOT STARTED; the instrumentation that looks like it is a different phase's work. |
| **C2** | (unlabelled) | **DONE.** The exit is "the decision is written down in `lib/discoveryShadow.ts` and in the packet, with the tautology argument". It is: `lib/discoveryShadow.ts:22-27#cold-fetch`, naming the extraction, the self-comparison and the tautology. |
| **C3** | `NOT STARTED` | **IN PROGRESS** — PR #252, 2026-08-31, **5 of 6 requirements met**. `lib/discoveryDivergenceReport.ts` (pure aggregation), `src/scripts/reportDiscoveryDivergence.ts` (read-only CLI behind the audit front door), `src/test/discoveryDivergenceReport.test.ts`, `package.json` → `report:discovery-divergence`, registered in `READ_ONLY_AUDIT_ENTRY_POINTS` with a written reason (`scripts/check-guard-coverage.mjs:209-216#reportDiscoveryDivergence`). Requirement 2 is unmet — see below. |
| **D** | `ON EXPLICIT HOLD` | The **machinery landed inert** — PR #250, 2026-08-31, `routes/discovery.ts:1656-1676#pdeCohort`. The hold is real and unchanged, but it is a hold on the *flip*, not on the build; reading the row as "nothing exists" was wrong in a way that would have caused someone to build it twice. |
| **E** | `❄️ FROZEN` | **Still frozen and still unbuilt** — no Phase-E measurement runbook exists (`phase-b3-probe-runbook.md` is B3's probe, not step 1's sequence), and step 3 is undischarged. One thing changed *around* it: the instrument step 3 reads was corrected by #366 and #387, so the check is owed a **fresh** reading. Recorded on the row rather than left for whoever runs it to discover |
| **F** | `❄️ FROZEN`, two gates stand | **Both gates verified SHUT in code**, not assumed: `2091:70-73`. A third owner hold — the step-7/8 modifiers behind `discovery_ranking_modifiers_enabled` (`2289:70-74`) — now exists and is **not** one of the two; named so it is not miscounted as a gate opening or a gate added |

#### The C3 requirement that is NOT met, stated rather than rounded up

C3 requirement 2 is *"breaks down by `serve_point`, and never sums 1–3 with
4–5."* The report satisfies the second half and not the first: it groups by
serve-point **class** — `cache_a` (1/2/3), `cold_rank` (6), `other` (everything
else) — at `lib/discoveryDivergenceReport.ts:51-55#classifyServePoint`. So 1–3 can never be summed
with 4–5, but **4 and 5 are pooled into an unlabelled `other` bucket together
with 7–10**, and the printed legend explains only `cache_a` and `cold_rank`
(`scripts/reportDiscoveryDivergence.ts:78-81#NEVER`).

That is harmless today — C1 is unwired, so no row can carry serve point 4 or 5 —
and it becomes a real defect the moment C1 lands, because C1's own exit criterion
requires the ranker-vs-ranker comparison to be labelled **"in the module *and in
the report output*"**. It is in the module and not in the output. **Recorded as
part of C1's remaining work, not as a separate finding**, so that whoever wires
C1 does not discover it after the fact.

#### What is still gated, and is being kept rather than tidied

Accuracy runs in both directions. Each of these was re-verified in code, not
carried forward on trust:

| Still gated | Verified how | Ruling |
|---|---|---|
| **Phase B stays PARKED** | Nothing in this pass touched it and nothing else has: the park is a platform-routing fact, not a code fact | Owner ruling 2026-08-15 — the same-origin proxy was the **last allowed prerequisite** |
| **The `pde` flip** | `DISCOVERY_ENGINE_MODE` seeded `enabled=false`, `metadata.mode='legacy'`; no migration after `2091` alters that row | Phase F gate 2 — **not ruled** |
| **Shadow for any cohort** | Same flag; and the D6 cohort gate fails closed to nobody (`lib/discoveryCohort.ts`, applied at `routes/discovery.ts:1743-1746#shadowCohort`) | Phase F gate 1 — **not ruled** |
| **Step 7/8 modifiers** | `discovery_ranking_modifiers_enabled` seeded OFF, with a migration postcondition that RAISEs if it is ever seeded on (`2289:70-74`) | The ranker is on owner HOLD |
| **Migration `2095`** | Still recorded `STAGED, NOT APPLIED` in `../migrations.md:327`. Its presence in the `2254` ledger backfill is **not** evidence of application — that migration says so in its own header: a `backfill` row means only that the filename was on disk | Operator presses it |
| **Phase E step 3 — the deferred D5 empirical check** | Unsatisfied, and now with an extra caveat: see below | Deferred to post-launch, explicitly NOT satisfied |

#### The steps the recent campaign landed, against the superseding sequence

These are the discovery-side changes from PRs #365, #366, #382 and #387. They
belong to **[the superseding sequence](#the-steps)**, not to phases A–F, which is
why none of them moved a row in the phase table — but the sequence table carried
no state at all, so they were invisible there too. It now carries state.

| Landed | Where | Sequence step |
|---|---|---|
| **impression-path exposure denominator** (#365) | `content_distribution_stats.eligible_impressions` is incremented where the impression is written (`lib/rankLog.ts:154#recordImpressionDistributionStats`, `:248`; `lib/discoveryServeLog.ts:241#recordImpressionDistributionStats`), and the outcome route no longer touches it (`routes/rankEvents.ts:235-241#content_distribution_stats`). The denominator was previously a count of **conversions** | Fixes the `03_Trending` defect the architecture status list carried as open |
| **discovery-surface outcome reporting** (#365) | An outcome now upgrades any row on a strictly **lower funnel rung** rather than only `outcome='impression'` (`routes/rankEvents.ts:111#upgradableOutcomesFor`, `:171`), so a tap→save chain lands as `save` instead of 404ing | Step 2 (Event Truth) is still the answer; this stops one class of loss on the way there |
| **pde-aware serve-point report** (#366) | Ranked-ness is read from the row — `features.rankedInRequest` (`lib/discoveryServePointReport.ts:171`) — not from a static serve-point set, so a pde-ranked cache-A serve counts as ranked | Instrument for step 1 / Phase E step 3 |
| **capped `local_momentum`** (#366) | `lib/discoveryLocalMomentum.ts:96` computes a 48h-vs-baseline place velocity; `portavaRank.ts:152` caps its contribution at `LOCAL_MOMENTUM_MAX_CONTRIBUTION = 0.15`, clamped at `:337-338` | **Step 7** — *"capped `local_momentum` as modifiers only"*, built to the words |
| **exploration governor** (#366) | `allocateExplorationBudget` (`services/ranking/FeedSlotAllocator.ts:461`) — budget clamped to 15–25 % (`:356-357`), slots spread rather than pinned, four **reason codes** per pick (`governorReasonsFor`, `:436`). With the flag off it computes the allocation and applies nothing | **Step 8** — *"budget ~15–25 % with reason codes, not fixed positions"* |
| **graph node kinds** (#366) | `circle` + `experience` admitted to the Compass graph (`migrations/2290_intelligence_graph_node_kinds.sql`) | Feeds step 7's *graph as modifier* |
| **serve-point report corpus** (#387) | `fetchDiscoveryServeRows` selects by **`event_type IS NULL`** (`lib/discoveryServePointReport.ts:529#fetchDiscoveryServeRows`, predicate at `:540`), never by `outcome` | Repairs the instrument Phase E step 3 reads — see below |
| **`/discovery/feed` client callers** (#382) | Serve point 7 had no caller in the repo; it has two now (`travel-buddy-standalone/src/components/discovery/DiscoveryEventPostsRail.tsx`, `ForYouTab.tsx:428`) | Reachability of the surface Phase B measures |

#### #387 changes what an old serve-point reading means, and that is worth stating

`report:discovery-serve-points` used to fetch
`.eq("surface","discovery").eq("outcome","impression")`. Because `rank_events` is
mutable state — the outcome route **UPDATEs the served row in place** — every
serve that converted stopped matching that filter. The report therefore
undercounted serves **differentially by conversion**, and the serve points that
rank convert best, so the D5 ranked share was biased toward *"ranking is
starved"* by exactly the serves that reached a ranker.

**This is the governing invariant in its measurement form:** the absent rows were
not absent behaviour, they were behaviour the instrument had stopped being able
to see, and the result it returned looked like a finding.

Consequences that must not be lost:

- Any serve-point reading taken **before `4cc19af82`** was taken with the old
  filter. It is not comparable with one taken after, and it is a **floor**, not a
  measurement. `serve-point-report-20260828.md` is such a reading.
- Phase E step 3 reads this exact query. It was already gated on reachability
  (Phase B) and on launch; it is **also** gated on being re-read with the fixed
  corpus.

---

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

It is **not** caused by the drift — the clean tree is correctly on the legacy
endpoint, and the drift is the tree that moved *off* it. `places.ts:289`
documents the route as degrading to an empty list on non-OK, which is honest but
silent: the caller cannot distinguish "no such city" from "the API is off".

→ **FILED: `../places/google-legacy-places-api-returns-nothing.md`.** It is its
own defect and **does not belong to Phase B** — folding it in would both delay
Phase B and bury the defect.

**Two corrections that investigation produced, recorded here because the
short version above was wrong in both directions:**

1. **`/places/google-details` fails too**, on the same legacy host, for a valid
   real `place_id`. It is the legacy Places **API family**, not one endpoint.
2. **It is degradation, not an outage.** `GlobalPlacePicker` composes several
   sources and `/api/places/search` (Nominatim) works, so the picker still
   returns results. What is lost is the whole Google-sourced contribution,
   silently. *"Destination search is broken"* would have been wrong.

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

**This table carried no state until 2026-09-05, which is why work landing against
steps 7 and 8 moved nothing anywhere and looked, from the roadmap, like nothing.**
The state column is now maintained under the same rule as the phase table.

| # | Unit | State (2026-09-05) | Note |
|---|---|---|---|
| **1** | **Land the in-flight harness — A–D** | **PARTIAL** — A DONE, B PARKED, C in progress, D built-and-held | Including Phase B's unmet probe criterion |
| **2** | **EVENT TRUTH** | **NOT STARTED — gated.** Packet written; **no migrations, no tables** | Sessions/runs, candidate viability, exposures, interactions, strong outcomes, attribution, context snapshots, stable IDs, **append-only**, able to **reconstruct opportunity** |
| **3** | **PLACE INTELLIGENCE v1 + VISIBLE CARDS** | **TIER 1 LANDED** (OSM tag mapping, photo persistence code, coverage measured); Tier 2 is a **leverage study**, not authorised as an integration; Tier 3 gated on users | Fixed experiential taxonomy, richer cards, *"Why this place"*. **Ships user-visible value — not merely ranker input** |
| **4** | **TASTE BOOTSTRAP** | **NOT STARTED** | Visual onboarding using **contrasting sets**, not isolated binaries. **Stop early when uncertainty drops.** Archetype priors |
| **5** | **PORTABLE TASTE** | **NOT STARTED** | Learned across destinations from **strong events**, with confidence **per taste dimension** |
| **6** | **CANDIDATE GENERATION** | **NOT STARTED as a step** — Cache A already holds a user-independent candidate set (D5=B's retrieval half) | |
| **7** | **CONTEXTUAL RANKING** | **PARTIAL, FLAG-GATED OFF.** `local_momentum` built and **capped** to `0.15` (`portavaRank.ts:152`), graph node kinds admitted (`2290`), all behind `discovery_ranking_modifiers_enabled` seeded OFF (`2289`) — #366 | **Taste as the spine**; graph, behaviour, trails and **capped `local_momentum` as modifiers only** |
| **8** | **GOVERNOR** | **BUILT, INERT.** `allocateExplorationBudget` (`FeedSlotAllocator.ts:461`): budget clamped 15–25 %, spread slots, four reason codes. With the flag off it computes the allocation and **applies nothing** — #366 | Exploration and diversity **allocator** — budget ~**15–25 %** with **reason codes**, *not fixed positions* |
| **9** | **LEARNED RESIDUAL** | **NOT STARTED — and must stay that way.** Its entry condition is *trustworthy outcomes*, and step 2 is unbuilt | **Only after trustworthy outcomes exist.** It must **improve the explicit model**, and an **unexplainable high-confidence prediction must CONSTRAIN how aggressively it is exploited** |
| **10** | **OPTIMISE AGAINST TRIP OUTCOMES** | **NOT STARTED** | |

> **A step built behind an OFF flag is not a step taken.** Steps 7 and 8 exist in
> the tree and reach no user. Recorded that way deliberately: *"built"* and
> *"serving"* are one flag apart, and the phase table has already been misread
> once in the other direction.

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

## Phase B — PARKED (2026-08-15)

> # ⏸️ PARKED WITH EVIDENCE — NOT CLOSED, NOT ABANDONED
>
> **THE EXIT CRITERION REMAINS UNMET.** Discovery rows at multiple serve points
> have **not** been produced. Nothing below claims otherwise, and **parking is
> not closure** — the same distinction that has governed this phase since #54,
> and it matters more here, not less. A parked phase with its state recorded is
> a phase someone can resume. A phase quietly treated as done is a phase whose
> criterion silently stopped applying.
>
> **This is the owner's ruling of 2026-08-15 firing exactly as written, not a
> judgement call made in the moment.** The same-origin proxy was the LAST
> PERMITTED PREREQUISITE. It failed on a platform routing rule. A different
> port, a different domain, or a different mechanism is *by definition* another
> chain of prerequisite work, and that no longer happens by default.
>
> **Do not attempt one.**

### BLOCKED ON

**No route exists from a browser session to the production API in this
workspace.**

1. **Replit's path-based routing intercepts `/api/*` on the workspace dev
   domain** and serves it from the local dev artifact, **regardless of what is
   bound underneath.** A same-origin proxy therefore cannot put a browser
   session in front of production: the browser's `/api` calls never leave for
   production, whatever the proxy is doing on its port.
2. **There is no deployed frontend**, which is what made a local client
   necessary in the first place.

#### Verified, not merely reported

| Probe | Result |
|---|---|
| `GET /api/healthz` on **production** | 200 + `server: Google Frontend`, `via: 1.1 google`, `x-cloud-trace-context` |
| `GET /api/healthz` on the **dev domain** | 200 with **none of those headers** — not reaching production |
| `GET /` on the **dev domain** | **502** |

**The last two lines together are the proof.** The root is 502 — nothing is
successfully serving the port — yet `/api/healthz` still returns 200. **`/api/*`
is answered by something other than what is bound underneath**, which is exactly
the interception claimed, demonstrated rather than asserted.

### The state that is being preserved

Parked-with-evidence means the next session resumes rather than rediscovers.

| | |
|---|---|
| **Baseline** | **Captured** against production 2026-08-15T12:50:13Z: 13 rows / 24 h, **all on serve point 9**, 4 sessions, serve points **1–8 at a floor of zero**, **zero `GET /discovery` serves**. Recorded in `phase-b3-probe-runbook.md` → RECORDED READINGS. |
| **Instrument** | **Fixed and red-proofed** (#58). Verified in use: it *declined* to render a verdict on sections 2b and 3 rather than returning a confident zero — *"That is not the criterion holding. It is the criterion untested."* |
| **Window** | **Fixed `--since`/`--until`** (#67), so a before/after pair can address one window. Refuses `--days` mixed with them, and refuses an inverted or zero-width window. |
| **Methodology** | **Settled.** Window-not-verdict; observer and verifier in different hands; the local-client substitution reasoned and documented rather than assumed. |
| **Authentication** | **Resolved.** Email/password; never gated on Google SSO (#63 correction). |
| **Deploy** | **Verified clean** — `a384e29fa` / build-id `58536e52`, confirmed in the *running* build, not merely published. |
| **Contamination question** | **Asked and answered before the probe**: the Foursquare 429 cannot suppress serve points, server-side (50-module import closure, zero FSQ call sites) or client-side (`useFsqPhoto` never throws). |

**None of that is invalidated by the park.** It is the reason the park is cheap
to reverse.

### What would unblock it later — RECORDED, NOT SCHEDULED

Stated so a cold reader is not left guessing, and **deliberately not planned,
resourced, or sequenced.** Neither of these is work anyone is doing:

- **A deployed frontend artifact**, which removes the need for a local client
  entirely; or
- **A probe harness that is not browser-based**, which sidesteps the routing
  rule rather than fighting it.

**Neither is proposed here, and proposing one is what the ruling forbids.** If
Phase B is resumed it will be because something else made one of them true
anyway — most plausibly the new sequence, since a working destination picker and
useful place cards both imply a frontend somebody can reach.

### One caveat on the blocker's phrasing, recorded for accuracy

The blocker is precisely *"no route from a **browser session** to the production
**API**."* It is **not** the broader claim that nothing in this workspace can
reach production data — the workspace's own `SUPABASE_URL` points at the
production project, which is why the read-only audit guard had to be opened
deliberately to take the baseline at all.

**This is recorded for accuracy, not as a route to unpark Phase B, and no such
route is proposed.** It is noted because a future reader comparing those two
statements would otherwise find them contradictory, and because a dev artifact
configured against the production database is worth someone's attention on its
own terms, separately from Phase B.

---

## Phase B — the original plan, kept for the record

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
a server-held `FOURSQUARE_API_KEY` (`lib/foursquarePlaces.ts:41#FOURSQUARE_API_KEY`),
same API version (`lib/foursquarePlaces.ts:16#FSQ_API_VERSION`) *(both re-cited
2026-09-05; they read lines 35 and 15 and the file has moved under them)*. A
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

> ## ⏸️ THIS PROBE IS PARKED — 2026-08-15. It was never run.
>
> The deploy precondition was met and the probe was authorised, staged and
> ready. It is blocked on **platform routing**, not on anything in this section:
> `/api/*` on the workspace dev domain is intercepted and served locally, so no
> browser session can reach the production API. See
> **[Phase B — PARKED](#phase-b--parked-2026-08-15)**.
>
> **Everything below remains correct and is preserved for whoever resumes it.**
> The exit criterion is unchanged and unmet.
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

## Phase C — Complete shadow coverage  ·  **IN PROGRESS** (C2 ✅, C3 ◐ 5/6, C1 ❌)

**Entry:** Phase B exit met, or explicitly declared blocked. **Satisfied** — B is
PARKED WITH EVIDENCE, which is the "explicitly declared blocked" branch, not a
softening of it.

> **State as of 2026-09-05, reconciled against `4cc19af82`:**
>
> | Unit | State | Evidence |
> |---|---|---|
> | **C1** — shadow at serve points 4–5 | **NOT STARTED** | `logDiscoveryShadowServe` has one call site, `routes/discovery.ts:1760#logDiscoveryShadowServe`, inside `serveCachedPlaces` ⇒ serve points **1–3 only** |
> | **C2** — decide serve point 6 | **DONE** | The decision and its tautology argument are in `lib/discoveryShadow.ts:22-27#cold-fetch` |
> | **C3** — the divergence report | **IN PROGRESS** (5 of 6 requirements) | PR #252. Built, tested, registered; requirement 2's per-serve-point breakdown is a per-*class* breakdown |
>
> **Do not read C3 being built as C1 being unnecessary.** The report has nothing
> to read at serve points 4/5 until C1 wires them, and it currently has no bucket
> that would name them if it did.
>
> **Why C3 says `IN PROGRESS` and not `DONE`.** An earlier draft of this
> reconciliation labelled it `DONE, one requirement short` and repeated the
> caveat at every occurrence. That is not one of the four words this table's own
> rule allows (`DONE` · `IN PROGRESS` · `BLOCKED — <reason>` · `NOT STARTED`),
> and a compound label is the crack a status table rots through: the caveat
> travels only as long as someone keeps copying it, while the word `DONE`
> travels on its own. A unit with an unmet requirement is `IN PROGRESS`. The
> count — 5 of 6 — carries the nuance the caveat was carrying, in a form that
> cannot be separated from the label.

### C1 — Serve points 4–5 (Compass)  ·  **NOT STARTED**

`CACHE_B_HIT` (4) and `COMPASS_FRESH_RANK` (5), reached inside the
`category === "for_you" && callerUserId` block at
`routes/discovery.ts:1884#callerUserId` *(the same block was at 1253 when this
was written; re-verified 2026-09-05)*.

> **The distinction that made this row read as done when it is not.** Those two
> serve points already carry **Stage-0 serve-point logging** —
> `logDiscoveryServe` at `routes/discovery.ts:1907#CACHE_B_HIT` and `:1967`, landed
> 2026-08-14 (`489d26b8a`) as part of the D4=C baseline. **That is not C1.** C1
> is the **shadow comparison**, and no shadow row can come from serve point 4 or
> 5 today because `logDiscoveryShadowServe` is never called there. An
> instrumented serve point and a shadowed one look alike in a grep and are
> different phases of work.

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

### C2 — Serve point 6: decide and document  ·  **DONE**

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

**MET.** `lib/discoveryShadow.ts:22-27#cold-fetch` carries the decision, the extraction
reason and the tautology argument verbatim, in the module the exit names. The
report also encodes it structurally: serve point 6 is its own `cold_rank` class
(`lib/discoveryDivergenceReport.ts:53`) rather than pooled, so if the decision is
ever reversed those rows arrive already distinguished.

### C3 — The divergence report  ·  **IN PROGRESS** (5 of 6 requirements)

A read-only report over `discovery_shadow_serves`, modelled on
`reportDiscoveryServePoints.ts` and inheriting its discipline.

> **BUILT — PR #252, 2026-08-31.** `lib/discoveryDivergenceReport.ts` (pure
> aggregation, no DB and no clock), `src/scripts/reportDiscoveryDivergence.ts`
> (the CLI), `src/test/discoveryDivergenceReport.test.ts`, `package.json` →
> `report:discovery-divergence`. Requirement-by-requirement below.

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

**Where each requirement stands — 2026-09-05**

| Req | State | Evidence |
|---|---|---|
| 1 — refuses on an empty window | **MET** | `reportDiscoveryDivergence.ts:65-73#rows.length` prints *"This is NOT evidence that PDE agrees with legacy"* and renders no groups |
| 2 — breaks down by `serve_point`, never sums 1–3 with 4–5 | **HALF MET** | It groups by serve-point **class** — `cache_a`(1/2/3) · `cold_rank`(6) · `other`(the rest) — `discoveryDivergenceReport.ts:51-55#classifyServePoint`. 1–3 can never be summed with 4–5, so the prohibition holds; the per-point breakdown does not exist, and **4/5 would land in an unlabelled `other` bucket alongside 7–10** |
| 3 — breaks down by `cohort_reason` | **MET** | Part of the group key, `discoveryDivergenceReport.ts:91-92#groupKey` |
| 4 — separates `sort_by` | **MET** | Also part of the group key, same line; `null` renders as `default` |
| 5 — surfaces `pde_suppressed_writes` | **MET** | `meanSuppressedWrites` per group, printed on the cost line (`discoveryDivergenceReport.ts:144-152#formatGroup`, in `formatGroup`) |
| 6 — read-only, front door, registered with a reason | **MET** | Guard imported at `reportDiscoveryDivergence.ts:15#ciProdReadOnlyAuditGuard`; registered with a written reason at `scripts/check-guard-coverage.mjs:209-216#reportDiscoveryDivergence` |

**Exit:** the report runs, and against today's empty table it exits **refusing a
verdict**. That refusal is the passing state at this point in the timeline.

**Verification:** run it. A report that returns a confident "0% divergence"
against an empty table has failed, not passed.

**What requirement 2 owes, and when it comes due.** Nothing is wrong today —
C1 is unwired, so no row can carry serve point 4 or 5, and the class split is
exactly right for the rows that can exist. It becomes wrong the moment C1 lands,
because **C1's own exit criterion requires the ranker-vs-ranker comparison to be
labelled in the module *and in the report output***, and the output has no name
for serve points 4/5. **Filed here as part of C1's remaining work**, not as a
separate defect, so that whoever wires C1 fixes both halves of one thing.

---

## Phase D — D5=B engine split  ·  **BUILT AND HELD**

The consequential architecture change, already ruled. **This is the actual fix
for one-user-per-city-per-two-hours.**

> ## ✅ THE MACHINERY LANDED — PR #250, 2026-08-31. THE FLIP DID NOT.
>
> This section described the work as unstarted until 2026-09-05, and the status
> table said `ON EXPLICIT HOLD`. **Both were read as "nothing exists", and that
> was wrong in the expensive direction: it invites somebody to build it twice.**
>
> `routes/discovery.ts:1656-1676#pdeCohort` — inside `serveCachedPlaces`, when the mode
> resolves to `pde` **and** the authenticated caller is in the D6 cohort, the
> cached candidates are ranked for that viewer, per request, and that order is
> served. Anonymous callers, out-of-cohort users and a ranking error all fall
> back to the legacy cached order.
>
> **What is held is ENABLING it, and that hold is untouched and unchanged.**
> `DISCOVERY_ENGINE_MODE` still ships `enabled=false` / `metadata.mode='legacy'`
> (`migrations/2091_discovery_engine_mode_flags.sql:71-73#DISCOVERY_ENGINE_MODE`); no later migration
> alters that row; the flip is **Phase F's second gate and is not ruled**. The
> owner ruling of 2026-08-15 put *ranker work* on hold, and building a path that
> serves nobody is not the thing the gate governs — the gate governs the flag.
>
> **"Wired" and "serving" are one UPDATE apart. Do not read this banner as the
> second one.**

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

**What was wrong, precisely — and what #250 changed about it.** Cache A's key is
user-independent, which is correct for a candidate set. It was consulted as a
**response** cache: `serveCachedPlaces` merged, filtered, sliced, `res.json()`ed
and returned, so every per-user stage below it was not skipped by a decision — it
was **never reached**. Retrieval and ranking were fused into one cache entry,
shared on the retrieval half's key.

**That is still what happens under mode `legacy`, which is the shipping
default**, so the constraint above remains a live description of production. What
changed is that the *capability* now exists next to it: the cached entry is
candidates (`setCacheA(key, { places: enrichedOsm, … })`,
`routes/discovery.ts:1877`) and the pde branch ranks them per request. **The
fusion is now a mode, not a shape.**

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

**MET — on its own terms, and only those.** `src/test/discoveryPdeServePath.test.ts`
drives a deterministic Cache-A (L1) hit twice: under `legacy` the raw cached
order comes back unchanged, and under `pde` + in-cohort the same serve is
re-ranked. The serve-point distribution is unchanged because the pde branch logs
on the **same** cache-level serve point it would otherwise have logged, tagged
`rankedInRequest: true`, and deliberately does not also call `logDiscoveryServe`
(`routes/discovery.ts:1696-1712`) — a second impression row per served item would
have been a silent measurement defect, not a visible one.

**Steps 1–3 are done; step 4 is a cost that has not been paid**, because paying
it requires the flip. The latency and CPU it names arrive with mode `pde` and not
before.

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

   > **The instrument this step reads has been corrected twice since the step was
   > written, and both corrections change what an old reading means.**
   > **#366** made ranked-ness a property of the *row*
   > (`features.rankedInRequest`, `lib/discoveryServePointReport.ts:171`) instead
   > of a static serve-point set, so a pde-ranked cache-A serve now counts as
   > ranked. **#387** replaced the serve corpus predicate: it is
   > `event_type IS NULL` (`lib/discoveryServePointReport.ts:540#event_type`), never `outcome='impression'`, because the
   > outcome route UPDATEs a served row in place and the old filter therefore
   > dropped every serve that converted — **differentially, and against the
   > ranked serve points, which convert best.**
   >
   > **Consequence for this step, stated so nobody discharges it with a stale
   > number:** any serve-point reading taken before `4cc19af82` is a **floor**,
   > not a measurement, and is not comparable with one taken after. The check is
   > owed a fresh reading regardless of what an older run said.
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

| Gate | Who decides | State | Re-verified 2026-09-05 |
|---|---|---|---|
| Enabling `shadow` for any cohort | **Owner** | **not ruled** | `DISCOVERY_ENGINE_MODE` seeded `enabled=false`, `metadata.mode='legacy'` (`2091:70-73`); the D6 cohort fails closed to nobody (`lib/discoveryCohort.ts`, applied at `routes/discovery.ts:1743-1746#shadowCohort`) |
| The `pde`-serving flip for real users | **Owner** | **not ruled** | Same flag row; no migration after `2091` alters it. The serve path it would switch on exists (#250) and is unreachable without the flip |

**A third thing now sits behind an owner hold, and it is recorded here so it is
not mistaken for a gate that has been opened:** the step-7/8 ranking modifiers
(capped `local_momentum`, the exploration governor) ship behind
`discovery_ranking_modifiers_enabled`, seeded OFF by `2289` with a postcondition
that **fails the migration** if the row is ever seeded on (`2289:70-74`). That is
not one of the two gates above — it is the ranker HOLD from the 2026-08-15
ruling, expressed as a flag.

The D6 cohort gate exists so the *first* decision is available to be made.
**Building the mechanism that makes a decision available is not the decision.**
"The gate exists" and "the gate has been opened" are one sentence apart, and a
reader skimming for status must not have to infer which happened.

**That sentence has now been tested by events, in both directions.** Between
2026-08-31 and 2026-09-04 the pde serve path, the divergence report and both
ranking modifiers were built. **Not one gate moved**, and the status table said
so badly enough that a reader would have concluded the opposite — first that
nothing existed, then, on finding it, that something had been enabled. Neither is
true. The mechanisms exist; the gates are shut.

Owed before the second gate: the deferred D5 empirical check (Phase E, step 3) —
and see the note there: the instrument was corrected twice in 2026-09, so the
check is owed a **fresh** reading, not the retrieval of an old one.

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
