# Portava AI Header Generation — build bundle

This bundle delivers the **server core** of the AI header/cover generation system,
already built, typecheck-clean, and unit-tested against your codebase — plus a client
image resolver, the SQL, and a reconciled agent command for the remaining client work.

## What's in here
```
apply.py                      # copies the new files in + registers the router (idempotent)
files/                        # the new source files (drift-safe: all NEW files)
  api-server/src/lib/visuals/…     service, providers, prompt builder, hash, priority, styles, sanitize, derivatives, types
  api-server/src/routes/visuals.ts API routes (/api/visuals/*)
  api-server/src/migrations/0189_generated_visuals.sql
  api-server/src/test/visuals.test.ts   (22 passing unit tests)
  travel-buddy/src/lib/visuals/resolveHeaderImage.ts   client resolver (never-imageless)
0189_generated_visuals.sql    # standalone copy of the migration
flip-flags.sql                # enable the feature flags when ready (they seed OFF)
AGENT-COMMAND.md              # reconciled handoff for the remaining client/admin/device work
```

## Apply (from your Replit shell)
```bash
cd ~/workspace          # or wherever this bundle was unzipped
python3 apply.py        # copies files + registers the router

cd ~/workspace/artifacts/api-server
npx tsc -p tsconfig.json --noEmit && echo "tsc OK"          # expect: tsc OK
SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
  node --import tsx/esm --test --test-force-exit src/test/visuals.test.ts   # expect: 22 pass
```
Then run the migration `src/migrations/0189_generated_visuals.sql` in the Supabase SQL
editor (it's additive + idempotent: creates `generated_visuals`, adds `header_image_*`
columns to `discovery_places` and `events`, seeds the flags OFF).

## Turning it on
1. `AI_INTEGRATIONS_OPENAI_API_KEY` set (+ OpenAI credits) — the key you're already adding.
2. Run `flip-flags.sql` to enable `ai_visual_provider_enabled` + `ai_event_headers_enabled`
   (leave auto-suggest / place headers OFF until beta).
3. Hand `AGENT-COMMAND.md` to your Replit agent for the client UI, card adoption, realtime,
   fallback assets, admin dashboard, and device testing.

## What's built vs. what's left
BUILT (this bundle, verified): DB schema + flags, the `VisualGenerationService`
(validate → dedupe → job → provider → derivatives → upload → apply-under-priority),
OpenAI (`gpt-image-1`) + category-fallback providers, deterministic prompt builder,
prompt-hash reuse cache, image-priority resolver + stale-guard, `/api/visuals/*` routes
with host/owner/admin authorization, WebP derivatives via sharp, and the client resolver.

LEFT (agent — see AGENT-COMMAND.md): `PlaceCard` + all cards adopting the resolver (this
is what fixes the imageless cards), `GeneratedHeaderPicker` + event-form integration,
realtime status wiring, branded fallback assets, admin dashboard, analytics, and device
testing.

## Repo bindings honored (why this differs from the generic spec)
- Env: `AI_INTEGRATIONS_OPENAI_*` (not `OPENAI_API_KEY`); model `gpt-image-1`.
- Flags: DB `feature_flags` rows, not env booleans.
- Events keep `cover_url` (no rival URL column); places get `header_image_url`.
- `generated_visuals.entity_id` is TEXT (place ids are OSM/text, not uuid).
- Reuses `sharp` + `post-media` bucket; generalizes the stamp generation pattern.
