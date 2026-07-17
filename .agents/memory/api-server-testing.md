---
name: API server test suite
description: How to run api-server tests without timeouts, and fake-client pitfalls
---

# Running the suite
- api-server tests use **node:test + node:assert** (NOT vitest/jest). New test files must follow that style AND be added to the explicit file list in the api-server package.json `test` script — unlisted files never run.
- The full suite takes well over 5 minutes (the geofence suite alone ~100s). **Never run it via a raw shell command** — the 5-min cap kills it, and detached/nohup background processes get reaped between shell calls.
- **Why:** multiple detached runs died silently; a foreground chunk run timed out.
- **How to apply:** run it through the registered `api-test` workflow (WorkflowsRestart), then grep the workflow log for `✖` and the final `ℹ fail` count.

# Reading workflow logs
- `/tmp/logs/<workflow>_*.log` files are drained snapshots: they only gain content when logs are refreshed, NOT continuously. Polling the newest file with `ls -t` mid-run silently reads a stale buffer (often the *previous* run), which can fake a "pass". Refresh logs first, then read the file it names.

# Hanging suite
- Some test files (e.g. the geofence suite) leak open handles (unclosed servers/sockets), so their child process never exits and the runner — which uses process isolation — waits forever on the next file. The `test` script must keep `--test-force-exit`; without it the full suite deterministically stalls partway with no error.

# Fake-client pitfalls
- The geocoder's fetch-swap test hook does NOT null its DB-client override — suites must explicitly set the DB override to null (e.g. in beforeEach) or their "no DB" tests silently read the live geocode cache table and return real rows.
- Code that calls `getServiceClient()` gets a REAL Supabase client during tests (workspace env has live secrets) unless the suite stubs it via `_setTestServiceClient` (hook in the supabase lib). Unstubbed suites make live network calls.
- Test fakes that override `from(table)` with strict per-table builders break when production code adds a new query or chain step. A `TypeError: ... is not a function` inside `requireUser` usually means the fake's `profiles` builder is missing part of the account-status chain — not a product bug.
