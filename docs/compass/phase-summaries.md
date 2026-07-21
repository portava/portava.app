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

## Phase 9 — Social Intelligence (2026-07-20)

- New `src/compass/CompassSocialEngine.ts` — privacy-first social layer:
  - `getWhosAround()` — surfaces circle presence from the user's active
    trips/upcoming events, gating EVERY target through
    `canViewCirclePresence` (the same guard the Circle UI uses: consent,
    global toggle, per-context defaults, overrides, pauses, mutual blocks,
    banned/suspended, staleness). Output is approximate-only: status,
    approximate_label (approximate_area mode) or venue_label (only on
    explicit check-in in venue_checkin mode). No coordinates, no
    needs_help, no data beyond what each person chose to share.
    Hidden users (blocked / blocker / muted) are removed before any
    presence lookup; names follow the @handle-default rule via
    `nameVisibilitySet`.
  - `computeTravelCompatibility()` — deterministic 0–100 score from
    interests / travel styles / budget adjacency / pace / languages that
    reveals ONLY the overlap, never the other person's full preferences.
  - Group aggregation: `aggregateGroupPreferences` (shared interests,
    interest union by frequency, most-restrictive concrete budget,
    all-verified flag, youngest known age — computed server-side from DOB,
    which never leaves), `buildGroupRankingProfile` (block union: anyone
    blocked by ANY member is excluded for the whole group; youngest age
    drives age-gated eligibility), `eventSatisfiesGroup` (capacity for the
    whole group, age_min fail-closed when any age is unknown,
    verified_only requires every member verified).
- Three new Compass tools in `CompassTools.ts`:
  - `get_whos_around` — honest empty answers for no contexts / nobody
    sharing.
  - `get_travel_compatibility` — relationship-gated (must share a Circle
    or accepted trip, fail-closed) + trust floor (score < 20 not
    surfaced). Adversarial-uniform: strangers, blocked users, and
    nonexistent handles all get the identical "not available" answer, so
    account existence and block state are unprobeable.
  - `get_group_recommendation` — group = named Circle (membership
    verified; non-member circles indistinguishable from nonexistent ones)
    or current-trip members; candidates ranked through the Phase 7
    pipeline with the group profile and post-filtered by group
    constraints, reporting which constraints removed candidates.
- Tools prompt addendum gained SOCIAL RULES: people only from tool
  results; approximate location only, never inferred/implied precise
  location; @handle labels; non-appearance means "not shared", never
  speculate.
- Tests: new `src/test/compass-social.test.ts` (20 tests) — compatibility
  determinism + overlap-only reveal, group aggregation + every event
  constraint (incl. fail-closed unknown age), who's-around approximate
  granularity / venue-mode gating / sharing-off exclusion / DB-level
  mutual-block defense-in-depth / no coordinate or needs_help leak, and
  adversarial leak tests: blocked-user injection (presence row exists but
  never surfaces), precise-location probing (venue string never leaks
  outside explicit check-in), cross-circle probing, DOB/real-name leak
  checks.
- Standing eval set ("Find my circle", "I'm traveling alone tonight")
  run E2E against the local API with an ephemeral signed-in user: AI proxy
  unreachable from this environment, so both turns exercised the honest
  fallback (`fallback: true`, no fabricated people/candidates), matching
  Phase 5–8 precedent; social behavior is covered deterministically by the
  suite above.
- Out of scope honored: no Compass Home surfaces (Phase 10), no proactive
  social alerts (Phase 11) — chat answers only.
- Full API suite (4,489 tests incl. Phase 9) + typecheck green; mobile
  untouched.

## Phase 10 — Compass Home (2026-07-20)

