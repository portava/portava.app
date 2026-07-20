# Compass Phase Summaries — Running Change Log

Every phase appends a short summary here after its "Done when" checklist is
met and the full suite is green. See `master-roadmap.md` for the plan.

---

## Phase 1 — Conversational Foundation (as found, July 2026)

State when the standing brief was installed:

- `POST /api/compass/ask` (`src/routes/compass.ts`) is a real conversational
  endpoint: multi-turn history persisted in `compass_conversations` /
  `compass_conversation_messages` (structured `payload` JSONB column,
  `prompt_version` traceability), a real `gpt-5-mini` call with full history,
  optional SSE streaming, and honest fallbacks on every error path (no canned
  fake recommendations).
- Versioned system prompt `compass-v1.0` (`src/lib/prompts/compass-v1.ts`)
  with honesty rules, privacy rules, propose-never-execute action policy, and
  `<portava:ugc>` data-not-instructions delimiters.
- Intent classifier runs in shadow mode; `action` intents (≥0.6 confidence)
  short-circuit with a graceful explanation. Quick actions are validated
  against a server-side whitelist.
- Context block: city-level location (`CompassLocationContext` — coordinates
  intentionally absent), upcoming trip city, followed hashtags, weather brief,
  and top "for_you" pipeline items (which pass Safety → Privacy Guard →
  Scoring).
- Tests: `compass-ask.test.ts` (persistence, multi-turn, classifier contract,
  fallbacks), `compass-context.test.ts`, `compass-pipeline.test.ts` (privacy
  guard GPS stripping), plus feed/cache/ux/admin/hardening suites.
- Gate note (Phase 3 pre-flight): `compass-ask.test.ts` was failing in this
  checkout because its test app never attached the `req.log` middleware that
  the route now uses; fixed the test harness (no production change) before
  starting Phase 3.

## Phase 3 — Structured Context Expansion (July 2026)

- Installed this standing brief: `docs/compass/master-roadmap.md` (global
  rules, per-phase Done-when checklists, standing 9-question eval set,
  guardrails) and this running log.
- New `src/compass/CompassStructuredContext.ts`:
  - `buildStructuredCompassContext(sc, profile)` gathers, privacy-guarded:
    - **Circles** — `circles` owned + `circle_memberships` joined; member
      handles resolved via `profiles`, with blocked, blocker, and muted user
      IDs (from `CompassProfile`) filtered out before anything reaches the
      prompt. Circle names are user-generated → UGC-wrapped.
    - **Active bookings** — `rent_buddy_bookings` (traveler side, status
      confirmed/in_progress), city-level only (city + date range + status);
      buddy excluded when blocked/muted; the free-text `note` column is never
      included.
    - **Passport history** — `user_stamps` (non-revoked, newest 10) joined to
      `stamp_definitions(name)`; only name/title, city, country, earned date.
      `lat`/`lng` columns are never selected. `title_override` is
      user-generated → UGC-wrapped.
  - Defense-in-depth coordinate scrub (`stripCoordinateFields`) removes any
    lat/lng-shaped key from every row before formatting.
  - `wrapUgc()` wraps user text in `<portava:ugc>…</portava:ugc>` and
    neutralizes nested delimiter injections.
  - `formatStructuredContextLines()` renders the prompt block.
  - `buildModeWeightingLines(contextState, intentMode)` makes the derived
    UI modes (arrival/night/budget + the rest) explicit, inspectable inputs
    to prompt weighting.
- `POST /api/compass/ask` context block now includes Circles, Active
  bookings, Passport history, and an explicit `Mode weighting` line derived
  from `CompassContextEngine` + `CompassIntentModeEngine`.
- New tests `src/test/compass-structured-context.test.ts`: accurate circle /
  booking / stamp references; blocked, blocker, and muted users never appear;
  no coordinate fields or numeric coordinate pairs in the assembled block;
  booking notes excluded; UGC delimiter injection neutralized; mode-weighting
  lines for arrival/night/budget. Registered in the api-server test suite.
