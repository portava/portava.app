---
name: Dynamic import() breaks under Jest
description: Why `await import(...)` in app code silently fails in travel-buddy component tests and what to do instead.
---

Rule: app code exercised by Jest component tests must not use dynamic `await import(...)` — under jest-expo (CJS, no `--experimental-vm-modules`) it throws "A dynamic import callback was invoked without --experimental-vm-modules".

**Why:** the rollout screen lazily imported the supabase client via `await import(...)` inside its fetch helper; in tests the throw was swallowed by the helper's catch, so every API call silently returned an error and the screen rendered empty — zero fetch calls, no visible error.

**How to apply:** use static imports for modules needed by testable code paths (matches the rest of the codebase). If lazy loading is truly needed, isolate it behind an injectable/mockable seam.
