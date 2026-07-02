---
name: tsx ESM bare-import isolation for node:test
description: Why bare relative imports (no .ts extension) in mobile service files crash the tsx/ESM node:test runner, and the fix pattern.
---

## The rule
Mobile service files (`events.ts`, `rentABuddy.ts`, etc.) import supabase with a bare
relative path: `from '../lib/supabase'` (no `.ts` extension). When loaded by
`node --import tsx/esm --test`, tsx processes the file in CJS mode and Node's
`require()` cannot resolve bare TypeScript paths → "Cannot find module" crash.

**Why:** `discoveryBookmarks.ts` works because it uses explicit `.ts` extensions:
`from '../components/savedPlacesMapFilterStorage.ts'`. Without the extension tsx
falls back to CJS require() which cannot find the file.

## Fix pattern
Extract pure logic (no supabase / native imports) into a zero-import helper module:

```
src/services/eventCtaHelper.ts   ← pure types + functions, no imports
```

Test files import from the helper directly. The service file re-exports from the helper
using an explicit `.ts` extension (allowed because `allowImportingTsExtensions: true`
is set in tsconfig):

```typescript
// events.ts
export { shouldShowRentBuddyCta, buildRentBuddyParamsFromEvent, type RentBuddySearchParams }
  from './eventCtaHelper.ts';
```

**Why:** The helper has zero imports so tsx has nothing to resolve incorrectly.

## How to apply
When writing node:test unit tests for logic that lives inside a service file that
imports `supabase` (or any native module) without `.ts` extension:
1. Extract the pure functions into a `*Helper.ts` or `*Utils.ts` file with no imports.
2. Have the original service re-export from the helper with explicit `.ts` extension.
3. Test file imports from the helper — no tsx resolution issue.