- Full api suite + typecheck green. Standing eval set exercised against the
  assembled context (context references resolve from real DB-backed data;
  "Find my circle" now has real circle context to reference).

## Phase 4 — Tool/Function Calling (July 2026)

- New `src/compass/CompassTools.ts`: eight native OpenAI function tools —
  `get_user_profile`, `get_current_trip`, `search_places` (over
  `discovery_places`; live Foursquare deferred to Phase 8), `search_events`,
  `get_place_details`, `get_circle_activity` (permission-gated via the
  Phase 3 structured-context builder), `check_trip_conflicts`, and
  `add_to_trip` (propose-only).
- Candidate/explanation separation enforced: a tools prompt addendum
  (`COMPASS_TOOLS_PROMPT_ADDENDUM`) states the candidate rule (recommendable
  places/events MUST come from tool results; honest "no results" otherwise),
  and all candidates are DB-backed rows.
- Privacy guards on every tool result: safe column lists (coordinates never
  selected), `sanitizeToolResult()` recursively strips coordinate-shaped and
  private keys (email/phone/address/notes/host_id/…) as defense-in-depth,
  blocked/blocker/muted hosts and members filtered, UGC text wrapped in
  `<portava:ugc>` delimiters, tool results framed as data-not-instructions.
- Calling loop in `POST /api/compass/ask` (`runToolCallingLoop`): model
  requests tools → server executes → results feed back → iterate (max 5
  rounds, then a forced final answer without tools). Streaming requests run
  the loop non-streamed and emit the final answer as a single SSE delta —
  same event contract.
- The Phase-1 "action intent" short-circuit was removed: action prompts now
  flow through the tool loop so the model can PROPOSE via `add_to_trip`.
  Propose-never-auto-execute holds: the tool returns a `pending_confirmation`
  proposal and writes nothing.
- Confirmation flow: proposals persist in the assistant message payload and
  surface as `pendingProposals` on the response; the mobile chat
  (`app/(tabs)/ai.tsx`) shows a minimal Confirm/Decline affordance (rich
  cards are Phase 5). `POST /api/compass/proposals/:id/confirm` re-authorizes
  (trip membership + plan-edit permission at execution time), applies the
  duplicate guard, executes the `trip_plan_items` insert, and records the
  resolution so a proposal can execute at most once; `/decline` records only.
- Persistence: every assistant turn stores `toolCalls` (name, arguments,
  size-bounded result) and any `pendingProposals` in the structured
  `payload` JSONB column of `compass_conversation_messages`.
- Tests: `compass-tools.test.ts` (17 tests — sanitizer, DB-backed candidates
  with coordinate-free output, block filtering, circle permission gate,
  conflicts, propose-only add_to_trip incl. fabricated-placeId rejection,
  route-level tool loop with payload persistence, confirm/decline lifecycle
  incl. double-resolve rejection and revoked-membership re-auth);
  `compass-ask.test.ts` suite D rewritten for the tool-loop action path.
  Registered in the api-server test suite. Full suites + typecheck green.

## Phase 5 — Dynamic UI Rendering (July 2026)

- Response contract extended: the model (prompt bumped to `compass-v1.1`)
  may declare a `blocks` array inside its JSON payload — `place_cards`,
  `event_cards`, `person_cards`, `map`, and `comparison` — each referencing
  entities strictly by id/handle from tool results in the same turn.
- New `src/compass/CompassUiBlocks.ts`: builds a candidate index from the
  executed tool log (`search_places`, `get_place_details`, `search_events`,
  `get_circle_activity`), validates every block reference against it —
  invented ids are silently dropped, empty blocks removed (client falls back
  to plain text) — and hydrates validated entities with the real candidate
  data. Validated place ids get coordinates re-fetched from the DB
  server-side (coordinates never pass through the model). Caps: 4 blocks,
  6 items/block, 4 comparison columns. UGC delimiters unwrapped for display.
