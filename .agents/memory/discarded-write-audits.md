---
name: Discarded Supabase write audits
description: How to find statement-position writes whose { error } is ignored, and the fatal-vs-best-effort fix policy used across api-server.
---

# Finding discarded writes

Single-line grep misses multiline chains. Use BOTH:

1. `grep -rn -E '^\s*await [a-zA-Z_.()!]+\.from\(' src | grep -v 'const {'` — single-line statement-position writes.
2. `grep -rn -A1 -E '^\s*(void )?await [a-zA-Z_.()!]+\s*$' src | grep -B1 '\.from('` — bare `await client` on its own line with `.from(` on the next (multiline builder chains). Filter to `.update/.insert/.delete/.upsert` to skip selects.

**Why:** supabase-js never throws — a discarded builder result means the route returns 200 even when the write failed. Several remediation tasks exist per file-family; check the task list before sweeping other files.

# Fix policy (established convention)

- Primary state-transition write (the thing the route exists to do) → destructure `{ error }`, `sendError(res, "db_error", error.message)` / return.
- Secondary cascades after the primary commit (decline siblings, close request, denormalised counters, backlink pointers) → log (`logger.error` / `console.warn` per file convention) and continue; failing the response after the primary committed would mislead.
- Audit-log / system-message inserts → always best-effort log, never fatal.
- Shared helpers: match the caller contract — `lib/chatSync.ts` returns `string | null` (log + return null, callers treat null as db_error); `services/groupChatSync.ts` throws (callers catch → sendError).

# Gotcha

Destructuring `{ error }` from a hand-written test fake whose terminal returns `undefined` throws TypeError — re-run the full api-test suite after adding destructures to previously-discarded calls (see fake-client builder drift).
