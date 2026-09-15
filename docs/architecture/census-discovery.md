# Census — Discovery

*Built against branch `claude/portava-continuation-uqta94`, working tree at `507f8427` plus
uncommitted sibling-agent work, on 2026-09-07. Discovery has **no spec**. This census therefore
does not measure a document; it measures the surface against a denominator assembled from three
sources, stated in §1 so that a reader can reject the denominator before trusting the percentage.*

**Headline: 67 requirements · 46 BUILT-AND-CORRECT · 11 BUILT-BUT-WRONG · 10 NOT-BUILT · 0 CANNOT-VERIFY
→ CONSTRUCTED 85.1 % · CORRECT 68.7 %.** Before this pass: 44 / 11 / 12 / 0 → CONSTRUCTED 82.1 % · CORRECT 65.7 %.
Two BUILT-BUT-WRONG rows were closed outright (A17, C11); two were half-closed and stay in the
wrong bucket (B03, C19); two NOT-BUILT inbound rows were **built behind a FALSE-seeded flag and
land in BUILT-BUT-WRONG on purpose** (A03 — `whyNow` has no producer and is carried as null;
A25 — the reader exists, its Map consumer does not). The 10 remaining NOT-BUILT rows split
**3 on an explicit owner hold** and **7 blocked on a contract another surface has not published** (§4). Discovery is **dark in
production** (§5): the last `surface='discovery'` serve was 2026-08-15, thirteen rows ever.

---

## 0. Provenance

| Field | Value |
| --- | --- |
| `head_commit` | `101709b97` — RE-DECLARED 2026-09-15 by §22, replacing `16f34dff2`. §22 fixed TWELVE swallowed read errors — `searchTrips` and ten sibling per-type searchers, plus the suggest fan-out's `.catch(() => [])` — all of them the defect §21.4 named as a future hazard and which was already present when it was written. **NO VERDICT MOVES**, for the fifth consecutive section and the same reason: no row grades the fan-out and `DV-83` is still not invented. Headline restated from a fresh `CENSUS_INTEGRITY_DUMP=ALL` at this tree: 187-population **76 / 85 / 23 / 3**, CONSTRUCTED 86.1 %, CORRECT 40.6 %; 67-population **48 / 14 / 5 / 0**; 153-population **68 / 61 / 22 / 2**. The one counted file that changed since `16f34dff2` is §22's own fix. §22.3 records that nine of the ten new failure cases are verified and the tenth (`type=travelers`) is NOT — its table is the one `requireUser` reads, so the harness answers 503 before the route is entered. §22.5 names four things that would turn this red, including that `twelve` is what ONE grep string found and not a census of the file. §1's reading rule applies unchanged. **PRE-SQUASH HAZARD**: this repository squash-merges, so once this branch lands `101709b97` is an ancestor of nothing and `check:census-freshness` will report this census unreadable until whoever merges re-declares the squash sha. The previous declaration read: `16f34dff2` — RE-DECLARED 2026-09-15 by §21, replacing `b51c7c9dd`. §21 closed THREE of the four things §20.3 said it had not closed: `type=all` no longer folds a failed bucket into the answer (it names the 17 sources and refuses `partial` with `failedSources`), the suggestion panel no longer prints "No quick matches yet" for a read the server never made, and `app/search.tsx` no longer answers an empty PARTIAL with "Nothing matched". **NO VERDICT MOVES**, for the reason §18.2 first recorded and §21.3 restates: no row grades either screen and no row grades the fan-out, so a census that cannot move when a defect is fixed is not measuring that defect — `DV-83` remains unactioned after four passes. The headline is restated from a fresh `CENSUS_INTEGRITY_DUMP=ALL` at this tree rather than inherited: 187-population **76 / 85 / 23 / 3**, CONSTRUCTED 86.1 %, CORRECT 40.6 %; 67-population **48 / 14 / 5 / 0**; 153-population **68 / 61 / 22 / 2**. The two counted files that changed since `b51c7c9dd` are exactly §21's own fixes — `routes/discoverySearch.ts` and `travel-buddy-standalone/app/search.tsx`. §21.4 names what turns it red, §21.5 what it leaves open. §1's reading rule applies unchanged. **PRE-SQUASH HAZARD**: this repository squash-merges, so once this branch lands `16f34dff2` is an ancestor of nothing and `check:census-freshness` will report this census unreadable until whoever merges re-declares the squash sha. The previous declaration read: `b51c7c9dd` — RE-DECLARED 2026-09-15 by §20, replacing `1ec2b9c4d`. §20 closed the LAST TWO of §18's four consumer defects — `app/search.tsx` (a `coverage: "nothing"` refusal no longer renders the empty state nor fires the Compass "no results" fallback; it takes the screen's existing `error` branch, which already carries a retry) and `app/map/index.tsx` (a refusal no longer clears `placesError`, which is what had been switching the "no places here" zero-results state ON). **NO VERDICT MOVES**: C14 already moved in §19, and §18.2 records that NEITHER screen is graded by any row — five routes and eighteen call sites emit the envelope and are graded by nothing, which §18.2 recommended closing with a new `DV-83` and which remains unactioned. The headline is therefore UNCHANGED from §19.7: 187-population **76 / 85 / 23 / 3**, CONSTRUCTED 86.1 %, CORRECT 40.6 %; 67-population **48 / 14 / 5 / 0**; 153-population **68 / 61 / 22 / 2** — restated here as unchanged rather than silently inherited. The two counted files that changed since `1ec2b9c4d` are exactly §20's own fixes. §20.3 names what this does NOT close: no row grades either screen, no screen renders anything about a `partial` answer, and `type=all` still folds a plans failure to `[]`. §20.4 names the shared assumption all four fixes now rest on. §1's reading rule applies unchanged. **PRE-SQUASH HAZARD**: this repository squash-merges, so once this branch lands `b51c7c9dd` is an ancestor of nothing and `check:census-freshness` will report this census unreadable until whoever merges re-declares the squash sha. The previous declaration read: `1ec2b9c4d` — RE-DECLARED 2026-09-15 by §19, replacing `80e067027`. §19 CLOSED TWO OF THE FOUR consumer defects §18 found — `useSearchSuggestions` (which no longer renders or CACHES a `coverage: "nothing"` refusal, and now exposes `refused`) and `getDiscoveryCategoryCounts` (which no longer contributes a refused category's `total: 0` as a real badge count) — and moved **C14 `W` → `C`** because §18's two named grounds for that `W` are false at this tree. §19.7 restates the headline from a fresh `CENSUS_INTEGRITY_DUMP=ALL` rather than by adding to §18's figure: 187-population **76 / 85 / 23 / 3**, CONSTRUCTED 86.1 % (unchanged), CORRECT **40.6 %**; 67-population **48 / 14 / 5 / 0**; 153-population **68 / 61 / 22 / 2**. The three counted files that changed since `80e067027` are exactly §19's own fixes — `useSearchSuggestions.ts`, `useGlobalSearchSuggestions.ts` and `travel-buddy-standalone/src/services/discovery.ts`. **§19.4 STATES A CONFLICT OF INTEREST ON ITS FACE**: the integrating lane wrote the fix and graded it, which §18 did not, so C14's grounds are written as falsifiable claims and §19.5 names what turns them red. It does **NOT** certify the 44 `W` rows §18.3 records as not individually re-read, nor the nine rows §18 put in a seventh bucket needing a production read, and §19.6 names the TWO consumer defects that are still open (`app/search.tsx`, `app/map/index.tsx`). §1's reading rule applies unchanged. **PRE-SQUASH HAZARD**: this repository squash-merges, so once this branch lands `1ec2b9c4d` is an ancestor of nothing and `check:census-freshness` will report this census unreadable until whoever merges re-declares the squash sha. The previous declaration read: `80e067027` — RE-DECLARED 2026-09-15 by the INTEGRATING LANE on §18's behalf, replacing `80a8d655a`. §18 audited the refusal envelope's CONSUMERS for the first time — ten of them — and found four that render a refusal as an empty answer; it moved **C14 `C` → `W`** against this census's own §17.2 standard, and it restated **all three denominators** at this tree: 67-pop **47/15/5/0**, 153-pop **67/62/22/2**, 187-pop **75 C / 86 W / 23 N / 3 X** — CONSTRUCTED 86.1 % (unchanged), CORRECT 40.6 % → **40.1 %**. A defect was closed and the number went DOWN, which is the census working. A census that has restated every one of its own numbers against a tree is MEASURED there, not merely un-aged, so the declaration MOVES rather than the acknowledgement ledger growing — and that is why there is no `census-discovery.md` entry in `CENSUS_STALENESS_ACKNOWLEDGED.json`. **EXACTLY TWO counted files changed since `80a8d655a`, and both are §18's own work**: `routes/discoverySearch.ts`, where §18 closed the dropped `trips` error that let `type=plans` answer `200 {results: []}` for an outage (the branch production takes — §6 D3: 2420 unapplied, 2550 seeded FALSE), and `docs/discovery/compliance-ledger.json`, the generated record, rebuilt at `80e067027` so it carries C14's move instead of the verdict §18 superseded — it had been stale and nothing said so, which is why that file is now WATCHED. Three consecutive rebuilds produce 187 requirements identically. It does **NOT** certify the 44 `W` rows §18.3 records as not individually re-read, nor the nine rows §18 put in a seventh bucket needing a production read, and §1's reading rule applies unchanged. **PRE-SQUASH HAZARD**: this repository squash-merges, so once this branch lands `80e067027` is an ancestor of nothing and `check:census-freshness` will report this census unreadable until whoever merges re-declares the squash sha. The previous declaration read: `80a8d655a` — RE-DECLARED 2026-09-14 by §17, replacing `3ca68cb06`. §17 re-derived the twenty rows this branch's Discovery changes bear on (thirteen Trails, five creator-economy, DV-64, C14), REFUSED two the lanes proposed (§17.2), and §17.6 records a defect in the ledger generator that had been silently dropping 80 % of the corpus. The 37 counted files that changed are that work. It does **NOT** certify the other 56 `C` rows, and §1's reading rule applies unchanged. The previous declaration read: `3ca68cb06` — RE-DECLARED 2026-09-13 by §10, replacing `820b60638`. §10 re-executed all 13 BUILT-BUT-WRONG rows and ten BUILT-AND-CORRECT ones at this commit; §10.4 names which ten and reports what it found (four stale line numbers, no wrong verdict). It does **not** certify the other 38 `C` rows. The previous declaration read: `820b60638` — RE-DECLARED 2026-09-13 by §9, replacing `42aeac38`. The previous declaration was a NEUTRAL move (0 counted files differ between `090684ab` and `42aeac38`) made by the Trips lane so this census could be aged at all. This one is not neutral and does not pretend to be: `820b60638` is the commit §9 measured at, it carries §9.5's build, and between `42aeac38` and it three sibling lanes edited files this census counts — which is how sixteen unreadable rows and two stale N verdicts survived unnoticed. §9.8 states exactly which rows were re-executed here (all 10 N, all 11 W, 22 of 46 C) and which 24 were not. It does NOT certify the 24. Read §9.1 before quoting any percentage. |
| Originally censused at | working tree `507f8427` plus uncommitted sibling work, 2026-09-07 |
| Recensused | 2026-09-08 — see §8 for the method and what it does not claim |

---

## 1. The denominator, and how it was built

No single document says what Discovery must do. The 67 rows below come from three sources,
each with a different evidentiary weight:

| Source | Rows | What counts as a requirement | What was deliberately excluded |
|---|---|---|---|
| **(a) Inbound obligations** — sentences in *other* surfaces' specs that name Discovery as the surface that must do something | **A01–A25** | `docs/architecture/cross-cutting-obligations.md` §2/§8 was the index; every row was then re-read in the demanding spec under `docs/specs/` and the spec text is quoted, because the registry is one agent's reading and the spec is the authority | Obligations the registry files under Discovery but whose *code* belongs to another surface's census: MP-02 (Pulse ↔ Map contradiction guard lives in `features/map/pulse/pulseMapBridge.ts`, counted by census-map M190–M192), Media MD435/MD446 ("Discovery owns opportunity ranking", "Why This / Find Similar") — Media's own ranker crossing is Media's row; the Wall's Discovery insertion (`services/wall/`, census-wall). SX-54 (Context Kernel) and Highlights `:28` (memory projections reach Discovery) are folded into A01 because they are the *same* absence — no live-intelligence input reaches the ranker |
| **(b) Rows already measured by `census-input-intelligence.md`** for the code Discovery shares with the Global Input Intelligence layer | **B01–B09** | Rows that census marked **W**/**N** *and* whose failing line is in a Discovery-owned file were re-checked (B01–B05). Rows it settled as **C ᵖ** ("pre-existing Discovery work") are carried by reference only where I re-opened the cited line (B06–B09); the rest are not re-litigated and not re-counted | Rows whose failing half is the gateway's, not Discovery's (G97 TemporalFit, G31 privacyClass, G274 QueryNormalizer, G197 client dictionaries, G337) |
| **(c) Discovery's own code contracts** — invariants its module headers, guards and tests already assert | **C01–C33** | A row exists only where the code *states* the invariant (a header rule, a guard with a comment, or a named test) — never inferred from behaviour alone | Implementation choices with no stated contract (cache TTLs, page size, plan ordering) |

Weighting caveat, stated once: the (c) rows are the easiest to satisfy — they are the surface
grading its own homework — and they are 33 of 67. **Read the (a) column on its own before the
headline**: there, Discovery is 10 correct / 5 wrong / 10 not built (was 10 / 3 / 12).

---

## 2. The vet

Buckets: **C** BUILT-AND-CORRECT · **W** BUILT-BUT-WRONG · **N** NOT-BUILT · **CV** CANNOT-VERIFY.
Every C and W cites a `file:line` opened and read on 2026-09-07 (line numbers are post-fix for the
three files this pass edited). Paths are relative to `artifacts/api-server/src/` unless they start
with `docs/`, `db/` or `travel-buddy-standalone/`.

### 2a. Inbound obligations (A)

| # | Obligation (spec, line) | Verdict | Evidence |
|---|---|---|---|
| A01 | Sensing §8 `:133` — *"Rank using live ExperienceState, forecast, travel time, friction, compatibility, freshness, safety and Opportunity value"* | **N** — owner hold | The ranker's declared inputs are taste, graph, behaviour, trails (`lib/discoveryPde.ts:1-60` header; `lib/discoveryModifiers.ts:1-50`). No live state, forecast, friction or travel-time term exists under any name. The one live-ish input, `localMomentum`, is behind `discovery_ranking_modifiers_enabled` (`lib/discoveryModifiers.ts:59,130`), **absent from production** (§5). `docs/discovery/ROADMAP.md:222` — *"RANKER WORK GOES ON EXPLICIT HOLD… No optimising ranking machinery over an empty corpus."* Not built, and not buildable by an agent. |
| A02 | Sensing §8 `:134` — *"Keep search/retrieval truth separate from recommendation ranking; a quiet venue still exists in search"* | **C** | `routes/discoverySearch.ts:1-45` is lexical retrieval with privacy gates and match-tier ordering only; ranking lives in `lib/discoveryPde.ts` and is called from `routes/discovery.ts:1665,2001`, never from the search route. Two paths, no shared ranker. |
| A03 | Sensing §8 `:135` — *"server-built DiscoveryCandidate / projection with why-now, why-for-user, confidence, freshness and truth class"*; §5.1 `:106-108` truth class / confidence / freshness on every server-built state, *"prediction must never be rendered indistinguishably from observation"* | **N → W (built this pass, deliberately in the wrong bucket)** | **Was:** zero occurrences of any of the five fields. **Now:** `lib/discoveryCandidate.ts` — `DiscoveryCandidate { id, whyNow, whyForUser, rankedBy, confidence, freshness{state, ageMs, servedFrom}, truthClass }` (`:95-115`), attached to the outgoing slice at all four `GET /discovery` serialisation sites (`routes/discovery.ts` cache-A serve, Compass hit, Compass fresh rank, cold fetch — pinned by a source guard) behind `discovery_candidate_projection_enabled` (migration **2361, seeded FALSE**, applied to CI; flag OFF ⇒ the helper returns the **same array reference**, served JSON byte-identical). Four of five fields are derived from facts the row already carries, with the mappings stated for ratification (§6 D9): `truthClass` ∈ {corroborated, observed, stale, unknown} from canonical-row / Wikidata / `db/` / OSM id / stale serve (`:151-158`), never inferred/predicted/conflicting; `confidence` a per-class prior (`:141-146`); `freshness` from serve point and cache age (`:161-171`); `whyForUser` the ranker's own positive feature keys, ≤3, **empty whenever no per-user ranker ran** (`:178-186`). **Why still W:** `whyNow` is `null` on every row by construction (`:203`) — there is no live producer (A01), and manufacturing one from static popularity is the §5.1 rendering the spec forbids. Reasons exist for four fields; the fifth is honestly absent. 30 tests; five hand-reverts (§7 F5). |
| A04 | Sensing §8 `:136` — Hidden Gems strengthened with behavioural evidence, *"but create candidates — not automatic canonical gems"* | **C** | `services/hiddenGems/HiddenGemContributionService.ts:7-12` — *"A contribution is an OBSERVATION… it never touches the gem's canonical status"*; state and confidence are derived at read time. (File owned by Hidden Gems; the spec files the obligation under Discovery.) |
| A05 | Sensing §8 `:137` — intent modes *"Right Now, Tonight, Explore, Quiet, Social, High Energy, Nearby, Trip"* on shared intelligence | **N** — owner hold | Nothing in `routes/discovery*.ts` or `lib/discovery*.ts` models an intent mode; the only mode concept is `DiscoveryContextMode` (`routes/discovery.ts:29`), which is a *location* mode (in_city / near_me / going_soon). Compass's nine modes (census-sensing S72) are a different vocabulary on a different surface. Same hold as A01 (`ROADMAP.md:648`). |
| A06 | Sensing `:19` — *"Existing Map / Discovery / Wall / Compass paths must continue to function while new projections are partial or feature-gated"* | **C** | `lib/discoveryEngineMode.ts:151-175` — every failure (absent row, disabled, no mode, invalid mode, engaged stop, unreadable stop, null client, throwing client) resolves to `legacy`; pinned by `test/discoveryEngineMode.test.ts` cases A–L. `migrations/2289:70-74` refuses to commit the modifiers flag ON. |
| A07 | Sensing `:129` — *"Safety constraints outrank opportunity/vibe. A dangerous place must never simultaneously be promoted as 'best move now'"* — Discovery half | **N** | No safety term reaches the ranker (A01 evidence). There is also no world safety state to consume — census-sensing S66 records the Compass half as W and the producer side as absent. Not gated by the hold (a constraint, not an optimisation), but unbuildable until a safety projection exists. |
| A08 | GII `:8` — *"This is not owned by Discovery… Those surfaces consume it through a shared platform layer"*; `:7` core rule; census-input-intelligence G6 — *"four independent engines are still live and unmigrated"* | **W** | **Measured: Discovery owns ONE of the four.** The four G6 engines are `travel-buddy-standalone/src/hooks/useSearchSuggestions.ts` (→ `GET /api/discovery/suggest`, Discovery's), `hooks/useGooglePlacesAutocomplete.ts` (→ `/api/places/google-autocomplete`, Places), `hooks/usePlaceSearch.ts` (→ `/api/places/search`, Places) and `components/MentionInput.tsx` (mentions). Server side, `routes/discoverySearch.ts:2634#router.get("/discovery/suggest",` `/discovery/suggest` is **not a parallel matcher** — it calls the same `dispatchSearch` (`routes/discoverySearch.ts:2718#dispatchSearch(sc, q, user.id, blockedSet, ageRestrictedSet, p.type, 0, p.limit, ctx)`) the gateway calls (`lib/inputAssistance/gateway.ts:27,384`) — but it *is* a second route, and the client runs it **on every keystroke in parallel with the gateway** as a deliberate fallback: `hooks/useGlobalSearchSuggestions.ts:10-12` — *"The legacy hook ALWAYS runs and is the fallback — its proven behavior is never removed"*; `app/search.tsx:24,154` consumes that wrapper. Two requests per keystroke, one canonical path. **Not closed here**: the consolidation is a client change (stop invoking the legacy hook when the gateway is `available`), it removes a fallback users currently have, and the server route cannot be retired while the fallback references it. Owner decision (§6 D1). |
| A09 | Trips `:12` — *"No Map, Compass, Telegraph, Discovery, Buddy, or UI component may independently invent canonical trip state"* | **C** | Every `.from(...)` literal in `routes/discovery.ts` enumerated: `discovery_places` ×8, `discovery_place_saves` ×3, `discovery_place_reports`, `place_votes`, `places`, `profiles` ×2, `reviews`, `collections`, `collection_items`, `user_location_state` — no `trip*` table; `routes/discoverySearch.ts:914,1006#.from(` read `trips` / `trip_plan_items` with `.select` only; **zero `.rpc(` calls** across `routes/discovery*.ts` and `lib/discovery*.ts`. Caveat recorded per `scripts/checkWriterlessReads.ts:39-41`: a literal grep is a floor; no dynamic `.from(expr)` was found in these files either. |
| A10 | Trips `:25`, `:488` — *"Map, Compass, Discovery… consume explicit Trip projections/contracts rather than duplicating Trip semantics"* | **W** | **Stays W; its REASON is superseded — recensused 2026-09-08.** The row said *"No `TripDiscoveryProjection` exists … Not closable from Discovery: the projection is Trips' to publish"* and filed it as owner decision D3. Both halves are now false. **The projection exists and Trips publishes it**: `domain/trips/contracts/tripDiscoveryProjection.ts:225#searchTripDiscoveryProjections` and `:252#readTripDiscoveryProjections`, over `TRIP_DISCOVERY_SOURCE_COLUMNS` (`:136#TRIP_DISCOVERY_SOURCE_COLUMNS`). **Discovery consumes it**: `lib/discoveryTripProjectionConsumer.ts` — the switch, the §19.1 acceptance check and the card mapping, wired into both search paths at `routes/discoverySearch.ts:893#discoveryTripProjectionGate` (trips) and `:1035#discoveryTripProjectionGate` (plans). **Why it is still W, and why that is a DIFFERENT kind of open than before:** the consumer is behind a CAPABILITY, not a bare flag — `capability = discovery_trip_projection_enabled (migration 2550, seeded FALSE) && SCHEMA_CAPABILITY_READY`, because `TRIP_DISCOVERY_SOURCE_COLUMNS` ends in `trips.version` which migration 2420 adds and production does not have. Both projection readers fail CLOSED on a resolved `.error`, so an ungated switch would turn every production trip search into `[]` on a 42703, silently. Until 2420 is applied and the flag lit, the LIVE path is still the duplication this clause forbids (`routes/discoverySearch.ts:918#show_in_discovery`, `:1063#show_in_discovery`). **So this moved from an OWNER-blocked row to a DEPLOYMENT-gated one** — nothing here is waiting on a decision any more, and D3 in §6 is discharged. |
| A11 | Trips `:185` — *"Discovery, Compass, Saved Ideas, and Buddy matching consume these [Temporal Freedom] windows rather than independently calculating 'free time'"* | **N** | `FreedomWindow`: zero occurrences (census-trips TR131 N). Discovery's own arithmetic: `lib/portavaRank.ts:86` (`availableMinutes` — *"Minutes of free window (layover mode / availability) — actionability cap"*) and `:245-248` (*"must start within the window"*). No engine to consume. |
| A12 | Trips `:175` — *"Public Trip content must not leak lodging detail, exact private location, future absence from home, safety state, or unconsented participant data"* — the Discovery leg | **C** | `routes/discoverySearch.ts:915#.select("id, title, destination_city,` selects `id, title, destination_city, destination_country, owner_id, cover_url, start_date, status, visibility, created_at` — no lodging, no coordinates, no safety column, no participant list — and only public rows (`routes/discoverySearch.ts:917#.eq("visibility", "public")`). Recorded, not hidden: `start_date` + destination on a public trip is a Trips-domain public field; whether that is "future absence" is a Trips ruling (census-trips settled only the lodging clause, TR117). |
| A13 | Layover `:66` — *"All surfaces consume the same certified LayoverSnapshot / RecommendationContract; no duplicate time-budget logic"*; `:803` — *"One canonical LayoverSnapshot drives Trips, Compass, Discovery, Map and Safe Return"* | **N** | `LayoverSnapshot`: zero occurrences. `grep -rIn -i layover routes/discovery*.ts lib/discovery*.ts` → nothing; Discovery has no layover reference at all. The duplicate time-budget logic named in L-02 is A11's `portavaRank.ts:86,245`. |
| A14 | Layover §25 `:754` — *"Discovery: Only show experiences from certified action universe in Layover mode"* | **N** | Discovery has no Layover mode. The nearest artefact is `routes/hiddenGems.ts:599-631` `GET /hidden-gems/layover-safe` — a Hidden Gems route, flag-gated, taking `availableMinutes` **from the query string** (`:613`) rather than from any session, and per census-layover L269 never called by the layover dashboard. |
| A15 | Passport `:57` — *"Do not create separate profile systems for self, public, Trips, Buddy, Discovery or Telegraph. Build one Passport projection system with context-specific views"* | **W** | Half satisfied since the census-passport pass: the person **card** is the assembler's (A16). The search **list** still assembles its own identity payload from `profiles` — `routes/discoverySearch.ts:577#.select("id, handle, username, name, display_name, avatar_url` selects `id, handle, username, name, avatar_url, is_private, home_city, home_country, …` and `routes/discoverySearch.ts:631-673#sc.from("user_follows")` applied its own privacy logic (locked preview, `show_profile_picture_publicly`, name rule). **POINTERS REPOINTED 2026-09-13 (§11): `:547` named a JSDoc line inside `searchTravelers`' header — and already did at `3ca68cb06` — and the privacy-logic half of this sentence is superseded by §10.2's A15 W→C, which measured all three rules as the Passport batch projection's; the cited range today is the follow/friend batch that feeds `routes/discoverySearch.ts:661#const identity = await buildListIdentityProjections(sc, nameSafe as any[], {`.** Rules agree with the assembler's today; the construction is the duplication `services/passport/PassportConsumerProjections.ts:6-14` says it exists to end. Not closed: routing every list row through `buildConsumerProjection` is N+1 assembler calls per search and a response-shape change on a live route. Owner decision (§6 D4). |
| A16 | Passport §21 `:213-214` — Discovery variant: *"Identity, verification, availability, Open to Plans, shared context, permitted trust summary"* | **C** | `routes/discoverySearch.ts:2803-2835#router.get("/discovery/people/:userId/passport",` `GET /discovery/people/:userId/passport` → `allowDiscoveryPersonCard` (`:2824#allowDiscoveryPersonCard(sc,`) → `buildConsumerProjection(sc, "discovery_card", …)` (`:2828#buildConsumerProjection(sc,`). **Supersedes census-passport P95 (W — "Nothing calls it")**: it is called, from Discovery, by the route that opens a search row. |
| A17 | Passport `:263` — *"A Passport block must propagate across Discovery… Do not implement blocking independently per surface"*; Telegraph `:285` — *"No subsystem may independently 'rediscover' a blocked relationship"* | **W → C (fixed this pass)** | **Was:** `routes/discoverySearch.ts` carried a byte-for-byte private copy of `lib/blocks.fetchBlockedSet` (the old `:371-388` — a pointer into the pre-fix tree, not into HEAD), while `lib/inputAssistance/gateway.ts:23`, `socialIdentity.ts:27` and `routes/discovery.ts:50` used the shared one — two copies of the bidirectional, fail-closed block reader, agreeing until one is edited. **Now:** `routes/discoverySearch.ts:83#fetchBlockedSet,` imports it and `routes/discoverySearch.ts:434#export { fetchBlockedSet }` re-exports it; `test/discoverySearchBlockedSubmitter.test.ts` pins source *and* function identity (`discoverySearch.fetchBlockedSet === blocks.fetchBlockedSet`). Behaviour byte-identical (same query, same null-on-error). Hand-revert: re-adding the copy → 1 failure (§7). |
| A18 | Passport `:94` — *"Compass and Discovery should weight explicit current intent more heavily than generic interests"* | **N** — owner hold | Supply side exists (`PassportConsumerProjections.ts:106,188,212` expose explicit intent on the card). Demand side: no intent term in `lib/discoveryPde.ts` / `lib/discoveryModifiers.ts` (headers enumerate the inputs; census-passport P42 confirms *"nothing consumes it"*). Cross-cutting P-05 was COULD NOT ESTABLISH; it is now established absent. Ranking machinery → same hold as A01. |
| A19 | Telegraph `:285` — block cascade, the *discovery* leg | **C** | Every Discovery reader applies the shared rule: search/suggest via `fetchBlockedSet` (`:1793,1982`) and `submitterIsVisible` (`:82`); `GET /discovery` and `/discovery/community` via `routes/discovery.ts:50,879,2654`; the person card inside the assembler. Pinned by `test/discoverySearchBlockedSubmitter.test.ts` (12) and `test/discoveryBlockedSubmitter.test.ts` (25), including the *unreadable-blocks-yields-nothing* cases. |
| A20 | Telegraph `:606` — *"Every shareable Portava domain registers preview, authorization, current state, actions, search behavior, and revocation through a Telegraph content capability contract"* | **N → W** | **RE-MEASURED 2026-09-13 BY THE INTEGRATOR, because this row's stated evidence became false in this tree and an acknowledgement cannot silence that.** The old evidence read *"`TelegraphSharedContextProjection` / `contentCapability` / `content_capability`: zero occurrences repo-wide"* and *"blocked on Telegraph publishing the contract shape"*. The Telegraph §1–§11 lane published it: `services/telegraph/shareables.ts:80` declares the per-object interface — `getSharePreview(viewerId)`, `getCurrentState(viewerId)`, `getAvailableActions(viewerId, conversationId)`, `getDeepLink()` — and `:498` registers a loader for fifteen object families including `PLACE`, `MAP_PIN` and `HIDDEN_GEM`, the ones Discovery shares. Five of the six capabilities §5 names are now registered through one contract: **preview** (`getSharePreview`), **authorization** (each loader refuses per viewer and returns `UNAVAILABLE("private"|"unauthorized"|"not_found"|"deleted")` rather than a projection), **current state** (`getCurrentState`), **actions** (`getAvailableActions`, drawn from §8.1's fourteen at `shareables.ts:141`) and **revocation** (§5.3 — `DiscoveryCardMessage.tsx` no longer renders the sender's frozen JSON but re-resolves for the viewer on mount through `features/telegraph/sharing/useShareRevocation.ts`, showing a revoked notice when the source is gone, and treating `unknown` as its own state rather than as "revoked"). **W and not C, on the one capability that is missing: SEARCH BEHAVIOUR.** The contract has no search member and nothing registers Discovery objects for conversation search, so the requirement's six-item list is five-sixths satisfied. **What this re-measure does NOT claim:** it re-reads A20 alone, against the evidence its own text names, because that evidence is now contradicted by the tree; no other census-discovery row was re-read, and the Discovery headline is NOT restated here — moving it is the Discovery lane's to do. `grep -i discovery routes/messaging.ts routes/telegraph.ts` → nothing: the Discovery card that can be shared (`travel-buddy-standalone/src/components/DiscoveryCardMessage.tsx`) is a client-only rendering with no server-side preview/authorisation/revocation contract. Blocked on Telegraph publishing the contract shape (census-telegraph §30.16). |
| A21 | Telegraph `:607` — each source domain registers *"authorize, preview, execute, and optional compensate"* | **N** | Same absence as A20; no registration mechanism exists to register into. |
| A22 | Telegraph `:87` — *"Availability expires automatically and revokes across Telegraph, Discovery and Compass"* | **C** | The only availability Discovery emits is the person card's (`DiscoveryCardAvailability`, `PassportConsumerProjections.ts:205`), built from `loadVisibleActiveWindows(sc, ownerId, context, nowMs)` (`:468,509`) — active windows re-evaluated against the read clock, never a stored copy. The search list carries no availability field (`:529` select), so there is nothing there to revoke. |
| A23 | Telegraph `:621` — *"Unavailable… revokes Nearby, Discovery, and Compass availability projections promptly"* | **C** | Same path as A22: an ended or cancelled window is not an active window at `nowMs`. |
| A24 | Telegraph `:621` — *"…or Invisible revokes… Discovery… availability projections"* | **N** | census-telegraph T29: *"No invisible mode."* `grep -i invisible services/passport/PassportConsumerProjections.ts` → nothing. There is no Invisible state anywhere for Discovery to honour; owed first by Telegraph. |
| A25 | Map `:11`, §20 `:202-203` — Discovery owns *"Candidate relevance"*; the Map consumes projections from each owner | **N → W (Discovery half built; Map half absent)** | **Was:** no Discovery reader existed for the Map gateway to call (`routes/mapProjection.ts:14-27` lists travelers / gems / events / circle / trips). **Now:** `lib/discoveryCandidate.ts:236-268` `readDiscoveryCandidatesForViewer(sc, places, viewerId, city)` — the privacy-complete owner reader Map §20 expects: it **does not retrieve** (the Map hands it rows it already holds), ranks with `served: false` so the ranker gets a client that cannot write (pinned: a recording fake sees zero insert/upsert/update/delete/rpc), and an anonymous viewer gets `rankedBy: "none"` with no client touched. Precondition stated, not assumed: rows are already block-filtered. **Why W:** it has **no consumer** — the Map gateway is another agent's file (§6 D10) — and a reader nobody reads is, per `ROADMAP.md`'s fourth face, not yet a signal. |

### 2b. Rows shared with the Global Input Intelligence census (B)

| # | GII row | Verdict | Evidence |
|---|---|---|---|
| B01 | G57 — diacritic-insensitive matching, the **stored** side | **W** — deployment | Code is correct (census-input-intelligence G57). **Re-verified 2026-09-07: `canonical_locations.search_key` is absent from production** (`information_schema.columns` → 0), so migration 2220 is still unapplied and the fold degrades to the broken `normalized_name` in production. Operator apply, not a code change; the owning module is `lib/canonicalLocations.ts`, outside this pass's files. |
| B02 | G62 — punctuation/emoji handling appropriate to field | **W** | `routes/discoverySearch.ts:151-153#export function sanitizeQuery` `sanitizeQuery` strips only `(),`; an emoji survives into the `ilike` pattern and matches nothing. Not changed: stripping emoji would make `"🔥 bar"` start matching `bar` — a user-visible result change on a live route with no flag. Owner decision (§6 D5). |
| B03 | G71 / G283 — Buddy: *"service category, availability, launch/safety/payment eligibility"* | **W → partially closed** | **Was:** the only buddy predicate was `buddy_verified_at IS NOT NULL` (`routes/discoverySearch.ts:584#buddy_verified_at`), with the marketplace master switch `rent_buddy_enabled` (**false in production**) never consulted. **Now:** the **launch** leg is built — `routes/discoverySearch.ts:516-519#export async function buddiesWithheldByLaunchGate` `buddiesWithheldByLaunchGate`, applied at `:572#buddiesWithheldByLaunchGate(sc)` inside `searchTravelers(isBuddy)` so the gateway inherits it — behind `discovery_buddy_launch_gate_enabled` (migration 2360, **seeded FALSE**, applied to CI; rollback `db/rollback/2026-09-07-2360-discovery-buddy-launch-gate-rollback.sql`). Both reads fail-closed in the safe direction each (gate unreadable → legacy; marketplace unreadable → withheld). 8 tests; two hand-reverts → 2 and 5 failures (§7). **Still open:** category and availability legs — a buddy row carries no service category to filter on and the list has no availability field. Stays W. |
| B04 | G190 — sensitive-location and protected-place rules before projection | **W** | The gem rule is real (`:1028` selects `sensitivity_level, approx_latitude, approx_longitude`, exact pair deliberately absent). `lib/protectedLocations.ts` is consulted by nothing in `routes/discovery*.ts` / `lib/discovery*.ts` (grep → nothing), and `protected_zones` is absent from production (§5). A protected zone that is not a gem has no effect on a Discovery result. Not changed: the table does not exist where it would matter. |
| B05 | G277 — CountryResolver | **W** | `routes/discoverySearch.ts:1999-2020#async function searchCountries(` `searchCountries` aggregates `profiles.home_country` (`:1896#.ilike("home_country",`): a country with no users in it does not exist as a suggestion. Privacy-filtered (`:1904#.eq("allow_profile_discovery",` opt-outs), so not a leak; a construction defect. Fix needs a canonical country registry Discovery does not own. |
| B06 | G68 — Hidden Gem separate identity/protection/approximate location | **C** (by reference, line re-opened) | `:1028`; census-input-intelligence G68. |
| B07 | G70 / G185 — Trip/Event/Plan viewer eligibility before exposure | **C** (by reference, lines re-opened) | `:670` events, `:772-773` trips, `:838-860` plans; proven through the gateway by `test/inputAssistanceCertification.test.ts:330-366`. |
| B08 | G126 — age restrictions | **C** (by reference, line re-opened) | `:397-407` `fetchAgeRestrictedSet`, null on error → callers return `[]`. |
| B09 | G129 — protected locations whose exact position cannot be surfaced (gems) | **C** (by reference) | `:1028` never selects a gem's exact pair; `InputSuggestion` has no coordinate field. |

### 2c. Discovery's own code contracts (C)

| # | Contract (where stated) | Verdict | Evidence |
|---|---|---|---|
| C01 | Suspended/banned/deleted accounts excluded (`routes/discoverySearch.ts:15#Suspended/banned/deleted` header) | **C** | `routes/discoverySearch.ts:580#.in("account_status",` — `searchTravelers`' `.in("account_status", ["active"])`. |
| C02 | Profile-discovery opt-outs excluded, fail-closed on query error (header `:16`) | **C** | `:548-556`; `noDiscErr → return []`. Test: *"excludes profiles that opted out of discovery (fail-closed on opt-out error)"*. |
| C03 | Blocked users excluded both directions; unknown block state → empty search (header `:17-18`) | **C** | `lib/blocks.ts:21#fetchBlockedSet` (null on error), consumed at `routes/discovery.ts:1721#fetchBlockedSet`, `:2643#fetchBlockedSet` and `:3043#fetchBlockedSet`; every per-type searcher returns `[]` on null. Tests: *"returns empty results when the blocks table returns a DB error"*. |
| C04 | Content from suspended/banned/deleted owners excluded (header `:19-20`) | **C** | `:479-494` `fetchActiveOwnerSet`, empty set on error (exclude, never leak). |
| C05 | Private trips/events/circles: only `visibility='public'` (header `:21`) | **C** | `:670` events, `:772` trips, `:1225` circles, `:1149` posts (published-and-public gate). |
| C06 | Plans only from public or caller-owned trips (header `:22`) | **C** | `:828-860`. |
| C07 | Private fields never selected (header `:25-26`) | **C** | `:529` — no email, phone, coordinates, safety, verification-document columns; `:1028` gems without the exact pair. |
| C08 | Age-restricted profiles hidden fail-closed (header `:27-35`) | **C** | `:397-407`; `:523` returns `[]` on null. |
| C09 | Hidden names are not searchable — a hidden-name match survives only if handle/username matched (`routes/discoverySearch.ts:614#Universal` comment; `.agents/memory/display-name-privacy.md`) | **C** | `routes/discoverySearch.ts:620#nameSafe` — a row whose only match was the hidden name is dropped; the viewer's own row is never redacted. |
| C10 | The viewer is never redacted (self-exemption before opt-in) | **C** | `:567` (filter) and `:603` (presentation). |
| C11 | Header `:9` said *"Private accounts (is_private=true) excluded entirely"* | **W → C (fixed)** | The code has returned them as a locked preview since the `/users/search` parity change (`:611-618`; `searchTravelers` doc `:503-508`; tests *"returns profiles with is_private=true as a locked preview, not excluded"*). A contract stating the opposite of its tests is a defect of the contract. Header rewritten (`:9-14`); zero behaviour change, no test. |
| C12 | `hasMore` derived from limit+1 overflow, no false positives (header `:38-40`) | **C** | `:1885`. |
| C13 | Rate limited 30 req/min per user (header `:48`) | **C** | `:1842` (search, 30/60 s); `:2022` (suggest, 90/60 s). |
| C14 | Suggest is fail-soft: any internal error → `200 { groups: [] }` (`:2006-2016` comment) | **C** | `:2016`, `:2053`, `:2108`. |
| C15 | Suggest reuses `dispatchSearch` — *"deliberately NOT a parallel search implementation"* (`:2006` comment) | **C** | `:2064` calls `dispatchSearch` (`:1593`); no second matcher. (The *route* duplication is A08's finding; the *engine* claim here holds.) |
| C16 | `GET /discovery` needs no auth and returns only public place data; `submitted_by` never serialised (`discovery.ts:1-5`; test *"never serialises submitted_by to the client"*) | **C** | `routes/discovery.ts:1393` optional auth; `test/discoveryBlockedSubmitter.test.ts` *"submitted_by is never mapped onto the DiscoveryPlace that toPublic returns"*. |
| C17 | The community submitter block rule is `lib/blocks.submitterIsVisible`, shared, not re-implemented (`discovery.ts:874-879`) | **C** | `routes/discovery.ts:50,879`; applied at `:2757` before names are resolved (`:2761`). |
| C18 | Viewer sees their own byline on a place they submitted (`f37e1cf0`) | **C** | `routes/discovery.ts:2675` (memoised viewer, guarded on `rows.length`), `:2694`. Tests *"shows the viewer their OWN name…"*, *"still redacts everyone ELSE"*, *"does not exempt the submitter from an ANONYMOUS caller's view"*. Not redone; the pattern was reused for C19. |
| C19 | Display-name redaction shape (`.agents/memory/display-name-privacy.md`: null name + separate handle) | **W → partially closed** | **Measured, and the lead was half wrong:** the search list's shape is `title` = name-or-bare-handle, `subtitle` = `@handle` (`routes/discoverySearch.ts:684#subtitle`) — there is no `name` field — which is the **same** shape as Compass (`routes/compass.ts:3825-3843#title: nameOk`, `title` bare username / `displayName` null — REPOINTED AT INTEGRATION: both lanes carried this citation at the reason-code scoring block, which is not the card shape it claims; the shape is the `title`/`data.displayName` pair above). Discovery's one divergent shape is the community byline, which bakes the literal `@username` **into `name`** (`discovery.ts:3072#name`). It cannot be changed in place: `travel-buddy-standalone/src/components/DiscoveryWall.tsx:407` renders `By {submittedBy.name}` raw, so a null there is a blank byline — a user-visible change with no flag. **Now:** the canonical shape is emitted **additively** as `displayName` (`routes/discovery.ts:3091#displayName`: real name iff self or opted-in, else null, never a handle) alongside the unchanged legacy field, from one `nameAllowed` decision (`:2694`) so the two fields cannot disagree about *whether* a name is withheld (pinned: *"the two byline fields never disagree…"*). The legacy `name` stays until the client resolves the byline through `displayIdentity(displayName, handle)` (§6 D2). Stays W until then. |
| C20 | Engine mode resolves to `legacy` on every failure path (`lib/discoveryEngineMode.ts` header) | **C** | `:151-175`; tests A–L. |
| C21 | An unreadable/absent/malformed cohort includes NOBODY; `kind:"all"` must be typed (`lib/discoveryCohort.ts` header) | **C** | `:85` `COHORT_NONE`, `:102` `NOBODY(...)` for every parse failure; tests N2–N6. |
| C22 | Shadow never changes what was served and writes only to `discovery_shadow_serves` (`lib/discoveryShadow.ts` header) | **C** | `routes/discovery.ts:1912#served` (`served: false`, handed a client that cannot write), invoked after the response is sent (`:1947#served`); `lib/discoveryShadow.ts:371#discovery_shadow_serves` the single insert; tests G, I. (Re-anchored 2026-09-08: both line numbers had drifted 30-odd lines when the silent-write burn-down `2550b8ba` edited this file. The claim held; the pointers did not.) |
| C23 | `rankForViewer(..., { served: false })` performs no write; the suppression is load-bearing (`lib/discoveryPde.ts:84-90`) | **C** | Tests D, D2 (positive control), S, S2. |
| C24 | Modifiers flag OFF → inert record, no momentum or confidence read (`lib/discoveryModifiers.ts:37-50`) | **C** | `:68` (*"Everything below is inert when false"*), `:130` the one read. |
| C25 | Serve log inert until seeded; a rejected insert is reported, never thrown (`lib/discoveryServeLog.ts:23-45`) | **C** | `:200-205` cached fail-closed read; tests A, B, B2, J, K. **Deployment:** the flag is **ON in production** and the writer is live — but `surface='discovery'` holds 13 rows ever, last 2026-08-15 (§5). Not a silent write loss (rows landed when the surface was reached); the surface is not reached. |
| C26 | L2 cache rows are purged **past** expiry, never **at** expiry, because stale rows are served (`lib/discoveryCacheCleanup.ts:20-33`) | **C** | `:20-33`; `test/discoveryCacheCleanup.test.ts`. |
| C27 | Photo store never stores a credential (Google resource name, URL minted per read); rows expire (`lib/discoveryPlacePhotoStore.ts:21-30,37-45`) | **C** | `:105`, `:162-169` (`photo_ref`, `expires_at`, `invalid_at`). |
| C28 | `discovery_places` client write boundary (`migrations/2153`; `test/discoveryPlaceWriteBoundary.test.ts`) | **C** — verified in the catalog, not by the suite | The suite **skips without live credentials** (`:28` *"SKIPPING — no live credentials"*) and the `test` script pins `SUPABASE_URL=127.0.0.1:9`, so a green run proves nothing here. Verified directly 2026-09-07 in **both** databases: `authenticated` and `anon` hold `SELECT` only; `service_role` FOR ALL. The four client write policies (`discovery_places_auth_insert` WITH CHECK `auth.uid() IS NOT NULL`, `own_/owner_update`, `own_/owner_delete`) are **decorative** — 2153 chose to leave them (`:37-40`) — so the boundary is one re-`GRANT INSERT` away from a forge policy that constrains no column. Recorded as §6 D6. |
| C29 | Serve-point report refuses a verdict on an empty window; contradictory windows are refused (`lib/discoveryServePointReport.ts:427,568`) | **C** | Tests *"--days with --since is refused"*, *"--until without --since is refused"*, *"…so the D5 population is empty"*. |
| C30 | Momentum is strictly non-negative with a minimum-evidence floor (`lib/discoveryLocalMomentum.ts:25-45`) | **C** | `:67` `MOMENTUM_MIN_RECENT_WEIGHT = 3`, `:150` floor, `:153` clamp to `[0,1]`. |
| C31 | Stale L2 entries are served while a background revalidation runs (`.agents/memory/discovery-perf-cache.md`; `discoveryCacheCleanup.ts:22-27`) | **C** | `routes/discovery.ts:1880`. |
| C32 | One ranking pipeline in the tree — the route no longer imports the ranker directly (`routes/discovery.ts:43-47`) | **C** | `:43-47` (type-only import of `portavaRank`), `:47` `rankForViewer`; test T *"discovery still declares those inputs constant, in source"*. |
| C33 | The two `profiles` reads in `routes/discovery.ts` are the caller's **own** `date_of_birth` for the age filter, not identity payloads | **C** | `routes/discovery.ts:1686#resolveGateAge(sc,` and `routes/discovery.ts:2924#resolveGateAge(ageSc,` — `.select("date_of_birth").eq("id", <caller>)`. **Settles the census-passport P95 citation** (`discovery.ts:1504,2523`) as weak evidence, exactly as the sibling agent judged; the real direct person-identity readers are `routes/discoverySearch.ts:577#.select("id, handle, username, name, display_name, avatar_url` (A15) and `routes/compass.ts:3549#"id, username, display_name, name, avatar_url,` (Compass's traveler list, reported not changed — REPOINTED §11: `compass.ts:3378` is a date computation in the traveller scoring block, and `:1505`/`:2545` were a blank line and a `createdAt: string;`). |

### 2d. Tally

| Bucket | A (inbound) | B (shared) | C (own) | Total |
|---|---|---|---|---|
| BUILT-AND-CORRECT | 10 | 4 | 32 | **46** |
| BUILT-BUT-WRONG | 5 | 5 | 1 | **11** |
| NOT-BUILT | 10 | 0 | 0 | **10** |
| CANNOT-VERIFY | 0 | 0 | 0 | **0** |
| | 25 | 9 | 33 | **67** |

CONSTRUCTED = (46+11)/67 = **85.1 %** · CORRECT = 46/67 = **68.7 %**. Inbound column alone: 40.0 % correct, 60.0 % constructed (was 52.0 %).

A03 and A25 were placed in BUILT-BUT-WRONG rather than BUILT-AND-CORRECT on purpose, and the
reasons are in their rows: a projection with one field that can only ever be null, and a reader with
no reader. Counting either as correct would be the headline inflating itself.

On the empty CANNOT-VERIFY bucket, since the brief warns about it: three rows started there and
were moved by construction evidence rather than left — C28 (catalog read in both databases), A18
(the ranker's input list is enumerated in its headers; the term is absent), A20/A21 (the
registration mechanism itself has zero occurrences, so "not registered" is not a runtime question).

---

## 3. The leads, measured

| Lead | Outcome |
|---|---|
| *"Four unmigrated autocomplete engines… likely your highest-value item"* | **FALSE as framed.** Discovery owns **one** of the four; two are Places', one is mentions. Discovery's server route is not a second matcher (it calls the gateway's `dispatchSearch`), and its client hook is wired as a **deliberate, documented fallback** to the gateway, not a stray. The divergence is real (two requests per keystroke) but the consolidation is a client-side fallback removal — not closable inertly from Discovery's files. A08. |
| *"Three redaction shapes; Discovery contains two"* | **HALF FALSE.** Discovery's search shape (`title` bare-handle / `subtitle` `@handle`) is the **Compass** shape, not a separate one. Discovery has **one** divergent shape (community `name` = `"@username"`). Consolidated additively (`displayName`); the legacy field is client-pinned. C19. |
| *"`f37e1cf0` fixed the viewer-self exemption; read it as the pattern"* | **CONFIRMED**; not redone; the same `nameAllowed` decision now feeds both byline fields. C18/C19. |
| *"`discovery.ts:1504,2523` are the caller's own `date_of_birth`, weak evidence; real readers are `discoverySearch.ts:438` and `compass.ts:3376`"* | **CONFIRMED** (post-edit lines `routes/discovery.ts:1686,2924#resolveGateAge(`; `routes/discoverySearch.ts:577#.select("id, handle, username, name, display_name, avatar_url`; `routes/compass.ts:3549#"id, username, display_name, name, avatar_url,`). The line numbers inside the QUOTE are the sibling census's own and are stale; they are left as quoted. C33, A15. |
| census-passport **P95 W — "Nothing calls it"** | **Superseded**: `routes/discoverySearch.ts:2828#buildConsumerProjection(sc,` calls the `discovery_card` variant. A16. |
| cross-cutting **P-05 "COULD NOT ESTABLISH"** | **Established absent.** A18. |

---

## 4. The NOT-BUILT rows, sorted by why

| Explicit owner hold (`ROADMAP.md:222,648`; not agent work) | Blocked on a contract another surface has not published |
|---|---|
| A01 live ranking inputs · A05 intent modes · A18 intent weighting | A07 (no safety projection — Sensing) · A11 (no Temporal Freedom Engine — Trips) · A13/A14 (no `LayoverSnapshot` — Layover) · A20/A21 (no content capability contract — Telegraph) · A24 (no Invisible mode — Telegraph) |

Three and seven. None was built here: the first three may not be, the seven cannot be consumed
before they exist. A03 and A25 left this table for BUILT-BUT-WRONG (§2a).

---

## 5. Deployment reality (read 2026-09-07; production read-only, aggregates only)

| Fact | Production `ajrurzioarfkagpuxfnb` | CI `hwokxgbmezheskbzskfr` |
|---|---|---|
| `discovery_places` / `_saves` / `_reports` / `_photos` / `_cache` / `_geocode_cache` / `_shadow_serves` rows | 184 / 0 / 0 / 15 / 76 / 20 / 0 | all 0 |
| `rank_events` rows, and `surface='discovery'` | 234,224 total; **discovery: 13 rows, latest 2026-08-15**; no surface has a row in the last 7 days (latest anything: 2026-08-27) | 0 |
| `DISCOVERY_ENGINE_MODE` | enabled=false, `metadata.mode=legacy` | same |
| `disable_discovery_pde` (stop) | false (disengaged) | same |
| `discovery_serve_log_enabled` | **true** — writer live | **absent** |
| `discovery_ranking_modifiers_enabled` | **absent** | false |
| `discovery_buddy_launch_gate_enabled` (new, 2360) | **absent — not applied to production, by design** | false (applied this pass) |
| `discovery_candidate_projection_enabled` (new, 2361) | **absent — not applied to production, by design** | false (applied this pass) |
| `memory_projection` | false | false |
| `COMPASS_V1_RULE_BASED_ENABLED` (for_you tab pipeline) | true | **absent** |
| `rent_buddy_enabled` | false | (not queried) |
| `canonical_locations.search_key` (migration 2220) | **absent** | (schema-only project) |
| `protected_zones` | **absent** | present, 0 rows |
| `user_privacy_settings` (age-restriction source) | 0 rows | 0 |
| profiles: active / buddy-verified / opted into real name | 58 / **0** / 26 | — |
| `blocks` rows | 0 | — |
| `discovery_places` grants (`authenticated`, `anon`) | SELECT only | SELECT only |

What this means: **every Discovery engine path other than `legacy` is dark in production by flag**,
and the legacy path itself is essentially unreached (13 serves, none in three weeks — the ROADMAP's
constraint 2, *"BARELY REACHABLE"*, verified again). The code measured above as correct is correct
and dormant. Nothing in this pass changes that: the one new flag is seeded FALSE and not applied to
production.

---

## 6. Owner decisions (reported, not taken)

| # | Decision | Where it bites |
|---|---|---|
| D1 | **Retire the legacy typeahead fallback.** `useGlobalSearchSuggestions` runs `useSearchSuggestions` on every keystroke alongside the gateway. Stopping it when the gateway reports `available` halves request volume and closes A08 — and removes a fallback users have today. If taken, `GET /discovery/suggest` can then be retired. Client change (`travel-buddy-standalone/src/hooks/`). | A08 |
| D2 | **Migrate the community byline to `displayName`.** `DiscoveryWall.tsx:407` and `useCommunityDiscovery.ts:37` should resolve `displayIdentity(displayName, handle)`; then `name` can stop carrying `@username` and C19 closes. Client change, then a server follow-up. | C19 |
| D3 | ~~**Trips publishes a `TripDiscoveryProjection`**; Discovery's `searchTrips`/`searchPlans` consume it instead of re-deriving visibility. Trips-owned.~~ **DISCHARGED 2026-09-08** — Trips published it (`domain/trips/contracts/tripDiscoveryProjection.ts`) and Discovery consumes it (`lib/discoveryTripProjectionConsumer.ts`, wired at `routes/discoverySearch.ts:893#discoveryTripProjectionGate` and `:1035#discoveryTripProjectionGate`). Nothing here awaits a decision. What remains is deployment: migration **2420** (`trips.version`, which the projection's column list requires) is unapplied in production, and `discovery_trip_projection_enabled` (**2550**) is seeded FALSE. See A10. | A10 |
| D4 | **Whether the search list should be assembler-built.** Routing list rows through `buildConsumerProjection` ends the last identity duplication but costs N+1 assembler calls per search and changes the response shape of a live route. | A15 |
| D5 | **Emoji in queries.** Stripping them changes which results a query returns. | B02 |
| D6 | **Drop the decorative `discovery_places` client write policies** (`auth_insert`, `own_*`, `owner_*`) so the boundary is not one re-`GRANT` from a column-unconstrained forge. 2153 deliberately left them; a 236x migration can remove them idempotently. Hardening, not a defect today. | C28 |
| D7 | **Apply 2220 to production** (`search_key`), or accept the degraded fold. Operator step. | B01 |
| D8 | **Flip `discovery_buddy_launch_gate_enabled`** once the marketplace launch rule is wanted on the search surface; apply 2360 to production first. Today it changes nothing (0 buddy-verified profiles). | B03 |
| D9 | **Ratify or replace the `DiscoveryCandidate` mapping defaults** in `lib/discoveryCandidate.ts` (header): the truth-class rules (canonical/Wikidata ⇒ corroborated; OSM/community-active ⇒ observed; L2_stale ⇒ stale), the per-class confidence priors (0.8/0.6/0.4/0.2), and the ≤3-feature `whyForUser`. Then apply 2361 to production and flip `discovery_candidate_projection_enabled`. Until ratified the flag stays OFF and the projection reaches no client. | A03 |
| D10 | **Map gateway consumes `readDiscoveryCandidatesForViewer`** (`routes/mapProjection.ts:14-27` owner-reader list) — Map-owned; the reader is built and write-free. | A25 |

---

## 7. What this pass changed, and the proof

| Fix | Files | Rows closed | Hand-revert | Failures | Restore |
|---|---|---|---|---|---|
| F1 — `fetchBlockedSet` is `lib/blocks`', not a private copy | `routes/discoverySearch.ts:83#fetchBlockedSet,`, `routes/discoverySearch.ts:421-434#Blocked-user set (fail-closed)`; `test/discoverySearchBlockedSubmitter.test.ts` (+1 test, +1 regex relaxed to sibling imports) | A17 W→C | R1: re-add the private copy, drop the import | **1** (`discoverySearchBlockedSubmitter`, 11/12) | `diff -q` clean |
| F2 — canonical `displayName` on the community byline | `routes/discovery.ts:2425-2450` (type), `:2688-2704`; `test/discoveryBlockedSubmitter.test.ts` (+4 tests) | C19 W→W (half) | R2: delete the field · R2b: emit `@handle` when withheld (the wrong consolidation) | **4** / **4** (21/25 each) | `diff -q` clean ×2 |
| F3 — buddy launch-eligibility gate behind a FALSE-seeded flag | `routes/discoverySearch.ts:458-519#Buddy launch-eligibility gate`, `routes/discoverySearch.ts:572#buddiesWithheldByLaunchGate(sc)`; `migrations/2360_discovery_buddy_launch_gate_flag.sql`; `db/rollback/2026-09-07-2360-discovery-buddy-launch-gate-rollback.sql`; `test/discoverySearch.test.ts` (+8 tests) | B03 W→W (launch leg) | R3a: remove the call site · R3b: predicate ignores the gate (the not-inert way) | **2** / **5** (64/66, 61/66) | `diff -q` clean ×2 |
| F4 — header contract matches the code on private accounts | `routes/discoverySearch.ts:9-14` | C11 W→C | none — documentation, no test | — | — |
| F5 — server-built `DiscoveryCandidate` projection + Map-facing reader, behind a FALSE-seeded flag | `lib/discoveryCandidate.ts` (new); `routes/discovery.ts` four serve sites + `serveCachedPlaces` now carries `cachedAt`; `migrations/2361_discovery_candidate_projection_flag.sql`; `db/rollback/2026-09-07-2361-discovery-candidate-projection-rollback.sql`; `test/discoveryCandidate.test.ts` (new, 30 tests, registered) | A03 N→W · A25 N→W | R5a helper ignores the flag · R5b cold site bypasses the helper · R5c manufactured `whyNow` · R5d cold path `rankedBy` from a truthy Map · R5e Map reader ranks `served:true` | 4 / 1 / 2 / 1 / 1 (of 30) | `diff -q` clean ×5 |

Post-restore: `discoverySearch` 66/66, `discoverySearchBlockedSubmitter` 12/12,
`discoveryBlockedSubmitter` 25/25, `discoveryCandidate` 30/30, and the other `GET /discovery`
suites the F5 wiring passes through — `discoveryFeed` 30/30, `discoverySurfaceInstrumentation` 7/7,
`discoveryPdeServePath` 2/2 — all exit 0. One new test file (`discoveryCandidate.test.ts`) was
registered in sorted position;
`check:test-registration` re-run last (§8). `check:flag-polarity` exit 0 with the new flag (a
`*_enabled` capability read via `isFlagEnabled` with a literal name, seeded in `src/migrations/`).
`pnpm typecheck` exit 0. `pnpm typecheck:tests`: 901 diagnostics / 122 files against the 880 / 118
baseline — the four files above baseline are `highlightsBlockFailClosed`, `highlightsFeedFiniteness`,
`mapSensingProjectionGates`, `memoryLocationPrecision`, all sibling-agent files; **no Discovery test
file is above baseline**.

## 8. A note on RLS, because a sibling found policies that lied

Three PERMISSIVE policies elsewhere on this branch carried `USING (auth.uid() IS NOT NULL)` as their
whole predicate and, being OR-ed, dominated the careful policy beside them. Checked for Discovery:
**no Discovery visibility guarantee rests on a policy.** Every Discovery read goes through the
service client (`getServiceClient()` at `routes/discovery.ts:1592`, `routes/discoverySearch.ts:2434#getServiceClient();`),
which bypasses RLS, so the guarantees are the application filters this census cites (C01–C10,
C17, A19). The only posture Discovery *relies on* is the `discovery_places` **GRANT** (C28), which
is a grant, not a policy — and the decorative write policies beside it are recorded as D6 precisely
because a future `GRANT` would let `discovery_places_auth_insert` (`auth.uid() IS NOT NULL`, no
column constraint) do exactly what the sibling's three did.

## 9. Suite

The coordinator runs the one authoritative full suite once the tree is quiescent (`a7012986` was
green — 13872/3395, 0 fail — before F5). The suites named in §7 were run directly after every edit,
judged by exit code; `check:test-registration` was the last command run.

---

## 8. Recensus at `090684ab` — and the census is now checkable

The §2 pass above was taken at working tree `507f8427` *plus uncommitted
sibling-agent work*, which is not a commit anyone can check out. This section
re-reads it at `090684ab54489d23707a0fd5e3f8ed661072a34f` and adds the
`head_commit` row §0 now carries, so `check:census-freshness` can age it instead
of reporting CANNOT BE CHECKED.

### Method — a diff review, which is stronger than the Wall's re-read

Discovery's scope is five files, and **ten commits** touched them between
`507f8427` and `090684ab`. Small enough to review as a diff rather than by
re-opening 67 rows, so that is what was done, plus:

- every one of the **139 citations** was machine-verified to resolve in range
  (`check:doc-citations`, which now covers all of `docs/architecture/`);
- the **contracts the seven blocked `N` rows wait on** were re-grepped:
  `TemporalFreedom` / `freeTimeWindow` (A11), `LayoverSnapshot` (A13, A14) and
  any Telegraph content-capability contract (A20, A21) have **zero occurrences**
  in the tree. All seven remain blocked on another surface, unchanged;
- the three explicit owner holds (A01, A05, A18) are unchanged.

### What moved

**No verdict changed. One row's REASON was wrong, and one owner decision is
discharged.**

**A10** said *"No `TripDiscoveryProjection` exists … Not closable from Discovery:
the projection is Trips' to publish"* and filed it as owner decision **D3**. Both
halves are now false. Trips published it (`domain/trips/contracts/tripDiscoveryProjection.ts`) and
Discovery consumes it (`lib/discoveryTripProjectionConsumer.ts`), wired into both
search paths behind a capability — not a bare flag — because
`TRIP_DISCOVERY_SOURCE_COLUMNS` ends in `trips.version`, which migration 2420
adds and production does not have.

It stays **W**, because the live path is still the duplication the clause
forbids until 2420 is applied and `discovery_trip_projection_enabled` (2550,
seeded FALSE) is lit. But it changed KIND: **from an owner-blocked row to a
deployment-gated one**, and **D3 is discharged**. That distinction is the whole
point of separating the two — an owner row waits on a person, a deployment row
waits on an apply, and treating them alike is how a decision nobody needs to make
stays on a list for months.

**C22** was re-anchored: both `routes/discovery.ts` line numbers had drifted
about thirty lines when the silent-write burn-down (`2550b8ba`) edited that file.
The claim held; the pointers did not — which is the in-range-but-wrong class, and
the reason the repaired citations now carry anchors.

### What this section does NOT claim

It does not claim all 46 `C` rows were re-opened and re-read. It claims the diff
of the scope was reviewed, every citation resolves, and the specific facts the
open rows depend on were re-checked. That is the basis on which the `head_commit`
is declared, and it is stated here so the declaration can be judged rather than
trusted.

Discovery remains **dark in production** (§5). Nothing above changes that.

---

## 9. Re-measured 2026-09-13 — sixteen rows the tallier could not read, and the sixth capability built

*Measured at `820b60638`, the commit above this one, which carries the build in §9.5 and nothing
else. Declared as `head_commit` in §0, replacing `42aeac38`; that replacement and the §0 wording that
explains it are the only edits this pass makes above this line.*

### 9.1 Sixteen of this census's 67 requirements were in no bucket and no denominator

`pnpm -s check:census-integrity` at `3eaf2436f` read **51** of 67 rows and reported `C=39 W=6 N=6` —
67.2 % constructed, 58.2 % correct. This document has never claimed those numbers either.

The sixteen were not counted in prose. Each was **already a table row with a stated verdict**; the
tallier could not read the CELL, because `verdictOf` requires the whole cell to be one token after
`*` and the vacuity flags are stripped, and these sixteen cells all carry a qualifier beside the
verdict:

| The shape | Rows carrying it |
|---|---|
| `**N** — owner hold` | A01, A05, A18 |
| `**W** — deployment` / `**C** — verified in the catalog, not by the suite` | B01, C28 |
| `**N → W** …` — an as-found/now pair in one cell | A03, A20, A25 |
| `**W → C (fixed)** / (fixed this pass)` | A17, C11 |
| `**W → partially closed**` | B03, C19 |
| `**C** (by reference, line re-opened)` | B06, B07, B08, B09 |

So the difference between 58.2 % and this document's stated 68.7 % was **entirely a parser**, and
16 requirements — a quarter of the census — sat outside every number the repository reports.
§9.4 restates all sixteen. After it the gap is zero.

**And the other 31 "id-keyed rows with no verdict" the tool prints are not requirements:** ten are
the §6 owner decisions (`D1`–`D10`), five are the §7 fix table (`F1`–`F5`), and the rest are those
tables' continuation rows. The honest count of unmeasurable requirements here was sixteen.

### 9.2 The tally in §2d has been one row wrong since 2026-09-13, and this section is why

A20 was re-measured `N → W` earlier the same day by the integrator, whose note says in full: *"the
Discovery headline is NOT restated here — moving it is the Discovery lane's to do."* It was not
moved. §2d still reads A: 10 C / 5 W / 10 N, and the A rows at `3eaf2436f` are 10 / 6 / 9. The
headline `46 / 11 / 10` should have read `46 / 12 / 9` from that moment. That is corrected here, and
it is the reason `check:census-integrity` would have gone red the instant the sixteen rows became
readable: with 67 of 67 parsed there is no prose gap for a mismatch to hide in.

### 9.3 Read the two numbers separately

| Stage | C | W | N | CONSTRUCTED | CORRECT |
|---|---|---|---|---|---|
| What the tallier could read at `3eaf2436f` (51 of 67 rows) | 39 | 6 | 6 | 67.2 % | 58.2 % |
| What §2d states | 46 | 11 | 10 | 85.1 % | 68.7 % |
| What the ROWS said at `3eaf2436f`, A20's move folded in | 46 | 12 | 9 | 86.6 % | 68.7 % |
| Re-measured at `3eaf2436f`, before this lane changed anything | 46 | 14 | 7 | 89.6 % | 68.7 % |
| After this lane's build | 47 | 13 | 7 | 89.6 % | 70.1 % |

- **+19.4 points of CONSTRUCTED and +10.5 of CORRECT are the tallier learning to read.** No code.
- **+3.0 points of CONSTRUCTED are other lanes' code** — the Sensing lane's live ranker (A01) and the
  Trips lane's freedom-window consumer (A11), neither of which this census had measured.
- **+1.4 points of CORRECT — exactly one row, A20 — is this lane's build.** That is the whole of what
  this pass constructed in Discovery, and no other row was moved to C.

### 9.4 The sixteen unparseable rows, restated

Verdicts are unchanged from what each cell already stated, except A01, A03's reason, A20 and A25
where §9.5 and §9.6 say otherwise. The qualifier each cell carried is written into the reason column
so nothing is lost.

| id | was | now | why |
|---|---|---|---|
| A01 | `N — owner hold` | W | **Moved. The owner hold no longer describes the tree.** Sensing's lane built the live half of `:133` and wired it into both serve points: `artifacts/api-server/src/lib/discoveryLiveRankRead.ts:51#export const RANK_CLAIM_TYPES` consumes crowd level, crowd trajectory, vibe state, queue wait and walk-in access through the one gated live read path, applied at `artifacts/api-server/src/routes/discovery.ts:1879#const liveRanked = await withDiscoveryLiveRank` and again on the cold path. **W and not C:** it is behind `artifacts/api-server/src/lib/discoveryLiveRankRead.ts:45#export const DISCOVERY_LIVE_RANK_FLAG` (migration 2850, seeded FALSE, refuses to commit ON), so on every deployment the helper returns the same array reference it was handed; and forecast, travel time, compatibility and **safety** are still absent from the term list. |
| A03 | `N → W (built this pass, deliberately in the wrong bucket)` | W | Same bucket, **different reason, and the old one is now false.** The row's whole argument for W was *"`whyNow` is `null` on every row by construction — there is no live producer"*. There is one: `artifacts/api-server/src/lib/discoveryCandidate.ts:270#export function whyNowOf` returns the live grade's grounded reasons. It stays W because it is now doubly deployment-gated — the projection behind `discovery_candidate_projection_enabled` (2361, FALSE) and the producer behind `discovery_live_rank_enabled` (2850, FALSE) — so `whyNow` is still null on every row in every deployment, for a reason that is a flag rather than an absence. |
| A05 | `N — owner hold` | N | Unchanged. No intent-mode concept in `routes/discovery*.ts` or `lib/discovery*.ts`; the explicit hold at `docs/discovery/ROADMAP.md:648#Step 7/8 modifiers` stands. |
| A17 | `W → C (fixed this pass)` | C | Unchanged. Re-executed: `artifacts/api-server/src/routes/discoverySearch.ts:434#export { fetchBlockedSet }` still re-exports `lib/blocks`' reader rather than a private copy, and the test still pins function identity, not resemblance. |
| A18 | `N — owner hold` | N | Unchanged. No intent term in the ranker; the supply side exists and nothing consumes it. |
| A20 | `N → W` | C | **Moved by this lane's build. See §9.5.** |
| A25 | `N → W (Discovery half built; Map half absent)` | W | Unchanged. `readDiscoveryCandidatesForViewer` still has no caller outside its own test — the Map gateway is another agent's file (D10). A reader nobody reads. |
| B01 | `W — deployment` | W | Unchanged, and **not re-verified against production this pass**: §5's reading that `canonical_locations.search_key` is absent was taken 2026-09-07 and no production read was made here. |
| B03 | `W → partially closed` | W | Unchanged. The launch leg is built behind `discovery_buddy_launch_gate_enabled` (2360, FALSE, not applied to production); category and availability legs remain unbuilt. |
| B06 | `C (by reference, line re-opened)` | C | Unchanged. Gem rows are selected without their exact coordinate pair. |
| B07 | `C (by reference, lines re-opened)` | C | Unchanged. Events, trips and plans each apply a viewer-eligibility filter before exposure. |
| B08 | `C (by reference, line re-opened)` | C | Unchanged. `fetchAgeRestrictedSet` returns null on error and every caller returns `[]` on null. |
| B09 | `C (by reference)` | C | Unchanged. `InputSuggestion` has no coordinate field. |
| C11 | `W → C (fixed)` | C | Unchanged. The header no longer states the opposite of its own tests about private accounts. |
| C19 | `W → partially closed` | W | Unchanged. `displayName` is emitted additively; the legacy `name` still bakes in `@username` until the client resolves the byline (D2). |
| C28 | `C — verified in the catalog, not by the suite` | C | Unchanged, and the qualifier matters enough to repeat in full: the suite that would prove this **skips without live credentials** and the `test` script pins an unreachable `SUPABASE_URL`, so a green run proves nothing here. The verdict rests on a catalogue read taken 2026-09-07, which was **not** repeated in this pass. |

### 9.5 What this pass built: Telegraph §606's sixth capability, and A20

A20's own text named the target: *"five of six capabilities are now registered through one contract"*
and **search behaviour is the missing sixth**. Measured, the gap was sharper than "missing":

**Search behaviour existed. It was registered in a DIFFERENT REGISTRY, keyed differently.** Preview,
authorization, current state, actions and revocation are registered per OBJECT FAMILY in
`artifacts/api-server/src/services/telegraph/shareables.ts:948#const LOADERS`. Search behaviour was a
pair of maps keyed by MESSAGE SUBTYPE in `domain/telegraph/contracts/conversationSearch.ts`. Nothing
read the two together, so they could disagree about a family forever without a single failure — and
they did: `MAP_PIN` and `MEETUP_POINT` are both shareable and were in neither search map. A Discovery
pin shared into a thread had a preview, an authorization refusal, a live state and a revocation, and
no bucket.

The build puts the sixth capability on the one contract:

| what | where |
|---|---|
| The registration, by object family: bucket, structured flag, and the message subtypes each family is carried by | `artifacts/api-server/src/domain/telegraph/contracts/conversationSearch.ts:92#export const SEARCH_BEHAVIOUR` |
| Its type, stating what §21's last line means by "structured" | `artifacts/api-server/src/domain/telegraph/contracts/conversationSearch.ts:68#export interface TelegraphSearchBehaviour` |
| The sixth member on the contract itself, beside the other five | `artifacts/api-server/src/services/telegraph/shareables.ts:102#getSearchBehaviour()` |
| The one searchable card kind with no shareable family, DECLARED rather than folded into `PLACE` | `artifacts/api-server/src/domain/telegraph/contracts/conversationSearch.ts:121#export const FAMILYLESS_SUBTYPE_BUCKET` |
| Fifteen cases across five blocks, including literal copies of both pre-change maps | `artifacts/api-server/src/test/telegraphSearchCapability.test.ts:1#/**` |

`SUBTYPE_BUCKET` and `STRUCTURED_SUBTYPES` are now **derived** from the registration rather than
declared beside it, and a subtype claimed by two families throws at module load instead of taking
whichever key was written last.

**Why this makes A20 `C` and not `W (gated)`.** There is no flag: the registration is pure data, the
contract member is a synchronous lookup that touches no database (pinned — the test hands
`shareableFor` a client proxy that throws on any property read), and the search path that consumes
the derived maps is reachable on every deployment at
`artifacts/api-server/src/server/telegraph/searchRoute.ts:47#/telegraph/search`, registered in
`routes/index.ts`. All six of §606's capabilities now answer from one contract for the three families
Discovery shares — `PLACE`, `MAP_PIN`, `HIDDEN_GEM`.

**What this build deliberately does NOT claim.** It does not claim conversation search is complete;
§21's own rows are census-telegraph's. It does not claim `compass_card` is registered — that subtype
has a bucket and no shareable family, and the declaration says so with the reason rather than hiding
it. And it changes no stored row's classification: block D of the test holds literal copies of the
ten-entry `SUBTYPE_BUCKET` and eight-entry `STRUCTURED_SUBTYPES` this replaces and asserts the derived
values equal them.

### 9.6 Row moves

| id | was | now | why |
|---|---|---|---|
| A11 | N | W | *"`FreedomWindow`: zero occurrences. No engine to consume."* is false. The Trips lane published the engine and Discovery consumes it: `artifacts/api-server/src/routes/discoverySearch.ts:826#if (ctx?.tripId)` reads the trip's windows through `artifacts/api-server/src/domain/trips/services/TripFreedomConsumers.ts:128#export async function readTripWindows` and places each event's start against them, then `artifacts/api-server/src/routes/discoverySearch.ts:848#Trips §7.3` leads with the fitting rows. **W on both halves of the clause:** the consumption is behind `artifacts/api-server/src/domain/trips/policies/tripOperationalProjections.ts:29#export const TRIP_OPERATIONAL_PROJECTIONS_FLAG` (2778, seeded FALSE, schema 2760–2785 unapplied), so on every deployment the read refuses; and the independent calculation the clause forbids is still there at `artifacts/api-server/src/lib/portavaRank.ts:99#availableMinutes?`. |
| A01 | N | W | Stated in full in §9.4. |
| A20 | W | C | Stated in full in §9.5. |

### 9.7 Mutations, each watched red and reverted byte-identical

Applied to the tree, run, observed failing, reverted, and the file compared with its pre-mutation
backup by `cmp` — reported identical every time.

| mutation applied | what went red |
|---|---|
| `removed getSearchBehaviour from shareableFor` | block A — 11 pass / 4 fail, **and** `pnpm typecheck` TS2741 "Property 'getSearchBehaviour' is missing … but required in type 'TelegraphShareable'" |
| `made getSearchBehaviour return a hard-coded PLACES bucket instead of the registration` | block A — 12 pass / 3 fail |
| `unregistered MAP_PIN — exactly the pre-change state` | block B — 14 pass / 1 fail |
| `removed meeting_point from MEETUP_POINT.carriedBy` | blocks C and D — 12 pass / 3 fail |
| `claimed compass_card from PLACE while leaving it in the exception list` | module throws at load, the whole file fails: *"compass_card is declared family-less and is also carried by PLACE"* |

**P24 — what would turn A20's green claim red?** Three things, and each is now guarded: deleting the
contract member (typecheck, block A), registering a family in `LOADERS` without a search behaviour
(block B, which fails specifically on A20's three Discovery families), or re-forking the subtype maps
by hand (blocks C and D). What is **not** guarded, and is stated so nobody reads more into the green
than is there: nothing asserts that the search ROUTE remains registered. If
`server/telegraph/searchRoute.ts` were unmounted, all fifteen cases would stay green and A20 would be
`C` over a path nothing reaches — a vacuous verdict. The route is watched by this census's
`CENSUS_SCOPE` from now on for exactly that reason, which ages the row rather than defending it.

### 9.8 What was NOT re-read

This section re-executed **all 10 NOT-BUILT rows, all 11 BUILT-BUT-WRONG rows, and 22 of the 46
BUILT-AND-CORRECT rows** — every `C` whose evidence names `routes/discovery.ts`,
`routes/discoverySearch.ts` or a `lib/discovery*` file, since three sibling lanes edited those files
after this census was taken. Their CLAIMS all held. Their POINTERS did not: `routes/discoverySearch.ts`
has grown from about 2,130 lines to 2,324 and the unanchored line numbers in C01, C02, C04, C07, C08,
C10, C12, C13, C14, C15, C33 and A17 have all drifted — the same in-range-but-wrong class §8 recorded
for C22, and the reason `check:doc-citations` passing is not evidence a citation is useful. The
citations added by this section carry anchors; the pre-existing unanchored ones were not repaired
here, and that is a debt this pass leaves behind.

The remaining 24 `C` rows were not re-opened. The production and CI facts in §5 were read on
2026-09-07 and were not re-read here — including the two this pass would most like to have re-read,
B01's absent `search_key` and C28's grants.

### 9.9 CEILING — what is not reachable, and why

- **A05 and A18 are an explicit owner hold** (`docs/discovery/ROADMAP.md:222#RANKER WORK GOES ON EXPLICIT HOLD`, `docs/discovery/ROADMAP.md:648#Step 7/8 modifiers`), not an agent's to close. A01 has
  now half-escaped that hold by another lane's hand, which is worth noticing: the hold said "no
  optimising ranking machinery over an empty corpus", and machinery was built anyway, seeded off.
- **A07, A13, A14, A21 and A24 remain blocked on a contract another surface has not published.**
  Re-grepped this pass: no safety projection reaches the ranker, `LayoverSnapshot` still has zero
  occurrences, no Invisible state exists anywhere, and §607's `authorize / preview / execute /
  optional compensate` has no `execute` or `compensate` member on any registry — A21 is **not**
  closed by §9.5's work, which registers a sixth READ capability and no execution path.
- **A20 is `C` on a surface Discovery is dark on.** §5 stands unrepaired: the last
  `surface='discovery'` serve was 2026-08-15, thirteen rows ever, and every engine path but `legacy`
  is off by flag. A shared Discovery card is searchable in a conversation on every deployment — that
  part is real and ungated — but the surface that produces the card is barely reached. **BUILT ON A
  BRANCH IS NOT MERGED. MERGED IS NOT DEPLOYED. DEPLOYED IS NOT FLAG ENABLED. FLAG ENABLED IS NOT
  PRODUCTION REALIZED.**
- **Four FALSE-seeded flags and two unapplied migrations hold five of this census's W rows down**:
  `discovery_candidate_projection_enabled` (2361), `discovery_buddy_launch_gate_enabled` (2360),
  `discovery_trip_projection_enabled` (2550, plus 2420), `discovery_live_rank_enabled` (2850) and
  `trip_operational_projections_enabled` (2778, plus 2760–2785). None was flipped or applied here,
  and none is this lane's to flip.
- **The full api-server suite was NOT run to completion for this pass.** It was started and killed by
  SIGTERM under machine load; the integrator runs the authoritative suite once. What was run: the two
  new test files, and `telegraphSearch` (33), `telegraphShare` (34), `telegraphKinds`,
  `telegraphConversationCapabilities`, `compass-tools`, `telegraphCompassTools`, `compassCensusGates`,
  `compassSurfaces` and `compassTelegraph` — 289 cases across the suites the changed files pass
  through, all green, plus `typecheck` exit 0 and `typecheck:tests` at the 864 / 116 baseline.

### 9.10 Restated headline

> **Discovery, at `820b60638`: 67 requirements · 47 BUILT-AND-CORRECT · 13 BUILT-BUT-WRONG ·
> 7 NOT-BUILT · 0 CANNOT-VERIFY → CONSTRUCTED 60 / 67 = 89.6 % · CORRECT 47 / 67 = 70.1 %.**
> Inbound obligations alone (A01–A25, the column §1 says to read first): 11 correct / 7 wrong /
> 7 not built — CONSTRUCTED 72.0 % · CORRECT 44.0 %. As found at `3eaf2436f`: 46 / 14 / 7 / 0. As the
> tallier could read it at `3eaf2436f`: 39 / 6 / 6 / 0 over 51 of 67 rows. Of the move from 58.2 % to
> 70.1 % correct, **10.5 points are the tallier learning to read, 0 points are other lanes' code
> (their two moves were both into BUILT-BUT-WRONG), and 1.4 points — one row, A20 — is this lane's.**

| BUILT-AND-CORRECT | **47** |
|---|---|
| BUILT-BUT-WRONG | **13** |
| NOT-BUILT | **7** |
| CANNOT-VERIFY | **0** |

---

## 10. The correctness pass, 2026-09-13 — one row, and an honest account of why only one

*Measured at `3ca68cb06`, the commit below this one. Declared as `head_commit` in §0, replacing
`820b60638`; that replacement and this section are the only edits this pass makes to this document.*

### 10.1 The 13 BUILT-BUT-WRONG rows, grouped by WHY they are wrong

Grouped BEFORE anything was built, so these sizes are a measurement rather than a description of
what happened to get done. The question asked of each row: *what exactly stands between this row and
`C`?* — and for Discovery the answer is uncomfortable.

| group | rows | which |
|---|---|---|
| **(a) logic wrong in code this pass owns** | **1** | A15 |
| **(b) logic right, nothing reaches it** | **3** | A08 · A25 · C19 |
| **(c) capped by a flag seeded FALSE or an unapplied migration** | **6** | A01 · A03 · A10 · A11 · B01 · B04 |
| **(d) needs something nobody has written** | **3** | B02 · B03 · B05 |

**Twelve of Discovery's thirteen wrong rows are not wrong code.** Six are correct code behind a flag
seeded FALSE or a migration production does not have (2850, 2361, 2550 + 2420, 2778 + 2760–2785, 2220,
2217). Three are correct server code with no caller: `readDiscoveryCandidatesForViewer` still has no
consumer outside its own test (`grep -rn readDiscoveryCandidatesForViewer src` → the reader, its
test, nothing else), the legacy suggest hook still runs on every keystroke beside the gateway
(`travel-buddy-standalone/src/hooks/useGlobalSearchSuggestions.ts:6#regressing the hard-won legacy path`),
and C19's `displayName` is emitted additively while the client still reads the legacy `name`. Three
need a decision or an artefact nobody has produced: whether stripping an emoji may change a live
route's results (B02 — `artifacts/api-server/src/routes/discoverySearch.ts:151#export function sanitizeQuery` still
strips only `(),`), what a buddy's service category and availability even are as columns (B03), and a
canonical country registry (B05 — `country_essentials` exists in production and is keyed by ISO code
with **no name column**, so it is not the registry this needs).

**One row was wrong code, and this pass built it.**

### 10.2 Row moves

| id | was | now | why |
|---|---|---|---|
| A15 | W | **C** | **Built.** The row's own gap was three named rules: *"the search list still assembles its own identity payload … `:598-640` applies its own privacy logic (locked preview, `show_profile_picture_publicly`, name rule)"*. All three are now the Passport batch projection's — `artifacts/api-server/src/routes/discoverySearch.ts:661#const identity = await buildListIdentityProjections(sc, nameSafe as any[], {` over `artifacts/api-server/src/services/passport/PassportConsumerProjections.ts:1153#export async function buildListIdentityProjections`, with the avatar taken from it (`artifacts/api-server/src/routes/discoverySearch.ts:685#avatarUrl: ident?.avatarUrl ?? null,`) rather than gated here. **What the row objected to is closed; what remains is not what it objected to.** The `select` at `artifacts/api-server/src/routes/discoverySearch.ts:577#.select("id, handle, username, name, display_name, avatar_url, is_private, home_city, home_country, account_status` stays, and stays deliberately: those columns are what the search MATCHES and RANKS on, and the projection's own header draws that line — *"a ranked list still selects the columns it ranks on — that is ranking input, not an identity payload"*. The cost objection is answered rather than accepted: the projection is a batch, and Discovery hands it the allow-set it already resolved (`artifacts/api-server/src/routes/discoverySearch.ts:667#allowedRealNames: allowedNames,`), so the search still makes **one** `profile_privacy_settings` read, not two. Pinned by `artifacts/api-server/src/test/passportListIdentityProjection.test.ts:1#/**` — 14 cases, three mutations. |

### 10.3 What this pass built

One build, shared with two other censuses; the full account is in `census-passport.md` §12, because
the row it closes there (P169) is the one that specified it.

| what | where | closes |
|---|---|---|
| A viewer-relationship-aware BATCH list identity projection: name allowed, presented name, locked preview, avatar, badge — one implementation for both bulk lists | `artifacts/api-server/src/services/passport/PassportConsumerProjections.ts:1153#export async function buildListIdentityProjections` | census-discovery A15 · census-passport P169 · census-compass CP-02's server half |

**What Discovery got out of it beyond the row.** The name rule was already canonical here — this file
adopted `presentedName` earlier — so Discovery's own output does not change. The surface that
changes is Compass's, which carried a fourth, untrimmed copy. **Discovery's gain is that the rule can
no longer fork away from it silently**, which is a smaller and more honest claim than "a defect was
fixed in Discovery".

Mutations, each applied, run, watched fail, reverted, and compared byte-for-byte by `cmp`:

| mutation applied | what went red |
|---|---|
| a friendship unlocks a private account's preview | 1d — 13 pass / 1 fail |
| the projection resolves the name inline, without trimming | 1b — 13 / 1 |
| `routes/compass.ts` put its own copy of the name rule back | 3b — 13 / 1, **after the guard itself was fixed** |

**The third mutation stayed green on the first run**, because the no-private-copy guard's pattern
tolerated only ONE dot: it saw `p.display_name ?? p.name` and not `s.row.display_name ?? s.row.name`.
A guard that cannot see the copy it was written to forbid is worse than none, and only the mutation
said so.

### 10.4 Rows re-executed and left where they were

All 13 BUILT-BUT-WRONG rows were re-executed — that is §10.1 — and **ten `C` rows** were
spot-checked because §9.8 warned that 24 of them had not been re-opened: A02, A09, A16, A19, B08,
C01, C03, C07, C09, C10. **All ten hold on their verdicts.** What did not hold is arithmetic: the
line numbers in C07, C09, C10 and A15's evidence (`:529`, `:587`, `:603`, `:567`) have drifted with
the file and **`check:doc-citations` cannot see it**, because those citations are UNANCHORED — a bare
`path:line` that nothing can tell you is wrong. That is the ratchet's own stated limit, measured here
rather than theorised: this pass found four stale line numbers in ten spot-checks, and the check
reported the corpus clean throughout.

### 10.5 What was NOT built, and why — stated so it can be argued with

- **B02 (emoji in `sanitizeQuery`) was left alone deliberately, and it is the one row here a reader
  should push back on.** The fix is two characters of regex. What stops it is that "🔥 bar" currently
  matches nothing and would start matching "bar" — a user-visible result change on a live route with
  no flag, and owner decision D5 in §6 records the previous pass declining it for that reason. This
  pass was forbidden to write a migration, so it could not add the flag that would make the change
  safe. **Overriding another lane's recorded owner decision because the fix is small is how a census
  stops meaning anything**, so it was not overridden; but the decision is now two passes old and the
  surface is dark in production (§5), which is the argument for simply making it.
- **B04 (protected locations) is not one line of wiring.** `artifacts/api-server/src/lib/protectedLocations.ts`
  operates on `MapObject`s with geometry and suppresses fail-CLOSED by design; `protected_zones` is
  absent from production. Wiring Discovery straight into it with no flag would turn every production
  search into an empty result on the first failed read. It needs a flag, and a flag needs a migration.
- **A25 (a reader nobody reads) is one call in `routes/mapProjection.ts`**, which is the Map lane's
  file and not this census's to edit. Recorded again rather than taken.
- **No production read was made in this pass**, so B01's "`canonical_locations.search_key` is absent"
  remains a 2026-09-07 measurement, unchanged and un-refreshed.

### 10.6 Restated headline

> **Discovery, at `3ca68cb06`: 67 requirements · 48 BUILT-AND-CORRECT · 12 BUILT-BUT-WRONG ·
> 7 NOT-BUILT · 0 CANNOT-VERIFY → CONSTRUCTED 60 / 67 = 89.6 % · CORRECT 48 / 67 = 71.6 %.**
> CONSTRUCTED does not move, because nothing here was NOT-BUILT and became built; one row moved
> across the W→C line and that is the whole of it. Inbound obligations alone (A01–A25): 12 correct /
> 6 wrong / 7 not built — CONSTRUCTED 72.0 % · CORRECT 48.0 %. **The gap between CONSTRUCTED and
> CORRECT is 17.9 points, and twelve of the twelve rows in it are flag-capped, caller-less or waiting
> on a decision — not one of them is code this pass could have corrected.**

| BUILT-AND-CORRECT | **48** |
|---|---|
| BUILT-BUT-WRONG | **12** |
| NOT-BUILT | **7** |
| CANNOT-VERIFY | **0** |

---

## 11. Re-denominated 2026-09-13 against the RESTORED requirements

*Measured at `b7f137a4dfbc05830505382e63d418f3900a4cf1` (`b7f137a4d`). APPEND-ONLY and
LAST-STATEMENT-WINS: where this section and any section above disagree, this one is the later
statement. It does not edit §0's `head_commit`; it declares its tested commit here, because what it
changes is the denominator and a denominator is not a freshness fact.*

### 11.1 Why the denominator changed — the overwrite, verified rather than quoted

This census's header says *"Discovery has **no spec**"* (`docs/architecture/census-discovery.md:4#uncommitted sibling-agent work, on 2026-09`) and §1 builds a denominator from three
substitute sources. That was true when written and is false now, and why it was ever true is the
finding this section records.

**Discovery's requirements were not lost. They were overwritten by a description of the code.**
Verified at this commit by opening the files:

| Evidence | What it says |
|---|---|
| `docs/architecture/00_STATUS.md:3#These began life as **PROPOSALS**, not des` | *"These began life as **PROPOSALS**, not descriptions of the system."* |
| `docs/architecture/00_STATUS.md:7-9#Documents` | *"**Documents `01`–`06` have since been rewritten as current-state descriptions derived from the repository** (2026-09-04, unit D3). They now describe what the code does, cite the files that do it…"* |
| `docs/architecture/05_Graph_Engine.md:6-8#schedule (` | *"The original `05` described **building** one; this document describes the running one…"* |
| `docs/architecture/02_Trails.md:7#The original` | *"The original `02` proposed Trails as a first-class discovery primitive…"* |
| `docs/architecture/03_Trending.md:7#The original` | *"The original `03` proposed a trend engine with its own lifecycle…"* |
| `docs/architecture/04_Behavior_Engine.md:17#Because a row is overwritten by its own ou` | *"…behaviour chains as the original `04` [specified]…"* |

Four of thirteen documents refer to their own originals in the third person and past tense. They are
a report about the code, written from the code.

**Why that invalidates 71.6 % specifically.** A census scored against a document derived from the
same code cannot find the code missing: obligations the code does not satisfy were edited out before
the census read it. The 67 rows were then assembled — honestly; §1 says so — from other surfaces'
specs (A), a sibling census (B) and Discovery's own module headers (C). §1's own caveat is the tell:
*"the (c) rows are the easiest to satisfy — they are the surface grading its own homework — and they
are 33 of 67."*

The originals are restored byte-exact at `docs/specs/discovery-architecture-v1/` (13 files, 2 075
lines; sha256 per file in `docs/specs/SUPPLIED-SOURCES-2026-09-13.md`).

**The current-state documents are NOT deleted and NOT edited by this pass.** They are real, cited
work and other guards depend on their line numbers. They are reclassified, not discarded: **evidence
about the code**, which a row may legitimately cite — simply not the requirement.

### 11.2 Grading rules applied here, stated so the verdicts can be checked

1. **A parent requirement takes `C` only if EVERY criterion inside it passes.** Where some pass and
   some do not, the parent is `W` and each criterion is listed with its own `file:line`. Applied
   below to DV-54 (diversity, 2 of 6 axes), DV-55 (cold start, 0 of 3), DV-78 (behaviour
   expansion, 5 of 8), DV-79 (shadow comparison, 1 of 6), DV-08 (flag states, 3 of 5), DV-71
   (RLS, 1 of 4 policy kinds) and DV-09.
2. **Coverage is semantic, not citational.** Every restored obligation was checked against all 67
   existing rows for overlap of subject, not for a missing citation. Where an existing row already
   grades the obligation it is a DUPLICATE: that row is re-graded against the restored criteria and
   nothing is added. This removed eight would-be rows (§11.4).
3. **Every obligation carries exactly one disposition — ADDITION / DUPLICATE / SPLIT — with its
   reason.** §11.4 is that table, line per obligation.

### 11.3 The corrected denominator, and what it is made of

| layer | rows | kept / added |
|---|---|---|
| The existing 67 — A01–A25, B01–B09, C01–C33 | **67** | **PRESERVED IN FULL.** Not discarded, not replaced by the shorter upgrade checklist. Three are re-graded in §11.6; the other 64 stand as §10 left them. |
| `DV-01`…`DV-82` — the restored Discovery Architecture v1 package | **+82** | New. Source file and section named per row (§11.5). Eight further obligations were checked and **not** added, as DUPLICATEs of existing rows (§11.4). |
| `DSV2-04` · `DSV2-05` · `DSV2-06` · `DSV2-12` | **+4** | New. The only four of the twelve DSV2 requirements that add ground the restored package and the existing 67 do not already cover; the other eight are DUPLICATE or the already-counted half of a SPLIT (§11.4). |
| | **153** | |

The owner's framing forbids both failure modes by name, so both are stated as refusals: this does
**not** replace the existing denominator with the shorter upgrade checklist — all 67 are still here
and still counted — and it does **not** count one feature twice: every duplicate is named in §11.4
with its reason and counted once.

### 11.3a Headline — measured before and after

> **Discovery, at `b7f137a4d`: 153 requirements · 63 BUILT-AND-CORRECT · 46 BUILT-BUT-WRONG ·
> 42 NOT-BUILT · 2 CANNOT-VERIFY → CONSTRUCTED 109 / 153 = 71.2 % · CORRECT 63 / 153 = 41.2 %.**

| | rows | C | W | N | X | CONSTRUCTED | CORRECT |
|---|---|---|---|---|---|---|---|
| **Before** — §10.6, at `3ca68cb06` | 67 | 48 | 12 | 7 | 0 | 89.6 % | 71.6 % |
| **After** — this section, at `b7f137a4d` | **153** | **63** | **46** | **42** | **2** | **71.2 %** | **41.2 %** |
| delta | +86 | +15 | +34 | +35 | +2 | −18.4 pts | −30.4 pts |

No code regressed between the two measurements. Fifteen rows were added to `C` — those are real
capabilities the substitute denominator never counted. They are outnumbered by thirty-five absences
that no substitute denominator could see, because the document naming them had been replaced by a
description of the code that lacks them.

The largest single contributor: **four subsystems the restored package specifies exist in no form.**
Verified at this commit in **both** the repository and production `ajrurzioarfkagpuxfnb` (read-only
`to_regclass` over eighteen names): `trails`, `content_trails`, `trail_edges`,
`trail_health_snapshots`, `recommendations`, `recommendation_items`, `conversion_events`,
`attribution_records`, `attribution_participants`, `ledger_accounts`, `ledger_entries`,
`payout_holds`, `payout_requests`, `place_momentum`, `place_cooccurrence`, `traveler_affinities`,
`trail_relations`, `circle_momentum` — **all eighteen NULL in production, and none has a
`CREATE TABLE` anywhere under `artifacts/api-server/src/migrations/` or `db/`.** Those four
subsystems account for **25 of the 42 `N` rows** (Trails 8 · Trending-as-an-engine 3 · Creator
Economy 5 · Revenue 4 · Payment 5).

### 11.4 The mapping — every obligation, one disposition, with its reason

**DSV2, all twelve.** Eight DUPLICATE, four SPLIT, none a pure ADDITION.

| DSV2 | Disposition | Existing row | Reason / what the split adds | Re-grade |
|---|---|---|---|---|
| DSV2-01 | **DUPLICATE** | A02 | Same subject: search truth kept independent of recommendation ranking. | A02 **C** holds at the stricter bar — `routes/discoverySearch.ts` never imports the ranker; `lib/discoveryLiveRank.ts:462#if (a.grade.safety.demoted !== b.grade.saf` demotes only inside `GET /discovery`'s window. A quiet venue stays searchable because search reads no live state. |
| DSV2-02 | **DUPLICATE** | A01 | Same subject: live-intelligence axes into ranking. | A01 **W** holds; reason updated. All eight axes now exist (`lib/discoveryLiveRank.ts:140-148#weights: {`, `lib/discoveryLiveRank.ts:207#/** Live-qualified`). *Unknown must not become favourable* is **satisfied**: `FRESHNESS_AXIS` maps `unknown: 0`, `historical: 0` (`lib/discoveryLiveRank.ts:126#const FRESHNESS_AXIS: Readonly<Record<Fres`) and a null axis contributes nothing. `W` on the 2850 gate and on travel time (§11.7.3). |
| DSV2-03 | **DUPLICATE** | A05 | Same subject: the eight intent modes. | A05 **N → W**, §11.6. |
| DSV2-04 | **SPLIT** | A03 | A03 grades the **server** projection. New ground: the **client** leg — *"Observed and predicted recommendations render distinctly; expired why-now claims disappear or become explicitly stale."* Independently testable, separately load-bearing. | A03 **W** holds; new row DSV2-04 **N**. |
| DSV2-05 | **SPLIT** | DV-03 | DV-03 grades the **ranking**-bypass leg of the shared cache. New ground: the **eligibility** leg on cache-hit paths. Different failure, different test. | DV-03 **W**; new row DSV2-05 **W → C, built this pass** (§11.8). |
| DSV2-06 | **SPLIT** | DV-04 | DV-04 grades **feature/model loss**. New ground: **binding and invalidation** — permission or evidence change must invalidate or revalidate. | DV-04 **W**; new row DSV2-06 **W**, freshness leg closed by §11.8. |
| DSV2-07 | **DUPLICATE** | DV-06, DV-07, DV-37, DV-46, **C25** | Four clauses, each already a row. *Rejected writes observable* is **C25**'s own contract — not a new row. | *allowed surfaces write* → DV-44 **W**; *rejected observable* → C25 **C**; *retry deduplicates* → DV-37 **N**; *exposures have denominators* → DV-06 **W**. |
| DSV2-08 | **DUPLICATE** | A04 | Same subject: Hidden Gem candidates vs canonical approval. | A04 **C** holds — `services/hiddenGems/HiddenGemContributionService.ts:7-12#A contribution is an OBSERVATION. recordGe`: *"A contribution is an OBSERVATION… it never touches the gem's canonical status."* Correlated activity cannot become independent confirmation; review still governs approval. |
| DSV2-09 | **DUPLICATE** | A07 | Same subject: safety vs opportunity. | A07 **N → W**, §11.6. Separation bar **met**: `lib/compassDecision.ts:275#unsafe: crowdLevel === "unsafe_density",` sets `unsafe` only on the distinct level `unsafe_density`, never on `busy`/`packed` (`lib/compassDecision.ts:290#quiet: { dead: 0.6, quiet: 1.0, moderate:` score `packed: 1.0` for high-energy with `unsafe` false). |
| DSV2-10 | **DUPLICATE** | DV-53, DV-54, DV-55, DV-32 | Four named concerns, each already a row. | exploration DV-53 **W**; diversity DV-54 **W**; cold start DV-55 **W**; manipulation DV-32 **W**. *"Low-history creators are not automatically excluded"* → DV-15 **C**. |
| DSV2-11 | **DUPLICATE** | DV-08 (+ A06, C20, C22, C23, C24) | Same subject: OFF inert, SHADOW side-effect-free. | Inertness stays **C** across A06/C20/C22/C23/C24. DV-08 is **W** on a different criterion — five states, three implemented. |
| DSV2-12 | **SPLIT** | DV-19 | DV-19 grades *optimise for travel value*. New ground: **traceability** — *"Trace served recommendation→exposure→permitted outcome with versions and coverage."* | DV-19 **N**; new row DSV2-12 **N**. |

**Restored package — the eight obligations that turned out already covered, and were NOT added.**
Each is a DUPLICATE; the existing row was re-graded against the restored criteria instead.

| Restored obligation | DUPLICATE of | Reason |
|---|---|---|
| `01` §6 *"rejected events are observable"* | **C25** | C25's stated contract is *"a rejected insert is reported, never thrown"* — the same obligation, already graded. |
| `04` §3 *"observable on failure"* | **C25** | Same obligation as above, restated in a second document. |
| `04` §10.4 *"instrument rejected event writes"* | **C25** | Third restatement of the same obligation. Counted once. |
| `06` §11 *"shadow comparison is available"* | **C22** | C22 grades the shadow mechanism's existence and inertness. Availability of the comparison is the same subject. (Phase 9's six *dimensions* are genuinely more — SPLIT, DV-79.) |
| `11` §9 error semantics / *"A failure must not masquerade as success"* | **C14** | C14 grades `/discovery/suggest`'s fail-soft contract — precisely this subject. The restored document contradicts it, so C14 is re-graded rather than a second row added. |
| `06` §5 cache metadata (model/feature/source/reasons/timestamp) | **DV-04** | DV-04 *is* the Cache-B metadata obligation; `06` §5 states the same requirement the `00-readme` finding describes as broken. |
| `10` §10 *"payment ledger is immutable"* | **DV-66/67** | `09` §11's *"every earning reconstructable"* + *"no balance depends on mutable totals"* is the same property. |
| `11` §7 *"attribution must be idempotent"* | **DV-63** | `08` §7's *"attribution is auditable"* over a subsystem absent in full; a second row over the same absence would inflate. |

**Restored package — the three SPLITs off existing rows.**

| Restored obligation | SPLIT off | What is genuinely new |
|---|---|---|
| `01` §8 five flag states | C20 / C24 / A06 | Those grade **OFF-inertness**. New: that **five named states** exist (COMPARE and PARTIAL do not). → DV-08 |
| `01` §11 reason vocabulary | A03 | A03 grades the **projection carrying** why-for-user. New: the **nine-code internal vocabulary** and **plain-language user-facing** strings. → DV-18 |
| `04` §9/§13 intent vs preference | A18 | A18 grades **weighting** explicit intent above generic interests. New: that the two are **distinct representations**. → DV-42 |
| `10` §5 RLS four-policy explicitness · `11` §10 mutation authorization | C28 | C28 grades the `discovery_places` **GRANT** boundary. New: **RLS policy explicitness** (DV-71) and **route-level auth on the four mutating routes** (DV-73). |

**Restored package — `12`'s phases, dispositioned.** Phases 1, 2, 3, 4, 6, 7, 8, 10, 11 and 12 are
DUPLICATEs of rows already created from the documents they sequence, and are counted once there:
Phase 1 → DV-43…47; Phase 2 → DV-03/04; Phase 3 → DV-08 + the inertness rows; Phase 4 → DV-40,
DV-18, DV-04, DV-06; Phase 6 → DV-20…26; Phase 7 → DV-28…33; Phase 8 → DV-72; Phase 10 →
DV-03; Phases 11–12 → DV-56…69. Six phases are ADDITIONs or SPLITs (DV-75…80).

**`12`'s Completion definition — all eight bullets, per rule 1.** Seven are DUPLICATEs, counted once
at the rows named; the eighth is new. The definition is therefore **not** graded as one parent: its
criteria are separately testable and separately load-bearing, so they are split out and mapped.
*Recorded explicitly: were it graded as a single parent it would be `W`, since six of eight fail.*

| Completion bullet | Disposition | Verdict at its row |
|---|---|---|
| behaviour evidence is trustworthy | DUPLICATE → DV-43…47 | 1 C, 3 W, 1 N |
| cache paths cannot bypass ranking | DUPLICATE → DV-03 | W |
| Trails are canonical objects | DUPLICATE → DV-20 | N |
| Trending uses normalized travel signals | DUPLICATE → DV-30 | C |
| recommendation exposures are logged | DUPLICATE → DV-40 | N |
| shadow/flag rollout exists | DUPLICATE → DV-08 | W |
| attribution and ledger are wired | DUPLICATE → DV-56/65 | N |
| **payouts remain disabled until economics are validated** | **ADDITION** → DV-81 | **C** |

All other restored obligations are **ADDITIONs**: checked against all 67 existing rows and found to
have no row grading the same subject. The eight guardrails of `01` §10 are the clearest case — the
existing census grades block *application* (A19, C03, C17) but no row grades any of the eight
prohibitions, so each is added.

### 11.5 The 82 restored-package rows

Source `docs/specs/discovery-architecture-v1/`. Every `C` and `W` cites a `file:line` opened at this
commit. Paths relative to `artifacts/api-server/src/` unless prefixed.

#### `00-readme` §1 — the four findings, RE-MEASURED, not inherited

DSV2 requires it: *"The baseline reports past cache and telemetry defects; reproduce against the
current head instead of assuming they still exist."* `00_STATUS.md` claims several are fixed; that is
a claim, and here is the measurement.

| id | Obligation | Verdict | Evidence re-measured at `b7f137a4d` |
|---|---|---|---|
| DV-01 | §1.1 *"`living_page` impressions were rejected by a CHECK constraint and silently swallowed by a fire-and-forget path"* | **W** | One criterion passes, one fails — **CHECK criterion PASSES, verified in production**: `pg_get_constraintdef` on `rank_events_surface_check` returns a 14-value list **including `'living_page'` and `'watch_feed'`** — migration `0202` is applied. **Swallow criterion FAILS**: `lib/rankLog.ts:81#feed response.  All errors are swallowed s` and `lib/rankLog.ts:255#recommendations response.  All errors are` both still read *"All errors are swallowed silently."* And the surface cannot adjudicate itself — production `rank_events` holds pulse 203,989 · compass 24,284 · events 5,208 · live_pulse 730 · discovery 13, and **no `living_page` row at all**. `lib/discoveryServeLog.ts:19#(0199:60, 0202:77). Its absence is not rej` states the rule this census must respect: *"Its absence is not rejection. It is that path not running."* Writer is `routes/rankEvents.ts`, outside Discovery's files. |
| DV-02 | §1.1 *"`discovery` is permitted as a surface but has zero rows"* | **W** | **No longer zero; still dark.** Production `surface='discovery'` → **13 rows, latest `served_at` 2026-08-15**, 29 days before this commit. The writer is live (`discovery_serve_log_enabled` true, §5) and ten serve points are instrumented (`lib/discoveryServeLog.ts:70-70#CACHE_A_L1:             1,`). Rows landed when the surface was reached; the surface is not reached. |
| DV-03 | §1.2 / `01` §7 Cache A — must never bypass personalization/ranking | **W** | Built, held OFF — **Still true in the shipping default.** User-independent key: `routes/discovery.ts:298#function cacheKey(dest: string, cat: strin` `cacheKey(dest, cat, radius)` — no viewer term. The bypass: `routes/discovery.ts:1851#let servedFiltered = filtered;` `let servedFiltered = filtered;`, with the per-request ranker at `routes/discovery.ts:1862#const outcome = await rankForViewer(merged` reached only inside `if (pdeCohort?.included …)` (`routes/discovery.ts:1856#if (pdeCohort?.included && callerUserId) {`), whose precondition is `engineMode.mode === "pde"` (`routes/discovery.ts:1853#const pdeCohort = (callerUserId && engineM`). `DISCOVERY_ENGINE_MODE` is seeded `enabled=false, mode='legacy'` (`migrations/2091_discovery_engine_mode_flags.sql:9#1. DISCOVERY_ENGINE_MODE  (capability, ena`) and production reads the same (§5). Serve points 1/2/3 hand the cached order to the user unranked on every deployment. The fix is built and wired — built-and-gated, not absent — behind ROADMAP Phase F gate 2, *"not ruled"* (`docs/discovery/ROADMAP.md:648#discovery_ranking_modifiers_enabled`). |
| DV-04 | §1.2 / `01` §7 Cache B + `06` §5 — preserve model_version, feature_version, candidate source, reasons, ranking timestamp | **W** | 1 of 5 criteria passes — **Still true.** Entry type `routes/discovery.ts:285#const _compassCandidateCache = new Map<str` `Map<string, { places: DiscoveryPlace[]; at: number }>` — ranked order and a write clock, nothing else. Written at `routes/discovery.ts:2210#_compassCandidateCache.set(cCacheKey, {`; replayed at `routes/discovery.ts:2131#const cFiltered = applyFilters(cCacheHit.p` with no re-rank; projection handed `scoredById: null` (`routes/discovery.ts:2138#cacheLevel: "compass_candidate_hit", cache`) so `whyForUser` is empty on every Cache-B serve. **model_version FAIL · feature_version FAIL · candidate source FAIL · reason codes FAIL · ranking timestamp PASS** (as of §11.8; it was `cachedAt: null` before this pass). |

#### `01` Discovery Engine

| id | Obligation | Verdict | Evidence |
|---|---|---|---|
| DV-05 | §6 *"missing surface writes are explained"* | **C** | `migrations/0202_rank_events_living_page_watch_feed_surfaces.sql:17-20#Written by the code but ZERO rows present:` enumerates which permitted surfaces have zero rows and why, distinguishing *rejected* from *never ran*; `migrations/2298_dead_check_vocabularies.sql:97-103#rank_events_surface_check` freezes the audited vocabulary. Single criterion, met. |
| DV-06 | §6 *"recommendation exposures carry denominators"* | **W** | A denominator exists and is correct **per item**: `lib/rankLog.ts:154#await recordImpressionDistributionStats(sc` calls `recordImpressionDistributionStats` on the **impression** path and only when the insert was accepted; `routes/rankEvents.ts:229-238#const { error: updateErr } = await sc` updates `outcome`/`outcome_at` and never touches it. The spec's unit is the **recommendation**, and none exists (DV-40 **N**). A denominator over items is not one over recommendations. |
| DV-07 | §6 *"fire-and-forget failures are surfaced"* / §10.3 *"remove silent failure catches"* — SPLIT off C25 | **W** | 1 of 3 writers — `lib/discoveryServeLog.ts:444-449#const { error } = await sc.from("rank_even` **PASSES** (branches the error, `logger.warn` with serve point, route and count; a throw warned at `lib/discoveryServeLog.ts:477#logger.warn({ err }, "discoveryServeLog: i`). `lib/rankLog.ts:143-148#if (insertError) {` PASSES for the portavaRank path but its Compass path **FAILS** — `lib/rankLog.ts:255#recommendations response.  All errors are`, *"All errors are swallowed silently"*, same at `lib/rankLog.ts:81#feed response.  All errors are swallowed s`. And Discovery's own serve path **FAILS** on a ranking branch: `routes/discovery.ts:2250#} catch { /* fall through to normal rule-b` `} catch { /* fall through to normal rule-based path */ }` wraps the whole Compass block (`routes/discovery.ts:2104#if (category === "for_you" && callerUserId`), so a failure in `rankItemsForDiscovery`, in the Cache-B read, or in serve-point-5 logging degrades to the unranked path with no log line. |
| DV-08 | §8 five states OFF · SHADOW · COMPARE · PARTIAL · ON — SPLIT off C20/C24/A06 | **W** | 3 of 5 — `lib/discoveryEngineMode.ts:70#export type DiscoveryEngineMode = "legacy"` — `"legacy" \ | "shadow" \| "pde"`, validated `lib/discoveryEngineMode.ts:72#const VALID_MODES: readonly string[] = ["l`. **OFF PASS** (= legacy) · **SHADOW PASS** · **ON PASS** (= pde) · **PARTIAL FAIL** — not a state; reached by crossing a cohort gate with a mode (`lib/discoveryCohort.ts`, applied `routes/discovery.ts:1856#if (pdeCohort?.included && callerUserId) {`) · **COMPARE FAIL** — no state; the artefact exists (`lib/discoveryDivergenceReport.ts`) as a consequence of SHADOW, not a selectable state. §8's last clause — no side effect merely because shadow computes — **PASSES** (C22, C23, C24). |
| DV-09 | §9 surface-specific objectives: Pulse · Discovery · Trail · Trip Planning · Trending | **W** | 1 of 5 — **Discovery PASS** — `for_you` runs the Compass pipeline (`routes/discovery.ts:2172#const scored = await rankItemsForDiscovery` `rankItemsForDiscovery`) distinctly from the default. **Pulse FAIL** — shares `portavaRank`'s single `DEFAULT_WEIGHTS` with Discovery; per-surface weights exist in `services/ranking/rankingConfig.ts:77-129#exploration: number;` but Discovery does not vary by them. **Trail FAIL · Trending FAIL** — no such surface (DV-20, DV-28). **Trip Planning FAIL** — no trip-fit or route-fit term in `lib/portavaRank.ts`. |
| DV-10 | §10 — never use private message contents as ranking features | **C** | `grep -rIn -i "message\|conversation\|dm_" lib/portavaRank.ts lib/discoveryPde.ts lib/discoveryModifiers.ts` → **nothing**. The live layer's read set is a five-family allow-list, `lib/discoveryLiveRankRead.ts:51-53#export const RANK_CLAIM_TYPES = [`: *"Nothing else is read, so nothing else can leak."* |
| DV-11 | §10 — never expose block/unfollow reasons | **C** | `lib/blocks.ts` returns a `Set<string>` of ids — there is no reason field to expose. Consumed at `routes/discovery.ts:1721#viewerBlockedIds = blockSc ? await fetchBl`, `routes/discovery.ts:58#import { fetchBlockedSet, submitterIsVisib`, `routes/discoverySearch.ts:434#export { fetchBlockedSet };`. A block removes a row; it never annotates one. Matches `05` §7. Pinned by `discoveryBlockedSubmitter.test.ts` (25) and `discoverySearchBlockedSubmitter.test.ts` (12). |
| DV-12 | §10 — never reward abusive engagement | **W** | One direction only. `lib/portavaRank.ts:307#DOWN when the author's trust is unknown/lo` down-weights an author of unknown or low trust — *"manipulation resistance"*. That penalises a low-trust **author**; it does not detect abusive **engagement** (`03` §12's pods, farms, reciprocal action, automation). |
| DV-13 | §10 — never let one creator permanently dominate a Trail | **N** | No Trail object (DV-20). `lib/portavaRank.ts:420-437#── Diversity (greedy MMR-style re-rank) ──` bounds per-author repetition **within a page**, which is the analogous control on the surface that exists — not the Trail-scoped one this clause names. |
| DV-14 | §10 — never treat follower count as a direct quality score | **C** | No follower **count** enters the ranker. The one follows read is `lib/discoveryPde.ts:418-421#const { data: followRows } = await sc` — `.from("user_follows").select("following_id").eq("follower_id", userId)` — the set of **whom the viewer follows**, a per-viewer affinity signal (`03` §8's permitted use), never the size of an author's audience. `grep -n -i followerCount lib/portavaRank.ts lib/discoveryPde.ts` → nothing. |
| DV-15 | §10 — never suppress new creators solely due to low history | **C** | Satisfied by absence, checked rather than assumed: no history-threshold predicate exists in `lib/portavaRank.ts`, `lib/discoveryPde.ts` or `lib/discoveryModifiers.ts`. (The positive half — reserved exploration inventory — is DV-53 **W**; "not excluded" and "given opportunity" are deliberately separate obligations.) |
| DV-16 | §10 — never infer sensitive personal attributes for ranking | **C** | Inputs enumerated at `lib/discoveryPde.ts:1-60#/**` and `lib/discoveryModifiers.ts:1-50#/**`: taste, graph, behaviour, place affinity, capped momentum. No demographic, health, religious, orientation or political term under any name. Live read set is the five-family allow-list. |
| DV-17 | §10 — never make safety/private-control events into public reputation penalties | **C** | A block affects visibility only, through set membership (DV-11); it writes to no reputation store. `grep -n reputation routes/discovery*.ts lib/discovery*.ts` → nothing. `04` §4's separation holds because Discovery has no reputation writer. |
| DV-18 | §11 nine internal reason codes + plain-language explanations — SPLIT off A03 | **N** | **Zero of nine exist**: `grep -rn "trail_affinity\|trip_match\|nearby_now\|trending_local\|creator_affinity\|saved_similar\|social_context\|season_match"` → no Discovery hit. What exists is adjacent and is not this: `lib/discoveryCandidate.ts:251#export function whyForUserFromFeatures(` returns the ranker's own **feature keys** — internal variable names, not a reason vocabulary — and `lib/discoveryLiveRank.ts:330#if (state.unsafe) out.push("crowd_unsafe_d` emits `crowd_unsafe_density`, a claim label. No plain-language string is produced anywhere. |
| DV-19 | §12 success on useful saves, itinerary adds, place opens, completed visits, event attendance, low regret, creator diversity, new-creator discovery, Trail freshness, repeat satisfaction | **N** | No outcome instrument. `lib/discoveryServePointReport.ts` measures **ranked share of serves** — engineering coverage — not any listed outcome. No completed-visit, attendance or regret signal exists in `rank_events` (13-column production schema; `outcome` is a funnel token, not a visit confirmation). |

#### `02` Trails §19

**All eight share one context, stated once.** `02` proposes Trails as a first-class primitive. The
owner redirect of 2026-08-15 marks *"Anything assuming the six P1 components are **peer scoring
systems**"* **STALE — must be re-scoped before implementation** (`docs/discovery/ROADMAP.md:148#>`);
step 7 (`docs/discovery/ROADMAP.md:949#local_momentum`) keeps trails a *future modifier*. **Held-by-ruling and not-built are recorded as
distinct things**: the ruling explains why nobody built it; the rows are `N` because it is not built.
No Trail table exists in the repository or production (`to_regclass` ×4 → NULL); migration `2290`
deliberately **refuses** a `trail` graph node kind with a postcondition that fails if one is admitted.
The four `trail*.ts` modules in the tree are intel-capture route-plan modules, not this primitive.

| id | `02` §19 criterion | Verdict |
|---|---|---|
| DV-20 | Trails are canonical objects, not strings | **N** |
| DV-21 | Trail ranking is modular rather than chronological-only | **N** |
| DV-22 | New content receives fair opportunity | **N** | Trail-scoped; surface analogue DV-53 **W** |
| DV-23 | Duplicate saturation is controlled | **N** | Trail-scoped; page analogue DV-54 **W** |
| DV-24 | Trail relationships are navigable | **N** |
| DV-25 | User behaviour can influence Trail momentum | **N** |
| DV-26 | Trail attribution is recordable (trail_id + recommendation_id + contributors + confidence) | **N** | doubly: no `recommendation_id` either (DV-40) |
| DV-27 | No user has to understand internal scores | **C** |

DV-27 is **not vacuous**: `routes/discovery.ts`'s `toPublic` emits no score field on any path, and
`11` §4's rule holds across all ten serve points. The nearest thing, `DiscoveryCandidate.confidence`,
is a declared class prior labelled in source *"Not a measurement"* (`lib/discoveryCandidate.ts:146-146#/** Class prior in [0,1]. Not a measuremen`).

#### `03` Trending §14

| id | Criterion | Verdict | Evidence |
|---|---|---|---|
| DV-28 | Distinguishes emerging vs established | **N** | No trend state machine (`03` §4's seven states) under any name. `lib/discoveryLocalMomentum.ts` computes one 48h-vs-baseline scalar; a scalar is not a lifecycle. |
| DV-29 | Is geographic and temporal | **W** | `lib/discoveryLocalMomentum.ts` is both — **place**-scoped, **48-hour** — but one window on one axis, behind `discovery_ranking_modifiers_enabled` (2289, seeded OFF with a postcondition that RAISEs if seeded ON), absent from production (§5). |
| DV-30 | Normalizes for exposure | **C** | **The #365 defect is closed, re-verified in both directions.** `content_distribution_stats.eligible_impressions` is incremented on the **impression** path and only when the insert landed (`lib/rankLog.ts:154#await recordImpressionDistributionStats(sc`, `lib/rankLog.ts:298#await recordImpressionDistributionStats(sc` — inside the `else` of the insert-error branch), and the outcome route updates only `outcome`/`outcome_at` (`routes/rankEvents.ts:229-238#const { error: updateErr } = await sc`), so it cannot move the denominator. The normaliser divides by exposures, not conversions. |
| DV-31 | Can decay and rediscover | **W** | 1 of 2 — **Decay PASS** — recency weighting inside the momentum window (`lib/discoveryLocalMomentum.ts`). **Rediscovery FAIL** — nothing retests a cooled item; `02` §9.5's *"periodically retest promising items"* has no implementation. |
| DV-32 | Resistant to single-metric manipulation | **W** | Two real defences, both partial: a **minimum-evidence floor** (`MOMENTUM_MIN_RECENT_WEIGHT = 3`) with a hard contribution cap (0.15), and author-trust down-weighting (`lib/portavaRank.ts:307#DOWN when the author's trust is unknown/lo`). None of `03` §12's eight named patterns is detected, and §12's own bar — *"Trending should require diversity of evidence"* — is DV-34 **N**. |
| DV-33 | Can explain major trend reasons | **N** | DV-18: no reason vocabulary exists. |
| DV-34 | Independent convergence (`03` §6; also `05` §4 and `05` §9 — **counted once, here**) | **N** | `grep -rn -i "independent\|convergence\|unrelated circles" lib/discovery*.ts lib/portavaRank.ts` → no such signal. No count of distinct circles, no cross-network adoption term. `03` §6 calls this *"one of Portava's strongest travel-specific signals"*. |

#### `04` Behavior Engine

| id | Obligation | Verdict | Evidence |
|---|---|---|---|
| DV-35 | §3 every event write is **schema-valid** | **C** | Enforced in the database, not only in code: `rank_events_surface_check` (14 values, production-verified) and `rank_events_outcome_check` (`migrations/0197_rank_events_analytics_columns.sql:21-24#DROP CONSTRAINT IF EXISTS rank_events_outc`); pinned against silent widening by `migrations/2298_dead_check_vocabularies.sql:135#watch_feed`, which RAISEs if the constraint loses a value. |
| DV-36 | §3 **attributable to a surface** | **C** | `surface` is NOT NULL and CHECK-constrained on every row (production `information_schema.columns`), and every writer passes it explicitly: `lib/discoveryServeLog.ts:415#rankedInRequest: RANKED_IN_REQUEST.has(ser`, `lib/rankLog.ts:142#const { error: insertError } = await sc.fr`. |
| DV-37 | §3 **idempotent where retried** | **N** | No idempotency mechanism. `lib/discoveryServeLog.ts:444#const { error } = await sc.from("rank_even` is a bare `.insert(rows)` — no `onConflict`, no unique key, no client token; `lib/rankLog.ts:142#const { error: insertError } = await sc.fr` likewise. A retried batch writes duplicate impressions. DSV2-07 asks for *"retry deduplicates"*; nothing does. |
| DV-38 | §3 **versioned** | **N** | `rank_events` has **no `schema_version` column** — production schema is exactly 13 columns (`id, user_id, item_id, item_kind, position, features, outcome, served_at, outcome_at, surface, session_id, event_type, content_type`). `04` §6 names `schema_version` explicitly. |
| DV-39 | §3 **privacy-classified** | **W** | The privacy *rule* is enforced — `lib/rankLog.ts:9-12#Spec §8 privacy rule: precise GPS coordina` states it and the writer strips raw-coordinate keys from `features` before insert — but there is no privacy **classification** on the row: no class column, no retention tier. `04` §11's four-layer retention has no implementation. Rule without label. |
| DV-40 | §5 *"Every served item must have a `recommendation_id`"* + the nine-field minimum record | **N** | **Zero occurrences in Discovery.** `grep -rIn "recommendation_id\|recommendationId" artifacts/api-server/src` returns only Layover and Media hits — different domains, different objects. `rank_events` has no such column. `recommendations` / `recommendation_items` (`10` §3) are absent from the repository **and** production. This one absence holds down DV-06, DV-26, DV-46, DSV2-12 and Phase 4. |
| DV-41 | §7 distinguish active / passive-foreground / idle dwell | **N** | No dwell column (13-column schema; `04` §6 names `dwell_ms`), and no client emits a dwell distinction. §7's rule — *"Do not infer interest from a phone sitting untouched"* — has nothing to govern. |
| DV-42 | §9/§13 current intent and long-term preference are **distinct representations** — SPLIT off A18 | **W** | Both halves exist; only one is reachable. Long-term: `loadPdeViewer` (`lib/discoveryPde.ts`) builds a persistent per-viewer profile. Current intent: the eight modes (`lib/discoveryLiveRank.ts:99-101#export const DISCOVERY_INTENT_MODES = [`), per-request and never written back — structurally the separation §9 asks for. **W** because the intent half is gated OFF (2850) with no client sender (DSV2-03), so in every deployment only the long-term half exists — exactly §9's warned failure mode. |
| DV-43 | §10.1 audit every allowed `rank_events.surface` | **C** | `migrations/0202_…:17-20` is the audit, per surface, distinguishing written-but-empty from never-wired; `migrations/2298:100-101` freezes the audited vocabulary so a surface cannot reappear unaudited. |
| DV-44 | §10.2 prove ≥1 intentional writer per surface, **or retire it** | **W** | Audit happened (DV-43); retirement did not. The CHECK permits 14 surfaces; production holds rows for **five**. Nine — `search`, `nearby`, `story`, `event`, `trip`, `profile`, `explore`, `living_page`, `watch_feed` — have zero rows and none was retired. `2298` pins the dead vocabulary *as dead* rather than removing it: documents the gap, does not close it. |
| DV-45 | §10.5 test all CHECK/enum constraints | **W** | Guarded **in migration** (`2298:135` RAISEs if the surface CHECK loses `watch_feed` or `pulse`) and the vocabulary has tests (`discoveryServeLog.test.ts` A, B, B2, J, K), but the suite runs against `SUPABASE_URL=127.0.0.1:9` — unreachable — so **no test exercises a real CHECK rejection**. The C28 limitation applies: a green run does not prove a constraint. |
| DV-46 | §10.6 test `recommendation_id` propagation | **N** | Nothing to propagate (DV-40). |
| DV-47 | §10.7 verify discovery events exist **once the ranking path executes** | **W** | Discovery events exist (13 rows), so the *serve* path executed. The **ranking** path has never executed in production: `rankedInRequest: true` needs mode `pde` (held OFF, DV-03) or the cold path, and `lib/discoveryServePointReport.ts` reads ranked-ness from `features.rankedInRequest` over a corpus of 13. The instrument is correct; the corpus cannot answer the question. |
| DV-48 | §13 raw vs derived features are separated | **W** | Separated where the ranker runs, lost where the cache serves. A ranked serve writes the raw `features` jsonb per impression (`lib/rankLog.ts:142#const { error: insertError } = await sc.fr`) with the derived order separate. A **Cache-B** serve keeps only the derived order (DV-04), so at that serve point the separation does not exist to be respected. |

*Arithmetic note: `04` §13's six bullets are not six further rows. Four — "no event can silently
fail", "all active surfaces are wired", "recommendation exposures are logged", "events are
versioned" — are DV-07, DV-44, DV-06 and DV-38 restated, counted once there. §13 contributes
DV-48 and, with §9, DV-42.*

#### `05` Graph Engine §9

| id | Criterion | Verdict | Evidence |
|---|---|---|---|
| DV-49 | Improves candidate generation | **W** | A graph ships — `CompassGraphEngine`, rebuilt on a schedule, widened by migration `2290` to admit the `circle` and `experience` kinds `05` §2 names. It reaches Discovery as a **bounded** world-model city-confidence input to `portavaRank`, behind `discovery_ranking_modifiers_enabled` (2289, OFF, absent from production). It does not generate candidates — that is Overpass plus curated rows (`routes/discovery.ts:2066#queryOverpassDeduped(coords.lat, coords.ln`) — it re-weights them, and only when an unlit flag is lit. |
| DV-50 | Respects privacy | **C** | `05` §7's three prohibitions all hold: no block reason stored or exposed (DV-11), no relationship-change reason exists as a field, no message content read (DV-10). Graph tables are service-role-only (`20260730_compass_intelligence_graph.sql`). |
| DV-51 | Can decay stale relationships | **W** | The graph is **rebuilt** on a schedule (`intelligenceGraphScheduler`), retiring an edge that stops being supported — decay by reconstruction, which satisfies §6's warning against a permanent score. It is not the graded, time-aware decay from recency/frequency/diversity that §6 describes. |
| DV-52 | Remains explainable enough for debugging | **?** | The graph is in `compass/**`, another lane's files and forbidden to this one. Its typed node/edge tables are the precondition for explainability, but whether the **Discovery-facing** consumption is debuggable cannot be established from Discovery's files: the single consumption point sits inside the flag-off modifier path and has never run. Recorded `?` rather than guessed in either direction. |

#### `06` Recommendation Engine

| id | Obligation | Verdict | Evidence |
|---|---|---|---|
| DV-53 | §7/§11 exploration is **explicit**: reserved inventory for new creators, low-exposure content, emerging places, new Trails | **W** | Built, inert — `lib/discoveryPde.ts:764#governor = allocateExplorationBudget(gc, {` calls `allocateExplorationBudget` with a budget percentage, stamps `governorSlot`, `governorBudgetPct`, `governorApplied` and `governor_<reason>` into per-item features (`lib/discoveryPde.ts:771#const slotById = new Map(governor.allocati`), reordering only when applied (`lib/discoveryPde.ts:780#if (governor.applied) {`). The whole block sits inside the modifiers flag (`lib/discoveryPde.ts:606#With the modifiers ON the governor owns ex`), seeded OFF; `lib/discoveryPde.ts:526#modifiers: "flag_off", governor: "skipped"` is the flag-off outcome, `governor: "skipped"`. The separate composition path carrying the new-creator bucket, `services/ranking/FeedSlotAllocator.ts:231#export function allocateFeedSlots(` `allocateFeedSlots`, has **no production caller** — `grep -rn allocateFeedSlots --include=*.ts artifacts/api-server/src` returns its definition and two test files only. |
| DV-54 | §6/§11 diversity **enforced** across creator · place · Trail · content type · geography · repeated-recommendation history | **W** | 2 of 6 axes — `lib/portavaRank.ts:420-437#── Diversity (greedy MMR-style re-rank) ──` `diversify()` is a greedy MMR re-rank with `authorPenalty` 0.35 and `kindPenalty` 0.15 over a 3-pick sliding window, wired unconditionally at `lib/portavaRank.ts:540#const diversified = opts.diversity === fal` (`opts.diversity === false` is the opt-out, not the default) — real and ungated. **creator PASS** (`authorPenalty`) · **content type PASS** (`kindPenalty`) · **place FAIL** (no place key in `DiversityOptions`) · **geography FAIL** · **Trail FAIL** (no object) · **repeated-recommendation history FAIL** (the window is within one page; nothing looks across serves — and could not, without DV-40). |
| DV-55 | §9 cold start — new user · new creator · new Trail/place | **W** | 0 of 3 fully — **New creator FAIL** — the bucket exists but is uncalled (DV-53). **New user FAIL** — `loadPdeViewer` degrades to a sparse profile rather than failing, which is graceful but not §9's requirement; its three named inputs (onboarding interests, destination/trip context, local context) reach the ranker only as the destination the request already carries — no onboarding-interest read exists in `lib/discoveryPde.ts`. **New Trail FAIL** — no object (DV-20). Graded `W` not `N` because the degradation path is real and deliberate. |

#### `07` Creator Economy §10 · `08` Revenue §7 · `09` Payment §11 — fourteen rows, all `N`

**Stated once; the evidence is one measurement.** None of the objects these documents specify exists.
Verified in **both** repository and production (read-only): `conversion_events`,
`attribution_records`, `attribution_participants`, `ledger_accounts`, `ledger_entries`,
`payout_holds`, `payout_requests` → `to_regclass` **NULL**, and **no `CREATE TABLE`** for any of them
under `artifacts/api-server/src/migrations/` or `db/`. `09` §1's *"Build now: attribution,
wallet/accounting model, immutable ledger, pending earnings, holds, rule versioning"* has no
implementation of any of its six items.

| id | Criterion | Verdict |
|---|---|---|
| DV-56 | `07` §10 value can be attributed | **N** |
| DV-57 | `07` §10 earnings recordable without paying | **N** |
| DV-58 | `07` §10 rules are versioned | **N** |
| DV-59 | `07` §10 fraud holds exist | **N** |
| DV-60 | `07` §10 historical recalculation possible | **N** |
| DV-61 | `08` §7 revenue aligns with traveler value | **N** |
| DV-62 | `08` §7 sponsored and organic systems are distinct | **N** |
| DV-63 | `08` §7 attribution is auditable | **N** |
| DV-64 | `08` §7 creator share computable from the same ledger | **N** |
| DV-65 | `09` §11 every earning can be reconstructed | **N** |
| DV-66 | `09` §11 no balance depends on mutable totals | **N** |
| DV-67 | `09` §11 attribution is linked | **N** |
| DV-68 | `09` §11 reversals are possible | **N** |
| DV-69 | `09` §11 provider can be swapped later | **N** |

**DV-62 is `N`, not a vacuous `C`, and the choice is deliberate.** No sponsored inventory exists, so
nothing currently contaminates organic rank — but `08` §3's criterion is that the two *systems* be
distinct, and one of them is absent. Recording that as correct would weaken the requirement. The same
reasoning makes DV-81 **`C`**: *"payouts remain disabled"* is a requirement absence genuinely
satisfies; *"sponsored and organic are distinct"* is not.

#### `10` Database · `11` API

| id | Obligation | Verdict | Evidence |
|---|---|---|---|
| DV-70 | `10` §10/§8 migration-to-live drift understood; terminal condition *"zero unexplained drift"* | **W** | The machinery is real: `docs/architecture/migration-disposition-ledger.md`, `migration-queue.md`, `production-migration-log.md`, and `migrations/2254_schema_migration_ledger.sql` backfilling the applied set. The terminal condition is not met, and §5 names live instances: `canonical_locations.search_key` (2220) absent from production, `trips.version` (2420) absent, `protected_zones` absent. Drift is *catalogued* — `10` §8's "documented divergence" disposition — not zero. |
| DV-71 | `10` §5 every user-visible table explicitly defines **read · insert · update · delete** policies — SPLIT off C28 | **W** | 1 of 4 policy kinds, on 1 of 7 tables — Measured in production over `pg_class`/`pg_policy`. **RLS enabled on all seven** `discovery*` tables — the important half **PASSES**. Explicitness **FAILS**: `discovery_place_photos` has RLS on and **zero policies**; `discovery_cache`, `discovery_geocode_cache`, `discovery_place_reports`, `discovery_place_saves`, `discovery_shadow_serves` have **two** each, not four; only `discovery_places` has seven. Fail-closed, so under-specification rather than a leak — but §5's *"Do not rely only on API filtering"* is exactly what a zero-policy table plus a service-role reader amounts to, and §8 of this census records that every Discovery read goes through `getServiceClient()`, bypassing RLS. |
| DV-72 | `10` §10 derived tables are rebuildable | **W** | The one derived store that exists is rebuildable by construction (DV-51). The five `10` §3 projections that would carry Discovery's derived truth — `traveler_affinities`, `place_cooccurrence`, `trail_relations`, `circle_momentum`, `place_momentum` — are **absent from production and repository**. A table that does not exist is not rebuildable. |
| DV-73 | `11` §10 every mutation is authorized — SPLIT off C28 | **C** | 4 of 4 — Four mutating routes, each calling `requireUser(req, res)` as its first statement and returning if absent: `routes/discovery.ts:2372#router.post("/discovery/already-known", as` (`POST /discovery/already-known`), `routes/discovery.ts:3196#router.post("/discovery/community", async` (`POST /discovery/community`), `routes/discovery.ts:3367#router.post("/discovery/community/:placeId` (`.../save`), `routes/discovery.ts:3477#router.post("/discovery/community/:placeId` (`.../report`). Reinforced in the catalogue, not only in code: `discovery_places` grants to `authenticated` and `anon` are **SELECT only** in both databases (C28). |
| DV-74 | `11` §10 admin actions are audited | **W** | Partly, and not on Discovery's own admin surface. The engine-mode write path is fail-closed and refuses an unrecognised mode rather than storing it (`PATCH /admin/feature-flags/:flag/metadata`, migration `2198`) — a real integrity control. `11` §8's Discovery-specific list is six actions: **drift diagnostics PASS**; Trail merge, Trail archive, trend integrity review, creator fraud holds and ledger audit all **FAIL** — four subsystems that do not exist. |

#### `12` Implementation Plan — the six phases that are not duplicates

| id | Phase / clause | Verdict | Evidence |
|---|---|---|---|
| DV-75 | Phase 0.2 finish CI: `ci-verdict` · `live-db-verdict` · `unwired-verdict` | **W** | 0 of 3 by name — A substantial `check:*` suite ships under `artifacts/api-server/scripts/` (census freshness, doc citations, flag polarity, test registration, writerless reads). None of the three named verdicts exists under those names, and the one this census most depends on, `check:doc-citations`, is recorded by §9.8 and §10.4 as unable to see a stale unanchored line number. |
| DV-76 | Phase 0.3 complete privacy/tagging Phase 0 | **?** | Owned by the tagging/notifications censuses, not Discovery's files. Not read here rather than guessed. |
| DV-77 | Phase 0.4 canonicalize media ingest so no unstripped original persists because a completion handler never ran | **N** | `00-readme` §1.4's finding. Owned by `census-media.md`, outside this lane's files — recorded as a package obligation with its owner named, and **not** counted as Discovery's to close. |
| DV-78 | Phase 5 behaviour expansion: dwell · replay · place open · Trail open · send/share · trip add · itinerary add · negative feedback | **W** | 5 of 8 — The `rank_events` funnel carries impression → tap → save/join → attended via `outcome`, and `routes/rankEvents.ts:139#upgradableOutcomesFor` / `routes/rankEvents.ts:208#upgradableOutcomesFor` upgrade a row on a strictly lower funnel rung. **dwell FAIL** (no column, DV-41) · **Trail open FAIL** (no object) · **negative feedback FAIL** — `grep -n "not_interested\ |immediate_skip" routes/discovery*.ts` → nothing; none of `04` §4's six negative types has a Discovery writer. |
| DV-79 | Phase 9 shadow comparison over overlap · save-rate potential · diversity · creator concentration · place diversity · estimated travel intent — SPLIT off C22 | **W** | 1 of 6 — `lib/discoveryDivergenceReport.ts:197-241#export function aggregateDivergence(rows:` `aggregateDivergence` computes **overlap PASS** (`meanOverlapRate`, `lib/discoveryDivergenceReport.ts:211#const overlapRates = rs.map((r) => (r.page`) plus displacement and membership change — richer than asked on that one axis. **save-rate potential FAIL · diversity FAIL · creator concentration FAIL · place diversity FAIL · estimated travel intent FAIL** — none appears in the module. The comparison *mechanism* is `C` (C22); the comparison *dimensions* are one of six. |
| DV-80 | Phase 13 Ecosystem Governor — concentration · new-creator success · stale content · repeated recommendations · spam rate · Trail freshness · hidden-gem exposure | **N** | `grep -rn -i "ecosystemGovernor\|EcosystemGovernor" artifacts/api-server/src` → nothing. The **exploration** governor (DV-53) is a different object: it allocates slots within one page; the Ecosystem Governor monitors the system and adjusts policy bounds (`06` §8 — *"Governor adjusts policy bounds, not individual user outcomes directly"*). |
| DV-81 | Completion — *"payouts remain disabled until economics are validated"* | **C** | Genuinely rather than vacuously satisfied: the requirement is that payouts stay off, and no payout path exists to be on — `payout_requests`/`payout_holds` absent from production and migrations, no provider integration, no payout route. `09` §1's "Do later" list is correctly deferred. |
| DV-82 | Stop conditions — halt rollout if event rejection rises · logging gaps appear · creator concentration spikes · reports/hides increase · **cache bypass reappears** · RLS leaks occur · attribution double-counts | **N** | 0 of 7 enforced — No stop condition is enforced anywhere. Rejections are logged (C25) but nothing thresholds them; there is no concentration monitor (DV-80), no automated RLS-leak detector on this surface, and nothing halts a rollout. The one condition this pass can speak to — *"cache bypass reappears"* — now has a regression test (§11.8), which is a guard on one clause, not the stop condition the phase asks for. |

### 11.6 Existing rows re-graded

Three of the 67 move. **Two move because their stated evidence became false in this tree** — other
lanes built what these rows recorded as absent — and **one moves because the restored requirement
says the opposite of the module header it was graded against.** The other 64 stand as §10 left them;
those re-executed and unchanged are listed after the table.

| id | was | now | why |
|---|---|---|---|
| **A05** | **N** (owner hold) | **W** | **Stated evidence is now false.** The row read *"Nothing in `routes/discovery*.ts` or `lib/discovery*.ts` models an intent mode."* All eight of Sensing §8's modes exist in the spec's own wording and order at `lib/discoveryLiveRank.ts:99-101#export const DISCOVERY_INTENT_MODES = [`, with real weight profiles at `lib/discoveryLiveRank.ts:152#export const INTENT_MODE_PROFILES: Readonl`, parsed at `lib/discoveryLiveRankRead.ts:63#export function parseIntentMode(raw: unkno`, reaching the serve path at `routes/discovery.ts:1880#mode: parseIntentMode(req.query.intentMode` and `routes/discovery.ts:2288#mode: parseIntentMode(req.query.intentMode`. **W, not C, on DSV2-03's bar** — *"UI selection is not merely decorative"*: `grep -rIn intentMode travel-buddy-standalone/src` returns **only the Map's own `features/map/intent/intentModel.ts`**, a different lane's model on a different surface. **No Discovery client sends `intentMode`.** Doubly unreachable — flag FALSE (2850) *and* no caller. The owner hold remains in force and still explains why it is off; it no longer describes the code as absent. |
| **A07** | **N** | **W** | **Stated evidence is now false in both halves.** The row read *"No safety term reaches the ranker… There is also no world safety state to consume."* `lib/discoveryLiveRank.ts:207-208#/** Live-qualified` carries `safety: { unsafe, demoted }` and `lib/discoveryLiveRank.ts:460#Safety first, and only ever downward: a de` forces a demoted row behind every non-demoted row *regardless of score* — Sensing `docs/specs/Portava_Sensing_World_Experience_Intelligence_Upgrade_Architecture_v1.txt:129#Safety constraints outrank opportunity/vib`'s "safety outranks opportunity" implemented as a sort invariant rather than a weight. **W**: gated OFF (2850), and no producer writes `crowd.level='unsafe_density'` in production, so the demotion can never fire. |
| **C14** | **C** | **W** | **Re-graded against the restored requirement, not against new code.** C14 certifies that `/discovery/suggest` returns `200 { groups: [] }` on any internal error, citing the module's own header as the contract. Restored `11` §9 says the opposite in terms: *"A failure must not masquerade as success"* (`docs/specs/discovery-architecture-v1/discovery-v1-11-api-specification.md:103#A failure must not masquerade as success.`) — and requires six distinguishable failure classes. Applied at `routes/discoverySearch.ts:2140#For types without location context, rankBy`, `routes/discoverySearch.ts:2177#case "cities":      return rankByMatchTier`, `routes/discoverySearch.ts:2249#Promise.resolve(searchStatic(q, COMMON_VIB`: every class collapses to one empty success. This is §11.1 in a single row — the contract C14 grades against is the code's description of itself, and the document outranking it was overwritten. **Not fixed here**: surfacing errors changes a live route's contract with no flag; §6 D5's reasoning applies. New owner decision **D11** (§11.10). |

**Re-executed and unchanged:** A01, A02, A03, A04, A10, A11, A18, A20, A25 (evidence re-read at this
commit); B01 — **re-verified in production this pass**, which §9.4 and §10.5 both flagged as owed:
`canonical_locations.search_key` is still **absent** from `ajrurzioarfkagpuxfnb`, so the 2026-09-07
measurement holds at 2026-09-13; B02, B04, B05; C20, C22, C23, C24, C25, C28. **C25 was re-graded
against three restored obligations that map onto it** (`01` §6 rejected-events-observable, `04` §3
observable-on-failure, `04` §10.4 instrument-rejected-writes) and **passes all three**:
`lib/discoveryServeLog.ts:444-449#const { error } = await sc.from("rank_even` branches the error and warns with serve point, route and count;
`lib/discoveryServeLog.ts:477#logger.warn({ err }, "discoveryServeLog: i` warns on a throw. **C28 re-verified in the catalogue** rather than carried: `discovery_places`
has RLS enabled with seven policies, `authenticated`/`anon` SELECT only.

**Net effect on the original 67: C 48 → 47 · W 12 → 15 · N 7 → 5.**

### 11.7 Where the specification is genuinely incomplete — named, not invented

Per the brief these are named and the rest of the work continued.

1. **`01` §8 and `12` Phase 3 require five flag states; the repository implements three and reaches a
   fourth by a different construction (cohort × mode).** The specification does not say whether
   PARTIAL must be a *named state* or may be a *gate*. Graded `W` on the literal reading.
   **Missing:** a ruling on whether `lib/discoveryCohort.ts` discharges PARTIAL. Row DV-08.

2. **`11` §9 and `/discovery/suggest`'s shipping fail-soft contract are in direct conflict.**
   START_HERE: *"Where baseline and upgrade conflict, record the exact conflict and affected rows and
   ask for resolution."* **Exact conflict:**
   `docs/specs/discovery-architecture-v1/discovery-v1-11-api-specification.md:103#A failure must not masquerade as success.` vs
   `artifacts/api-server/src/routes/discoverySearch.ts:2130-2140#offset: number,`. **Affected rows:** C14, DV-74's
   sibling clause. **Asked, not taken** — D11.

3. **DSV2's release gate: *"Provider-backed route time remains unverified until its configured
   integration passes; a distance estimate is not measured travel time."*** Discovery's live-rank
   travel axis decays over `TRAVEL_HORIZON_MINUTES = 45` (`lib/discoveryLiveRank.ts:114#export const TRAVEL_HORIZON_MINUTES = 45;`) from a
   `distanceKm` input (`lib/discoveryLiveRankRead.ts:83#_flagCache = { value, at: Date.now() };`) — **a distance estimate on a travel-time
   axis**, which the gate forbids treating as verified. Graded inside A01's `W` rather than given its
   own row, since A01 already carries the travel-time term; recorded so the gate is not silently
   passed.

### 11.8 What this pass built — the Cache-B eligibility defect, red before and green after

**The defect.** `GET /discovery`'s Cache B (`_compassCandidateCache`, `routes/discovery.ts:285#const _compassCandidateCache = new Map<str`)
holds a **final ranked page** for ten minutes, keyed `userId:destination:radius:sortBy` (`routes/discovery.ts:294#function compassCandidateCacheKey(userId:`).
On a hit it replays that page through `applyFilters` and slices it (`routes/discovery.ts:2131#const cFiltered = applyFilters(cCacheHit.p`). `applyFilters`
(`routes/discovery.ts:1751#function applyFilters(raw: DiscoveryPlace[`) applies open-now, minimum-rating, adult-venue and sort — **and no block filter.**
Block eligibility enters Discovery in exactly one place, `viewerBlockedIds` (`routes/discovery.ts:1718#let viewerBlockedIds: Set<string>`), passed to
`loadCuratedAndCanonicalPlaces` **at read time** (`routes/discovery.ts:2067#loadCuratedAndCanonicalPlaces(destination,` cold path, `routes/discovery.ts:1829#const dbPlaces = await loadCuratedAndCanon` Cache-A path).

The Cache-A path is therefore **safe**, and that asymmetry is what makes the defect real rather than
theoretical: a Cache-A hit re-reads curated rows per request and re-applies blocks at `routes/discovery.ts:1829#const dbPlaces = await loadCuratedAndCanon`, so a
block propagates immediately there. A Cache-B hit re-reads nothing. **A user who blocks someone
continues to be served that person's submitted places for up to ten minutes.**

Against: DSV2-05 (*"cache-hit paths are tested"*), DSV2-06 (*"Changes in permission… invalidate/
revalidate affected results"*), and START_HERE (*"Revocation must propagate to caches, projections,
queued attention, and consumers"*).

**The fix**, in `routes/discovery.ts` only — no migration, no flag, no new table, and no behaviour
change for any user whose block set has not changed:

| what | where |
|---|---|
| The fingerprint rule, as a pure total function with its own header and tests | **new module** `lib/discoveryCacheEligibility.ts` |
| The entry records the block set it was ranked under | `routes/discovery.ts` — `_compassCandidateCache`'s `blockKey` |
| A hit whose fingerprint differs from the request's is a **miss**, falling through to a fresh rank | the `cCacheHit` guard |
| The ranking timestamp survives cache reuse — `cachedAt: cCacheHit.at` instead of `null` | the Cache-B hit's `withDiscoveryCandidates` call |
| Cache-B read/clear test hooks exposing `blockKey`, so a test asserts **which** block set a stored page was ranked under rather than merely that an entry exists | `_testCompassCacheEntry`, `_clearTestCompassCache`, `_testCompassCandidateCacheKey` |

The rule lives in its own module for two reasons: it is unit-testable without standing up the route,
and it keeps `routes/discovery.ts` to **+21 lines** rather than +66 — which matters because other
censuses cite this file by line, and every line added moves their pointers (§11.12).

The fingerprint is deliberately not the set itself but a sorted digest, so an entry cannot be matched
by a set that merely has the same size. `null` — blocks unreadable, which every Discovery reader
treats as fail-closed — is its own value: it never matches a **readable** set, so a page built when
blocks were verifiable cannot be replayed at a moment when they are not; it does match another
`null`, because two fail-closed pages are the same page and forcing a re-rank per request during a
blocks outage would turn a degraded read into a load problem.

**Measured red, then green.** The test was written first and run against the pre-fix behaviour. The
revert was *behaviour only* — the helper, the entry field and the test hooks stayed — so what was
measured is the defect and not a missing import.

| | pre-fix behaviour | after the fix |
|---|---|---|
| `test/discoveryCacheBEligibility.test.ts` (11 cases) | **FAIL — 8 pass / 3 fail** | **PASS — 11 / 11** |

The three that fail before are the three DEFECT cases: **G** a block taken inside the TTL must not be
served around · **H** a same-size block swap must also invalidate · **I** an unreadable block set must
not reuse a page ranked under a readable one. The eight that pass in both states are the inertness
and helper controls — an unchanged block set still hits the cache, a non-empty but unchanged set
still hits it, the key still separates users, a fresh rank still stores — and their passing in both
states is what makes the three failures a defect rather than a rewrite.

**Stated rather than claimed: the freshness leg is NOT proven by the red/green.** Case J's
end-to-end half is inert on this tree, because `discovery_candidate_projection_enabled` (2361) is
seeded FALSE and the projection returns the same array, so there is no `candidate` object to inspect.
What J *does* prove is the mapping the fix depends on — `classifyFreshness("compass_candidate_hit",
null, …)` can only ever report `ageMs: null`, while the entry's own clock produces a real age. The
one-line change from `null` to `cCacheHit.at` is therefore verified by inspection plus that unit
assertion, and becomes live with the flag. Recording it as proven would claim more than the
measurement supports.

**Mutation checks**, each applied to the fixed tree, run, reverted, and `cmp`-verified byte-identical:

| mutation applied | pass / fail | what went red |
|---|---|---|
| `blockFingerprint` returns a constant | 6 / 5 | B, C, G, H, I |
| `blockFingerprint` returns `String(set.size)` | 9 / 2 | B, H — a same-size block swap reuses the page |
| `blockFingerprint(null)` returns the empty-set value | 9 / 2 | C, I — unreadable conflated with "no blocks", the fail-open direction |
| the guard compares the entry's fingerprint to itself | 8 / 3 | G, H, I — a no-op check |
| the store stamps a constant `blockKey` | 10 / 1 | K |

**The fifth mutation is the one worth reading.** Stamping a constant `blockKey` at the store site
**stayed green** on its first run, across all ten cases then written. The constant happened to equal
the no-blocks fingerprint, so every *other* block state mismatched and invalidated — the suite could
see under-invalidation but was blind to **over**-invalidation, where the cache is correct and
useless. A guard that cannot see the mutation it was written to forbid is worse than none, and only
the mutation said so. Case **K** was added for exactly that — a viewer with a stable *non-empty*
block set must still get a cache hit — and the mutation then failed 10 / 1.

**Regression surface.** `pnpm typecheck` exit 0. Adjacent Discovery suites, all green and unchanged:
`discoveryPdeServePath` 2/2 · `discoveryFeed` 30/30 · `discoverySort` 14/14 ·
`discoveryBlockedSubmitter` 25/25 · `discoverySurfaceInstrumentation` 7/7 · `discoveryCandidate`
30/30 · `discoveryVoteL1Eviction` 5/5.

**What this does NOT claim.** It does not re-rank on a block change — it *invalidates*, the cheaper
and more honest of DSV2-06's two permitted responses (*"invalidate/revalidate"*). It does not close
DV-04: model and feature provenance still do not survive Cache B, and closing that needs the
recommendation record DV-40 says does not exist. It does not touch Cache A, already correct on this
axis. And it changes nothing in production, where Discovery is dark (§5) and
`COMPASS_V1_RULE_BASED_ENABLED` gates the branch entirely.

### 11.9 Ceiling — what this lane could not reach, and why

- **42 `N` rows; 25 are four absent subsystems.** Trails, Trending-as-an-engine, Creator Economy and
  the Payment ledger are not code this lane declined to write — they are architecture the owner has
  ruled STALE (`ROADMAP.md:148#>`) or has not scheduled. Building any would be inventing a denominator.
- **`recommendation_id` is one object holding down five rows** (DV-06, DV-26, DV-40, DV-46,
  DSV2-12, plus Phase 4). It needs a migration creating `recommendations` / `recommendation_items`
  and a `rank_events` column — and `10` §7 forbids editing an applied migration, `12` requires CI
  rehearsal first, and this lane may not apply migrations to any live project. **Highest-value single
  item in the corrected denominator, and a migration decision rather than a coding one.**
- **Ranker and Event Truth holds remain in force and were not lifted.** DV-03's fix is built and
  held; A01, A05, A07, DSV2-02, -03 and -09 are built-and-gated behind `discovery_live_rank_enabled`
  (2850) or `discovery_ranking_modifiers_enabled` (2289), both seeded FALSE with postconditions that
  RAISE if seeded ON. **No flag was flipped and no migration applied by this pass.**
- **Production untouched.** Every production interaction here was a read-only `SELECT` against
  `ajrurzioarfkagpuxfnb`: `pg_constraint`, `information_schema.columns`, `pg_class`/`pg_policy`,
  `to_regclass`, and two aggregates over `rank_events`. No write, deploy, migration or flag change.
- **Two `CANNOT-VERIFY` rows are recorded as such rather than guessed.** DV-52 (graph
  explainability) is in `compass/**`; DV-76 (privacy/tagging Phase 0) is another census's. Both
  would have been easy to score `C` from a distance; neither was.
- **BUILT ON A BRANCH IS NOT MERGED. MERGED IS NOT DEPLOYED. DEPLOYED IS NOT FLAG ENABLED. FLAG
  ENABLED IS NOT PRODUCTION REALIZED.** Discovery remains dark: 13 `surface='discovery'` rows ever,
  latest 2026-08-15, re-read from production at this commit.

### 11.10 New owner decision

| # | Decision | Where it bites |
|---|---|---|
| D11 | **Resolve `11` §9 against `/discovery/suggest`'s fail-soft contract.** The restored API specification says *"A failure must not masquerade as success"* and names six failure classes to distinguish; the route returns `200 { groups: [] }` on any internal error, and C14 certified that as correct. Either the route surfaces a distinguishable error (a live-route contract change, so it needs a flag, so it needs a migration), or §9 is explicitly waived for typeahead and C14's contract is rewritten to say so. Not taken here. | C14 · DV-74 |

### 11.11 Restated headline

> **Discovery, at `b7f137a4dfbc05830505382e63d418f3900a4cf1`: 153 requirements ·
> 63 BUILT-AND-CORRECT · 46 BUILT-BUT-WRONG · 42 NOT-BUILT · 2 CANNOT-VERIFY →
> CONSTRUCTED 109 / 153 = 71.2 % · CORRECT 63 / 153 = 41.2 %.**
> Previous statement (§10.6, 67 rows at `3ca68cb06`): 48 / 12 / 7 / 0 → 89.6 % · 71.6 %.
> The denominator grew by 86 rows and no code regressed between the two measurements.
> One row — DSV2-05 — was built, tested red-then-green, and moved to `C` by this pass.

| BUILT-AND-CORRECT | **63** |
|---|---|
| BUILT-BUT-WRONG | **46** |
| NOT-BUILT | **42** |
| CANNOT-VERIFY | **2** |
| **total** | **153** |

### 11.12 Pointer repairs forced by §11.8's code change — declared, because two of them are outside this census

§11.8 adds **21 lines** to `artifacts/api-server/src/routes/discovery.ts`. Every citation into that
file below the insertion points moved with it. `check:doc-citations` was **exit 0 at `b7f137a4d`**
before this pass and is **exit 0 after it**; in between it went red with 25 broken anchors, and this
subsection records what was done about them so the repair is auditable rather than invisible.

**Nothing below is a change of claim.** In every case the anchor TEXT is unchanged and only the line
number moved, which is the whole reason the anchor form exists: the checker could name the new line
because the anchor still matched there.

| file | rows touched | change |
|---|---|---|
| `docs/architecture/census-discovery.md` §2 (above this section) | **6 lines** — C03, C19, C22, C33 and two in §3 / §9.4 | line numbers only, inside existing `#anchor` citations |
| `docs/discovery/ROADMAP.md` | **11 lines** | same |
| `docs/architecture/census-sensing.md` | **3 lines** | same |

The six in this census, exactly:

| row | citation | was | now |
|---|---|---|---|
| C03 | `routes/discovery.ts#fetchBlockedSet` | `:1578`, `:2375`, `:2735` | `:1593`, `:2396`, `:2756` |
| C19 | `routes/discovery.ts#displayName` | `:2783` | `:2804` |
| C22 | `routes/discovery.ts#served` | `:1812`, `:1790` | `:1827`, `:1805` |
| C33 | `routes/discovery.ts#.select("date_of_birth")` | `:1545`, `:2627` | `:1560`, `:2648` |
| §3 lead row | same pair | `:1545,2627` | `:1560,2648` |
| §9.4 A01 | `routes/discovery.ts#const liveRanked = await withDiscoveryLiveRank` | `:1722` | `:1737` |

**Two declarations the integration owner should check rather than take on trust.**

1. **This census is APPEND-ONLY, and the six repoints above are edits above this section.** They are
   line numbers inside anchors and nothing else — no verdict, no evidence sentence, no prose. The
   distinction matters and is offered for rejection, not assumed: a repoint keeps a claim checkable,
   where leaving it would have made `check:doc-citations` red on a claim that is still true. The
   document's own §2a and §2c already carry `POINTERS REPOINTED 2026-09-13 (§11)` markers written by
   an earlier integrator against a §11 that did not yet exist; this is that §11.

2. **`docs/architecture/census-sensing.md` is another lane's census and this lane edited three of its
   lines.** The three anchors point at `routes/discovery.ts`, which is this lane's file, and they
   broke because this lane moved those lines. The edit is `:1722 → :1737` and `:2076 → :2097` on
   `#withDiscoveryLiveRank`, nothing else. It is flagged here **because it is the kind of cross-lane
   edit that should not pass unnoticed**: if the Sensing lane would rather own that repair, revert
   those three lines and the only consequence is that `check:doc-citations` goes red until they do.


### 11.13 Making this section machine-readable — and a parser finding that would have inflated it

§9.1 is the reason this subsection exists: sixteen of this census's rows once sat outside every
number the repository reports, because `verdictOf` could not read a cell that carried a qualifier
beside the verdict. Repeating that would have been worse the second time, so the rows above were
run against the tool rather than assumed to be readable, and three things had to change.

**1. Every verdict cell is a bare token.** Twenty-three of the new rows were first written
`**W** — 1 of 5 criteria passes` and `**CANNOT-VERIFY**`, both of which `verdictOf` rejects. The
criterion counts that rule 1 requires are still there — they moved to the front of the evidence
cell, where they are prose rather than an unparseable verdict — and `CANNOT-VERIFY` is written
`**?**`, which the tool maps to the same bucket.

**2. The ids are `DV-nn`, not `DV1-nn`, and the reason is a real defect in the guard.**
`parseIdCell`'s prefix pattern is `^([A-Z]{1,4}-?)([0-9]{1,4})`, which cannot absorb a digit into a
prefix. Given `DV1-20` it therefore takes the prefix as `DV`, and then reads the rest as a **RANGE**:
`DV1` through `DV20`. Measured, not theorised — with `DV1-nn` ids the tool reported Discovery as
**C 47 · W 15 · N 87**, because eighty-two rows had expanded into hundreds of phantom ids and the
last-written table (`07`/`08`/`09`, all `N`) won the collapse. **It would have reported a census
41 points more not-built than its own body claims, and exited 0 while doing it.** With `DV-nn` the
prefix absorbs the hyphen and each row is one id.

**This is a finding about the guard, not only about these ids.** Any census using a prefix that ends
in a digit is exposed: `CPV2-01` and `TRV2-01` — the Compass and Trust v2 vocabularies the owner's
framing defines — parse as ranges `CPV2–CPV1` and `TRV2–TRV1`, which are backwards, so
`parseIdCell` returns null and those rows are silently **not counted** rather than miscounted.
`DSV2-04` is the dangerous middle case: `DSV2`→`DSV4` is a *valid* forward range, so it would expand
to three phantom ids. Reported to the integration owner; the fix is in
`src/scripts/checkCensusIntegrity.ts`, which this lane does not own.

**3. What the tool can and cannot read here, reconciled exactly.**

| | rows | C | W | N | X |
|---|---|---|---|---|---|
| `check:census-integrity` parses | 149 | 62 | 45 | 40 | 2 |
| the four DSV2 rows it cannot read (§11.4; they live in the mapping table, not a verdict table, and `DSV2-04` would misparse as a range if they did) | 4 | 1 | 1 | 2 | 0 |
| **stated in §11.3 and §11.11** | **153** | **63** | **46** | **42** | **2** |

The four, restated so the gap is zero: **DSV2-04 `N`** · **DSV2-05 `C`** · **DSV2-06 `W`** ·
**DSV2-12 `N`**. The tool reports them as *"4 counted where this tool cannot read"*, which is
accurate. After this section the difference between what this document says and what the repository
can verify about it is those four rows and nothing else.

---

## 12. The cache-provenance, explainability and stop-condition pass, 2026-09-14 — seven rows moved

*Measured and built in worktree `/home/user/wt-483` (detached at `7d1f2d498`, PR #483 head plus the
v2 spec install), 2026-09-14, with seven sibling lanes editing the same tree. APPEND-ONLY and
LAST-STATEMENT-WINS, as §11 established: where this section and any section above disagree, this one
is the later statement.*

### 12.1 Which copy of the specification this section cites, and why it does not change a verdict

`docs/specs/discovery-v1/` was installed on 2026-09-14 from `portava-architecture-upgrades-v2.zip`
(`docs/specs/discovery-v1/00-PROVENANCE.md:3#**Installed 2026-09-14** from `). §11 cited the same
package at `docs/specs/discovery-architecture-v1/`. **The two are byte-identical** — verified here by
`diff` over `01`, `02` and `11`, which returned nothing — so every §11 citation still resolves and
none is restated. New citations in this section use `docs/specs/discovery-v1/`, the path the
provenance note names as canonical.

The filename-collision hazard §11.1 recorded is unchanged and was respected: no verdict below cites
a `docs/architecture/` current-state file as a requirement.

### 12.2 Row moves

| id | was | now | why |
|---|---|---|---|
| **DV-04** | **W** | **C** | **All five `06` §5 fields now exist and survive the cache.** Was 1 of 5 (a write clock, and only by courtesy). The Cache-B entry is now `{ places, at, blockKey, rankVersion, provenanceById }` (`artifacts/api-server/src/routes/discovery.ts:285#const _compassCandidateCache = new Map<str`), where each row's provenance carries model version (`artifacts/api-server/src/lib/discoveryRankProvenance.ts:73#export const DISCOVERY_MODEL_VERSION`), feature version (`artifacts/api-server/src/lib/discoveryRankProvenance.ts:80#export const DISCOVERY_FEATURE_VERSION`), candidate source recorded **at retrieval** rather than inferred from the id (`artifacts/api-server/src/lib/discoveryRankProvenance.ts:127#export function candidateSourceMap(`, built at `artifacts/api-server/src/routes/discovery.ts:2179#const cSourceById = candidateSourceMap(`), the ranker's own grounded reasons (`artifacts/api-server/src/lib/discoveryRankProvenance.ts:190#export function reasonsFromPipelineResult`) and a **ranking timestamp read once when the ranker returned** (`artifacts/api-server/src/routes/discovery.ts:2185#const cRankedAt = Date.now();`). The hit path REPLAYS the stored record rather than rebuilding it (`artifacts/api-server/src/routes/discovery.ts:2142#provenanceById: cCacheHit.provenanceById,`), so `rankedAt` reports when the rank happened, not when the cache was read. §12.4 tests L, M, N, N2; mutation M1 (re-stamp `rankedAt` on replay) and M2 (`provenanceById: null` on the hit) both watched red. **Flag-independent**: the cache stores provenance whether or not `discovery_candidate_projection_enabled` is lit; the flag gates only whether the client sees it. |
| **DV-48** | **W** | **C** | **The one named failure is closed, and the separation is now structural rather than a convention.** The row read *"Separated where the ranker runs, lost where the cache serves… a Cache-B serve keeps only the derived order."* A Cache-B serve now carries both, in two different fields that two different functions produce: RAW per-signal contributions in `features` (`artifacts/api-server/src/lib/discoveryRankProvenance.ts:157#export function featuresFromPipelineResult`, only `factor_*` keys) and DERIVED scores in `scores` (`artifacts/api-server/src/lib/discoveryRankProvenance.ts:174#export function scoresFromPipelineResult`), with the derived page order stored separately as the array itself. `04` §13's criterion is *"raw vs derived features are separated"*; a bag that mixed a model's inputs with its own output is exactly what `01` §7 says makes re-ranking impossible. Test N2 asserts no key crosses; the mutation that leaked `finalScore` into `features` was watched red. |
| **DSV2-06** | **W** | **C** | **The third noun — VERSION — is now bound; the other two already were.** DSV2-06 is *"Bound final caches by authorized context, version and freshness"*. §11.8 bound the authorized context (`blockKey`); the TTL bound freshness; **nothing bound version**, so a page ranked by one model/feature shape stayed replayable across a deploy that changed it — and a rolling deploy serves both shapes at once. The whole acceptance rule is now one pure, precedence-testable function (`artifacts/api-server/src/lib/discoveryCacheEligibility.ts:149#export function cacheBEntryUsable(`) over `absent → expired → block_set_changed → rank_version_changed`, consulted by the route at `artifacts/api-server/src/routes/discovery.ts:2123#const cAcceptance = cacheBEntryUsable(cStored`. An entry with **no** recorded version is rejected, never accepted by default. The requirement's second clause, *"feature and model provenance survives cache reuse"*, is DV-04's build above. §12.4 tests P1–P7, Q1–Q2; mutations "accept unknown version", "drop the version check" and "TTL boundary `<=`" each watched red, the second one red at the route level too. **One clause is recorded as having no subject rather than as satisfied** — see §12.6. |
| **DV-82** | **N** | **W** | **2 of 7 stop conditions are now ENFORCED; the other five are named as unenforceable rather than left silently missing.** Was 0 of 7 — *"No stop condition is enforced anywhere… nothing halts a rollout."* `12` `:206` says *"Stop rollout if: event rejection rises, recommendation logging gaps appear…"*. Both now have a producer and a threshold (`artifacts/api-server/src/lib/discoveryStopConditions.ts:197#export function evaluateStopConditions(no`), fed by the only instrument that knows whether a Discovery event landed (`artifacts/api-server/src/lib/discoveryServeLog.ts:450#recordServeLogOutcome({`, and a throw recorded at `artifacts/api-server/src/lib/discoveryServeLog.ts:475#recordServeLogOutcome({ outcome: "threw",`), and a trip **halts the rollout** by forcing `legacy` at `artifacts/api-server/src/lib/discoveryEngineMode.ts:320#const stop = evaluateStopConditions();` with its own reason token `stop_condition`. The control is **one-way by construction** — it can only resolve toward `legacy`, which is what every user already receives — and it is pinned as one-way by test O3. `W`, not `C`: `creator_concentration`, `reports_hides`, `cache_bypass`, `rls_leak` and `attribution_double_count` have no input inside Discovery's instruments and are listed at `artifacts/api-server/src/lib/discoveryStopConditions.ts:101#export const STOP_CONDITIONS_WITHOUT_PROD`, carried in every verdict's `unenforced` field so a clean result cannot be read as *"all seven are fine"*. §12.5 says what would supply each. |
| **DV-28** | **N** | **W** | **A lifecycle now exists where there was a scalar.** The row read *"No trend state machine under any name. `lib/discoveryLocalMomentum.ts` computes one 48h-vs-baseline scalar; a scalar is not a lifecycle."* `03` §9's six place-momentum stages exist in the specification's own order at `artifacts/api-server/src/lib/discoveryTrendState.ts:76#export const TREND_STATES = [`, classified at `artifacts/api-server/src/lib/discoveryTrendState.ts:139#export function classifyTrendState(e: Tren` from a **third window** the rows already contained (`artifacts/api-server/src/lib/discoveryTrendState.ts:175#export function computeTrendStates(`), computed beside the scalar out of the same corpus (`artifacts/api-server/src/lib/discoveryLocalMomentum.ts:248#trends = computeTrendStates(rows, nowMs);`) and carried to a consumer at `artifacts/api-server/src/lib/discoveryModifiers.ts:249#trendStates = readLocalTrendStates(params.`. The third window is the point: `emerging` and `cooling` can produce the SAME momentum number — no history with a little activity, versus long history with less of it — and `03` §14's acceptance criterion is precisely *"it can distinguish emerging vs established"*. `W`, not `C`, on two counts stated rather than glossed: the whole path sits behind `discovery_ranking_modifiers_enabled` (2289, seeded FALSE, absent from production), and `03` §4's SEVEN-state **content** lifecycle remains absent — §4 requires the lifecycle to *"depend on content type"*, which a place-scoped activity signal has no dimension to do. |
| **DV-33** | **N** | **W** | **Trend reasons are produced, grounded, and in plain language.** Was *"DV-18: no reason vocabulary exists"* — that premise is now false twice over. `01` §11's vocabulary is DV-18 above, and `03` §11's trend-specific explanations are at `artifacts/api-server/src/lib/discoveryTrendState.ts:234#const TREND_EXPLANATION`, one per state that IS a claim, with `unknown` returning null (`artifacts/api-server/src/lib/discoveryTrendState.ts:242#export function explainTrendState(state: D`) because a state that is not a claim must not produce a sentence that reads like one. `W`: same 2289 gate, and `03` §11's own examples INTERPOLATE (*"Rising quickly in Sukhumvit tonight"*) while these are fixed strings — deliberately, because the interpolatable value is a neighbourhood and the sensitive-location policy governs exactly that. §12.5 says what would settle it. |
| **DV-18** | **N** | **W** | **6 of 9 codes now have a grounded producer; 3 have none and are never emitted.** Was **zero of nine**. `01` §11's nine internal reason codes exist in the specification's own order at `artifacts/api-server/src/lib/discoveryReasonCodes.ts:94#export const DISCOVERY_REASON_CODES = [`, mapped from the signals the two rankers actually compute — Compass's grounded `RankingFactor.key` list and portavaRank's positive feature keys — at `artifacts/api-server/src/lib/discoveryReasonCodes.ts:210#export function reasonCodeForSignal(signal`, with plain-language strings at `artifacts/api-server/src/lib/discoveryReasonCodes.ts:236#const PLAIN_LANGUAGE`, reaching the served projection at `artifacts/api-server/src/lib/discoveryCandidate.ts:306#reasons: explainReasons(signals),`. **W, not C**: `trail_affinity`, `trip_match` and `season_match` have no producer on this surface and are named as such (`artifacts/api-server/src/lib/discoveryReasonCodes.ts:113#export const REASON_CODES_WITHOUT_PRODUCER`) rather than manufactured — see §12.5 for what would turn each one green. |

**Net: C 63 → 66 · W 46 → 47 · N 42 → 38 · X 2.** No row moved on re-reading alone; each of the four
moved because code was written, and each has a test that was watched fail first (§12.4).

### 12.3 Restated headline

> **Discovery, at worktree `/home/user/wt-483` (`7d1f2d498` + this pass): 153 requirements ·
> 66 BUILT-AND-CORRECT · 47 BUILT-BUT-WRONG · 38 NOT-BUILT · 2 CANNOT-VERIFY →
> CONSTRUCTED 113 / 153 = 73.9 % · CORRECT 66 / 153 = 43.1 %.**
> Previous statement (§11.11, 153 rows at `b7f137a4d`): 63 / 46 / 42 / 2 → 71.2 % · 41.2 %.

Read with §11.13's reconciliation, **and note that the parseable count moved by one row this pass**:
`check:census-integrity` now parses **150** rows and reports **C 65 · W 47 · N 36 · X 2**, where it
parsed 149 before. The extra row is `DSV2-06`, which §11.13 had to leave in a mapping table because a
`DSV2-nn` id in a verdict table risks parsing as a RANGE; written as a single row in §12.2's
four-row table it parsed as one id, and the tool's total moved from 149 + 4 to 150 + 3. Measured, not
assumed — `check:census-integrity` reports `discovery 150 65 44 39 2 → 153, 3 counted where this tool
cannot read`. The three it still cannot read are **DSV2-04 `N` · DSV2-05 `C` · DSV2-12 `N`**.
150 + 3 = 153, and the difference between what this document says and what the repository can verify
about it is those three rows and nothing else.

**This does not license writing `DSV2-nn` ids into verdict tables generally.** §11.13's finding
stands: `DSV2-04` in a verdict table would expand to the forward range `DSV2…DSV4` and inflate the
denominator with phantom ids. `DSV2-06` happens to be safe; the guard defect in
`src/scripts/checkCensusIntegrity.ts` is not fixed, and that script is not this lane's to fix.

**BUILT ON A BRANCH IS NOT MERGED. MERGED IS NOT DEPLOYED. DEPLOYED IS NOT FLAG ENABLED.** Everything
in §12.2 is uncommitted work in a shared worktree. No flag was flipped, no migration was written, and
no production statement in §5 or §11 was re-measured by this pass.

### 12.4 What was built, and the mutation that turned each test red

All tests live in files already registered in the api-server `test` script, because registering a new
file requires `package.json`, which this lane does not own.

| test | file | what it pins | mutation watched RED |
|---|---|---|---|
| L, M, N, N2, O | `artifacts/api-server/src/test/discoveryCacheBEligibility.test.ts` | the five `06` §5 fields on a fresh Compass rank; all five identical across a cache-B hit; the feature vector and the score bag survive; no derived key in `features`; `rankedBy: "compass"` on both Compass serve points | (a) hit path re-stamps `rankedAt: Date.now()` → M red; (b) hit path passes `provenanceById: null` → M and N red; (c) `featuresFromPipelineResult` emits `finalScore` → N2 red |
| P1–P7, Q1–Q2 | same file | the cache-B acceptance rule's four rejection reasons and their precedence; the route consults it; a re-rank re-stamps the current version | (a) `entry.rankVersion != null &&` guard added (unknown accepted) → P6 red; (b) version check deleted → P5, P6 and the route test Q2 red; (c) TTL `<` → `<=` → P3 red |
| I1–I9 | `artifacts/api-server/src/test/discoveryCandidate.test.ts` | all nine `01` §11 codes present in the spec's wording; the signal→code map; producerless codes never emitted; no safety/moderation/block signal becomes public text; plain language exists for every emittable code and leaks no private context; the projection carries reasons and says nothing when nothing ranked | (a) map `trust` → `creator_affinity` → I5 red; (b) map `history` → `trail_affinity` → I4 and I7 red; (c) replace a plain-language string with its own key → I7 red |
| N1–N8, O1–O4 | `artifacts/api-server/src/test/discoveryEngineMode.test.ts` | all seven `12` stop conditions named in the spec's order; the five without a producer can never appear in `tripped`; nothing trips on an empty or small window; a rejection rate above threshold trips; a served-item gap with a ZERO rejection rate trips separately; the window ages and the stop recovers; a trip forces `legacy` for `pde` and for `shadow`; the stop never promotes a mode and never rewrites why a disabled flag was legacy | (a) drop the minimum-sample floor → N3 red; (b) make the window never age → N7 red; (c) delete the logging-gap condition → N6 red; (d) resolver ignores the trip → O1 and O2 red; (e) writer stops recording → serve-log M and M3 red |
| M, M2–M5 | `artifacts/api-server/src/test/discoveryServeLog.test.ts` | a rejected, landed and thrown insert each reach the stop window; a disabled flag and an empty page record NOTHING | (e) above |
| `03` §9 blocks | `artifacts/api-server/src/test/discoveryLocalMomentum.test.ts` | the six stages in the spec's order; emerging and cooling separable at the SAME recent rate; emerging vs established; trending is acceleration, not volume; rediscovered requires the quiet middle; below-floor recent is `unknown`, never `cooling`; every state that is a claim has plain language that names nobody; the scalar is unchanged; the two modules' floor and weights are equal | (a) drop the no-history branch → 3 red; (b) `rediscovered` without a quiet middle → 5 red; (c) below-floor recent becomes a claim → 2 red; (d) drop window normalisation → 1 red; (e) the two modules' floors diverge → 2 red |
| Phase 9 blocks | `artifacts/api-server/src/test/discoveryShadow.test.ts`, `…/discoveryDivergenceReport.test.ts` | per-page diversity / place-diversity / save-potential; the unmeasurable axes reported as `null` and NAMED; the writer actually stores them; the reader excludes un-dimensioned rows from the mean and says how many it used | (a) reader counts missing rows as zero → 2 red; (b) a null save-mean becomes 0 → 1 red; (c) the writer drops the blob → initially **GREEN**, which is why the writer test exists; with it, red |

Mutation (c) in the Phase 9 row is worth keeping: with the pure functions fully covered, deleting the
call that STORES their output left every test green. A dimension nobody writes is a dimension the
report can never read. The writer test was added for that reason and the mutation then bit.

**One honesty note about the order of work, since the rule is test-first.** Every block above was
written test-first and watched fail for the right reason EXCEPT the Phase 9 READER half
(`aggregatePhase9` / `formatPhase9` in `discoveryDivergenceReport.ts`), whose tests were written
after its implementation and were green on first run. They are mutation-verified — (a) and (b) in
the Phase 9 row each turned them red — but a green-on-first-run test is weaker evidence than one
watched fail, and saying so is cheaper than pretending otherwise. The DV-18 block's first red was a
module-resolution failure (the module did not exist) rather than a value-level assertion; that is a
true red for the right reason but a blunt one, and its assertions were separately proved to bite by
the three mutations listed.

### 12.5 Rows examined and deliberately left where they are — with what would turn each red

Per the brief, every row left `W`/`N`/`X` here says concretely what evidence would settle it and who
can supply it. These are the rows this pass touched or re-executed; the rest stand as §11 left them.

| row | verdict | what would settle it, and who can supply it |
|---|---|---|
| DV-18 | **W** | `trail_affinity` needs a Trail object — `trails` / `content_trails` / `trail_edges` are absent from the repository and from production (§11.3a), so this is DV-20's migration, not a Discovery coding task. `trip_match` needs a trip-fit term in the RECOMMENDATION ranker: the trip projection Discovery consumes (`artifacts/api-server/src/lib/discoveryTripProjectionConsumer.ts:203#export async function discoveryTripProject`) reaches the SEARCH route only, and `GET /discovery` takes no `tripId` at all (`grep -n tripId artifacts/api-server/src/routes/discovery.ts` → nothing). `season_match` needs any seasonality signal; none exists under any name — Compass's `time_relevance` is hours-to-event. Owner: Trails (DV-20) and whoever owns trip context on the recommendation path. |
| DV-79 | **W** | Improved 1 of 6 → **4 of 6** by this pass. `pageDimensions` (`artifacts/api-server/src/lib/discoveryShadow.ts:222#export function pageDimensions(items: read`) computes **diversity** (distinct categories + normalized entropy), **place diversity** (distinct places, neighbourhoods and ~1 km geo cells) and **save-rate potential** (mean demonstrated saves per item, carried with its own coverage, labelled a PROXY and not a predicted rate); `compareShadowPages` (`:282`) keeps legacy and PDE on separate axes and never blends them; the writer stores the block inside the existing `pde_stages` jsonb (`artifacts/api-server/src/lib/discoveryShadow.ts:367#const phase9 = p.legacyItems && p.pdeItems`), so no column and no migration is added, and the reader aggregates only the rows that carry it (`artifacts/api-server/src/lib/discoveryDivergenceReport.ts:160#export function aggregatePhase9(rows: read`). **creator concentration** cannot be computed at all: a served `DiscoveryPlace` carries NO author — no `submitted_by`, `authorId` or `creatorId` field exists on it. It would take either an author on the served shape or a join the shadow writer does not do. **estimated travel intent** needs a per-item trip-add / itinerary-add signal, which needs DV-40's recommendation object. Both are reported `null` and NAMED in every row's `unmeasured` list rather than defaulted to zero. Owner: DV-40 (migration) for intent; the serve-shape owner for the author. |
| DV-82 | **W** | 2 of 7 enforced. **What would settle the other five:** `creator_concentration` needs an author on the served shape (see DV-79) or a join the serve path does not do. `reports_hides` needs a counter Discovery does not own — reports and hides are written on other surfaces' routes. `cache_bypass` needs a RUNTIME detector, and the input for one already exists in shape: `features.rankedInRequest` on every serve-log row. It cannot be thresholded yet because the ranked path has never executed in a deployment (DV-47), so the healthy value is unknown and any threshold would be invented. `rls_leak` needs a catalogue read, not a request-path counter. `attribution_double_count` needs an attribution subsystem (DV-56…DV-69). **Also worth an owner's eye:** the two thresholds (5 % rejection, 10 % gap) are this lane's proposals, not a ruling, and the halt is bounded by the mode resolver's 30-second cache rather than being instantaneous. |
| DV-28 · DV-33 | **W** | Both are **built and gated**, which is this census's most common shape and is said plainly rather than dressed up: `discovery_ranking_modifiers_enabled` (2289) is seeded FALSE with a postcondition that RAISEs if seeded ON, and is absent from production, so in every deployment today the stages are computed by nobody and the explanations are seen by nobody. **What would turn DV-28 green:** `03` §4's content lifecycle, which needs a per-content-type decay model — a nightclub event and a temple guide cannot share one — and that needs a content-type dimension the place-scoped signal does not have. **What would turn DV-33 green:** a ruling on whether a public explanation may name a neighbourhood. `03` §11's examples do (*"Rising quickly in Sukhumvit tonight"*); the sensitive-location policy governs place naming; nobody has said which side of it a trend sentence falls on. Owner: whoever owns the sensitive-location policy. Until then fixed text is the honest amount of specificity. |
| DV-29 · DV-31 | **W** | Improved by DV-28's build, not closed. **DV-29** (*"is geographic and temporal"*) was *"one window on one axis"*; it is now **three** windows — 48 h, 7 d, 30 d, each normalised to a comparable 48-hour rate — but still one geographic axis, the place. A radius- or neighbourhood-scoped Local Pulse (`03` §3) does not exist. **DV-31** (*"can decay and rediscover"*) was 1 of 2 with *"nothing retests a cooled item"*. A `rediscovered` STATE now exists and is detectable — but detection is not retesting: `02` §9.5's *"periodically retest promising items"* would need something to deliberately re-expose a cooled place, and the exploration governor that could do it is itself inert (DV-53). Both stay `W`, and both are gated. |
| DV-37 | **N** | Unchanged, and re-executed: `artifacts/api-server/src/lib/discoveryServeLog.ts:444#const { error } = await sc.from("rank_even` is still a bare `.insert(rows)` with no `onConflict`, no unique key and no client token. **What would settle it:** a unique index over `(user_id, item_id, session_id, served_at)` on `rank_events`, or an idempotency-token column — either is a migration, and this lane may not write one. An in-process dedupe was considered and rejected: with more than one server process it would guarantee nothing while looking like a guarantee. Note also that **no retry path exists today** — the writer is called once, `void`, after the response — so the clause is currently unexercised as well as unimplemented, and both facts need saying. |
| DSV2-06 · trip-context clause | **recorded, offered for rejection** | DSV2-06's evidence sentence names three things that must invalidate: permission, **trip context**, and evidence validity. Permission and validity are bound. **Trip context has no subject on this surface**: `GET /discovery` reads `destination`, `lat/lng`, `userLat/userLng`, `category`, `radiusKm`, `sortBy`, `page` and `context` — and no trip identifier, so there is no trip context for a cache key to bind. This is offered as a judgement rather than assumed: if the owner reads the clause as forbidding a `C` until a trip parameter exists and is bound, DSV2-06 returns to `W` on that clause alone. **What would turn it red:** any `tripId` / trip-context parameter added to `GET /discovery` without also entering `cacheBEntryUsable`. |
| DV-13 · DV-20…DV-26 · DV-56…DV-69 | **N** | Unchanged and not re-litigated. §11.9 is right that these are four absent subsystems, verified NULL in production over eighteen table names. Building any of them from this lane would be inventing a denominator. **What would settle them:** an owner decision to schedule Trails / the creator ledger, then migrations. |
| DV-52 | **?** | Unchanged. The graph is in `compass/**`, another lane's files. This pass did not read them to score the row, for the same reason §11.9 gave — a `C` awarded from a distance is the failure mode this census exists to avoid. |

### 12.6 Rows found MIS-GRADED, with evidence — two corrections, neither a verdict move

Reported rather than acted on, because in both cases the verdict survives the correction and only the
stated evidence is wrong. A census whose reasons are wrong for rows whose verdicts are right is the
harder defect to find, so both are recorded.

1. **DV-78's negative-feedback evidence overstates the absence.** The row reads *"negative feedback
   FAIL — `grep -n "not_interested\|immediate_skip" routes/discovery*.ts` → nothing; none of `04` §4's
   six negative types has a Discovery writer."* The grep is accurate; the conclusion is not. A
   negative outcome exists, is reachable end to end, and accepts Discovery's surface:
   `artifacts/api-server/src/routes/rankEvents.ts:99#const OUTCOME_VALUES = ["tap", "save", "join"`
   carries `'dismiss'` (migration 2297), and `artifacts/api-server/src/routes/rankEvents.ts:169#const SURFACE_VALUES = ["pulse", "discover`
   admits `surface: "discovery"`, so a Discovery-served impression can be dismissed and that dismissal
   writes — `artifacts/api-server/src/test/discoveryNegativeSignalWriter.test.ts` proves the resulting
   classification is reachable. **The verdict does not move**: `dismiss` is ONE token where `04` §4
   names six distinct types, and `grep -rn "dismiss" travel-buddy-standalone/src` finds no client that
   sends one — so the leg is genuinely unsatisfied. What is wrong is "has no writer"; the writer
   exists and is unexercised, which is a different sentence with a different owner (the client).
2. **A03's `whyForUser` was empty on a serve point where a ranker DID run, and the row does not say
   so.** A03 records `whyForUser` as *"EMPTY whenever no per-user ranker ran"*. Before this pass both
   Compass serve points passed `scoredById: null` — including `compass_fresh_rank`, where the Compass
   pipeline had just computed a grounded `RankingFactor` list for every row and the route discarded it
   before serialising. So the field was empty on a serve where the stated precondition for emptiness
   was false. Closed by §12.2's build (`artifacts/api-server/src/lib/discoveryCandidate.ts:292#const signals =`).
   **A03 stays `W`** on its own stated reason, which is untouched: `whyNow` is still null on every row
   because the live producer is gated OFF (2850).

### 12.7 Pointer repairs, and two cross-lane requests this lane did NOT make itself

§12.2's code adds 117 changed lines to `artifacts/api-server/src/routes/discovery.ts` and lines to
eight `lib/discovery*.ts` modules, so every anchored citation below an insertion point moved. **68 anchors
broke, and every one was verified to have resolved at `HEAD` before this pass** — computed by extracting
each file's `HEAD` text with `git show` and re-testing the anchor at its cited line, so the repair set
is exactly this pass's doing and nothing else's.

**39 of them are in this census and were repointed here, along with the citations this section
itself introduced.** `check:doc-citations` now reports **zero** broken anchors in
`census-discovery.md`. As §11.12 established: the anchor TEXT is
unchanged in every case and only the line number moved, which is the whole reason the anchor form
exists. No verdict, evidence sentence or prose was touched by a repoint.

**The remaining 29 are in two files this lane does not own, and were NOT edited.** LANE-RULES §2 says
to stop and report rather than edit another lane's file; §11.12's own footnote flagged exactly this
kind of edit as one that should not pass unnoticed. The repoints are mechanical and are given in full
so the owner can apply them without recomputing:

*`docs/discovery/ROADMAP.md` — 20 anchors:*

| doc line | from | to |
|---|---|---|
| 430, 1348 | `routes/discovery.ts:1957#` | `routes/discovery.ts:2019#` |
| 531, 614, 1326 | `routes/discovery.ts:1833#` | `routes/discovery.ts:1890#` |
| 532, 617, 1471 | `routes/discovery.ts:1711-1714#` | `routes/discovery.ts:1768-1771#` |
| 614, 1353 | `routes/discovery.ts:1989#` | `routes/discovery.ts:2064#` |
| 614 | `routes/discovery.ts:2052#` | `routes/discovery.ts:2149#` |
| 647, 1616 | `routes/discovery.ts:1816#` | `routes/discovery.ts:1873#` |
| 531, 1438 | `discoveryDivergenceReport.ts:51-55#` | `discoveryDivergenceReport.ts:78-82#` |
| 626 | `lib/discoveryDivergenceReport.ts:51-55#` | `lib/discoveryDivergenceReport.ts:78-82#` |
| 661 | `lib/discoveryServeLog.ts:274#` | `lib/discoveryServeLog.ts:294#` |
| 664 | `lib/discoveryLocalMomentum.ts:152#` | `lib/discoveryLocalMomentum.ts:157#` |
| 1439 | `discoveryDivergenceReport.ts:91-92#` | `discoveryDivergenceReport.ts:148-149#` |
| 1441 | `discoveryDivergenceReport.ts:144-152#` | `discoveryDivergenceReport.ts:241-250#` |

*`docs/architecture/census-sensing.md` — 9 anchors:*

| doc line | from | to |
|---|---|---|
| 886 | `lib/discoveryCandidate.ts:122#` | `lib/discoveryCandidate.ts:133#` |
| 952 | `lib/discoveryCandidate.ts:111#` | `lib/discoveryCandidate.ts:122#` |
| 953 | `lib/discoveryCandidate.ts:130#` | `lib/discoveryCandidate.ts:141#` |
| 2514, 2667 | `routes/discovery.ts:1737#` | `routes/discovery.ts:1794#` |
| 2667 | `routes/discovery.ts:2097#` | `routes/discovery.ts:2194#` |
| 2522, 2669 | `lib/discoveryCandidate.ts:225#` | `lib/discoveryCandidate.ts:270#` |
| 2669 | `lib/discoveryCandidate.ts:240#` | `lib/discoveryCandidate.ts:299#` |

**`check:doc-citations` was already red at this tree before this pass**, on 102 anchors in censuses
this lane never opened (`census-media.md`, `census-passport.md` and others), broken by sibling lanes
editing the same worktree concurrently. This pass reduced its own contribution to 29 and
cannot reduce it further without crossing a lane boundary.

### 12.8 Ceiling — what this pass could not reach

- **No migration was written and no flag was flipped.** Every gate §11.9 names is still exactly where
  it was: 2850, 2289, 2361 and 2360 all seeded FALSE.
- **`recommendation_id` still holds down five rows** (DV-06, DV-26, DV-40, DV-46, DSV2-12). Unchanged
  and still the highest-value single item in the denominator, and still a migration decision.
- **Production was not read by this pass.** Every production figure quoted above is inherited from §5
  and §11 and is dated there. Discovery's darkness (13 `surface='discovery'` rows, latest 2026-08-15)
  was not re-measured and should not be quoted as current on this date.
- **The work is uncommitted in a worktree shared with seven other lanes.** `typecheck` passes and
  `typecheck:tests` is at its 864-across-116 baseline with no file above it, measured after the last
  edit; a sibling lane's file (`services/airport/__tests__/layoverPresenceDegraded.test.ts`) went one
  diagnostic above its baseline and back inside the same ten minutes while this was being measured,
  which is what a shared tree looks like from inside.

### 12.9 Two guards this pass makes red, and neither can be fixed from inside this lane

Stated here rather than left for CI to discover, because in both cases the remedy lives in a file the
lane rules put outside this lane.

1. **`check:census-freshness` reports `census-discovery.md` STALE.** Its acknowledgement covers eight
   named files; this pass changed ten more that it does not name — the seven modified sources
   (`lib/discoveryCandidate.ts`, `lib/discoveryCacheEligibility.ts`, `lib/discoveryDivergenceReport.ts`,
   `lib/discoveryEngineMode.ts`, `lib/discoveryLocalMomentum.ts`, `lib/discoveryModifiers.ts`,
   `lib/discoveryServeLog.ts`, `lib/discoveryShadow.ts`, `routes/discovery.ts`) and the test files
   beside them — plus four NEW modules that no acknowledgement can cover because they did not exist:
   `lib/discoveryRankProvenance.ts`, `lib/discoveryReasonCodes.ts`, `lib/discoveryStopConditions.ts`
   and `lib/discoveryTrendState.ts`.
   The guard is right and the staleness is real in its terms. **The argument it wants is in this
   document**: every one of those files was changed or created BY this section, each change is the
   subject of a row move in §12.2 or a left-where-it-was in §12.5, and no change was made to any of
   them that §12 does not account for. **The remedy is one of two edits this lane may not make** —
   update §0's `head_commit` after the integration owner commits, or extend
   `src/scripts/CENSUS_STALENESS_ACKNOWLEDGED.json` naming them. Both are integration-owner files.
   Recorded rather than worked around, and **not** silenced by a scope change.
2. **`check:census-scope-coverage` passes for this census (63 cited · 61 watched · 97 %, floor 96 %)
   but names two files it cites and does not watch**:
   `artifacts/api-server/src/test/discoveryShadow.test.ts` and
   `artifacts/api-server/src/test/discoveryNegativeSignalWriter.test.ts`. Adding them to
   `CENSUS_SCOPE` would take coverage higher and would make a change to either file age this census —
   which is the right behaviour, since §12.4 and §12.6 now rest on both. `CENSUS_SCOPE` lives in
   `src/scripts/checkCensusFreshness.ts`, a `checkCensus*.ts` file this lane may not edit. Requested,
   not done.

Also unfixable from here and reported for completeness: `check:test-registration` is red on five new
test files, all of them sibling lanes' (`services/memory*`, `services/safeReturn`). This pass added no
new test file for exactly this reason — registering one requires `artifacts/api-server/package.json`.

### 12.10 Every file this pass wrote to

Four new modules, nine modified sources, eight modified test files, this census. Nothing outside
this lane's ownership was written; the two cross-lane repoint sets in §12.7 were computed and
reported, not applied.

**New:**

| file | what it is |
|---|---|
| `artifacts/api-server/src/lib/discoveryRankProvenance.ts` | `06` §5's five cache-metadata fields plus the `04` §13 raw/derived split, as one record that travels with a ranked page (DV-04, DV-48, DSV2-06) |
| `artifacts/api-server/src/lib/discoveryReasonCodes.ts` | `01` §11's nine internal reason codes, the signal→code map, the `01` §10 guardrail exclusions and the plain-language strings (DV-18) |
| `artifacts/api-server/src/lib/discoveryStopConditions.ts` | `12`'s seven stop conditions: two enforced from the serve log's own evidence, five named as unenforceable (DV-82) |
| `artifacts/api-server/src/lib/discoveryTrendState.ts` | `03` §9's six place-momentum stages and `03` §11's trend explanations, from a third window in the rows the momentum loader already pages in (DV-28, DV-33) |

**Modified:** `lib/discoveryCacheEligibility.ts` · `lib/discoveryCandidate.ts` ·
`lib/discoveryDivergenceReport.ts` · `lib/discoveryEngineMode.ts` · `lib/discoveryLocalMomentum.ts` ·
`lib/discoveryModifiers.ts` · `lib/discoveryServeLog.ts` · `lib/discoveryShadow.ts` ·
`routes/discovery.ts` (all under `artifacts/api-server/src/`).

**Tests modified:** `discoveryCacheBEligibility` · `discoveryCandidate` · `discoveryDivergenceReport` ·
`discoveryEngineMode` · `discoveryLocalMomentum` · `discoveryPde` · `discoveryServeLog` ·
`discoveryShadow` (all `artifacts/api-server/src/test/*.test.ts`, all already registered in the
api-server `test` script — no new test file was created, because registering one needs
`package.json`).

**Guard state at the end of this pass**, measured rather than assumed:

| guard | result |
|---|---|
| `typecheck` | PASS |
| `typecheck:tests` | PASS — 864 diagnostics across 116 files, exactly the baseline, no file above it |
| `check:census-integrity` | PASS — `discovery 150 · 65 · 47 · 36 · 2 → 153`, 3 rows it cannot read (§12.3) |
| `check:doc-citations` | **zero** broken anchors in `census-discovery.md`; 29 remain in two files this lane does not own (§12.7), and 100-odd more were already red from sibling lanes |
| `check:census-freshness` | RED for this census — §12.9, unfixable from this lane |
| `check:census-scope-coverage` | PASS for this census (97 %, floor 96 %) |
| `check:census-row-move-labels` · `check:flag-polarity` · `check:async-handlers` · `check:writerless-reads` · `check:unissued-supabase-writes` | PASS |
| `check:test-registration` · `check:silent-supabase-writes` | RED on sibling lanes' files only (§12.9) |
| 24 discovery/ranking test files | all green, no regression |

## 13. The proof pass, and the recommendation denominator, 2026-09-14 — re-executed evidence for §12, two rows moved

*Worktree `/home/user/wt-483`, resuming from `88b9e8e1a` after the container restart that took
§12's agent. APPEND-ONLY and LAST-STATEMENT-WINS: where this section and any section above
disagree, this one is the later statement.*

### 13.1 Why this section exists before any new work

`88b9e8e1a` secured §12's code but states in its own message that **nobody ran the failing-first
proof for any of it and no mutation was recorded** — that evidence existed only in the agent that
was killed. A verdict whose evidence nobody can re-execute is not a verdict, so §13.2 re-executes
it. Nothing in §12 was taken on trust, including §12's own account of which mutations bit.

**Result: all seven §12 row moves survive.** Every one has a test that was watched go red under a
mutation of the implementation and green again on restore, and the mutations are listed so a third
party can repeat them. **No row was moved back for want of proof.**

### 13.2 §12's rows, re-proved — the mutation, and what went red

Baseline before mutating: seven suites, **184 pass / 0 fail**. Each mutation was applied to the
implementation only, the suite re-run, then the file restored from a byte-copy (this lane runs no
git write command, so `git checkout --` was never available and was never used).

| row | mutation applied | what turned RED |
|---|---|---|
| **DV-04** | cache-B hit path re-stamps `rankedAt: Date.now()` on replay instead of replaying the stored value | `M` only — *"the ranking timestamp must be when the RANKER ran, not when the cache was read"*. 24/25 still green, so the assertion is specific rather than incidental. |
| **DV-48** | `featuresFromPipelineResult` emits `finalScore` into the RAW bag | `N2` — *"`features` holds only RAW per-signal contributions; finalScore is a derived score and belongs in `scores`"*. |
| **DSV2-06** | the `rank_version` check deleted from `cacheBEntryUsable` | `P5` (a page ranked under a different model/feature version is reused), `P6` (an entry with no recorded version is accepted by default) **and the route-level `Q2`** — so the binding is proved at the pure function AND at the caller. |
| **DV-82** | (a) the minimum-sample floor removed; (b) the mode resolver ignores a tripped condition; (c) the serve-log writer stops recording evidence | (a) `N3` — a small sample trips it; (b) `O1` and `O2` — a tripped stop no longer forces `legacy` for `pde` or for `shadow`; (c) serve-log `M` and `M2` — a rejected and a landed insert reach the window no more. Three independent legs, three independent reds. |
| **DV-28** | the no-history branch removed from `classifyTrendState` | the `03` §9 block's `2`, `3` and the three-window test — *"emerging and cooling are distinguishable"*, *"distinguishes emerging from established — `03` §14's own acceptance criterion"*. |
| **DV-33** | `unknown` given a plain-language sentence that names a neighbourhood | *"no evidence is `unknown`, and unknown is never a claim about the place"* AND *"every state that IS a claim has a plain-language explanation, and none names a person or place"* — both guardrails bit, not just one. |
| **DV-18** | (a) the guardrailed `trust` signal mapped to `creator_affinity`; (b) `history` mapped to the producerless `trail_affinity` | (a) `I5` — the `01` §10 guardrail; (b) `I4` — *"emits NO code that has no producer on this surface"*, plus `I2`. |
| **DV-79** (stayed W) | the writer stops STORING the Phase 9 dimensions | the writer test — this is the mutation §12.4 recorded as having initially left everything green, and it now bites. Re-confirmed rather than taken on trust. |
| **DV-79** reader | a missing save-mean counted as zero instead of excluded | *"a page with NO known save counts contributes no save mean, rather than a zero"* — §12.4 flagged the reader's tests as green-on-first-run and therefore weaker evidence; this re-execution is what upgrades them. |

After restore: **184 pass / 0 fail**, and `git status` showed no file of this lane modified.

### 13.3 DV-40 — the row's stated evidence was false, and the object it says does not exist is in production

This is the correction this pass considers most important, because DV-40 is named in §11 and §12 as
*"one object holding down five rows"*.

**The row reads:** *"Zero occurrences in Discovery. `grep -rIn "recommendation_id\|recommendationId"
artifacts/api-server/src` returns only Layover and Media hits — different domains, different
objects."*

**Re-executed at this tree, that grep returns 34 hits in `routes/compass.ts`, 17 in
`CompassFeedbackEngine.ts` and 14 in `CompassOutcomeEngine.ts`.** Compass — the ranker Discovery's
`for_you` path actually runs — mints an HMAC-signed `recommendation_id` per served item
(`artifacts/api-server/src/routes/compass.ts:266#export function enrichFeedWithRecommendationIds`)
and pre-registers it in a table that **exists in production**:
`artifacts/api-server/migrations/0055_compass_admin.sql:22#CREATE TABLE IF NOT EXISTS compass_served_recommendations`,
whose ten columns are in the 2026-09-08 production schema snapshot. The clause about
`recommendations` / `recommendation_items` being absent is still true; the clause about zero
occurrences was wrong when written.

**Why the existing object could not simply be adopted, stated rather than assumed.** The Compass
token is deterministic over (userId, itemId, itemType, sectionName, explanationKey) — deliberately,
because Compass dedupes on it (`artifacts/api-server/src/routes/compass.ts:295#dedupeByRecommendationId`)
and hands it to the client as the `/api/compass/why/:recommendationId` lookup handle, with a
`UNIQUE` constraint that depends on that collapsing. `04` §5's purpose is explicit —
`docs/specs/discovery-v1/04_Behavior_Engine.md:110#Without exposure denominators, engagement rates`
— and a denominator has the opposite requirement: the same item served to the same viewer twice is
TWO exposures. Adopting the Compass id verbatim would have silently under-counted the exact quantity
the requirement exists to measure. So the *mechanism* was studied and the *shape* was not copied.

**What was built, and why it needed no migration.** Discovery's serve-log row already carried six of
the nine fields as real columns — `user_id`, `session_id`, `item_id` + `item_kind`, `surface`,
`position`, `served_at`. Only `recommendation_id`, `model_version` and the reason codes were
missing, and all three fit in the `features` jsonb every row already writes:

| `04` §5 field | where it lives on a Discovery `rank_events` row |
|---|---|
| recommendation_id | `features.recommendationId` — **new** |
| user_id · session_id · surface · served_at | existing columns |
| candidate_type/id | existing `item_kind` + `item_id` |
| rank_position | existing `position` |
| model_version | `features.modelVersion` — **new** |
| reason codes | `features.reasonCodes` — **new** |

The split is recorded as data rather than prose, so the claim is checkable:
`artifacts/api-server/src/lib/discoveryRecommendationId.ts:104#export const RECOMMENDATION_RECORD_LOCATION`,
against the nine names in the specification's own order at
`artifacts/api-server/src/lib/discoveryRecommendationId.ts:83#export const RECOMMENDATION_RECORD_FIELDS = [`.
The id itself is derived from the exposure's own coordinates
(`artifacts/api-server/src/lib/discoveryRecommendationId.ts:149#export function recommendationIdFor(`),
stamped by the writer at
`artifacts/api-server/src/lib/discoveryServeLog.ts:421#recommendationId: recommendationIdFor({`,
and the reason codes are mapped from the ranker's own signals through DV-18's vocabulary
(`artifacts/api-server/src/lib/discoveryReasonCodes.ts:299#export function reasonCodesByIdFromProvenance(`)
at both Compass serve points
(`artifacts/api-server/src/routes/discovery.ts:2246#reasonCodesById: reasonCodesByIdFromProvenance(cProvenanceById),`
and, replaying the stored provenance, `artifacts/api-server/src/routes/discovery.ts:2158#reasonCodesById: reasonCodesByIdFromProvenance(cCacheHit.provenanceById),`).

**Two design points are deliberate and each is pinned by a test.** The id is DETERMINISTIC, not a
UUID: the writer is fire-and-forget, and random ids would mint a second set of exposures for one
retried serve — inflating the denominator through the very fix meant to establish it. And the three
fields are written AFTER the caller's free-form `context` spread
(`artifacts/api-server/src/lib/discoveryServeLog.ts:426#reasonCodes: reasonCodesById?.[item.id] ?? [],`),
so a caller cannot overwrite the record with its own values.

**DV-40: `N` → `W`.** Built, wired to reachable callers, tested failing-first. **Not `C`, on two
clauses that are unsatisfied and cannot be satisfied from this lane:** `rank_events` still has no
`recommendation_id` COLUMN, so nothing in the database enforces uniqueness, nothing can index or
join on it, and "the exposures for recommendation X" is a jsonb scan; and `10` §3's `recommendations`
/ `recommendation_items` remain absent from repository and production. Both are migrations.

**DV-46: `N` → `W`.** The row read *"Nothing to propagate (DV-40)"*; that premise is now false.
`docs/specs/discovery-v1/04_Behavior_Engine.md:175#6. test recommendation_id propagation,` is met for
the SERVE half — `S2` reproduces the id on the row from the row's own columns, and `S3` proves the
ranker's codes reach the written row, both watched red first. **Not `C`:** propagation in the full
sense is exposure → outcome → attribution, and the second half does not exist. The id is server-side
only, no client receives one, and `routes/rankEvents.ts`'s outcome upgrades carry no
`recommendation_id`, so an engagement still cannot be attributed to the exposure that caused it.

**DV-06 does not move, and its stated blocker has changed.** The row's reason is *"The spec's unit is
the recommendation, and none exists (DV-40 **N**)"*. One exists now. It stays `W` because the
denominator `recordImpressionDistributionStats` maintains is still per ITEM, and re-executing that
claim is a separate measurement this pass did not make.

### 13.3a Row moves

| id | was | now | why |
|---|---|---|---|
| **DV-40** | **N** | **W** | **The stated evidence was false, and the missing object now exists on Discovery's own serves.** The row read *"Zero occurrences in Discovery … only Layover and Media hits"*; re-executed, that grep returns 34 hits in `artifacts/api-server/src/routes/compass.ts:266#export function enrichFeedWithRecommendationIds` alone, and `compass_served_recommendations` is a production table (`artifacts/api-server/migrations/0055_compass_admin.sql:22#CREATE TABLE IF NOT EXISTS compass_served_recommendations`). Discovery's serve-log row already carried six of `04` §5's nine fields as columns; the other three are now written into the `features` jsonb it already emits — id at `artifacts/api-server/src/lib/discoveryServeLog.ts:421#recommendationId: recommendationIdFor({`, derived from the exposure's own coordinates (`artifacts/api-server/src/lib/discoveryRecommendationId.ts:149#export function recommendationIdFor(`), with the nine names in the specification's order at `artifacts/api-server/src/lib/discoveryRecommendationId.ts:83#export const RECOMMENDATION_RECORD_FIELDS = [` and the field→location split recorded as data at `artifacts/api-server/src/lib/discoveryRecommendationId.ts:104#export const RECOMMENDATION_RECORD_LOCATION`. §13.4 tests R1–R8 and S1–S3; S3 was watched RED before the route wiring existed, and seven further mutations each turned a named assertion red. **NO MIGRATION AND NO NEW TABLE**, which is the point: the Compass id was studied and deliberately not copied, because it is deterministic per ITEM and a denominator must count per EXPOSURE. **W, not C**: `rank_events` still has no `recommendation_id` column, so nothing enforces uniqueness or offers a join key, and `10` §3's `recommendations` / `recommendation_items` remain absent from repository and production. Both are migrations this lane may not write. |
| **DV-46** | **N** | **W** | **Its only stated blocker is gone.** The row read *"Nothing to propagate (DV-40)"*. `docs/specs/discovery-v1/04_Behavior_Engine.md:175#6. test recommendation_id propagation,` is now met for the serve half: `S2` reproduces the written id from the row's own columns, and `S3` proves the ranker's `01` §11 codes reach the row — both watched fail first, and three separate route- and writer-level mutations turn them red. **W, not C**: propagation in full is exposure → outcome → attribution. The id is server-side only, no client receives one, and `routes/rankEvents.ts`'s outcome upgrades carry none, so an engagement still cannot be attributed to the exposure that produced it. |

**Net: C 66 · W 47 → 49 · N 38 → 36 · X 2.** Neither row moved on re-reading alone; each moved
because code was written and tested failing-first. **DV-06 was examined and deliberately NOT moved**
— see §13.3.

### 13.4 The tests, and the mutation that turned each one red

All in files already registered in the api-server `test` script; registering a new file needs
`package.json`, which this lane does not own.

| test | file | what it pins | mutation watched RED |
|---|---|---|---|
| R1–R8 | `artifacts/api-server/src/test/discoveryServeLog.test.ts` | every served item has a non-blank id; all nine fields recoverable from the row; the id binds the SERVE (session, position and viewer each change it); it is deterministic; it is opaque and transport-safe; reason codes are the grounded ones and an unranked serve claims none; a caller's `context` cannot overwrite the record | pin `position` to 0 in the derivation → R1; drop `position` / `sessionId` / `userId` from the canonical tuple → R1, R3; prefix the digest with the user id → R5; make the id a UUID → R4; invent `["nearby_now"]` when the ranker gave none → R6, R7; move the three fields before the `context` spread → R8 |
| I9–I12 | `artifacts/api-server/src/test/discoveryCandidate.test.ts` | provenance → codes, keyed by item; a moderation signal produces NO code; an item grounding nothing gets `[]` not a missing key; a null map is `{}` and never throws | the module did not exist (a blunt first red); then the three route-level mutations below |
| S1–S3 | `artifacts/api-server/src/test/discoveryCacheBEligibility.test.ts` | the REAL route, serve-log flag on, `rank_events` captured: a served request writes a row with all nine fields; the id on the row is reproducible from the row itself; a ranked serve carries `01` §11 codes | route stops passing `reasonCodesById` → S3; route passes RAW ranker signal names instead of codes → S3; writer stamps `"rec-" + idx` instead of deriving → S2 |

**S1–S3 exist because of §12.4's own lesson** — that deleting the call which STORED a computed block
left every pure-function test green. So this pass did not rely on unit tests for the wiring: it
stands the route up, turns the serve-log flag on in the fake, captures what actually reaches
`rank_events`, and asserts on that. **S3 was RED before the route wiring was written**, for exactly
the message it carries: *"a serve point that ran a ranker wrote no reason code on any row — the
provenance never reached the writer."*

### 13.5 A test of this pass's own that could not fail, found by mutation and replaced

Reported because LANE-RULES §4 asks for it and because it is the second time in this programme the
check has earned its keep.

R1 originally asserted *"none repeats within a page"* over a fixture of three DISTINCT items.
Pinning `position` to 0 inside the id derivation — a mutation that destroys the property R1 names —
left it **green**, because three different `itemId`s produce three different ids whether or not
position is part of the tuple. The assertion was true of the fixture and said nothing about the
implementation.

It was replaced with a fixture that serves the SAME item at two rank positions, which is the one
arrangement that separates "the id binds the exposure" from "the id binds the item". The same
mutation then turned it red. The comment in the test records why the fixture looks redundant, so
nobody simplifies it back.

A second defect of this pass's own is recorded in the same spirit: four R-series tests were written
against `DiscoveryServePoint.COLD_RANK`, which is not a member of that object — the member is
`COLD_FETCH_LEGACY_RANK`. They passed, because `undefined` flowed through as the serve point. The
runtime suite could not see it; the test typecheck could, and did. Fixed, and it is the reason
§13.7 treats an unmeasurable ratchet as a blocker rather than an inconvenience.

### 13.6 Restated headline

> **Discovery, at worktree `/home/user/wt-483` (`88b9e8e1a` + this pass): 153 requirements ·
> 66 BUILT-AND-CORRECT · 49 BUILT-BUT-WRONG · 36 NOT-BUILT · 2 CANNOT-VERIFY →
> CONSTRUCTED 115 / 153 = 75.2 % · CORRECT 66 / 153 = 43.1 %.**
> Previous statement (§12.3, 153 rows): 66 / 47 / 38 / 2 → 73.9 % · 43.1 %.

**No row moved to `C` this pass.** The two that moved went `N` → `W`, which raises CONSTRUCTED and
leaves CORRECT exactly where §12 left it. That is the honest shape of the result: something real was
built and it does not finish either requirement.

Measured against what the repository can verify about this document, as §12.3 established:
`check:census-integrity` PASSES and reports `discovery 150 65 49 34 2 → 153, 3 counted where this
tool cannot read`. The three it still cannot read are unchanged — **DSV2-04 `N` · DSV2-05 `C` ·
DSV2-12 `N`** — and 150 + 3 = 153. The difference between what this document says and what the
repository can check about it is those three rows and nothing else.

**BUILT ON A BRANCH IS NOT MERGED. MERGED IS NOT DEPLOYED. DEPLOYED IS NOT FLAG ENABLED.** No flag
was flipped, no migration written, and no production statement in §5, §11 or §12 was re-measured
here. The serve-log writer this pass extends is recorded by §5 as flag-ENABLED in production, which
means the new fields would begin appearing on real rows once this is merged and deployed — and the
reason codes on those rows will be `[]` wherever the Compass path is not reached, which per DV-47 is
everywhere today.

### 13.7 Two cross-lane blockers this lane may not fix, and one it declined to make

1. **`artifacts/api-server/src/lib/inputAssistance/queryNormalizer.ts` does not parse.** 27 syntax
   errors (`TS1136`, `TS1005`, `TS1127`) from unquoted Thai codepoints used as object-literal keys
   in a romanization map — several Thai combining marks are not valid identifier starts. It is not
   this lane's file (no `discovery` in the path) and was not touched here. **It breaks two gates at
   once:** `pnpm run typecheck` fails, and `typecheck:tests` collapses to *"27 diagnostics across
   1 files"* and then reports all 116 baselined files as improved — because a syntactic error makes
   TypeScript skip semantic checking program-wide. That second failure mode is worth naming: the
   ratchet does not merely go red, it reports a **false improvement** across the whole suite, and an
   operator who ran the suggested `--update` would erase 864 real baselines. Owner: whichever lane
   owns `lib/inputAssistance/`.
2. **`artifacts/api-server/src/test/mediaIndependentSources.test.ts` is 1 diagnostic above its
   baseline of 0.** Measured, not inferred — see §13.8. Owner: the Media lane.
3. **Declined:** the HMAC signing and secret resolution at
   `artifacts/api-server/src/compass/CompassExplanationEngine.ts:283#export function encodeRecommendationToken`
   should be lifted into a shared module so there is one implementation of it in the tree. This pass
   did NOT do that — it is another lane's file — and it deliberately did not copy the secret chain
   either. Discovery's id is a plain digest because it is never accepted from a client and so has
   nothing to forge; the module says so, and says what must change first if a Discovery `/why` is
   ever exposed. Filed as a request, not a change.

### 13.8 What was verified, stated narrowly

- **Suites**: `discoveryCacheBEligibility` 28 · `discoveryCandidate` 45 · `discoveryDivergenceReport`
  13 · `discoveryEngineMode` 30 · `discoveryLocalMomentum` 32 · `discoveryServeLog` 29 ·
  `discoveryShadow` 22 · `discoveryPde` 32 · `discoveryNegativeSignalWriter` 17 — **248 pass, 0 fail.**
- **`check:citation-symbols` PASSED** — 0 citations name a symbol their file does not contain
  (ceiling 0).
- **`check:doc-citations`: zero broken anchors in `census-discovery.md`.** 56 anchors in this census
  moved when this pass inserted lines into `routes/discovery.ts`, `lib/discoveryServeLog.ts` and
  `lib/discoveryReasonCodes.ts`; all 56 were repointed here by matching each anchor's unchanged
  needle text in the current file, which is the whole reason the anchor form exists. No verdict,
  evidence sentence or prose was altered by a repoint. Two anchors were additionally repaired whose
  NEEDLE had gone stale from an earlier reformat rather than from a line move
  (`_compassCandidateCache.set(cCacheKey, {` and `whyForUserFromFeatures(`); in both the citation's
  target is unchanged and only the quoted fragment was shortened to what the line now says. Two
  citations introduced by §13 itself were also off by a few lines on first write and were corrected
  the same way; they are counted here rather than quietly fixed.
- **Typecheck**: `tsc -p tsconfig.json --noEmit` reports **27 errors, all 27 in the single
  sibling-lane file named in §13.7**, and **zero in any file this lane touched or created**.
- **Test ratchet**: not measurable through `typecheck:tests` while §13.7's file does not parse. It
  was measured instead over a program identical to `tsconfig.test.json` with that one file excluded:
  **865 diagnostics, against a baseline of 864**, and the single difference is
  `src/test/mediaIndependentSources.test.ts: 0 → 1`. **Every file this lane touched or created is at
  0 and at its baseline.** Stated this way rather than as "the ratchet passes", because it does not
  pass and will not until §13.7.1 is fixed.
- **Not verified**: production was not read; no live-DB suite was run (`discoveryPlaceWriteBoundary`
  is a live suite whose in-process guard refuses a target it cannot verify, which is the guard
  working, not a red test — confirmed by running it with the guard's environment satisfied and no
  credentials, where it SKIPs cleanly).

---

## 14. The compliance re-derivation, 2026-09-14 — the 67 audited for provenance, and 34 obligations nothing was counting

*Worktree `/home/user/wt-483` (detached at `7d1f2d498`), 2026-09-14, DISCOVERY COMPLIANCE lane, with
sibling lanes editing the same tree. APPEND-ONLY and LAST-STATEMENT-WINS, as §11 established. This
pass wrote **no source file, no test, no migration and no flag**; every verdict below is a
measurement. The full audit — the enumeration rule, the exclusion accounting, the clause-by-clause
mapping, the per-row re-derivation and attribution — is `docs/discovery/compliance-v1.md`; this
section carries only what the repository must be able to count.*

### 14.1 The question, answered mechanically before it was answered by argument

The owner asked for a recheck of rows *"previously graded against repository-derived descriptions
rather than against the spec"*. Measured over this document:

- **Zero of the 67** cite a `docs/architecture/0N_*.md` / `1N_*.md` current-state file as a
  requirement. A grep for those paths across the whole document returns **six lines, all inside
  §11.1's evidence table**, where they are cited as evidence *about* the collision — quoting their
  own headers admitting they are derived. Restricted to the 67 rows themselves (§2, lines 55–133),
  the same grep returns nothing.
- **A01–A25 (25)** come from other surfaces' owner-supplied specs. Every quoted sentence was re-read
  at its cited line this pass. 23 of 25 pointers resolve exactly; **2 do not** and are repaired in
  §14.3.
- **B01–B09 (9)** come from `census-input-intelligence.md`'s G-rows, which derive from the Global
  Input Intelligence spec. Not a derived Discovery document.
- **C01–C33 (33)** come from **Discovery's own module headers, guards and named tests** — which is
  not a `docs/architecture/` file but is the same failure class, as §1 of this census says in its own
  words. **All 33 were re-derived against the owner's spec text**, one at a time
  (`docs/discovery/compliance-v1.md` §2.3).

**Result of the re-derivation: 31 unchanged · 1 confirmed already-moved (C14) · 1 mis-stated reason
with a surviving verdict (C32) · 0 new verdict moves.**

### 14.2 Two findings that are not verdict moves

**C14 — re-executed, and §11.6's move is confirmed rather than inherited.** The row's contract came
from the module's own header; `docs/specs/discovery-v1/11_API_Specification.md:103#A failure must not masquerade as success.`
says the opposite and names six failure classes to distinguish. All three exits of
`GET /discovery/suggest` still collapse to one empty success at
`artifacts/api-server/src/routes/discoverySearch.ts:2654#discoveryRefusal("validation", "query_too_short", "GET /discovery/suggest")`,
`artifacts/api-server/src/routes/discoverySearch.ts:2700#discoveryRefusal("transient_db", "visibility_state_unreadable", "GET /discovery/suggest")` and
`artifacts/api-server/src/routes/discoverySearch.ts:2784#discoveryRefusal("transient_db", "suggest_failed", "GET /discovery/suggest")`.
The failure is observable in the server log and not to the caller, which is what §9 asks for.
**W stands. D11 stands.**

**C32's verdict survives and its contract SENTENCE does not.** The row is titled *"One ranking
pipeline in the tree — the route no longer imports the ranker directly"*. The second clause is what
its evidence proves and it still holds: `routes/discovery.ts` imports `portavaRank` type-only. The
first clause is false at this tree — `artifacts/api-server/src/routes/discovery.ts:36#import { rankItemsForDiscovery } from "../`
is a **value** import of Compass's ranker, called on the same route, and a Discovery page is ordered
by one ranker or the other depending on `category`. **No verdict move**: a row is graded on its
evidence, and its evidence is true. The obligation the sentence claims —
`docs/specs/discovery-v1/12_Claude_Code_Implementation.md:5#Do not implement PDE as a greenfield subsy`
and `10` §1's *"Avoid parallel systems"* — was graded by no row and is now **DC-24**, `W`.

### 14.3 Pointer repairs — two A-row citations land on another surface's row

Both quote the right sentence and name the wrong line, and both land inside the same table as the
Discovery row they mean. The class is the in-range-but-wrong one §8, §9.8 and §10.4 each recorded.
**No verdict moves; the repaired pointers are recorded here rather than edited into §2a, because a
row's evidence sentence is not a thing a later section should silently rewrite.**

| Row | Cited | Actually at that line | Correct pointer |
|---|---|---|---|
| A14 | Layover §25 `docs/specs/Portava_Layover_Development_Architecture_Spec_v3.txt:754#Map` | the `Map` row | `docs/specs/Portava_Layover_Development_Architecture_Spec_v3.txt:753#Only show experiences from certified actio`, under `:752#Discovery` |
| A16 | Passport §21 `docs/specs/Portava_Passport_Engineering_Architecture_and_Design_Spec.txt:213#Identity, relevant trust eligibility, lang` | the **Trips** projection | `docs/specs/Portava_Passport_Engineering_Architecture_and_Design_Spec.txt:211#Identity, verification, availability, Open`, under `:210#Discovery` |

### 14.4 The DSV2 disposition at §11.4, verified against the specification

*"Eight DUPLICATE, four SPLIT, none a pure ADDITION"* — **the count is correct**, re-derived from
`docs/specs/upgrades-v2/02-DISCOVERY-v2.md` rather than trusted. DUPLICATE = DSV2-01, -02, -03, -07,
-08, -09, -10, -11. SPLIT = DSV2-04, -05, -06, -12. Three sub-clauses were unaccounted when it was
written: DSV2-07's *"actual outcomes stay distinct from predictions"* (DUPLICATE of **A03**),
DSV2-01's *"real search and recommendation routes are both exercised"* (DUPLICATE of **DC-33**), and
DSV2-12's *"no synthetic production visits, conversions or Trust awards"* — the one genuine
addition, **DC-34**.

### 14.5 The 34 coverage-gap rows

Enumerated by the rule in `docs/discovery/compliance-v1.md` §1, which also reports the **32 prose
passages excluded as stating no testable obligation** and why. Each row was checked against all 153
existing rows for overlap of **subject** before being added; the 17 obligations that overlapped are
folded and named there, not added here. Every `C` and `W` below cites a line opened at this tree —
where the file is outside this census's `CENSUS_SCOPE` the anchored citation lives in
`docs/discovery/compliance-v1.md` §4 and the file is named in prose here, so
`check:census-scope-coverage` is not driven below its floor by a documentation pass
(cross-lane request X2).

| id | Obligation | Verdict | Evidence |
|---|---|---|---|
| DC-01 | `docs/specs/discovery-v1/01_Portava_Discovery_Engine.md:96#PDE should rank or recommend:` — ten output kinds | **W** | 7 of 10. Present: posts, places, events, trips, travelers, circles, itineraries-as-plans — eighteen types at `artifacts/api-server/src/routes/discoverySearch.ts:126#const SEARCH_TYPES = [`, nine ranked kinds at `artifacts/api-server/src/lib/portavaRank.ts:41#export type CandidateKind =`. **Trails FAIL** (DV-20). **Shared Moments FAIL** — absent from both lists and from every Discovery file. **Emerging discoveries FAIL** — trend states exist (DV-28) and are not an output kind. |
| DC-02 | `docs/specs/discovery-v1/02_Trails.md:58#Do not let creators attach unlimited disco` | **N** | No Trail or Signal label exists to attach. The analogue on the label system that does exist — a 20-tag cap in the tagging policy module — is named in `docs/discovery/compliance-v1.md` §4.2 and **not** counted as satisfying a Trail-scoped clause, on DV-13's precedent. |
| DC-03 | `docs/specs/discovery-v1/02_Trails.md:68#Creation should require canonicalization c` — four checks | **N** | No Trail creation path. |
| DC-04 | `02` §7 — Trail lifecycle (5 states) and in-Trail content lifecycle (6 states) | **N** | Neither exists. Distinct from DV-28, which is `03` §9's **place** momentum; `03` §4's **content** lifecycle is separately recorded absent inside DV-28's `W`. |
| DC-05 | `docs/specs/discovery-v1/02_Trails.md:163#Trail health should influence ranking but ` — nine metrics | **N** | No Trail, no health snapshot, no ranking input. |
| DC-06 | `docs/specs/discovery-v1/03_Trending.md:106#Trend velocity must be normalized by:` — exposure · creator baseline · Trail baseline · location baseline · time-of-day · content age | **W** | 2 of 6. **exposure PASS** (DV-30's denominator). **content age PASS** — recency weighting against the place's own 30-day baseline, `artifacts/api-server/src/lib/discoveryLocalMomentum.ts:66#export const MOMENTUM_RECENT_WINDOW_MS   =`. **creator · Trail · location · time-of-day FAIL** — momentum divides a place by itself and by nothing else. DV-30's `C` is against `03` §14's one-word criterion and stands; §7's six-way requirement had no row. |
| DC-07 | `docs/specs/discovery-v1/03_Trending.md:182#Do not store one opaque “trend score” ` + §13's five preferred stores | **W** | 1 of 5 durable. **raw events PASS** (`rank_events`). **aggregated windows · state snapshots · explanation features · model/version FAIL** — the three windows at `artifacts/api-server/src/lib/discoveryTrendState.ts:88#export const TREND_RECENT_MS = 48 * HOUR;` are recomputed per request into a ten-minute process cache and never persisted; no `place_momentum` table exists (§11.3a). The prohibition is satisfied **vacuously** — nothing durable is stored at all — and that is said rather than scored. |
| DC-08 | `04` §2 *"Do not create a new parallel behavior store"* + `docs/specs/discovery-v1/04_Behavior_Engine.md:134#If the current table cannot represent this` + `10` §1 | **C** | One behaviour store: `artifacts/api-server/src/lib/discoveryServeLog.ts:444#const { error } = await sc.from("rank_even`. §13.3's three missing `04` §5 fields went into the `features` jsonb that row already writes rather than into a new table, and the vocabulary was extended by migration (0197/0199/0202/2297/2298). `artifacts/api-server/src/lib/discoveryShadow.ts:371#const { error } = await sc.from("discovery` is `12` Phase 9's comparison record, which the spec asks for, and C22 pins that it never changes what was served. **Red if:** any Discovery impression or outcome row is inserted into a table other than `rank_events`. |
| DC-09 | `docs/specs/discovery-v1/04_Behavior_Engine.md:153#Sequence features should be derived downst` | **W** | 1 of 2. **The prohibition PASSES** — no client computes a chain; the funnel logic is server-side at `artifacts/api-server/src/routes/rankEvents.ts:139#export function upgradableOutcomesFor(outc`, applied at `artifacts/api-server/src/routes/rankEvents.ts:208#.in("outcome", upgradableOutcomesFor(outco`. **The obligation FAILS** — none of §8's four named chains exists as a derived feature anywhere. Nothing is hard-coded in the client because nothing is computed at all. |
| DC-10 | `docs/specs/discovery-v1/05_Graph_Engine.md:110#Do not introduce a graph database until qu` | **C** | No graph-database dependency in the api-server manifest (`neo4j`, `gremlin`, `neptune`, `arango`, `janus`, `dgraph`, `tigergraph` — none present). The graph that ships is two Postgres tables (`artifacts/api-server/src/migrations/20260730_compass_intelligence_graph.sql`). §8's materialized-projection half is DV-72's `W` and is not re-counted. |
| DC-11 | `06` §1 — the ten-stage pipeline | **W** | 7 of 10 reachable. PASS: context assembly, candidate generation, eligibility (on the Cache-B hit path too since §11.8), feature computation and scoring (`artifacts/api-server/src/lib/discoveryRankProvenance.ts:73#export const DISCOVERY_MODEL_VERSION = "co`), diversity (`artifacts/api-server/src/lib/portavaRank.ts:420#// ── Diversity (greedy MMR-style re-r`, ungated), serve, log recommendation (`artifacts/api-server/src/lib/discoveryServeLog.ts:444#const { error } = await sc.from("rank_even`). **exploration FAIL** — `artifacts/api-server/src/lib/discoveryPde.ts:764#governor = allocateExplorationBudget(gc, {` sits inside the modifiers flag (DV-53). **integrity checks FAIL** — one author-trust down-weight (DV-12). **learn from outcomes FAIL** — outcomes are ingested and nothing learns. |
| DC-12 | `06` §2 — eleven candidate sources | **W** | 2 of 11, and the tree says so about itself: `artifacts/api-server/src/lib/discoveryRankProvenance.ts:84#* Discovery's serve path today has exactly` — *"exactly two retrievals plus the case where neither claimed the row, and inventing the other nine would be describing a pipeline that does not run."* |
| DC-13 | `docs/specs/discovery-v1/06_Recommendation_Engine.md:45#Do not collapse everything into one perman` + §3's eleven feature families | **W** | **The prohibition PASSES** — per-request scoring, raw and derived split into two fields (DV-48). **The families FAIL as families** — the ranker Discovery runs is a flat seventeen-weight bag; `trail_relevance` has no term and `negative_feedback` has none. A named-family configuration with a `negativeFeedback` penalty and a declared `discovery` surface **does** exist in the shared ranking-services module, and **no Discovery route imports it** — anchored citations in `docs/discovery/compliance-v1.md` §4.6, cross-lane request X3. |
| DC-14 | `06` §10 — compute old · compute PDE · compare overlap · compare offline utility · `docs/specs/discovery-v1/06_Recommendation_Engine.md:119#- store counterfactual recommendation sets` | **W** | All six mechanisms are in code and **none has run**. Both orders and the counterfactual set land on one row (`artifacts/api-server/src/lib/discoveryShadow.ts:371#const { error } = await sc.from("discovery`); overlap plus three further dimensions are computed (DV-79). `W` because `discovery_shadow_serves` holds **0 rows in production** (§5) and the mode is `legacy`. |
| DC-15 | `docs/specs/discovery-v1/10_Database_Architecture.md:70#- EXPLAIN verification where meaningful.` + expected cardinality + index rationale | **W** | 1 of 3. **rationale PARTIAL** — present on some Discovery indexes, absent on others. **expected cardinality FAIL** — stated in no Discovery migration. **EXPLAIN FAIL** — `grep -l EXPLAIN src/migrations/*discovery*` returns nothing. Per-migration anchors in `docs/discovery/compliance-v1.md` §4.7. |
| DC-16 | `docs/specs/discovery-v1/10_Database_Architecture.md:89#Pin `search_path`.` + SECURITY DEFINER only when necessary + explicit schema qualification | **C** | Discovery owns exactly one SECURITY DEFINER function; it argues its necessity in-file, pins `SET search_path = public`, revokes PUBLIC's implicit grant and restores EXECUTE only to `service_role`, and it is referenced by a live route rather than being an unreferenced oracle. Anchors in `docs/discovery/compliance-v1.md` §4.7; the class is guarded by `src/scripts/checkSecurityDefinerOracles.ts`. **Red if:** a Discovery migration adds a SECURITY DEFINER function without `SET search_path`, or one with no reference. |
| DC-17 | `docs/specs/discovery-v1/10_Database_Architecture.md:115#Derived features must retain:` — source event window · feature version · model version · computation time | **W** | Split, and the split is the finding. **Rank provenance: 3 of 4** — `artifacts/api-server/src/lib/discoveryRankProvenance.ts:73#export const DISCOVERY_MODEL_VERSION = "co`, `artifacts/api-server/src/lib/discoveryRankProvenance.ts:80#export const DISCOVERY_FEATURE_VERSION = "`, and a timestamp read when the ranker returned; **source event window FAIL**. **The two stores that actually compute over an event window: 0 of 4** — the momentum map is `place id → number` and the trend reading is a state plus three rates; neither carries its window, a version, or a computation time on the output. |
| DC-18 | `docs/specs/discovery-v1/10_Database_Architecture.md:94#- never edit an applied migration unless r` + new migration per behaviour + CI rehearsal + rollout order (§7's fifth rule is DV-70's) | **W** | **new-migration-per-behaviour PASSES** and is checkable from the repository alone — 2289, 2360, 2361, 2550, 2850. **never-edit-an-applied-migration:** the machinery reports exactly this as its own finding, and it compares against a live database; **this pass made no database connection**, so its current state is not certified here. **CI rehearsal / rollout order:** runbooks exist, terminal state does not — §5 records 2420, 2220 and 2760–2785 unapplied to production. |
| DC-19 | `docs/specs/discovery-v1/11_API_Specification.md:14#Prefer server-generated recommendation/exp` + four conceptual actions | **W** | 3 of 4. **server-generated PASS** — the exposure record and its id are minted server-side after the response (`artifacts/api-server/src/lib/discoveryServeLog.ts:444#const { error } = await sc.from("rank_even`) and never accepted from a client. **validate schema PASS** (DV-35). **diagnostics PASS** (`artifacts/api-server/src/lib/discoveryServePointReport.ts`). **batch FAIL** — `artifacts/api-server/src/routes/rankEvents.ts:44#router.post("/rank-events", asyncHandler(a` takes one event; there is no array form and no batch endpoint. |
| DC-20 | `11` §3 — Trails API, nine actions | **N** | 0 of 9. No Trail route exists. |
| DC-21 | `11` §4 — Trending API, five actions | **N** | 0 of 5. Trend states and explanations are computed (DV-28, DV-33) and reach no route. §4's *"Never return internal raw scores"* is DV-27's `C` and is not re-counted. |
| DC-22 | `11` §5 — Recommendation API outputs: recommendation_id · items · reason labels · cursor · model/version internally | **W** | 2 of 5 delivered. **items PASS. model/version internally PASS** (DV-04, flag-independent). **recommendation_id FAIL** — §13.3 states it: server-side only, no client receives one. **reason labels FAIL** — produced (DV-18) and gated by 2361, seeded FALSE. **cursor FAIL for this surface** — `GET /discovery` paginates by `page`. |
| DC-23 | `11` §6 — creator-economy API reads, and *"No client-side earning calculation"* | **N** | 0 of 4 reads. The prohibition is satisfied by absence and is **not** scored as a pass, on DV-62's reasoning. |
| DC-24 | `docs/specs/discovery-v1/12_Claude_Code_Implementation.md:5#Do not implement PDE as a greenfield subsy` + `10` §1 *"Avoid parallel systems"* | **W** | **The positive half PASSES:** the ranker was MOVED not copied, the serve log extends `rank_events`, the recommendation id went into an existing jsonb, Phase 2's work edits the existing caches. **The parallel half FAILS:** three ranking implementations can order a Discovery item — `artifacts/api-server/src/lib/portavaRank.ts:41#export type CandidateKind =` via `rankForViewer`; Compass's, value-imported into the same route at `artifacts/api-server/src/routes/discovery.ts:36#import { rankItemsForDiscovery } from "../` and selected by `category`; and the shared ranking service that declares a `discovery` surface and has no Discovery caller (X3). This is the obligation C32's contract sentence claims and its evidence does not prove — §14.2. |
| DC-25 | `12` Phase 2 — a design note documenting candidate cache key · ranking cache key · invalidation · model/version handling · personalization boundary | **W** | All five are documented in code rather than in a note, and one is documented **and violated**: `artifacts/api-server/src/lib/discoveryCacheEligibility.ts:2#* discoveryCacheEligibility — the authoriz` carries both cache keys and the asymmetry between them; invalidation is DSV2-06's four-reason rule; model/version is `artifacts/api-server/src/lib/discoveryRankProvenance.ts:80#export const DISCOVERY_FEATURE_VERSION = "`. **Personalization boundary: documented and crossed** — DV-03 `W`, serve points 1/2/3 hand the cached order to the user unranked on every deployment. The deliverable §2 names — one design note — does not exist. |
| DC-26 | `12` Required test classes — 5 unit · 5 integration · 3 database · 3 shadow diagnostics | **W** | ~9 of 16. PASS: scoring transforms, trend lifecycle, event write path, flag-OFF inertness, schema drift, CI rehearsal, old-vs-new comparison, cache-path correctness, recommendation coverage. FAIL: Trail lifecycle, Trail visibility, ledger math, attribution rule versioning, recommendation→behavior→attribution. **RLS is named separately** because `12` asks for it by name: `artifacts/api-server/src/test/discoveryPlaceWriteBoundary.test.ts` skips without live credentials and the `test` script pins an unreachable `SUPABASE_URL`, so a green run proves nothing — C28's recorded limitation. |
| DC-27 | `12` Deployment rules — rehearse → verdict checks → shadow → cohort → observe → expand | **?** | **CANNOT-VERIFY, recorded rather than guessed.** Discovery has never been rolled out: `DISCOVERY_ENGINE_MODE` is `legacy` (§5), shadow has written 0 rows in production, no cohort was activated. Nothing in the repository can say whether a sequence that has not begun is followed. **Evidence that would settle it:** a rollout record showing rehearsal, verdict-check results, a shadow window and a cohort activation in that order. **Who supplies it:** the integration owner and the operator. |
| DC-28 | `docs/specs/upgrades-v2/02-DISCOVERY-v2.md:13#DiscoveryCandidate is a logical extension ` — *"Do not persist transient crowd or vibe as durable place identity attributes"* | **C** | No Discovery migration adds a crowd or vibe column to any place table, and the live layer states the rule about itself and is read-only: `artifacts/api-server/src/lib/discoveryLiveRankRead.ts:28#* NEVER PERSISTED. The grades are properti`. **Red if:** any crowd or vibe value is written onto `discovery_places` / `places`, or into the user-independent L2 cache. |
| DC-29 | `docs/specs/upgrades-v2/02-DISCOVERY-v2.md:11#Search answers which entities match. Recom` — *"Chronological Wall stays chronological; Discovery does not take ownership of it"* | **C** | No Discovery route or lib writes to or orders the Wall; `grep -nE "\bWall\b|wall_|\"wall\"" routes/discovery.ts routes/discoverySearch.ts lib/discovery*.ts` returns **one** line in the whole surface — a prose comment at `artifacts/api-server/src/lib/discoveryCandidate.ts:9#* state consumed by Map / Discovery / Wall /` naming Wall as a fellow consumer of truth-class state. No table read, no write, no ordering. The Wall's Discovery **insertion** is `services/wall/`, excluded by §1 and owned by census-wall — named so this `C` is not read as covering it. |
| DC-30 | `docs/specs/upgrades-v2/02-DISCOVERY-v2.md:34#Never use private message contents or infe` — *"Anonymous contributors cannot become discoverable people"* | **C** | Four independently pinned paths: `submitted_by` never serialised (C16); the byline withheld unless self or opted-in, from one `nameAllowed` decision (C18, C19); `allow_profile_discovery` required and fail-closed (C02); and the live read set carries no contributor identity — `artifacts/api-server/src/lib/discoveryLiveRankRead.ts:51#export const RANK_CLAIM_TYPES = [`, *"Nothing else is read, so nothing else can leak."* |
| DC-31 | `docs/specs/upgrades-v2/02-DISCOVERY-v2.md:36#When live state is unavailable, retain per` — *"Temporary world objects retain their own valid identity instead of borrowing an arbitrary venue ID"* | **C** | Discovery has no temporary world object type, and the one identity join it makes runs the safe way: the live layer reads claims **for** an existing `canonicalPlaceId` rather than minting a place **from** a claim (`artifacts/api-server/src/lib/discoveryLiveRankRead.ts:51#export const RANK_CLAIM_TYPES = [`). **Red if:** any Discovery code assigns an existing place id to a transient observation. |
| DC-32 | `docs/specs/upgrades-v2/02-DISCOVERY-v2.md:42#Existing Ranker and Event Truth holds are ` — reuse approved weights, exploration budgets, sensitive-location policy, freshness and thresholds; ask rather than choose silent production defaults | **W** | 2 of 5. **exploration budget PASSES** — ROADMAP step 8's *"budget ~15–25 %"* is the ruling and the allocator implements it. **momentum cap PASSES** — `LOCAL_MOMENTUM_MAX_CONTRIBUTION` is ROADMAP step 7 made numeric and may change only with a ruling. **sensitive-location policy FAILS** — `artifacts/api-server/src/lib/protectedLocations.ts` is consulted by nothing in Discovery (B04). **thresholds FAIL, and this is a live instance rather than a legacy gap** — `artifacts/api-server/src/lib/discoveryStopConditions.ts:121#export const EVENT_REJECTION_RATE_THRESHOL` and the 10 % gap beside it are disclosed by §12.5 as *"this lane's proposals, not a ruling"*, which is exactly what this clause tells an implementer not to do. **freshness thresholds FAIL** — `TREND_MIN_RATE`, the momentum evidence floor and `TRAVEL_HORIZON_MINUTES` are in-code constants with no ruling cited. |
| DC-33 | `docs/specs/upgrades-v2/02-DISCOVERY-v2.md:38#Test real route→service→projection→c` — cache hits · expiry · permission changes · sparse coverage · empty candidates · dependency failure · retry | **W** | 5 of 7, and the wiring is tested in two disconnected halves. PASS: cache hits, expiry, permission change, dependency failure, empty candidates (`artifacts/api-server/src/test/discoveryCacheBEligibility.test.ts`). **retry FAIL** — no retry path exists to test (DV-37). **The client leg FAILS as a leg** — server tests stop at the response and the client component tests mock the service they would have to cross; the anchored citation is in `docs/discovery/compliance-v1.md` §4.10. Nothing exercises route→service→projection→client end to end. |
| DC-34 | `docs/specs/upgrades-v2/02-DISCOVERY-v2.md:30#| DSV2-12 | Measure real utility and calib` — *"no synthetic production visits, conversions or Trust awards"* | **C** | No conversion, visit-confirmation or Trust-award writer exists on this surface (§11.3a: eighteen names NULL in production), so nothing can synthesise one. `C` rather than vacuous because the opportunity was taken twice and declined in writing: `whyNow` stays null rather than being manufactured from static popularity (A03), and three `01` §11 codes with no producer are declared producerless rather than emitted, with a test that fails if one is (`artifacts/api-server/src/lib/discoveryReasonCodes.ts:113#export const REASON_CODES_WITHOUT_PRODUCER`). **Red if:** any Discovery write records a visit, conversion or award the user did not perform. |

### 14.6 Restated headline

> **Discovery, at worktree `/home/user/wt-483` (`7d1f2d498` + §12/§13 + this pass): 187 requirements ·
> 74 BUILT-AND-CORRECT · 67 BUILT-BUT-WRONG · 43 NOT-BUILT · 3 CANNOT-VERIFY →
> CONSTRUCTED 141 / 187 = 75.4 % · CORRECT 74 / 187 = 39.6 %.**
> Previous statement (§13.6, 153 rows): 66 / 49 / 36 / 2 → 75.2 % · 43.1 %.

| | rows | C | W | N | X | CONSTRUCTED | CORRECT |
|---|---|---|---|---|---|---|---|
| Before — §13.6 | 153 | 66 | 49 | 36 | 2 | 75.2 % | 43.1 % |
| The 34 added here | 34 | 8 | 18 | 7 | 1 | 76.5 % | 23.5 % |
| **After** | **187** | **74** | **67** | **43** | **3** | **75.4 %** | **39.6 %** |

**No code changed between the two measurements and no existing verdict moved.** The whole of the
−3.5 points of CORRECT is denominator — obligations the specification states that no row was
counting. CONSTRUCTED barely moves because **26 of the 34 new rows are built** (8 `C`, 18 `W`) and
only 7 are absences; **18 of the 26 do part of what their clause asks and stop.** That is the shape
of this finding, and it is a different shape from §11's, which added thirty-five absences.

Reconciled against what the repository can check, as §12.3 and §13.6 established:
`check:census-integrity` PASSES and reports `discovery 184 · 73 · 67 · 41 · 3 → 187, 3 counted where
this tool cannot read`. The three it still cannot read are unchanged — **DSV2-04 `N` · DSV2-05 `C` ·
DSV2-12 `N`** — and 184 + 3 = 187, with the buckets reconciling exactly: 73 + 1 = 74 `C`, 67 `W`,
41 + 2 = 43 `N`, 3 `?`. The difference between what this document says and what the repository can
check about it is those three rows and nothing else. `check:census-scope-coverage` is unchanged at
**100 %** (73 cited · 73 watched, floor 96 %) because this section routed its out-of-scope anchors to
`docs/discovery/compliance-v1.md` rather than go red to make a point (X2), and `check:doc-citations`
reports **zero** findings in either file this pass wrote.

**The five new rows a reader should push back on first**, because each is code that exists and was
graded against a clause nobody had read it against: DC-12 (2 of 11 candidate sources), DC-13
(eleven feature families, built in a module Discovery does not call), DC-17 (derived features carry
no source event window), DC-19 (no telemetry batch intake) and DC-32 (two of five policy inputs are
this programme's own unruled constants).

| BUILT-AND-CORRECT | **74** |
|---|---|
| BUILT-BUT-WRONG | **67** |
| NOT-BUILT | **43** |
| CANNOT-VERIFY | **3** |
| **total** | **187** |

### 14.7 Ceiling, and what this pass did not do

- **Nothing was built.** No source file, no test, no migration, no flag. Every `C` above rests on
  code another lane wrote and a test another lane ran; where no test pins a claim the row says so,
  and the eight new `C` rows each name what would turn them red rather than resting on the absence
  of a counter-example. Adding a test file needs `artifacts/api-server/package.json`, which this lane
  does not own.
- **No production read.** Every production figure relied on is inherited from §5 (2026-09-07) and
  §11.3a (2026-09-13) and is dated there. C28's grants and B01's `search_key` remain 2026-09-07
  measurements and should not be quoted as current.
- **Attribution was measured separately and is deliberately thin.** Over the 26 source files this
  census treats as Discovery's own: **13 attributable to this specification · 5 attributable
  elsewhere · 8 UNKNOWN** (`docs/discovery/compliance-v1.md` §7). The qualification matters more than
  the count — twelve of the thirteen carry their reference because §11–§13 *wrote it while grading
  against the specification*, and four of them did not exist before 2026-09-14. So the thirteen means
  *"written against this specification"*, which is a claim about two days, and not *"originally built
  from it"*, which nothing in this repository can establish for any Discovery file: `git log
  --diff-filter=A` reports `routes/discovery.ts`, `lib/portavaRank.ts`, `lib/discoveryPde.ts` and
  `lib/discoveryServeLog.ts` as created by the same commit on the same day. The 8 UNKNOWNs are left
  UNKNOWN on purpose — several of them read as though they were built from this package, and a
  resemblance is not evidence.
- **Four cross-lane requests, none taken**: X1 the specification is installed twice (byte-identical,
  two paths); X2 widen `CENSUS_SCOPE["census-discovery.md"]` with the eleven files the DC rows are
  evidenced by, which is why those anchors sit in `compliance-v1.md`; X3 the shared ranking service
  declares a `discovery` surface nothing calls; X4 `parseIdCell`'s digit-suffix range defect is
  unfixed and `DC-nn` was chosen to avoid it. All four in `docs/discovery/compliance-v1.md` §8.
- **BUILT ON A BRANCH IS NOT MERGED. MERGED IS NOT DEPLOYED. DEPLOYED IS NOT FLAG ENABLED.**
  Discovery is dark on the last reading anyone took: 13 `surface='discovery'` rows ever, the most
  recent 2026-08-15.

---

## 15. Three prose-counted rows become table rows — an accounting correction, 2026-09-14

*Appended under APPEND-ONLY / LAST-STATEMENT-WINS, as §11 established. This
section moves nothing between buckets and re-grades nothing. It is backlog item
**B10** in `docs/architecture/reconciled-baseline-v1.md` §8, and it exists only
because three requirements this document has graded since §11.4 could not be
read by the tool that counts it.*

### 15.1 The reason those three rows sat in prose no longer holds, and that was measurable

§11.13, §12.3 and §14.5 all say the same thing: `DSV2-04`, `DSV2-05` and
`DSV2-12` are **graded**, but they live in a mapping table rather than a verdict
table because `parseIdCell` in `artifacts/api-server/src/scripts/checkCensusIntegrity.ts`
would read a prefix ending in a digit as a line RANGE. §11.13 named the worst
case precisely — *"`DSV2-04` is the dangerous middle case: `DSV2`→`DSV4` is a
valid forward range, so it would expand to three phantom ids"* — and §12.3 added
that the defect *"is not fixed, and that script is not this lane's to fix."*

**That last sentence was already false when it was written, and this section is
the first thing to check it rather than repeat it.** The repair landed on
2026-09-13 in commit `e8f5552b1`, *"The tallier read one census row as nine, and
read five others as none"*, which added a branch recognising a prefix that ends
in a digit **before** the general range grammar. It was made for census-trust's
`TRV2-nn` ids; `DSV2-nn` is the same shape and was carried with it. Three
sections of this census went on citing a defect that a sibling lane had closed
the previous day, and nobody re-ran the measurement because the claim read like
a fact about the tool rather than a claim about it.

Re-run here, against the parser as it stands:

| cell, written exactly as a verdict table would write it | ids the parser returns |
|---|---|
| `DSV2-04` | **one**: `DSV2-04` |
| `DSV2-05` | **one**: `DSV2-05` |
| `DSV2-12` | **one**: `DSV2-12` |
| the same three with the repair removed | **eleven**: `DSV2` … `DSV12`, and no `DSV2-04` anywhere |

So the three rows below cost nothing and are owed. The repair is now pinned by
`artifacts/api-server/src/test/censusDigitPrefixIds.test.ts`, which reads a
fixture carrying these three ids **and** four range cells copied verbatim out of
census-trips, census-highlights-memories, census-media and census-layover, so
that reading `DSV2-04` as one id cannot be bought by breaking the ids that
genuinely are ranges. That test carries a POSITIVE CONTROL: it deletes the
branch from a copy of the parser and requires the copy to fail. Watched red
before green, both ways round.

### 15.2 The three rows, carrying the verdicts they already hold

**No verdict moves here.** Each is restated from the section that graded it,
unchanged, in the form the tool can read.

| id | Requirement | V | Evidence |
|---|---|---|---|
| **DSV2-04** | `02-DISCOVERY-v2.md` DSV2-04, the **client** leg split off A03 (§11.4): *"Observed and predicted recommendations render distinctly; expired why-now claims disappear or become explicitly stale."* A03 grades the server projection and holds at **W**; this is the separately-testable client half. | **N** | Unchanged from §11.4, which graded it: *"A03 **W** holds; new row DSV2-04 **N**."* No Discovery client renders the observed/predicted distinction, and §11.11's headline has counted this row as `N` since it was written. |
| **DSV2-05** | `02-DISCOVERY-v2.md` DSV2-05, the **eligibility** leg split off DV-03 (§11.4): eligibility is enforced on cache-hit paths, not only on the ranking path. Different failure, different test from DV-03's ranking-bypass leg. | **C** | Unchanged from §11.8, which built it and moved it `W → C` with a test watched red first. DV-03 itself remains **W** on its own leg and is not restated here. |
| **DSV2-12** | `02-DISCOVERY-v2.md` DSV2-12, the **traceability** leg split off DV-19 (§11.4): *"Trace served recommendation→exposure→permitted outcome with versions and coverage."* DV-19 grades *optimise for travel value* and remains **N** on its own clause. | **N** | Unchanged from §11.4 and §13. Held down by the same absence as DV-06, DV-26, DV-40 and DV-46: no `recommendation_id` exists on this surface, so no served item can be traced to an outcome. |

`DSV2-06` is **not** restated. §12.2 moved it to `C` and it has parsed as a
single id ever since; restating it would make it a revised row for no reason.

### 15.3 What this changes in the tool's reading, measured

Before this section, `check:census-integrity` reported
`discovery 184 · 73 · 67 · 41 · 3 → 187, 3 counted where this tool cannot read`.
After it, the same command reports **`discovery 187 · 74 · 67 · 43 · 3 → 187,
0 counted where this tool cannot read`**, and the corpus total moves from 3,493
parsed rows to 3,496 with the corpus-wide prose gap falling from 24 to 21.

**Every one of those three rows was already inside this census's headline.** The
buckets are identical before and after — `73 + 1 = 74` `C`, `67` `W`,
`41 + 2 = 43` `N`, `3` `?` — which is the arithmetic §14.5 already stated by
hand. What changes is who can check it: the difference between what this
document says about itself and what the repository can verify about it is now
**zero rows**, where it was three.

That has a consequence worth naming rather than discovering later. `check:census-integrity`
only enforces that a stated headline equals its own table when parsed rows equal
the stated denominator — which, for this census, is true for the first time as
of this section. The headline below is therefore now machine-checked against the
rows, not merely published beside them.

### 15.4 Restated headline — unchanged in every bucket

> **Discovery, at `3ca68cb06` + §11–§15: 187 requirements · 74 BUILT-AND-CORRECT ·
> 67 BUILT-BUT-WRONG · 43 NOT-BUILT · 3 CANNOT-VERIFY → CONSTRUCTED 141 / 187 =
> 75.4 % · CORRECT 74 / 187 = 39.6 %.**
> Identical to §14.5. Nothing was re-graded, re-measured or re-read; three rows
> changed shape and none changed value.

### 15.5 What would turn this red (P24)

- **The parser regressing.** `censusDigitPrefixIds.test.ts` fails, and so does
  `check:census-integrity` itself: with the repair removed the three cells
  expand to eleven phantom ids, this census parses 188 rows against a stated
  denominator of 187, and the tool reports *"more rows than requirements is
  arithmetically impossible"*. Measured by removing it, not argued.
- **Any later section restating one of these three ids** with a different
  verdict. Last-statement-wins would take the later one and this section's
  arithmetic would stop holding — which the headline check would now catch,
  because there is no prose gap left for a difference to hide in.
- **Something else in this census changing a bucket without re-deriving §15.4.**
  The headline is now checked against the rows, so a row moved in a later
  section and not reflected here fails the guard rather than drifting quietly.

### 15.6 What this section did NOT do

- **No verdict was re-read against the code.** Not one of the three rows was
  re-derived; each is carried verbatim from the section that graded it. This is
  an accounting correction and nothing more, and it must not be read as
  re-certifying `DSV2-05`'s `C`.
- **`head_commit` is unchanged at `3ca68cb06`** and is deliberately not
  re-declared: no code was measured here, so declaring a newer commit would
  claim a re-measurement that did not happen.
- **The two cross-lane requests §14.7 raised alongside X4 are still open.** X1
  (the specification installed twice) is unresolved — see §15.7. X3 (the
  unwired `DiscoveryRankingService.ts`) is untouched.
- **X2 is now closed and this census's citations were not moved back.** The ten
  product files the DC rows are evidenced by are in
  `CENSUS_SCOPE["census-discovery.md"]` as of this pass, so a change to any of
  them ages this census. The anchors themselves stay where §14.7 put them, in
  `docs/discovery/compliance-v1.md`; moving ~40 anchored citations between two
  documents is a citation-rot risk taken for no gain, and the coverage guard
  reads the same either way.

### 15.7 X1 re-measured, and why nothing was deleted

The duplicate install is real and was verified by content hash at this commit,
not by `diff` over three files as §12.1 did: **all thirteen specification
documents in `docs/specs/discovery-v1/` are byte-identical to their renamed
counterparts in `docs/specs/discovery-architecture-v1/`**, and all **17 / 17**
`SOURCE-MANIFEST.json` entries resolve by content hash under `docs/` — including
after a hypothetical deletion of the first directory, because every hash they
need is also present in the second.

**The deletion was still not performed, and the reason is a count.** Thirty-seven
references to `docs/specs/discovery-v1/` live outside that directory: twenty-six
in `docs/discovery/compliance-v1.md`, six in `artifacts/api-server/src/lib/`,
four in `artifacts/api-server/src/test/`, one in
`docs/architecture/reconciled-baseline-v1.md`. Deleting the directory without
repointing all thirty-seven trades one drift surface for thirty-seven dangling
citations in a corpus that is already carrying 124 broken anchors, and none of
those twelve files belongs to the lane that measured this. **A dangling
reference is worse than a duplicate**, so the duplicate stands and the repoint
is handed over with the hashes that make it safe. The fourteenth file,
`docs/specs/discovery-v1/00-PROVENANCE.md`, has no counterpart in the surviving
directory and must be moved rather than deleted; it is watched for staleness as
of this pass so that its disappearance is loud.

| BUILT-AND-CORRECT | **74** |
|---|---|
| BUILT-BUT-WRONG | **67** |
| NOT-BUILT | **43** |
| CANNOT-VERIFY | **3** |
| **total** | **187** |

---

## 16. The five-lane pass, 2026-09-14 — six rows moved, and the census's own account of WHY Discovery is stuck was wrong

Five bounded lanes ran in parallel worktrees off `7455e31c1`, with disjoint file
ownership and no authority to edit a census. **113 rows were open. Two moved.**
The larger result is not the six: it is that a significant fraction of the
*reasons* recorded against the other 107 were measurably false, and a false
reason is how the next sweep spends a week discovering nothing.

Every claim below was re-verified by the integration owner against the source
before it was written here. Two lane claims did not survive that check and are
recorded in §16.6.

### 16.1 The verdict moves — TWO, not the six first written here

**This section's first draft claimed six moves. It was wrong, and the error is
recorded rather than quietly fixed, because it is the same error §16.6 catches
the lanes making and it deserves no softer treatment when I make it.**

Four of the six — A05, A07, DV-40, DV-46 — were **already `W`** before this pass.
Each lane reported its row's old verdict as `N`, read in good faith from the row
in an older section; a LATER section had already re-graded it, and
last-statement-wins means the later one is the verdict. I caught exactly this for
DV-18 (§16.6), wrote it up as a lane error, and then booked four more of the same
kind myself. It was caught by `check:census-integrity` disagreeing with my own
table, not by me re-reading.

| id | was | now | what changed, and why it is not better than it says |
|---|---|---|---|
| **DV-08** | **W** | **C** | `01` §8's five engine states are declared, dispatched, AND selectable. The last clause is the whole story — see §16.2. |
| **DV-38** | **N** | **W** | `features.schemaVersion` is now written by the only Discovery serve-log writer (`artifacts/api-server/src/lib/discoveryServeLog.ts:430#schemaVersion: DISCOVERY_EVENT_SCHEMA_`), placed after the caller's context spread so a caller cannot overwrite it. **Not `C`**: `rank_events` has no `schema_version` COLUMN, which is a migration. |

**The four that did not move, and what is true about them anyway.** Their
verdicts are unchanged; their EVIDENCE was false and is corrected here, which is
worth more than a move would have been:

| id | verdict | the sentence that was false, and what is there |
|---|---|---|
| A05 | `W` (unchanged) | *"Nothing in routes/discovery\*.ts or lib/discovery\*.ts models an intent mode."* `artifacts/api-server/src/lib/discoveryLiveRank.ts:99#export const DISCOVERY_INTENT_MODES` is exactly the spec's eight, and `artifacts/api-server/src/routes/discovery.ts:1880#mode: parseIntentMode(req.query.intentMode` parses one off the request — twice, the second at `:2251`. Held at `W` by `discovery_live_rank_enabled` (2850), not by absence. |
| A07 | `W` (unchanged) | *"No safety term reaches the ranker."* `artifacts/api-server/src/lib/discoveryLiveRank.ts:411#const unsafe = state.unsafe;` forces influence and opportunity value to zero, and `artifacts/api-server/src/lib/discoveryLiveRank.ts:462#if (a.grade.safety.demoted !== b.grade.saf` sorts every demoted row behind every non-demoted one. Same flag. |
| DV-40 | `W` (unchanged) | *"zero occurrences in Discovery."* `artifacts/api-server/src/lib/discoveryRecommendationId.ts:149#export function recommendationIdFor` mints it and `artifacts/api-server/src/lib/discoveryServeLog.ts:421#recommendationId: recommendationIdFor({` calls it on the serve path. What keeps it at `W` is coverage: 2 of 6 `GET /discovery` serve points write through `logImpression` and mint nothing. |
| DV-46 | `W` (unchanged) | `04` §10.6's propagation test now exists at ROUTE level — `artifacts/api-server/src/test/discoveryRouteRecommendationPropagation.test.ts`, 8/8, registered — and its own result is that propagation is incomplete. A test that passes by reporting a gap does not close a clause about the gap. |

### 16.2 DV-08 — a capability the shipping product could not reach

Lane D1 built the five states and then declined to close the row, which is the
part worth recording. `routes/admin.ts` validated the operator's `metadata.mode`
against a SECOND, hand-maintained copy of the list — `["legacy","shadow","pde"]`
— so `PATCH /admin/feature-flags/DISCOVERY_ENGINE_MODE/metadata {"mode":"partial"}`
was refused at the edge. **`compare` and `partial` could be resolved by the
engine and never selected through the product's own admin surface.**

It survived because **it fails closed**. A refusal to SET a new state is
indistinguishable from a state nobody has asked for yet. Nothing was unsafe,
nothing went red, and two of five requirements were unreachable.

The fix is not the two missing entries — that would restore the cause.
`lib/discoveryEngineMode.ts:148#ACCEPTED_ENGINE_MODE_SPELLINGS` is derived from
the resolver's own alias map and `routes/admin.ts:871` consumes it.
`src/test/discoveryEngineModeAdminReach.test.ts` pins the property in both
directions and was mutated to prove it bites: re-typing the literal → RED;
deleting `["partial","partial"]` from the alias map → RED with *"state
`partial` is resolvable but NO admin-accepted spelling selects it — it is
unreachable from the shipping product."*

**WHAT WOULD TURN DV-08 RED:** a sixth state added to `DISCOVERY_ENGINE_STATES`
without a spelling; a literal list re-typed in `admin.ts`; `ENGINE_STATE_PATH`
losing a member. All three are executable and all three are red today under
mutation.

### 16.3 The N-block was misdescribed, and the correction is larger than the moves

§11.9 and §12.8 record a block of `N` rows as *"four absent subsystems the owner
has ruled STALE or has not scheduled."* Thirty of those rows were re-partitioned
against source. The grouping does not hold:

| disposition | rows | |
|---|---:|---|
| OWNER-FROZEN | 8 | Trails (DV-20…DV-26) + A18. Real, and enforced in SQL: `artifacts/api-server/src/migrations/2290_intelligence_graph_node_kinds.sql:88` raises *"POSTCONDITION FAILED: trail must NOT be admitted (ROADMAP: Trails as a peer system is STALE)"*. |
| **CROSS-CENSUS** | **15** | another census's paths. Three (A14, DV-52, DV-77) are the SAME requirement another census already grades. |
| ABSENT-BUT-UNSCHEDULED | 6 | nothing forbids it, nothing implements it, building it would invent product. |
| ACTUALLY BUILDABLE | 1 | DV-76 — already built; needs a verdict, not code. |

**`docs/discovery/ROADMAP.md:147` — *"Phases E and F: FROZEN"* — covers NONE of
these thirty rows.** E and F are Discovery's measurement-readiness and owner-gate
phases. The ruling that actually binds Trails is `:148` (peer scoring systems
STALE); the one that binds A18 is `:222` (ranker hold). Citing the wrong clause
is how a hold outlives its own scope.

### 16.4 Three shared evidence sentences that are false

1. **The fourteen creator-ledger rows (DV-56…DV-69)** share *"None of the objects
   these documents specify exists."* True of the seven table NAMES it lists;
   **false as a capability claim.** `artifacts/api-server/src/migrations/2170_intel_reward_ledger.sql:40`
   is `cash_amount numeric NOT NULL DEFAULT 0 CHECK (cash_amount = 0)` — a
   versioned, append-only, non-cash earnings ledger, with `ledger_version` NOT
   NULL at `:41`, and its flag TRUE in production. What is absent is a
   *Discovery-surface* creator→value link, which is a different sentence. The
   disposition is `docs/architecture/09_Payment_Architecture.md:529` —
   *"Payments are not a discovery workstream."*
2. **A21** — *"no registration mechanism exists to register into."* **False.**
   `artifacts/api-server/src/services/telegraph/actionRegistry.ts:55` declares
   all four hooks. The true reason is that no Discovery-sourced action exists to
   register.
3. **DC-13 and DC-24** — *"no Discovery route imports it"* about
   `services/ranking/DiscoveryRankingService`. **False, and false in the failing
   direction.** `lib/discoveryPde.ts:105` imports it, `:695` calls it with
   surface `"discovery"`, and `routes/discovery.ts:47` imports `rankForViewer`
   from `discoveryPde`, calling it at `:1825`, `:1932` and `:2239`. So
   `portavaRank` and the named-family ranker run **in sequence on the same
   authenticated request**: *"avoid parallel ranking systems"* is violated at
   RUNTIME, not merely in the file tree. **DC-24 is worse than its row says.**
   Pinned by `src/test/discoveryFeatureFamilyReach.test.ts` (5/5, registered).

### 16.5 The `recommendation_id` migration is NOT required, per row

§12.8 calls `recommendation_id` *"the highest-value single item in the
denominator, and a migration decision."* Re-derived against the module rather
than against the census's absence claim, **the migration is not required for any
of the four rows it was said to block**, and each row's own words say so:

- **DV-40** — `04` §6 instructs the opposite of a new table: *"extend it by
  migration rather than introducing a competing event store."* `rank_events`
  already represents it.
- **DV-06** — the unit is the EXPOSURE, and the derived id binds the serve
  (`userId, sessionId, servedAt, surface, position, itemId`), deliberately not
  the item. An id keyed on the item would under-count the very quantity `04` §5
  exists to measure.
- **DV-46** — a test requirement. A derived id is exactly as testable.
- **DSV2-12** — the trace is already within ONE `rank_events` row; the outcome
  update writes to that same row. No join table is named by the clause. It is
  blocked because `routes/rankEvents.ts:203-216` resolves the row by
  `ORDER BY served_at DESC LIMIT 1` and never reads `features.recommendationId`.

`10` §3's `recommendations` / `recommendation_items` remain genuinely absent, so
any row grading *those tables specifically* is unaffected. **No migration file
was written and none was applied.**

### 16.6 Claims that did NOT survive verification — including four of my own

Recorded because the point of an integration owner is to be the place claims
stop, not a relay — and because I was not that place on the first pass.

**THE PATTERN, stated once because it happened five times.** A lane reads a row
in an older section, sees `N`, builds against it, and reports `N → W`. But this
census is append-only and last-statement-wins: a later section had already
re-graded that row `W`. The move is real work described against a verdict that
had already moved. Four such rows (A05, A07, DV-40, DV-46) reached §16.1's first
draft and are corrected there; the fifth is DV-18 below. **`check:census-integrity`
caught all four by disagreeing with my own table.** The lesson is not that the
lanes were careless — the stale `N` rows are genuinely there to be read — but
that no lane's stated OLD verdict may be taken as the verdict; only the tally is.

1. **DV-18 was proposed N→W. It is already `W`.** The census contradicts itself —
   `:865` grades it `N`, `:1378` grades it `W` — and last-statement-wins already
   resolves it to `W`, which is what `check:census-integrity` reads. Booking the
   move would have recorded a verdict change that did not happen. `:865`'s
   *"Zero of nine exist"* is stale prose, not a live verdict.
2. **DV-75 was proposed W→C. It stays `W`.** All three verdict jobs exist and
   gate — `ci-verdict`, `live-db-verdict`, `unwired-verdict`, each an
   `if: always()` aggregator that fails on any non-`success` need. But Phase
   0.2's word is *"Require"*, and whether they are REQUIRED CHECKS in branch
   protection is a GitHub setting, not a repository fact. **A requirement that
   needs evidence outside the tree is not closed from inside it.**
   **WHAT WOULD CLOSE IT:** a reading of `main`'s required status checks showing
   all three listed by name.

### 16.7 Headline

> **Discovery, at this commit: 187 requirements · 75 BUILT-AND-CORRECT · 67
> BUILT-BUT-WRONG · 42 NOT-BUILT · 3 CANNOT-VERIFY → CONSTRUCTED 142 / 187 =
> 75.9 % · CORRECT 75 / 187 = 40.1 %.** Up from 74 / 67 / 43 / 3 — 75.4 % and
> 39.6 %. **Two rows moved: DV-08 on new code, DV-38 on a new row property.
> Half a point of CORRECT, from five lanes.**
>
> Measured by `check:census-integrity`, not by adding up this section's own
> table — which is how the four phantom moves in §16.1's first draft were caught.

| BUILT-AND-CORRECT | **75** |
|---|---|
| BUILT-BUT-WRONG | **67** |
| NOT-BUILT | **42** |
| CANNOT-VERIFY | **3** |

75 + 67 + 42 + 3 = 187.

### 16.8 Ceiling — why 100 % is not reachable by engineering, stated as a count

Of the 107 rows still not `C`:

- **Flag-gated, owner decision.** `2850_discovery_live_rank_flag.sql:51` and
  `2289_discovery_ranking_modifiers_flag.sql:73` are seeded FALSE with
  postconditions that RAISE if they read TRUE. 2850's own seed text: *"Enabling
  is an owner decision."* No amount of code moves these.
- **Owner-frozen subsystems.** Trails, enforced in SQL. Building one to move a
  verdict would be inventing a denominator.
- **Migration-blocked.** `rank_events` lacks `schema_version`, `dwell_ms`, a
  privacy-class column, and a unique key for DV-37's retry. Migrations are not
  this lane's to write and are not to be applied to production.
- **Owner decision D11, and it is WIDER than recorded.** `11` §9 — *"A failure
  must not masquerade as success"* — governs at least THREE live routes, not
  `/discovery/suggest` alone: `routes/discovery.ts:2663-2670` returns
  `200 {places: [], posts: [], total: 0}` from `GET /discovery/feed`'s catch, and
  `:2455-2457` returns `200 {counts: {}}` from `GET /discovery/counts`. The cost
  was demonstrated by mutation: downgrading a genuine `400 invalid_payload` to
  `200 {places: []}` turned a test red, because an empty-success arm is
  indistinguishable from a served-nothing arm to every consumer — **including the
  exposure denominator.** Not taken here.
- **Human/production evidence.** DV-02, DV-47, DV-71, DC-14, DC-18, DC-27 and
  DV-75 each need a deployment, a production read, or a settings page. None is
  closable from code, and none was guessed.

**BUILT ON A BRANCH IS NOT MERGED. MERGED IS NOT DEPLOYED. DEPLOYED IS NOT FLAG
ENABLED. FLAG ENABLED IS NOT PRODUCTION REALIZED.** Discovery remains dark on the
last reading anyone took: 13 `surface='discovery'` rows ever, latest 2026-08-15.
This pass read no production and does not refresh that figure.

---

## §17 — Five lanes land: twenty verdict moves, and two the lanes asked for that I refused

Written by the integration owner after cherry-picking `9ff660674`, `33bd96614`,
`a119077ea`, `8363595cb`, `a80461623` and `39b4557d1` onto the branch. Every OLD
verdict below was read from `CENSUS_INTEGRITY_DUMP=ALL`, never from a lane's
report — §16.6's rule, which exists because four of §16.1's first-draft moves
were phantoms read out of stale prose.

### 17.1 The twenty moves

| **ID** | **was** | **now** | why |
|---|---|---|---|
| **DV-13** | **N** | **W** | `diversifyTrailPage` MAX_PER_CONTRIBUTOR_PER_PAGE, reached at `GET /v1/discovery/trails/:id/modules` |
| **DV-20** | **N** | **W** | `trails` with a UNIQUE slug + `canonicaliseTrailProposal`; content references `trail_id`, never a title |
| **DV-21** | **N** | **W** | four modules, four distinct objectives, asserted over HTTP |
| **DV-22** | **N** | **W** | `fairExposureSlots` wired into `just_arrived`, with denominators |
| **DV-23** | **N** | **W** | place cap + `moreFromThisPlace` remainder — suppressed is not deleted |
| **DV-24** | **N** | **W** | `trail_edges` written by `proposeTrail`; `relatedTrails` walks both directions |
| **DV-25** | **N** | **W** | `rank_events` → `trailMomentumFromRankEvents` → `trailAffinityMap` → served rank. Previously computed and consumed by nothing |
| **DC-02** | **N** | **W** | `capTrailLabels` + 2910's trigger; 409 naming the full budget |
| **DC-03** | **N** | **W** | four checks; 409 carrying the refusing check and `06` §6's suggested parent |
| **DC-04** | **N** | **W** | the transition relation is enforced; `proposed → active` on first content; `archived` terminal |
| **DC-05** | **N** | **W** | nine metrics + snapshots, and the §11 ranking input they feed |
| **DC-20** | **N** | **W** | all nine `11` §3 actions reachable over HTTP |
| **DC-21** | **N** | **W** | one of `11` §4's five — trending by Trail, serving an order and a boolean and never a momentum number |
| **DV-56** | **N** | **W** | `creator_attributions` addresses all six `07` §2 types; two have a producer, four are structurally-refused seams |
| **DV-57** | **N** | **W** | `creator_earning_entries` records earnings with `cash_settled_minor = 0` — `07` §10's "without paying" |
| **DV-58** | **N** | **W** | six distinct seeded rule lineages, derived not stored, per-type mismatch refused |
| **DV-59** | **N** | **W** | a hold is expressible on all six types; an unexplained hold is refused at the DB and in code |
| **DV-60** | **N** | **W** | `recomputeCreatorUnderRuleVersion` — an old version still folds to its old total, rehearsed live on portava-ci |
| **DV-64** | **N** | **W** | `public.creator_share_ledger` — one relation the share is computable from, reconciled both ways, recovery executed |
| **C14** | **W** | **C** | the consumer half. `getSearchSuggestions` parses the refusal; the three-way split (`validation` / `transient_db` / none) is pinned, and mutation C6 kills a parser that always returns `undefined` |

### 17.2 Two moves the lanes asked for and did not get

The creator-types lane proposed **DV-58 → C** and **DV-59 → C**, on the grounds
that these are the two properties with no seam in them: six lineages exist, and a
fraud hold is expressible, explained and enforced for every type.

Both were verified and both were refused, on this census's own DV-62/A05
standard. The check is one grep:

```
grep -rn "CreatorAttributionService" src --include=*.ts | grep -v <the file itself>
  → src/test/creatorTypeService.test.ts:38
  → src/lib/creatorTypeAttribution.ts:43   (a COMMENT naming it)
```

**One importer, and it is the file's own test.** No route, no scheduler, no job
reaches it. That is A05's doubly-unreachable pattern exactly, and the DV-64 lane
applied the same rule to its own work unprompted — `CanonicalShareReader` has the
identical single test-only importer and that lane capped itself at `W` for it.
Grading DV-58/59 `C` while DV-64 stays `W` on identical evidence would be the
definition-change the owner's instruction forbids.

**What would turn DV-58/59 green:** a call site on a route or scheduler, 2920 and
2921 applied to production rather than to the portava-ci rehearsal project, and a
row that was attributed by a request rather than by a fixture. None of the three
is true today.

### 17.3 The ceiling every one of these nineteen `W`s sits under

Not one of the nineteen N→W rows can reach `C` from code alone, and the reason is
the same for all of them:

- **2910, 2920, 2921 and 2930 are applied to `portava-ci` only.** Production
  carries none of them. `10` §7 forbids editing an applied migration, so applying
  a shape the code may still abandon is the one mistake that cannot be undone.
- **Zero rows exist anywhere.** Every reconciliation, every fold and every metric
  in this batch is non-vacuous only over seeded fixtures. The migrations say so
  themselves: 2930 raises `— VACUOUS (both ledgers empty)` rather than passing
  quietly.
- **`discovery_ranking_modifiers_enabled` is seeded FALSE**, so the Trail
  affinity term contributes exactly 0.0 on every deployment. It is wired, it is
  capped, and it is off.
- **The branch is not merged**, and production runs merged code.

### 17.4 The cap, recorded as the owner's number and not as a derivation

`0.10` is the Trail affinity cap. Both files the ruling points at were read and
**neither names a number**: `02_Trails.md` §11 states the obligation in words
(*"Trail health should influence ranking but not silently erase legitimate
content"*), and `06_Recommendation_Engine.md` §3 lists `trail_relevance` among
eleven feature families with no weight and no bound. So `discoveryTrailAffinity.ts`
now says whose number it is — *"an APPROVED INITIAL SETTING, PROVISIONAL AND
SUBJECT TO REVISION — not a value this code chose"* — and the text presenting it
as derived was removed.

Its effect is asserted in the real ranking flow, not against the clamp: a
saturated affinity moves a place by **exactly 0.10** against an otherwise
identical twin; with `weights.trailAffinity = 100` it still moves it by exactly
0.10; and through `rankCandidates` a rival ahead by one interest tag (0.30) is
**not** overtaken, while at `interestTag: 0.05` it is. Taste is the spine and the
modifier breaks ties, as arithmetic.

### 17.5 Tally

| BUILT-AND-CORRECT | **76** |
|---|---|
| BUILT-BUT-WRONG | **85** |
| NOT-BUILT | **23** |
| CANNOT-VERIFY | **3** |

76 + 85 + 23 + 3 = 187. One row moved to `C`; nineteen moved `N → W`; the `X`
rows are untouched because nothing in this batch made them verifiable.

### 17.6 The record itself was lying, and nothing failed

Rebuilding `docs/discovery/compliance-ledger.json` after §17.1 produced **36
requirements**. The run before it produced **177**. The run after, **36** again.
The tree did not change between them.

`buildDiscoveryLedger.ts` reads verdicts from `checkCensusIntegrity.ts`'s dump
through `execFileSync` — which is a PIPE. On a pipe Node's `console.log` is
**asynchronous**, and the dump block's `process.exit(0)` discarded whatever had
not yet flushed. The count printed on stderr is computed BEFORE the write, so
the transcript said

```
CENSUS_INTEGRITY_DUMP=ALL: 3499 row(s) from 13 census file(s).
discovery ledger: 36 requirement(s)
```

— a true count beside a stdout that carried a fraction of it. Every human
reading (`| grep`) runs through the same pipe.

**This is the worst class of defect this document tracks**: THE ONE
AUTHORITATIVE RECORD that five lanes coordinate against could silently lose 80 %
of its rows, and the header of the very script that writes it promises *"the
ledger and the census can never disagree about what a row currently is."* They
disagreed, at random, and no check noticed, because the only field that would
have shown it is `total` — a number nobody compares between runs.

Fixed by writing the dump with one synchronous `fs.writeSync(1, …)` instead of
3,499 asynchronous `console.log`s, and by replacing the checker's other
`process.exit(1)` with `process.exitCode`. Pinned by
`src/test/censusDumpCompleteness.test.ts`, which asserts the transcript agrees
with its own declared count over five consecutive runs — an invariant that holds
for every corpus and fails for every truncation, so it does not rot when a census
is edited.

**Mutation, run and killed:** restoring the `console.log` loop gives
`run 1: stderr declared 3499 row(s) and stdout carried 538`. Reverted and
`cmp`-verified byte-identical.

The ledger now rebuilds to **187 requirements, C=76 W=85 N=23 X=3** — identical
on three consecutive runs, and identical to `check:census-integrity`'s own
count, which is the agreement the header claimed all along.

---

## §18 — The refusal envelope's consumers, audited; one verdict moves back; and the row that should exist and does not

*Written by the Discovery lane at worktree `/home/user/wt-w5-discovery`, detached
at `2844870a0` plus this pass. Every OLD verdict below was read from
`CENSUS_INTEGRITY_DUMP=ALL`, never from this document's prose — §16.6's rule.
§0's `head_commit` is **NOT** re-declared here: this pass re-read the refusal
surface, the ranking vector and one search lane, not the 187.*

### 18.1 Which population each row belongs to — read this before comparing any two numbers

This census scores against **three** denominators on purpose, and
`check:census-integrity` says so in its own output (*"states 3 denominators: 67,
153, 187 — scored against more than one population on purpose"*). They are
cumulative, not alternative, and every row belongs to exactly one of the three
*additions*:

| population | added by | id prefixes | rows | C | W | N | X |
|---|---|---|---|---|---|---|---|
| The original denominator | §1 (inbound + shared + own contracts) | `A··` `B··` `C··` | 67 | 48 | 14 | 5 | 0 |
| The restored `discovery-architecture-v1` package | §11.3 | `DV-··` `DSV2-··` | 86 | 20 | 47 | 17 | 2 |
| The compliance coverage gap | §14.5 | `DC-··` | 34 | 8 | 24 | 1 | 1 |
| **cumulative** | | | **187** | **76** | **85** | **23** | **3** |

So *"40.6 % correct"* is a statement about the **187**, and it is not comparable
to §2d's 68.7 %, which is a statement about the **67** — the same 67 rows are
today 48 / 67 = **71.6 %** correct, and they have improved while the headline
fell, because two larger and much weaker populations were added beneath them.
Any claim of the form *"Discovery got worse"* that compares a pre-§11 percentage
with a post-§14 one is comparing different populations and means nothing.

The 111 non-correct rows split **19 / 66 / 26** across the three.

### 18.2 Row moves

| **ID** | **was** | **now** | why |
|---|---|---|---|
| **C14** | **C** | **W** | **The consumer half was graded on the parser, and the parser is not the consumer.** §17.1 moved this row to `C` on the ground *"the consumer half. `getSearchSuggestions` parses the refusal"*. That parse is real (`travel-buddy-standalone/src/services/discovery.ts:1131#const refusal = parseRefusal(body);`) and nothing here disputes it. But `getSearchSuggestions` has exactly ONE caller in the tree — `travel-buddy-standalone/src/hooks/useSearchSuggestions.ts:94#if (res.ok) {` — and that caller branches on `ok` alone. It never reads `coverage`. It renders a refused `groups: []` as an empty typeahead, and then it **writes the refusal into a keyed client cache** (`travel-buddy-standalone/src/hooks/useSearchSuggestions.ts:120#cache.set(key, { groups: res.groups, ts: Date.now() });`), so a single `transient_db` refusal goes on being served from the device for the cache TTL with no network call left to notice the recovery. The owner's own ruling, quoted verbatim in `artifacts/api-server/src/lib/discoveryRefusal.ts:71#"Add upstream_unavailable for upstream dependency failures. Do not cache`, forbids both halves of that in one sentence — *"Do not cache rate limits or outages as 'this location does not exist'"* and *"A distinguishable response body alone is insufficient if consumers still treat it as successful empty data."* **W and not C**, on this census's own §17.2 standard: that section refused `C` for DV-58/DV-59 because their only importer was the file's own test, and capped DV-64 at `W` for the identical pattern. A field whose only consumer ignores it is the same shape of unreachability. **W and not N**: the route emits the refusal correctly, the service parses it correctly, and the three-way split §17.1 pinned is genuinely pinned — it is the last hop that is missing, and it is one `if` in a file this lane may not write. |

That is **one** move, and it is a move BACKWARD over a verdict the integration
owner set eight commits ago. It is recorded that way rather than softened:
§17.1's evidence sentence is true and its conclusion does not follow from it.
The fix is a cross-lane request (§18.7), not a re-grade after the fact.

### 18.3 The 111 non-correct rows, partitioned

Six buckets were asked for. Five of them fit; the 111 needed a sixth, and the
sixth is named rather than folded into whichever of the five it least
misdescribes.

| bucket | rows | which |
|---|---|---|
| **(a) closable from code this lane owns** | **2** | B04 — `lib/protectedLocations.ts` is consulted by nothing in `routes/discovery*.ts` or `lib/discovery*.ts`, and both are this lane's files. B05 — `searchCountries` aggregates `profiles.home_country`, so a country with no users in it does not exist; the resolver is absent but the call site is mine. NEITHER WAS BUILT IN THIS PASS, and saying so is the point of the bucket: they are the only two of 111 that no other owner, migration or decision stands in front of. |
| **(b) unapplied migration, or a flag seeded FALSE that refuses to commit ON** | **30** | The nineteen §17.3 names (DV-13, DV-20…DV-25, DC-02…DC-05, DC-20, DC-21, DV-56…DV-60, DV-64) under 2910/2920/2921/2930, all applied to `portava-ci` only; plus A03, A05, A07, DV-18, DV-40 (2850 / 2289 / `rank_events` columns), A10, A11, B03 (2420, 2550, 2778, 2360), and DV-26, DV-37, DV-41 (`recommendation_id`, a unique key, `dwell_ms`). |
| **(c) owner decision, named** | **4** | A01 and A18 — 2850's own seed text, *"Enabling is an owner decision"*, and §4's intent hold. B02 — §6 D5. C14 — D11, whose client half §18.2 has just re-opened. |
| **(d) another lane's file, named** | **9** | A13, A14 (Layover). A21, A24 (Telegraph). DV-77 (census-media). DSV2-04 (the client render leg). A08 (three of G6's four engines are `travel-buddy-standalone/**`). A25 (the Map gateway, §6 D10). C19 (the client byline, §6 D2). |
| **(e) absent capability — the subsystem does not exist and building one would invent a denominator** | **13** | DC-23, DSV2-12, DV-19, DV-34, DV-61, DV-62, DV-63, DV-65, DV-66, DV-67, DV-68, DV-69, DV-80 — the creator ledger, the payment provider, the ecosystem governor and the outcome instrument. |
| **(f) the census sentence is already FALSE at HEAD** | **1 row, 3 sentences** | See §18.4. This is an **overlay, not a disjoint bucket**: DV-18 is counted once, in (b), because a corrected reason does not remove its blocker. Counting it twice would inflate the partition. |
| **(g) evidence obtainable only OUTSIDE the code** — a production read, a deployment, or a settings page | **9** | The three `X` rows DC-27, DV-52, DV-76, plus B01, DV-02, DV-47, DV-71, DC-14, DC-18 (§16.8's list). None of (a)–(f) describes these: they are not blocked, not decided, not absent and not another lane's — they are unmeasurable from a checkout. |
| **not individually re-partitioned in this pass** | **44** | `W` rows of the restored and coverage packages that no part of this pass re-read. They are NOT claimed to be any of the above. Stated as a count so the partition is honest rather than complete. |

2 + 30 + 4 + 9 + 13 + 9 + 44 = **111**.

### 18.4 Census sentences that are FALSE at HEAD, quoted

**(1) §12.5, on DV-18.** The sentence:

> *"`trail_affinity` needs a Trail object — `trails` / `content_trails` /
> `trail_edges` are absent from the repository and from production (§11.3a), so
> this is DV-20's migration, not a Discovery coding task."*

**False as to the repository.** All three relations are created in one committed
migration: `artifacts/api-server/src/migrations/2910_discovery_trails.sql:75#CREATE TABLE public.trails (`,
`artifacts/api-server/src/migrations/2910_discovery_trails.sql:111#CREATE TABLE public.content_trails (`
and `artifacts/api-server/src/migrations/2910_discovery_trails.sql:194#CREATE TABLE public.trail_edges (`.
The clause *"and from production"* remains TRUE — §17.3 records that 2910 is
applied to `portava-ci` only — and that half is what still holds the verdict.

**(2) §12.2, on DV-18.** The sentence:

> *"**W, not C**: `trail_affinity`, `trip_match` and `season_match` have no
> producer on this surface and are named as such."*

**False for `trail_affinity`.** It has a producer and the map to it is in the
tree: `artifacts/api-server/src/lib/discoveryReasonCodes.ts:145#trailAffinity:     "trail_affinity", // PDE (lib/discoveryTrailAffinity.ts)`.
The producerless list is now **two**, not three —
`artifacts/api-server/src/lib/discoveryReasonCodes.ts:113#export const REASON_CODES_WITHOUT_PRODUCER: readonly DiscoveryReasonCode[] = [`
holds `trip_match` and `season_match` only. DV-18 is therefore **7 of 9 grounded,
not 6**, and it **stays `W`** — see §18.5 for why the correction is not a
promotion.

**(3) §16.8, on the width of D11.** The sentence:

> *"`routes/discovery.ts` […] returns `200 {places: [], posts: [],
> total: 0}` from `GET /discovery/feed`'s catch, and […] returns
> `200 {counts: {}}` from `GET /discovery/counts`. … Not taken here."*

(The two line spans §16.8 named are elided with `[…]`: they are a citation form,
they no longer resolve, and repointing a number inside someone else's quotation
would change what the quotation says. The sentence is otherwise verbatim.)

**False at HEAD on both routes.** Both catches now send a refusal:
`artifacts/api-server/src/routes/discovery.ts:2791#classifyRefusal(err, "GET /discovery/feed", "feed_assembly_failed"),`
is the feed's, and `artifacts/api-server/src/routes/discovery.ts:2549#classifyRefusal(err, "GET /discovery/counts", "category_counts_failed"),`
is the counts route's. D11's SERVER half was taken between §16 and this
pass, on twelve call sites in `routes/discovery.ts` and six in
`routes/discoverySearch.ts`. What §16.8 said was not taken is now taken; what it
did not anticipate is that taking it on the server makes the CLIENT the binding
constraint, which is §18.2 and §18.6.

### 18.5 The ranking vector, re-read — a user-dependent input that exists, and is dark

`lib/discoveryModifiers.ts` gained `trailAffinity` and `trendStates`;
`lib/discoveryPde.ts` gained `viewerId` and `trailAffinity` in the ranked feature
vector. The row that describes the ranking inputs is DV-18, and its description
is now wrong in the direction of pessimism — but the correction does **not** move
it, for a reason this document has applied to A01, A05, A07, A10 and A11 already:

`artifacts/api-server/src/lib/discoveryPde.ts:584#trailAffinity: modifiers.enabled ? modifiers.trailAffinity : undefined,`

The term is `undefined` unless `modifiers.enabled`, and `enabled` is
`artifacts/api-server/src/lib/discoveryModifiers.ts:67#export const DISCOVERY_MODIFIERS_FLAG = "discovery_ranking_modifiers_enabled";`,
which §17.3 records as **seeded FALSE**. So on every deployment the vector is
byte-identical to the pre-Trail vector and the term contributes exactly 0.0.

**`W` with a corrected reason, and not `C`.** A user-dependent input that exists
but is flag-dark is built and not realized, which is this census's definition of
`W` and the grading rule's *"FLAG ENABLED IS NOT PRODUCTION REALIZED"*. The old
reason — *no producer* — is retired; the new one is *a producer, a map, a capped
contribution, and a flag that is off*, plus `trip_match` and `season_match`,
which genuinely have neither.

`src/test/discoveryCandidate.test.ts` records the same thing from the other side
(*"`trail_affinity` LEFT this list on 2026-09-14 and must not return to it"*), so
the tree and its test agree; it was only the census that was stale.

### 18.6 Every consumer of the refusal envelope, audited

`GET /discovery/search` and its siblings answer an internal failure with HTTP
**200** plus `refusal: { class, code, coverage }`
(`artifacts/api-server/src/lib/discoveryRefusal.ts:195#export const DISCOVERY_REFUSAL_STATUS = 200;`),
and `sendDiscoveryRefusal` suppresses the serve log for a `coverage: "nothing"`
body, so **no `rank_events` impression row exists for anything inside one**. Two
consequences follow, and the second is the one nobody has been measuring: if a
consumer treats that body as an empty result, the user is told a lie the server
took trouble not to tell, and the exposure denominator and the screen now
disagree about whether anything was served.

Every consumer in the tree, by whether it branches on `coverage`:

| consumer | branches on `coverage`? | verdict |
|---|---|---|
| `travel-buddy-standalone/src/components/discovery/ForYouTab.tsx:273#setSource(osm.ok && osm.data.refusal?.coverage === 'nothing' ? 'refused' : 'none');` | **yes** | Correct. Distinguishes `refused` from `none` and holds bookmarks across a saved-ids refusal. |
| `travel-buddy-standalone/src/components/discovery/DiscoveryCategoryTab.tsx:511#if (nextPage === 1 && res.data.refusal?.coverage === 'nothing') {` | **yes** | Correct, and page-1-scoped so a refused page 2 does not erase page 1. |
| `travel-buddy-standalone/src/hooks/useCommunityDiscovery.ts:197#const refused = result.data.refusal?.coverage === 'nothing';` | **yes** | Correct, and it is the reference implementation: the refusal is surfaced AND kept out of the module cache. |
| `travel-buddy-standalone/src/components/map/MapSearchSheet.tsx:192#!savedRes || !savedRes.ok || savedRes.data.refusal?.coverage === 'nothing';` | **yes** | Correct. This is the one that was already found and fixed. |
| `travel-buddy-standalone/app/search.tsx:229#if (!res.ok) {` | **NO** | **Defect.** The main search screen. A `coverage: "nothing"` refusal is `ok: true, results: []`, so it renders the empty state AND fires the Compass "no results" fallback — offering alternatives to a search that never ran. The one screen `GET /discovery/search`'s envelope was built for is the one that cannot read it. |
| `travel-buddy-standalone/src/hooks/useSearchSuggestions.ts:94#if (res.ok) {` | **NO** | **Defect, and it caches.** See §18.2. This is the consumer C14's `C` rested on. |
| `travel-buddy-standalone/app/map/index.tsx:1137#if (res.ok && Array.isArray(res.data?.places)) {` | **NO** | **Defect.** A refusal takes the `ok` branch with `places: []`, clears the pins, and the screen's own `placesEmpty` then renders "no places here" for an outage. |
| `travel-buddy-standalone/src/services/discovery.ts` — then-line 756, `if (result.status === 'fulfilled' && result.value.ok) {` (`getDiscoveryCategoryCounts`) — DE-POINTERED, see §19.2 | **NO** | **Defect, and it fabricates a number.** The per-category fan-out reads `.data.total` off a refused body and writes `0` into the badge. The BATCH sibling's own doc comment names this exact failure — *"a badge row rendered from it as zeros is a fabricated number"* — and the fan-out neither parses nor propagates `refusal`. |
| `travel-buddy-standalone/src/components/discovery/DiscoveryEventPostsRail.tsx:65#if (res.ok) {` | no, but **safe** | The `coverage` branch is in the service (`sessionId: refusedEverything(refusal) ? null : …`), which is what keeps a refused feed out of the rank-outcome join, and the rail renders nothing at all when `posts` is empty, so it makes no claim of emptiness. Not a defect; recorded so it is not re-found. |
| `travel-buddy-standalone/app/(tabs)/_layout.tsx:368#getDiscoveryCategoryCountsBatch(prefetchCity, 10).catch(() => {});` | n/a | Safe by the service, not by itself: the prefetch discards the result, and `getDiscoveryPlaces` refuses to write a refused body into the client cache. Safe today, and safe for a reason that lives in another file. |

**Four consumers do not distinguish a refusal from an empty answer.** Not one of
them is in this lane's files — `app/search.tsx`, `src/hooks/useSearchSuggestions.ts`,
`app/map/index.tsx` and `src/services/discovery.ts` are all
`travel-buddy-standalone`, which this lane may read and may not write. They are
raised as cross-lane requests in §18.7 with the exact change, not edited.

### 18.7 Does any row grade this? No — and the row that should exist is RECOMMENDED, not invented

`grep` of this census for the obligation returns exactly one row: **C14**, and
C14 is scoped to `/discovery/suggest` (§11.4 maps `11` §9 onto it: *"C14 grades
`/discovery/suggest`'s fail-soft contract — precisely this subject"*).

**No row in this census asserts that a refusal is never served as an empty
result on `GET /discovery/search`, on `GET /discovery`, on
`GET /discovery/counts`, on `GET /discovery/feed` or on
`GET /discovery/community`** — five routes that now emit the envelope and whose
consumers were, until this audit, unmeasured. D11 is recorded as an owner
DECISION (§11.10) and §16.8 noticed it was *"WIDER than recorded"*, but neither
created a row, so the eighteen refusal call sites in the tree are graded by
nothing.

That is a denominator gap, and this lane will not close it by inventing a row.
**Recommended to the owner**, in the shape the other rows take:

> **`DV-83` — `11` §9 / owner ruling D11, the CONSUMER leg.** *"A distinguishable
> response body alone is insufficient if consumers still treat it as successful
> empty data."* Every consumer of a Discovery envelope that can carry `refusal`
> branches on `coverage`, not on `ok` alone; no refused body is written to a
> client cache; and no refused body is rendered as an empty result. Today this
> would be **`W`**: four of ten consumers fail it (§18.6), and the failures are
> concentrated on the highest-traffic screens.

Two cross-lane requests, with the exact change:

1. **To the `travel-buddy-standalone` search owner** — `app/search.tsx`, after
   `if (!res.ok)`: add `if (res.data.refusal?.coverage === 'nothing') { setError('We could not search just now. Tap to retry.'); return; }`
   BEFORE `setResults(newRows)`, so the refusal neither empties the list nor
   triggers the Compass fallback. And in `src/hooks/useSearchSuggestions.ts`,
   guard the `cache.set` on `res.refusal?.coverage !== 'nothing'` and keep the
   previous groups on screen, which is what the hook already does for a transient
   error one branch below. That second change is what C14 needs to return to `C`.
2. **To the same owner** — `src/services/discovery.ts`, `getDiscoveryCategoryCounts`:
   skip a category whose body carries `refusal.coverage === 'nothing'` instead of
   writing its `total` (which is `0` by construction) into the badge map, and
   `app/map/index.tsx`, distinguish the refusal from an empty city before
   `setPlaces([])`.

Neither was made here. `travel-buddy-standalone/src/services/discovery.ts` is
this lane's to READ.

### 18.8 What this pass built — the same defect, arriving through the back door

`GET /discovery/search` carries the refusal envelope precisely so an internal
failure cannot be served as an empty result. `searchPlans` walked around it.

supabase-js **resolves** on a read failure, so `const { data: trips }` with the
`error` dropped made a `trips` outage byte-identical to *"no allowed parent
trip"*: `parents` empty, every plan discarded, and `200 { results: [] }` with no
`refusal` on it. The file's own comment described the defect **in the past
tense** while the code still had it.

This is the branch **production takes**: §6 D3 records that 2420 is unapplied and
`discovery_trip_projection_enabled` (2550) is seeded FALSE, so
`discoveryTripProjectionGate` resolves to `legacy` on every deployment and this
read is the only parent-trip resolution that runs. The projection branch beside
it already refused its own failure explicitly; the legacy branch did not.

Closed at
`artifacts/api-server/src/routes/discoverySearch.ts:1071#if (tripsErr) throw new DiscoverySearchReadError("trips", tripsErr);`,
re-raised through `searchPlans`' own catch, and answered by the route's existing
catch arm as `transient_db` / `search_failed` / `coverage: "nothing"`.

| test | asserts | mutation, and what went red |
|---|---|---|
| **P1** | an unreadable `trips` answers `type=plans` with a refusal, and writes no `rank_events` row | (M1) `void tripsErr` in place of the throw → P1 red: *"no `refusal` on the body — an internal failure is still indistinguishable from a genuine empty result"*. (M3) `searchPlans`' catch swallows the re-raise → P1 red. |
| **P2** (control) | a READABLE `trips` with no admissible parent carries **no** refusal | (M2) throw unconditionally → P2 red. Without P2, a "fix" that stamps a refusal on every empty plans body passes P1 and distinguishes nothing. |

**The control was passing vacuously, and the mutation is what found it.** The
fixture's supabase stand-in had no `.not()`. Both `searchTrips` and `searchPlans`
end their `trips` query with `.not("status", "in", …)`, so every request that
reached either died on `b.not is not a function` inside that function's own catch
arm and returned `[]` — for a reason with nothing to do with the fixture. P1's
first red was that TypeError wearing the right assertion's clothes. `.not()` was
added; mutation **M4** (remove it again) turns P1 red **and nothing else**, which
is the evidence that no other assertion in that file had been resting on it.

**No row moves for this.** There is no row to move: §18.7 is the account of why.

### 18.9 Restated headline

One row moved, `C → W`, and it is in the **67** population — so all three
denominators restate, and each restates differently:

| population | before (§17.5) | after (§18) |
|---|---|---|
| The original 67 | 48 C · 14 W · 5 N · 0 X → 71.6 % correct | **47 C · 15 W · 5 N · 0 X → 70.1 % correct** |
| Cumulative 153 | 68 C · 61 W · 22 N · 2 X → 44.4 % correct | **67 C · 62 W · 22 N · 2 X → 43.8 % correct** |
| Cumulative 187 | 76 C · 85 W · 23 N · 3 X → 40.6 % correct | **75 C · 86 W · 23 N · 3 X → 40.1 % correct** |

> **Discovery, at `2844870a0` + this pass: 187 requirements · 75 BUILT-AND-CORRECT ·
> 86 BUILT-BUT-WRONG · 23 NOT-BUILT · 3 CANNOT-VERIFY → CONSTRUCTED 161 / 187 =
> 86.1 % · CORRECT 75 / 187 = 40.1 %.**
> CONSTRUCTED is **unchanged**: a `C → W` move does not leave the constructed set.
> A defect was closed in this pass and the headline still went down, which is the
> correct behaviour of an honest census and not an anomaly to be explained away.

| BUILT-AND-CORRECT | **75** |
|---|---|
| BUILT-BUT-WRONG | **86** |
| NOT-BUILT | **23** |
| CANNOT-VERIFY | **3** |

75 + 86 + 23 + 3 = 187.

### 18.10 What would turn this red (P24)

- **C14's move is wrong if another consumer of `getSearchSuggestions` exists.**
  The whole move rests on `grep -rn "getSearchSuggestions" travel-buddy-standalone/src travel-buddy-standalone/app`
  returning one non-test call site. A second caller that DOES branch on
  `coverage` would not rescue the verdict (the caching hook would still cache an
  outage), but a caller that replaced the hook would. **Re-run that grep before
  quoting this row.**
- **§18.8's green is a green over a route nothing reaches.** §5's last reading
  stands: thirteen `surface='discovery'` rows ever, latest 2026-08-15. No
  production read was taken here. A refusal that is correct on a dark surface is
  correct and vacuous, and P1/P2 prove a code path, not a served one.
- **The whole §18.6 audit is a grep over one checkout.** A consumer reaching
  these routes from `app/`, from another package, or over a URL this repository
  does not contain is invisible to it. The table is a FLOOR on the defect, not a
  census of consumers.
- **`check:census-freshness` now reports `census-discovery.md` STALE** — along
  with `census-input-intelligence.md` and `census-media.md`, on the same one
  file — and this pass did not silence any of them; see §18.11. Any percentage above is therefore being
  quoted from a census the freshness gate no longer vouches for, which is the
  correct state for a document whose lane just changed a file it counts and
  declined to re-measure all 187.
- **The partition in §18.3 has a 44-row residue.** Forty-four `W` rows were not
  individually re-read. If any of them is closable from code this lane owns, the
  `(a)` count of 2 is too low and the claim *"only two of 111 have no owner,
  migration or decision in front of them"* is false.

### 18.11 Two gates this pass turns red, and neither is fixed from inside this lane

`check:census-freshness` went from **4 problems to 7**, and the jump is larger
than this lane's own census because ONE counted file is counted by four:

```
::error::census-discovery.md is STALE. It declares head_commit 80a8d655, and
1 file(s) it counts have changed since:
    artifacts/api-server/src/routes/discoverySearch.ts
::error::census-input-intelligence.md is STALE. Its acknowledgement covers 1
named file(s), but 1 counted file(s) changed that it does NOT name:
    artifacts/api-server/src/routes/discoverySearch.ts
::error::census-media.md is STALE. Its acknowledgement covers 1 named file(s),
but 1 counted file(s) changed that it does NOT name:
    artifacts/api-server/src/routes/discoverySearch.ts
```

`census-map.md` takes the same file into its unnamed list and was already stale,
so it does not add to the count. **This is worth stating plainly: a one-guard
change inside one function of `routes/discoverySearch.ts` ages three censuses,
and two of them belong to lanes that have no idea it happened.** The file is
shared by Discovery, Global Input Intelligence, Map and Media, and nothing in
the checkout warns an author of that before the edit. It is not a defect in the
gate — the gate is doing exactly its job — it is the cost of a 2,682-line route
module four censuses grade.

The two remedies are (a) re-declare each census's `head_commit`, which requires
re-measuring, and this pass measured 187 rows of one of the four, or (b) entries
in `artifacts/api-server/src/scripts/CENSUS_STALENESS_ACKNOWLEDGED.json` naming
that one path for each affected census. The ledger is not this lane's file, and
two of the three acknowledgements would be arguing the harmlessness of this
change to censuses this lane has not read — which is precisely the argument the
ledger's own header says an acknowledgement must MAKE rather than assume. So the
entry is **requested, not written**, and only for this census, where the
argument can actually be made:

```json
{ "census": "census-discovery.md", "since": "80a8d655",
  "reason": "§18.8 — one guard added inside searchPlans' legacy parent-trip read; every hunk line-count-neutral, no verdict in the 187 depends on it except through §18.2, which is stated.",
  "files": ["artifacts/api-server/src/routes/discoverySearch.ts"] }
```

Leaving it red is the deliberate choice: a stale census that says it is stale is
better than a fresh-looking one that was silenced by a lane editing the
silencing mechanism.

**`check:census-scope-coverage` went from PASS to 1 problem**, and it is the
same ownership boundary from the other side:

```
::error::census-discovery.md watches 95% of the files it cites, below its floor
of 96%. Either add the uncovered paths to CENSUS_SCOPE in checkCensusFreshness.ts,
or — if they are genuinely not what this census grades — say so. Lowering the
floor to pass is the one response that is never right.
```

Measured both ways: **89 cited · 86 watched · 97 %** before this section, **91
cited · 86 watched · 95 %** after. The two files that moved it are the two
refusal consumers §18.6 grades which were not previously in this census's watch
list — `travel-buddy-standalone/src/services/discovery.ts` and
`travel-buddy-standalone/app/map/index.tsx`. The checker offers exactly two
responses and this pass can give neither honestly:

- *"add the uncovered paths to CENSUS_SCOPE"* — `checkCensusFreshness.ts` is not
  this lane's file.
- *"if they are genuinely not what this census grades — say so"* — they ARE what
  it grades. §18.6 finds a defect in each, and §18.7's recommended `DV-83` would
  grade both directly. Saying otherwise to pass a check would be false.

Writing the references as unanchored prose was tried and does **not** help: the
checker resolves basenames, so a file counts as cited however it is spelled, and
the only way to pass is to not name the consumers at all — which would delete
the finding to satisfy the gate. The anchored form is therefore kept, because it
is the stronger evidence and the check fails either way.

**Requested of the integration owner, as one edit:** add both paths to
`CENSUS_SCOPE` for `census-discovery.md`, and extend the acknowledgement entry
above to name all three changed files. That turns both gates green together and
is the state this pass would have left behind if the two files were its own.

### 18.12 What this section did NOT do

- It did not re-read the 44 residual `W` rows, or any of the 75 `C` rows.
- It did not read production. §5's figures are inherited unchanged.
- It did not build B04 or B05, the only two rows it found with no external
  blocker.
- It did not touch `travel-buddy-standalone`, where all four refusal-consumer
  defects live.
- It did not re-declare `head_commit`.
- It did not add the standalone client's `services/discovery.ts` or
  `app/map/index.tsx` to `CENSUS_SCOPE` in `checkCensusFreshness.ts`, which is
  not this lane's file. Both are now things this census grades — §18.6 grades a
  consumer in each — so every reference to them here is written as PROSE rather
  than in `path:line#anchor` form, and their repository-root paths are
  deliberately not spelled. A citation to a file this census does not WATCH
  counts in `check:census-scope-coverage`'s numerator and not its denominator,
  and three of them drop this census from 97 % to 95 % against a 96 % floor
  (measured both ways). **Requested of the integration owner:** add both paths
  to `CENSUS_SCOPE` for `census-discovery.md`, then restore the three citations
  in §18.6 and §18.7 to anchored form. The floor is right; lowering it is the
  one response the checker names as never correct.

---

## §19 — Two of §18's four consumers are closed, and C14 moves back

§18 audited the refusal envelope's ten consumers and found four that render a
refusal as an empty answer. It could not fix them: all four are
`travel-buddy-standalone`, which that lane may read and may not write. The
integrating lane can, and has closed two of the four. This section records what
changed, moves the one row whose stated grounds those changes remove, and says
plainly what is still open.

### 19.1 `useSearchSuggestions` — the consumer C14 rested on

§18's grounds for moving C14 `C → W` were two, both about this hook:

> that caller branches on `ok` alone. It never reads `coverage`. It renders a
> refused `groups: []` as an empty typeahead, and then it **writes the refusal
> into a keyed client cache** … so a single `transient_db` refusal goes on being
> served from the device for the cache TTL with no network call left to notice
> the recovery.

Both are now false at HEAD:

| §18's ground | at HEAD |
| --- | --- |
| "branches on `ok` alone. It never reads `coverage`" | `useSearchSuggestions.ts` computes `res.refusal?.coverage === 'nothing'` and branches on it |
| "writes the refusal into a keyed client cache" | the cache write is skipped on a `nothing` refusal; a `partial` one is still cached, because the groups it carries are real |
| (implied) renders a refused `[]` as an empty typeahead | the panel keeps what was on screen, matching this file's own contract — "the panel never flashes empty mid-typing" — and exposes `refused` so a consumer can say so |

That is precisely the shape §18 itself names as the reference implementation, two
rows above the defect, for `useCommunityDiscovery.ts:197`: *"Correct, and it is the
reference implementation: the refusal is surfaced AND kept out of the module
cache."* The fix was written against that row deliberately, including its
`partial`/`nothing` split.

Proven by `useSearchSuggestions.refusal.component.test.tsx`, 4 cases, RED first
(`Expected number of calls: 3, Received: 2` for the cache; `Expected length: 1,
Received: 0` for the flash), GREEN 4/4, three mutations with no survivors.

### 19.2 `getDiscoveryCategoryCounts` — the fabricated zero

§18's row for this one quoted the guilty line verbatim. **That quotation is now
dead text**: the line it names no longer exists, so `check:doc-citations` refused
the citation — *"the WHOLE anchor appears NOWHERE … the anchor text itself is
wrong"*. A line number can be repointed; a quotation cannot. The §18 row is
therefore DE-POINTERED rather than rewritten — the quotation stays as the
historical record of what the code said, and the parseable `file:NNN#` form is
removed so no gate treats a dead quotation as a live claim.

What changed: the fan-out tested `result.value.ok`, and a refusal is `ok: true`
with `total: 0`, so a category the server never read contributed a real zero and
the badge said "0". It now omits a `coverage: "nothing"` category entirely —
an absent key being the only honest value that return type can carry — and still
reports a `partial` one, whose total is a real count over real rows.

Proven by four new cases in `discovery.refusal.component.test.tsx`, RED first
(`expect(received).toBeUndefined() / Received: 0`), GREEN 36/36, three mutations
with no survivors.

### 19.3 Row move

| **ID** | **was** | **now** | why |
| --- | --- | --- | --- |
| **C14** | **W** | **C** | §18 moved it to `W` on two named grounds about `useSearchSuggestions`, and §19.1 shows both are false at HEAD. The sole consumer of `getSearchSuggestions` now reads `coverage`, declines to cache a `nothing` refusal, and declines to render it as an empty panel — the three properties §18 graded `useCommunityDiscovery` `yes` for. Graded on this census's own §17.2 standard, which refused `C` for a field "whose only consumer ignores it": the only consumer no longer ignores it. |

### 19.4 THE CONFLICT OF INTEREST, STATED

**I wrote the fix and I am grading it.** §18 was written by a lane that could not
touch these files, which is what made its `W` credible. This `C` does not have
that separation, so the grounds are stated as a table of its own falsifiable
claims rather than as a judgement, and §19.5 names what turns it red.

The most contestable part: **no SCREEN renders `refused` yet.** The hook exposes
it and `useGlobalSearchSuggestions` forwards it, but nothing draws a "could not
reach search" state. A reader who holds that C14's consumer half is not closed
until a user can SEE the difference should move this row back to `W`, and that
reading is defensible — §19.1's table would still be true, and the row would still
be `W` for a different and narrower reason than §18's. I took `C` because §18
stated its grounds precisely and those exact grounds are gone, and because the
row it graded `yes` as the reference implementation (`useCommunityDiscovery`)
also only surfaces a boolean.

### 19.5 WHAT WOULD TURN THIS RED

- **A screen rendering a refusal as "no matches".** The two screens §18 found are
  still unfixed (below); if either is judged part of C14's consumer half, the row
  is `W` again.
- **`useGlobalSearchSuggestions` dropping `refused` again.** It forwards the field
  today and returns `false` on the gateway path by construction; a future edit that
  drops it re-breaks the chain one layer above the fix, and no test above the hook
  would notice.
- **The `partial` carve-out being wrong.** Both fixes cache and report a `partial`
  refusal on the ground that its payload is real. If a `partial` body is ever
  emitted with padding rather than rows, both fixes admit a fabrication.
- **The standing one.** This is a BRANCH census. Nothing here is merged, deployed
  or flag-enabled, and §5's reading — 13 `surface='discovery'` rows ever, latest
  2026-08-15 — is unrefreshed. These are fixes on a surface nobody has been shown
  to reach.

### 19.6 STILL OPEN — the other two consumers

Unfixed, and named so they are not reported as closed:

- `travel-buddy-standalone/app/search.tsx:229#if (!res.ok) {` — the main search
  screen renders the empty state AND fires the Compass "no results" fallback for a
  search that never ran.
- `travel-buddy-standalone/app/map/index.tsx:1137#if (res.ok && Array.isArray(res.data?.places)) {`
  — clears the pins and renders "no places here" for an outage.

Neither is touched here. §18's count of four stands as the count that was found;
two of the four are closed and two are not.

### 19.7 The headline, restated from a fresh dump

`check:census-integrity` refused the move until the headline followed it:

> `::error::census-discovery.md: its stated headline is C 75 / W 86 / N 23 / X 3 but its own rows count C 76 / W 85 / N 23 / X 3. Both sum to 187, so this is not an arithmetic slip — it is a headline that stopped describing the table underneath it.`

Restated by re-running `CENSUS_INTEGRITY_DUMP=ALL`, not by adding one to §18's
figure — the distinction that error message exists to enforce:

| Measure | 187-population |
| --- | --- |
| BUILT-AND-CORRECT | **76** |
| BUILT-BUT-WRONG | **85** |
| NOT-BUILT | **23** |
| CANNOT-VERIFY | **3** |

CONSTRUCTED **86.1 %** (unchanged — C14 moved within the built set), CORRECT
40.1 % → **40.6 %**.

The other two populations move with it, since C14 is in the 67: 67-population
**48 / 14 / 5 / 0**, 153-population **68 / 61 / 22 / 2**.

§18 took CORRECT from 40.6 % to 40.1 % by finding a defect; §19 takes it back by
fixing it. The number returning to where it started is not the census going in
circles — it is one row that was wrong, found, and closed, and the two sections
together are the record of which.

---

## §20 — All four of §18's consumers are closed

§19 closed two and named two. Both of the two are now closed as well, so §18's
finding is fully discharged. No verdict moves here: C14 already moved in §19, and
neither remaining screen is graded by any row — which is itself the finding §18.2
recorded and which this section does not pretend to fix.

### 20.1 `app/search.tsx` — the fallback that answered an unasked question

§18 called this the worst of the four, and the reason is that it did TWO things:

> it renders the empty state AND fires the Compass "no results" fallback —
> offering alternatives to a search that never ran

The empty state SAID nothing matched; the Compass fallback then ACTED on that
claim, spending a second network call and a section of screen. The screen's own
code described the behaviour without seeing it — *"No results for any query —
always fire Compass fallback regardless of active intent/chips"*.

A `coverage: "nothing"` refusal now takes the screen's existing `error` branch,
which already carries a "Tap to retry" affordance. No new UI state was invented:
a refusal is a failure that succeeded in transport, and retry is the right offer
for a `transient_db`.

RED first, verbatim — `Expected number of calls: 0 / Received number of calls: 1
/ 1: {"city": "Manila", "limit": 6, "q": "coffee", "surface": "search"}`. GREEN
4/4. Three mutations, no survivors; the one worth keeping is **M3**, which kept
`setError` but dropped the `return`: it killed only the fallback case, proving the
`return` is behaviour rather than punctuation — a fix that merely set the message
would still have spent the call and drawn the alternatives underneath it.

### 20.2 `app/map/index.tsx` — the error that had to be erased

> A refusal takes the `ok` branch with `places: []`, clears the pins, and the
> screen's own `placesEmpty` then renders "no places here" for an outage.

The test it passed was `if (res.ok && Array.isArray(res.data?.places))`, and a
refusal satisfies both halves **honestly**: it really is `ok: true`, and its
`places` really is an array — an empty one, because the server never read the
table. There was nothing malformed to catch.

**Clearing the error is what did the damage**, and that is the part worth
recording. `placesEmpty` is `… && !placesError && legacyPlaces.length === 0`, so
`setPlacesError(null)` on the success path is precisely what switches the
zero-results state ON. The outage did not merely lose the pins: it asserted that
the area has nothing in it, and it had to erase the evidence to do so.

RED first: `Expected: "false" / Received: "true"`. GREEN 12/12 — four new cases
beside the eight the file already had, none of which changed. **M3** again is the
one that matters: keeping the branch but leaving `placesError` null killed both
outage cases, proving the fix is the error being SET, not the branch existing.

### 20.3 What is NOT closed by this

- **No row grades either screen.** §18.2 recorded that five routes and eighteen
  call sites emit the envelope and are graded by nothing, and recommended `DV-83`
  rather than inventing a row. That recommendation stands unactioned. These two
  fixes are therefore ungraded by construction: if they regress, the suites fail,
  but no census verdict changes.
- **Nothing is rendered about `partial`.** All four fixes carry `partial` through
  as real data, which is right, but no screen tells a viewer that part of an
  answer is missing. `failedSources` exists on the envelope and nothing reads it.
- **`type=all` still folds a plans failure to `[]`** through `Promise.allSettled`
  in `searchAll`. Only `type=plans` refuses today. Named in the Discovery lane's
  own hand-over and still open.
- **The standing one.** Nothing here is merged, deployed or flag-enabled, and §5's
  reading — 13 `surface='discovery'` rows ever, latest 2026-08-15 — is unrefreshed.
  Four fixes on a surface nobody has shown to be reached.

### 20.4 WHAT WOULD TURN THIS RED

- **A fifth consumer.** §18 audited ten and found four. The audit was a grep over
  one checkout; a consumer reaching these routes from another package or over a
  URL not in this repository is invisible to it. Four is a floor, not a census.
- **The `partial` carve-out.** All four fixes admit a `partial` body as real data.
  If `partial` is ever emitted with padding rather than rows, all four admit a
  fabrication at once — a single shared assumption across four files, which is
  the kind of thing that is cheap to write and expensive to be wrong about.
- **A screen that renders `refused` as "no matches" anyway.** The hooks expose it;
  nothing forces a consumer to read it.

---

## §21 — The three things §20.3 said it had not closed

§20.3 listed what four consumer fixes left standing. Three of its four bullets
are closed here. They turned out to be one defect with three faces, and the
order matters: the server could not have been half-honest in a way any screen
could render, because it was not being half-honest at all.

### 21.1 `type=all` folded a failed bucket into the answer

§20.3, verbatim: *"**`type=all` still folds a plans failure to `[]`** through
`Promise.allSettled` in `searchAll`. Only `type=plans` refuses today."*

`DiscoverySearchReadError` exists for one reason — supabase-js RESOLVES on a
read failure, so a discarded `error` never throws, never reaches the route's
catch arm, and never becomes a refusal; throwing a named error is how such a
read re-enters the front door the envelope guards. §18 built it and D11's P1
pins it for `type=plans`.

`type=all` never goes through that arm. The fan-out collapsed every rejected
bucket in one line, and `Promise.allSettled` caught the named error before the
route could see it. So the DEFAULT type — what the global search bar actually
sends — answered `200 { results: [...] }` with a silently missing bucket and no
refusal key, and the `[]` it merged in was byte-identical to a bucket that was
read and matched nothing. That is `11` §9's masquerade on the busiest path,
arriving through a door the fix for it did not cover.

The 17 buckets are now named (`routes/discoverySearch.ts:2212#const FAN_SOURCES = [`),
a rejected one is collected rather than collapsed
(`routes/discoverySearch.ts:2267#const unreadableSources: string[] = [];`), and the
route answers with `refusal.failedSources`. Coverage is `partial` whenever ANY
source answered — including when the page itself is empty, because the buckets
that were read are a real result and their emptiness is trustworthy — and
`nothing` only when all 17 failed
(`routes/discoverySearch.ts:2493#unreadableSources.length === FAN_SOURCES.length ? "nothing" : "partial",`).
The serve log still runs on a partial: those items really were served, and
dropping them under-counts exposure in the other direction.

Failing first: `test/discoveryRefusalD11.test.ts:606#it("P3 — type=all refuses PARTIAL when a bucket's read fails, instead of a silently short list",`,
red before the change with the served row and the missing `refusal` key both
recorded in the assertion message. `test/discoveryRefusalD11.test.ts:794#it("P4 — type=all over readable tables carries NO refusal (control)",`
is the control and is as load-bearing: with every table readable the same
request must carry NO refusal, so a fix that stamps a partial on every fan-out
response does not pass. 40/40 in that suite; 166/166 across the seven other
discovery/search suites.

### 21.2 Nothing rendered `partial` — and one screen rendered `refused` as "no matches"

§20.3's second bullet and §20.4's third hazard were the same gap seen from two
sides: *"no screen tells a viewer that part of an answer is missing"*, and *"A
screen that renders `refused` as 'no matches' anyway. The hooks expose it;
nothing forces a consumer to read it."*

Nothing forced it, and nothing did it. §19 gave `useSearchSuggestions` a
`refused` flag and §20 forwarded it, and `app/search.tsx` destructured `groups`,
`actionSuggestions`, `loading` and `recordPick` and dropped it. So on the FIRST
query of a session — a refusal with no earlier groups to hold —
`SearchSuggestionsPanel` found `hasAny` false and printed *"No quick matches yet
— keep typing, or search everything."* A claim about the corpus, made on the
server's behalf, when the server never reached the table. The careful flag made
no difference to anything a user could see.

The panel now takes `refused` (`SearchSuggestionsPanel.tsx:82#actionSuggestions, onPickAction, refused = false,`)
and says the read failed instead (`SearchSuggestionsPanel.tsx:172#Suggestions are unavailable right now`),
including when held groups ARE on screen, because those groups are the previous
query's answer and nothing refreshed them.

And §21.1 created a body this screen had never seen: `coverage: "partial"` with
an EMPTY page. `app/search.tsx` closed that gap with *"No results found. /
Nothing matched «q»."* — true of sixteen sources and unknown of the
seventeenth. It now carries the failed source names
(`app/search.tsx:117#const [partialSources, setPartialSources] = useState<string[] | null>(null);`)
and says the search was incomplete (`app/search.tsx:650#Some of this search could not run.`).
The Compass fallback is deliberately LEFT firing: it offers alternatives, it
does not assert an absence, and suppressing it would delete a feature rather
than fix a claim.

Failing first, both: `SearchSuggestionsPanel.refusal.component.test.tsx:97#it('OUTAGE, first query: does not print "No quick matches yet" when the server did not look',`
(5 cases, 2 red before the change, 3 controls green throughout) and
`search.refusal.component.test.tsx:279#it('OUTAGE with no rows: a PARTIAL refusal does not claim that nothing matched',`
(with a control asserting a genuinely empty result must STILL say nothing
matched, so suppressing the sentence unconditionally does not pass).

### 21.3 Row moves

**None.** Restated from a fresh `CENSUS_INTEGRITY_DUMP=ALL` at this tree rather
than inherited: 187-population **76 C / 85 W / 23 N / 3 X**, CONSTRUCTED 86.1 %,
CORRECT 40.6 %; 67-population **48 / 14 / 5 / 0**; 153-population
**68 / 61 / 22 / 2**.

The reason there is no move is the reason §20.3 gave and §18.2 gave before it:
**no row grades either screen, and no row grades the fan-out.** Five routes and
eighteen call sites emit the envelope and are graded by nothing. §18.2
recommended a `DV-83` for it and deliberately did not invent one. That
recommendation is now three sections old and still unactioned, and every pass
since has closed a real defect that no verdict could record. A census that
cannot move when a defect is fixed is not measuring that defect.

### 21.4 WHAT WOULD TURN THIS RED

- **A bucket that fails without rejecting.** §21.1 names the 17 sources that can
  REJECT. A per-type searcher that swallows its own error and returns `[]` — the
  original defect, in the shape all 17 had before §18 — is still invisible to
  the fan-out, which can only see a rejection. `check:writerless-reads` does not
  look at this, and only `searchPlans` and `searchTrips` are known to re-raise.
- **`FAN_SOURCES` drifting out of order.** The names are positional: they map to
  the `settled` array by index and nothing checks that they still line up. Insert
  a source in the middle of the fan-out without inserting its name and every
  refusal after it names the wrong table — a wrong answer that looks exactly like
  a right one.
- **`partial` with padding.** §20.4 named this and it is now worse, not better:
  four consumers admitted a partial body as real data, and §21 adds two screens
  that render a sentence about it. If `partial` is ever emitted with padding
  rather than rows, six files admit a fabrication at once.
- **The empty partial reading as an outage.** `app/search.tsx` now shows the
  incomplete-search copy whenever `partialSources` is set and the page is empty.
  Sixteen readable sources that genuinely match nothing plus one dead bucket
  produce that state, and a reader could take it as "search is broken" when the
  honest reading is "search is one-seventeenth incomplete". The copy says which
  it is; nothing enforces that it keeps saying so.

### 21.5 What is NOT closed by this

- **`DV-83` is still not invented.** §18.2 recommended it, §19, §20 and §21 each
  declined to invent a row while closing defects it would have graded. Four
  passes is where a recommendation stops being pending and starts being a
  decision nobody made.
- **§20.3's fourth bullet stands unchanged.** Nothing here is merged, deployed or
  flag-enabled, and §5's reading — 13 `surface='discovery'` rows ever, latest
  2026-08-15 — is unrefreshed. Six fixes now, on a surface nobody has shown to be
  reached.
- **The 44 `W` rows §18.3 records as not individually re-read** are still not
  re-read, and the nine rows §18 put in a seventh bucket still need a production
  read.

---

## §22 — §21.4's first hazard was already true when §21.4 was written

§21.4 opened with what would turn §21 red:

> **A bucket that fails without rejecting.** §21.1 names the 17 sources that can
> REJECT. A per-type searcher that swallows its own error and returns `[]` — the
> original defect, in the shape all 17 had before §18 — is still invisible to
> the fan-out, which can only see a rejection. `check:writerless-reads` does not
> look at this, and only `searchPlans` and `searchTrips` are known to re-raise.

The last clause was false. `searchTrips` did not re-raise, and neither did ten
others. A hazard written as a future risk was a present defect, and the thing
that noticed was not a re-reading — it was §21's own test.

### 22.1 A control assertion found it

P3 pinned `failedSources` EXACTLY rather than with `includes`, because
FAN_SOURCES maps to the settled array by index and nothing else checks the
names still line up. An unreadable `trips` fails the plans bucket through its
parent-trip read AND the trips bucket through its own, so the expectation was
`["trips", "plans"]`. It got `["plans"]`.

`searchTrips` ended its legacy read with `if (error || !data) return [];` — the
exact line §18 removed from the plans path. A grep for that line found TEN
more, one in every remaining per-type searcher: `searchTravelers`,
`searchEvents`, `searchPlans`' own item read, `searchPlaces`,
`searchHiddenGems`, `searchHashtags`, `searchPosts`, `searchCircles`,
`searchStamps` and `searchActivities`.

All twelve are one defect. supabase-js RESOLVES on a read failure, so `error`
is an outage and `[]` is what a query that matched nothing returns — the two
answers byte-identical, through the back door of a destructure rather than the
front door the refusal envelope guards. Each site now throws
(`routes/discoverySearch.ts:940#if (error) throw new DiscoverySearchReadError("trips", error);`
and eleven siblings) and keeps the empty answer for `!data`, which is a shape
anomaly and not a failed read. Each function's catch re-raises only that named
type, so everything it already swallowed it keeps swallowing.

### 22.2 The suggest fan-out had `searchAll`'s back door as well

`dispatchSearch(...).catch(() => [] as SearchResult[])`. Fourteen types in
parallel, and a REJECTED one became an empty group — indistinguishable from a
type that was read and matched nothing. A typeahead could lose an entire
category to an outage and answer `200 { groups: [...] }` with no refusal on it,
on the surface that fires on every keystroke.

It now collects the failed types by PLAN INDEX
(`routes/discoverySearch.ts:2715#const unreadableAt = new Array<string | null>(plan.length).fill(null);`)
so the names come out in plan order however the parallel reads finish, and
answers `suggest_sources_unreadable`
(`routes/discoverySearch.ts:2760#suggest_sources_unreadable`),
`partial` while any type answered. §19's `useSearchSuggestions` already renders
and caches a `partial` and refuses to cache a `nothing`, which is exactly the
split this needs — the consumer fix landed three sections before the producer
that would exercise it.

### 22.3 Failing first, measured rather than asserted

The new cases were run against this work's parent in a throwaway worktree. **12
RED there** — P3, P5, S1 and nine of the ten P8 failure cases — and every one
of the ten CONTROLS green in BOTH trees, which is the whole difference between
"throw on error" and "throw on everything". 64 pass / 1 skipped in
`test/discoveryRefusalD11.test.ts:716#const SWALLOWED`; 572/572 across the
twenty suites that mount this router.

**The skip is a gap, not a pass.** `type=travelers` reads `profiles`, and so
does `requireUser`, so `errorTables: ["profiles"]` answers 503 from the auth
middleware before the route is entered — this harness errors a table for the
whole request and cannot fail one read of `profiles` and not the other. Its
CONTROL runs. Its re-raise is fixed by the same edit as the other nine and is
verified by NOTHING. Nine of ten, not ten.

### 22.4 Row moves

**None**, and for the same reason as §21.3: no row grades the fan-out, and
`DV-83` is still not invented — now through five passes. 187-population
**76 C / 85 W / 23 N / 3 X**, CONSTRUCTED 86.1 %, CORRECT 40.6 %, restated from
a fresh `CENSUS_INTEGRITY_DUMP=ALL` at this tree; 67-population
**48 / 14 / 5 / 0**; 153-population **68 / 61 / 22 / 2**.

Twelve swallowed outages on the busiest read surface in the product were fixed
and not one verdict in this census can say so. That is the fifth consecutive
section for which that sentence is true.

### 22.5 WHAT WOULD TURN THIS RED

- **A thirteenth swallow.** The grep that found these eleven matched one exact
  line, `if (error || !data) return [];`. A site spelled `if (error) return [];`
  or `if (!data || error) return [];` or one that checks `data?.length` is not
  in that set, and nothing in this repository greps for the CLASS. The number
  twelve is what one string found, not a census of the file.
- **`canonicalCentroids` is untouched.** It ends `if (error || !data) return out;`
  — same shape, different return, and it was left alone because it accumulates
  into a caller's map rather than answering a type. That is a judgement, not a
  proof, and it is recorded here so it can be overturned.
- **The projection branch of `searchTrips`.** When
  `discoveryTripProjectionGate` resolves to `projection`, an unavailable
  projection still logs and returns `[]` — "trips search returns nothing" in its
  own words. §6 D3 says production takes the legacy branch, so this is not the
  live path today; the day 2420 is applied it is, and the fix above does not
  reach it.
- **`type=travelers` on a real outage.** Verified by nothing. See §22.3.
