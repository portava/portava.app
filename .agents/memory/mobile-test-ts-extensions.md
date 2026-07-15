---
name: Mobile test import extensions
description: travel-buddy node:test files must import app modules with an explicit .ts extension
---
Rule: In `artifacts/travel-buddy` (and the standalone fork) test files run via `node --import tsx/esm --test`, import local modules with the explicit `.ts` extension (e.g. `from '../stampOverlay.ts'`). Also: new test FILES are not auto-discovered — they must be appended to the space-separated list inside the `test` script of that package's `package.json` (main and fork each have their own list).

**Why:** tsx compiles these tests to CJS; extensionless specifiers fail at runtime with `MODULE_NOT_FOUND` even though `tsc --noEmit` passes (tsconfig has `allowImportingTsExtensions`; every sibling test already uses `.ts` specifiers). The failure message in the full suite is just `'test failed'` — run the single file solo to see the real error.

**How to apply:** Copy the import style of an existing `__tests__` neighbor, register the file in the package.json test list, and run the new file solo before re-running the whole suite.
