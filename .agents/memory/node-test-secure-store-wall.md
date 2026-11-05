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

**How to apply:** if a new test file's import chain will hit this wall, name it `*.component.test.ts`
so `pnpm test:component` runs it under jest (Jest globals; `node:assert` works there too). Do NOT name it
`*.test.ts` and add it to `KNOWN_BROKEN`: `test:component` passes `--testPathPattern='\.component\.test\.'`,
so such a file runs in neither runner. That is how 25 files sat unrun until 2026-11-04, when they were
renamed and `KNOWN_BROKEN` emptied. Under jest, load a module that reads env at import time with
`require()` after setting the env (a static `import` is hoisted above it; `await import()` needs
`--experimental-vm-modules`).
