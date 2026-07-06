---
name: node:test describe concurrency
description: Top-level describe() blocks in node:test run in parallel by default; wrapping them in a single outer describe forces sequential execution.
---

## The rule
When multiple `describe()` blocks share a global resource (such as `_setTestClient` / `_setTestServiceClient`), wrap all of them inside a **single outer `describe()`** so they become subtests of one suite and execute sequentially.

**Why:** Node.js `node:test` runs top-level `describe()` calls in parallel by default. If two describe blocks run concurrently while sharing a global fake-client slot, one test's `setClients()` call races with another test's HTTP request. The race produces intermittent 500 errors that are impossible to reproduce in isolation — the same request succeeds when run alone.

**How to apply:**
- Affected pattern: any test file that has two or more top-level `describe()` calls AND calls `_setTestClient`/`_setTestServiceClient` (or any other shared global) inside `it()` bodies.
- Fix: `describe("all", () => { describe("suite A", () => {}); describe("suite B", () => {}); })`.
- Inner (nested) describes always run sequentially relative to each other — only top-level ones are concurrent.
- Diagnostic clue: a test passes in an isolated debug script but fails ~50% of the time in the full suite → concurrency race on a shared global.
