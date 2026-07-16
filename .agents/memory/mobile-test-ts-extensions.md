---
name: Mobile test import extensions
description: travel-buddy node:test files must import app modules with an explicit .ts extension
---
Rule: In `artifacts/travel-buddy` (and the standalone fork) test files run via `node --import tsx/esm --test`, import local modules with the explicit `.ts` extension (e.g. `from '../stampOverlay.ts'`). Discovery update (July 2026): both packages now run `scripts/run-node-tests.mjs`, which auto-discovers `src/**/*.test.ts` and `server/**/*.test.ts` — no manual package.json registration anymore. It has a KNOWN_BROKEN exclusion list; keep it accurate.

**Why:** tsx compiles these tests to CJS; extensionless specifiers fail at runtime with `MODULE_NOT_FOUND` even though `tsc --noEmit` passes (tsconfig has `allowImportingTsExtensions`; every sibling test already uses `.ts` specifiers). The failure message in the full suite is just `'test failed'` — run the single file solo to see the real error.

**How to apply:** Copy the import style of an existing `__tests__` neighbor, register the file in the package.json test list, and run the new file solo before re-running the whole suite.

Also applies to travel-buddy-standalone: its tsx/esm node:test runs also fail with "Cannot find module" unless relative imports use explicit `.ts` extensions. Same fix as the main app.