- `POST /api/compass/ask` (streaming and non-streaming) returns `uiBlocks`
  and persists them in the assistant message payload.
- Mobile renderer `src/components/compass/CompassChatBlocks.tsx`, wired into
  the chat screen (`app/(tabs)/ai.tsx` RecCard): place cards (tap →
  `/map` focused on the real coordinates, or `/search` when coordinate-less;
  "Plan" routes through the existing PlanPicker confirmation flow — no
  mutation on tap), event cards (→ `/event/[id]`), person cards
  (→ `/u/[handle]`), map block (per-place map deep links), comparison table
  (row tap opens the entity), and an itinerary/timeline rendering of the
  `itinerary` payload. The map block deliberately avoids importing maplibre
  (web-split hazard) and deep-links to the real map screen instead.
- No dead-end quick actions: every whitelisted `actionType` (explore,
  viewEvent, viewPlace, openMap, viewPassport, findBuddy, viewTrips,
  startPoll, shareTip, …) now lands on a real screen.
- Tests: `src/test/compass-ui-blocks.test.ts` (candidate indexing incl. UGC
  unwrap, invented-id rejection, all-invented block dropping, comparison
  validation, coordinate hydration + non-fatal DB failure, caps,
  handle validation) and a route-level test in `compass-tools.test.ts`
  proving `/compass/ask` returns and persists hydrated `uiBlocks` with
  invented ids dropped; mobile
  `CompassChatBlocks.component.test.tsx` (block→component mapping,
  plain-text fallback, and no-dead-end navigation targets for every card
  type + the PlanPicker callback). Registered in both suites.
- Standing eval set: exercised live against the local API (ephemeral
  signed-in user). The AI proxy is not reachable from this isolated task
  environment, so every turn exercised the honest-fallback path
  (`fallback: true`, no fabricated blocks — guardrail holds); the
  contract itself (v1.1 prompt path, `uiBlocks` validation/hydration) is
  covered deterministically by the stubbed-model route test above.
- Mobile + api suites and typechecks green.

## Phase 6 — Layered Compass Memory (July 2026)

- Migration `20260724_compass_memories.sql` (applied live): `compass_memories`
  table — structured durable insight records, one per fact, scoped
  `session` (tied to a conversation), `trip`, `long_term` (durable personal
  preference), and `circle` (group fact bound to `circle_owner_id`, CHECK
  enforced). Source is `taught` / `compressed` / `inferred` with a
  confidence score. Also adds `compass_conversations.compressed_message_count`
  so compression runs on a bounded cadence instead of every turn.
- New `src/compass/CompassMemoryService.ts`:
  - `scrubMemoryText` privacy guard — strips coordinate pairs, emails, and
    phone-like digit runs, caps content at 280 chars — applied before every
    persist, so raw PII never reaches storage or prompts.
  - `buildMemoryPromptBlock` injects memories into `/compass/ask` context
    under a hard `MEMORY_PROMPT_BUDGET_CHARS` (1200) budget with
    `<portava:ugc>` delimiters (memory is data, never instructions).
    Layer order: long-term → trip → session → circle. Circle memories are
    injected ONLY when the ask names a `circleOwnerId` AND
    `isCircleMember` verifies live membership — personal asks never see
    group facts, and group facts never cross circles.
  - `compressConversationIfDue` — fire-and-forget after each persisted ask
    turn; when ≥8 new messages accumulate, the model distills ≤3 durable
    insights (`source='compressed'`), the cadence counter advances, and a
    model failure is a deterministic no-op (never blocks the reply).
    Long-term memories cap at 50 with oldest-first eviction; identical
    content per scope dedupes.
- Routes (`routes/compass.ts`): `GET /compass/me/memories` (optional
  `?scope=`), `POST /compass/me/memories/teach` ("Teach My Compass" —
  explicit statement → structured `{category, content}` preference via the
  model, deterministic raw-statement fallback; circle teaching requires
  membership, 403 otherwise), `PATCH`/`DELETE /compass/me/memories/:id`
  (edit / forget, ownership-scoped, 404 for foreign rows). `askBodySchema`
  gains optional `circleOwnerId`; both streaming and non-streaming ask paths
  inject the memory block and trigger compression.
