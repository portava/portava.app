---
name: Expo dotenv overrides Replit secrets
description: Expo CLI's built-in dotenv loader runs when expo start launches and overwrites Replit process env secrets with values from .env. Fix pattern for Travel Buddy.
---

## The rule

Expo CLI has its own dotenv loader (dotenv-flow) that runs when `expo start` executes. It loads `.env` and sets `EXPO_PUBLIC_*` vars, **overwriting** any Replit secrets already in `process.env` that share the same name. The bundled app gets the `.env` values, not the Replit secrets.

**Why:** Expo inlines `EXPO_PUBLIC_*` at bundle time from its own env snapshot, not from the workflow process env.

**How to apply:** Never rely on Replit secrets alone for `EXPO_PUBLIC_*` vars in Expo projects. Use one of:
1. **Preferred — `.env.local` written in `predev`:** The `predev` npm script runs before Expo CLI starts, so Replit secrets are still intact. Write a `.env.local` file using `printf` with the real values (`$SUPABASE_URL`, `$EXPO_PUBLIC_SUPABASE_ANON_KEY`, `$REPLIT_DEV_DOMAIN`). Expo prioritizes `.env.local` over `.env` so real values win. `.env.local` is already gitignored via `.env*.local`.
2. Put real (non-secret) values directly in `.env` — fine for public keys like Supabase anon key and Supabase URL.

## Travel Buddy specifics (artifacts/travel-buddy)

- `predev` in `package.json` writes `.env.local` before expo start
- `EXPO_PUBLIC_SUPABASE_URL` comes from `$SUPABASE_URL` (Replit secret, server-side name)
- `EXPO_PUBLIC_SUPABASE_ANON_KEY` comes from `$EXPO_PUBLIC_SUPABASE_ANON_KEY` (Replit secret)
- `EXPO_PUBLIC_API_BASE_URL` comes from `https://$REPLIT_DEV_DOMAIN` (dynamic per session)
- `.env` retains placeholder values — that's intentional so the file is safe to commit

## Diagnosis tip

If `process.env.EXPO_PUBLIC_*` look wrong in the bundle, grep the pre-warmed bundle file for the value — you'll see both `.env` and `.env.local` values if both are loaded; the inlined module code (not the HMR block) shows which one wins.