- New `GET /api/compass/home` (`src/routes/compassHome.ts`) — context-aware
  home payload assembled server-side from real signals only:
  - `bestNextMove` — top item from the Phase 7 pipeline (`buildSection`
    "for_you" over hydrated candidates), flattened with explanationKey.
  - `circleActivity` — Phase 9 `getWhosAround` (every target consent-gated;
    approximate area / explicit-check-in venue only, hidden users filtered).
  - `startingSoon` — public events starting within 6 hours (same
    visibility/state guards as the `search_events` tool, hidden hosts
    filtered, city-scoped when the profile has a current city).
  - `tonightVibe` — assembled only in evening/night hours from real events
    within 12 hours, summarised by dominant category; null when nothing is on.
  - `weatherWindow` — tomorrow's Open-Meteo forecast for the current city
    with an honest indoor/outdoor headline; null without a city or forecast.
  - Time-awareness: `timeOfDay` bucket (morning/afternoon/evening/night,
    `_setTestHourUtc` test hook) drives which sections can appear; payloads
    provably differ morning vs night.
  - Honesty rules: every section is real-data-or-null — no template cards.
    COMPASS_ENABLED off → `{ compassEnabled: false, fallback: true }`.
- Mobile: `src/components/compass/CompassHome.tsx` replaces the blank-chat
  empty state in `app/(tabs)/ai.tsx`. Card stack (best next move → circle →
  starting soon → tonight's vibe → weather window) renders only sections the
  server returned; taps lead somewhere real (event/gem/post/profile screens,
  discovery) or into chat with a prefilled intent. Six core actions —
  What should I do right now / Tonight / Meet People / Build My Day /
  Surprise Me / My Trip — each prefill a grounded intent into the existing
  `send()` chat flow, so Ask Compass stays one tap away (input bar unchanged).
  `fetchCompassHome` + types added to `services/compass.ts`.
- Tests: `src/test/compass-home.test.ts` (8 tests — auth, disabled-flag
  fallback, honest empty sections, morning-vs-night divergence, 6-hour
  starting-soon window with cancelled/private exclusion, no-template-cards
  at night, bestNextMove backed by seeded data only) and mobile
  `CompassHome.component.test.tsx` (5 tests — six actions render + prefill
  via onAsk, all real-data sections render, null sections hide, event row
  navigates to the real event screen, fallback renders no data cards).
- E2E against the local API with an ephemeral signed-in user: 200 with
  `timeOfDay: night`, a real DB-backed event as bestNextMove, all empty
  sections honestly null; unauthenticated → 401. (AI proxy not needed —
  the home surface is deterministic; the standing eval set's chat flows are
  unchanged and remain covered by the Phase 5–9 fallback precedent.)
- Out of scope honored: no proactive notifications (Phase 11), no live
  session mode (Phase 12).

## Phase 11 — Compass Sense (2026-07-20)

- New `src/compass/CompassSenseEngine.ts` — proactive intelligence that is
  silent by default and speaks only on genuine, data-backed signals:
  - `saved_event_starting` — an explicitly saved event (`event_saves`)
    starts within 2 hours (cancelled/deleted states excluded).
  - `leave_earlier` — a pending route stop's planned arrival cannot be met
    by the remaining leg travel time (+10 min buffer) — `route_plans` /
    `route_stops` / `route_legs`; one timing nudge per plan.
  - `weather_change` — rain (or a clear window) in the live Open-Meteo
    forecast, and only when the in-progress trip has real plan items today
    (no plans → silence; no forecast → silence).
  - `circle_plan_change` — a meetup the user RSVPed going/maybe was
    cancelled/confirmed within the last 2 hours.
  - `free_time_block` — daytime only, on a planned day, when no plan item
    starts within 3 hours (labelled `ai_inference`; all others
    `verified_live` via Phase 8 `makeConfidence`).
- Presence & permissions, enforced server-side before anything is sent:
  Passive (default) is fully silent — signals are not even evaluated;
  Aware allows only time-critical categories (timing/events/weather,
  3/day cap); Active allows all five (6/day cap). Per-category permissions
  stored in `compass_sense_settings` are honored regardless of level.
- Over-notification protections: durable dedupe via `compass_sense_nudges`
  (same dedupe key never delivers twice in 24 h), per-day caps, and the
  user's `notification_preferences` quiet window silences every Sense nudge
  (reuses `isQuietHours`). A simulated 12-signal storm delivers exactly the
  daily cap and suppresses the rest.
- Delivery through the existing pathway: `NotificationService.create` +
  `NotificationRouter.route`, category `compass`, new
  `compass.sense.*` templates; every nudge deep-links to a real surface
  (`/event/:id`, `/route-plan/:id`, `/trip/:id`, `/meetup/:id`) with honest
  copy and the confidence snapshot in metadata.
- Routes (`src/routes/compassSense.ts`, COMPASS_ENABLED-gated with the
  honest fallback envelope): GET/PUT `/api/compass/sense/settings`,
  POST `/api/compass/sense/check`, GET `/api/compass/sense/nudges`.
- Migration `20260726_compass_sense.sql` (applied live via Management API):
  `compass_sense_settings` + `compass_sense_nudges` with own-row RLS.
- Mobile: "Compass Sense" section in `app/compass-preferences.tsx` —
  presence radio (Passive/Aware/Active) + per-category switches, backed by
  `fetchCompassSenseSettings` / `putCompassSenseSettings` in
  `services/compass.ts`; hidden when Compass is disabled.
- Tests: `src/test/compass-sense.test.ts` (16 tests — auth, disabled-flag
  fallback, default settings, PUT validation, Passive silence with genuine
  signals present, no-signal silence, saved-event window + deep link +
  confidence, leave-earlier genuine-vs-ample-time, weather only with real
  plans, category permission, aware-vs-active gating, quiet hours, dedupe,
  12-signal storm bounded at the cap, free-time daytime gate, nudge log).
  Also registered the previously unregistered `compass-home.test.ts` in the
  suite. Out of scope (per roadmap): live sessions (Phase 12), re-planning
  actions (Phase 13) — Sense flags, never fixes.

## Phase 12 — Compass Live (2026-07-21)

- New `src/compass/CompassLiveEngine.ts` — a persistent live travel session
  the user EXPLICITLY starts and stops. Companion, not surveillance:
  `runLiveCheck` returns immediately with zero evaluation and zero writes
  when no session is active; nothing runs before start or after stop.
- Session lifecycle: `compass_live_sessions` (migration
  `20260727_compass_live.sql`, applied live via Management API — own-row
  RLS, one active session per user via a partial unique index). Start is
  idempotent (a second start returns the existing session); stop marks the
  row ended and returns an end-of-session summary (duration, checks,
  nudges delivered, stops reached, city).
- Live context loop: each check recomputes rolling context against the
  day's plan (`trips` in_progress → today's `trip_plan_items`): current
  stop, next item, minutes-to-next, city (trip destination or stored
  city — city-level only, no coordinates ever read or stored). Real
  transitions are recorded as events in a capped `recentEvents` trail, so
  context provably carries across a sequence of checks.
