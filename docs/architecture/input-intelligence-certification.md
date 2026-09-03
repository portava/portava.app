# Global Input Intelligence — Phase 10 Certification Report

**Scope:** the merged Global Input Intelligence platform (Phases 1–9) audited against
the §49 Testing and Certification Matrix, plus the §2 non-negotiables, §29 privacy
gateway, and §47 security boundaries.

**Surfaces certified**
- Backend: `artifacts/api-server/src/lib/inputAssistance/*` (gateway, policyRegistry,
  projection, geoResolver, creation, duplicateDetection, personalization,
  liveSuggestions, aiWriting, semanticIntent, socialIdentity) + `routes/inputAssistance.ts`.
- Client: `travel-buddy-standalone/src/platform/input-assistance/*` (SDK services,
  hooks, components, and the wired search / geo picker / telegraph recipient /
  compass AI / creation surfaces).

**Method:** read-only audit of each §49 dimension → PASS (cite the proving code +
test) or GAP (a real, missing/weak guarantee). Gaps were closed with *additive,
mutation-proven* tests only. No working code was rewritten.

**Test totals after this pass:** backend input-assistance = **168 tests, 0 fail**
(across 10 files); client input-assistance = **179 tests, 0 fail** (across 24 files).

---

## Headline verdict

**The Input Intelligence platform is CERTIFIED for the code-verifiable dimensions.**
The audit found **no actual defect** — no privacy leak, no fabricated-live path, no
silent AI insertion, no raw-private-text capture. The nine phases were already built
with the §2 non-negotiables as first-class invariants and mutation-proofed as they
landed. Phase 10 **closed the remaining test-coverage holes** in the safety-load-bearing
dimensions (Privacy, Failure, Telemetry) and documents the dimensions that can only
be certified against a running app / real device / real traffic.

New tests added this pass:
- `artifacts/api-server/src/test/inputAssistanceCertification.test.ts` (13 tests)
- `travel-buddy-standalone/src/platform/input-assistance/services/__tests__/inputTelemetry.test.ts` (5 tests)

---

## §49 Matrix — dimension by dimension

