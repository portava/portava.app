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
