---
name: Telegraph surface + Pulse ranking guard
description: Patterns for the Compass telegraph surface endpoint and Pulse feed location guard; fake-client like() support; req.log optional chaining in tests.
---

## isEnabled uses like(), not eq()

`compass/flags.ts` loads all Compass flags with:
```ts
.from("feature_flags").select("flag, enabled").like("flag", "COMPASS_%")
```
Fake clients in tests must implement `like()` with a LIKE-to-regex conversion:
```ts
like: (col, pattern) => {
  const rx = new RegExp("^" + pattern.replace(/%/g, ".*").replace(/_/g, ".") + "$", "i");
  filtered = filtered.filter(r => typeof r[col] === "string" && rx.test(r[col]));
  return b;
},
```
Without this, `isEnabled()` returns false for every flag → feature_disabled (404).

**Why:** `loadFlags` fetches all COMPASS_ flags in one SELECT to minimize round-trips. The pattern `.like("flag", "COMPASS_%")` is a module-level implementation detail that fake clients must mirror.

## req.log is undefined in tests

Route handlers call `req.log.error(...)` / `req.log.info(...)` (added by pino-http middleware). Test apps created with `express()` + `express.json()` don't mount that middleware, so `req.log` is undefined.

**Fix:** Use optional chaining everywhere logs appear in routes that will be exercised in tests:
```ts
req.log?.info({ ... }, "message");
req.log?.error({ err }, "error message");
```
This is especially critical in catch blocks — without it the catch handler itself throws and the route returns 500 instead of the intended error/fail-open response.

**How to apply:** Whenever adding a new route endpoint that includes catch blocks with `req.log`, use `?.` on all log calls in that handler.

## Pre-shape location guard (raw rows, not shaped posts)

The Pulse feed has a delayed-posting location guard that must nullify location fields before they reach the client. **Always apply this guard on raw DB rows (snake_case column names like `location_source`, `location_city`) before the shaping step that converts to camelCase.** 

If the guard runs on the shaped `posts` array instead, it checks `p.locationSource` which is never set (the shaper doesn't include that column) → guard silently never fires.

Correct pattern in pulse.ts:
```ts
// Pre-shape: on raw rows
rows = rows.map(row => {
  if (row.location_source === "delayed_pending") {
    return { ...row, location_city: null, location_name: null, venue_name: null, pulse_geo_tags: null };
  }
  return row;
});

// Then shape
const posts = rows.map(row => ({ ..., locationCity: geoTag?.city ?? row.location_city ?? null }));
```

## Fake client for pulse tests: post structure

The pulse route queries `posts` with a complex SELECT including embedded relations. Fake post objects in tests must include the embedded fields the route accesses:
```ts
{
  id:          "00000001-0000-0000-0000-000000000001",  // valid hex UUID
  author_id:   BOB_ID,
  content:     "Post body",
  created_at:  new Date().toISOString(),
  status:      "active",   // REQUIRED — route filters eq("status","active")
  visibility:  "public",   // REQUIRED — route filters eq("visibility","public")
  pulse_geo_tags: null,    // embedded relation (null = no geo tag)
  post_media:  [],         // embedded relation
  profiles:    { id, username, full_name, avatar_url },  // embedded relation
}
```

## invalidateFlagsCache between test suites

`compass/flags.ts` uses a 30-second in-memory cache. Tests running in the same process can get stale flag values from a previous suite. Call `invalidateFlagsCache()` at the start of every `before()` hook in test files that touch Compass-gated routes.
