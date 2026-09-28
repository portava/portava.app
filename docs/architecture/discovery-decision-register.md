# Discovery decision register

Owner authorisation, 2026-09-28. These instructions come from the owner:

- The 2026-08-15 ranker implementation hold is lifted. The held designs may be built and tested behind flags seeded FALSE.
- Routine architecture and product decisions are to be made from the specifications, recorded here, and implemented.
- Four kinds of decision are NOT delegated:
  - real user consent;
  - financial obligations (rates, payouts, commercial terms);
  - data-retention policy;
  - production activation (production migrations, deploys, flags turned on in production).

  For each of those this register carries an exact recommended action and a specific approval request. Nothing is chosen silently.

Each lane appends its own `## <lane> — <topic>` section and never edits another lane's section. An entry has:

- **Decision id:** `D-<lane>-<n>`.
- **The question:** quoted from the census section or spec that raised it, with a citation.
- **Options considered:** each with its consequence.
- **Decision and rationale:** with spec citations.
- **Reversibility:** how to undo it, and whether anything is lost.
- **Where it is implemented:** file references, plus the tests that pin it.

An entry that needs owner approval is marked **APPROVAL REQUIRED**. It gives the recommended action with exact values, the consequence of approving, the consequence of declining, and the recovery path.

## W10-S1 — search safety and search product decisions

Lane W10-S1, 2026-09-28, branch `disc-w10-s1-search`. Census section: census-discovery §80. Rows: B02, DV-83, B04, A08. Owner items from §69.1: D-8 (both halves), A-3, E-9.

### D-W10-S1-1 — emoji in search (B02; D-8, first half)

- **Question:** census-discovery §6 D5, re-keyed D-8 in §69.1: *"Emoji in queries. Stripping them changes which results a query returns."* The options are §46.5's.
- **Options considered:**
  - **(a) status quo.** "🔥 bar" finds only rows whose text literally holds "🔥 bar", so "Sky Bar" is missed. No 400s.
  - **(b) strip emoji from the search key**, using the platform's rule. "🔥 bar" finds "Sky Bar" and the emoji-named row both, because the key is "bar". An emoji-only query has no searchable characters: `400 invalid_payload` on `/discovery/search` (the answer "((" has always had) and a `query_too_short` refusal on `/discovery/suggest`. A row can no longer be found by its emoji alone.
  - **(c) strip for place, people and geo types; keep literal for content types.** `type=all` would mix two rules in one answer, and no spec clause names a split by type.
  - **(d) search both forms.** Every emoji query costs a second pattern per type. It is also a policy no other platform field uses.
- **Decision: (b).** Discovery's search key takes the shared input platform's field-context rule: `stripsEmoji("global_search")` is true, and the strip applies to the key only, never to the text the person sees. Grounds:
  - GII §10: *"Punctuation and emoji handling appropriate to field context"*.
  - GII §2: *"One platform layer."*
  - census-input-intelligence G62 is `C` on this exact function.
  - A Discovery search box is a lookup field, not prose.
  - It also keeps the Map sheet's gateway page (D-W10-S1-5) identical to `/discovery/search`, which it could not be under (a), (c) or (d).
- **Reversibility:** revert the two edited lines in `routes/discoverySearch.ts`. Nothing is stored, so nothing is lost.
- **Where it is implemented:**
  - Code: `artifacts/api-server/src/routes/discoverySearch.ts:140#let q = applyAliases(stripEmoji(qAfterHandle));` and `artifacts/api-server/src/routes/discoverySearch.ts:414#const q = sanitizeQuery(applyAliases(stripEmoji(`, which apply `stripEmoji` from `lib/inputAssistance/queryNormalizer.ts`. `lib/inputAssistance/searchPage.ts` `prepareSearchQuery` does the same.
  - Tests: `src/test/discoverySearchQueryPolicy.test.ts` Q2–Q6, restated as the visible diff §46.5 said they would be; `src/test/inputAssistanceMapSearchPage.test.ts` "E: an emoji in the query".

