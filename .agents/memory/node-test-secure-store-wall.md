---
name: node:test cannot import anything reaching SecureStoreAdapter/react-native
description: A hard, unfixable esbuild transform wall hit when a node:test file's import chain reaches supabase.ts -> SecureStoreAdapter -> react-native.
---

`travel-buddy-standalone/scripts/run-node-tests.mjs` runs plain `node --import tsx/esm --test` (no Jest
transform pipeline). Any test file whose import chain reaches `src/lib/supabase.ts` -> `SecureStoreAdapter`
-> the `react-native` package hits a hard wall: react-native@0.81.5's `index.js` uses Flow syntax
(`import typeof * as X from './index.js.flow'`) that esbuild cannot parse standalone, producing
`ERROR: Unexpected "typeof"`. This is NOT specific to any one file — it reproduces for *any* import of a
function that transitively touches that chain (e.g. `getPublicPostcards`, `updateMyProfile`, anything
calling `freshToken()` in `apiToken.ts`), even in files that previously passed (environment/package-version
sensitive, not code-sensitive).

**Why:** confirmed by writing a minimal one-line probe file that only imports the offending function — it
failed identically. Do not spend time trying to fix the transform (tsconfig, esbuild target, jest-style
`moduleNameMapper`, etc.) — Jest's own transform (babel + jest-expo preset) is what actually handles this
correctly; plain node/tsx cannot.

**How to apply:** if a new node:test file's import chain will hit this wall, write it in Jest syntax
instead (`import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'`, no `node:assert`)
and add its path to the `KNOWN_BROKEN` array in `run-node-tests.mjs` with a one-line comment citing the
chain (mirrors existing entries like `auth.requestPasswordReset.test.ts`). It will then run automatically
under `pnpm test:component` (Jest's `testMatch` picks up any `*.test.ts`, not just `*.component.test.*`).
