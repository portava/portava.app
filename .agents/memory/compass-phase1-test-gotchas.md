---
name: Compass Phase 1 test gotchas
description: Pitfalls discovered writing node:test HTTP tests for the compass/ask route
---

## Rule: flags.ts uses column `flag`, not `key`

The `feature_flags` table schema has a column named `flag` (not `key`). The `loadFlags` query also filters with `.like("flag", "COMPASS_%")`. Fake clients must use `{ flag: "COMPASS_ENABLED", enabled: true }` and support a no-op `.like()` method.

**Why:** Easy to write `{ key: "COMPASS_ENABLED" }` from reading code that calls `flags["COMPASS_ENABLED"]`. The column name in the DB is `flag`.

**How to apply:** Any test that needs COMPASS_ENABLED=true must seed `feature_flags` with `flag` column, not `key`. Add `like: (_col, _pat) => b` to fake builder.

## Rule: Express test servers need a req.log shim

Routes call `req.log.info(...)` and `req.log.error(...)` (injected by pino-http). A bare `express()` in tests has no `req.log`, causing `TypeError: Cannot read properties of undefined (reading 'info')` with a 500 HTML response.

**Why:** pino-http middleware isn't included in minimal test Express setups.

**How to apply:** Always add before mounting routers:
```typescript
app.use((req, _res, next) => {
  (req as any).log = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} };
  next();
});
```

## Rule: _setTestClient second arg is `ready: boolean`, not a token string

Signature: `_setTestClient(client: any, ready: boolean)`. Pass `true`, not `"test-token"`. Both work at runtime (truthy), but `true` is correct.

## Rule: Fake builder needs `.like()` no-op

The flags query uses `.like("flag", "COMPASS_%")`. Fake builders that only implement `.eq`, `.is`, `.in` will silently pass the call through as a no-op since JavaScript won't throw on `undefined()`. But to be explicit and avoid subtle bugs, add `like: (_col, _pat) => b` to the fake builder.