- **The follow-up (independent verification at `bc0ba4a94`, decided and built the same day).** Four gaps in the first strip were found:
  - **Subdivision flags** (🏴 + TAG characters U+E0020–U+E007F) left invisible tags in the key. The TAG block is now part of the emoji class, so "🏴 pub" searches "pub", and the flag alone is refused.
  - **Keycaps** kept their base character, so "1️⃣ bar" searched "1 bar" and "*️⃣*️⃣" searched "* *". The whole sequence `[0-9#*]️?⃣` is now removed.
  - **An emoji inside a word.** Rule: an emoji between two LOWERCASE letters is inside one word and is removed without a gap ("caf☕e" searches "cafe"). Anywhere else it separates, as a space: between words, at an edge, or before an UPPERCASE letter that starts a new word ("Sky🔥Bar" searches "Sky Bar"). The trade-off: "Sky🔥bar", all lowercase, joins to "Skybar". "caf☕e" does not find "Café Luna", for the same reason "cafe" does not: Discovery's free-text place names are matched accent-sensitively, which is outside G62 (§46.3's stated limit of B01). "caf☕é luna" does find it.
  - **A literal `*`** is PostgREST's like-wildcard, so "**" matched every row. `sanitizeQuery` now drops `*` the way it drops `(`, `)` and `,`.
  - One function serves both callers, so the gateway's key is the same (Q8c).
  - **Where:**
    - `lib/inputAssistance/queryNormalizer.ts`: the class line, the `stripEmoji` line, and `KEYCAP_RE` / `IN_WORD_EMOJI_RE` at the foot;
    - `lib/inputAssistance/searchCandidates.ts` `sanitizeQuery`;
    - pinned by `discoverySearchQueryPolicy` Q7a–Q7e (every hidden-mark class, one at a time), Q8a–Q8c and Q9.

