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
