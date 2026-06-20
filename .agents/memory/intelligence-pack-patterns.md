---
name: Telegraph Intelligence Pack patterns
description: Key non-obvious decisions from the Daily Brief / Concierge Commands / Preference Learning implementation
---

## Supabase builder .catch()
`supabase.from(...).insert(...).catch(() => {})` fails TypeScript — `PostgrestFilterBuilder` has no `.catch` method.
**Fix:** wrap in `try { await ... } catch { /* best-effort */ }` or use `.then(r => r, () => fallback)`.

## parseIntent substring pitfall
Checking `.includes("eat")` before `.includes("meetup")` causes "create a meetup" to match `find_food`
because "cr**eat**e" contains "eat".
**Fix:** check meetup first, or use `\beat\b` word-boundary regex for food signals.

## Token pattern: no prop drilling
The intelligence service (`src/services/intelligence.ts`) uses `freshToken()` internally (same as `tripPlan.ts`).
Components (`DailyBriefCard`, `ConciergeCommandBar`, `TelegraphFeedbackMenu`) take no `token` prop.
SessionContext does not expose `session.access_token` — always get it via `supabase.auth.getSession()`.

## Access control: always HTTP 200 for non-members
Non-members and invited users get `{ access: "access_denied", brief: null }` at HTTP 200,
not a 403 crash. Privacy resolver returns `denialReason: "pending_invite"` for invited role.

## Test pattern
Tests in `src/test/intelligence.test.ts` use node:test + tsx/esm + `_setTestClient` fake client.
Dynamic import of routers must happen **after** `_setTestClient` is called.
