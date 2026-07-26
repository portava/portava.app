# PORTAVA AI HEADER GENERATION — AGENT HANDOFF (reconciled with the codebase)

The server core of this system is **already built, typecheck-clean, and unit-tested**
(see "ALREADY BUILT" below). Your job is the remaining **client UI, realtime wiring,
card adoption, admin dashboard, fallback assets, and device testing** — plus honoring
the repo-specific bindings. Do NOT rebuild the server service, provider, migration, or
resolver; extend and wire them.

---

## REPO-SPECIFIC BINDINGS (read first — these override the generic spec)

1. **Env vars use the existing convention.** The image provider reads
   **`AI_INTEGRATIONS_OPENAI_API_KEY`** and **`AI_INTEGRATIONS_OPENAI_BASE_URL`**
   (same as the stamp system). Image model is **`gpt-image-1`**, overridable via
   `AI_IMAGE_MODEL`. Do NOT introduce `OPENAI_API_KEY` / `AI_IMAGE_PROVIDER`.
2. **Feature flags are DB rows, not env booleans.** They live in the `feature_flags`
   table and are read with `isFlagEnabled(sc, 'flag')` (fail-closed). Migration 0189
   already seeds them OFF: `ai_visual_provider_enabled`, `ai_event_headers_enabled`,
   `ai_event_auto_suggest_enabled`, `ai_place_headers_enabled`, `ai_trip_covers_enabled`,
   `ai_visual_regeneration_enabled`, `ai_visual_admin_review_enabled`. The client may
   receive safe on/off states, but the server enforces every flag.
3. **Events already have `cover_url` + `cover_media_type` (migration 0151).** Do NOT
   add a rival `header_image_url` to events. 0189 adds generation METADATA columns
   (`header_image_source/status/generated_id/attribution/updated_at`) and the service
   writes the resolved URL back into the existing `cover_url`. **Places
   (`discovery_places`) have no image column**, so they get a full `header_image_url` set.
4. **`generated_visuals.entity_id` is TEXT, not uuid** — `discovery_places` ids are
   OSM/text, not uuids. Keep it text everywhere.
5. **Reuse the existing image tooling.** `sharp` is already a dependency and
   `src/lib/mediaProcessing.ts` exists. Derivatives use `src/lib/visuals/derivatives.ts`
   (already built on sharp). Reuse the existing **`post-media`** storage bucket
   (override via `AI_VISUAL_BUCKET`) under a `generated-visuals/…` path — don't make a
   new bucket unless there's a real reason.
6. **This generalizes the stamp generation pattern.** The provider abstraction mirrors
   `src/lib/stamps/imageProvider.ts` and reuses the shared `lib/openai.ts` client. Keep
   `stamp_artwork` reachable as one purpose of the same system; do not fork a parallel
   generation stack.

---

## ALREADY BUILT (server) — do not recreate

api-server:
- `src/migrations/0189_generated_visuals.sql` — `generated_visuals` table (+ indexes,
  partial-unique idempotency index, RLS deny-all-to-anon), `header_image_*` columns on
  `discovery_places` and `events`, and the seven feature-flag rows (seeded OFF).
- `src/lib/visuals/types.ts` — all contracts (purposes, sources, statuses, provider
  interface, `ResolvedHeaderImage`).
- `src/lib/visuals/styles.ts` — the 10-style system + `coerceStyle` (server-only style
  text; client sends only the style ID).
- `src/lib/visuals/sanitize.ts` — PII/banned-key stripping + text/enum/list normalizers.
- `src/lib/visuals/promptHash.ts` — canonical snapshot + stable sha256 cache key.
- `src/lib/visuals/promptBuilder.ts` — deterministic event/place/generic prompt builders
  with shared safety/negative constraints (no title text, representation labeling).
- `src/lib/visuals/priority.ts` — the image-priority resolver + `mayApplyGenerated`
  stale-guard.
- `src/lib/visuals/derivatives.ts` — sharp → WebP master/hero/card/thumbnail/share.
- `src/lib/visuals/providers/openaiImageProvider.ts` — gpt-image-1 via the shared client.
- `src/lib/visuals/providers/categoryFallbackProvider.ts` — static category fallbacks.
- `src/lib/visuals/service.ts` — `VisualGenerationService`: `requestGeneration()`
  (validate flags + usage limits, load canonical entity, sanitize, build prompt+hash,
  reuse-cache, create job) and `processJob()` (provider → derivatives → upload →
  finalize → apply-to-entity under priority rules). Idempotent via the unique index.
- `src/routes/visuals.ts` — `POST /api/visuals/generate`, `GET /api/visuals/:id`,
  `GET /api/visuals/entity/:type/:id`, `POST /:id/regenerate`, `POST /:id/accept`,
  `DELETE /:id`. Authorization: event→host, trip→owner, place→admin. Registered in
  `src/routes/index.ts`.
- `src/test/visuals.test.ts` — 22 passing unit tests (prompt builder, hash, priority,
  sanitize, styles, fallback).

travel-buddy:
- `src/lib/visuals/resolveHeaderImage.ts` — pure client resolver mirroring the server
  priority ladder, with a category-fallback tail so a card is never imageless, plus
  `candidatesFromEntity()`.