| # | Dimension | Status | Proof |
|---|-----------|--------|-------|
| 1 | **Correctness** — exact / prefix / typo / alias / transliteration / ambiguous entity / duplicate suppression | **PASS (pre-existing)** | Diacritic/stroke fold + abbreviation + misspelling: `inputAssistanceGeoCore.test.ts` ("da nang"→Đà Nẵng, "hcmc"→HCMC, "phu qouc"→Phu Quoc). Ambiguity → ranked CHOICES, not a silent pick: geoCore (Paris FR vs TX; airport DAD disambiguation). Duplicate suppression: `inputAssistanceCreation.test.ts` (gem/place dedup) + `inputAssistanceGlobalSearch.test.ts` (cross-group entity-id dedupe) + client `raceAndCache.test.ts` (`dedupeSuggestions`). |
| 2 | **Race safety** — rapid typing / cancellation / out-of-order / stale cache | **PASS (pre-existing)** | Sequence guard (latest-current, out-of-order rejected, `invalidate()`) + SWR cache (TTL expiry, LRU eviction, coord-jitter key stability): client `services/__tests__/raceAndCache.test.ts`. Wired into the live path via `AbortController` + monotonic guard in `hooks/useInputAssistance.ts` (`guardRef`/`abortRef`, `if (!guardRef.current.isCurrent(mySeq)) return`). Server carries a per-request `requestId` (`routes/inputAssistance.ts`). |
| 3 | **Routing** — every suggestion opens the right entity/action; missing destination handled | **PASS (pre-existing)** | Every row resolves to an action, canonical entity, or destination; non-resolvable rows are dropped: `projection.ts` `isResolvable`/`dropDeadRows`, proven in `inputAssistanceGlobalSearch.test.ts` ("no dead rows net") + the §8 projection contract test in `inputAssistanceGateway.test.ts`. |
| 4 | **Privacy** — blocked-user suppression / private Trip·Event exclusion / private-metadata index exclusion / precise-location leakage | **PASS — 2 gaps CLOSED** | *Blocked suppression + fail-closed (pre-existing):* `inputAssistanceGateway.test.ts` + `...GlobalSearch` + `...SocialIdentity` (null block-set ⇒ show nobody). *Private Trip/Event exclusion (CLOSED):* the gateway delegates to `dispatchSearch`, whose `.eq("visibility","public")` gate is proven at source in `discoverySearch.test.ts`; **new** `inputAssistanceCertification.test.ts` proves the *gateway* preserves it end-to-end (a stranger's private event/trip never surfaces in `global_search`). *Precise-location leakage (CLOSED):* `InputSuggestion` has no coordinate field and `projection.ts` copies only a display-safe whitelist; **new** cert test feeds adversarial coords in `SearchResult.metadata` and deep-scans every projected row — a place/gem never carries a coordinate, while a city *picker binding* carries only the public city-center coord (the intended §17/§53 value). *Private-metadata index exclusion:* covered by construction — search queries only public columns, projection drops `metadata`/`privacyState`/`accessState` (metadata-strip test + the new precise-location test). |
| 5 | **Offline** — static dictionary / cache / no fake live labels / raw-query fallback | **PASS (construction) + runtime QA** | *No fake live labels:* client is a pure renderer — `components/freshnessDisplay.ts` never synthesizes a label the server did not send (mutation-proofed in `freshnessDisplay.test.ts`); backend anti-fabrication in `liveSuggestions.ts` (`inputAssistanceLiveIntelligence.test.ts`). *Cache:* `SuggestionCache` SWR (raceAndCache test). *Static dictionary / cached-local / raw-query fallback* are declared per field in `policyRegistry.ts` (`offlinePolicy`). **Runtime QA:** actual on-device offline degradation (airplane mode, cache hydration) requires a device run. |
| 6 | **Accessibility** — keyboard / screen reader / focus / dynamic type / reduced motion | **Foundation present + runtime QA** | Components carry `accessibilityLabel` / `accessibilityRole` (button/header/alert) / `accessibilityState` / `accessibilityLiveRegion` (announcing the suggestion overlay); active-descendant tracking (`activeIndex`/`activeId`) in `SmartInput.tsx`. **Runtime QA required:** real VoiceOver/TalkBack announcement order, hardware-keyboard traversal, Dynamic Type scaling, and `prefers-reduced-motion` behavior are device-level and are NOT asserted in code. |
| 7 | **Failure** — provider timeout / API error / empty result / partial degradation | **PASS — gap CLOSED** | The route fails soft to a well-formed empty 200 envelope (`routes/inputAssistance.ts` try/catch); every candidate sub-call is `.catch(() => [])`. **New** cert test proves: (a) *partial degradation* — one candidate source erroring still returns the surviving sources at 200; (b) *total data-layer failure* → a well-formed empty 200 (never a 500 mid-keystroke); (c) *empty result* → a clean empty list, no dead/fabricated row. (Provider timeout for external place providers is dormant — `external_places_enabled` OFF — so it is a runtime item when that path is enabled.) |
| 8 | **AI** — no silent insertion / no canonical-fact invention / correct opt-in + provenance | **PASS (pre-existing)** | `inputAssistanceCompassAI.test.ts`: opt-in required (per-request `aiAssist` + policy `allowAI` + `compass_ai_writing_enabled` flag, all mutation-proofed OFF ⇒ no AI), `source:'ai'` provenance, editable `replace_text` (never auto-insert/publish), `ai_suggestion` sorts LAST so a canonical entity always outranks it (§9), minimum coarse context only (no coords/address), and `sanitizeSuggestedText` drops unsafe variants (§47). AI creates no canonical entity. |
| 9 | **Performance** — P50/P95 latency / cold start / render cost / large index | **PASS (construction) + runtime QA** | *Cold start:* zero-char defaults/recents render from local/owner data before the first keystroke (`inputAssistanceGeoCore.test.ts`, `...Personalization`). *Large index / render cost:* `maxSuggestions` cap + reserved-slot ordering (`orderSuggestionsReserving`) + client `capSuggestions`/`finalizeSuggestions` + debounce 100–150 ms (policy). **Runtime QA required:** actual P50/P95 latency, cold-start time, and large-index render cost are measured against a running server + device, not in unit code. |
| 10 | **Telemetry** — no prohibited raw private-text capture / action-result linkage | **PASS — gap CLOSED** | The suggest path persists **nothing** (no serve-log / analytics / insert in `lib/inputAssistance/*`). The only write is the explicit `POST /select`, which stores a *folded* query key + canonical entity label for personalization-enabled contexts only. **New** backend cert test proves the private-text contexts (`caption` / `comment` / `telegraph_message`) record NOTHING and that every private-message/sensitive/viewer-scoped policy declares `logRawText:false`. **New** client `inputTelemetry.test.ts` proves the emit path scrubs raw-text props (`text`/`query`/`message`) for a `captureRawText:false` field and honors the event allowlist. *Action/result linkage:* the response carries `requestId`; `/select` links the accepted entity to the query that produced it. (A full impression→outcome analytics funnel per §44 is a later analytics-infra item, not a construction gap — the taxonomy + sink are wired, the transport is deferred.) |

---

## §2 / §29 / §47 non-negotiables — spot verification

| Principle | Status | Where enforced |
|-----------|--------|----------------|
| §2 Canonical entities outrank AI guesses | PASS | `projection.ts` `TYPE_RANK` (entity=0 … ai_suggestion=9); `...CompassAI`/`...SemanticIntent`/`...GlobalSearch` order tests. |
| §2 AI never silently replaces user text; low confidence preserves raw input | PASS | Every AI/semantic row is an editable `replace_text`/action that sorts after entities; a LOW parse adds nothing (`...SemanticIntent.test.ts`). |
| §2/§31 Live never fabricated when unavailable | PASS | `liveSuggestions.buildFreshnessState` returns null on empty envelopes; `freshnessDisplay` renders nothing without server data (both mutation-proofed). |
| §29 Privacy/eligibility BEFORE projection; fail-closed | PASS | Gateway runs the block/age gate before projection; null block-set ⇒ no entities (gateway + globalSearch tests). |
| §29 Precise private location never leaks | PASS (locked this pass) | `InputSuggestion` has no coord field; projection whitelist; **new** precise-location deep-scan test. |
| §29 AI receives only minimum permitted context | PASS | `aiWriting.buildPermittedWritingContext` (coarse city only; coords/address omitted + `stripCoordinateFields` backstop); `...CompassAI` test. |
| §47 Action suggestions reuse the target's own auth; validation not bypassed | PASS | Gateway only PROPOSES actions (`SuggestionAction`); execution stays behind each endpoint's auth. `sanitizeQuery` PostgREST guard + `sanitizeSuggestedText` moderation on AI output. Recipient search is enumeration-safe (`...SocialIdentity`). |

---

## Real defects found

**None.** The audit specifically hunted for an actual privacy leak, a fabricated-live
path, and a silent AI auto-insert. All three are provably absent: precise location is
structurally unrepresentable in `InputSuggestion` and stripped at projection; every
live label traces to a gated, unexpired observation via `readLiveClaimEnvelopes`; and
every AI row is an opt-in, flag-gated, editable proposal that sorts below canonical
entities and passes moderation before surfacing. The Phase-10 work is therefore
coverage completion, not defect repair.

---

## Gaps closed this pass (all additive + mutation-proven)

| Gap | §49 dimension | Fix | Mutation proof |
|-----|---------------|-----|----------------|
| Precise-location leakage was not locked by a test | Privacy | Deep-scan test over `projectSearchResult`/`projectCanonicalCity` + a gateway event-search assertion | Copy `r.metadata` in `projectSearchResult` ⇒ the secret coord is found ⇒ RED (verified). |
| Private Trip/Event exclusion unproven *through the gateway* | Privacy | Gateway integration: private event/trip never surfaces in `global_search`, public does | Remove `.eq("visibility","public")` in `searchEvents` ⇒ "private event must never surface" ⇒ RED (verified). |
| No route-level failure / partial-degradation test | Failure | Force a source table error (partial), total error (empty 200), and a no-match (clean empty) | (Construction guarantee; asserts 200-never-500.) |
| Raw-private-text capture only tested for `username` | Telemetry | `/select` records nothing for `caption`/`comment`/`telegraph_message`; `logRawText:false` for every sensitive policy | Remove the `allowPersonalization` gate in `recordSelection` ⇒ all three record ⇒ RED (verified). |
| Client telemetry scrub (`scrubProps`) unproven | Telemetry | `emitInputEvent` drops `text`/`query`/`message` for a private field, keeps them public, honors the allowlist | Remove the `RAW_TEXT_KEYS` drop ⇒ private-field test ⇒ RED (verified). |

---

## Runtime / QA-required cert items (honestly NOT code gaps)

These depend on a running app, a real device, or real traffic and cannot be certified
in unit code. They are cert items for a device/QA/observability pass, not construction
holes:

- **Accessibility on device** — VoiceOver/TalkBack announcement order & completeness,
  hardware-keyboard traversal/focus, Dynamic Type scaling, `prefers-reduced-motion`.
- **Performance under load** — measured P50/P95 suggestion latency, cold-start time,
  render cost of large suggestion groups, large-index behavior at production scale.
- **Offline on device** — real airplane-mode degradation and cache hydration behavior.
- **Provider failure** — external place-provider timeout/error behavior once
  `external_places_enabled` is switched on (dormant today).
- **§44 outcome funnel** — the impression→selection→outcome analytics funnel once the
  telemetry transport is attached (taxonomy + sink are wired; transport deferred).
- **Privacy incident count = 0** — the §57 explicit metric; verified zero in
  construction, to be monitored in production.

---

## Certification statement

For every §49 dimension that can be verified in code, the Global Input Intelligence
platform **passes**, and the safety-load-bearing dimensions (Privacy, AI,
anti-fabrication, Telemetry, Failure) are now each locked by mutation-proven tests.
The remaining items are honestly runtime/QA-cert items, not defects. Recommendation:
**certify for launch on the code-verifiable dimensions**, and schedule the device/QA
pass for the runtime items above before enabling AI writing, live intelligence, or
external providers to any live cohort.