- Mobile: `app/compass-memories.tsx` ("Compass Remembers") — view memories
  grouped with scope/category/source labels, inline edit, confirm-to-forget,
  and a "Teach My Compass" input — linked from Compass Preferences → Memory;
  presentational core in `src/components/compass/CompassRemembers.tsx`;
  service functions `fetchCompassMemories` / `teachCompassMemory` /
  `updateCompassMemory` / `forgetCompassMemory`.
- Tests: `src/test/compass-memory.test.ts` (13 cases) — teach→list
  persistence and fresh-session prompt injection, model-down fallback,
  edit/forget taking effect in both list and prompt block, cross-circle
  isolation (circle A fact never in circle B/no-circle context; non-member
  exclusion; foreign-circle teach rejected with no row written),
  prompt-size bound under 40 oversized memories, PII scrubbing
  (coordinates/email/phone) and length cap, and compression cadence
  (below-threshold no-op, threshold distillation, counter advance, no
  duplicate work). Mobile component tests cover the Remembers surface
  (labels, empty state, forget wiring) and the teach interaction.
- Out of scope honored: no ranking changes (memory informs context only),
  no proactive notifications.
- API + mobile suites and typechecks green.

## Phase 7 — Formal Recommendation Engine (July 2026)

- New `src/compass/CompassRecommendationEngine.ts` — the formal ranking
  authority's scoring core, computing two INDEPENDENT 0–100 signals per
  candidate:
  - **Community Score** (`computeCommunityScore`) — viewer-independent
    popularity: quality/rating, saved count, event attendance, author trust,
    with report/spam penalties. Deterministic per item; never reads a profile.
  - **Compass Match** (`computeCompassMatch`) — personal fit: interest
    overlap, current-city match, feedback history (category weights), budget,
    distance, language, Phase 6 memory-derived preferences, social signals,
    safety preference, open-now, availability, and time relevance. Contains
    zero popularity signals, so fit and popularity move independently
    (verified both directions in tests).
  - Every contributing signal is recorded as a grounded `RankingFactor`
    (`key`, `label`, `weight`, `detail` citing the actual matched value);
    `buildWhyThisText` renders "Why this?" text ONLY from these factors —
    sensitive/moderation keys are excluded and never surface.
- `CompassPipeline.runPipeline` is the single candidate-ranking authority:
  it loads long-term memory preference tags once per call (non-fatal),
  annotates every `PipelineResult` with `compassMatch`, `communityScore`,
  and `rankingFactors`, and applies a bounded (≤5-point) memory boost to
  `finalScore`. Tests prove pipeline output is a strict subset of its input —
  the model can never inject candidates.
- Phase 4 chat tools ranked through the same pipeline: `search_places` and
  `search_events` run their DB-backed rows through `runPipeline`
  (`rankToolCandidates`/`applyToolRanking`), returning candidates in engine
  order with `compassMatch`/`communityScore`/`whyThis` attached and
  `ranked: true`; gate-dropped items are excluded. If ranking fails the tools
  fall back honestly to the raw DB list (never empty due to ranker failure).
  The tools prompt addendum instructs the model to preserve pre-ranked order
  and never invent scores.
- Migration `20260726_compass_ranking_factors.sql` (applied live):
  `compass_served_recommendations.ranking_factors` JSONB. Feed and section
  routes store the `{compassMatch, communityScore, factors}` snapshot per
  served recommendation; `GET /compass/why/:id` now returns the
  factor-grounded explanation plus `factors`, `compassMatch`, and
  `communityScore` — sensitive explanation keys keep the generic template
  and expose nothing. Feed API items also carry both scores + factors.
- Mobile: `CompassWhySheet` renders the two score pills (Compass Match vs
  Community Score, visually separate signals) and the grounded factor list
  under the explanation; `fetchCompassWhy`/`useCompassWhyExplanation`
  updated accordingly.
