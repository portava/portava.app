/**
 * Type stub for ./ciProdReadOnlyAuditGuard.mjs.
 *
 * Same reason as ./ciSupabaseGuard.d.mts: the guard front doors are authored as
 * plain ESM JavaScript rather than TypeScript so they are runnable and
 * importable by a bare `node`, with no tsx, no loader and no build step — which
 * is what makes both the refusal path and the read-only audit path exercisable
 * and verifiable directly (`node src/lib/ciProdReadOnlyAuditGuard.mjs`).
 * `allowJs` is off in tsconfig.base.json, so this declaration is what lets the
 * four read-only audit entry points under src/scripts/ write
 * `import "../lib/ciProdReadOnlyAuditGuard.mjs";` and still typecheck.
 *
 * The module exports nothing. It is imported purely for its import-time side
 * effect: assert the Supabase target, or exit 2. `export {}` marks this file as
 * a module (rather than a global script) while declaring exactly that empty
 * public surface.
 */
export {};