**Verify the server before building client work:**
```
cd ~/workspace/artifacts/api-server
npx tsc -p tsconfig.json --noEmit && echo "tsc OK"
SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
  node --import tsx/esm --test --test-force-exit src/test/visuals.test.ts
```

---

## WHAT YOU MUST BUILD (client + integration + ops)

### 1. Card & detail adoption (highest priority — fixes the imageless cards)
Route EVERY place/event image through `resolveHeaderImage()` (client) or the normalized
`header_image_url` / `cover_url` field. Concretely:
- `src/components/discovery/PlaceCard.tsx` currently renders **no `<Image>` at all** —
  add a header image element that uses the resolver, with the category fallback so OSM
  places (which will never have a Foursquare photo) still look finished.
- Apply the resolver in: Pulse, Discovery, Search, Compass/For-You, event cards, event
  detail, place cards, place detail, map preview/popups, trips, saved places, city
  guides, nearby, notifications, share previews. No screen guesses its own image.
- Add the **"AI-generated representation"** label + info-menu copy wherever
  `resolved.isRepresentation === true` (AI place images only).

### 2. Event creation/edit integration
- Build a reusable **`GeneratedHeaderPicker`** component: current image + source badge;
  actions Upload / Generate / Regenerate / Change style / Accept / Replace / Remove; and
  the states `not_requested | queued | generating | ready | failed | blocked | replaced`
  (designed skeleton + fallback while generating). Never freeze the form; never block
  publish. A user upload always overrides generated imagery.
- Wire it into the event create form and the event edit "your details changed —
  update header?" prompt (major-field detection). Auto-suggest only when
  `ai_event_auto_suggest_enabled` is on and the user hasn't uploaded.

### 3. Realtime
- Subscribe to generation status transitions for the entity (use the app's existing
  realtime mechanism) and update cards/detail without a full reload: preserve scroll,
  preload, fade fallback→generated, and never let a stale generated result overwrite a
  newer user upload (compare source priority + `header_image_updated_at`).

### 4. Category fallback assets
- Produce the branded static fallback images the providers reference
  (`generic-place`, `generic-event`, `restaurant`, `cafe`, `nightclub`, `cocktail-bar`,
  `hotel`, `beach`, `landmark`, `attraction`, `shopping`, `wellness`,
  `outdoor-adventure`, `festival`, `meetup`, `concert`, `food-event`, `sports-event`)
  as WebP, and wire `fallbackUrlFor` (client) / `AI_VISUAL_FALLBACK_BASE` (server) to
  them. They must look intentional and contain no fake venue details.

### 5. Admin dashboard
- Add an admin area for generated visuals: counts (today, by type, success/fail/blocked/
  reused), avg attempts, est. cost, provider status, queue depth, avg duration, top
  styles, regeneration rate, user reports, place representations awaiting review, storage
  use. Actions: view entity / snapshot / sanitized prompt / history, disable, replace,
  mark place image verified, regenerate, block-entity, suspend-user, and the global
  event/place/provider kill switches (flip the `feature_flags` rows). Restrict prompt +
  moderation metadata to admins. Gate behind `ai_visual_admin_review_enabled`.

### 6. Worker/queue hardening (optional but recommended)
- `processJob()` currently runs fire-and-forget from the route. If you want durability
  across restarts, enqueue via the same pattern the **stamp generation queue** uses
  (`src/lib/stamps/generationWorker.ts`) with bounded exponential-backoff retries
  (`AI_VISUAL_MAX_RETRIES`), and do NOT retry `blocked`/`invalid` outcomes.

### 7. Analytics + observability
- Emit the safe events (`visual_generation_requested/queued/started/completed/failed/
  blocked/reused/accepted/regenerated/replaced/removed/reported`) with identifiers +
  categorical metadata only — never prompts, descriptions, or secrets. Structured logs
  per the spec's OBSERVABILITY section; no keys, no signed URLs.

### 8. Testing (client + device)
- UI tests: event form picker, generation loading, publish-while-generating,
  background/resume, accept/regenerate/replace/remove, daily-limit state, failure state,
  place representation label, responsive cards, map popup rendering.
- Device: iPhone + Android + web — upload, generate, background/resume, realtime
  completion, feed update, card/hero cropping, slow network, offline recovery, restart
  during generation, duplicate taps, account switching.

---

## PROVISIONING (owner — you already have most of this)
- Set `AI_INTEGRATIONS_OPENAI_API_KEY` (+ credits) — the same key being set up now.
- Flip the `feature_flags` rows ON when ready (see `flip-flags.sql` in this bundle;
  recommended first: `ai_visual_provider_enabled` + `ai_event_headers_enabled`, keep
  auto-suggest and place headers off until beta).
- Follow the spec's staged rollout: Stage 1 (migration + admin-only generate) →
  Stage 2 (manual "Generate with AI" on events) → Stage 3 (auto-suggest + limits) →
  Stage 4 (place representations + labels) → Stage 5 (trips/city guides/more styles).
  Every stage reversible via its flag.

## ACCEPTANCE (unchanged from the spec)
User can generate an event header and can upload instead; upload always wins; publish is
never blocked; places with no real image get a labeled representation; images are stored
permanently and never regenerated on card render; duplicate requests don't double-charge;
accepted images appear consistently everywhere including map popups; provider secrets stay
server-side; input/output moderation + usage/cost controls + kill switches all work; a
verified real image replaces a representation; and typecheck/lint/tests/build all pass.
