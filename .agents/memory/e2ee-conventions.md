---
name: E2EE implementation conventions
description: Key decisions and gotchas from E-0/E-1/E-2 end-to-end encryption implementation for the Telegraph messaging feature.
---

## op-sqlite v17 API change
`@op-engineering/op-sqlite` v17+ returns `rows` as a **direct array** — `result.rows` is `unknown[]`, not `{ _array: unknown[] }`. The v11 `rows._array` shape no longer exists.
- `localMessageDb.ts` uses an `extractRows()` helper that handles both shapes for graceful drift.
- The Jest mock at `__mocks__/@op-engineering/op-sqlite.ts` returns `{ rows: [] }` (v17 shape).

**Why:** v11 never shipped; 17.1.2 is the current stable. The API changed between major versions.

## `__mocks__/` must be excluded from the mobile tsconfig
(Historical — `artifacts/travel-buddy` archived at `bc1bef404`.) `artifacts/travel-buddy/tsconfig.json` includes `**/*.ts` which picks up `__mocks__/`. Mock files use `jest.fn()`, but `@types/jest` is not in scope for the app typecheck, causing TS2708.

Fix: add `"__mocks__/**"` to the tsconfig `exclude` array.

**Why:** `jest.fn()` is a test-only global; mock files are runtime substitutions, not app code.

## `typeof import('native-pkg')` antipattern for lazy-required native modules
When a native module is lazily required (try/catch `require()`) to survive Expo Go, do NOT use `typeof import('native-pkg')` as the type annotation — TypeScript must resolve the module path for that form, and the package isn't in the JS module graph until EAS build.

Fix: annotate as `any` at the variable/parameter declaration site.

**How to apply:** Any `let ExpoFoo: typeof import('expo-foo') | null` → `let ExpoFoo: any`.

## ApiErrorCode is extensible in http.ts
New error codes must be added to BOTH the union type AND the `STATUS` map in `artifacts/api-server/src/lib/http.ts`. Added:
- `e2ee_thread` → 422 (translation/scan refused for encrypted threads)
- `no_key_package` → 404 (no key package available for recipient device)

## pnpm-workspace.yaml must include `packages/*`
`packages/expo-openmls` lives in `packages/`. The workspace file must list `- 'packages/*'` or the package is invisible to pnpm resolution. Added in this session.

## EAS Rust pre-build hook
`scripts/eas-install-rust.sh` installs rustup + cross-compilation targets for OpenMLS. Referenced in `eas.json` `development` and `preview` profiles as `prebuildCommand`. Path is relative to the app tree; it was `bash ../../scripts/eas-install-rust.sh` from `artifacts/travel-buddy/` (archived at `bc1bef404`). From `travel-buddy-standalone/` the correct depth is one level: `bash ../scripts/eas-install-rust.sh`.

## Solicitation scanner must be guarded for E2EE
`messaging.ts` solicitation scanner (`OFF_APP_PATTERNS`) reads `body`. For E2EE threads `body` is `null` — the guard is `if (!isE2ee && body && ...)`. Without the guard, `p.test(null)` throws.
