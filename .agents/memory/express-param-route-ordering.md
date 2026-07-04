---
name: Express param-route ordering
description: Static routes shadowed by param routes; applies both within a single Router and across routers registered in routes/index.ts
---

## Rule — within a single Router
Register all static GET routes (e.g. `GET /trips/me`, `GET /trips/upcoming`) **before** any parameterized route (`GET /trips/:tripId`) within the same Express Router instance. Express matches routes in registration order; a param route will swallow a static path if listed first.

**Why:** `/trips/me` matches `GET /trips/:tripId` with `:tripId = "me"`. The UUID check (`/^[0-9a-f-]{36}$/i`) then rejects it with 400. The bug is silent — the route registers without error and only fails at runtime.

## Rule — across routers registered in routes/index.ts
Router registration order in `routes/index.ts` matters just as much. If `followsRouter` (with `GET /users/:userId`) is registered before `profileRouter` (with `GET /users/check-username`), Express reaches `followsRouter` first and the static path is swallowed by the param route in a different file.

**Concrete case:** `GET /api/users/check-username` returned non-200 ("Could not check username") because `followsRouter` was registered before `profileRouter`. Fixed by moving `profileRouter` above `followsRouter` in `routes/index.ts`.

**How to apply:**
- In any router file with both `GET /resource/:id` and `GET /resource/static-name`, put the static routes first.
- Across routers in `routes/index.ts`: if router A has a static path `/users/check-username` and router B has `/users/:userId`, router A **must** be registered first (`router.use(routerA)` before `router.use(routerB)`).
- The parameterized route must be the **last** GET handler registered for that path segment, across both within-file and cross-file ordering.
- `server.unref()` after `server.listen()` in tests lets the Node.js process exit even if the server handle is still open — prevents 30-45 second hangs after the test suite finishes.

## Test ID constraint
When route handlers validate IDs with `UUID_RE = /^[0-9a-f-]{36}$/i`, test fixture IDs must contain only `[0-9a-f-]` characters. Letters like `r`, `n`, `l`, `p` are NOT valid hex and will cause a 400 from the UUID guard before the handler body runs.

Safe test ID patterns:
- `"11111111-1111-1111-1111-111111111111"` (digits)
- `"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"` (`a`–`f` are hex)
- `"a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1"` (mixed)

**Unsafe:** `"rrrrrrrr-..."`, `"nnnnnnnn-..."`, `"llllllll-..."` — `r`, `n`, `l` are not hex.