- Signals: the Phase 11 `evaluateSenseSignals` run at live frequency, plus
  live-only session-aware nudges — `live_next_up` (next item within
  30 min), `live_arriving_early` (45 min–3 h gap → room for a detour),
  `live_ride_home` (late night 22:00–04:00 safety prompt). Starting a
  session is an explicit opt-in, so presence level does not gate live
  checks; per-category permissions, durable 24 h dedupe (shared
  `compass_sense_nudges` log), and a per-session cap (12) all still do.
  Delivery via `NotificationService` + `NotificationRouter`
  (`compass.live.*`, category `compass`, confidence in metadata).
- Routes (`src/routes/compassLive.ts`, COMPASS_ENABLED-gated with the
  honest fallback envelope): GET `/api/compass/live/session`,
  POST `/api/compass/live/start` / `stop` / `check`.
- Chat grounding: `/api/compass/ask` injects live-session context lines
  (active flag, city, current/next stop, timing, recent events) into the
  context block while a session is active; empty outside a session.
- Mobile: `CompassLive` surface at the top of the AI tab — explicit
  "Go Live" row when inactive, live card (city, now/next, delivered
  nudges) with a prominent red "End live session" button while active,
  end-of-session summary card after stop. Polls `/check` every 60 s only
  while active AND focused; the interval is cleared on stop, blur, and
  unmount — zero background activity after stop. Service functions in
  `services/compass.ts`.
- Tests: `src/test/compass-live.test.ts` (11 tests — auth, disabled-flag
  fallback, explicit/idempotent lifecycle, simulated event-sequence
  context carry across three checks, nudge timeliness windows (20 min →
  next-up, 40 min → silence, 2 h → arriving-early), late-night-only
  ride-home, category permission, durable dedupe, clean shutdown with
  summary + zero post-stop evaluation/writes, chat grounding only while
  active). Mobile: `CompassLive.component.test.tsx` (session resume
  render + explicit start-on-press only). Chat flows in the standing eval
  set are unchanged (context-line injection only) and remain covered by
  the Phase 5–9 fallback precedent.
