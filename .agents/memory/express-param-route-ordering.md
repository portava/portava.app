---
name: Express param-route ordering
description: GET /trips/:tripId intercepts static paths like /trips/me when registered first; test IDs must be valid hex for UUID_RE
---

## Rule
Register all static GET routes (e.g. `GET /trips/me`, `GET /trips/upcoming`) **before** any parameterized route (`GET /trips/:tripId`) within the same Express Router instance. Express matches routes in registration order; a param route will swallow a static path if listed first.

**Why:** `/trips/me` matches `GET /trips/:tripId` with `:tripId = "me"`. The UUID check (`/^[0-9a-f-]{36}$/i`) then rejects it with 400. The bug is silent — the route registers without error and only fails at runtime.

**How to apply:**
- In any router file with both `GET /resource/:id` and `GET /resource/static-name`, put the static routes first.
- The parameterized route must be the **last** GET handler registered for that path segment.
- `server.unref()` after `server.listen()` in tests lets the Node.js process exit even if the server handle is still open — prevents 30-45 second hangs after the test suite finishes.

## Test ID constraint
When route handlers validate IDs with `UUID_RE = /^[0-9a-f-]{36}$/i`, test fixture IDs must contain only `[0-9a-f-]` characters. Letters like `r`, `n`, `l`, `p` are NOT valid hex and will cause a 400 from the UUID guard before the handler body runs.

Safe test ID patterns:
- `"11111111-1111-1111-1111-111111111111"` (digits)
- `"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"` (`a`–`f` are hex)
- `"a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1"` (mixed)

**Unsafe:** `"rrrrrrrr-..."`, `"nnnnnnnn-..."`, `"llllllll-..."` — `r`, `n`, `l` are not hex.
