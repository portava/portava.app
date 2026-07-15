---
name: Env/secrets audit gotchas
description: Lessons from auditing Replit secrets vs app env usage in this project
---

- A plain shared env var with the same key as a secret takes effect and can carry a corrupted value (e.g. `SUPABASE_URL` had a stray "5 " prefix, crashing the Supabase client at startup). **How to apply:** when a config value looks wrong despite a correct secret, check `viewEnvVars` for a same-name non-secret env var and delete it.
- User-added secrets frequently have typo'd names (`AILINTEGRATIONS_OPENAL_API_KEY`, `EXPO_PUBLIC_SUPABASE_UR`) that code never reads. The agent cannot delete or rename secrets — request the correctly named one via `requestSecrets` and ask the user to delete the typos (including any `PORT` secret, which is workflow-assigned).
- API server validates required env at startup via `assertRequiredEnv` (fails fast, logs key names only). Local `.env` in api-server was removed; secrets are the source of truth.
- Server geocoding uses `MAPBOX_TOKEN` (optional); the Google Maps/Foursquare/MapTiler server-side keys the user added are not referenced by server code.