- Out of scope honored: no automatic trip modification (Phase 13) — Live
  nudges inform; they never move items.

## Phase 13 — Trip Autopilot (2026-07-21)

- Goal: Compass keeps a trip healthy — monitor for problems, repair only
  the affected pieces, and never act without explicit user confirmation.
- Item typing: `trip_plan_items.lock_type` — `fixed` (never auto-moved,
  under any circumstances), `flexible` (movable when permitted), and
  `optional` (movable/removable when permitted). Exposed through the
  plan-item create/patch APIs (`lockType`), default `flexible`.
- Permissions: `trip_autopilot_settings` per user per trip — `enabled`,
  `allow_move_flexible`, `allow_move_optional`, `allow_remove_optional`.
  GET/PUT `/api/trips/:tripId/autopilot/settings`. Disabling autopilot
  still reports issues (honest Heartbeat) but creates zero proposals.
- Monitors (`CompassAutopilotEngine.detect*`): timing conflicts per day
  with a travel-time estimate between located items (haversine at walking
  speed, 10-min floor) producing concrete reasons ("ends 17:30, starts
  18:00 — only 30 min gap but getting there takes about 40 min");
  weather clashes (rainy forecast day × outdoor items, via the shared
  weather cache); social changes (meetup-sourced item whose meetup was
  cancelled); plus injectable disruptions (`item_cancelled`,
  `transport_delay`, `closure`) accepted by POST
  `/api/trips/:tripId/autopilot/check` so recovery is testable/demoable.
- Partial re-planner (`buildRepairProposals`): minimal changes touching
  ONLY the affected items — shift the later conflicting item (or the
  earlier one if the later is immovable), delay a delayed item, and for a
  cancelled day anchor propose cancelling it plus pulling the same day's
  next movable item up into the freed slot; everything else untouched.
  Never full regeneration. A final safety filter drops any proposal that
  would touch a fixed item.
- Propose, never execute: proposals are durable rows in
  `trip_autopilot_proposals` (before/after per item, dedupe via a partial
  unique pending index). Confirm (`POST /api/autopilot/proposals/:id/confirm`)
  re-verifies membership, lock types, and permissions at apply time —
  an item re-typed to `fixed` after proposing is refused with a reason.
  Decline resolves with zero writes. Only
  `starts_at`/`ends_at`/`day_date`/`status` are ever applyable.
- Trip Heartbeat: GET `/api/trips/:tripId/heartbeat` → status
  (healthy/attention/at_risk), active issues, upcoming weather risks,
  pending-proposal count, fixed/flexible/optional item counts, and the
  next upcoming item. Mobile `TripHeartbeatCard` on the trip screen
  (inside an error boundary, hidden on the disabled-flag fallback) with
  issue/risk rows, Apply / Keep-as-is per proposal, and a
  "Check my trip now" action.
- Migration `20260728_compass_autopilot.sql` applied live (column +
  two tables verified via information_schema).
- Tests: `src/test/compass-autopilot.test.ts` (15 tests — auth, fallback
  envelope, non-member rejection, conflict reason quality, fixed-item
  immunity at propose AND confirm time, permission bounds, disabled
  autopilot, simulated day-anchor cancellation recovery touching only
  affected items, dedupe, confirm/decline semantics, heartbeat states
  incl. weather risk). Mobile: `TripHeartbeatCard.component.test.tsx`
  (render, confirm wiring, disabled-flag hiding).
- Out of scope honored: no booking/paying on the user's behalf; no
  outcome-learning loops (Phase 14).

## Phase 14 — Outcome Learning (2026-07-21)

- Goal: track the full recommendation outcome chain — recommended →
  viewed → saved → went → stayed → liked → invited → made_memory →
  returned — compare predicted fit against realized outcomes, feed the
  delta back into ranking, and establish a "value delivered" north-star
  signal instead of engagement-time proxies.
- Outcome capture: `CompassOutcomeEngine.recordOutcome` writes
  deduplicated rows (one per user + recommendation + stage) to
  `compass_outcome_events`, each tied to the originating
  `compass_served_recommendations` row — resolved by the signed
  recommendationId token or, for organic signals, by the most recent
  served rec for the entity within 30 days. Never-recommended entities
  no-op (no phantom rows). Fire-and-forget `linkOutcomeSignal` hooks in
  existing real-signal routes: profile save (saved), event RSVP/join
  (went), GPS-verified stamps with a recommended trip/postcard (stayed),
  post/memory likes (liked), circle invites (invited), memory creation
  anchored to a recommended event/place/trip (made_memory), repeat
  recent-place visits (returned), plus the rank-events funnel route
  (tap→viewed, save→saved, join/rsvp/attended→went). Clients can also
  report stages directly via POST `/api/compass/outcomes`.
- Predicted vs actual: the Compass Match persisted at delivery time
  (`ranking_factors.compassMatch` on the served-rec row) is snapshotted
  onto each outcome event. Realized score = max stage value reached
  (viewed 15 … returned 100, same 0–100 scale). When
  |realized − predicted| ≥ 20, the user's category weight for the item
  type is nudged ±1 (bounded ±10) in
  `compass_user_preferences.category_weights` — the same per-user weight
  surface the feed builder and recommendation engine already read — so
  prediction error feeds directly back into ranking.
- Value delivered: `computeValueDelivered` aggregates the outcome chain
  into per-stage value points (weighted toward real-world outcomes:
  went 8, stayed 10, made_memory 10, returned 12 vs viewed 1), with
  served-vs-converted conversion, per-type breakdown, and prediction
  calibration (avg predicted/realized/delta, over/under-predicted
  counts). Exposed via admin-only GET `/api/compass/value-delivered`
  with `basis: "outcome_chain"` — explicitly no chat-length or
  session-time inputs.
- Migration `20260729_compass_outcome_learning.sql` applied live
  (table + indexes + RLS verified via information_schema).
- Tests: `src/test/compass-outcome-learning.test.ts` (19 tests — chain
  recording end to end, token + organic linking, dedupe, no phantom
  rows, realized-score/fit-delta math, ranking weight nudges in both
  directions with threshold, no-prediction safety, route auth +
  validation, value-delivered aggregate math and admin gating).
- Out of scope honored: no new user-facing surfaces; no intelligence
  graph (Phase 15).

## Phase 15 — Travel Intelligence Graph (2026-07-21)

- Graph substrate: `compass_graph_nodes` + `compass_graph_edges` persist a
  typed graph over People–Places–Events–Trips–Time–Vibe–Behavior–Outcomes,
  populated by batch builders in `src/compass/CompassGraphEngine.ts` from
  data the app already collects (user_stamps, trips, events,
  compass_outcome_events, rank_events — no new external data). Cross-trip
  relationships persist: repeat visits accumulate `observed_count` on the
  `visited` edge, and a second trip by the same person to the same city
  creates an explicit `returned_to` edge. Person nodes carry no profile
  attributes; privacy guards apply at read time (every read API returns
  aggregates only — no user ids, handles, or coordinates ever leave the
  graph). Rebuild is idempotent (batch upserts on typed identity keys).
- Destination World Model: `compass_city_models` holds per-city
  day-of-week × daypart activity profiles (`active_during:<category>`
  edge observations rolled up per time slice) plus monthly/seasonal
  buckets and top categories. Cebu on a Friday night genuinely differs
  from Monday morning — each slice has its own count + category mix.
  Consumed in two places: (1) ranking — `runPipeline` loads the viewer's
  city model once per call and `worldModelBoostForItem` adds a bounded
  0–5 time-aware boost (mirroring memoryBoost) with a `city_rhythm`
  ranking factor so "Why this?" stays grounded; under-sampled slices
  (<3 observations) contribute zero boost; (2) context —
  `buildDestinationContextLines` injects rhythm + seasonality lines into
  the `/api/compass/ask` prompt context.
- City-confidence index: `compass_city_confidence` scores per-city data
  depth 0–100 from aggregate signals (visitors, cross-trip returners,
  events, realized outcomes, time-slice coverage, sample size) with
  tiers deep/moderate/thin. Feeds the Phase 8 honesty surface: prompt
  context always includes an honest data-depth line
  (`cityConfidenceNote`) — deep cities answer confidently, thin cities
  say so. Exposed via GET `/api/compass/city-confidence` (auth,
  aggregates only, unknown cities default honestly to thin) and admin
  GET `/api/compass/graph/status` / POST `/api/compass/graph/rebuild`.
- Depth-first launch: live rebuild against production data ran clean
  (90 nodes, 117 edges, 23 cities modeled + scored). Strongest city
  today: London (23.78, tier thin) — and the index honestly reports ALL
  cities as thin at current data volume, exactly the intended behavior:
  confidence is earned from data depth, not asserted.
- Migration `20260730_compass_intelligence_graph.sql` applied live
  (4 tables + indexes + service-role-only RLS verified via
  information_schema).
- Tests: `src/test/compass-intelligence-graph.test.ts` (18 tests —
  cross-trip persistence, person-node privacy, idempotent rebuild,
  time-sliced world models, time-varying boost (same item, different
  time, different rank) end to end through `runPipeline`, under-sampled
  honesty, depth scoring + tiers + strongest-city selection, honest
  thin/deep notes, prompt lines free of ids/coordinates, route auth).
- Out of scope honored: no external data acquisition; no multi-city
  depth work beyond wiring the index.

---

## Roadmap wrap-up (2026-07-21)

All 15 phases of the Compass master roadmap are complete. The arc:

- **Foundation (1–4):** a real conversational endpoint with honest
  fallbacks, the four-gate pipeline (safety → eligibility → scoring →
  ranking), privacy-guarded structured context, and grounded "verified
  places only" answers.
- **Personalization (5–8):** per-user preference weights, layered memory
  with strict circle boundaries, memory-boosted ranking, and the
  confidence/honesty system (source-classed labels, "can't verify"
  notes).
- **Real-world surface (9–13):** proactive suggestions, booking
  frontloading, dual-score ranking (Compass Match with zero popularity
  inputs vs Community Score with zero viewer inputs), live in-trip
  grounding, and Trip Autopilot.
- **Proprietary intelligence (14–15):** the outcome chain
  (served → viewed → … → returned) closes the loop from prediction to
  reality and nudges ranking weights from prediction error; the
  intelligence graph, Destination World Model, and city-confidence
  index make Portava's answers improve with every stamp, trip, event,
  and outcome the community records — independent of the underlying
  model. Deep cities will answer confidently because the data earned
  it; thin cities say so honestly until it does.

The system is designed to compound: every phase's signals feed the
graph, and the graph feeds ranking, context, and honesty. Next
frontier work (multi-city depth, richer seasonal models, graph-driven
buddy matching) can build on this substrate without schema changes.

---

## Live answer-quality eval attempt (2026-07-21)

Attempted to run the standing 9-question eval set against the live model
via `POST /api/compass/ask` with a signed-in ephemeral user (admin-created,
deleted after). Outcome: **blocked — the AI proxy is still unreachable**,
identical to the Phase 5 attempt.

Evidence gathered:
- Direct proxy probe (`$AI_INTEGRATIONS_OPENAI_BASE_URL/chat/completions`,
  localhost:1106 modelfarm) returns `404 Replit AI Integrations is not
  configured` for every model tried.
- Through the running dev server, `/api/compass/ask` returns the honest
  fallback (`fallbackReason: "ai_error"`); server logs show the same 404
  from the OpenAI SDK inside `runToolCallingLoop` — the compass-v1.1
  prompt path is reached, only the upstream model call fails.
- The `AI_INTEGRATIONS_OPENAI_*` secrets exist; the failure is the proxy
  service itself, which a task environment cannot provision (the
  integration setup callback is unavailable here — it must be run from
  the owner's main workspace session).
- Production (`portava.replit.app`) responds on `/api/compass/ask` but
  with the legacy pre-v1.1 response shape (`bestPick`/`socialProof`),
  i.e. the deployed build predates the compass-v1.1 contract, so prod
  cannot exercise block declaration either.

No block-type / hallucination / conversational-quality observations could
be recorded — no live model turn occurred. Positive note: the honest-
fallback guarantee held on every turn (no fake AI output). The eval should
be re-run after the OpenAI AI integration is enabled from the main
workspace session (and/or a fresh build is published).
