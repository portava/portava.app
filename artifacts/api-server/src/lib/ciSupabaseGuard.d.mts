/**
 * Type stub for ./ciSupabaseGuard.mjs.
 *
 * The guard is authored as plain ESM JavaScript rather than TypeScript for one
 * reason: it must be runnable and importable by a bare `node`, with no tsx, no
 * loader and no build step, so that the refusal path can be exercised and
 * verified directly. `allowJs` is off in tsconfig.base.json, so this
 * declaration is what lets the five checked entry points under src/scripts/
 * write `import "../lib/ciSupabaseGuard.mjs";` and still typecheck.
 *
 * The module exports nothing. It is imported purely for its import-time side
 * effect: assert the Supabase project allowlist, or exit 2. `export {}` marks
 * this file as a module (rather than a global script) while declaring exactly
 * that empty public surface.
 */
export {};