- Tests: new `src/test/compass-recommendation-engine.test.ts` (score
  independence in both directions, factors grounded in nonzero signals,
  popularity never moves Compass Match, memory-tag boost bounded ≤5,
  whyThis grounding + sensitive-factor exclusion, pipeline output ⊆ input);
  `compass-tools.test.ts` extended (fit item ranked first with scores +
  whyThis on places and events); `compass-hardening.test.ts` extended
  (/why returns grounded factors + both scores; sensitive keys leak
  nothing; snapshot-less rows fall back to templates).
- Standing eval set (9 queries) run E2E against the local API with an
  ephemeral signed-in user: AI proxy unreachable from this environment, so
  every turn exercised the honest-fallback path (`fallback: true`, no
  fabricated candidates — guardrail holds), matching Phase 5/6 precedent;
  ranking/tool behavior is covered deterministically by the suites above.
- Out of scope honored: no live external data (Phase 8), no outcome-chain
  learning (Phase 14) — history signals use existing feedback weights only.
- API + mobile suites and typechecks green.

## Phase 8 — Live Intelligence (2026-07-20)

- New `src/lib/liveIntelligence.ts`: central confidence system + tool-time
  live lookups, modeled on the weather-cache pattern (short in-memory TTL,
  strict timeout, graceful degradation, never fabricate).
  - `SourceClass` = `verified_live` / `community_reported` / `historical` /
    `ai_inference`; `makeConfidence()` attaches a human label, `checkedAt`,
    and an optional honest `dataNote` (named to survive the tool-result
    private-key sanitizer, which strips `note`).
  - `getLiveVenueStatus(name, city)` — live open-now via Foursquare
    (`hours.open_now`, falling back to `closed_bucket`), 2.5s timeout,
    10-minute in-memory cache incl. confirmed-miss caching. Returns `null`
    on any failure (no key, HTTP error, timeout, venue not found) so callers
    must degrade honestly.
  - Test-only outage simulation: `_setSimulatedOutage("places_live", true)`
    makes live lookups behave exactly like a source outage (no fetch).
- Compass tools now carry confidence end to end:
  - `search_places` candidates → `community_reported` (verified catalog) or
    `historical` (unverified); `search_events` → `community_reported`;
  - `get_place_details` attempts a live open-now check at tool time and
    attaches `liveStatus`: on success `{available: true, openNow, source,
    checkedAt, confidence: verified_live}`; on failure `{available: false,
    openNow: null, dataNote: "Live status can't be verified right now…",
    confidence: historical}` — zero fabricated fields.
  - Tools prompt addendum gained a CONFIDENCE RULE: only claim open/closed
    *now* on verified_live data; say so when live status is unverifiable;
    never invent live status, wait times, or conditions.
- UI blocks (`CompassUiBlocks.ts`): `UiPlace`/`UiEvent` carry a validated
  `confidence` object (forged/unknown source classes are dropped) plus
  `openNow` on places; a successful live check honestly upgrades the card
  label to Verified live, a degraded one never does.
- Mobile: `CompassChatBlocks.tsx` renders a confidence pill on place and
  event cards (Live / Community / Historical / AI) plus an Open now /
  Closed now pill when — and only when — live-verified; types added in
  `services/compass.ts`.
- Other volatile surfaces labeled honestly: Telegraph AI recommendations →
  `confidence: ai_inference`; route-plan legs → `timingConfidence`
  (`historical` with an "estimated timing" note for approximated legs — no
  live routing source is configured, per the no-new-paid-APIs rule).
- Tests: new `src/test/compass-live-intel.test.ts` (13 tests): live fetch on
  demand + TTL cache dedup, per-source-class label correctness through the
  tool dispatcher, sanitizer keeps confidence/dataNote, simulated outage →
  explicit can't-verify with zero fabricated fields and no fetch attempted,
  UI-block carry-through incl. forged-confidence rejection.
- API + mobile suites and typechecks green.