- **The backslash (round 3, independent verification of `5a434ec7b`).** In a LIKE pattern `\` is the escape character, and the search pattern escaped `%` and `_` but not `\` itself. So "kiosk\" sent `%kiosk\%`, where the trailing `\` escaped the closing wildcard, and "k\iosk" sent `%k\iosk%`, which matches "kiosk". Rule: **every user string that reaches a LIKE pattern is literal**; `\`, `%` and `_` are each escaped with `\`.
  - `lib/inputAssistance/searchCandidates.ts` `sqlPattern` now escapes `\` as well. "kiosk\" finds only the row that literally holds it, "k\iosk" does not find "Kiosk Row", and "100%" does not match "1000 Lakes".
  - `lib/inputAssistance/duplicateDetection.ts` spliced names into `.or()` through the shared `lib/postgrestFilter.ts#safeOrIlikeValue`, which LIKE-escapes first and then strips `\` as an `.or()` structural character, so it removes the escapes it has just added: a place named "100%" was scanned as `100<anything>`. The scan now strips the `.or()` structure first and LIKE-escapes second, so no user backslash survives and the escapes do.
  - Every other place a user string reaches `ilike` on the search and gateway paths was checked and is safe by construction: `discoverySearchCanonical.ts` and `canonicalLocations.ts` match on `searchKey` / `normalizeLocationName` output (`[a-z0-9\s]` only), and `socialIdentity.ts` matches a hashtag slug (`[A-Za-z0-9]`).
  - **Not changed here:** the shared helper itself. It is not this lane's file, and `routes/follows.ts` and `routes/tags.ts` use it; it is routed in census-discovery §80.13.
  - **Then fixed (§80.14, at the coordinator's request):** the shared helper now strips first and escapes second, the same order. Its callers `routes/follows.ts` (`GET /users/search`), `routes/tags.ts` (`GET /tags/suggestions`) and `services/airport/AirportProfileService.ts` (`searchAirports`) now match `%` and `_` literally. Pinned by `src/test/postgrestFilterLikeEscape.test.ts` on the helper and over HTTP on the two routes. Those routes' census rows belong to census-passport, census-layover and census-discovery's own non-search rows; each got an argued staleness acknowledgement and none is re-graded.
  - Pinned by `discoverySearchQueryPolicy` Q10a–Q10d and Q11a. The in-word rule is also pinned for Greek and Cyrillic (Q8d: "αθ🔥ήνα" → "αθήνα", "моск🔥ва" → "москва", "Москва🔥Питер" → "Москва Питер").

### D-W10-S1-2 — partial coverage: may a consumer render `partial` as complete, and in what words (DV-83 ground 2; D-8, second half)

- **Question:** census-discovery §60.8 Q1, verbatim: *"May a Discovery consumer render a `coverage: "partial"` answer as a complete result with no notice … Or must every consumer that renders a list surface `failedSources` … If the second, which wording is ratified?"*
- **Options considered:**
  - **(i) Partial may render as complete.** DV-83's criterion stays met by 8 of 11 consumers as they are. A person reading a short list cannot tell it is short: the `11` §9 masquerade with rows in front of it.
  - **(ii) Every list-rendering consumer says the list is incomplete.** Each consumer gains one notice, and a partial with no rows can no longer read as "nothing found".
- **Decision: (ii).** Grounds:
  - `02-DISCOVERY-v2` "Privacy, degradation and integration": *"retain permitted baseline retrieval and recommendations with honest limitations"*.
  - `11` §9: *"A failure must not masquerade as success."*
  - The owner's D11 ruling: *"A distinguishable response body alone is insufficient if consumers still treat it as successful empty data."*
- **The rule:**
  - Rows are kept: they are real and they were served.
  - One notice says the list may be incomplete.
  - A partial with no rows is never the "nothing found" state.
  - `failedSources` holds table and bucket names. They are for logs and alerts, so they are not printed. "Surfacing" them means stating that something is missing.
- **The wording:** taken from sentences the app already ships, with one home in `travel-buddy-standalone/src/services/discoveryCoverageNotice.ts`.
  - **Search surfaces** (the search screen, its suggestions panel, the Map search sheet):
    - rows present: "These results are incomplete — part of the search couldn’t be run." (already verbatim in `MapSearchSheet` and `app/search.tsx`);
    - no rows: "Some of this search could not run." with "Part of the search failed, so this is not a statement about what exists. Try again in a moment."
  - **Browse lists** (Discovery tabs and sections, the Map's places layer):
    - rows present: "Some {noun} couldn’t be loaded just now, so this list may be incomplete." This is the Telegraph search screen's shape;
    - no rows: "Some {noun} couldn’t be loaded just now" with "This is on our side, not your filters. Try again in a moment." (the category tab's own phrase).
- **On the server:**
  - The input gateway's envelope now carries coverage in the same refusal vocabulary (`refusal`, and `laneRefusals.saved` for the Map page). Its typeahead used to answer a failed read with the body of an empty one.
  - A serve that throws carries `suggest_failed`.
  - Before this, E-9 (D-W10-S1-4) would have made the global typeahead lose the partial and refused notices the legacy route carried.
- **Reversibility:** remove the notices. The rows never change, so nothing is lost.
- **Where it is implemented:**
  - Server: `artifacts/api-server/src/lib/inputAssistance/gateway.ts` (coverage sink, `generateSuggestionsWithCoverage`, `gatewayFailureRefusal`), `artifacts/api-server/src/routes/inputAssistance.ts` (lines 36, 263, 297, 320, each edited in place) and `artifacts/api-server/src/lib/inputAssistance/types.ts`.
  - Client transport: `platform/input-assistance/services/suggestResponse.ts`, `services/inputAssistance.ts` and `hooks/useInputAssistance.ts` (exposes `refusal`, never caches a refused or partial serve).
  - Client consumers: `hooks/useSearchSuggestions.ts`, `hooks/useGlobalSearchSuggestions.ts`, `hooks/useCommunityDiscovery.ts`, `components/search/SearchSuggestionsPanel.tsx`, `app/search.tsx`, `components/discovery/ForYouTab.tsx`, `components/discovery/DiscoveryCategoryTab.tsx`, `components/map/MapSearchSheet.tsx`, `app/map/index.tsx`.
  - Static pin: `src/services/__tests__/discoveryRefusalConsumers.guard.test.ts` G7 and G8.
  - Tests: listed in census-discovery §80.4.

### D-W10-S1-3 — what the protected-zone search pass does (B04; A-3, semantics)

- **Question:** census-discovery §69.1 A-3: *"a ruling on 3366's protected-zone pass (B04)"*, and §46.4: *"Is the flag still needed?"*
- **Decision: the semantics, and that they are correct.**
  - **What it decides:** each search CANDIDATE, by its stored position, before projection. This happens on every serve that reaches the Discovery searchers:
    - `GET /discovery/search` (all three branches);
    - `GET /discovery/suggest`;
    - since §80, the input gateway: the typeahead's and the pickers' candidates, and the Map search sheet's `map.search` page.
  - **Actions:**
    - zones read and none registered: identity, the same array;
    - allow: the same object;
    - coarsen: the position is snapped to the zone anchor, with `coordsPrecision: "approximate"`;
    - suppress: the row is not served, and **not suggested by name** either (§46.4's reported gap, closed);
    - policy unreadable: positions withheld (`coordsPrecision: "hidden"`), rows kept;
    - a malformed zone: `unknown` coverage, so every positioned row is suppressed.
  - **What it never does:** put counts on the wire; empty a search because the policy is unreadable; loosen anything. Every failure branch tightens.
  - **Why it is correct:** it applies Map spec §24 through the one reader of `protected_zones` (`lib/protectedZoneStore.ts`) and the contract's own `applyProtection`. The same row is judged the same way on every serve point, so a place hidden from search is not findable by name in the typeahead.
  - **Is the flag still needed:** not for safety. With production's 0 zones it is the identity. It stays because turning it on is production activation (AR-W10-S1-1).
- **Reversibility:** flag OFF restores byte-identical bodies. This is pinned by §46's R2 and by `inputAssistanceMapSearchPage` Z4 and I2.
- **Where it is implemented:**
  - Code: `lib/discoverySearchProtection.ts` (unchanged); `lib/inputAssistance/gateway.ts` `protectGatewayCandidates`; `lib/inputAssistance/searchPage.ts`; migration `3460_discovery_search_protection_scope.sql`, which updates the flag's description only and never its state.
  - Tests: `src/test/inputAssistanceMapSearchPage.test.ts` Z1–Z5 and `src/test/db/discoverySearchProtectionGateway.db.test.ts` W0–W3 (harness).

### AR-W10-S1-1 — APPROVAL REQUIRED: turn the protected-zone search pass on in production (B04, A-3 activation)

- **Recommended action, exact:**
  1. Apply `artifacts/api-server/src/migrations/3366_discovery_search_protected_zones_flag.sql`, then `3460_discovery_search_protection_scope.sql`, to production through the ledgered path. 3366 seeds the row FALSE; 3460 rewrites the description only.
  2. Then set it on:

     ```sql
     UPDATE public.feature_flags SET enabled = true WHERE flag = 'discovery_search_protected_zones_enabled';
     ```

  - Reader: `lib/discoverySearchProtection.ts` `searchProtectionEnabled`, which caches for 30 s per process.
- **Prerequisites:**
  - `protected_zones` exists (2217, applied 2026-09-21, §46.1). It holds **0 rows** as last read (2026-09-27), so the flip is a byte-identity until zones are registered.
  - 3366 and 3460 are both unapplied in production.
  - The server build carrying §80 is deployed; without it the gateway leg does not exist.
  - Registering zones is a separate act of policy, not asked here.
- **Monitoring:**
  - The server log line "discovery search: §24 protection pass changed what was served" (`lib/discoverySearchProtection.ts`). It carries counts only: evaluated, coarsened, suppressed, withheld, and `policy: read|unreadable`. Since §80 its `route` names `POST /input-assistance/suggest` for the gateway.
  - The rate of `policy: "unreadable"`. Each such serve withholds every position until the read heals.
  - `protected_zones` row count, and the 30 s cache TTL.
  - No count is on the wire, by design.
- **If approved:**
  - Every search serve reads the flag and, while zones exist, `protected_zones`, at most once per 30 s per process.
  - With 0 zones, nothing changes on screen.
  - Once zones are registered: shelters and similar places vanish from search, suggest, the typeahead and the Map sheet; clinics are coarsened.
  - If the table becomes unreadable, positions are withheld from search results until it heals.
- **If declined:** B04 stays `W`. A zone registered later has no effect on any search serve, while the Map already honours it.
- **Recovery:**

  ```sql
  UPDATE public.feature_flags SET enabled = false WHERE flag = 'discovery_search_protected_zones_enabled';
  ```

  This takes effect within 30 s and restores byte-identical bodies. Nothing is stored by the pass, so nothing needs repair. 3366's rollback (`db/rollback/2026-09-27-3366-discovery-search-protected-zones-flag-rollback.sql`) refuses while the flag is ON, by design.

### D-W10-S1-4 — the legacy typeahead (A08 reason 2; E-9)

- **Question:** census-discovery §69.1 E-9, *"the legacy typeahead"*; §53.4 reason 2: *"Until the gateway returns at least one suggestion on a mount, both requests fire per keystroke."*
- **Options considered:**
  - **(a) Keep the proving window.** Two requests on every first keystroke, and on every keystroke of a mount whose queries never match.
  - **(b) Retire it once the gateway has answered at all.** The first keystroke still doubles.
  - **(c) Run the legacy typeahead only while the gateway reports `unavailable`.**
  - **(d) Delete it.** GII §38 requires a failure ladder, so no.
- **Decision: (c).** A gateway that has not answered yet has not failed. GII §38's signal is `unavailable` (404/405/501, offline, no token, an unreadable schema). The fallback is one keystroke away when that fires, and `GET /discovery/suggest` stays as that fallback. A transient 5xx keeps what is on screen, which is GII §38's *"Provider failure must not collapse the input UI"*.
- **Reversibility:** one line (`legacyEnabled`).
- **Where it is implemented:**
  - Code: `travel-buddy-standalone/src/hooks/useGlobalSearchSuggestions.ts`.
  - Tests: `useGlobalSearchSuggestions.singleSystem.component.test.tsx`. The first case is restated from "every keystroke still fetches the legacy typeahead" to "no keystroke fetches it", because this decision changed it. A control and a never-matching-mount case were added.

- **The timeout (follow-up).** With E-9 the fallback starts only on `unavailable`, and a gateway that accepted the connection and never answered was never `unavailable`. Every request to `POST /input-assistance/suggest`, from both the typeahead and the Map page, now has a **5 000 ms** budget (`SUGGEST_TIMEOUT_MS`).
  - When the budget runs out, the request is aborted and reported as `unavailable`, which starts the legacy typeahead. The Map sheet shows its error line.
  - The caller's own abort of a superseded keystroke stays `aborted`.
  - Why 5 s: it is two orders of magnitude over GII §33's 100–150 ms debounce, so a slow but live serve is not cut off, and a person still typing gets the fallback while it helps. GII names no latency number.
  - **Where:**
    - Code: `travel-buddy-standalone/src/platform/input-assistance/services/inputAssistance.ts` (`withBudget`).
    - Tests: `services/__tests__/requestTimeout.component.test.ts`, with fake timers.

- **The missing policy (round 3, independent verification of `5a434ec7b`).** With no authoritative policy table — never fetched, the fetch failed, another account's table, past the 12 h expiry, or a newer `policyVersion` noted — `global_search` resolves to the conservative policy, whose `minChars` is unreachable. The gateway hook then returns before any request and reports `unavailable = false`, so under (c) the legacy typeahead never started either: the search bar did nothing. The table was refetched only on auth events, so a failed startup fetch stayed failed for the session, and a mounted hook never re-read the store.
  - **Decision:** a non-authoritative `global_search` policy counts as the gateway being unavailable, and the legacy typeahead runs. The gateway still obeys the conservative policy and sends nothing. The fallback is `GET /discovery/suggest`, the same matcher (`dispatchSearch`) the gateway calls, with the server's own rules applied, so this does not widen what the viewer may see; it keeps search working while the assistance policy is missing.
  - **Refresh on use.** While the field is used without a current table, the policy is fetched again, through the store and fetcher `installInputPolicySync` installed, at most once per 30 s (`POLICY_RETRY_MIN_GAP_MS`) and one at a time. It is not a schedule: no typing, no fetch. A failed fetch still relaxes nothing (`refreshPolicies` installs only a payload that survives `PolicyStore.install`).
  - **A mounted screen picks the table up.** `useInputAssistance` keys its resolved policy on `policyEpoch()` (active account, held account, version, and whether the table is current), so a table that lands, expires or is superseded changes the field on the next render instead of the next mount. The search hook re-renders when a refresh installs a table, so the gateway takes over again without a keystroke.
  - **Scope:** only `global_search` falls back to the legacy route, because only it has one. Refresh on use is wired from this hook only; the `policyEpoch()` re-read applies to every field.
  - **Reversibility:** `legacyEnabled` and `preferGateway` in `useGlobalSearchSuggestions.ts`, the memo key in `useInputAssistance.ts`, and the `bindPolicyRefreshOnUse` call in `installInputPolicySync.ts`, each one line.
  - **Where:**
    - Code: `travel-buddy-standalone/src/hooks/useGlobalSearchSuggestions.ts` (`legacyEnabled`, `preferGateway`, `usePolicyRefreshOnUse`); `platform/input-assistance/hooks/useInputAssistance.ts` (the memo key and `policyAuthoritative` in the result); `platform/input-assistance/services/policyStore.ts#policyEpoch`; `platform/input-assistance/services/policyRefreshOnUse.ts` (new); `platform/input-assistance/services/installInputPolicySync.ts` (the binding).
    - Tests: `src/hooks/__tests__/useGlobalSearchSuggestions.missingPolicy.component.test.tsx`, which runs the real gateway hook inside the real search hook with no policy seeded, and `services/__tests__/policyRefreshOnUse.component.test.ts`. The two mocked-gateway suites (`singleSystem`, `refused`) now state `policyAuthoritative: true` in their stand-in, the premise every case there already described (a healthy gateway); no assertion changed.

### D-W10-S1-5 — the Map search sheet on the gateway (A08 reason 3)

- **Question:** census-discovery §70.3: *"Moving it would change what a person sees … it carries none of the `refusal.coverage` notices the sheet renders."*
- **Decision:** the sheet is the `map.search` FIELD of the `global_search` context. GII §13 phase 3 names Map among Global Search's consumers, and GII §2 says *"The field owns behavior"*.
  - The gateway serves this field as a **search page** (`lib/inputAssistance/searchPage.ts`):
    - the same platform searchers (`searchAll` plus `saved`, limit 20, as the sheet always asked);
    - the same eligibility reads;
    - the same §24 pass;
    - the same query preparation.
  - Projection: the §42 suggestion plus `mapResult`, which carries the wire type, the display fields, and from `metadata` only `lat`, `lng`, `coordsPrecision`, `savedKind` and `bounds`.
  - Coverage: each lane's coverage on the envelope.
  - One request per settled keystroke instead of two.
- **Visible behaviour:** the same rows and the same notices. `inputAssistanceMapSearchPage` E compares the route and the gateway over eleven query shapes, healthy and degraded. The sheet's twelve cases are restated onto the new transport.
- **Known differences, none visible on a healthy search:**
  - A 429 now carries the gateway's text ("Too many suggestion requests. Please wait.") instead of the route's. The bucket is `input_assist_suggest`, 90/min, shared with the global typeahead, instead of 30/min for two requests per keystroke.
  - The Map sheet's searches no longer write Discovery serve-point-8 rows (`rank_events`). They were typeahead traffic counted as search exposures, two per keystroke. The gateway logs its serve (`input-assistance/suggest served`).
  - The Compass search signal is sent once per answered query instead of twice.
- **Reversibility:** restore the sheet's `run` (git). The server page is additive.
- **Where it is implemented:**
  - Code: `lib/inputAssistance/searchPage.ts`, `lib/inputAssistance/gateway.ts`, `routes/inputAssistance.ts`, `travel-buddy-standalone/src/platform/input-assistance/search/mapSearch.ts`, `services/inputAssistance.ts` `requestMapSearchPage`, and `components/map/MapSearchSheet.tsx`.
  - Tests: `inputAssistanceMapSearchPage.test.ts`, `mapSearch.test.ts` and `MapSearchSheet.refusal.component.test.tsx`.

- **Nothing searchable (follow-up).** For "🔥", "((", "@a" (the second keystroke of every handle search) or a subdivision flag, the gateway page answers a `validation` / `query_too_short` refusal on both lanes. Before the move this was the route's `400`.
  - The sheet now treats class `validation` as not-enough-to-search: the state it already has for a one-character query. It shows no rows, no outage sentence, no "Nothing matched", and no error line.
  - It does not print the route's developer message ("q must be at least 2 characters after sanitization"), which the old error line did. That is the only visible difference, and it removes a message nobody should have seen.
  - **Where:** `MapSearchSheet.tsx` (`tooShortNow`) and `mapSearch.ts` (`tooShort`). Tests: sheet case (11) with the outage control (11b), and `mapSearch.test.ts` V1.

### D-W10-S1-6 — the search helpers join the platform module (A08, the residual §70 named)

- **Question:** census-discovery §70.8: *"`routes/discoverySearchHelpers.ts` into the platform layer."*
- **Decision:** move it verbatim to `lib/inputAssistance/searchQueryHelpers.ts`, keeping the same lines. The six `lib/` importers now import it there. `routes/discoverySearchHelpers.ts` becomes a one-line re-export, so no Discovery caller changes.
- **Reversibility:** `git mv` back.
- **Where it is implemented:** `searchPlatformBoundary.test.ts`. B5 is now an empty list and B6 pins the re-export.
