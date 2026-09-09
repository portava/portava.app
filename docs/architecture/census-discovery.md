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
| `head_commit` | `090684ab54489d23707a0fd5e3f8ed661072a34f` (`git rev-parse HEAD`) |
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
| A08 | GII `:8` — *"This is not owned by Discovery… Those surfaces consume it through a shared platform layer"*; `:7` core rule; census-input-intelligence G6 — *"four independent engines are still live and unmigrated"* | **W** | **Measured: Discovery owns ONE of the four.** The four G6 engines are `travel-buddy-standalone/src/hooks/useSearchSuggestions.ts` (→ `GET /api/discovery/suggest`, Discovery's), `hooks/useGooglePlacesAutocomplete.ts` (→ `/api/places/google-autocomplete`, Places), `hooks/usePlaceSearch.ts` (→ `/api/places/search`, Places) and `components/MentionInput.tsx` (mentions). Server side, `routes/discoverySearch.ts:2006` `/discovery/suggest` is **not a parallel matcher** — it calls the same `dispatchSearch` (`:1593`) the gateway calls (`lib/inputAssistance/gateway.ts:27,384`) — but it *is* a second route, and the client runs it **on every keystroke in parallel with the gateway** as a deliberate fallback: `hooks/useGlobalSearchSuggestions.ts:10-12` — *"The legacy hook ALWAYS runs and is the fallback — its proven behavior is never removed"*; `app/search.tsx:24,154` consumes that wrapper. Two requests per keystroke, one canonical path. **Not closed here**: the consolidation is a client change (stop invoking the legacy hook when the gateway is `available`), it removes a fallback users currently have, and the server route cannot be retired while the fallback references it. Owner decision (§6 D1). |
| A09 | Trips `:12` — *"No Map, Compass, Telegraph, Discovery, Buddy, or UI component may independently invent canonical trip state"* | **C** | Every `.from(...)` literal in `routes/discovery.ts` enumerated: `discovery_places` ×8, `discovery_place_saves` ×3, `discovery_place_reports`, `place_votes`, `places`, `profiles` ×2, `reviews`, `collections`, `collection_items`, `user_location_state` — no `trip*` table; `routes/discoverySearch.ts:772,838` read `trips` / `trip_plan_items` with `.select` only; **zero `.rpc(` calls** across `routes/discovery*.ts` and `lib/discovery*.ts`. Caveat recorded per `scripts/checkWriterlessReads.ts:39-41`: a literal grep is a floor; no dynamic `.from(expr)` was found in these files either. |
| A10 | Trips `:25`, `:488` — *"Map, Compass, Discovery… consume explicit Trip projections/contracts rather than duplicating Trip semantics"* | **W** | **Stays W; its REASON is superseded — recensused 2026-09-08.** The row said *"No `TripDiscoveryProjection` exists … Not closable from Discovery: the projection is Trips' to publish"* and filed it as owner decision D3. Both halves are now false. **The projection exists and Trips publishes it**: `lib/tripDiscoveryProjection.ts:225#searchTripDiscoveryProjections` and `:252#readTripDiscoveryProjections`, over `TRIP_DISCOVERY_SOURCE_COLUMNS` (`:136#TRIP_DISCOVERY_SOURCE_COLUMNS`). **Discovery consumes it**: `lib/discoveryTripProjectionConsumer.ts` — the switch, the §19.1 acceptance check and the card mapping, wired into both search paths at `routes/discoverySearch.ts:822#discoveryTripProjectionGate` (trips) and `:948#discoveryTripProjectionGate` (plans). **Why it is still W, and why that is a DIFFERENT kind of open than before:** the consumer is behind a CAPABILITY, not a bare flag — `capability = discovery_trip_projection_enabled (migration 2550, seeded FALSE) && SCHEMA_CAPABILITY_READY`, because `TRIP_DISCOVERY_SOURCE_COLUMNS` ends in `trips.version` which migration 2420 adds and production does not have. Both projection readers fail CLOSED on a resolved `.error`, so an ungated switch would turn every production trip search into `[]` on a 42703, silently. Until 2420 is applied and the flag lit, the LIVE path is still the duplication this clause forbids (`routes/discoverySearch.ts:847#show_in_discovery`, `:976#show_in_discovery`). **So this moved from an OWNER-blocked row to a DEPLOYMENT-gated one** — nothing here is waiting on a decision any more, and D3 in §6 is discharged. |
| A11 | Trips `:185` — *"Discovery, Compass, Saved Ideas, and Buddy matching consume these [Temporal Freedom] windows rather than independently calculating 'free time'"* | **N** | `FreedomWindow`: zero occurrences (census-trips TR131 N). Discovery's own arithmetic: `lib/portavaRank.ts:86` (`availableMinutes` — *"Minutes of free window (layover mode / availability) — actionability cap"*) and `:245-248` (*"must start within the window"*). No engine to consume. |
| A12 | Trips `:175` — *"Public Trip content must not leak lodging detail, exact private location, future absence from home, safety state, or unconsented participant data"* — the Discovery leg | **C** | `routes/discoverySearch.ts:770` selects `id, title, destination_city, destination_country, owner_id, cover_url, start_date, status, visibility, created_at` — no lodging, no coordinates, no safety column, no participant list — and only public rows (`:772`). Recorded, not hidden: `start_date` + destination on a public trip is a Trips-domain public field; whether that is "future absence" is a Trips ruling (census-trips settled only the lodging clause, TR117). |
| A13 | Layover `:66` — *"All surfaces consume the same certified LayoverSnapshot / RecommendationContract; no duplicate time-budget logic"*; `:803` — *"One canonical LayoverSnapshot drives Trips, Compass, Discovery, Map and Safe Return"* | **N** | `LayoverSnapshot`: zero occurrences. `grep -rIn -i layover routes/discovery*.ts lib/discovery*.ts` → nothing; Discovery has no layover reference at all. The duplicate time-budget logic named in L-02 is A11's `portavaRank.ts:86,245`. |
| A14 | Layover §25 `:754` — *"Discovery: Only show experiences from certified action universe in Layover mode"* | **N** | Discovery has no Layover mode. The nearest artefact is `routes/hiddenGems.ts:599-631` `GET /hidden-gems/layover-safe` — a Hidden Gems route, flag-gated, taking `availableMinutes` **from the query string** (`:613`) rather than from any session, and per census-layover L269 never called by the layover dashboard. |
| A15 | Passport `:57` — *"Do not create separate profile systems for self, public, Trips, Buddy, Discovery or Telegraph. Build one Passport projection system with context-specific views"* | **W** | Half satisfied since the census-passport pass: the person **card** is the assembler's (A16). The search **list** still assembles its own identity payload from `profiles` — `routes/discoverySearch.ts:529` selects `id, handle, username, name, avatar_url, is_private, home_city, home_country, …` and `:598-640` applies its own privacy logic (locked preview, `show_profile_picture_publicly`, name rule). Rules agree with the assembler's today; the construction is the duplication `services/passport/PassportConsumerProjections.ts:6-14` says it exists to end. Not closed: routing every list row through `buildConsumerProjection` is N+1 assembler calls per search and a response-shape change on a live route. Owner decision (§6 D4). |
| A16 | Passport §21 `:213-214` — Discovery variant: *"Identity, verification, availability, Open to Plans, shared context, permitted trust summary"* | **C** | `routes/discoverySearch.ts:2126-2160` `GET /discovery/people/:userId/passport` → `allowDiscoveryPersonCard` (`:2147`) → `buildConsumerProjection(sc, "discovery_card", …)` (`:2151`). **Supersedes census-passport P95 (W — "Nothing calls it")**: it is called, from Discovery, by the route that opens a search row. |
| A17 | Passport `:263` — *"A Passport block must propagate across Discovery… Do not implement blocking independently per surface"*; Telegraph `:285` — *"No subsystem may independently 'rediscover' a blocked relationship"* | **W → C (fixed this pass)** | **Was:** `routes/discoverySearch.ts` carried a byte-for-byte private copy of `lib/blocks.fetchBlockedSet` (the old `:371-388`), while `lib/inputAssistance/gateway.ts:23`, `socialIdentity.ts:27` and `routes/discovery.ts:50` used the shared one — two copies of the bidirectional, fail-closed block reader, agreeing until one is edited. **Now:** `routes/discoverySearch.ts:82` imports it and `:386` re-exports it; `test/discoverySearchBlockedSubmitter.test.ts` pins source *and* function identity (`discoverySearch.fetchBlockedSet === blocks.fetchBlockedSet`). Behaviour byte-identical (same query, same null-on-error). Hand-revert: re-adding the copy → 1 failure (§7). |
| A18 | Passport `:94` — *"Compass and Discovery should weight explicit current intent more heavily than generic interests"* | **N** — owner hold | Supply side exists (`PassportConsumerProjections.ts:106,187,211` expose explicit intent on the card). Demand side: no intent term in `lib/discoveryPde.ts` / `lib/discoveryModifiers.ts` (headers enumerate the inputs; census-passport P42 confirms *"nothing consumes it"*). Cross-cutting P-05 was COULD NOT ESTABLISH; it is now established absent. Ranking machinery → same hold as A01. |
| A19 | Telegraph `:285` — block cascade, the *discovery* leg | **C** | Every Discovery reader applies the shared rule: search/suggest via `fetchBlockedSet` (`:1793,1982`) and `submitterIsVisible` (`:82`); `GET /discovery` and `/discovery/community` via `routes/discovery.ts:50,879,2654`; the person card inside the assembler. Pinned by `test/discoverySearchBlockedSubmitter.test.ts` (12) and `test/discoveryBlockedSubmitter.test.ts` (25), including the *unreadable-blocks-yields-nothing* cases. |
| A20 | Telegraph `:606` — *"Every shareable Portava domain registers preview, authorization, current state, actions, search behavior, and revocation through a Telegraph content capability contract"* | **N** | `TelegraphSharedContextProjection` / `contentCapability` / `content_capability`: zero occurrences repo-wide. `grep -i discovery routes/messaging.ts routes/telegraph.ts` → nothing: the Discovery card that can be shared (`travel-buddy-standalone/src/components/DiscoveryCardMessage.tsx`) is a client-only rendering with no server-side preview/authorisation/revocation contract. Blocked on Telegraph publishing the contract shape (census-telegraph §30.16). |
| A21 | Telegraph `:607` — each source domain registers *"authorize, preview, execute, and optional compensate"* | **N** | Same absence as A20; no registration mechanism exists to register into. |
| A22 | Telegraph `:87` — *"Availability expires automatically and revokes across Telegraph, Discovery and Compass"* | **C** | The only availability Discovery emits is the person card's (`DiscoveryCardAvailability`, `PassportConsumerProjections.ts:204`), built from `loadVisibleActiveWindows(sc, ownerId, context, nowMs)` (`:468,509`) — active windows re-evaluated against the read clock, never a stored copy. The search list carries no availability field (`:529` select), so there is nothing there to revoke. |
| A23 | Telegraph `:621` — *"Unavailable… revokes Nearby, Discovery, and Compass availability projections promptly"* | **C** | Same path as A22: an ended or cancelled window is not an active window at `nowMs`. |
| A24 | Telegraph `:621` — *"…or Invisible revokes… Discovery… availability projections"* | **N** | census-telegraph T29: *"No invisible mode."* `grep -i invisible services/passport/PassportConsumerProjections.ts` → nothing. There is no Invisible state anywhere for Discovery to honour; owed first by Telegraph. |
| A25 | Map `:11`, §20 `:202-203` — Discovery owns *"Candidate relevance"*; the Map consumes projections from each owner | **N → W (Discovery half built; Map half absent)** | **Was:** no Discovery reader existed for the Map gateway to call (`routes/mapProjection.ts:14-27` lists travelers / gems / events / circle / trips). **Now:** `lib/discoveryCandidate.ts:236-268` `readDiscoveryCandidatesForViewer(sc, places, viewerId, city)` — the privacy-complete owner reader Map §20 expects: it **does not retrieve** (the Map hands it rows it already holds), ranks with `served: false` so the ranker gets a client that cannot write (pinned: a recording fake sees zero insert/upsert/update/delete/rpc), and an anonymous viewer gets `rankedBy: "none"` with no client touched. Precondition stated, not assumed: rows are already block-filtered. **Why W:** it has **no consumer** — the Map gateway is another agent's file (§6 D10) — and a reader nobody reads is, per `ROADMAP.md`'s fourth face, not yet a signal. |

### 2b. Rows shared with the Global Input Intelligence census (B)

| # | GII row | Verdict | Evidence |
|---|---|---|---|
| B01 | G57 — diacritic-insensitive matching, the **stored** side | **W** — deployment | Code is correct (census-input-intelligence G57). **Re-verified 2026-09-07: `canonical_locations.search_key` is absent from production** (`information_schema.columns` → 0), so migration 2220 is still unapplied and the fold degrades to the broken `normalized_name` in production. Operator apply, not a code change; the owning module is `lib/canonicalLocations.ts`, outside this pass's files. |
| B02 | G62 — punctuation/emoji handling appropriate to field | **W** | `routes/discoverySearch.ts:114-116` `sanitizeQuery` strips only `(),`; an emoji survives into the `ilike` pattern and matches nothing. Not changed: stripping emoji would make `"🔥 bar"` start matching `bar` — a user-visible result change on a live route with no flag. Owner decision (§6 D5). |
| B03 | G71 / G283 — Buddy: *"service category, availability, launch/safety/payment eligibility"* | **W → partially closed** | **Was:** the only buddy predicate was `buddy_verified_at IS NOT NULL` (`:535`), with the marketplace master switch `rent_buddy_enabled` (**false in production**) never consulted. **Now:** the **launch** leg is built — `routes/discoverySearch.ts:468-472` `buddiesWithheldByLaunchGate`, applied at `:524` inside `searchTravelers(isBuddy)` so the gateway inherits it — behind `discovery_buddy_launch_gate_enabled` (migration 2360, **seeded FALSE**, applied to CI; rollback `db/rollback/2026-09-07-2360-discovery-buddy-launch-gate-rollback.sql`). Both reads fail-closed in the safe direction each (gate unreadable → legacy; marketplace unreadable → withheld). 8 tests; two hand-reverts → 2 and 5 failures (§7). **Still open:** category and availability legs — a buddy row carries no service category to filter on and the list has no availability field. Stays W. |
| B04 | G190 — sensitive-location and protected-place rules before projection | **W** | The gem rule is real (`:1028` selects `sensitivity_level, approx_latitude, approx_longitude`, exact pair deliberately absent). `lib/protectedLocations.ts` is consulted by nothing in `routes/discovery*.ts` / `lib/discovery*.ts` (grep → nothing), and `protected_zones` is absent from production (§5). A protected zone that is not a gem has no effect on a Discovery result. Not changed: the table does not exist where it would matter. |
| B05 | G277 — CountryResolver | **W** | `routes/discoverySearch.ts:1478-1500` `searchCountries` aggregates `profiles.home_country` (`:1490`): a country with no users in it does not exist as a suggestion. Privacy-filtered (`:1498` opt-outs), so not a leak; a construction defect. Fix needs a canonical country registry Discovery does not own. |
| B06 | G68 — Hidden Gem separate identity/protection/approximate location | **C** (by reference, line re-opened) | `:1028`; census-input-intelligence G68. |
| B07 | G70 / G185 — Trip/Event/Plan viewer eligibility before exposure | **C** (by reference, lines re-opened) | `:670` events, `:772-773` trips, `:838-860` plans; proven through the gateway by `test/inputAssistanceCertification.test.ts:330-366`. |
| B08 | G126 — age restrictions | **C** (by reference, line re-opened) | `:397-407` `fetchAgeRestrictedSet`, null on error → callers return `[]`. |
| B09 | G129 — protected locations whose exact position cannot be surfaced (gems) | **C** (by reference) | `:1028` never selects a gem's exact pair; `InputSuggestion` has no coordinate field. |

### 2c. Discovery's own code contracts (C)

| # | Contract (where stated) | Verdict | Evidence |
|---|---|---|---|
| C01 | Suspended/banned/deleted accounts excluded (`discoverySearch.ts` header `:16`) | **C** | `:531-532` `.in("account_status", ["active"])`. |
| C02 | Profile-discovery opt-outs excluded, fail-closed on query error (header `:16`) | **C** | `:548-556`; `noDiscErr → return []`. Test: *"excludes profiles that opted out of discovery (fail-closed on opt-out error)"*. |
| C03 | Blocked users excluded both directions; unknown block state → empty search (header `:17-18`) | **C** | `lib/blocks.ts:21#fetchBlockedSet` (null on error), consumed at `routes/discovery.ts:1572#fetchBlockedSet`, `:2343#fetchBlockedSet` and `:2703#fetchBlockedSet`; every per-type searcher returns `[]` on null. Tests: *"returns empty results when the blocks table returns a DB error"*. |
| C04 | Content from suspended/banned/deleted owners excluded (header `:19-20`) | **C** | `:479-494` `fetchActiveOwnerSet`, empty set on error (exclude, never leak). |
| C05 | Private trips/events/circles: only `visibility='public'` (header `:21`) | **C** | `:670` events, `:772` trips, `:1225` circles, `:1149` posts (published-and-public gate). |
| C06 | Plans only from public or caller-owned trips (header `:22`) | **C** | `:828-860`. |
| C07 | Private fields never selected (header `:25-26`) | **C** | `:529` — no email, phone, coordinates, safety, verification-document columns; `:1028` gems without the exact pair. |
| C08 | Age-restricted profiles hidden fail-closed (header `:27-35`) | **C** | `:397-407`; `:523` returns `[]` on null. |
| C09 | Hidden names are not searchable — a hidden-name match survives only if handle/username matched (`routes/discoverySearch.ts:580#Universal` comment; `.agents/memory/display-name-privacy.md`) | **C** | `routes/discoverySearch.ts:586#nameSafe` — a row whose only match was the hidden name is dropped; the viewer's own row is never redacted. |
| C10 | The viewer is never redacted (self-exemption before opt-in) | **C** | `:567` (filter) and `:603` (presentation). |
| C11 | Header `:9` said *"Private accounts (is_private=true) excluded entirely"* | **W → C (fixed)** | The code has returned them as a locked preview since the `/users/search` parity change (`:611-618`; `searchTravelers` doc `:503-508`; tests *"returns profiles with is_private=true as a locked preview, not excluded"*). A contract stating the opposite of its tests is a defect of the contract. Header rewritten (`:9-14`); zero behaviour change, no test. |
| C12 | `hasMore` derived from limit+1 overflow, no false positives (header `:38-40`) | **C** | `:1885`. |
| C13 | Rate limited 30 req/min per user (header `:48`) | **C** | `:1842` (search, 30/60 s); `:2022` (suggest, 90/60 s). |
| C14 | Suggest is fail-soft: any internal error → `200 { groups: [] }` (`:2006-2016` comment) | **C** | `:2016`, `:2053`, `:2108`. |
| C15 | Suggest reuses `dispatchSearch` — *"deliberately NOT a parallel search implementation"* (`:2006` comment) | **C** | `:2064` calls `dispatchSearch` (`:1593`); no second matcher. (The *route* duplication is A08's finding; the *engine* claim here holds.) |
| C16 | `GET /discovery` needs no auth and returns only public place data; `submitted_by` never serialised (`discovery.ts:1-5`; test *"never serialises submitted_by to the client"*) | **C** | `routes/discovery.ts:1393` optional auth; `test/discoveryBlockedSubmitter.test.ts` *"submitted_by is never mapped onto the DiscoveryPlace that toPublic returns"*. |
| C17 | The community submitter block rule is `lib/blocks.submitterIsVisible`, shared, not re-implemented (`discovery.ts:874-879`) | **C** | `routes/discovery.ts:50,879`; applied at `:2654` before names are resolved (`:2658`). |
| C18 | Viewer sees their own byline on a place they submitted (`f37e1cf0`) | **C** | `routes/discovery.ts:2675` (memoised viewer, guarded on `rows.length`), `:2694`. Tests *"shows the viewer their OWN name…"*, *"still redacts everyone ELSE"*, *"does not exempt the submitter from an ANONYMOUS caller's view"*. Not redone; the pattern was reused for C19. |
| C19 | Display-name redaction shape (`.agents/memory/display-name-privacy.md`: null name + separate handle) | **W → partially closed** | **Measured, and the lead was half wrong:** the search list's shape is `title` = name-or-bare-handle, `subtitle` = `@handle` (`routes/discoverySearch.ts:650#subtitle`) — there is no `name` field — which is the **same** shape as Compass (`routes/compass.ts:3578-3589`, `title` bare username / `displayName` null). Discovery's one divergent shape is the community byline, which bakes the literal `@username` **into `name`** (`discovery.ts:2748#name`). It cannot be changed in place: `travel-buddy-standalone/src/components/DiscoveryWall.tsx:407` renders `By {submittedBy.name}` raw, so a null there is a blank byline — a user-visible change with no flag. **Now:** the canonical shape is emitted **additively** as `displayName` (`routes/discovery.ts:2751#displayName`: real name iff self or opted-in, else null, never a handle) alongside the unchanged legacy field, from one `nameAllowed` decision (`:2694`) so the two fields cannot disagree about *whether* a name is withheld (pinned: *"the two byline fields never disagree…"*). The legacy `name` stays until the client resolves the byline through `displayIdentity(displayName, handle)` (§6 D2). Stays W until then. |
| C20 | Engine mode resolves to `legacy` on every failure path (`lib/discoveryEngineMode.ts` header) | **C** | `:151-175`; tests A–L. |
| C21 | An unreadable/absent/malformed cohort includes NOBODY; `kind:"all"` must be typed (`lib/discoveryCohort.ts` header) | **C** | `:85` `COHORT_NONE`, `:102` `NOBODY(...)` for every parse failure; tests N2–N6. |
| C22 | Shadow never changes what was served and writes only to `discovery_shadow_serves` (`lib/discoveryShadow.ts` header) | **C** | `routes/discovery.ts:1791#served` (`served: false`, handed a client that cannot write), invoked after the response is sent (`:1769#served`); `lib/discoveryShadow.ts:186#discovery_shadow_serves` the single insert; tests G, I. (Re-anchored 2026-09-08: both line numbers had drifted 30-odd lines when the silent-write burn-down `2550b8ba` edited this file. The claim held; the pointers did not.) |
| C23 | `rankForViewer(..., { served: false })` performs no write; the suppression is load-bearing (`lib/discoveryPde.ts:84-90`) | **C** | Tests D, D2 (positive control), S, S2. |
| C24 | Modifiers flag OFF → inert record, no momentum or confidence read (`lib/discoveryModifiers.ts:37-50`) | **C** | `:68` (*"Everything below is inert when false"*), `:130` the one read. |
| C25 | Serve log inert until seeded; a rejected insert is reported, never thrown (`lib/discoveryServeLog.ts:23-45`) | **C** | `:200-205` cached fail-closed read; tests A, B, B2, J, K. **Deployment:** the flag is **ON in production** and the writer is live — but `surface='discovery'` holds 13 rows ever, last 2026-08-15 (§5). Not a silent write loss (rows landed when the surface was reached); the surface is not reached. |
| C26 | L2 cache rows are purged **past** expiry, never **at** expiry, because stale rows are served (`lib/discoveryCacheCleanup.ts:20-33`) | **C** | `:20-33`; `test/discoveryCacheCleanup.test.ts`. |
| C27 | Photo store never stores a credential (Google resource name, URL minted per read); rows expire (`lib/discoveryPlacePhotoStore.ts:21-30,37-45`) | **C** | `:105`, `:162-169` (`photo_ref`, `expires_at`, `invalid_at`). |
| C28 | `discovery_places` client write boundary (`migrations/2153`; `test/discoveryPlaceWriteBoundary.test.ts`) | **C** — verified in the catalog, not by the suite | The suite **skips without live credentials** (`:28` *"SKIPPING — no live credentials"*) and the `test` script pins `SUPABASE_URL=127.0.0.1:9`, so a green run proves nothing here. Verified directly 2026-09-07 in **both** databases: `authenticated` and `anon` hold `SELECT` only; `service_role` FOR ALL. The four client write policies (`discovery_places_auth_insert` WITH CHECK `auth.uid() IS NOT NULL`, `own_/owner_update`, `own_/owner_delete`) are **decorative** — 2153 chose to leave them (`:37-40`) — so the boundary is one re-`GRANT INSERT` away from a forge policy that constrains no column. Recorded as §6 D6. |
| C29 | Serve-point report refuses a verdict on an empty window; contradictory windows are refused (`lib/discoveryServePointReport.ts:427,568`) | **C** | Tests *"--days with --since is refused"*, *"--until without --since is refused"*, *"…so the D5 population is empty"*. |
| C30 | Momentum is strictly non-negative with a minimum-evidence floor (`lib/discoveryLocalMomentum.ts:25-45`) | **C** | `:67` `MOMENTUM_MIN_RECENT_WEIGHT = 3`, `:150` floor, `:153` clamp to `[0,1]`. |
| C31 | Stale L2 entries are served while a background revalidation runs (`.agents/memory/discovery-perf-cache.md`; `discoveryCacheCleanup.ts:22-27`) | **C** | `routes/discovery.ts:1802`. |
| C32 | One ranking pipeline in the tree — the route no longer imports the ranker directly (`routes/discovery.ts:43-47`) | **C** | `:43-47` (type-only import of `portavaRank`), `:47` `rankForViewer`; test T *"discovery still declares those inputs constant, in source"*. |
| C33 | The two `profiles` reads in `routes/discovery.ts` are the caller's **own** `date_of_birth` for the age filter, not identity payloads | **C** | `:1505` and `:2545` — `.select("date_of_birth").eq("id", <caller>)`. **Settles the census-passport P95 citation** (`discovery.ts:1504,2523`) as weak evidence, exactly as the sibling agent judged; the real direct person-identity readers are `discoverySearch.ts:529` (A15) and `compass.ts:3371` (Compass's, reported not changed). |

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
| *"`discovery.ts:1504,2523` are the caller's own `date_of_birth`, weak evidence; real readers are `discoverySearch.ts:420` and `compass.ts:3369`"* | **CONFIRMED** (post-edit lines `:1505,:2545`; `discoverySearch.ts:529`; `compass.ts:3371`). C33, A15. |
| census-passport **P95 W — "Nothing calls it"** | **Superseded**: `discoverySearch.ts:2151` calls the `discovery_card` variant. A16. |
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
| D3 | ~~**Trips publishes a `TripDiscoveryProjection`**; Discovery's `searchTrips`/`searchPlans` consume it instead of re-deriving visibility. Trips-owned.~~ **DISCHARGED 2026-09-08** — Trips published it (`lib/tripDiscoveryProjection.ts`) and Discovery consumes it (`lib/discoveryTripProjectionConsumer.ts`, wired at `routes/discoverySearch.ts:822#discoveryTripProjectionGate` and `:948#discoveryTripProjectionGate`). Nothing here awaits a decision. What remains is deployment: migration **2420** (`trips.version`, which the projection's column list requires) is unapplied in production, and `discovery_trip_projection_enabled` (**2550**) is seeded FALSE. See A10. | A10 |
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
| F1 — `fetchBlockedSet` is `lib/blocks`', not a private copy | `routes/discoverySearch.ts:82,373-386`; `test/discoverySearchBlockedSubmitter.test.ts` (+1 test, +1 regex relaxed to sibling imports) | A17 W→C | R1: re-add the private copy, drop the import | **1** (`discoverySearchBlockedSubmitter`, 11/12) | `diff -q` clean |
| F2 — canonical `displayName` on the community byline | `routes/discovery.ts:2425-2450` (type), `:2688-2704`; `test/discoveryBlockedSubmitter.test.ts` (+4 tests) | C19 W→W (half) | R2: delete the field · R2b: emit `@handle` when withheld (the wrong consolidation) | **4** / **4** (21/25 each) | `diff -q` clean ×2 |
| F3 — buddy launch-eligibility gate behind a FALSE-seeded flag | `routes/discoverySearch.ts:424-472,524`; `migrations/2360_discovery_buddy_launch_gate_flag.sql`; `db/rollback/2026-09-07-2360-discovery-buddy-launch-gate-rollback.sql`; `test/discoverySearch.test.ts` (+8 tests) | B03 W→W (launch leg) | R3a: remove the call site · R3b: predicate ignores the gate (the not-inert way) | **2** / **5** (64/66, 61/66) | `diff -q` clean ×2 |
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
service client (`getServiceClient()` at `routes/discovery.ts:1568`, `routes/discoverySearch.ts:1787`),
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
halves are now false. Trips published it (`lib/tripDiscoveryProjection.ts`) and
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
