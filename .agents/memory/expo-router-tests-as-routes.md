---
name: Expo Router test files as routes
description: Jest component tests placed under `app/` are scanned as routes by Expo Router unless Metro's blockList excludes them.
---

**Rule:** Exclude `**/__tests__/**` and `*.test.*` files from Metro's resolver in any Expo Router app that places Jest tests under `app/`.

**Why:** Expo Router's file-based routing discovers `.test.tsx` files inside `app/` and tries to render them as routes, causing runtime errors like `expect is not defined` because Jest globals are not defined in the app bundle. The same files may pass the Jest test suite without issue, so the failure only appears in the dev/production app bundle.

**How to apply:** Add `resolver.blockList` entries to `metro.config.js` (or `metro.config.ts`) for both directories and file extensions:

```js
config.resolver.blockList = [
  ...existingPatterns,
  /\/__tests__\/.*/,
  /\.(component\.)?test\.(tsx|ts|jsx|js)$/,
];
```

If the repo has a standalone fork, copy the same blockList to its `metro.config.js` so both trees stay consistent.
